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

console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
