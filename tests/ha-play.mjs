// Play here, against a Home Assistant that is not there: a small server stands in
// for it and answers each play_media the way a real player's integration does.
//
// The owner's 3Reality speaker made HA answer HTTP 500 to a playlist, and the page
// said "Home Assistant answered HTTP 500." and nothing more (2.14.204). So: what
// HA says goes into the message, a player that will not take a playlist is given
// the track instead, and the playlist carries HA_TOKEN when the container has one.
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

// what the fake HA was asked, and how it answers a playlist
const asked = [];
let refusePlaylist = false;
const ha = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const said = body ? JSON.parse(body) : {};
    asked.push(said);
    if (refusePlaylist && String(said.media_content_id || '').includes('.m3u')) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      return res.end('500 Internal Server Error\n\nServer got itself in trouble');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('[]');
  });
});
await new Promise((r) => ha.listen(0, '127.0.0.1', r));

const { db, setSetting } = await import('../server/db.js');
const { haPlay } = await import('../server/ha.js');
setSetting('haUrl', `http://127.0.0.1:${ha.address().port}`);
setSetting('haToken', 'outbound-token');
db.prepare("INSERT INTO books (id, path, genre, author, title) VALUES (1, '/a/b', 'Fantasy', 'Adair Hart', 'The Purification')").run();
for (const i of [0, 1, 2]) {
  db.prepare('INSERT INTO tracks (id, book_id, idx, path, title, duration) VALUES (?, 1, ?, ?, ?, 60)')
    .run(10 + i, i, `/a/b/${i}.mp3`, `Track ${i + 1}`);
}
const req = { headers: { host: 'x' }, protocol: 'http', query: {} };

{
  const r = await haPlay(req, { player: 'media_player.kitchen', bookId: 1, from: 1 });
  check('a player that takes a playlist is given one, with the token it will be asked for',
    [asked[0].media_content_id, r.single],
    ['http://books.local:8080/api/ha/book/1.m3u?from=1&token=inbound-secret', false]);
}

asked.length = 0;
refusePlaylist = true;
{
  const r = await haPlay(req, { player: 'media_player.3reality', bookId: 1, from: 1 });
  check('one that fails the playlist is given the track the listener is on',
    [asked.length, asked[1].media_content_id, asked[1].media_content_type, r.single],
    [2, 'http://books.local:8080/api/stream/11', 'music', true]);
}

// and when HA fails that as well, its own words come back with the number
ha.removeAllListeners('request');
ha.on('request', (q, res) => {
  q.resume();
  q.on('end', () => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Error communicating with the speaker' }));
  });
});
{
  const e = await haPlay(req, { player: 'media_player.3reality', bookId: 1 }).catch((err) => err);
  check('a failure says what Home Assistant said to each attempt', e.message,
    'Home Assistant refused the playlist (HTTP 500: Error communicating with the speaker) '
    + 'and the single track (HTTP 500: Error communicating with the speaker). Its log says which part it could not handle.');
}

ha.close();
console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
