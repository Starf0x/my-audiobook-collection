import fs from 'node:fs';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import { getSetting, getLibraries } from './db.js';
import { dirs, audioFiles } from './scan.js';

export const importProgress = { running: false, done: 0, total: 0, current: '', error: '' };

// audio directly in the folder, plus one level down for a disc-split rip
const filesUnder = (dir) => audioFiles(dir).concat(...dirs(dir).map(audioFiles));

// Every folder in the import path that holds audio, with what its tags say so
// the form can be filled in for you.
export async function candidates() {
  const root = getSetting('importPath');
  if (!root || !fs.existsSync(root)) return [];
  const out = [];
  for (const dir of dirs(root)) {
    const files = filesUnder(dir);
    if (!files.length) continue;
    let album = '';
    let artist = '';
    try {
      const c = (await parseFile(files[0])).common || {};
      album = c.album || '';
      artist = c.artist || c.albumartist || '';
    } catch { /* unreadable, the folder name will have to do */ }
    out.push({ path: dir, name: path.basename(dir), files: files.length, album, artist });
  }
  return out;
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

const clean = (s) => String(s || '').trim().replace(/[\\/:*?"<>|]/g, '-');

export async function importBook({ source, genre, author, series, title }) {
  const target = genreFolders().find((g) => g.genre === genre);
  if (!target) throw new Error(`Unknown genre: ${genre}`);
  if (!clean(author) || !clean(title)) throw new Error('An author and a title are required');
  if (!source || !fs.existsSync(source)) throw new Error('That import folder is no longer there');

  const parts = [clean(author), ...(clean(series) ? [clean(series)] : []), clean(title)];
  const dest = path.join(target.path, ...parts);
  if (fs.existsSync(dest)) throw new Error(`There is already a folder at ${dest}`);

  Object.assign(importProgress, { running: true, done: 0, total: 0, current: '', error: '' });
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      fs.renameSync(source, dest);
    } catch (e) {
      // import folder on another mount than the library: copy across, then drop the source
      if (e.code !== 'EXDEV') throw e;
      await copyTree(source, dest);
      fs.rmSync(source, { recursive: true, force: true });
    }
    return { dest };
  } catch (e) {
    importProgress.error = e.message;
    throw e;
  } finally {
    importProgress.running = false;
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
  importProgress.total = files.length;
  for (const f of files) {
    importProgress.current = path.basename(f.from);
    fs.mkdirSync(path.dirname(f.to), { recursive: true });
    fs.copyFileSync(f.from, f.to);
    importProgress.done++;
    await new Promise((r) => setImmediate(r)); // let the status endpoint answer
  }
}
