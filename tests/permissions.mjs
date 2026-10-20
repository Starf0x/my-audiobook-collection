// permissions — putting a folder's owner and modes right, and forgetting a
// library that is gone (2.14.112).
//
// The owner's Folder permissions list showed `/audiobooks/Dystopia · not there` —
// a genre folder deleted outside the app and still on the list of libraries —
// and `Juvenile Fiction · 0:0 · 755` among genres at `1000:100 · 777`, made as
// root. He asked for the gone ones to go, and for a button that puts the rights
// in order in the subfolders too.
//
// The modes are asked of the disk only where the disk has them: Windows keeps
// no Unix modes, so there the walk is checked for what it can say — that it
// went everywhere, and that it changes nothing it was not asked about. CI runs
// on Linux and asks the rest.
//
// Run: node tests/permissions.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HERE = path.join(ROOT, 'fixtures', 'permissions-test');
const LIB = path.join(HERE, 'audiobooks');
const DATA = path.join(HERE, 'data');
const UNIX = process.platform !== 'win32';

let failed = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
};

fs.rmSync(HERE, { recursive: true, force: true });
const juvenile = path.join(LIB, 'Juvenile Fiction');
const book = path.join(juvenile, 'An Author', 'A Book');
fs.mkdirSync(book, { recursive: true });
fs.writeFileSync(path.join(book, '01.mp3'), 'x');
fs.writeFileSync(path.join(book, '02.mp3'), 'x');
const fantasy = path.join(LIB, 'Fantasy');
fs.mkdirSync(fantasy, { recursive: true });
const gone = path.join(LIB, 'Dystopia');
// as root made them: shut to anybody else
if (UNIX) {
  for (const p of [juvenile, path.dirname(book), book]) fs.chmodSync(p, 0o700);
  for (const f of ['01.mp3', '02.mp3']) fs.chmodSync(path.join(book, f), 0o600);
}

fs.mkdirSync(DATA, { recursive: true });
process.env.DATA_DIR = DATA;
const { setSetting, getLibraries } = await import('../server/db.js');
const { fixable, fixTree, forgetLibrary, modesFor, ownerFor } = await import('../server/perms.js');

setSetting('libraries', JSON.stringify([
  { path: juvenile, asGenre: true }, { path: fantasy, asGenre: true }, { path: gone, asGenre: true },
]));
setSetting('importPath', path.join(HERE, 'import'));
const save = (libs) => setSetting('libraries', JSON.stringify(libs));

// --- which folders it may be asked about ------------------------------------
check('it may put right the libraries and the import folder, and nothing else',
  fixable(), [juvenile, fantasy, gone, path.join(HERE, 'import')]);
check('the modes are everything the umask allows: 777 and 666 with none',
  [modesFor(0o000).dir.toString(8), modesFor(0o000).file.toString(8),
    modesFor(0o022).dir.toString(8), modesFor(0o022).file.toString(8)],
  ['777', '666', '755', '644']);

// --- forgetting a library that is gone --------------------------------------
check('a library folder that is still there is not forgotten, however it is asked',
  (() => { try { forgetLibrary(fantasy, save); return 'forgotten'; } catch (e) { return e.message; } })(),
  `${fantasy} is there, so it is not forgotten.`);
check('nor is a folder that was never a library',
  (() => { try { forgetLibrary(path.join(LIB, 'Never'), save); return 'forgotten'; } catch (e) { return e.message; } })(),
  `${path.join(LIB, 'Never')} is not one of the libraries.`);
forgetLibrary(gone, save);
check('a library folder that is gone comes off the list, and only that one',
  getLibraries().map((l) => l.path), [juvenile, fantasy]);

// --- putting a tree right --------------------------------------------------------
const owner = ownerFor(juvenile);
const said = await fixTree(juvenile, { owner, modes: modesFor(0o000) });
check('the walk goes all the way down: three folders and two files',
  [said.folders, said.files], [3, 2]);
if (UNIX) {
  const mode = (p) => (fs.statSync(p).mode & 0o777).toString(8);
  check('every folder under it is opened to the share',
    [mode(juvenile), mode(path.dirname(book)), mode(book)], ['777', '777', '777']);
  check('and every file', [mode(path.join(book, '01.mp3')), mode(path.join(book, '02.mp3'))], ['666', '666']);
  check('and what it changed is counted, with nothing failing', [said.changed, said.failed], [5, 0]);
  const again = await fixTree(juvenile, { owner, modes: modesFor(0o000) });
  check('run again, there is nothing left to change', again.changed, 0);
} else {
  console.log('     (Windows keeps no Unix modes: the modes themselves are checked on Linux, in CI)');
}

// one at a time: two walks over one share at once would only fight
const one = fixTree(fantasy, { owner, modes: modesFor(0o000) });
const two = await fixTree(fantasy, { owner, modes: modesFor(0o000) }).then(() => 'ran', (e) => e.message);
await one;
check('a second fix while one runs is refused, not run alongside',
  two, 'A permission fix is already running. Wait for it to finish.');

console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
