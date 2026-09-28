// outward — what this app fetches when it is told an address, and what it writes
// into a file somebody else's player reads.
//
// Nothing here goes near the internet: every check is about a request that must
// be refused before it is made, or about text that must not become syntax.
//
// Run: node tests/outward.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'fixtures', 'outward-test', 'data');

let failed = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
};
const threw = (fn) => {
  try {
    fn();
    return '';
  } catch (e) {
    return e.message;
  }
};

fs.rmSync(path.dirname(DATA), { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
process.env.DATA_DIR = DATA;

const { picture } = await import('../server/outbound.js');
const { db } = await import('../server/db.js');
const { saveHaSettings, haSettings, bookPlaylist } = await import('../server/ha.js');

// --- an address a request handed us -------------------------------------
// This server can reach the router, the other containers and the address cloud
// hosts keep their credentials at. A cover never lives on any of them.
const NL = String.fromCharCode(10);
const refusals = [];
for (const [what, url] of [
  ['plain http', 'http://example.com/cover.jpg'],
  ['a file on this disk', 'file:///etc/passwd'],
  ['something that is not an address', 'cover.jpg'],
  ['this machine', 'https://127.0.0.1/cover.jpg'],
  ['this machine by name', 'https://localhost/cover.jpg'],
  ['the cloud metadata address', 'https://169.254.169.254/latest/meta-data/'],
  ['a private range', 'https://192.168.2.200/cover.jpg'],
  ['another private range', 'https://10.0.0.5/cover.jpg'],
  ['the carrier range Tailscale sits in', 'https://100.100.100.100/cover.jpg'],
]) {
  // eslint-disable-next-line no-await-in-loop -- one at a time reads better here
  const got = await picture(url);
  refusals.push([what, !!got.error && !got.bytes]);
}
check('every address that is not a public https picture is refused', refusals,
  refusals.map(([what]) => [what, true]));

const said = await picture('https://192.168.2.200/cover.jpg');
check('and the refusal says which network it is on', /on this network/.test(said.error), true);
check('an http address says what it wanted instead',
  (await picture('http://example.com/a.jpg')).error, 'Only https addresses are fetched.');

// --- a title that tries to become a playlist line -----------------------
db.prepare(`INSERT INTO books (id, path, genre, author, title, duration)
            VALUES (1, '/x', 'Fantasy', 'An Author', ?, 10)`)
  .run(`Gunslinger${NL}#EXTINF:1,Not a real track`);
db.prepare(`INSERT INTO tracks (book_id, idx, path, title, duration)
            VALUES (1, 0, '/x/1.mp3', ?, 10)`).run(`One${NL}http://elsewhere/steal.mp3`);

const m3u = bookPlaylist({ headers: { host: 'h' }, protocol: 'http' }, 1, 0);
const lines = m3u.trim().split(NL);
check('the playlist is the four lines it should be', lines.length, 4);
check('and they are the ones this app wrote',
  [lines[0], lines[3]], ['#EXTM3U', 'http://h/api/stream/1']);
check('the smuggled track line never becomes a line', lines.includes('#EXTINF:1,Not a real track'), false);
check('nor does the smuggled address', lines.includes('http://elsewhere/steal.mp3'), false);
check('the title is still readable, only folded',
  /Gunslinger #EXTINF:1,Not a real track/.test(lines[1]), true);

// --- the address the Home Assistant token is sent to --------------------
saveHaSettings({ url: 'http://192.168.2.200:8123/lovelace/0', token: 'a-long-lived-token' });
check('a dashboard path is taken off the address', haSettings().url, 'http://192.168.2.200:8123');
check('and the token is kept', haSettings().hasToken, true);

saveHaSettings({ url: 'http://192.168.2.200:8123' });
check('saving the same address again keeps the token', haSettings().hasToken, true);

saveHaSettings({ url: 'http://somewhere-else.example:8123' });
check('but pointing it at another Home Assistant forgets the token', haSettings().hasToken, false);

for (const [what, url] of [
  ['a word', 'not an address'],
  ['a file', 'file:///etc/passwd'],
  ['another protocol', 'ftp://host/'],
]) {
  check(`${what} is refused as an address`, !!threw(() => saveHaSettings({ url })), true);
}
check('and the address that was there is untouched',
  haSettings().url, 'http://somewhere-else.example:8123');

console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
