import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseFile } from 'music-metadata';
import { db, getLibraries, DATA_DIR } from './db.js';
import { lane, pool } from './pool.js';

const AUDIO = /\.(mp3|m4a|m4b|ogg|flac|opus)$/i;
const COVER = /^(cover|folder|front)\.(jpg|jpeg|png)$/i;
export const DISC = /^(disc|disk|cd|part|tape)[\s._-]*\d+$/i;

// A dot hides a folder from the app (the trash uses that), and so do the two
// names an import gives a copy it set aside: neither is a book to list.
export const NOT_IMPORTED = 'Not Imported - ';
export const REPLACED = 'Replaced - ';
const setAside = (name) => name.startsWith(NOT_IMPORTED) || name.startsWith(REPLACED);

export const dirs = (p) => fs.readdirSync(p, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !setAside(e.name))
  .map((e) => path.join(p, e.name));

export const audioFiles = (p) => fs.readdirSync(p, { withFileTypes: true })
  .filter((e) => e.isFile() && AUDIO.test(e.name))
  .map((e) => path.join(p, e.name))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

// One listing of a folder, and everything the walk wants to know about it: the
// folders to go into, the ones set aside by an import, its audio, and the kinds
// of file it holds that this app does not read. One readdir instead of the two
// that dirs() and audioFiles() used to make of every folder — and it is what lets
// a scan say why a folder was not counted, instead of the number being short with
// no reason given.
function listing(p) {
  let entries = [];
  try {
    entries = fs.readdirSync(p, { withFileTypes: true });
  } catch (e) {
    return { dirs: [], aside: [], audio: [], others: [], error: e.message };
  }
  const out = { dirs: [], aside: [], audio: [], others: [], error: '' };
  for (const e of entries) {
    const full = path.join(p, e.name);
    if (e.isDirectory()) {
      if (e.name.startsWith('.')) continue; // the trash and its kind: never a book
      if (setAside(e.name)) out.aside.push(full);
      else out.dirs.push(full);
    } else if (e.isFile()) {
      if (AUDIO.test(e.name)) out.audio.push(full);
      else if (!e.name.startsWith('.')) {
        const ext = path.extname(e.name).toLowerCase();
        if (ext && !out.others.includes(ext)) out.others.push(ext);
      }
    }
  }
  out.audio.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return out;
}

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

const NOTHING = {
  title: '', narrator: '', year: '', description: '',
  tagged: '', tagSeries: '', seriesNo: 0, cover: null,
};

// Everything a book's first file says about the book itself. A full read and the
// shortcut for a book that has not changed take the same fields from the same
// parse — only the running time and the track list need every file.
function firstFileMeta(tags) {
  const c = tags.common || {};
  const s = seriesFromTags(tags);
  const meta = {
    title: c.album || c.title || '',
    narrator: c.composer?.[0] || c.artist || '',
    year: c.year ? String(c.year) : '',
    description: descriptionOf(c),
    tagged: taggedFields(c),
    tagSeries: s.name,
    seriesNo: s.no,
    cover: null,
  };
  const pic = c.picture?.[0];
  if (pic) {
    // named after the image itself: the same art keeps its name, new art gets
    // a new one, so a browser may keep it for a long time
    const name = crypto.createHash('md5').update(pic.data).digest('hex') + '.jpg';
    // Several books can carry the same art, and with several books being read
    // at once two of them could write this file at the same moment. The name is
    // the hash of the bytes, so whoever wrote it first wrote the right thing.
    const target = path.join(DATA_DIR, 'covers', name);
    try {
      if (!fs.existsSync(target)) fs.writeFileSync(target, Buffer.from(pic.data));
    } catch { /* another book is writing the same art right now */ }
    meta.cover = name;
  }
  return meta;
}

// cover.jpg, folder.png and their kind, beside the audio
const localCover = (bookPath) => {
  try {
    const local = fs.readdirSync(bookPath).find((n) => COVER.test(n));
    return local ? 'file:' + path.join(bookPath, local) : null;
  } catch {
    return null;
  }
};

async function firstFileTells(file) {
  try {
    return firstFileMeta(await lane(() => parseFile(file)));
  } catch {
    return { ...NOTHING };
  }
}

// A volume number on the end of a name: "The Dark Tower V" is the fifth book of
// The Dark Tower, whether that name came from a folder or from a tag. Splitting
// it off is what keeps one series from becoming five.
const VOLUME = /^(.*?)[\s,._-]*(?:(?:book|vol|volume|part|deel|boek)[\s.]*)?(\d{1,3}|[ivxlcdm]{1,7})$/i;
const ROMAN = {
  i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10,
  xi: 11, xii: 12, xiii: 13, xiv: 14, xv: 15, xvi: 16, xvii: 17, xviii: 18, xix: 19, xx: 20,
};

const splitVolume = (raw) => {
  const name = (raw || '').trim();
  const m = VOLUME.exec(name);
  if (!m) return { name, no: 0 };
  const prefix = m[1].trim().replace(/[,\-–:._]+$/, '').trim();
  const token = m[2].toLowerCase();
  const no = /^\d+$/.test(token) ? Number(token) : (ROMAN[token] || 0);
  return prefix.length >= 3 && no ? { name: prefix, no } : { name, no: 0 };
};

// A book filed straight under its author has no series folder, but its files
// often say which series it belongs to: iTunes and most audiobook taggers put it
// in the movement name, others in the grouping or a SERIES text frame.
const seriesFromTags = (tags) => {
  const c = tags.common || {};
  const txxx = (tags.native?.['ID3v2.4'] || tags.native?.['ID3v2.3'] || [])
    .find((f) => f.id === 'TXXX' && /^(series|album series)$/i.test(f.value?.description || ''));
  const said = [c.movement, c.grouping, txxx?.value?.text]
    .map((v) => (v || '').trim())
    .find((v) => v && v !== c.album && v !== c.title) || '';
  // some taggers put the volume there rather than the series: "The Dark Tower V"
  const v = splitVolume(said);
  return { name: v.name, no: Number(c.movementIndex?.no) || v.no };
};

async function readMeta(files, bookPath) {
  const meta = { ...NOTHING, duration: 0, tracks: [] };
  for (const [i, file] of files.entries()) {
    let tags = {};
    // No { duration: true }: that scans every frame of every file (~4s per MP3).
    // Duration is only used for a badge, so take it when the header offers it for free.
    try { tags = await lane(() => parseFile(file)); } catch { /* unreadable file */ }
    const c = tags.common || {}, f = tags.format || {};
    meta.duration += f.duration || 0;
    meta.tracks.push({ title: c.title || path.basename(file, path.extname(file)), duration: f.duration || 0 });
    if (i === 0) Object.assign(meta, firstFileMeta(tags));
  }
  if (!meta.cover) meta.cover = localCover(bookPath);
  return meta;
}

// Prepared once and reused. Preparing inside the per-book loop held a native
// statement handle for every book and track, which showed up as growing RSS
// across repeated scans of a large library.
const q = {
  bookByPath: db.prepare(`SELECT id, duration, narrator, year, description, cover,
                          tag_series, series_no FROM books WHERE path = ?`),
  trackPaths: db.prepare('SELECT path FROM tracks WHERE book_id = ? ORDER BY idx'),
  touchBook: db.prepare(`UPDATE books SET genre = ?, author = ?, series = ?, tagged = ?,
      tag_series = ?, series_no = ?, narrator = ?, year = ?, description = ?, cover = ?
      WHERE id = ?`),
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
    // One parse of the first file is cheap, and the book takes from it everything
    // it says: the "in MP3" state stays truthful after tags were written outside
    // the app, and so do the values — narrator, year, description, cover — which
    // is where a full read gets them from as well. What the file does not say is
    // left alone, so a title or a description filled in here is not blanked by a
    // scan. The series goes the same way: a book already in the library picks up
    // what a newer version of this app can work out, without its folders changing.
    const told = await firstFileTells(files[0]);
    q.touchBook.run(genre, author, series, told.tagged,
      // the files first, then what the folders suggest, then what the book already
      // says: a series filled in from a lookup without writing the files must not
      // be blanked by the next scan either
      told.tagSeries || (guess ? guess.name : '') || existing.tag_series,
      told.seriesNo || (guess ? guess.no : 0) || existing.series_no,
      told.narrator || existing.narrator, told.year || existing.year,
      told.description || existing.description,
      // a picture inside the files wins; then whatever the book already had, so a
      // cover chosen here is not thrown away; then art that has appeared beside
      // the audio since the last scan
      told.cover || existing.cover || localCover(bookPath),
      existing.id);
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

export const progress = { running: false, done: 0, total: 0, current: '', books: 0, error: '', warning: '', skipped: 0 };

// What the last scan walked past, and why. In memory: it is a diagnostic for the
// scan that just ran, not a record to keep.
let skippedLast = [];
export const lastSkipped = () => skippedLast;

export async function scan(only = '') {
  // running must be true before walking the tree: on a large library that walk
  // takes tens of seconds, and the UI would otherwise read the scan as finished.
  Object.assign(progress, { running: true, done: 0, total: 0, current: '', books: 0, error: '', warning: '', skipped: 0 });
  skippedLast = [];
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
export function seriesFromSiblings(names) {
  const groups = new Map();
  for (const name of names) {
    if (DISC.test(name)) continue; // a disc marker is not a volume of a series
    const { name: prefix, no } = splitVolume(name);
    if (!no) continue;
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

// Why a folder the walk went past holds no book it could read. Called only for
// folders that turned out to have nothing, so the extra looking is rare.
function whyNothing(dir, seen) {
  if (seen.error) return { reason: 'unreadable', detail: seen.error };
  // a book one level deeper than the layout goes: genre / author / series / book
  // is as deep as it reads, and this is a level below that
  for (const inner of seen.dirs) {
    const below = listing(inner);
    if (below.audio.length || below.dirs.some((d) => listing(d).audio.length)) {
      return {
        reason: 'deeper',
        detail: `the audio is in ${path.basename(inner)}, a folder deeper than `
          + 'genre / author / series / book goes',
      };
    }
  }
  if (seen.others.length) {
    return {
      reason: 'unsupported',
      detail: `holds ${seen.others.join(', ')} — this app reads .mp3 .m4a .m4b .ogg .flac .opus`,
    };
  }
  return { reason: 'empty', detail: 'no audio files in it, and no folder under it that has any' };
}

async function walkAndScan(only) {
  const jobs = [];
  const tooDeep = [];
  const skipped = [];
  const note = (dir, reason, detail) => {
    if (skipped.length < 500) skipped.push({ path: dir, reason, detail });
  };
  // one library folder, or all of them
  const libs = only
    ? getLibraries().filter((l) => path.resolve(l.path) === path.resolve(only))
    : getLibraries();
  if (only && !libs.length) throw new Error(`Not a library folder: ${only}`);
  for (const lib of libs) {
    if (!fs.existsSync(lib.path)) continue;
    if (!lib.asGenre && looksTooDeep(lib.path)) tooDeep.push(lib.path);
    const root = lib.asGenre ? null : listing(lib.path);
    if (root) root.aside.forEach((d) => note(d, 'aside', 'set aside by an import, and not offered again'));
    for (const genreDir of (lib.asGenre ? [lib.path] : root.dirs)) {
      const genre = path.basename(genreDir);
      const inGenre = listing(genreDir);
      inGenre.aside.forEach((d) => note(d, 'aside', 'set aside by an import, and not offered again'));
      if (inGenre.audio.length) {
        note(genreDir, 'loose', `${inGenre.audio.length} audio file(s) lying in the genre folder `
          + 'itself: a book has to be in a folder of its own, under an author');
      }
      for (const authorDir of inGenre.dirs) {
        const author = path.basename(authorDir);
        const inAuthor = listing(authorDir);
        inAuthor.aside.forEach((d) => note(d, 'aside', 'set aside by an import, and not offered again'));
        if (inAuthor.audio.length) {
          note(authorDir, 'loose', `${inAuthor.audio.length} audio file(s) lying in the author folder `
            + 'itself: a book has to be in a folder of its own');
        }
        const level3s = inAuthor.dirs;
        // What the folder names say about series, for the books that are not in a
        // series folder. A guess from names, so it names the series and never
        // moves a file: it goes where a series read from the tags goes.
        const guessed = seriesFromSiblings(level3s.map((d) => path.basename(d)));
        for (const level3 of level3s) {
          const guess = guessed.get(path.basename(level3)) || null;
          const inLevel3 = listing(level3);
          inLevel3.aside.forEach((d) => note(d, 'aside', 'set aside by an import, and not offered again'));
          if (inLevel3.audio.length) {
            jobs.push({ genre, author, series: null, dir: level3, files: inLevel3.audio, guess });
          } else if (discFiles(level3)) {
            jobs.push({ genre, author, series: null, dir: level3, files: discFiles(level3), guess });
          } else if (!inLevel3.dirs.length) {
            const why = whyNothing(level3, inLevel3);
            note(level3, why.reason, why.detail);
          } else {
            // A folder holding a single sub-folder is a redundantly nested book,
            // not a series: there is nothing to group.
            const books = inLevel3.dirs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
            const series = books.length > 1 ? path.basename(level3) : null;
            for (const bookDir of books) {
              const inBook = listing(bookDir);
              const files = inBook.audio.length ? inBook.audio : discFiles(bookDir);
              if (!files || !files.length) {
                const why = whyNothing(bookDir, inBook);
                note(bookDir, why.reason, why.detail);
                continue;
              }
              jobs.push({ genre, author, series, dir: bookDir, files, guess: series ? null : guess });
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

  skippedLast = skipped;
  progress.skipped = skipped.length;
  progress.total = jobs.length;
  // Several books at once: the work is waiting for the disk, not thinking.
  await pool(jobs, async (j) => {
    progress.current = path.basename(j.dir);
    // read the count first: "x += await y" reads x before the await, so with
    // several books in flight the additions would overwrite each other
    const added = await addBook(j.genre, j.author, j.series, j.dir, j.files, false, j.guess);
    progress.books += added;
    progress.done++;
  });
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
