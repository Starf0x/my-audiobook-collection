import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseFile } from 'music-metadata';
import { db, getLibraries, DATA_DIR } from './db.js';

const AUDIO = /\.(mp3|m4a|m4b|ogg|flac|opus)$/i;
const COVER = /^(cover|folder|front)\.(jpg|jpeg|png)$/i;

const dirs = (p) => fs.readdirSync(p, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
  .map((e) => path.join(p, e.name));

const audioFiles = (p) => fs.readdirSync(p, { withFileTypes: true })
  .filter((e) => e.isFile() && AUDIO.test(e.name))
  .map((e) => path.join(p, e.name))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

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
    const comment = c.comment?.[0];
    meta.description = (typeof comment === 'string' ? comment : comment?.text) || '';
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

async function addBook(genre, author, series, bookPath) {
  const files = audioFiles(bookPath);
  if (!files.length) return 0;
  const folderTitle = path.basename(bookPath);
  const existing = db.prepare('SELECT id, duration FROM books WHERE path = ?').get(bookPath);
  const known = existing
    ? db.prepare('SELECT path FROM tracks WHERE book_id = ? ORDER BY idx').all(existing.id).map((t) => t.path)
    : [];
  const unchanged = existing && known.length === files.length && known.every((p, i) => p === files[i]);

  if (unchanged) {
    db.prepare('UPDATE books SET genre = ?, author = ?, series = ? WHERE id = ?')
      .run(genre, author, series, existing.id);
    return 1;
  }

  const m = await readMeta(files, bookPath);
  db.prepare(`INSERT INTO books (path, genre, author, series, title, narrator, year, description, cover, duration)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET genre = excluded.genre, author = excluded.author, series = excluded.series,
      title = excluded.title, narrator = excluded.narrator, year = excluded.year,
      description = excluded.description, cover = excluded.cover, duration = excluded.duration`)
    .run(bookPath, genre, author, series, m.title || folderTitle, m.narrator, m.year, m.description, m.cover, m.duration);

  const id = db.prepare('SELECT id FROM books WHERE path = ?').get(bookPath).id;
  db.prepare('DELETE FROM tracks WHERE book_id = ?').run(id);
  const ins = db.prepare('INSERT INTO tracks (book_id, idx, path, title, duration) VALUES (?, ?, ?, ?, ?)');
  files.forEach((f, i) => ins.run(id, i, f, m.tracks[i].title, m.tracks[i].duration));
  return 1;
}

export const progress = { running: false, done: 0, total: 0, current: '', books: 0, error: '' };

export async function scan() {
  // running must be true before walking the tree: on a large library that walk
  // takes tens of seconds, and the UI would otherwise read the scan as finished.
  Object.assign(progress, { running: true, done: 0, total: 0, current: '', books: 0, error: '' });
  const jobs = [];
  for (const root of getLibraries()) {
    if (!fs.existsSync(root)) continue;
    for (const genreDir of dirs(root)) {
      const genre = path.basename(genreDir);
      for (const authorDir of dirs(genreDir)) {
        const author = path.basename(authorDir);
        for (const level3 of dirs(authorDir)) {
          if (audioFiles(level3).length) jobs.push({ genre, author, series: null, dir: level3 });
          else {
            // A folder holding a single sub-folder is a redundantly nested book,
            // not a series: there is nothing to group.
            const books = dirs(level3);
            const series = books.length > 1 ? path.basename(level3) : null;
            for (const bookDir of books) jobs.push({ genre, author, series, dir: bookDir });
          }
        }
      }
    }
  }

  progress.total = jobs.length;
  try {
    for (const j of jobs) {
      progress.current = path.basename(j.dir);
      progress.books += await addBook(j.genre, j.author, j.series, j.dir);
      progress.done++;
    }
    const seen = jobs.map((j) => j.dir);
    for (const b of db.prepare('SELECT id, path FROM books').all()) {
      if (!seen.includes(b.path)) {
        db.prepare('DELETE FROM tracks WHERE book_id = ?').run(b.id);
        db.prepare('DELETE FROM books WHERE id = ?').run(b.id);
      }
    }
  } catch (e) {
    progress.error = e.message;
  } finally {
    progress.running = false;
  }
  return { books: progress.books };
}
