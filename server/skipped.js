// Putting a folder the scan walked past where it belongs.
//
// *Not counted* names every folder a scan could not read as a book and why. That
// list said what was wrong and left the fixing to a file manager. This does the
// fixing: given a genre, an author and a title, the audio is moved into
// `<genre>/<author>/[series]/<title>/`, the book is added to the library, and the
// same words are written into the files — so the metadata that decided where it
// went is also the metadata it carries.
//
// The two shapes that need care, and why moving "the folder" is not enough:
//
// * `loose` — the audio lies directly in a genre or author folder, so the path in
//   the list is that folder. Moving it would move the whole genre; only the loose
//   files may be taken.
// * `deeper` — the audio sits below the level the layout reads
//   (`…/Book One/Disc A/01.mp3`). The files are flattened into the one book
//   folder, and where they come from more than one sub-folder the folder name
//   goes in front of each file, or the order of the discs would be lost.
import fs from 'node:fs';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import { db, getLibraries } from './db.js';
import { genreFolders, destinationFor, clean } from './import.js';
import { addOne } from './scan.js';

const AUDIO = /\.(mp3|m4a|m4b|ogg|flac|opus)$/i;

const dirsIn = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
const audioIn = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .filter((e) => e.isFile() && AUDIO.test(e.name)).map((e) => path.join(dir, e.name))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

// Every audio file under a folder, with the sub-folder it came from, deepest last
// so a two disc book keeps its order.
function audioUnder(dir, depth = 0) {
  const out = audioIn(dir).map((file) => ({ file, from: '' }));
  if (depth > 3) return out;
  for (const sub of dirsIn(dir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
    for (const found of audioUnder(sub, depth + 1)) {
      out.push({ file: found.file, from: found.from ? `${path.basename(sub)}/${found.from}` : path.basename(sub) });
    }
  }
  return out;
}

// Which files this folder would give up, for the reason it was skipped.
export function filesOf(source, reason) {
  if (!fs.existsSync(source)) return [];
  return reason === 'loose'
    ? audioIn(source).map((file) => ({ file, from: '' }))
    : audioUnder(source);
}

// Where in the library this folder sits, so the genre and author can be offered
// without asking: the layout is `<library>/<genre>/<author>/…`.
function placeOf(source) {
  const here = path.resolve(source);
  for (const g of genreFolders()) {
    const root = path.resolve(g.path);
    if (here === root) return { genre: g.genre, rest: [] };
    if (here.startsWith(root + path.sep)) {
      return { genre: g.genre, rest: path.relative(root, here).split(path.sep) };
    }
  }
  // a library that is one genre folder itself has no genre level above it
  for (const lib of getLibraries()) {
    const root = path.resolve(lib.path);
    if (here.startsWith(root + path.sep)) return { genre: '', rest: path.relative(root, here).split(path.sep) };
  }
  return { genre: '', rest: [] };
}

// What to put in the fields before anybody types: the folders say where it is,
// and the first file usually says what it is.
export async function guessFor(source, reason = '') {
  const found = filesOf(source, reason);
  const place = placeOf(source);
  const guess = {
    genre: place.genre,
    author: place.rest[0] || '',
    series: '',
    title: reason === 'loose' ? '' : path.basename(source),
    files: found.length,
    discs: [...new Set(found.map((f) => f.from).filter(Boolean))],
    genres: genreFolders().map((g) => g.genre),
  };
  // a book one level too deep is `<author>/<series>/<book>` as often as
  // `<author>/<book>/<disc>`, so what is between the author and here is the series
  if (place.rest.length >= 2 && reason !== 'loose') guess.series = place.rest[place.rest.length - 2] || '';
  if (guess.series === guess.title) guess.series = '';
  if (!found.length) return guess;
  try {
    const tags = (await parseFile(found[0].file)).common || {};
    if (!guess.author && (tags.albumartist || tags.artist)) guess.author = tags.albumartist || tags.artist;
    if (tags.album) guess.title = tags.album;
    else if (!guess.title && tags.title) guess.title = tags.title;
    if (!guess.genre && tags.genre?.[0]) guess.genre = tags.genre[0];
  } catch { /* the tags are a bonus; the folders already said enough */ }
  return guess;
}

// A name nothing else in the folder has yet.
const freeName = (dir, wanted) => {
  let name = wanted;
  for (let n = 2; fs.existsSync(path.join(dir, name)); n++) {
    const dot = wanted.lastIndexOf('.');
    name = dot > 0 ? `${wanted.slice(0, dot)} (${n})${wanted.slice(dot)}` : `${wanted} (${n})`;
  }
  return name;
};

// The folders under it that the move emptied, deepest first.
function pruneEmptyUnder(dir) {
  for (const sub of dirsIn(dir)) {
    pruneEmptyUnder(sub);
    try {
      fs.rmdirSync(sub);
    } catch { /* something that is not audio is still in it */ }
  }
}

// Empty folders the move left behind, up to but never including the genre folder
// itself: an empty author folder is litter, a genre folder is the library.
function pruneUpTo(from, stopAt) {
  let dir = path.resolve(from);
  const stop = path.resolve(stopAt);
  while (dir !== stop && dir.startsWith(stop + path.sep)) {
    try {
      fs.rmdirSync(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

// Move it, add it, and hand back the row it landed on.
export async function fileSkipped({ source, reason, genre, author, series, title }) {
  if (!source || !fs.existsSync(source)) throw new Error('That folder is no longer there.');
  const found = filesOf(source, reason);
  if (!found.length) throw new Error('There is no audio in that folder to file.');
  const dest = destinationFor({ genre, author, series, title });
  const inPlace = path.resolve(dest) === path.resolve(source);
  if (inPlace && !found.some((f) => f.from)) {
    throw new Error('That is where it already is. Give it another genre, author or title.');
  }
  if (!inPlace && fs.existsSync(dest) && (audioIn(dest).length || dirsIn(dest).length)) {
    throw new Error(`There is already a book at ${dest}. Nothing was moved.`);
  }
  fs.mkdirSync(dest, { recursive: true });

  // the disc folder goes in front of the name only when there is more than one,
  // or every book of one disc would end up with "Disc 01 - " on every file
  const discs = new Set(found.map((f) => f.from).filter(Boolean));
  const moved = [];
  for (const { file, from } of found) {
    const base = path.basename(file);
    const wanted = discs.size > 1 && from ? `${from.replace(/[\\/]/g, ' - ')} - ${base}` : base;
    const to = path.join(dest, freeName(dest, wanted));
    try {
      fs.renameSync(file, to);
    } catch (e) {
      if (e.code !== 'EXDEV') throw e;
      fs.copyFileSync(file, to);
      fs.rmSync(file);
    }
    moved.push(to);
  }
  // what is left of where it came from: the disc folders it emptied, and then the
  // folders above them, but never the genre folder
  if (reason !== 'loose') {
    pruneEmptyUnder(source);
    const place = genreFolders().find((g) => path.resolve(source).startsWith(path.resolve(g.path) + path.sep));
    if (place && !inPlace) pruneUpTo(source, place.path);
  }

  await addOne({ genre, author: clean(author), series: clean(series), dir: dest, force: true });
  const row = db.prepare('SELECT id, genre, author, series, title FROM books WHERE path = ?').get(dest) || {};
  return { dest, files: moved.length, ...row };
}
