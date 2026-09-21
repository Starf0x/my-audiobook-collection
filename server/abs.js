// The Audiobookshelf face of this app, so Music Assistant can be pointed at it.
//
// Why an imitation rather than a provider of our own: Music Assistant has no
// supported way to load a third-party provider. Its maintainers were asked for an
// extension point and declined — "Just follow the development workflow and we're
// open for PR's" (music-assistant discussion 4167) — and the one community
// workaround is a pre-release package that monkey-patches MA's provider loader at
// runtime. What MA *does* have is an Audiobookshelf provider, and ABS is the same
// shape of thing this app is: a self-hosted server with books, series, chapters
// and a listening position. So this answers enough of the ABS API for that
// provider to work, and MA needs no changes at all.
//
// Say the honest part out loud: this imitates another product's private API. The
// contract is not ABS's documentation but what `aioaudiobookshelf` — MA's own
// client — will parse, and either side can move. Two things make that survivable.
// Its models set `forbid_extra_keys = False`, so extra fields are ignored and
// only the *required* ones matter. And it still accepts the pre-2.26 token, so
// this hands out one token and never enters the refresh dance: fewer moving
// parts to break.
//
// The whole surface is off unless MA_TOKEN is set on the container, the way the
// Home Assistant answers are gated by HA_TOKEN.
import fs from 'node:fs';
import { db } from './db.js';
import { baseUrl } from './ha.js';

export const inboundToken = () => (process.env.MA_TOKEN || '').trim();
export const enabled = () => !!inboundToken();

// A listener is a name in this app, and Music Assistant asks for a username and a
// password: so the username is which person is listening, and the password is the
// container's token. The token handed back carries the name, which is what makes
// a position written from MA land on the right person — and it is exactly as
// strong as MA_TOKEN, since it contains it.
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const unb64 = (s) => Buffer.from(s, 'base64url').toString('utf8');
const tokenFor = (user) => `${b64(user || '')}.${inboundToken()}`;

// Who this request is, or null when it may not ask. A bare MA_TOKEN is allowed
// and means the nameless listener the app already supports.
export function listener(req) {
  const want = inboundToken();
  if (!want) return null;
  const said = String(req.query.token || '')
    || (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!said) return null;
  if (said === want) return '';
  const cut = said.indexOf('.');
  if (cut < 0 || said.slice(cut + 1) !== want) return null;
  try { return unb64(said.slice(0, cut)); } catch { return null; }
}

const ms = (iso) => (iso ? Date.parse(iso) || 0 : 0);
const now = () => Date.now();

// One library holding the collection. Genres are a field on a book here, not a
// shelf of their own, and a reader browsing in MA wants every book in one place.
const LIB = 'mac-library';
const FOLDER = 'mac-folder';

const library = () => ({
  id: LIB,
  name: 'My Audiobook Collection',
  folders: [{ id: FOLDER, fullPath: '/audiobooks', libraryId: LIB, addedAt: 0 }],
  displayOrder: 1,
  icon: 'audiobookshelf',
  mediaType: 'book',
  provider: 'audible',
  settings: { coverAspectRatio: 1, disableWatcher: false },
  createdAt: 0,
  lastUpdate: now(),
});

// --- a book, in the shapes ABS answers with ------------------------------
// Minified for a list, expanded for one book with its tracks. The fields below
// are the ones aioaudiobookshelf requires; anything it does not ask for is left
// out rather than invented.
const BOOK = `SELECT b.id, b.title, b.author, b.narrator, b.year, b.description, b.genre,
                     b.duration, b.cover,
                     COALESCE(NULLIF(b.series, ''), NULLIF(b.tag_series, '')) AS series,
                     b.series_no
              FROM books b`;

const tracksOf = (id) => db.prepare(
  'SELECT id, idx, path, title, duration FROM tracks WHERE book_id = ? ORDER BY idx').all(id);

const fileMeta = (t) => {
  let size = 0;
  try { size = fs.statSync(t.path).size; } catch { /* the disk check reports these */ }
  const name = t.path.split(/[\\/]/).pop() || `${t.idx + 1}.mp3`;
  return {
    filename: name,
    ext: (name.match(/\.[^.]+$/) || ['.mp3'])[0],
    path: t.path,
    relPath: name,
    size,
    mtimeMs: 0,
    ctimeMs: 0,
    birthtimeMs: 0,
  };
};

const metadata = (b) => ({
  title: b.title,
  subtitle: null,
  genres: b.genre ? [b.genre] : [],
  publishedYear: b.year || null,
  publishedDate: null,
  publisher: null,
  description: b.description || null,
  isbn: null,
  asin: null,
  language: null,
  explicit: false,
  authors: [{ id: `au-${b64(b.author || '')}`, name: b.author || '' }],
  narrators: b.narrator ? [b.narrator] : [],
  // the sequence is a string in ABS, and a book with no number has none rather
  // than a nought, which would sort it in front of book one
  series: b.series ? [{ id: `se-${b64(b.series)}`, name: b.series,
    sequence: b.series_no ? String(b.series_no) : null }] : [],
  // the minified shape wants these flattened as well
  titleIgnorePrefix: b.title,
  authorName: b.author || '',
  authorNameLF: b.author || '',
  narratorName: b.narrator || '',
  seriesName: b.series || '',
});

// Every file of the book is one audio file and one track, laid end to end: the
// offsets are what let a player seek across a book of forty files.
const audio = (b, base) => {
  const tracks = tracksOf(b.id);
  let at = 0;
  const files = [];
  const list = [];
  for (const t of tracks) {
    const meta = fileMeta(t);
    const seconds = t.duration || 0;
    files.push({
      index: t.idx + 1,
      ino: String(t.id),
      metadata: meta,
      addedAt: 0,
      updatedAt: 0,
      manuallyVerified: false,
      exclude: false,
      error: null,
      format: 'mp3',
      duration: seconds,
      codec: 'mp3',
      timeBase: '1/1000',
      mimeType: 'audio/mpeg',
    });
    list.push({
      index: t.idx + 1,
      startOffset: at,
      duration: seconds,
      title: t.title || meta.filename,
      // MA builds the stream address as `${base}${contentUrl}?token=…`, so this
      // has to be a path from the root and the route behind it has to take a
      // token in the query
      contentUrl: `/api/items/${b.id}/file/${t.id}`,
      metadata: meta,
      mimeType: 'audio/mpeg',
    });
    at += seconds;
  }
  // one chapter per file: this app knows no finer division, and a book of one
  // long file honestly has one chapter
  const chapters = list.map((t, i) => ({
    id: i, start: t.startOffset, end: t.startOffset + (t.duration || 0), title: t.title,
  }));
  return { files, tracks: list, chapters, duration: at, size: files.reduce((n, f) => n + (f.metadata.size || 0), 0), base };
};

const itemBase = (b) => ({
  id: String(b.id),
  ino: String(b.id),
  libraryId: LIB,
  folderId: FOLDER,
  path: `/audiobooks/${b.genre}/${b.author}/${b.title}`,
  relPath: `${b.genre}/${b.author}/${b.title}`,
  isFile: false,
  mtimeMs: 0,
  ctimeMs: 0,
  birthtimeMs: 0,
  addedAt: 0,
  updatedAt: now(),
  isMissing: false,
  isInvalid: false,
  mediaType: 'book',
});

export const minifiedItem = (b) => {
  const tracks = tracksOf(b.id);
  return {
    ...itemBase(b),
    numFiles: tracks.length,
    size: 0,
    media: {
      metadata: metadata(b),
      coverPath: b.cover || null,
      tags: [],
      numTracks: tracks.length,
      numAudioFiles: tracks.length,
      numChapters: tracks.length,
      duration: b.duration || tracks.reduce((n, t) => n + (t.duration || 0), 0),
      size: 0,
    },
  };
};

export const expandedItem = (b, req) => {
  const a = audio(b, baseUrl(req));
  return {
    ...itemBase(b),
    size: a.size,
    libraryFiles: [],
    media: {
      libraryItemId: String(b.id),
      metadata: metadata(b),
      coverPath: b.cover || null,
      tags: [],
      audioFiles: a.files,
      chapters: a.chapters,
      duration: a.duration || b.duration || 0,
      size: a.size,
      tracks: a.tracks,
    },
  };
};

// --- what a listener has done with a book --------------------------------
// ABS keeps a progress row per item; this app keeps one per user and book, which
// is the same thing said differently.
export const progressOf = (user, b) => {
  const p = db.prepare(`SELECT p.position, p.track_idx, p.done, p.updated
                        FROM progress p WHERE p.user = ? AND p.book_id = ?`).get(user || '', b.id);
  if (!p) return null;
  const behind = db.prepare(`SELECT COALESCE(SUM(duration), 0) AS s FROM tracks
                             WHERE book_id = ? AND idx < ?`).get(b.id, p.track_idx || 0).s;
  const into = behind + (p.position || 0);
  const whole = b.duration || 0;
  return {
    id: `pr-${b.id}`,
    libraryItemId: String(b.id),
    mediaItemId: String(b.id),
    mediaItemType: 'book',
    duration: whole,
    progress: whole ? Math.min(1, into / whole) : 0,
    currentTime: into,
    isFinished: !!p.done,
    hideFromContinueListening: false,
    lastUpdate: ms(p.updated) || now(),
    startedAt: ms(p.updated) || now(),
    finishedAt: p.done ? (ms(p.updated) || now()) : null,
  };
};

// The seconds MA reports are seconds into the whole book; this app keeps a track
// and a position inside it, so the number is walked back over the tracks.
export function writeProgressFromWhole(user, bookId, seconds, finished) {
  const tracks = tracksOf(bookId);
  if (!tracks.length) return;
  let left = Math.max(0, seconds);
  let idx = 0;
  for (const t of tracks) {
    const d = t.duration || 0;
    if (left < d || t === tracks[tracks.length - 1]) { idx = t.idx; break; }
    left -= d;
  }
  db.prepare(`INSERT INTO progress (user, book_id, track_idx, position, updated, done)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(user, book_id) DO UPDATE SET
                track_idx = excluded.track_idx, position = excluded.position,
                updated = excluded.updated, done = MAX(progress.done, excluded.done)`)
    .run(user || '', bookId, idx, left, new Date().toISOString(), finished ? 1 : 0);
}

export const user = (name) => ({
  id: `us-${b64(name || '')}`,
  username: name || 'listener',
  type: 'user',
  token: tokenFor(name),
  mediaProgress: db.prepare(`${BOOK} JOIN progress p ON p.book_id = b.id AND p.user = ?`)
    .all(name || '').map((b) => progressOf(name, b)).filter(Boolean),
  seriesHideFromContinueListening: [],
  bookmarks: [],
  isActive: true,
  isLocked: false,
  lastSeen: now(),
  createdAt: 0,
  permissions: {
    download: true, update: false, delete: false, upload: false,
    accessAllLibraries: true, accessAllTags: true, accessExplicitContent: true,
  },
  librariesAccessible: [],
  itemTagsAccessible: [],
});

// Enough of a server for the provider to read; the values are this app's, not
// pretend Audiobookshelf ones, except where a field has to be one of a set.
export const serverSettings = (version) => ({
  id: 'mac-server',
  scannerFindCovers: false,
  scannerCoverProvider: 'google',
  scannerParseSubtitle: false,
  scannerPreferMatchedMetadata: false,
  scannerDisableWatcher: true,
  storeCoverWithItem: false,
  storeMetadataWithItem: false,
  metadataFileFormat: 'json',
  rateLimitLoginRequests: 10,
  rateLimitLoginWindow: 600000,
  backupSchedule: '',
  backupsToKeep: 2,
  maxBackupSize: 1,
  loggerDailyLogsToKeep: 7,
  loggerScannerLogsToKeep: 2,
  homeBookshelfView: 1,
  bookshelfView: 1,
  sortingIgnorePrefix: false,
  sortingPrefixes: ['the'],
  chromecastEnabled: false,
  dateFormat: 'dd/MM/yyyy',
  timeFormat: 'HH:mm',
  language: 'en-us',
  logLevel: 2,
  // the provider is tested against ABS 2.19 and up, and says so in its own docs
  version: `2.19.0 (My Audiobook Collection ${version})`,
});

export const loginResponse = (name, version) => ({
  user: user(name),
  userDefaultLibraryId: LIB,
  serverSettings: serverSettings(version),
  Source: 'my-audiobook-collection',
});

// --- the socket Music Assistant insists on -------------------------------
// Not a nicety: the provider's `handle_async_init` calls `init_client()`, which
// is `socketio.AsyncClient.connect(url)`, and the only exception it catches
// around that is a login error. Nothing listening at /socket.io/ means a
// ConnectionError out of setup, and the provider never connects at all — so the
// handshake below is what makes every answer above reachable.
//
// It is Engine.IO v4 over long polling and nothing else. The client offers to
// upgrade to a WebSocket; Node hands an upgrade request to a listener this app
// does not register, the socket is dropped, and python-engineio goes on polling,
// which is a supported way to be connected. Writing an actual WebSocket server
// by hand — framing, masking, ping — to send events nothing sends yet would be
// the larger and less honest change.
//
// The packet alphabet used here: 0 open, 2 ping, 3 pong, 4 message; and inside a
// message, 40 connect, 42 an event. Several packets in one answer are joined
// with a record separator.
const SEP = '\x1e';
const OPEN = 0;
const sockets = new Map();

// A poll is held rather than answered empty, the way engine.io does it, or the
// client would come straight back and the two of them would spin.
const HOLD = 25000;

const socketSend = (s, text) => {
  if (!s.waiting) { s.queue.push(text); return; }
  const res = s.waiting;
  s.waiting = null;
  clearTimeout(s.timer);
  res.type('text/plain; charset=UTF-8').send(text);
};

export function socketOpen(res) {
  const sid = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  sockets.set(sid, { queue: [], waiting: null, timer: null, at: Date.now() });
  // forget sessions nobody came back for, so a restarting Music Assistant does
  // not leave one behind on every attempt
  for (const [id, s] of sockets) if (Date.now() - s.at > 300000 && !s.waiting) sockets.delete(id);
  return res.type('text/plain; charset=UTF-8').send(
    `${OPEN}${JSON.stringify({
      sid,
      upgrades: [],
      pingInterval: HOLD,
      pingTimeout: 20000,
      maxPayload: 1000000,
    })}`);
}

export function socketPoll(req, res) {
  const s = sockets.get(String(req.query.sid || ''));
  if (!s) return res.status(400).json({ code: 1, message: 'Session ID unknown' });
  s.at = Date.now();
  if (s.queue.length) {
    const out = s.queue.join(SEP);
    s.queue = [];
    return res.type('text/plain; charset=UTF-8').send(out);
  }
  // hold it open, and let go on every way out: a poll whose reader has gone must
  // not keep a timer and a response alive behind it
  s.waiting = res;
  s.timer = setTimeout(() => {
    if (s.waiting === res) { s.waiting = null; res.type('text/plain; charset=UTF-8').send('2'); }
  }, HOLD);
  const done = () => {
    if (s.waiting === res) { s.waiting = null; clearTimeout(s.timer); }
  };
  res.on('close', done);
  res.on('finish', done);
  return undefined;
}

export function socketSay(req, res) {
  const s = sockets.get(String(req.query.sid || ''));
  if (!s) return res.status(400).json({ code: 1, message: 'Session ID unknown' });
  s.at = Date.now();
  for (const packet of String(req.body || '').split(SEP)) {
    // the client asking to join the one namespace there is
    if (packet.startsWith('40')) socketSend(s, '40' + JSON.stringify({ sid: `s-${Date.now().toString(36)}` }));
    // 3 is its answer to our ping, and an event is the token it announces
    // itself with; there is nothing to do with either but read it
  }
  return res.type('text/html').send('ok');
}
// --- a playback session --------------------------------------------------
// Asked for the moment somebody presses play, and the one answer here that was
// invented rather than transcribed: it went out missing seven fields, and the
// page said so in as many words — *Field "device_info" of type DeviceInfo is
// missing in PlaybackSessionExpanded instance*. Every field below is one the
// client's dataclass gives no default, so every one of them has to be here.
//
// This app opens nothing and keeps nothing: the files are streamed straight
// out, and the session is a description of what would have been opened. What
// matters to Music Assistant is `audioTracks`, which is where it reads the
// addresses it will fetch.
// A session has to be remembered, and that is not about bookkeeping: a listener
// configured with a **username and password** — which is how this app tells
// Music Assistant apart from one person and the next — never fetches the audio
// directly. Every part goes through MA's own address, which looks the session up
// with `GET /api/session/<id>` and redirects to the file. A 404 there becomes
// SessionNotFoundError, which that route turns into a 404 of its own, and then
// nothing plays at all — not one book, played or half finished. Only a listener
// configured with an API key streams straight from here.
const sessions = new Map();
const KEEP = 12 * 60 * 60 * 1000;

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function playbackSession(b, user, req, version) {
  const item = expandedItem(b, req);
  const when = new Date();
  const place = progressOf(user, b);
  const id = `pl-${b.id}-${when.getTime().toString(36)}`;
  for (const [old, s] of sessions) if (when.getTime() - s.at > KEEP) sessions.delete(old);
  sessions.set(id, { book: b.id, user: user || '', at: when.getTime() });
  return {
    id,
    userId: `us-${b64(user || '')}`,
    libraryId: LIB,
    libraryItemId: String(b.id),
    episodeId: null,
    mediaType: 'book',
    mediaMetadata: item.media.metadata,
    displayTitle: b.title || '',
    displayAuthor: b.author || '',
    // a string, not a nullable one: a book with no picture has no path, and
    // that is an empty string here rather than a null the client will not take
    coverPath: b.cover || '',
    duration: item.media.duration,
    // 0 is direct play: the player fetches the files as they are, and nothing
    // here transcodes on the way out
    playMethod: 0,
    mediaPlayer: 'music-assistant',
    deviceInfo: {
      deviceId: 'music-assistant',
      clientName: 'Music Assistant',
      clientVersion: '',
      manufacturer: '',
      model: '',
    },
    serverVersion: version,
    date: when.toISOString().slice(0, 10),
    dayOfWeek: DAYS[when.getDay()],
    timeListening: 0,
    // where this listener already is, so a session opened on a book in progress
    // does not describe it as starting from nought
    startTime: place ? place.currentTime : 0,
    currentTime: place ? place.currentTime : 0,
    startedAt: when.getTime(),
    updatedAt: when.getTime(),
    chapters: item.media.chapters,
    audioTracks: item.media.tracks,
  };
}

// The session again, by its id. The answer is rebuilt rather than stored: what
// matters in it is `audioTracks`, and those are the files as they are now.
export function openSession(id, req, version) {
  const said = sessions.get(String(id));
  if (!said) return null;
  const b = book(said.book);
  if (!b) return null;
  said.at = Date.now();
  const out = playbackSession(b, said.user, req, version);
  // the same session, not a new one: the id MA is holding has to keep working
  sessions.delete(out.id);
  out.id = String(id);
  sessions.set(out.id, said);
  return out;
}

// What MA reports while a book plays, and once more when it stops: seconds into
// the whole book. The same walk back over the tracks as a progress PATCH, so
// there is one rule for where a second belongs, not two.
export function syncSession(id, body) {
  const said = sessions.get(String(id));
  if (!said) return false;
  said.at = Date.now();
  const seconds = Number((body || {}).currentTime);
  if (Number.isFinite(seconds)) writeProgressFromWhole(said.user, said.book, seconds, false);
  return true;
}

export function closeSession(id, body) {
  const ok = syncSession(id, body);
  sessions.delete(String(id));
  return ok;
}

// A session a player kept to itself while it was offline: it carries the book
// and the second, so it needs no session of ours to have existed.
export function syncFromLocal(user, said) {
  const bookId = Number((said || {}).libraryItemId);
  const seconds = Number((said || {}).currentTime);
  if (!bookId || !Number.isFinite(seconds) || !book(bookId)) return false;
  writeProgressFromWhole(user, bookId, seconds, false);
  return true;
}

// --- one author, one series ----------------------------------------------
// Browsing into an author or a series asks for it by the id this app handed
// out, and a 404 there is not a gentle "nothing here": the client raises a bare
// NotFoundError, which the page shows as an error with no words in it. So both
// answer, and the ids are read back the way they were written.
const nameIn = (id) => { try { return unb64(String(id).replace(/^[a-z]{2}-/, '')); } catch { return ''; } };

export const author = (id) => {
  const name = nameIn(id);
  const mine = books().filter((b) => b.author === name);
  if (!mine.length) return null;
  const named = [...new Set(mine.map((b) => b.series).filter(Boolean))];
  return {
    id: String(id),
    name,
    description: null,
    imagePath: null,
    addedAt: 0,
    updatedAt: now(),
    numBooks: mine.length,
    libraryItems: mine.map(minifiedItem),
    series: named.map((s) => ({
      id: `se-${b64(s)}`,
      name: s,
      items: mine.filter((b) => b.series === s).map(minifiedItem),
    })),
  };
};

// The books of a series, in reading order, and which of them this listener has
// finished — the provider reads the order straight out of `libraryItemIds`.
export const seriesWithProgress = (id, user) => {
  const name = nameIn(id);
  const mine = books().filter((b) => b.series === name)
    .sort((a, b) => (a.series_no || 0) - (b.series_no || 0) || a.title.localeCompare(b.title));
  if (!mine.length) return null;
  const done = new Set(db.prepare('SELECT book_id FROM progress WHERE user = ? AND done = 1')
    .all(user || '').map((r) => String(r.book_id)));
  const ids = mine.map((b) => String(b.id));
  const finished = ids.filter((bookId) => done.has(bookId));
  return {
    id: String(id),
    name,
    description: null,
    addedAt: 0,
    updatedAt: now(),
    books: mine.map(minifiedItem),
    progress: {
      libraryItemIds: ids,
      libraryItemIdsFinished: finished,
      isFinished: finished.length === ids.length,
    },
  };
};

// Browsing a narrator filters the item list rather than asking for the narrator:
// `filter=narrators.<the id we handed out>`. Ignoring it would answer with the
// whole collection under one narrator's name, which is worse than an error.
export const filteredBooks = (filter) => {
  const all = books();
  const said = String(filter || '');
  if (!said) return all;
  const [group, value] = [said.slice(0, said.indexOf('.')), said.slice(said.indexOf('.') + 1)];
  const name = nameIn(decodeURIComponent(value));
  if (group === 'narrators') return all.filter((b) => b.narrator === name);
  if (group === 'authors') return all.filter((b) => b.author === name);
  if (group === 'series') return all.filter((b) => b.series === name);
  if (group === 'genres') return all.filter((b) => b.genre === name);
  // a filter this app does not know is answered with everything rather than
  // nothing: a shelf that is empty for no stated reason reads as a broken server
  return all;
};

export const libraries = () => [library()];
export const books = () => db.prepare(`${BOOK} ORDER BY b.author, series, b.series_no, b.title`).all();
export const book = (id) => db.prepare(`${BOOK} WHERE b.id = ?`).get(Number(id));
export { LIB };
