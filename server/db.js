import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.DATA_DIR || '/data';
fs.mkdirSync(path.join(DATA_DIR, 'covers'), { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'library.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY,
    path TEXT UNIQUE,
    genre TEXT, author TEXT, series TEXT, title TEXT,
    narrator TEXT, year TEXT, description TEXT, cover TEXT,
    duration REAL DEFAULT 0,
    tagged TEXT DEFAULT '',
    -- the series as the files claim it, for books that are not in a series folder
    tag_series TEXT DEFAULT '',
    series_no INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS tracks (
    id INTEGER PRIMARY KEY,
    book_id INTEGER, idx INTEGER, path TEXT, title TEXT, duration REAL
  );
  CREATE TABLE IF NOT EXISTS progress (
    user TEXT, book_id INTEGER, track_idx INTEGER, position REAL, updated TEXT,
    done INTEGER DEFAULT 0,
    PRIMARY KEY (user, book_id)
  );
  CREATE TABLE IF NOT EXISTS users (name TEXT PRIMARY KEY);
  -- a whole-collection tag write, and what is left of it: the queue is what
  -- makes the run resumable after a stop or a restart
  CREATE TABLE IF NOT EXISTS tagrun (
    id INTEGER PRIMARY KEY,
    total INTEGER, done INTEGER, written INTEGER, failed INTEGER,
    state TEXT, current TEXT, started_at TEXT, finished_at TEXT
  );
  CREATE TABLE IF NOT EXISTS tagqueue (book_id INTEGER PRIMARY KEY);
  -- what a disk check found wrong with a book, so the list survives a restart
  CREATE TABLE IF NOT EXISTS broken (
    book_id INTEGER PRIMARY KEY, reason TEXT, detail TEXT, checked_at TEXT
  );
  CREATE TABLE IF NOT EXISTS replaced (
    id INTEGER PRIMARY KEY,
    path TEXT UNIQUE, was_path TEXT,
    genre TEXT, author TEXT, series TEXT, title TEXT,
    files INTEGER, bytes INTEGER, quality TEXT, replaced_at TEXT
  );
  CREATE TABLE IF NOT EXISTS trash (
    id INTEGER PRIMARY KEY,
    was_path TEXT, trash_path TEXT,
    genre TEXT, author TEXT, series TEXT, title TEXT,
    files INTEGER, deleted_at TEXT
  );
  -- A deleted book must not leave its verdict behind: SQLite hands out ids again,
  -- and a new book would inherit it.
  CREATE TRIGGER IF NOT EXISTS broken_follows_books AFTER DELETE ON books
  BEGIN DELETE FROM broken WHERE book_id = OLD.id; END;
  -- every book lookup, delete and tag write filters tracks by book_id
  CREATE INDEX IF NOT EXISTS tracks_book ON tracks (book_id);
`);

// columns added after the first release; harmless when they already exist
try { db.exec('ALTER TABLE progress ADD COLUMN done INTEGER DEFAULT 0'); } catch { /* already there */ }
try { db.exec("ALTER TABLE books ADD COLUMN tagged TEXT DEFAULT ''"); } catch { /* already there */ }
try { db.exec("ALTER TABLE books ADD COLUMN tag_series TEXT DEFAULT ''"); } catch { /* already there */ }
try { db.exec('ALTER TABLE books ADD COLUMN series_no INTEGER DEFAULT 0'); } catch { /* already there */ }

// descriptions stored before iTunes normalisation data was filtered out of them
for (const b of db.prepare("SELECT id, description FROM books WHERE description <> ''").all()) {
  if (/^[0-9a-f]{6,8}( +[0-9a-f]{6,8})+$/i.test(b.description.trim())) {
    db.prepare("UPDATE books SET description = '' WHERE id = ?").run(b.id);
  }
}

// The admin password used to be settable in the app; it comes from the
// container now, so a hash left in here means nothing and is dropped.
for (const key of ['adminHash', 'adminSalt']) {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

export const getSetting = (key, def = '') =>
  db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? def;

export const setSetting = (key, value) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?')
    .run(key, value, value);

// The key lives in the container template, so it survives an empty appdata
// folder and there is no second copy of it to drift out of step.
export const googleKey = () => process.env.GOOGLE_API_KEY || '';

// A library entry is either a folder holding genre folders, or a single genre
// folder itself. Plain strings are entries stored before that choice existed.
export const getLibraries = () => {
  let saved = [];
  try {
    saved = JSON.parse(getSetting('libraries', '[]'));
  } catch {
    return []; // rather no libraries for a moment than every request failing
  }
  return (Array.isArray(saved) ? saved : [])
    .map((l) => (typeof l === 'string' ? { path: l, asGenre: false } : l))
    .filter((l) => l && typeof l.path === 'string' && l.path);
};
