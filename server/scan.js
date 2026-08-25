import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseFile } from 'music-metadata';
import { db, getLibraries, DATA_DIR } from './db.js';

const AUDIO = /\.(mp3|m4a|m4b|ogg|flac|opus)$/i;
const COVER = /^(cover|folder|front)\.(jpg|jpeg|png)$/i;
export const DISC = /^(disc|disk|cd|part|tape)[\s._-]*\d+$/i;

// A dot hides a folder from the app (the trash uses that), and so do the two
// names an import gives a copy it set aside: neither is a book to list.
export const SET_ASIDE = /^(Replaced|Not Imported) - /;

export const dirs = (p) => fs.readdirSync(p, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SET_ASIDE.test(e.name))
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

// A book filed straight under its author has no series folder, but its files
// often say which series it belongs to: iTunes and most audiobook taggers put it
// in the movement name, others in the grouping or a SERIES text frame.
const seriesFromTags = (tags) => {
  const c = tags.common || {};
  const txxx = (tags.native?.['ID3v2.4'] || tags.native?.['ID3v2.3'] || [])
    .find((f) => f.id === 'TXXX' && /^(series|album series)$/i.test(f.value?.description || ''));
  const name = [c.movement, c.grouping, txxx?.value?.text]
    .map((v) => (v || '').trim())
    .find((v) => v && v !== c.album && v !== c.title) || '';
  return { name, no: Number(c.movementIndex?.no) || 0 };
};

async function readMeta(files, bookPath) {
  const meta = {
    title: '', narrator: '', year: '', description: '', duration: 0, cover: null,
    tagSeries: '', seriesNo: 0,
  };
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
    const s = seriesFromTags(tags);
    meta.tagSeries = s.name;
    meta.seriesNo = s.no;
    const pic = c.picture?.[0];
    if (pic) {
      // named after the image itself: the same art keeps its name, new art gets
      // a new one, so a browser may cache it for a long time
      const name = crypto.createHash('md5').update(pic.data).digest('hex') + '.jpg';
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
  upsertBook: db.prepare(`INSERT INTO books
      (path, genre, author, series, title, narrator, year, description, cover, duration, tagged, tag_series, series_no)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET genre = excluded.genre, author = excluded.author, series = excluded.series,
      title = excluded.title, narrator = excluded.narrator, year = excluded.year,
      description = excluded.description, cover = excluded.cover, duration = excluded.duration,
      tagged = excluded.tagged, tag_series = excluded.tag_series, series_no = excluded.series_no`),
  idByPath: db.prepare('SELECT id FROM books WHERE path = ?'),
  dropTracks: db.prepare('DELETE FROM tracks WHERE book_id = ?'),
  addTrack: db.prepare('INSERT INTO tracks (book_id, idx, path, title, duration) VALUES (?, ?, ?, ?, ?)'),
  allBookPaths: db.prepare('SELECT id, path FROM books'),
  dropBook: db.prepare('DELETE FROM books WHERE id = ?'),
};

async function addBook(genre, author, series, bookPath, files = null, force = false, guess = null) {
  files = files || audioFiles(bookPath);
  if (!files.length) return 0;
  const folderTitle = path.basename(bookPath);
  const existing = q.bookByPath.get(bookPath);
  const known = existing
    ? q.trackPaths.all(existing.id).map((t) => t.path)
    : [];
  // A replaced book keeps every file name, so "same paths" would read as "same
  // book" and the old duration and cover would survive the new copy.
  const unchanged = !force && existing && known.length === files.length && known.every((p, i) => p === files[i]);

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
         m.cover, m.duration, m.tagged || '',
         m.tagSeries || (guess ? guess.name : ''),
         m.seriesNo || (guess ? guess.no : 0));

  const id = q.idByPath.get(bookPath).id;
  q.dropTracks.run(id);
  files.forEach((f, i) => q.addTrack.run(id, i, f, m.tracks[i].title, m.tracks[i].duration));
  return 1;
}

// A folder whose sub-folders are all disc markers is one book split over discs,
// wherever it sits: directly under an author, or under a series folder as well.
// Returns its files in disc order, or null when it is not such a folder.
export function discFiles(dir) {
  if (audioFiles(dir).length) return null;
  const inner = dirs(dir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (inner.length < 2 || !inner.every((d) => DISC.test(path.basename(d)))) return null;
  return inner.flatMap(audioFiles);
}

// Add one known book straight away, so an import or a restore turns up in the
// library at once instead of after a full scan of everything else.
export async function addOne({ genre, author, series, dir, force }) {
  return addBook(genre, author, series || null, dir, discFiles(dir), !!force);
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

export async function scan(only = '') {
  // running must be true before walking the tree: on a large library that walk
  // takes tens of seconds, and the UI would otherwise read the scan as finished.
  Object.assign(progress, { running: true, done: 0, total: 0, current: '', books: 0, error: '', warning: '' });
  try {
    await walkAndScan(only);
  } catch (e) {
    // an unreadable folder must not escape: the caller does not await scan(),
    // so an unhandled rejection would take the process down
    progress.error = e.message;
  } finally {
    progress.running = false;
  }
  return { books: progress.books };
}

// "The Dark Tower I", "The Dark Tower II", "The Dark Tower III" — one series,
// split over folders that differ only by a volume number. Two of them are enough
// to say so; one on its own is just a title that happens to end in a numeral.
const VOLUME = /^(.*?)[\s,._-]*(?:(?:book|vol|volume|part|deel|boek)[\s.]*)?(\d{1,3}|[ivxlcdm]{1,7})$/i;
const ROMAN = {
  i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10,
  xi: 11, xii: 12, xiii: 13, xiv: 14, xv: 15, xvi: 16, xvii: 17, xviii: 18, xix: 19, xx: 20,
};

export function seriesFromSiblings(names) {
  const groups = new Map();
  for (const name of names) {
    if (DISC.test(name)) continue; // a disc marker is not a volume of a series
    const m = VOLUME.exec(name.trim());
    if (!m) continue;
    const prefix = m[1].trim().replace(/[,\-–:._]+$/, '').trim();
    const token = m[2].toLowerCase();
    const no = /^\d+$/.test(token) ? Number(token) : (ROMAN[token] || 0);
    if (prefix.length < 3 || !no) continue;
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix).push({ name, no });
  }
  const out = new Map();
  for (const [prefix, members] of groups) {
    if (members.length < 2) continue;
    for (const m of members) out.set(m.name, { name: prefix, no: m.no });
    // a first volume is often just the series name, with no number at all
    const bare = names.find((n) => n.trim() === prefix);
    if (bare && !out.has(bare)) out.set(bare, { name: prefix, no: 1 });
  }
  return out;
}

async function walkAndScan(only) {
  const jobs = [];
  const tooDeep = [];
  // one library folder, or all of them
  const libs = only
    ? getLibraries().filter((l) => path.resolve(l.path) === path.resolve(only))
    : getLibraries();
  if (only && !libs.length) throw new Error(`Not a library folder: ${only}`);
  for (const lib of libs) {
    if (!fs.existsSync(lib.path)) continue;
    if (!lib.asGenre && looksTooDeep(lib.path)) tooDeep.push(lib.path);
    for (const genreDir of (lib.asGenre ? [lib.path] : dirs(lib.path))) {
      const genre = path.basename(genreDir);
      for (const authorDir of dirs(genreDir)) {
        const author = path.basename(authorDir);
        const level3s = dirs(authorDir);
        // What the folder names say about series, for the books that are not in a
        // series folder. A guess from names, so it names the series and never
        // moves a file: it goes where a series read from the tags goes.
        const guessed = seriesFromSiblings(level3s.map((d) => path.basename(d)));
        for (const level3 of level3s) {
          const guess = guessed.get(path.basename(level3)) || null;
          if (audioFiles(level3).length) jobs.push({ genre, author, series: null, dir: level3, guess });
          else if (discFiles(level3)) {
            jobs.push({ genre, author, series: null, dir: level3, files: discFiles(level3), guess });
          } else {
            // A folder holding a single sub-folder is a redundantly nested book,
            // not a series: there is nothing to group.
            const books = dirs(level3).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
            const series = books.length > 1 ? path.basename(level3) : null;
            for (const bookDir of books) {
              jobs.push({ genre, author, series, dir: bookDir, files: discFiles(bookDir), guess: series ? null : guess });
            }
          }
        }
      }
    }
  }

  if (tooDeep.length) {
    progress.warning = `${tooDeep.join(', ')} looks like a single genre folder, so its authors are `
      + 'being filed as genres. Tick "Is a Genre" behind it in Settings, or add the folder that '
      + 'contains your genre folders instead.';
  }

  progress.total = jobs.length;
  for (const j of jobs) {
    progress.current = path.basename(j.dir);
    progress.books += await addBook(j.genre, j.author, j.series, j.dir, j.files, false, j.guess);
    progress.done++;
  }
  // Books whose folder is gone are dropped — but only from what was walked, or
  // scanning one library folder would delete the books of all the others.
  const seen = new Set(jobs.map((j) => j.dir));
  const roots = libs.map((l) => path.resolve(l.path));
  for (const b of q.allBookPaths.all()) {
    const here = path.resolve(b.path);
    const walked = !only || roots.some((r) => here === r || here.startsWith(r + path.sep));
    if (walked && !seen.has(b.path)) {
      q.dropTracks.run(b.id);
      q.dropBook.run(b.id);
    }
  }
}
