// Home Assistant, in both directions.
//
// Outward: with a long-lived access token from HA, this app writes its own
// entities into HA (`POST /api/states/...`) and calls its services, so nothing has
// to be configured on the HA side — no YAML, no custom component, no restart. That
// is what the Home Assistant page in the app is for.
//
// Inward: `GET /api/ha` still answers with the same state for anyone who would
// rather poll, and the playlists below are what a media player is actually given.
//
// The playlist is the part that makes "continue this book on the kitchen speaker"
// possible at all. A media player cannot be told "play book 12 from 3h14m", but it
// can be given a URL, and most of them take an M3U and play it through. So the
// playlist starts at the track the listener is on and runs to the end of the book;
// the seconds into that track come back in the JSON, for HA to pass to
// `media_player.media_seek` once playback has started.
import crypto from 'node:crypto';
import { db, getSetting, setSetting } from './db.js';
import { countsAsRead, readCount } from './finished.js';

// Where this app is reachable from, which is not always where the request came
// from: HA may talk to a hostname the browser never uses, and a media player has
// to be able to fetch the audio itself. BASE_URL settles it when set.
// Whether a header may say where this app is reached. `X-Forwarded-*` is written
// by a reverse proxy, and it is also written by anybody who can reach this
// container directly — so on a machine where both are possible it is a way to
// put another address into the playlists this app hands to media players.
//
// It stays on by default, and deliberately: this app is normally behind exactly
// such a proxy, and turning it off by default would break every install that
// works today for a risk that is only real where the container is reachable past
// the proxy. `TRUST_PROXY=0` turns it off; `BASE_URL` settles it outright and
// needs neither.
export const trustProxy = () => !/^(0|no|false|off)$/i.test((process.env.TRUST_PROXY || '').trim());

export function baseUrl(req) {
  const set = (process.env.BASE_URL || '').trim().replace(/\/+$/, '');
  if (set) return set;
  const forwarded = trustProxy();
  const proto = ((forwarded && req.headers['x-forwarded-proto']) || req.protocol || 'http').split(',')[0].trim();
  const host = ((forwarded && req.headers['x-forwarded-host']) || req.headers.host || '').split(',')[0].trim();
  return `${proto}://${host}`;
}

// One token, read from the container. Without it these answers are as open as the
// listening page already is on the same network; with it, HA has to say it.
export const inboundToken = () => (process.env.HA_TOKEN || '').trim();

// Comparing a secret with === answers faster the sooner it differs. On a home
// network that is a theoretical attack rather than a real one, but the admin
// password is already compared in constant time and there is no reason for the
// tokens to be the odd ones out. Hashing both sides first also settles the
// length difference `timingSafeEqual` would throw over.
export function sameSecret(said, want) {
  if (!said || !want) return false;
  const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(digest(said), digest(want));
}

// An address a media player is handed carries its own pass: a signature of the
// path, made with a key this app keeps. The player has no cookie of ours, and
// without `HA_TOKEN` — the common install — it had nothing else either, so every
// playlist and track it was given answered "Sign in first." and HA reported the
// speaker's failure as "The data provided is invalid" (2.14.226). A signature opens
// that one path and nothing else, and needs nothing set up.
const playerKey = () => {
  let key = getSetting('playerKey');
  if (!key) {
    key = crypto.randomBytes(32).toString('hex');
    setSetting('playerKey', key);
  }
  return key;
};
const signatureOf = (pathname) => crypto.createHmac('sha256', playerKey()).update(pathname).digest('hex').slice(0, 32);

// `pathname` with what follows it, signed: `/api/stream/12` → `…/api/stream/12?sig=…`
export function playerUrl(base, pathname, params = {}) {
  const q = new URLSearchParams({ ...params, sig: signatureOf(pathname) });
  return `${base}${pathname}?${q}`;
}

export function playerSigOk(req) {
  const said = req.query && req.query.sig;
  return !!said && sameSecret(said, signatureOf(String(req.originalUrl || '').split('?')[0]));
}

export function tokenOk(req) {
  const want = inboundToken();
  if (!want) return true;
  const said = req.query.token
    || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return sameSecret(said, want);
}

// Every line terminator, written through the constructor rather than as a regex
// literal: U+2028 and U+2029 *are* line terminators in JavaScript source, so a
// literal holding them is a literal broken across two lines.
const BREAKS = new RegExp('[\\r\\n\\u2028\\u2029]+', 'g');

const hours = (seconds) => Math.round((seconds / 3600) * 10) / 10;

// How much of the collection has been listened to. A book marked listened counts
// whole; a book in progress counts the tracks already behind the listener plus the
// seconds into the one they are on. Per listener, or everybody at once.
export const listenedSeconds = (user) => {
  const sql = `SELECT COALESCE(SUM(CASE WHEN p.done = 1 THEN b.duration ELSE
      COALESCE((SELECT SUM(t.duration) FROM tracks t
                WHERE t.book_id = b.id AND t.idx < p.track_idx), 0) + p.position END), 0) AS s
    FROM progress p JOIN books b ON b.id = p.book_id`;
  return user
    ? db.prepare(`${sql} WHERE p.user = ?`).get(user).s
    : db.prepare(sql).get().s;
};

const BOOK = `SELECT b.id, b.title, b.author, b.genre, b.duration,
  NULLIF(COALESCE(NULLIF(b.series, ''), NULLIF(b.tag_series, '')), '') AS series, b.series_no,
  (SELECT COUNT(*) FROM tracks t WHERE t.book_id = b.id) AS tracks`;

// `who` is who the answer is about, decided by the caller. The route passes
// `whoReads(req)`, so a browser that has signed in gets its own listening and
// nothing else — this read `?user=` straight off the request, and `forHA` lets a
// request through when no `HA_TOKEN` is set, which is the common install. A
// signed-in listener could then ask `/api/ha?user=` for somebody else's places,
// and `continue.m3u` would hand over the book and the second they stopped at.
// Left null for the pushes below, which build a request of their own carrying
// the listener from Settings.
export function haState(req, version = '', who = null) {
  const base = baseUrl(req);
  const users = db.prepare('SELECT name FROM users ORDER BY name').all().map((u) => u.name);
  // one listener asked for, or the only one there is, or nobody
  const user = String(who === null ? (req.query.user || '') : (who || '')).trim()
    || (users.length === 1 ? users[0] : '');
  const totals = db.prepare(`SELECT
      (SELECT COUNT(*) FROM books) AS books,
      (SELECT COUNT(*) FROM tracks) AS files,
      (SELECT COALESCE(SUM(duration), 0) FROM books) AS seconds`).get();
  // read by the rule every other count of "listened" uses, so a sensor and the
  // list beside it cannot say two different numbers (2.10.40)
  const done = readCount(user);
  const listened = listenedSeconds(user);

  const link = (b, trackIdx) => ({
    // the whole book from the beginning
    playlist: playerUrl(base, `/api/ha/book/${b.id}.m3u`),
    // and from where this listener stopped, which is what "continue" means
    ...(trackIdx === undefined ? {} : {
      continueFrom: playerUrl(base, `/api/ha/book/${b.id}.m3u`, { from: trackIdx }),
    }),
  });

  // Every place kept, not the newest twelve: `listening` below is the shelf's
  // list, and twelve rows of which eight were finished books left four on it.
  // `trackSeconds` is what `countsAsRead` needs to see a book played to its end
  // that nobody ticked.
  const kept = db.prepare(`${BOOK}, p.track_idx, p.position, p.done, p.updated, p.started,
      (SELECT t.duration FROM tracks t WHERE t.book_id = b.id AND t.idx = p.track_idx) AS trackSeconds
      FROM progress p JOIN books b ON b.id = p.book_id
      WHERE p.user = ? AND (p.position > 0 OR p.done = 1)
      ORDER BY p.updated DESC`).all(user);
  const behind = db.prepare(`SELECT COALESCE(SUM(t.duration), 0) AS s FROM tracks t
      WHERE t.book_id = ? AND t.idx < ?`);
  const place = (b) => {
    const into = behind.get(b.id, b.track_idx).s + b.position;
    // read by the same rule as the shelf and the Listened section: the tick, or a
    // place sitting at the end of the last track. It was the tick alone, so a book
    // played out but never ticked was still "the one they are in the middle of".
    const read = countsAsRead(b);
    return {
      id: b.id,
      title: b.title,
      author: b.author,
      series: b.series || '',
      series_no: b.series_no || 0,
      track: b.track_idx + 1,
      tracks: b.tracks,
      position: Math.round(b.position),
      into_hours: hours(into),
      left_hours: read ? 0 : hours(Math.max(0, b.duration - into)),
      percent: read ? 100
        : Math.max(0, Math.min(100, b.duration ? Math.round((into / b.duration) * 100) : 0)),
      listened: read,
      updated: b.updated,
      // when they began it, which is not when they last touched it
      started: b.started || '',
      ...link(b, b.track_idx),
    };
  };
  const places = kept.map(place);

  return {
    version,
    listeners: users,
    listener: user,
    books: totals.books,
    files: totals.files,
    listened_books: done,
    hours: {
      total: hours(totals.seconds),
      listened: hours(listened),
      left: hours(Math.max(0, totals.seconds - listened)),
    },
    // every book with a place kept, newest first, finished ones included and
    // marked — the twelve this has always answered with
    continue: places.slice(0, 12),
    // and the shelf itself: Continue listening, which is the books not yet read,
    // up to the twelve `/api/home` shows
    listening: places.filter((b) => !b.listened).slice(0, 12),
    // and what has just arrived
    new: db.prepare(`${BOOK} FROM books b ORDER BY b.id DESC LIMIT 12`).all().map((b) => ({
      id: b.id,
      title: b.title,
      author: b.author,
      genre: b.genre,
      series: b.series || '',
      series_no: b.series_no || 0,
      tracks: b.tracks,
      hours: hours(b.duration),
      ...link(b),
    })),
  };
}

// --- driving Home Assistant --------------------------------------------
// The direction that needs no YAML: given the address of a Home Assistant and a
// long-lived access token made in it, this app writes its own sensors into HA's
// state machine and calls HA's services. Nothing is configured on the HA side and
// nothing is restarted there. The token is typed into the app's Home Assistant
// page by whoever made it, kept in the settings table, and never sent back to a
// browser — the page is only ever told whether one is there.
const KEY = { url: 'haUrl', token: 'haToken', every: 'haEvery', player: 'haPlayer', listener: 'haListener',
  // the address this app is reached at, kept so a push after a restart has one
  base: 'haBase' };

export const haSettings = () => ({
  url: getSetting(KEY.url),
  hasToken: !!getSetting(KEY.token),
  every: Number(getSetting(KEY.every) || 0), // minutes between pushes; 0 = only when asked
  player: getSetting(KEY.player),
  listener: getSetting(KEY.listener),
});

// The address the token is sent to, so it is checked before it is kept: an
// http(s) address with a host and nothing else. A path on the end is the mistake
// everyone makes here, and it is already explained by `explainHA`.
function asHaAddress(said) {
  const raw = String(said || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  let at;
  try {
    at = new URL(raw);
  } catch {
    throw new Error(`That is not an address: ${raw}. It looks like http://192.168.2.200:8123`);
  }
  if (at.protocol !== 'http:' && at.protocol !== 'https:') {
    throw new Error('A Home Assistant address is http:// or https://.');
  }
  if (!at.hostname) throw new Error('That address has no host in it.');
  return `${at.protocol}//${at.host}`;
}

export function saveHaSettings(body = {}) {
  if (body.url !== undefined) {
    const now = asHaAddress(body.url);
    // The token belongs to the Home Assistant it was made in. Pointing this at
    // another address and keeping the token means the next call hands it to
    // whatever is there — a typo is enough — so changing the address forgets it.
    if (now !== getSetting(KEY.url) && !body.token) setSetting(KEY.token, '');
    setSetting(KEY.url, now);
  }
  // an empty token leaves the one that is there; "-" forgets it
  if (body.token) setSetting(KEY.token, body.token === '-' ? '' : String(body.token).trim());
  if (body.every !== undefined) setSetting(KEY.every, String(Math.max(0, Number(body.every) || 0)));
  if (body.player !== undefined) setSetting(KEY.player, String(body.player).trim());
  if (body.listener !== undefined) setSetting(KEY.listener, String(body.listener).trim());
  return haSettings();
}

// Why a call failed, in words that say what to do. A wrong token and an address
// with a dashboard path on the end are the two mistakes everyone makes here.
const explainHA = (status) => ({
  401: 'Home Assistant did not accept the token. Make a new long-lived access token in Home '
    + 'Assistant (your profile → Security → Long-lived access tokens) and paste it here.',
  403: 'Home Assistant refused the token. It may belong to a user without permission.',
  404: 'Home Assistant answered, but not with its API. The address should be the one you open HA '
    + 'at — http://192.168.2.200:8123 — with no dashboard path after it.',
}[status] || `Home Assistant answered HTTP ${status}.`);

async function call(path, { method = 'GET', body } = {}) {
  const url = getSetting(KEY.url);
  const token = getSetting(KEY.token);
  if (!url) throw new Error('No Home Assistant address yet. Fill it in on the Home Assistant page.');
  if (!token) throw new Error('No token yet. Paste a long-lived access token on the Home Assistant page.');
  let res;
  try {
    res = await fetch(`${url}/api${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      // a redirect is another address, and this request carries the token
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    throw new Error(e.name === 'TimeoutError'
      ? `Home Assistant at ${url} did not answer within ten seconds.`
      : `Could not reach Home Assistant at ${url}. Check the address, and that this container may reach it.`);
  }
  if (!res.ok) {
    // What HA itself said, after the number: "HTTP 500" alone gave the owner
    // nothing to go on (2.14.204). A service that fails answers with a message,
    // as JSON or as text; it is cut short, and never shown for the token errors.
    let said = '';
    if (![401, 403, 404].includes(res.status)) {
      const text = await res.text().catch(() => '');
      try { said = JSON.parse(text).message || ''; } catch { said = text; }
      said = String(said).replace(/\s+/g, ' ').trim().slice(0, 200);
    }
    const e = new Error(explainHA(res.status).replace(/\.$/, '') + (said ? `: ${said}` : '.'));
    e.status = res.status;
    throw e;
  }
  return res.status === 204 ? null : res.json();
}

// Is it there, is the token good, and which Home Assistant is it?
export async function haPing() {
  const hello = await call('/');
  const conf = await call('/config').catch(() => null);
  return {
    message: hello?.message || 'API running.',
    name: conf?.location_name || '',
    haVersion: conf?.version || '',
  };
}

// Whether HA answers, known before anybody opens a page: the listening page shows
// its speaker pulldown only while this says so. Looked at when the app starts —
// a container that was set up connects on its own (2.14.248) — every five
// minutes after that, and whenever the connection is saved or tested.
export const haLink = { connected: false, at: '', error: '' };
export async function haConnect() {
  const { url, hasToken } = haSettings();
  if (!url || !hasToken) return Object.assign(haLink, { connected: false, at: new Date().toISOString(), error: '' });
  try {
    await haPing();
    Object.assign(haLink, { connected: true, at: new Date().toISOString(), error: '' });
  } catch (e) {
    Object.assign(haLink, { connected: false, at: new Date().toISOString(), error: e.message });
  }
  return haLink;
}
let linkTimer = null;
export function keepHaLinked() {
  clearInterval(linkTimer);
  haConnect();
  linkTimer = setInterval(haConnect, 300000);
  linkTimer.unref?.();
}

// One player's state, for a page that is driving it: playing, paused or idle,
// and what it is playing.
export async function haSpeaker(player) {
  const entity = String(player || '').trim();
  if (!entity.startsWith('media_player.')) throw new Error('Pick a media player first.');
  const st = await call(`/states/${entity}`);
  return { player: entity, state: st?.state || 'unknown', title: st?.attributes?.media_title || '' };
}

// Every media player HA knows, by the name a person would recognise.
export async function haPlayers() {
  const states = await call('/states');
  return (Array.isArray(states) ? states : [])
    .filter((s) => String(s.entity_id).startsWith('media_player.'))
    .map((s) => ({
      entity_id: s.entity_id,
      name: s.attributes?.friendly_name || s.entity_id,
      state: s.state,
      playing: s.attributes?.media_title || '',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// The entities this app keeps in HA. Written straight into the state machine, so
// they appear the moment the first push lands. HA forgets states written this way
// when it restarts, which is why the push repeats on a timer.
// --- what each person is in the middle of, and what they have finished -----
//
// The sensors above are about the collection and about one chosen listener.
// This is about everybody: who is reading what, how far in they are, and what
// they have already been through. Asked for so a dashboard can show the
// household rather than one account.
//
// A finished book **stays** in the list, marked as read, with how long that
// person took over it. "How long" is from the day they first opened it to the
// day they finished — not hours of audio, which is a fact about the book, and
// not time since they last touched it, which is a fact about nothing. For a
// book begun before the app started writing that down there is no answer, and
// the field is left out rather than guessed at.
//
// An entity id has to be a slug, and a listener's name is whatever they typed.
// Two names that slug the same would otherwise write over each other's sensor,
// so a repeat gets its position appended — ugly, and better than one of them
// silently not existing.
const slug = (name) => String(name || '').toLowerCase().normalize('NFKD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'listener';

const DAY = 86400000;
const tookThem = (started, at) => {
  if (!started || !at) return null;
  const from = new Date(started.includes('T') ? started : `${started.replace(' ', 'T')}Z`);
  const to = new Date(at);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  const days = Math.max(0, Math.round((to - from) / DAY));
  return { started, finished: at, days, took: days === 0 ? 'the same day' : days === 1 ? '1 day' : `${days} days` };
};

export function everybody(req) {
  const users = db.prepare('SELECT name FROM users ORDER BY name').all().map((u) => u.name);
  const seen = new Map();
  return users.map((name, i) => {
    const s = haState(req, '', name);
    // The one they are in the middle of is the newest of what they have on the
    // go; the rest of that shelf comes too, each book with how far in they are.
    const reading = s.listening[0] || null;
    const listening = s.listening.map((b) => ({
      id: b.id, title: b.title, author: b.author, series: b.series, series_no: b.series_no,
      chapter: b.track, chapters: b.tracks, percent: b.percent,
      hours_in: b.into_hours, hours_left: b.left_hours,
      ...(b.started ? { started: b.started } : {}), last_heard: b.updated,
      playlist: b.continueFrom,
    }));
    const finished = db.prepare(`SELECT c.book_id, c.title, c.at, c.started, b.author
        FROM completions c LEFT JOIN books b ON b.id = c.book_id
        WHERE c.user = ? ORDER BY c.at DESC LIMIT 25`).all(name)
      .map((c) => ({
        id: c.book_id, title: c.title, author: c.author || '',
        listened: true, finished_at: c.at, ...(tookThem(c.started, c.at) || {}),
      }));
    const key = slug(name);
    const id = seen.has(key) ? `${key}_${i}` : key;
    seen.set(key, true);
    return { name, id, reading, listening, finished, hours_listened: s.hours.listened, listened_books: s.listened_books };
  });
}

export function haEntities(req, version) {
  const asked = { headers: req.headers, protocol: req.protocol, query: { user: haSettings().listener } };
  const s = haState(asked, version);
  const next = s.listening[0] || s.continue[0] || null;
  const attrs = (extra) => ({ attribution: 'My Audiobook Collection', ...extra });
  const short = (b) => ({
    id: b.id, title: b.title, author: b.author, track: b.track, tracks: b.tracks,
    position: b.position, percent: b.percent, playlist: b.continueFrom,
  });
  return [
    ['sensor.audiobooks', String(s.books), attrs({
      friendly_name: 'Audiobooks', unit_of_measurement: 'books', icon: 'mdi:bookshelf',
      files: s.files, listener: s.listener, listeners: s.listeners,
      hours_total: s.hours.total, hours_listened: s.hours.listened, hours_left: s.hours.left,
      listened_books: s.listened_books,
      new: s.new.map((b) => ({ id: b.id, title: b.title, author: b.author, hours: b.hours, playlist: b.playlist })),
    })],
    ['sensor.audiobook_files', String(s.files), attrs({
      friendly_name: 'Audiobook files', unit_of_measurement: 'files', icon: 'mdi:file-music',
    })],
    ['sensor.audiobook_hours', String(s.hours.total), attrs({
      friendly_name: 'Audiobook hours', unit_of_measurement: 'h', icon: 'mdi:clock-outline',
    })],
    ['sensor.audiobook_hours_listened', String(s.hours.listened), attrs({
      friendly_name: 'Audiobook hours listened', unit_of_measurement: 'h', icon: 'mdi:headphones',
      hours_left: s.hours.left,
    })],
    ['sensor.audiobook_hours_left', String(s.hours.left), attrs({
      friendly_name: 'Audiobook hours left', unit_of_measurement: 'h', icon: 'mdi:timer-sand',
    })],
    ['sensor.audiobook_next_up', next ? next.title : 'nothing', attrs({
      friendly_name: 'Audiobook next up', icon: 'mdi:play-circle-outline',
      ...(next ? { book_id: next.id, ...short(next), hours_left: next.left_hours } : {}),
      queue: s.listening.map(short),
    })],
    // One per listener: what that person is in the middle of is the state, so a
    // dashboard card can show it without digging into attributes, and what they
    // have finished hangs off it — kept, marked read, with how long they took.
    ...everybody(asked).flatMap((p) => [[`sensor.audiobook_${p.id}`,
      p.reading ? p.reading.title : 'nothing', attrs({
        friendly_name: `Audiobook · ${p.name}`, icon: 'mdi:account-music',
        listener: p.name,
        ...(p.reading ? {
          book_id: p.reading.id, author: p.reading.author,
          chapter: p.reading.track, chapters: p.reading.tracks,
          percent: p.reading.percent,
          hours_in: p.reading.into_hours, hours_left: p.reading.left_hours,
          started: p.reading.started || undefined, last_heard: p.reading.updated,
          playlist: p.reading.continueFrom,
        } : {}),
        listened_books: p.listened_books, hours_listened: p.hours_listened,
        // everything on their Continue listening shelf, newest first, the book
        // in the state above included — and what they have finished below it
        listening: p.listening,
        finished: p.finished,
      })],
      // How far into that book, as a number of its own (2.14.303): a gauge card
      // shows a sensor's state and cannot read an attribute. 0 with nothing on.
      [`sensor.audiobook_${p.id}_progress`, String(p.reading ? p.reading.percent : 0), attrs({
        friendly_name: `Audiobook progress · ${p.name}`, icon: 'mdi:progress-clock',
        unit_of_measurement: '%', state_class: 'measurement', listener: p.name,
        ...(p.reading ? { book_id: p.reading.id, title: p.reading.title } : {}),
      })]]),
  ];
}

// What the last push did, for the page to show — the one on the timer included.
export const lastPush = { at: '', entities: 0, error: '' };

// Push them all: one request per entity, which is what HA's API takes.
export async function haPush(req, version) {
  const written = [];
  try {
    for (const [entity, state, attributes] of haEntities(req, version)) {
      await call(`/states/${entity}`, { method: 'POST', body: { state, attributes } });
      written.push(entity);
    }
  } catch (e) {
    Object.assign(lastPush, { error: e.message });
    throw e;
  }
  Object.assign(lastPush, { at: new Date().toISOString(), entities: written.length, error: '' });
  return { entities: written, at: lastPush.at };
}

// Play a book on one of HA's media players: the playlist first, then the seek — a
// player takes a URL, and a position can only be asked for once it has something
// to seek within. A player that cannot seek still plays, from the track's start.
export async function haPlay(req, { player, bookId, from = 0, seek = 0, speed, listener = '', version = '' } = {}) {
  const entity = String(player || haSettings().player || '').trim();
  if (!entity.startsWith('media_player.')) throw new Error('Pick a media player first.');
  // no book named: the one being listened to, from where it stopped. That is what
  // an automation wants — "carry on" is a single call with a player in it.
  if (!bookId) {
    const asked = { headers: req.headers, protocol: req.protocol, query: { user: haSettings().listener } };
    const next = haState(asked, version).continue.find((b) => !b.listened);
    if (!next) throw new Error('Nothing to continue: no book has been started yet.');
    ({ id: bookId } = next);
    from = next.track - 1;
    seek = next.position;
  }
  const id = Number(bookId);
  if (!bookPlaylist(req, id, Number(from) || 0)) throw new Error('That book has no files to play.');
  // A media player has nothing to show for itself but the address, so the address
  // carries a signature (`playerUrl`) rather than HA_TOKEN, which is a secret.
  //
  // The tracks go to the player one by one, not as a playlist. An M3U was one
  // call, but the owner's ESPHome speaker took it and then played nothing
  // (2.14.226) — while every player that plays a URL plays a single file. A player
  // that can queue is handed the rest of the book behind the first track; one that
  // cannot is given the next track by this app whenever one ends (`follow`).
  const base = baseUrl(req);
  const tracks = db.prepare('SELECT id, path, duration FROM tracks WHERE book_id = ? AND idx >= ? ORDER BY idx')
    .all(id, Number(from) || 0);
  // HA has no way to tell a speaker how fast to play (2.14.325): a speed other
  // than 1× is played by this app, the track sent through ffmpeg's atempo — and
  // then from the second to start at, since a seek into a stream cannot be asked.
  // Started from HA — an automation, the HA page — there is no speed in the call:
  // then it is the one the listener last chose in the app (2.14.336).
  const who = listener || haSettings().listener || onlyListener();
  const rate = tempo(speed ?? speedOf(who));
  const startAt = Math.max(0, Number(seek) || 0);
  const sped = (extra = {}) => (rate === 1 ? {} : { speed: rate, ...extra });
  const st = await call(`/states/${entity}`).catch(() => null);
  const queues = (Number(st?.attributes?.supported_features) || 0) & MEDIA_ENQUEUE;
  const first = await playTrack(entity, base, tracks[0], '', sped(startAt ? { at: Math.round(startAt) } : {}));
  nowOn.set(entity, { bookId: id, from: Number(from) || 0, i: 0, at: startAt, speed: rate, since: Date.now(),
    heard: 0, lastPoll: Date.now(), listener: who, single: !queues });
  saveNowOn();
  keepPlaces();
  let queued = 0;
  if (queues) {
    for (const t of tracks.slice(1)) {
      try {
        await playTrack(entity, base, t, 'add', sped());
        queued++;
      } catch { break; } // what is queued plays; the rest is not worth failing for
    }
  } else if (tracks.length > 1) {
    follow(entity, base, tracks, startAt, rate);
  }
  const media = first;
  const single = !queues;
  const at = Math.round(Number(seek) || 0);
  let seeked = rate !== 1 && at > 0; // started there already
  if (at > 0 && rate === 1) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      await call('/services/media_player/media_seek', {
        method: 'POST', body: { entity_id: entity, seek_position: at },
      });
      seeked = true;
    } catch { /* not every player can seek */ }
  }
  return { player: entity, media, seek: at, seeked, single, queued, speed: rate };
}

// 0.5× to 2×, which is what one atempo does and what the speed pulldown offers
export const tempo = (speed) => {
  const n = Math.round((Number(speed) || 1) * 10) / 10;
  return n >= 0.5 && n <= 2 ? n : 1;
};

// The speed each listener last chose in the app, kept here so that a book started
// from Home Assistant plays at it too — the browser's own choice is in the browser.
const speedKey = (who) => `speed:${who}`;
// with one listener there is no question whose book it is
const onlyListener = () => {
  const all = db.prepare('SELECT name FROM users').all();
  return all.length === 1 ? all[0].name : '';
};
export const speedOf = (who) => tempo(getSetting(speedKey(who)) || 1);

// A new speed chosen: kept, and whatever a speaker is playing for that listener
// starts again at it, from where it had got to.
export async function haSetSpeed(req, { listener, speed, apply = true, version = '' } = {}) {
  const rate = tempo(speed);
  if (listener) setSetting(speedKey(listener), String(rate));
  const restarted = [];
  if (!apply) return { speed: rate, restarted };
  for (const [entity, was] of [...nowOn]) {
    if (was.listener !== listener || was.speed === rate) continue;
    const st = await call(`/states/${entity}`).catch(() => null);
    if (st?.state !== 'playing') continue;
    await haSpeed(req, { player: entity, speed: rate, version }).catch(() => null);
    restarted.push(entity);
  }
  return { speed: rate, restarted };
}

// What this app last started on each player: the book, the track (from + i), the
// second it started at and how fast — so a new speed can start again where the
// listener is, worked out from how far the player says it got.
//
// Kept in the database as well (2.14.336): the owner resumes the speaker with its
// own button, through an HA automation, so after the app restarted — an update —
// it no longer knew what the speaker was playing, and nothing was kept.
const nowOn = new Map();
const NOW_ON = 'haNowOn';
const saveNowOn = () => setSetting(NOW_ON, JSON.stringify([...nowOn]));
setTimeout(() => {
  try {
    for (const [entity, was] of JSON.parse(getSetting(NOW_ON) || '[]')) {
      nowOn.set(entity, { ...was, lastPoll: Date.now() });
      // a player that cannot queue is handed the next track by this app: carry on
      // doing that, from the track it is on
      const base = getSetting(KEY.base);
      if (was.single && base) {
        const tracks = db.prepare('SELECT id, path, duration FROM tracks WHERE book_id = ? AND idx >= ? ORDER BY idx')
          .all(was.bookId, was.from + was.i);
        Object.assign(nowOn.get(entity), { from: was.from + was.i, i: 0 });
        if (tracks.length > 1) follow(entity, base, tracks, was.at, was.speed);
      }
    }
    if (nowOn.size) keepPlaces();
  } catch { /* nothing kept, or not readable: nothing to carry on */ }
}, 0).unref?.();

export async function haSpeed(req, { player, speed, version = '' } = {}) {
  const entity = String(player || '').trim();
  const was = nowOn.get(entity);
  if (!was) throw new Error('Nothing this app started is playing there.');
  const st = await call(`/states/${entity}`).catch(() => null);
  const seek = Math.round(placeOn(was, st));
  return haPlay(req, { player: entity, bookId: was.bookId, from: was.from + was.i, seek, speed,
    listener: was.listener, version });
}

// Where the speaker has got to, as a second in the book: from `at`, plus what the
// player says it has played at its speed — or, from one that keeps no count, the
// time since the track began.
const placeOn = (was, st) => {
  const a = st?.attributes || {};
  let heard = Number(a.media_position);
  if (Number.isFinite(heard)) {
    if (st.state === 'playing' && a.media_position_updated_at) {
      heard += Math.max(0, (Date.now() - Date.parse(a.media_position_updated_at)) / 1000);
    }
  } else {
    // a player that keeps no count: the time it has been seen playing, counted on
    // each look — so a pause from the speaker's own button is not counted
    heard = (Number(was.heard) || 0)
      + (st?.state === 'playing' ? Math.max(0, (Date.now() - (was.lastPoll || Date.now())) / 1000) : 0);
  }
  return was.at + heard * was.speed;
};

// A book played on a speaker moved nobody's place: the browser that sent it is
// quiet, and the speaker tells this app nothing. So the place, the app's page and
// the sensors in HA stayed where the browser had left them (2.14.325). While a
// speaker plays what this app started, its place is written down every half
// minute under the listener who pressed Play, and HA is told soon after.
export const KEEP_EVERY = { ms: 30000 };
let keeping = null;
function keepPlaces() {
  if (keeping) return;
  keeping = setInterval(async () => {
    if (!nowOn.size) { clearInterval(keeping); keeping = null; return; }
    for (const [entity, was] of nowOn) {
      const st = await call(`/states/${entity}`).catch(() => null);
      const now = Date.now();
      const looked = was.lastPoll || now;
      was.lastPoll = now;
      if (st?.state !== 'playing') { saveNowOn(); continue; }
      // Playing something of this book's? A player that says what it plays is
      // believed: another of the book's tracks (one that queues moves on by itself)
      // is followed, and anything else is not this book and moves no place.
      const playing = String(st.attributes?.media_content_id || '').match(/\/api\/stream\/(\d+)/);
      if (st.attributes?.media_content_id && !playing) continue;
      if (playing) {
        const t = db.prepare('SELECT book_id, idx FROM tracks WHERE id = ?').get(Number(playing[1]));
        if (!t || t.book_id !== was.bookId) continue;
        if (t.idx !== was.from + was.i) Object.assign(was, { i: t.idx - was.from, at: 0, heard: 0 });
      }
      was.heard = (Number(was.heard) || 0) + (now - looked) / 1000;
      saveNowOn();
      if (!was.listener) continue;
      const idx = was.from + was.i;
      const t = db.prepare('SELECT duration FROM tracks WHERE book_id = ? AND idx = ?').get(was.bookId, idx);
      // `heard` is up to date just above, so nothing more is added for this look
      const position = Math.min(Math.round(placeOn({ ...was, lastPoll: now }, st)),
        Math.floor(Number(t?.duration) || Infinity));
      db.prepare(`INSERT INTO progress (user, book_id, track_idx, position, updated, via, started)
          VALUES (?, ?, ?, ?, datetime('now'), 'home-assistant', datetime('now'))
        ON CONFLICT(user, book_id) DO UPDATE SET track_idx = excluded.track_idx,
          position = excluded.position, updated = excluded.updated, via = excluded.via`)
        .run(was.listener, was.bookId, idx, position);
      haPushSoon();
    }
  }, KEEP_EVERY.ms);
  keeping.unref?.();
}

// HA's flag for a player that takes `enqueue` on play_media
const MEDIA_ENQUEUE = 2097152;

// One track to a player, as `music` first — what Music Assistant and ESPHome
// players take — then as the file's own type (2.14.215). Gives back its address.
async function playTrack(entity, base, track, enqueue = '', extra = {}) {
  const url = playerUrl(base, `/api/stream/${track.id}`, extra);
  const ext = String(track.path || '').split('.').pop().toLowerCase();
  const own = extra.speed ? 'audio/mpeg' : { mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg',
    opus: 'audio/ogg', flac: 'audio/flac', wav: 'audio/wav' }[ext] || 'audio/mpeg';
  let last = null;
  for (const type of ['music', own]) {
    try {
      await call('/services/media_player/play_media', {
        method: 'POST',
        body: { entity_id: entity, media_content_type: type, media_content_id: url, ...(enqueue ? { enqueue } : {}) },
      });
      return url;
    } catch (e) { last = e; }
  }
  throw last;
}

// A player that cannot queue is given the next track when one ends. Watched
// through HA every few seconds: playing, then idle once most of the track's
// length has gone by, is a track that ended — idle sooner is somebody pressing
// stop, and that is left alone. One book per player; Play here again replaces it.
const following = new Map();
export const FOLLOW_EVERY = { ms: 5000 };
function follow(entity, base, tracks, skipped = 0, rate = 1) {
  clearInterval(following.get(entity));
  let i = 0;
  let since = 0; // when the current track was first seen playing
  let quiet = 0; // polls with nothing playing yet
  const stop = () => { clearInterval(following.get(entity)); following.delete(entity); };
  const timer = setInterval(async () => {
    const st = await call(`/states/${entity}`).catch(() => null);
    if (!st) return;
    if (['off', 'unavailable'].includes(st.state)) return stop();
    if (st.state === 'playing' || st.state === 'paused') {
      if (!since) since = Date.now();
      return;
    }
    if (!since) {
      // never started: give it two minutes, then stop watching
      if (++quiet * FOLLOW_EVERY.ms > 120000) stop();
      return;
    }
    const heard = (Date.now() - since) / 1000;
    // the first track was started `skipped` seconds in, so less of it is left to hear
    // and at another speed it takes that much more or less time
    const left = ((Number(tracks[i].duration) || 0) - (i === 0 ? skipped : 0)) / rate;
    if (heard < left * 0.9) return stop(); // stopped by hand
    i++;
    if (i >= tracks.length) return stop();
    since = 0;
    quiet = 0;
    const on = nowOn.get(entity);
    if (on) Object.assign(on, { i, at: 0, since: Date.now(), heard: 0, lastPoll: Date.now() });
    saveNowOn();
    try { await playTrack(entity, base, tracks[i], '', rate === 1 ? {} : { speed: rate }); } catch { stop(); }
  }, FOLLOW_EVERY.ms);
  timer.unref?.();
  following.set(entity, timer);
}
// Pause, carry on or stop what a player is playing. Stop also ends the app handing
// it the next track, or the next track would start the moment it went quiet.
export async function haControl({ player, action } = {}) {
  const entity = String(player || haSettings().player || '').trim();
  if (!entity.startsWith('media_player.')) throw new Error('Pick a media player first.');
  const service = { pause: 'media_pause', play: 'media_play', stop: 'media_stop' }[action];
  if (!service) throw new Error('Pause, play or stop.');
  if (action === 'stop') {
    clearInterval(following.get(entity));
    following.delete(entity);
    nowOn.delete(entity);
    saveNowOn();
  }
  await call(`/services/media_player/${service}`, { method: 'POST', body: { entity_id: entity } });
  return { player: entity, action };
}

export const stopFollowing = () => { for (const e of [...following.keys()]) { clearInterval(following.get(e)); following.delete(e); } };

// The push that runs on its own. It needs a request to build URLs from — a URL in
// HA that only works from one browser is no use — so the last real one is kept,
// and the address it was reached at is written down as well. That address is what
// makes a push possible at all after a restart, when no browser has been here yet:
// HA empties these states when *it* restarts, and this is what puts them back.
let timer = null;
let startup = null;
let lastReq = null;

export const rememberRequest = (req) => {
  lastReq = { headers: { ...req.headers }, protocol: req.protocol, query: {} };
  const base = baseUrl(req);
  if (/^https?:\/\/[^/]+$/.test(base) && base !== getSetting(KEY.base)) setSetting(KEY.base, base);
};

// A stand-in for a request, built from an address: enough for baseUrl to answer.
const asIfFrom = (base) => {
  let at;
  try {
    at = new URL(base);
  } catch {
    return null;
  }
  if (!at.host) return null;
  const proto = at.protocol.replace(':', '');
  return { headers: { host: at.host, 'x-forwarded-proto': proto }, protocol: proto, query: {} };
};

// Whatever this push can use for URLs: the last browser here, else the address
// that was written down, else the one the container was told outright.
const pushFrom = () => lastReq
  || asIfFrom(getSetting(KEY.base))
  || asIfFrom((process.env.BASE_URL || '').trim());

// A place changed: HA hears of it within a few seconds rather than at the next
// interval, which is minutes (2.14.325). One push for a burst of changes.
let pushVersion = '';
let soon = null;
export const PUSH_SOON = { ms: 10000 };
export function haPushSoon() {
  const { url, hasToken } = haSettings();
  if (!url || !hasToken || soon) return;
  soon = setTimeout(() => {
    soon = null;
    const from = pushFrom();
    if (from) haPush(from, pushVersion).catch(() => { /* lastPush.error already says why */ });
  }, PUSH_SOON.ms);
  soon.unref?.();
}

export function scheduleHaPush(version) {
  pushVersion = version;
  if (timer) clearInterval(timer);
  if (startup) clearTimeout(startup);
  timer = null;
  startup = null;
  const { every, url, hasToken } = haSettings();
  if (!every || !url || !hasToken) return;
  const push = () => {
    const from = pushFrom();
    if (!from) return;
    haPush(from, version).catch(() => { /* lastPush.error already says why */ });
  };
  // once, soon after starting: a restart of either side is what loses the sensors,
  // and waiting a whole interval for them is waiting too long
  startup = setTimeout(push, 15000);
  startup.unref?.();
  timer = setInterval(push, every * 60000);
  timer.unref?.();
}

// The book as a playlist a media player can be handed. #EXTM3U with a title per
// track, absolute URLs, and `from` cutting off what has already been heard.
export function bookPlaylist(req, id, from = 0) {
  const book = db.prepare('SELECT id, title, author FROM books WHERE id = ?').get(id);
  if (!book) return null;
  const tracks = db.prepare('SELECT id, idx, title, duration FROM tracks WHERE book_id = ? ORDER BY idx')
    .all(id).filter((t) => t.idx >= from);
  if (!tracks.length) return null;
  const base = baseUrl(req);
  // A line of an M3U ends at the newline, so a title that carries one writes the
  // rest of the playlist. Titles come from folder names and from tags — neither
  // is this app's to trust — and `#EXTINF` is one line by definition, so anything
  // that would break it is folded into a space.
  const oneLine = (s) => String(s || '').replace(BREAKS, ' ').trim();
  return [
    '#EXTM3U',
    `#PLAYLIST:${oneLine(book.title)}${book.author ? ` — ${oneLine(book.author)}` : ''}`,
    ...tracks.flatMap((t) => [
      `#EXTINF:${Math.round(t.duration || 0)},${oneLine(book.title)} — ${oneLine(t.title)}`,
      playerUrl(base, `/api/stream/${t.id}`),
    ]),
  ].join('\n') + '\n';
}
