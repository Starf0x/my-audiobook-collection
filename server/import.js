import fs from 'node:fs';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import { db, getSetting, getLibraries } from './db.js';
import { dirs, audioFiles, discFiles, DISC, addOne, NOT_IMPORTED, REPLACED } from './scan.js';
import { lane, pool } from './pool.js';

// One progress object for every operation that shifts files about: importing,
// moving a book and emptying it into the trash all report through it.
export const fileProgress = { running: false, done: 0, total: 0, current: '', error: '' };

export function beginFileWork() {
  Object.assign(fileProgress, { running: true, done: 0, total: 0, current: '', error: '' });
}

// What the disk said, in words that say what to do about it. A raw EACCES from
// libuv tells the person looking at the page nothing at all.
export function explainFileError(e, what) {
  const who = typeof process.getuid === 'function' ? `${process.getuid()}:${process.getgid()}` : 'root';
  if (e.code === 'EACCES' || e.code === 'EPERM') {
    return new Error(`${what} was refused by the disk (${e.code}). This app is writing as ${who}. `
      + 'Set PUID and PGID on the container to the user that owns the share (99 and 100 on Unraid), '
      + 'and check that the folders it has already made are not owned by root.');
  }
  if (e.code === 'ENOSPC') return new Error(`${what} stopped: the disk is full.`);
  if (e.code === 'EROFS') return new Error(`${what} failed: that folder is mounted read-only.`);
  if (e.code === 'ENOTEMPTY' || e.code === 'EEXIST') {
    return new Error(`${what} failed: there is already something at the destination.`);
  }
  return e;
}

// Every file of a folder, by path relative to it, with its size.
const treeOf = (root) => {
  const out = new Map();
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const here = path.join(dir, e.name);
      if (e.isDirectory()) walk(here, path.join(rel, e.name));
      else if (e.isFile()) out.set(path.join(rel, e.name), fs.statSync(here).size);
    }
  };
  walk(root, '');
  return out;
};

// A rename where the two paths share a filesystem, a copy where they do not —
// two Docker bind mounts, or a user share spread over several disks, which answers
// a rename between them with EXDEV, and sometimes with ENOTEMPTY or EEXIST when
// the destination exists on another disk of the same share.
//
// Deliberately not EPERM or EBUSY: those mean something holds the folder or the
// rights are wrong, and copying then would leave the book in two places instead of
// saying so.
const COPY_INSTEAD = ['EXDEV', 'ENOTEMPTY', 'EEXIST'];

export async function moveFolder(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) {
    if (fs.readdirSync(dest).length) {
      throw new Error(`There is already something at ${dest}. Nothing was moved.`);
    }
    // An empty folder, left behind by an earlier attempt or made by hand: out of
    // the way first, because a rename onto one is refused on some platforms.
    fs.rmdirSync(dest);
  }
  try {
    fs.renameSync(src, dest);
    return;
  } catch (e) {
    if (!COPY_INSTEAD.includes(e.code)) throw e;
  }
  await copyTree(src, dest);
  // The source only goes once every file has arrived, the same size as it left.
  // A move that half worked and then deleted the original is not recoverable.
  const from = treeOf(src);
  const to = treeOf(dest);
  const missing = [...from].filter(([rel, size]) => to.get(rel) !== size);
  if (missing.length) {
    throw new Error(`Copied ${to.size} of ${from.size} file(s) to ${dest}, so nothing was removed `
      + `from ${src}. The first one missing is ${missing[0][0]}.`);
  }
  try {
    fs.rmSync(src, { recursive: true, force: true });
  } catch (e) {
    // The book is where it belongs; only the original could not be cleared. Undoing
    // a good move over that would be worse, so it is said and left.
    fileProgress.error = `Copied to ${dest}, but ${src} could not be removed (${e.code}). `
      + 'It is still in the import folder — delete it there.';
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
    // A folder that is gone is worse than a list that is merely old: the page
    // would offer a book that cannot be imported, and emptying the import folder
    // would leave every one of them on screen. One stat per book, not a walk of
    // the whole folder — and the signature is cleared, so the pass below reads it
    // again for whatever else has changed.
    const here = cache.items.filter((i) => fs.existsSync(i.path));
    if (here.length !== cache.items.length) {
      cache = { ...cache, items: here, sig: '', at: Date.now() };
      importState.count = here.length;
      importState.cachedAt = cache.at;
      importState.changed++;
    }
    checkInBackground(root);
    return { items: cache.items, cachedAt: cache.at, fromCache: true };
  }
  const items = await build(root, false);
  return { items, cachedAt: cache.at, fromCache: false };
}

// Re-read only when the set of book folders differs from what the list was built
// from, and never touch the progress bar: nobody asked for this pass.
// At most one look every few seconds: the page asks for the state every two
// seconds while the import panel is open, and a folder on a share is not worth
// walking that often.
let lookedAt = 0;
const LOOK_GAP = 5000;

function checkInBackground(root) {
  if (checking || importState.building) return;
  if (Date.now() - lookedAt < LOOK_GAP) return;
  lookedAt = Date.now();
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
    const out = await pool(found, async (b) => {
      if (!quiet) fileProgress.current = path.basename(b.dir);
      let album = '';
      let artist = '';
      try {
        const c = (await lane(() => parseFile(b.files[0]))).common || {};
        album = c.album || '';
        artist = c.artist || c.albumartist || '';
      } catch { /* unreadable, the folder names will have to do */ }
      // Guess from the folders around it, the way the library itself is laid out.
      // A leading folder that names a known genre is that, not an author, which
      // is what an import folder organised like the library looks like.
      const parts = path.relative(root, b.dir).split(path.sep);
      const genre = known.has(parts[0]) ? parts[0] : '';
      const p = genre ? parts.slice(1) : parts;
      if (!quiet) fileProgress.done++;
      return {
        path: b.dir,
        name: path.basename(b.dir),
        where: parts.join(' / '),
        files: b.files.length,
        album,
        genre,
        artist: artist || (p.length >= 3 ? p[p.length - 3] : (p[p.length - 2] || '')),
        series: p.length >= 3 ? p[p.length - 2] : '',
      };
    });
    cache = { root, sig: signature(found), items: out, at: Date.now() };
    Object.assign(importState, { cachedAt: cache.at, count: out.length });
    return out;
  } finally {
    importState.building = false;
    if (!quiet) fileProgress.running = false;
  }
}

// The page watching the import panel asks for the state, not the list: this is
// what makes that watch notice a folder emptied behind its back.
export function lookAgain() {
  try {
    checkInBackground(importRoot());
  } catch { /* no import folder set, or it is not there: nothing to look at */ }
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
  const read = await pool(files, (f) => lane(async () => {
    let bytes = 0;
    try { bytes = fs.statSync(f).size; } catch { /* vanished mid-read */ }
    try {
      const { format } = await parseFile(f);
      return { bytes, format };
    } catch {
      return { bytes, format: null }; // unreadable file: it still counts for size
    }
  }));
  for (const { bytes, format } of read) {
    out.bytes += bytes;
    if (!format) continue;
    out.duration += format.duration || 0;
    out.sampleRate = Math.max(out.sampleRate, format.sampleRate || 0);
    out.channels = Math.max(out.channels, format.numberOfChannels || 0);
    out.codec = out.codec || format.codec || format.container || '';
    out.lossless = out.lossless || !!format.lossless;
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
  let replacedPath = '';
  try {
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
  } catch (err) {
    const e = explainFileError(err, `The import of ${path.basename(source)}`);
    // The copy that was there has been stepped aside but the new one never
    // arrived: put it back, or the library points at a folder that is not there.
    if (replacedPath && !fs.existsSync(dest) && fs.existsSync(replacedPath)) {
      try {
        fs.renameSync(replacedPath, dest);
        db.prepare('DELETE FROM replaced WHERE path = ?').run(replacedPath);
      } catch { /* leave it on the Replaced list to be put back by hand */ }
    }
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
  for (const dir of new Set(files.map((f) => path.dirname(f.to)))) {
    fs.mkdirSync(dir, { recursive: true });
  }
  await pool(files, (f) => lane(async () => {
    fileProgress.current = path.basename(f.from);
    await fs.promises.copyFile(f.from, f.to);
    fileProgress.done++;
  }));
}
