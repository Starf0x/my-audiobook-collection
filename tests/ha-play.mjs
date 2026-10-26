// Play here, against a Home Assistant that is not there: a small server stands in
// for it and answers each play_media the way a real player's integration does.
//
// The owner's 3Reality speaker made HA answer HTTP 500 to a playlist (2.14.204),
// was refused by the sign-in gate (2.14.226), and then took a playlist and played
// nothing. So a player is handed signed track addresses one by one: queued behind
// the first where it can queue, and otherwise the next one when a track ends.
//
// Run: node tests/ha-play.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-play-'));
process.env.DATA_DIR = DATA;
process.env.HA_TOKEN = 'inbound-secret';
process.env.BASE_URL = 'http://books.local:8080';

let failed = 0;
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) console.log(`     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`);
};

// what the fake HA was asked, and what it says each player is doing
const asked = [];
const players = {
  'media_player.sonos': { state: 'idle', attributes: { supported_features: 2097152 | 512 } },
  'media_player.3reality': { state: 'idle', attributes: { supported_features: 512 } },
};
let failAll = false;
const ha = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const states = req.url.match(/^\/api\/states\/(.+)$/);
    if (states) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(players[decodeURIComponent(states[1])] || {}));
    }
    asked.push(body ? JSON.parse(body) : {});
    if (failAll) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ message: 'Error communicating with the speaker' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('[]');
  });
});
await new Promise((r) => ha.listen(0, '127.0.0.1', r));

const { db, setSetting } = await import('../server/db.js');
const { haPlay, haControl, haSpeed, haSetSpeed, playerSigOk, bookPlaylist, FOLLOW_EVERY, KEEP_EVERY, stopFollowing } = await import('../server/ha.js');
KEEP_EVERY.ms = 30; // how often a speaker's place is read; set before anything plays
setSetting('haUrl', `http://127.0.0.1:${ha.address().port}`);
setSetting('haToken', 'outbound-token');
db.prepare("INSERT INTO books (id, path, genre, author, title) VALUES (1, '/a/b', 'Fantasy', 'Adair Hart', 'The Purification')").run();
for (const i of [0, 1, 2]) {
  db.prepare('INSERT INTO tracks (id, book_id, idx, path, title, duration) VALUES (?, 1, ?, ?, ?, 0.05)')
    .run(10 + i, i, `/a/b/${i}.mp3`, `Track ${i + 1}`);
}
const req = { headers: { host: 'x' }, protocol: 'http', query: {} };
const asking = (u) => ({ originalUrl: u.pathname + u.search, query: Object.fromEntries(u.searchParams) });
const plays = () => asked.filter((a) => a.media_content_id)
  .map((a) => [new URL(a.media_content_id).pathname, a.enqueue || '']);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

{
  const r = await haPlay(req, { player: 'media_player.sonos', bookId: 1, from: 1 });
  check('a player that queues is given the track it is on, and the rest of the book behind it',
    [plays(), r.queued, r.single],
    [[['/api/stream/11', ''], ['/api/stream/12', 'add']], 1, false]);
  const url = new URL(asked.find((a) => a.media_content_id).media_content_id);
  check('as music, signed, and without the HA_TOKEN secret in it',
    [asked[0].media_content_type, /^[0-9a-f]{32}$/.test(url.searchParams.get('sig') || ''), url.searchParams.has('token')],
    ['music', true, false]);

  // The player has no cookie, and without HA_TOKEN nothing else either: it was
  // answered "Sign in first." (2.14.226). The signature is what lets it in, for
  // that one path only.
  check('the signed address is let in', playerSigOk(asking(url)), true);
  const other = new URL(url);
  other.pathname = '/api/stream/12';
  check('and the same signature opens no other track', playerSigOk(asking(other)), false);
  const tracks = bookPlaylist(req, 1, 0).split('\n').filter((l) => l.startsWith('http'));
  check('every track in a playlist is signed as well',
    tracks.map((l) => playerSigOk(asking(new URL(l)))), [true, true, true]);
}

// A player that cannot queue — the owner's ESPHome speaker — gets one track, and
// the next when HA says the first has played out.
asked.length = 0;
FOLLOW_EVERY.ms = 20;
{
  const r = await haPlay(req, { player: 'media_player.3reality', bookId: 1, from: 1 });
  check('one that cannot queue is given the track it is on', [plays(), r.single], [[['/api/stream/11', '']], true]);
  players['media_player.3reality'].state = 'playing';
  await wait(120);
  players['media_player.3reality'].state = 'idle';
  await wait(120);
  check('and the next one when that track has played out', plays().map(([p]) => p),
    ['/api/stream/11', '/api/stream/12']);
  stopFollowing();
}

// Stop from the app's page stops the speaker, and the app hands it nothing more:
// a book on a speaker could not be stopped from the page at all (2.14.237).
asked.length = 0;
players['media_player.3reality'].state = 'idle';
{
  await haPlay(req, { player: 'media_player.3reality', bookId: 1, from: 0 });
  players['media_player.3reality'].state = 'playing';
  await wait(60);
  await haControl({ player: 'media_player.3reality', action: 'stop' });
  players['media_player.3reality'].state = 'idle';
  await wait(120);
  check('Stop is passed to the player, and no next track follows it',
    [asked.some((a) => a.entity_id === 'media_player.3reality' && !a.media_content_id), plays().map(([p]) => p)],
    [true, ['/api/stream/10']]);
}

// HA cannot set a speaker's speed, so the app plays it at that speed (2.14.325):
// the address asks for the speed, and the first track for the second to start at,
// since a seek into a stream made as it is sent cannot be asked for.
asked.length = 0;
{
  const params = () => asked.filter((a) => a.media_content_id).map((a) => {
    const u = new URL(a.media_content_id);
    return [u.pathname, u.searchParams.get('speed'), u.searchParams.get('at')];
  });
  const r = await haPlay(req, { player: 'media_player.sonos', bookId: 1, from: 1, seek: 30, speed: 1.5 });
  check('a speed other than 1× is in every address, the start only in the first, and no seek is asked',
    [params(), r.seeked, asked.some((a) => 'seek_position' in a)],
    [[['/api/stream/11', '1.5', '30'], ['/api/stream/12', '1.5', null]], true, false]);
  asked.length = 0;
  players['media_player.sonos'] = { state: 'paused', attributes: { supported_features: 2097152 | 512, media_position: 20 } };
  await haSpeed(req, { player: 'media_player.sonos', speed: 1.2 });
  check('a new speed starts the track again where the speaker got to: 30 s + 20 s heard at 1.5×',
    params()[0], ['/api/stream/11', '1.2', '60']);
  const none = await haSpeed(req, { player: 'media_player.nothing', speed: 1.2 }).catch((e) => e.message);
  check('and on a player this app started nothing on, it says so', none, 'Nothing this app started is playing there.');
}

// A book on a speaker moved nobody's place, so the app and HA stayed where the
// browser had left them (2.14.325). Its place is now read off the speaker.
asked.length = 0;
{
  players['media_player.sonos'] = { state: 'playing', attributes: { supported_features: 2097152 | 512, media_position: 42 } };
  db.prepare('UPDATE tracks SET duration = 600').run();
  await haPlay(req, { player: 'media_player.sonos', bookId: 1, from: 1, listener: 'Ada' });
  await wait(150);
  const kept = db.prepare("SELECT track_idx, position, via FROM progress WHERE user = 'Ada' AND book_id = 1").get();
  check('the place a speaker has got to is kept under the listener who pressed Play',
    kept && [kept.track_idx, kept.position, kept.via], [1, 42, 'home-assistant']);
  // the owner resumes with the speaker's own button, so what the app started has
  // to outlive a restart of the app (2.14.336)
  const { getSetting } = await import('../server/db.js');
  check('and what is playing where is kept in the database, for after a restart',
    JSON.parse(getSetting('haNowOn') || '[]').map(([e, w]) => [e, w.bookId, w.listener]),
    [['media_player.sonos', 1, 'Ada']]);
  // a player that says what it plays: another of the book's tracks is followed…
  players['media_player.sonos'].attributes.media_content_id = 'http://x/api/stream/12?sig=1';
  players['media_player.sonos'].attributes.media_position = 7;
  await wait(150);
  const moved = db.prepare("SELECT track_idx, position FROM progress WHERE user = 'Ada' AND book_id = 1").get();
  check('a speaker that moved on to the next track moves the place with it', [moved.track_idx, moved.position], [2, 7]);
  // …and something that is not this book moves nothing
  players['media_player.sonos'].attributes.media_content_id = 'spotify:track:abc';
  players['media_player.sonos'].attributes.media_position = 99;
  await wait(150);
  const still = db.prepare("SELECT track_idx, position FROM progress WHERE user = 'Ada' AND book_id = 1").get();
  check('and music that is not the book leaves the place alone', [still.track_idx, still.position], [2, 7]);
  await haControl({ player: 'media_player.sonos', action: 'stop' });
  db.prepare('UPDATE tracks SET duration = 0.05').run();
}

// Started from Home Assistant there is no speed in the call: the owner played
// on the speaker through HA and it stayed at 1× (2.14.336). The listener's own
// choice, kept by the app, is used — and a new one restarts what is playing.
asked.length = 0;
{
  const speeds = () => asked.filter((a) => a.media_content_id)
    .map((a) => new URL(a.media_content_id).searchParams.get('speed'));
  await haSetSpeed(req, { listener: 'Ada', speed: 1.5, apply: false });
  players['media_player.sonos'] = { state: 'playing', attributes: { supported_features: 2097152 | 512, media_position: 0 } };
  await haPlay(req, { player: 'media_player.sonos', bookId: 1, from: 2, listener: 'Ada' });
  check('a book started without a speed plays at the one the listener chose', speeds(), ['1.5']);
  asked.length = 0;
  const r = await haSetSpeed(req, { listener: 'Ada', speed: 1.2 });
  check('and choosing another starts the speaker again at it',
    [r.restarted, speeds()], [['media_player.sonos'], ['1.2']]);
  await haControl({ player: 'media_player.sonos', action: 'stop' });
}

// and when HA refuses, its own words come back with the number
asked.length = 0;
failAll = true;
{
  const e = await haPlay(req, { player: 'media_player.3reality', bookId: 1 }).catch((err) => err);
  check('a failure says what Home Assistant said', e.message,
    'Home Assistant answered HTTP 500: Error communicating with the speaker');
}

ha.close();
console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
