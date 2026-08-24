import fs from 'node:fs';
import path from 'node:path';
import { db, getLibraries } from './db.js';
import { audioFiles } from './scan.js';
import { beginFileWork, fileProgress, moveFolder, destinationFor, clean } from './import.js';

export const KEEP_DAYS = 30;

const bookOr404 = (id) => {
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(Number(id));
  if (!book) throw new Error('Book not found');
  return book;
};

// Move a book to where its new genre, author, series and title say it belongs,
// keeping its row so the listened state and playback position survive.
export async function moveBook(id, { genre, author, series, title }) {
  const book = bookOr404(id);
  const dest = destinationFor({ genre, author, series, title });
  if (dest === book.path) throw new Error('That is where the book already is');
  if (fs.existsSync(dest)) throw new Error(`There is already a folder at ${dest}`);
  if (!fs.existsSync(book.path)) throw new Error(`The book's folder is gone: ${book.path}`);

  beginFileWork();
  try {
    await moveFolder(book.path, dest);
    db.prepare('UPDATE books SET path = ?, genre = ?, author = ?, series = ?, title = ? WHERE id = ?')
      .run(dest, genre, clean(author), clean(series) || null, clean(title), book.id);
    for (const t of db.prepare('SELECT id, path FROM tracks WHERE book_id = ?').all(book.id)) {
      db.prepare('UPDATE tracks SET path = ? WHERE id = ?')
        .run(path.join(dest, path.relative(book.path, t.path)), t.id);
    }
    return { dest };
  } catch (e) {
    fileProgress.error = e.message;
    throw e;
  } finally {
    fileProgress.running = false;
  }
}

// The trash lives inside the library entry the book came from, so a delete is a
// rename on the same filesystem and never a copy of gigabytes. Its name starts
// with a dot, which the scanner already skips.
function trashRootFor(bookPath) {
  // resolve both sides: a library path is stored as typed, a book path is built
  // with path.join, so the two can differ in separators alone
  const book = path.resolve(bookPath);
  const entry = getLibraries().find((l) => {
    const root = path.resolve(l.path);
    return book === root || book.startsWith(root + path.sep);
  });
  if (!entry) throw new Error(`That book is not inside a library folder: ${bookPath}`);
  return path.join(path.resolve(entry.path), '.trash');
}

export async function deleteToTrash(id, stamp) {
  const book = bookOr404(id);
  if (!fs.existsSync(book.path)) throw new Error(`The book's folder is gone: ${book.path}`);
  const dest = path.join(trashRootFor(book.path), `${stamp}-${path.basename(book.path)}`);

  beginFileWork();
  try {
    const files = audioFiles(book.path).length
      || db.prepare('SELECT COUNT(*) AS n FROM tracks WHERE book_id = ?').get(book.id).n;
    await moveFolder(book.path, dest);
    db.prepare(`INSERT INTO trash (was_path, trash_path, genre, author, series, title, files, deleted_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(book.path, dest, book.genre, book.author, book.series, book.title, files, new Date(stamp).toISOString());
    db.prepare('DELETE FROM tracks WHERE book_id = ?').run(book.id);
    db.prepare('DELETE FROM progress WHERE book_id = ?').run(book.id);
    db.prepare('DELETE FROM books WHERE id = ?').run(book.id);
    return { dest };
  } catch (e) {
    fileProgress.error = e.message;
    throw e;
  } finally {
    fileProgress.running = false;
  }
}

export function listTrash(now) {
  return db.prepare('SELECT * FROM trash ORDER BY deleted_at DESC').all().map((t) => ({
    ...t,
    onDisk: fs.existsSync(t.trash_path),
    daysLeft: Math.max(0, KEEP_DAYS - Math.floor((now - Date.parse(t.deleted_at)) / 86400000)),
  }));
}

export async function restoreFromTrash(id) {
  const t = db.prepare('SELECT * FROM trash WHERE id = ?').get(Number(id));
  if (!t) throw new Error('Not in the trash');
  if (!fs.existsSync(t.trash_path)) throw new Error('Those files are no longer in the trash');
  if (fs.existsSync(t.was_path)) throw new Error(`There is already a folder at ${t.was_path}`);

  beginFileWork();
  try {
    await moveFolder(t.trash_path, t.was_path);
    db.prepare('DELETE FROM trash WHERE id = ?').run(t.id);
    return { restored: t.was_path };
  } catch (e) {
    fileProgress.error = e.message;
    throw e;
  } finally {
    fileProgress.running = false;
  }
}

// Deleting for real: the files go, the row goes.
export function purge(id) {
  const t = db.prepare('SELECT * FROM trash WHERE id = ?').get(Number(id));
  if (!t) throw new Error('Not in the trash');
  fs.rmSync(t.trash_path, { recursive: true, force: true });
  db.prepare('DELETE FROM trash WHERE id = ?').run(t.id);
  return { purged: 1 };
}

export function emptyTrash() {
  let purged = 0;
  for (const t of db.prepare('SELECT id FROM trash').all()) purged += purge(t.id).purged;
  return { purged };
}

// Anything past its keep-days is dropped; called at startup and after a scan.
export function purgeExpired(now) {
  let purged = 0;
  for (const t of listTrash(now)) if (t.daysLeft === 0) purged += purge(t.id).purged;
  return { purged };
}
