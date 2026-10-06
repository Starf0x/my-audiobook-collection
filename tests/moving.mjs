// moving — filing a book somewhere else, throwing one away, and getting it back.
//
// These are the routes that pick up the owner's audiobooks and put them
// somewhere else. Until this suite, `/api/trash` had no checks at all — not the
// delete, not the restore, not the purge, not emptying it — and `/api/move` had
// one, which only proved that a second job is refused while another runs. The
// code that can lose a book was the least covered in the app.
//
// Everything here is checked against the **disk** as well as the database: a
// move that updates a row and leaves the files where they were is the failure
// worth catching, and it would pass any check that only reads the library.
//
// The database is also backed up on startup, so this is where that is checked
// too: it writes beside the database, the copy really opens, and the oldest go.
//
// Run: node tests/moving.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HERE = path.join(ROOT, 'fixtures', 'moving-test');
const LIB = path.join(HERE, 'audiobooks');
const DATA = path.join(HERE, 'data');

let failed = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
};

// One of these steps throwing would end the run where it stood, and the checks
// after it — the ones about the files — would never be reached. For routes whose
// whole point is that they move somebody's audiobooks about, a failure in one
// step should be named and the rest still asked. So a throw becomes a failed
// check with the reason on it, and the suite carries on.
const ran = async (label, fn) => {
  try {
    return await fn();
  } catch (e) {
    failed++;
    console.log(`FAIL ${label}\n       threw ${e.message}`);
    return null;
  }
};

const FRAME = Buffer.from(`fffb10c4${'00'.repeat(100)}`, 'hex');
const mp3 = (n) => Buffer.concat(Array(n).fill(FRAME));

fs.rmSync(HERE, { recursive: true, force: true });
const make = (...parts) => {
  const dir = path.join(LIB, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '01 - One.mp3'), mp3(40));
  return dir;
};
make('Fantasy', 'Olive Flat', 'A Plain Series', 'Volume One');
make('Fantasy', 'Olive Flat', 'A Plain Series', 'Volume Two');
make('Fantasy', 'Sam Single', 'A Standalone Book');
make('Thriller', 'Sam Single', 'Another Book');
fs.mkdirSync(DATA, { recursive: true });

process.env.DATA_DIR = DATA;
const { db, setSetting } = await import('../server/db.js');
const { scan } = await import('../server/scan.js');
const { moveBook, deleteToTrash, listTrash, restoreFromTrash, purge, emptyTrash } =
  await import('../server/trash.js');
const { backupNow, listBackups, KEEP } = await import('../server/backup.js');

setSetting('libraries', JSON.stringify([{ path: LIB, asGenre: false }]));
await scan();

const idOf = (title) => db.prepare('SELECT id FROM books WHERE title = ?').get(title)?.id;
const rowOf = (title) => db.prepare('SELECT genre, author, series, path FROM books WHERE title = ?').get(title);
const under = (p) => path.relative(LIB, p).split(path.sep).join('/');
const there = (p) => fs.existsSync(p) && fs.readdirSync(p).some((f) => f.endsWith('.mp3'));

check('the library is read', db.prepare('SELECT COUNT(*) AS n FROM books').get().n, 4);

// --- filing a book somewhere else -----------------------------------------
{
  const was = rowOf('Volume One').path;
  await moveBook(idOf('Volume One'), {
    genre: 'Fantasy', author: 'Olive Flat', series: 'A Renamed Series', title: 'Volume One',
  });
  const now = rowOf('Volume One');
  check('the row says where it went', under(now.path), 'Fantasy/Olive Flat/A Renamed Series/Volume One');
  check('and the audio is really there', there(now.path), true);
  check('and really gone from where it was', fs.existsSync(was), false);
  check('the series it was filed under came with it', now.series, 'A Renamed Series');
}

// A book can leave its series entirely, which empties the folder behind it. The
// old series folder must go: an author with an empty folder under them would be
// listed as having a series with nothing in it.
{
  await moveBook(idOf('Volume Two'), {
    genre: 'Fantasy', author: 'Olive Flat', series: '', title: 'Volume Two',
  });
  check('a book can come out of its series', under(rowOf('Volume Two').path), 'Fantasy/Olive Flat/Volume Two');
  check('and the folder it emptied is gone',
    fs.existsSync(path.join(LIB, 'Fantasy', 'Olive Flat', 'A Plain Series')), false);
}

// Two books cannot share a folder, and the refusal must leave the first alone.
{
  const standing = rowOf('Another Book').path;
  let said = '';
  try {
    await moveBook(idOf('Volume Two'), {
      genre: 'Thriller', author: 'Sam Single', series: '', title: 'Another Book',
    });
  } catch (e) { said = e.message; }
  check('moving onto a book that is already there is refused', /already/i.test(said), true);
  check('and the book that was there is untouched', there(standing), true);
  check('as is the one that tried to move', there(rowOf('Volume Two').path), true);
}

// --- throwing one away, and getting it back -------------------------------
const when = Date.parse('2026-10-06T12:00:00Z');
{
  const was = rowOf('A Standalone Book').path;
  await deleteToTrash(idOf('A Standalone Book'), when);
  check('a deleted book is out of the library', idOf('A Standalone Book'), undefined);
  check('and its folder is gone from the shelf', fs.existsSync(was), false);

  const [t] = listTrash(when);
  check('the trash knows what it was', [t.title, t.author, t.genre], ['A Standalone Book', 'Sam Single', 'Fantasy']);
  check('and that the files are really in it', [t.onDisk, there(t.trash_path)], [true, true]);
  check('and how long it has left', t.daysLeft, 30);
  check('it says where it came from, which is how it goes back', t.was_path, was);

  await ran('restoring the book is possible at all', () => restoreFromTrash(t.id));
  check('restoring puts the book back in the library', !!idOf('A Standalone Book'), true);
  check('at the path it came from', rowOf('A Standalone Book').path, was);
  check('with its audio', there(was), true);
  check('and the trash is empty again', listTrash(when).length, 0);
}

// Purging is the one that cannot be undone, so it is checked that the files
// really go rather than that a row does.
{
  await deleteToTrash(idOf('Another Book'), when);
  const [t] = listTrash(when);
  await ran('purging is possible at all', async () => purge(t.id));
  check('purging takes the files with it', fs.existsSync(t.trash_path), false);
  check('and the row', listTrash(when).length, 0);
}

// Emptying takes whatever is in there, however much.
{
  await deleteToTrash(idOf('Volume One'), when);
  await deleteToTrash(idOf('Volume Two'), when);
  const paths = listTrash(when).map((t) => t.trash_path);
  check('two books are waiting', paths.length, 2);
  await ran('emptying is possible at all', async () => emptyTrash());
  check('emptying leaves nothing behind', [listTrash(when).length, paths.filter(fs.existsSync).length], [0, 0]);
}

// --- the copy of the database ---------------------------------------------
// Taken on startup and once a day. Checked here because this suite has a real
// database with real rows in it, which is what a backup is for.
{
  const first = backupNow(Date.parse('2026-10-01T03:00:00Z'));
  check('a backup is written', !first.error && /^library-2026-10-01\.db$/.test(first.name), true);
  const where = path.join(DATA, 'backups', first.name);
  check('and it is a file of its own, beside the database', fs.existsSync(where), true);

  // the point of VACUUM INTO rather than a file copy: what it writes opens, and
  // holds what the database held
  const { DatabaseSync } = await import('node:sqlite');
  const copy = new DatabaseSync(where);
  check('the copy opens, and has the books in it',
    copy.prepare('SELECT COUNT(*) AS n FROM books').get().n,
    db.prepare('SELECT COUNT(*) AS n FROM books').get().n);
  copy.close();

  // one a day, named for the day: a second run the same day replaces it
  backupNow(Date.parse('2026-10-01T22:00:00Z'));
  check('a second copy on the same day is still one copy', listBackups().length, 1);

  // and the oldest go, so this cannot fill the disk it is kept on
  for (let d = 2; d <= KEEP + 3; d++) {
    backupNow(Date.parse(`2026-10-${String(d).padStart(2, '0')}T03:00:00Z`));
  }
  const kept = listBackups();
  check(`no more than ${KEEP} are kept`, kept.length, KEEP);
  check('and it is the oldest that go',
    [kept[0].name, kept[kept.length - 1].name],
    [`library-2026-10-${String(KEEP + 3 - KEEP + 1).padStart(2, '0')}.db`, `library-2026-10-${String(KEEP + 3).padStart(2, '0')}.db`]);
}

console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
