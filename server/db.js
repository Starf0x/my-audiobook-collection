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
    tagged TEXT DEFAULT ''
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
  -- every book lookup, delete and tag write filters tracks by book_id
  CREATE INDEX IF NOT EXISTS tracks_book ON tracks (book_id);
`);

// columns added after the first release; harmless when they already exist
try { db.exec('ALTER TABLE progress ADD COLUMN done INTEGER DEFAULT 0'); } catch { /* already there */ }
try { db.exec("ALTER TABLE books ADD COLUMN tagged TEXT DEFAULT ''"); } catch { /* already there */ }

// descriptions stored before iTunes normalisation data was filtered out of them
for (const b of db.prepare("SELECT id, description FROM books WHERE description <> ''").all()) {
  if (/^[0-9a-f]{6,8}( +[0-9a-f]{6,8})+$/i.test(b.description.trim())) {
    db.prepare("UPDATE books SET description = '' WHERE id = ?").run(b.id);
  }
}

export const getSetting = (key, def = '') =>
  db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? def;

export const setSetting = (key, value) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?')
    .run(key, value, value);

export const getLibraries = () => JSON.parse(getSetting('libraries', '[]'));
