// one-at-a-time — the guards that were only in the page, and the two routes
// anybody on the network can post to.
//
// The page refuses to start a second job while one runs. That guards one page:
// a phone beside a laptop, or a reload in the middle of an import, is a request
// the page never knew about, and what it reaches moves folders about. The lock
// lives on the server as well now, and answers 409.
//
// The listening routes stay open — a listener has no password, which is the
// model (§7.12) — but open is not the same as taking whatever arrives.
//
// Run: node tests/one-at-a-time.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HERE = path.join(ROOT, 'fixtures', 'one-at-a-time-test');
const DATA = path.join(HERE, 'data');
const PORT = 8537;
const BASE = `http://127.0.0.1:${PORT}`;

let failed = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
};

fs.rmSync(HERE, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
process.env.DATA_DIR = DATA;
process.env.PORT = String(PORT);

const { db } = await import('../server/db.js');
const { take, busyWith } = await import('../server/onejob.js');
await import('../server/index.js');
await new Promise((r) => setTimeout(r, 700));

const post = async (where, body) => {
  const r = await fetch(`${BASE}${where}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

db.prepare(`INSERT INTO books (id, path, genre, author, title, duration)
            VALUES (7, '/x', 'Fantasy', 'An Author', 'A Book', 60)`).run();

// --- the lock -----------------------------------------------------------
check('nothing holds it to begin with', busyWith(), '');
const done = take('The import');
check('and then something does', busyWith(), 'The import');

const second = await post('/api/move/7', { genre: 'Fantasy', author: 'A', title: 'B' });
check('a second job that moves files is refused', second.status, 409);
check('and the refusal names what is running',
  /The import is still running/.test(second.body.error), true);

done();
check('letting go frees it', busyWith(), '');
const late = take('The move');
late();
check('and letting go twice is harmless', busyWith(), '');

// a job whose own work throws still lets go
const { alone } = await import('../server/onejob.js');
await alone('The delete', async () => { throw new Error('no'); }).catch(() => {});
check('a job that fails lets go too', busyWith(), '');

// --- what the open routes accept ----------------------------------------
const NUL = String.fromCharCode(0);
const long = 'x'.repeat(400);

check('a place in a book that names no book is refused',
  (await post('/api/progress', { user: 'Frank', bookId: 99, trackIdx: 0, position: 1 })).status, 404);
check('a track that is not a number is refused',
  (await post('/api/progress', { user: 'Frank', bookId: 7, trackIdx: 'x', position: 1 })).status, 400);
check('a position that is not a number is refused',
  (await post('/api/progress', { user: 'Frank', bookId: 7, trackIdx: 0, position: 'soon' })).status, 400);
check('a position before the beginning is refused',
  (await post('/api/progress', { user: 'Frank', bookId: 7, trackIdx: 0, position: -5 })).status, 400);
check('and an ordinary place is kept',
  (await post('/api/progress', { user: 'Frank', bookId: 7, trackIdx: 0, position: 12 })).status, 200);
check('which is really in the database',
  db.prepare("SELECT position FROM progress WHERE user = 'Frank'").get().position, 12);

check('ticking a book that is not there is refused',
  (await post('/api/listened', { user: 'Frank', bookId: 99, done: true })).status, 404);

await post('/api/users', { name: `  Frank${NUL}${long}  ` });
const names = db.prepare('SELECT name FROM users').all().map((u) => u.name);
const kept = names.find((n) => n.startsWith('Frank'));
check('a name is cut to something a list can hold', kept.length <= 60, true);
check('and carries no control characters', kept.includes(NUL), false);

await post('/api/users', { name: '   ' });
check('a name of nothing but space makes no listener',
  db.prepare('SELECT COUNT(*) AS n FROM users').get().n, names.length);

// --- what the open book route hands out ---------------------------------
// Where a book sits on disk is the edit dialog's and Move…'s business, and
// neither of those is on the listening page — which is the page this route
// answers to anybody. `adminRequired()` reads the environment every time it is
// asked, so a password can be put on this running server and taken off again.
const bookNow = async () => (await fetch(`${BASE}/api/books/7`)).json();

const wideOpen = await bookNow();
check('with no password set, everybody is the admin and gets the path',
  typeof wideOpen.path, 'string');

process.env.ADMIN_PASSWORD = 'a password';
const locked = await bookNow();
check('with one set, a browser that has not unlocked gets no path', 'path' in locked, false);
check('nor the folder series the move dialog prefills from', 'folderSeries' in locked, false);
check('nor the name of the cover file on disk', 'cover' in locked, false);
check('but still everything the listening page plays with',
  [locked.title, Array.isArray(locked.tracks), typeof locked.coverV],
  ['A Book', true, 'string']);
delete process.env.ADMIN_PASSWORD;

console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
