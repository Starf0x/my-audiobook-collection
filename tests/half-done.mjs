// half-done — the three ways this app could finish a job it had not done.
//
// Each of these ended with the app believing something the disk did not say:
//
//  * a cross-device import whose copy came up short left the half-copy standing,
//    which made the rollback skip itself — the old copy stayed renamed to
//    `Replaced - …` and the library pointed at a broken folder;
//  * a tag write counted only the writes that threw, so a book where every file
//    was unwritable came back `written: 0` with no error, and the whole-
//    collection run counted it as done — "0 file(s) tagged in 200 book(s)";
//  * two conversions of one book could start together, because the lock was
//    taken several awaits after the check that guarded it.
//
// Run: node tests/half-done.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HERE = path.join(ROOT, 'fixtures', 'half-done-test');
const DATA = path.join(HERE, 'data');
const LIB = path.join(HERE, 'library');
const IMPORT = path.join(HERE, 'import');

let failed = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
};
const threw = async (fn) => {
  try {
    await fn();
    return '';
  } catch (e) {
    return e.message;
  }
};

const FRAME = Buffer.from(`fffb10c4${'00'.repeat(100)}`, 'hex');
const mp3 = (seconds) => Buffer.concat(Array(Math.round(seconds * 44100 / 1152)).fill(FRAME));

fs.rmSync(HERE, { recursive: true, force: true });
for (const d of [DATA, IMPORT]) fs.mkdirSync(d, { recursive: true });
const bookDir = path.join(LIB, 'Fantasy', 'Stephen King', 'Gunslinger');
fs.mkdirSync(bookDir, { recursive: true });
for (const n of ['01 - One.mp3', '02 - Two.mp3']) fs.writeFileSync(path.join(bookDir, n), mp3(2));

process.env.DATA_DIR = DATA;
const { db, setSetting } = await import('../server/db.js');
setSetting('libraries', JSON.stringify([{ path: LIB, asGenre: false }]));
setSetting('importPath', IMPORT);

const { scan } = await import('../server/scan.js');
const { applyMetadata } = await import('../server/google.js');
const { convertBook, convertProgress } = await import('../server/convert.js');
const { moveFolder } = await import('../server/import.js');

await scan();
const book = db.prepare("SELECT * FROM books WHERE title = 'Gunslinger'").get();
check('the book is in the library', !!book, true);

// --- 1. a tag write that wrote nothing says so --------------------------
// The files are made unwritable by taking them away under the row: node-id3
// answers false for a file it cannot open, which is exactly the shape that used
// to pass for success.
const hidden = path.join(HERE, 'hidden');
fs.mkdirSync(hidden, { recursive: true });
const files = db.prepare('SELECT path FROM tracks WHERE book_id = ? ORDER BY idx').all(book.id);
for (const f of files) fs.renameSync(f.path, path.join(hidden, path.basename(f.path)));

const wrote = await applyMetadata(book, {}, true);
check('a write that reached no file reports none written', wrote.written, 0);
check('and it does not call that a success', !!wrote.why, true);
check('the reason names how many and which', /2 of 2 file\(s\) could not be written/.test(wrote.why), true);
check('and the row does not claim tags the files do not carry',
  db.prepare('SELECT tagged FROM books WHERE id = ?').get(book.id).tagged, '');

// put them back, and a real write is still a success
for (const f of files) fs.renameSync(path.join(hidden, path.basename(f.path)), f.path);
const good = await applyMetadata(book, {}, true);
check('a write that reached every file says nothing is wrong', [good.written, good.why], [2, '']);
check('and the row now carries what was written',
  db.prepare('SELECT tagged FROM books WHERE id = ?').get(book.id).tagged.includes('album'), true);

// and a part-written book must not claim the lot
fs.renameSync(files[1].path, path.join(hidden, path.basename(files[1].path)));
db.prepare("UPDATE books SET tagged = '' WHERE id = ?").run(book.id);
const half = await applyMetadata(book, {}, true);
check('a part-written book reports what did not go in', [half.written, /1 of 2/.test(half.why)], [1, true]);
check('and its row still claims nothing',
  db.prepare('SELECT tagged FROM books WHERE id = ?').get(book.id).tagged, '');
fs.renameSync(path.join(hidden, path.basename(files[1].path)), files[1].path);

// --- 2. a copy that comes up short leaves nothing behind ----------------
// moveFolder falls back to copying when a rename is refused across devices, and
// checks every file's size afterwards. A file that grows between the copy and
// the check is the shape that fails; here the destination is made to disagree by
// taking a file out of it mid-flight, which the size check then catches.
const src = path.join(IMPORT, 'A Book');
const dest = path.join(HERE, 'landing', 'A Book');
fs.mkdirSync(src, { recursive: true });
fs.writeFileSync(path.join(src, '01.mp3'), mp3(1));
fs.writeFileSync(path.join(src, '02.mp3'), mp3(1));

// Both paths are on one disk here, so the rename would simply work and the copy
// path — the one being checked — would never run. EXDEV is what a share spread
// over several disks answers, so that is what the rename is made to answer, and
// then one file is left short behind the copy's back, which is the failure the
// size check exists to catch.
const realRename = fs.renameSync;
const realCopy = fs.promises.copyFile;
fs.renameSync = () => {
  const e = new Error('cross-device link not permitted');
  e.code = 'EXDEV';
  throw e;
};
let shrank = false;
fs.promises.copyFile = async (from, to) => {
  await realCopy(from, to);
  if (!shrank && to.endsWith('02.mp3')) { shrank = true; fs.writeFileSync(to, 'short'); }
};
const said = await threw(() => moveFolder(src, dest));
fs.renameSync = realRename;
fs.promises.copyFile = realCopy;

check('a copy that came up short is reported', /Copied .* file\(s\) to /.test(said), true);
check('the source is left alone', fs.existsSync(path.join(src, '01.mp3')), true);
check('and the half-copy is swept away', fs.existsSync(dest), false);

// --- 3. two conversions of one book cannot both start -------------------
// Nothing here is really converted: the point is only that the second call is
// refused, and it is refused before the first has done any of its waiting.
check('nothing is converting to begin with', convertProgress.running, false);
const both = await Promise.all([
  threw(() => convertBook(book.id)),
  threw(() => convertBook(book.id)),
]);
const refused = both.filter((m) => /being converted already/.test(m));
check('one of the two is refused outright', refused.length, 1);
check('and the lock is let go afterwards', convertProgress.running, false);

console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
