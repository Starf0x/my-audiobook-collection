import fs from 'node:fs';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import { getSetting, getLibraries } from './db.js';
import { dirs, audioFiles, DISC } from './scan.js';

// One progress object for every operation that shifts files about: importing,
// moving a book and emptying it into the trash all report through it.
export const fileProgress = { running: false, done: 0, total: 0, current: '', error: '' };

export function beginFileWork() {
  Object.assign(fileProgress, { running: true, done: 0, total: 0, current: '', error: '' });
}

// A rename where the two paths share a filesystem, a copy where they do not,
// which is the case for two separate Docker bind mounts.
export async function moveFolder(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(src, dest);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await copyTree(src, dest);
    fs.rmSync(src, { recursive: true, force: true });
  }
}

// Find the book folders in the import path, however deep they sit: a folder that
// holds audio is a book, and so is one whose sub-folders are all disc markers.
// Offering the folder that *is* the book matters, or importing an author folder
// would file its book one level too deep.
function findBooks(dir, depth, out) {
  if (depth > 5) return;
  let own = [];
  let subs = [];
  try {
    own = audioFiles(dir);
    subs = dirs(dir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  } catch {
    return; // unreadable folder, skip it rather than fail the whole listing
  }
  if (own.length) return void out.push({ dir, files: own });
  if (subs.length > 1 && subs.every((d) => DISC.test(path.basename(d)))) {
    return void out.push({ dir, files: subs.flatMap(audioFiles) });
  }
  for (const s of subs) findBooks(s, depth + 1, out);
}

export async function candidates() {
  const root = getSetting('importPath');
  if (!root) throw new Error('No import folder set yet. Add one in Settings.');
  if (!fs.existsSync(root)) throw new Error(`The import folder is not there: ${root}`);

  const found = [];
  for (const d of dirs(root)) findBooks(d, 1, found);

  // reading one tag per book is the slow part, so it reports progress
  beginFileWork();
  fileProgress.total = found.length;
  try {
    const out = [];
    for (const b of found) {
      fileProgress.current = path.basename(b.dir);
      let album = '';
      let artist = '';
      try {
        const c = (await parseFile(b.files[0])).common || {};
        album = c.album || '';
        artist = c.artist || c.albumartist || '';
      } catch { /* unreadable, the folder names will have to do */ }
      // Guess from the folders around it, the way the library itself is laid out:
      // author/book, or author/series/book when it sits a level deeper.
      const parts = path.relative(root, b.dir).split(path.sep);
      const guessedAuthor = parts.length >= 3 ? parts[parts.length - 3] : (parts[parts.length - 2] || '');
      out.push({
        path: b.dir,
        name: path.basename(b.dir),
        where: parts.join(' / '),
        files: b.files.length,
        album,
        artist: artist || guessedAuthor,
        series: parts.length >= 3 ? parts[parts.length - 2] : '',
      });
      fileProgress.done++;
      await new Promise((r) => setImmediate(r));
    }
    return out;
  } finally {
    fileProgress.running = false;
  }
}

// Which folder each genre lives in, so an import knows where to put a book.
export function genreFolders() {
  const out = [];
  for (const lib of getLibraries()) {
    if (!fs.existsSync(lib.path)) continue;
    if (lib.asGenre) out.push({ genre: path.basename(lib.path), path: lib.path });
    else for (const d of dirs(lib.path)) out.push({ genre: path.basename(d), path: d });
  }
  return out;
}

export const clean = (s) => String(s || '').trim().replace(/[\\/:*?"<>|]/g, '-');

// Where a book with this genre, author, series and title belongs on disk.
export function destinationFor({ genre, author, series, title }) {
  const target = genreFolders().find((g) => g.genre === genre);
  if (!target) throw new Error(`Unknown genre: ${genre}`);
  if (!clean(author) || !clean(title)) throw new Error('An author and a title are required');
  return path.join(target.path, clean(author), ...(clean(series) ? [clean(series)] : []), clean(title));
}

export async function importBook({ source, genre, author, series, title }) {
  const dest = destinationFor({ genre, author, series, title });
  if (!source || !fs.existsSync(source)) throw new Error('That import folder is no longer there');
  if (fs.existsSync(dest)) throw new Error(`There is already a folder at ${dest}`);

  beginFileWork();
  try {
    await moveFolder(source, dest);
    pruneEmptyParents(source);
    return { dest };
  } catch (e) {
    fileProgress.error = e.message;
    throw e;
  } finally {
    fileProgress.running = false;
  }
}

// A book nested under author and series folders leaves those behind. Drop them
// while they are empty, never the import folder itself.
function pruneEmptyParents(source) {
  const root = path.resolve(getSetting('importPath'));
  let dir = path.resolve(path.dirname(source));
  while (dir !== root && dir.startsWith(root + path.sep)) {
    try {
      fs.rmdirSync(dir); // throws while anything is still in it
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

async function copyTree(src, dest) {
  const files = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name), path.join(rel, e.name));
      else files.push({ from: path.join(dir, e.name), to: path.join(dest, rel, e.name) });
    }
  };
  walk(src, '');
  fileProgress.total = files.length;
  for (const f of files) {
    fileProgress.current = path.basename(f.from);
    fs.mkdirSync(path.dirname(f.to), { recursive: true });
    fs.copyFileSync(f.from, f.to);
    fileProgress.done++;
    await new Promise((r) => setImmediate(r)); // let the status endpoint answer
  }
}
