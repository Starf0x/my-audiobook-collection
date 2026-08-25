import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseFile } from 'music-metadata';
import { db, getLibraries, DATA_DIR } from './db.js';

const AUDIO = /\.(mp3|m4a|m4b|ogg|flac|opus)$/i;
const COVER = /^(cover|folder|front)\.(jpg|jpeg|png)$/i;
export const DISC = /^(disc|disk|cd|part|tape)[\s._-]*\d+$/i;

export const dirs = (p) => fs.readdirSync(p, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
  .map((e) => path.join(p, e.name));

export const audioFiles = (p) => fs.readdirSync(p, { withFileTypes: true })
  .filter((e) => e.isFile() && AUDIO.test(e.name))
  .map((e) => path.join(p, e.name))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

// iTunes normalisation data ends up in the ID3v1 comment field as hex groups.
const descriptionOf = (c) => {
  const comment = c.comment?.[0];
  const text = ((typeof comment === 'string' ? comment : comment?.text) || '').trim();
  return /^[0-9a-f]{6,8}( +[0-9a-f]{6,8})+$/i.test(text) ? '' : text;
};

// which tags the files themselves carry, so the interface can tell file
// metadata apart from what only lives in the database
const taggedFields = (c) => [
  ['album', c.album], ['title', c.title], ['artist', c.artist], ['album artist', c.albumartist],
  ['narrator', c.composer?.[0]], ['genre', c.genre?.[0]], ['year', c.year],
  ['description', descriptionOf(c)], ['cover', c.picture?.[0]], ['track no', c.track?.no],
].filter(([, v]) => v).map(([k]) => k).join(',');

async function taggedOf(file) {
  try {
    return taggedFields((await parseFile(file)).common || {});
  } catch {
    return '';
  }
}

async function readMeta(files, bookPath) {
  const meta = { title: '', narrator: '', year: '', description: '', duration: 0, cover: null };
  for (const [i, file] of files.entries()) {
    let tags = {};
    // No { duration: true }: that scans every frame of every file (~4s per MP3).
    // Duration is only used for a badge, so take it when the header offers it for free.
    try { tags = await parseFile(file); } catch { /* unreadable file */ }
    const c = tags.common || {}, f = tags.format || {};
    meta.duration += f.duration || 0;
    meta.tracks = meta.tracks || [];
    meta.tracks.push({ title: c.title || path.basename(file, path.extname(file)), duration: f.duration || 0 });
    if (i > 0) continue;
    meta.title = c.album || c.title || '';
    meta.narrator = c.composer?.[0] || c.artist || '';
    meta.year = c.year ? String(c.year) : '';
    meta.description = descriptionOf(c);
    meta.tagged = taggedFields(c);
    const pic = c.picture?.[0];
    if (pic) {
      const name = crypto.createHash('md5').update(bookPath).digest('hex') + '.jpg';
      fs.writeFileSync(path.join(DATA_DIR, 'covers', name), Buffer.from(pic.data));
      meta.cover = name;
    }
  }
  if (!meta.cover) {
    const local = fs.readdirSync(bookPath).find((n) => COVER.test(n));
    if (local) meta.cover = 'file:' + path.join(bookPath, local);
  }
  return meta;
}

// Prepared once and reused. Preparing inside the per-book loop held a native
// statement handle for every book and track, which showed up as growing RSS
// across repeated scans of a large library.
const q = {
  bookByPath: db.prepare('SELECT id, duration FROM books WHERE path = ?'),
  trackPaths: db.prepare('SELECT path FROM tracks WHERE book_id = ? ORDER BY idx'),
  touchBook: db.prepare('UPDATE books SET genre = ?, author = ?, series = ?, tagged = ? WHERE id = ?'),
  upsertBook: db.prepare(`INSERT INTO books (path, genre, author, series, title, narrator, year, description, cover, duration, tagged)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET genre = excluded.genre, author = excluded.author, series = excluded.series,
      title = excluded.title, narrator = excluded.narrator, year = excluded.year,
      description = excluded.description, cover = excluded.cover, duration = excluded.duration,
      tagged = excluded.tagged`),
  idByPath: db.prepare('SELECT id FROM books WHERE path = ?'),
  dropTracks: db.prepare('DELETE FROM tracks WHERE book_id = ?'),
  addTrack: db.prepare('INSERT INTO tracks (book_id, idx, path, title, duration) VALUES (?, ?, ?, ?, ?)'),
  allBookPaths: db.prepare('SELECT id, path FROM books'),
  dropBook: db.prepare('DELETE FROM books WHERE id = ?'),
};

async function addBook(genre, author, series, bookPath, files = null) {
  files = files || audioFiles(bookPath);
  if (!files.length) return 0;
  const folderTitle = path.basename(bookPath);
  const existing = q.bookByPath.get(bookPath);
  const known = existing
    ? q.trackPaths.all(existing.id).map((t) => t.path)
    : [];
  const unchanged = existing && known.length === files.length && known.every((p, i) => p === files[i]);

  if (unchanged) {
    // reading the first file's tags is cheap, and it keeps the "in MP3" state
    // truthful after tags were written outside the app
    q.touchBook.run(genre, author, series, await taggedOf(files[0]), existing.id);
    return 1;
  }

  const m = await readMeta(files, bookPath);
  q.upsertBook
    // Folder name wins over the album tag: album tags repeat across a series
    // ("The Belgariad" for all ten books) while folder names identify the book.
    .run(bookPath, genre, author, series, folderTitle || m.title, m.narrator, m.year, m.description,
         m.cover, m.duration, m.tagged || '');

  const id = q.idByPath.get(bookPath).id;
  q.dropTracks.run(id);
  files.forEach((f, i) => q.addTrack.run(id, i, f, m.tracks[i].title, m.tracks[i].duration));
  return 1;
}

// A folder whose sub-folders are all disc markers is one book split over discs,
// wherever it sits: directly under an author, or under a series folder as well.
// Returns its files in disc order, or null when it is not such a folder.
function discFiles(dir) {
  if (audioFiles(dir).length) return null;
  const inner = dirs(dir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (inner.length < 2 || !inner.every((d) => DISC.test(path.basename(d)))) return null;
  return inner.flatMap(audioFiles);
}

// Add one known book straight away, so an import or a restore turns up in the
// library at once instead of after a full scan of everything else.
export async function addOne({ genre, author, series, dir }) {
  return addBook(genre, author, series || null, dir, discFiles(dir));
}

// A library root holds genre folders, so its books sit three levels down. When
// they sit two levels down the root is a genre folder and every author would be
// filed as a genre, which is the easiest mistake to make when picking a folder.
function looksTooDeep(root) {
  for (const child of dirs(root).slice(0, 3)) {
    for (const grand of dirs(child).slice(0, 3)) {
      if (audioFiles(grand).length) return true;
    }
  }
  return false;
}

export const progress = { running: false, done: 0, total: 0, current: '', books: 0, error: '', warning: '' };

export async function scan() {
  // running must be true before walking the tree: on a large library that walk
  // takes tens of seconds, and the UI would otherwise read the scan as finished.
  Object.assign(progress, { running: true, done: 0, total: 0, current: '', books: 0, error: '', warning: '' });
  try {
    await walkAndScan();
  } catch (e) {
    // an unreadable folder must not escape: the caller does not await scan(),
    // so an unhandled rejection would take the process down
    progress.error = e.message;
  } finally {
    progress.running = false;
  }
  return { books: progress.books };
}

async function walkAndScan() {
  const jobs = [];
  const tooDeep = [];
  for (const lib of getLibraries()) {
    if (!fs.existsSync(lib.path)) continue;
    if (!lib.asGenre && looksTooDeep(lib.path)) tooDeep.push(lib.path);
    for (const genreDir of (lib.asGenre ? [lib.path] : dirs(lib.path))) {
      const genre = path.basename(genreDir);
      for (const authorDir of dirs(genreDir)) {
        const author = path.basename(authorDir);
        for (const level3 of dirs(authorDir)) {
          if (audioFiles(level3).length) jobs.push({ genre, author, series: null, dir: level3 });
          else if (discFiles(level3)) {
            jobs.push({ genre, author, series: null, dir: level3, files: discFiles(level3) });
          } else {
            // A folder holding a single sub-folder is a redundantly nested book,
            // not a series: there is nothing to group.
            const books = dirs(level3).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
            const series = books.length > 1 ? path.basename(level3) : null;
            for (const bookDir of books) {
              jobs.push({ genre, author, series, dir: bookDir, files: discFiles(bookDir) });
            }
          }
        }
      }
    }
  }

  if (tooDeep.length) {
    progress.warning = `${tooDeep.join(', ')} looks like a single genre folder, so its authors are `
      + 'being filed as genres. Tick "is one genre" behind it in Settings, or add the folder that '
      + 'contains your genre folders instead.';
  }

  progress.total = jobs.length;
  for (const j of jobs) {
    progress.current = path.basename(j.dir);
    progress.books += await addBook(j.genre, j.author, j.series, j.dir, j.files);
    progress.done++;
  }
  const seen = new Set(jobs.map((j) => j.dir));
  for (const b of q.allBookPaths.all()) {
    if (!seen.has(b.path)) {
      q.dropTracks.run(b.id);
      q.dropBook.run(b.id);
    }
  }
}
