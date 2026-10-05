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

// A name is bounded and has no control characters in it. It used to arrive at
// `POST /api/users`, which accounts replaced in 2.7.0 — the rule moved with it
// and is checked where it lives now.
const { asName } = await import('../server/listeners.js');
check('a name is cut to something a list can hold', asName(`Frank${long}`).length, 40);
check('and carries no control characters', asName(`Fr${NUL}ank`).includes(NUL), false);
check('a name of nothing but space is no name', asName('   '), '');
check('and the spaces around one are not part of it', asName('  Frank  '), 'Frank');

// --- what the open book route hands out ---------------------------------
// Where a book sits on disk is the edit dialog's and Move…'s business, and
// neither of those is on the listening page — which is the page this route
// answers to anybody. `adminRequired()` reads the environment every time it is
// asked, so a password can be put on this running server and taken off again.
const bookNow = async () => (await fetch(`${BASE}/api/books/7`)).json();

const wideOpen = await bookNow();
check('with no password set, everybody is the admin and gets the path',
  typeof wideOpen.path, 'string');

// With a password set the route is behind the gate, so the question becomes what
// a signed-in *listener* is given — somebody who may play the book and may not
// edit it. (A browser with no account gets nothing at all; that is accounts.mjs.)
process.env.ADMIN_PASSWORD = 'a password';
const { requestAccount, decide } = await import('../server/listeners.js');
await requestAccount({
  name: 'Ann', password: 'a good long one', reason: 'I would like to listen to these books',
});
decide('Ann', 'approved');
const inAs = await fetch(`${BASE}/api/account/signin`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Ann', password: 'a good long one' }),
});
const hers = (inAs.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
const locked = await (await fetch(`${BASE}/api/books/7`, { headers: { Cookie: hers } })).json();

check('a listener gets no path on disk', 'path' in locked, false);
check('nor the folder series the move dialog prefills from', 'folderSeries' in locked, false);
check('nor the name of the cover file on disk', 'cover' in locked, false);
check('but still everything the listening page plays with',
  [locked.title, Array.isArray(locked.tracks), typeof locked.coverV],
  ['A Book', true, 'string']);
delete process.env.ADMIN_PASSWORD;

// --- Move… does not need an import folder ---------------------------------
// The dialog asked `/api/import` for the list of genres, and that route walks
// the import folder and throws when there is none set — or when there is one and
// the share it names is not mounted. Moving a book has nothing to do with
// importing, and `moveBook` is an inline handler, so the throw went nowhere
// anybody would see: the button simply did nothing on an install that had never
// imported. This install has no import folder, which is the case that broke.
const asksImport = await fetch(`${BASE}/api/import`);
check('asking about imports without an import folder is refused',
  [asksImport.status, (await asksImport.json()).error],
  [400, 'No import folder set yet. Add one in Settings.']);
const asksGenres = await fetch(`${BASE}/api/genrefolders`);
check('but the genres can still be had', asksGenres.status, 200);

// Comments off first: the one above this change names the route it stopped
// asking, and reading that back as the code still asking it is how a check comes
// to pass for the wrong reason.
const moveDialog = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8')
  .match(/window\.moveBook = async function[\s\S]*?\n\};/)[0]
  .replace(/^\s*\/\/.*$/gm, '');
check('and Move… asks that one instead',
  [/api\/genrefolders/.test(moveDialog), /api\/import/.test(moveDialog)], [true, false]);

console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
