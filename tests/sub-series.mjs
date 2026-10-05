// sub-series — an author who writes in parts.
//
// Some authors do not write a flat series: it goes
// `Auteur / Serie / Onderdeel / Boek`, which is one level deeper than
// `genre / author / series / book`. The scan used to walk past those folders
// and say so — "a folder deeper than the layout reads" — and the books never
// appeared at all.
//
// The sub-series is read as the **series**, because that is what it is: three
// numbered books that belong together. What is above it is kept beside it as
// `parent_series`, which only groups. That way round nothing else had to
// change: numbering, completeness, Music Assistant and Home Assistant all go on
// reading `series` exactly as before.
//
// Run: node tests/sub-series.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HERE = path.join(ROOT, 'fixtures', 'sub-series-test');
const LIB = path.join(HERE, 'audiobooks');
const DATA = path.join(HERE, 'data');

let failed = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
};

// one silent MPEG frame, repeated: a file the readers accept as audio
const FRAME = Buffer.from(`fffb10c4${'00'.repeat(100)}`, 'hex');
const mp3 = (n) => Buffer.concat(Array(n).fill(FRAME));

fs.rmSync(HERE, { recursive: true, force: true });
const book = (...parts) => {
  const dir = path.join(LIB, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '01 - One.mp3'), mp3(40));
};

// the shape this is all about: author, series, part, three books
book('Fantasy', 'Jane Deep', 'The Great Cycle', 'First Movement', 'Book One');
book('Fantasy', 'Jane Deep', 'The Great Cycle', 'First Movement', 'Book Two');
book('Fantasy', 'Jane Deep', 'The Great Cycle', 'First Movement', 'Book Three');
book('Fantasy', 'Jane Deep', 'The Great Cycle', 'Second Movement', 'Book Four');
// and the ordinary shapes, which must come out exactly as they did before
book('Fantasy', 'Olive Flat', 'A Plain Series', 'Volume One');
book('Fantasy', 'Olive Flat', 'A Plain Series', 'Volume Two');
book('Fantasy', 'Sam Single', 'A Standalone Book');

// a folder of folders where one of them is not a book is not a sub-series: the
// reader is told it is deeper than the layout reads, rather than being handed a
// series with a hole in it
const odd = path.join(LIB, 'Fantasy', 'Jane Deep', 'The Great Cycle', 'Odd Movement');
fs.mkdirSync(path.join(odd, 'Book Five', 'Deeper Still'), { recursive: true });
fs.writeFileSync(path.join(odd, 'Book Five', 'Deeper Still', '01 - One.mp3'), mp3(40));
fs.mkdirSync(path.join(odd, 'Nothing Here'), { recursive: true });

fs.mkdirSync(DATA, { recursive: true });
process.env.DATA_DIR = DATA;
const { db, setSetting } = await import('../server/db.js');
const { scan, lastSkipped } = await import('../server/scan.js');

setSetting('libraries', JSON.stringify([{ path: LIB, asGenre: false }]));
await scan();

const shelf = () => db.prepare(`SELECT title, author, series, parent_series AS parent
  FROM books ORDER BY author, parent_series, series, title`).all();

// --- the books are there at all -------------------------------------------
check('the three books of a part are found', shelf().filter((b) => b.series === 'First Movement')
  .map((b) => b.title), ['Book One', 'Book Three', 'Book Two']);

// --- and read the way the rest of the app already understands --------------
check('the part is the series, because that is what numbers the books',
  shelf().find((b) => b.title === 'Book One')?.series, 'First Movement');
check('and the series above it is kept beside, to group by',
  shelf().find((b) => b.title === 'Book One')?.parent, 'The Great Cycle');
check('a second part is its own series under the same parent',
  shelf().filter((b) => b.parent === 'The Great Cycle').map((b) => [b.series, b.title]),
  [['First Movement', 'Book One'], ['First Movement', 'Book Three'],
    ['First Movement', 'Book Two'], ['Second Movement', 'Book Four']]);

// --- nothing that worked before works differently --------------------------
check('a plain series is still a plain series, with no parent',
  shelf().filter((b) => b.author === 'Olive Flat').map((b) => [b.series, b.parent]),
  [['A Plain Series', ''], ['A Plain Series', '']]);
check('and a book filed straight under its author has neither',
  shelf().filter((b) => b.author === 'Sam Single').map((b) => [b.series, b.parent]),
  [[null, '']]);

// --- one level, and no more ------------------------------------------------
check('a sixth level is still too deep, and is not read as a book',
  shelf().some((b) => b.title === 'Book Five' || b.title === 'Deeper Still'), false);
check('and the reader is told where it is',
  lastSkipped().some((s) => s.reason === 'deeper' && /Odd Movement/.test(s.path)), true);

// --- and a book in a part can be given its number -------------------------
// `/api/books/:id` tells the edit dialog which series folder a book sits in, and
// it answered with the second folder from the top — the series *above* the part.
// `applyMetadata` only writes a book number when that field still names the
// series the book is in, so for every book in a part the two disagreed and the
// number was dropped without a word: typed in, saved, gone.
process.env.PORT = '8545';
process.env.ADMIN_USER = 'tester';
process.env.ADMIN_PASSWORD = 'a very good password';
await import('../server/index.js');
await new Promise((r) => setTimeout(r, 700));
const BASE = 'http://127.0.0.1:8545';

const signin = await fetch(`${BASE}/api/account/signin`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'tester', password: 'a very good password' }),
});
const cookie = (signin.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
const ask = (where) => fetch(BASE + where, { headers: { Cookie: cookie } }).then((r) => r.json());

const idOf = (title) => db.prepare('SELECT id FROM books WHERE title = ?').get(title).id;
const partBook = await ask(`/api/books/${idOf('Book One')}`);
check('the dialog is told the folder the book is in, not the one above it',
  partBook.folderSeries, 'First Movement');
const plainBook = await ask(`/api/books/${idOf('Volume One')}`);
check('and for a book not in a part that is its series, as it always was',
  plainBook.folderSeries, 'A Plain Series');

const saved = await fetch(`${BASE}/api/apply/${idOf('Book One')}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: cookie },
  // what the dialog sends when somebody types a number into it and saves
  body: JSON.stringify({ pick: { title: 'Book One', series: partBook.folderSeries, seriesNo: 2 } }),
});
check('saving a number on a book in a part is accepted', saved.status, 200);
check('and the number is really on the book',
  db.prepare('SELECT series_no FROM books WHERE title = ?').get('Book One').series_no, 2);
check('and it did not leave the part it was in',
  db.prepare('SELECT series, parent_series FROM books WHERE title = ?').get('Book One'),
  { series: 'First Movement', parent_series: 'The Great Cycle' });

console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');

// A moment before going, and not for the checks' sake: they are all done.
//
// This is the first suite that both scans a library — which starts the worker
// threads the tag pool keeps — and runs the server, and `process.exit()` with
// those still closing makes libuv assert on Windows:
//   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c
// The process then leaves with 127 having printed every check as passed, which
// `run-all` reads as a failed suite and nobody reading the output would believe.
// Letting the loop turn first settles it.
await new Promise((r) => setTimeout(r, 300));
process.exit(failed ? 1 : 0);
