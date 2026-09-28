// safe-paths — the three places a path came from outside and went to the disk.
//
// Each of these was reachable before the fix, and each is checked here against
// the shape that reached it:
//
//  * a cover column naming something outside covers/, which `GET /api/cover/:id`
//    served to anyone on the network although only an admin could write it;
//  * an import or a filing whose source folder was anywhere on the host;
//  * a scan that read no library at all and took that for "the library is empty",
//    dropping every book row — and with it, through the
//    `progress_follows_books` trigger, everybody's place in every book.
//
// The last one is why this suite builds a real library of real (silent) MPEG
// frames and runs a real scan: the rule it pins down is about what a walk did or
// did not manage to read, which no stub can stand in for.
//
// Run: node tests/safe-paths.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HERE = path.join(ROOT, 'fixtures', 'safe-paths-test');
const DATA = path.join(HERE, 'data');
const LIB = path.join(HERE, 'library');
const IMPORT = path.join(HERE, 'import');
const OUTSIDE = path.join(HERE, 'outside');

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

// --- a library of real frames -------------------------------------------
const FRAME = Buffer.from(`fffb10c4${'00'.repeat(100)}`, 'hex');
const mp3 = (seconds) => Buffer.concat(Array(Math.round(seconds * 44100 / 1152)).fill(FRAME));

fs.rmSync(HERE, { recursive: true, force: true });
for (const d of [DATA, IMPORT, OUTSIDE]) fs.mkdirSync(d, { recursive: true });

const BOOKS = [
  ['Fantasy', 'Stephen King', 'Gunslinger'],
  ['Fantasy', 'Stephen King', 'The Drawing of the Three'],
  ['Science Fiction', 'Frank Herbert', 'Dune'],
];
for (const [genre, author, title] of BOOKS) {
  const dir = path.join(LIB, genre, author, title);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '01 - One.mp3'), mp3(2));
}
// a picture beside the audio, which is the one kind of cover that lives outside
// covers/ and is therefore allowed to
const besideAudio = path.join(LIB, 'Fantasy', 'Stephen King', 'Gunslinger', 'cover.jpg');
fs.writeFileSync(besideAudio, Buffer.from('ffd8ffdb00', 'hex'));
// and a folder that is nobody's business, with something worth stealing in it
fs.writeFileSync(path.join(OUTSIDE, 'secrets.txt'), 'the admin password');

process.env.DATA_DIR = DATA;
const { db, setSetting } = await import('../server/db.js');
setSetting('libraries', JSON.stringify([{ path: LIB, asGenre: false }]));
setSetting('importPath', IMPORT);

const { scan, progress } = await import('../server/scan.js');
const { coverFile, storedCover, inside } = await import('../server/safepath.js');
const { importBook, skipImport, clean } = await import('../server/import.js');
const { fileSkipped } = await import('../server/skipped.js');
const { applyMetadata } = await import('../server/google.js');

const titles = () => db.prepare('SELECT title FROM books ORDER BY title').all().map((b) => b.title);

await scan();
check('the library scanned', titles(), ['Dune', 'Gunslinger', 'The Drawing of the Three']);

// --- 1. what a cover column may name ------------------------------------
const stored = 'd41d8cd98f00b204e9800998ecf8427e.jpg';
fs.writeFileSync(path.join(DATA, 'covers', stored), Buffer.from('ffd8ffdb00', 'hex'));

check('a stored cover resolves', path.basename(coverFile(stored)), stored);
check('a picture beside the audio resolves', path.basename(coverFile(`file:${besideAudio}`)), 'cover.jpg');
// The traversal has to point at something that is really there, or the check
// passes because the target is missing rather than because the guard held — and
// a check that cannot fail is not a check. `../../outside/secrets.txt` from
// covers/ lands on the file written above.
check('the file this traversal aims at really exists',
  fs.existsSync(path.join(DATA, 'covers', '../../outside/secrets.txt')), true);
check('a cover climbing out of covers/ resolves to nothing',
  coverFile('../../outside/secrets.txt'), '');
check('and neither does the same with backslashes',
  coverFile('..\\..\\outside\\secrets.txt'), '');
check('and so does one with a path in it', coverFile('sub/dir/art.jpg'), '');
check('a file: cover outside every library folder resolves to nothing',
  coverFile(`file:${path.join(OUTSIDE, 'secrets.txt')}`), '');
check('a file: cover that is a folder rather than a file resolves to nothing',
  coverFile(`file:${LIB}`), '');
check('a name that is not a picture at all resolves to nothing',
  [coverFile('passwd'), coverFile('art.exe'), coverFile('')], ['', '', '']);
check('the shape a stored cover must have',
  [storedCover(stored), storedCover('../x.jpg'), storedCover('a/b.jpg'), storedCover('x.webp')],
  [true, false, false, false]);

// the write side: the one place a cover can be named from outside
const book = db.prepare("SELECT * FROM books WHERE title = 'Dune'").get();
check('applying a cover from outside covers/ is refused',
  await threw(() => applyMetadata(book, { cover: '../../etc/passwd' }, false)),
  'That is not a cover this app stored.');
check('and the book keeps the cover it had',
  db.prepare('SELECT cover FROM books WHERE id = ?').get(book.id).cover, null);
await applyMetadata(book, { cover: stored }, false);
check('a cover this app stored is taken',
  db.prepare('SELECT cover FROM books WHERE id = ?').get(book.id).cover, stored);

// --- 2. where a folder may be moved from --------------------------------
const outsideBook = path.join(OUTSIDE, 'Someone Else');
fs.mkdirSync(outsideBook, { recursive: true });
fs.writeFileSync(path.join(outsideBook, '01.mp3'), mp3(1));
const insideImport = path.join(IMPORT, 'A New Book');
fs.mkdirSync(insideImport, { recursive: true });
fs.writeFileSync(path.join(insideImport, '01.mp3'), mp3(1));

check('importing a folder from outside the import folder is refused',
  await threw(() => importBook({ source: outsideBook, genre: 'Fantasy', author: 'X', title: 'Y' })),
  'That folder is not inside the import folder, so this app will not move it.');
check('and the folder is still where it was', fs.existsSync(outsideBook), true);
check('setting one aside is refused the same way',
  await threw(() => skipImport(outsideBook)),
  'That folder is not inside the import folder, so this app will not move it.');
check('the import folder itself is not a book to import',
  await threw(() => importBook({ source: IMPORT, genre: 'Fantasy', author: 'X', title: 'Y' })),
  'That folder is not inside the import folder, so this app will not move it.');
check('filing a folder from outside the library is refused',
  await threw(() => fileSkipped({ source: outsideBook, reason: 'loose', genre: 'Fantasy', author: 'X', title: 'Y' })),
  'That folder is not inside a library folder, so this app will not move it.');

// and the ordinary case still goes through
await importBook({ source: insideImport, genre: 'Fantasy', author: 'New Author', title: 'A New Book' });
check('a book inside the import folder is imported', titles().includes('A New Book'), true);

check('a name that is only dots is not a name',
  [clean('..'), clean('.'), clean('...'), clean('The Dark Tower')],
  ['--', '-', '---', 'The Dark Tower']);
check('containment says no to the root itself and yes to what is under it',
  [inside(LIB, LIB), inside(LIB, path.join(LIB, 'Fantasy')), inside(LIB, OUTSIDE)],
  [false, true, false]);

// --- 3. a scan that could read nothing must remove nothing ---------------
const before = titles();
setSetting('libraries', '{ this will not parse');
await scan();
check('a libraries setting that will not parse removes no books', titles(), before);
// and it says so rather than reporting a clean scan of nothing
check('and the scan says why nothing was removed',
  /No library folder could be read/.test(progress.warning), true);

setSetting('libraries', JSON.stringify([{ path: path.join(HERE, 'not-there'), asGenre: false }]));
await scan();
check('a library folder that is not there removes no books', titles(), before);

// the real thing: a folder that really did go
setSetting('libraries', JSON.stringify([{ path: LIB, asGenre: false }]));
fs.rmSync(path.join(LIB, 'Science Fiction'), { recursive: true, force: true });
await scan();
check('a book whose folder is gone is dropped', titles().includes('Dune'), false);
check('and the rest of the library is still there',
  titles().includes('Gunslinger') && titles().includes('The Drawing of the Three'), true);

// Two shares, one of them away: the half that could not be read keeps its books
// while the half that could is reconciled as usual. This is the case the early
// exit above does not cover — there the walk read nothing at all, here it read
// something, and "something" must not stand in for "everything".
const OTHER = path.join(HERE, 'library-two');
const otherBook = path.join(OTHER, 'Crime', 'Agatha Christie', 'Murder on the Orient Express');
fs.mkdirSync(otherBook, { recursive: true });
fs.writeFileSync(path.join(otherBook, '01.mp3'), mp3(1));
setSetting('libraries', JSON.stringify([{ path: LIB, asGenre: false }, { path: OTHER, asGenre: false }]));
await scan();
check('both libraries scanned', titles().includes('Murder on the Orient Express'), true);

// the second share goes away — not deleted, just not there to read
fs.renameSync(OTHER, `${OTHER}-unplugged`);
const goneBook = path.join(LIB, 'Fantasy', 'Stephen King', 'The Drawing of the Three');
fs.rmSync(goneBook, { recursive: true, force: true });
await scan();
check('a book on the share that went away is kept',
  titles().includes('Murder on the Orient Express'), true);
check('and a book really gone from the share that was read is dropped',
  titles().includes('The Drawing of the Three'), false);
fs.renameSync(`${OTHER}-unplugged`, OTHER);
setSetting('libraries', JSON.stringify([{ path: LIB, asGenre: false }]));

// and what a place in a book is worth: the row must outlive a failed walk
db.prepare(`INSERT INTO progress (user, book_id, track_idx, position, updated)
            VALUES ('Frank', (SELECT id FROM books WHERE title = 'Gunslinger'), 0, 42, datetime('now'))`).run();
setSetting('libraries', '[]');
await scan();
check('no libraries at all removes no books', titles().includes('Gunslinger'), true);
check('and nobody loses their place',
  db.prepare("SELECT position FROM progress WHERE user = 'Frank'").get()?.position, 42);

console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
