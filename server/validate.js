import fs from 'node:fs';
import { parseFile } from 'music-metadata';
import { db } from './db.js';
import { audioFiles, discFiles } from './scan.js';

// A scan trusts the folders it walks. This does not: it opens every file of
// every book, which is the only way to find a truncated download or a share
// that answers but cannot read. On a large collection it takes a long time,
// so it reports through its own progress object and is never automatic.
export const checkProgress = { running: false, done: 0, total: 0, current: '', broken: 0, error: '' };

const q = {
  books: db.prepare('SELECT id, path, genre, author, title FROM books ORDER BY genre, author, title'),
  book: db.prepare('SELECT id, path, genre, author, title FROM books WHERE id = ?'),
  tracks: db.prepare('SELECT path FROM tracks WHERE book_id = ?'),
  mark: db.prepare(`INSERT INTO broken (book_id, reason, detail, checked_at) VALUES (?, ?, ?, ?)
                    ON CONFLICT(book_id) DO UPDATE SET reason = excluded.reason,
                      detail = excluded.detail, checked_at = excluded.checked_at`),
  clear: db.prepare('DELETE FROM broken WHERE book_id = ?'),
};

// What is wrong with this book, or null when nothing is.
async function checkBook(book) {
  if (!fs.existsSync(book.path)) {
    return { reason: 'gone', detail: 'The folder is not there any more' };
  }
  let files = [];
  try {
    files = audioFiles(book.path).length ? audioFiles(book.path) : (discFiles(book.path) || []);
  } catch (e) {
    return { reason: 'unreadable', detail: `The folder cannot be read: ${e.message}` };
  }
  if (!files.length) return { reason: 'empty', detail: 'The folder holds no audio files any more' };

  let bad = 0;
  for (const file of files) {
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      bad++;
      continue;
    }
    if (!size) { bad++; continue; }
    try {
      const m = await parseFile(file);
      if (!m.format || !m.format.container) bad++;
    } catch {
      bad++; // a header that will not parse is a file no player will play either
    }
    // yield, so the status endpoint can still answer during a long check
    await new Promise((r) => setImmediate(r));
  }
  if (bad) return { reason: 'damaged', detail: `${bad} of ${files.length} file(s) cannot be read` };

  const known = q.tracks.all(book.id).map((t) => t.path);
  const missing = known.filter((p) => !fs.existsSync(p));
  if (missing.length) {
    return {
      reason: 'changed',
      detail: `${missing.length} of ${known.length} file(s) the library listed are gone; ${files.length} other file(s) are there`,
    };
  }
  return null;
}

async function record(book) {
  const bad = await checkBook(book);
  if (bad) q.mark.run(book.id, bad.reason, bad.detail, new Date().toISOString());
  else q.clear.run(book.id);
  return bad;
}

export async function validateAll(stamp) {
  Object.assign(checkProgress, { running: true, done: 0, total: 0, current: '', broken: 0, error: '' });
  try {
    const books = q.books.all();
    checkProgress.total = books.length;
    for (const b of books) {
      checkProgress.current = b.title;
      if (await record(b)) checkProgress.broken++;
      checkProgress.done++;
    }
    return { checked: books.length, broken: checkProgress.broken, at: stamp };
  } catch (e) {
    checkProgress.error = e.message;
    throw e;
  } finally {
    checkProgress.running = false;
  }
}

export async function recheck(id) {
  const book = q.book.get(Number(id));
  if (!book) throw new Error('Book not found');
  const bad = await record(book);
  return { ok: !bad, ...(bad || {}) };
}

export function listBroken() {
  return db.prepare(`SELECT b.book_id AS id, b.reason, b.detail, b.checked_at,
                            k.title, k.genre, k.author, k.path
                     FROM broken b JOIN books k ON k.id = b.book_id
                     ORDER BY b.reason, k.genre, k.author, k.title`).all()
    .map((r) => ({ ...r, onDisk: fs.existsSync(r.path) }));
}

// Forgetting a book the library can no longer find: the row goes, and with it
// the tracks and everyone's place in it. There are no files left to move.
export function forget(id) {
  const book = q.book.get(Number(id));
  if (!book) throw new Error('Book not found');
  db.prepare('DELETE FROM tracks WHERE book_id = ?').run(book.id);
  db.prepare('DELETE FROM progress WHERE book_id = ?').run(book.id);
  db.prepare('DELETE FROM broken WHERE book_id = ?').run(book.id);
  db.prepare('DELETE FROM books WHERE id = ?').run(book.id);
  return { forgotten: book.title };
}
