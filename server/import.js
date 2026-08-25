import fs from 'node:fs';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import { db, getSetting, getLibraries } from './db.js';
import { dirs, audioFiles, discFiles, DISC, addOne } from './scan.js';

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

// Walking the folders is cheap; reading a tag per book is not. So the list is
// kept, handed back at once next time, and checked against the folders in the
// background: same book folders, same list.
let cache = null; // { root, sig, items, at }
let checking = false;
export const importState = { building: false, checking: false, changed: 0, cachedAt: 0, count: 0 };

const bookFolders = (root) => {
  const found = [];
  for (const d of dirs(root)) findBooks(d, 1, found);
  return found;
};

const signature = (found) => found.map((b) => `${b.dir}|${b.files.length}`).sort().join('\n');

const importRoot = () => {
  const root = getSetting('importPath');
  if (!root) throw new Error('No import folder set yet. Add one in Settings.');
  if (!fs.existsSync(root)) throw new Error(`The import folder is not there: ${root}`);
  return root;
};

export async function candidates({ refresh = false } = {}) {
  const root = importRoot();
  if (!refresh && cache && cache.root === root) {
    checkInBackground(root);
    return { items: cache.items, cachedAt: cache.at, fromCache: true };
  }
  const items = await build(root, false);
  return { items, cachedAt: cache.at, fromCache: false };
}

// Re-read only when the set of book folders differs from what the list was built
// from, and never touch the progress bar: nobody asked for this pass.
function checkInBackground(root) {
  if (checking || importState.building) return;
  checking = true;
  importState.checking = true;
  setImmediate(async () => {
    try {
      if (signature(bookFolders(root)) !== cache.sig) {
        await build(root, true);
        importState.changed++;
      }
    } catch { /* the folder went away or is unreadable; leave the list as it is */ } finally {
      checking = false;
      importState.checking = false;
    }
  });
}

async function build(root, quiet) {
  const found = bookFolders(root);
  const known = new Set(genreFolders().map((g) => g.genre));
  importState.building = true;
  if (!quiet) {
    beginFileWork();
    fileProgress.total = found.length;
  }
  try {
    const out = [];
    for (const b of found) {
      if (!quiet) fileProgress.current = path.basename(b.dir);
      let album = '';
      let artist = '';
      try {
        const c = (await parseFile(b.files[0])).common || {};
        album = c.album || '';
        artist = c.artist || c.albumartist || '';
      } catch { /* unreadable, the folder names will have to do */ }
      // Guess from the folders around it, the way the library itself is laid out.
      // A leading folder that names a known genre is that, not an author, which
      // is what an import folder organised like the library looks like.
      const parts = path.relative(root, b.dir).split(path.sep);
      const genre = known.has(parts[0]) ? parts[0] : '';
      const p = genre ? parts.slice(1) : parts;
      out.push({
        path: b.dir,
        name: path.basename(b.dir),
        where: parts.join(' / '),
        files: b.files.length,
        album,
        genre,
        artist: artist || (p.length >= 3 ? p[p.length - 3] : (p[p.length - 2] || '')),
        series: p.length >= 3 ? p[p.length - 2] : '',
      });
      if (!quiet) fileProgress.done++;
      await new Promise((r) => setImmediate(r));
    }
    cache = { root, sig: signature(found), items: out, at: Date.now() };
    Object.assign(importState, { cachedAt: cache.at, count: out.length });
    return out;
  } finally {
    importState.building = false;
    if (!quiet) fileProgress.running = false;
  }
}

// A book that has just been imported is gone from the folder. Drop that one line
// from the kept list and from its signature, so the rest stays usable and the
// background check does not think everything changed.
export function forgetCandidate(dir) {
  if (!cache) return;
  cache.items = cache.items.filter((i) => i.path !== dir);
  cache.sig = cache.sig.split('\n').filter((l) => !l.startsWith(`${dir}|`)).join('\n');
  cache.at = Date.now();
  Object.assign(importState, { cachedAt: cache.at, count: cache.items.length });
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

// What a folder of audio adds up to, in the terms that decide which of two
// copies of the same book is the better one to keep.
export async function qualityOf(dir) {
  const files = audioFiles(dir).length ? audioFiles(dir) : (discFiles(dir) || []);
  const out = {
    files: files.length, bytes: 0, duration: 0, bitrate: 0,
    sampleRate: 0, channels: 0, codec: '', lossless: false,
  };
  for (const f of files) {
    try { out.bytes += fs.statSync(f).size; } catch { /* vanished mid-read */ }
    try {
      const { format } = await parseFile(f);
      out.duration += format.duration || 0;
      out.sampleRate = Math.max(out.sampleRate, format.sampleRate || 0);
      out.channels = Math.max(out.channels, format.numberOfChannels || 0);
      out.codec = out.codec || format.codec || format.container || '';
      out.lossless = out.lossless || !!format.lossless;
    } catch { /* unreadable file: it still counts for size */ }
  }
  // measured, not read from a header, so a mislabelled file cannot flatter itself
  if (out.duration) out.bitrate = Math.round((out.bytes * 8) / out.duration / 1000);
  return out;
}

// Is there already a book where this one would land, and how do the two compare?
export async function compareWithExisting({ source, genre, author, series, title }) {
  const dest = destinationFor({ genre, author, series, title });
  if (!fs.existsSync(dest)) return { exists: false, dest };
  const [incoming, existing] = await Promise.all([qualityOf(source), qualityOf(dest)]);
  return { exists: true, dest, incoming, existing };
}

const prefixed = (dir, prefix) => {
  let target = path.join(path.dirname(dir), prefix + path.basename(dir));
  for (let n = 2; fs.existsSync(target); n++) {
    target = path.join(path.dirname(dir), `${prefix}${path.basename(dir)} (${n})`);
  }
  return target;
};

// Left alone but marked, so the folder says for itself why it is still here.
export const NOT_IMPORTED = 'Not Imported - ';
export const REPLACED = 'Replaced - ';

export function skipImport(source) {
  if (!source || !fs.existsSync(source)) throw new Error('That import folder is no longer there');
  const target = prefixed(source, NOT_IMPORTED);
  fs.renameSync(source, target);
  forgetCandidate(source);
  return { skipped: target };
}

export async function importBook({ source, genre, author, series, title, replace }) {
  const dest = destinationFor({ genre, author, series, title });
  if (!source || !fs.existsSync(source)) throw new Error('That import folder is no longer there');
  if (fs.existsSync(dest) && !replace) throw new Error(`There is already a folder at ${dest}`);

  beginFileWork();
  try {
    let replacedPath = '';
    if (fs.existsSync(dest)) {
      // step the old copy aside under its own name; the new one takes the path,
      // so the book keeps its row, and with it every listener's place in it
      const old = db.prepare('SELECT * FROM books WHERE path = ?').get(dest);
      const quality = await qualityOf(dest);
      replacedPath = prefixed(dest, REPLACED);
      fs.renameSync(dest, replacedPath);
      db.prepare(`INSERT INTO replaced (path, was_path, genre, author, series, title, files, bytes, quality, replaced_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(replacedPath, dest, genre, clean(author), clean(series) || null,
             old?.title || path.basename(dest), quality.files, quality.bytes,
             `${quality.bitrate} kbps`, new Date().toISOString());
    }
    await moveFolder(source, dest);
    pruneEmptyParents(source);
    // put it in the library now: a full rescan of a big share takes minutes
    // force: a replacement lands on the very same file names, and "unchanged"
    // would then keep the old copy's duration, cover and description
    await addOne({ genre, author: clean(author), series: clean(series), dir: dest, force: !!replacedPath });
    forgetCandidate(source);
    // hand back the row as it was filed, so the page can show the book where it
    // landed instead of leaving it to be found
    const row = db.prepare('SELECT id, genre, author, title FROM books WHERE path = ?').get(dest) || {};
    return { dest, replacedPath, ...row };
  } catch (e) {
    fileProgress.error = e.message;
    throw e;
  } finally {
    fileProgress.running = false;
  }
}

export function listReplaced() {
  return db.prepare('SELECT * FROM replaced ORDER BY replaced_at DESC').all()
    .map((r) => ({ ...r, onDisk: fs.existsSync(r.path) }));
}

export function deleteReplaced(id) {
  const r = db.prepare('SELECT * FROM replaced WHERE id = ?').get(Number(id));
  if (!r) throw new Error('Not on the replaced list');
  fs.rmSync(r.path, { recursive: true, force: true });
  db.prepare('DELETE FROM replaced WHERE id = ?').run(r.id);
  return { deleted: 1 };
}

export function deleteAllReplaced() {
  let n = 0;
  for (const r of listReplaced()) { deleteReplaced(r.id); n++; }
  return { deleted: n };
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
