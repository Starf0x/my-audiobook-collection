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
    series_no INTEGER DEFAULT 0,
    -- The series this book's series belongs to, where an author writes in parts:
    -- author / series / part / book. The sub-series is the series column itself --
    -- it is what numbers the books, what completeness counts and what the other
    -- two faces report -- and this names the one above it, which only groups.
    -- Keeping it that way round is why nothing else had to change.
    -- (No backticks in here: this whole schema is one template literal.)
    parent_series TEXT DEFAULT ''
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
  -- A listener used to be a name and nothing else, and the listening page was
  -- open to whoever could reach it. It is an account now: somebody asks for one
  -- with a reason, the admin approves it, and only then can they sign in.
  -- state is pending, approved or denied; pass is scrypt of the password with
  -- salt, and is empty for the names that existed before this, which are
  -- approved and choose a password the first time they sign in.
  CREATE TABLE IF NOT EXISTS users (name TEXT PRIMARY KEY);
  -- Signed-in browsers. In the database rather than in memory, because the
  -- cookie is good for seven days and a container restart is not a reason to
  -- ask everybody in the house to sign in again.
  CREATE TABLE IF NOT EXISTS listener_sessions (
    token TEXT PRIMARY KEY, name TEXT, made TEXT, seen TEXT
  );
  CREATE INDEX IF NOT EXISTS listener_sessions_name ON listener_sessions (name);
  -- The hearts. One row per person per book, and it goes when either goes.
  CREATE TABLE IF NOT EXISTS favourites (
    user TEXT, book_id INTEGER, at TEXT,
    PRIMARY KEY (user, book_id)
  );
  CREATE TRIGGER IF NOT EXISTS favourites_follow_books AFTER DELETE ON books
  BEGIN DELETE FROM favourites WHERE book_id = OLD.id; END;
  -- Books somebody played to the end. Deliberately not worked out from progress:
  -- clearing your place in a book, unticking it or starting it again says what
  -- you are listening to now and nothing about what you have finished, and a
  -- tally that fell when somebody tidied up would not be worth having. It is
  -- also deliberately not dropped when a book is: finishing it happened.
  CREATE TABLE IF NOT EXISTS completions (
    user TEXT, book_id INTEGER, title TEXT, at TEXT,
    PRIMARY KEY (user, book_id)
  );
  -- Whole books taken away, and by whom. The admin's statistics say which, so
  -- the title is kept here too — a download of a book that is later deleted is
  -- still a download that happened.
  CREATE TABLE IF NOT EXISTS downloads (
    id INTEGER PRIMARY KEY, user TEXT, book_id INTEGER, title TEXT, at TEXT
  );
  CREATE INDEX IF NOT EXISTS downloads_user ON downloads (user, at);
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
  CREATE TABLE IF NOT EXISTS converted (
    id INTEGER PRIMARY KEY,
    path TEXT UNIQUE, was_path TEXT,
    genre TEXT, author TEXT, series TEXT, title TEXT,
    files INTEGER, bytes INTEGER, converted_at TEXT
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
  -- and for the same reason, what a listener had done and where they were: a scan
  -- that drops a book whose folder has gone left these behind, and the next book
  -- added could be given the freed id along with a stranger's place in it
  CREATE TRIGGER IF NOT EXISTS progress_follows_books AFTER DELETE ON books
  BEGIN DELETE FROM progress WHERE book_id = OLD.id; END;
  -- every book lookup, delete and tag write filters tracks by book_id
  CREATE INDEX IF NOT EXISTS tracks_book ON tracks (book_id);
`);

// columns added after the first release; harmless when they already exist
try { db.exec('ALTER TABLE progress ADD COLUMN done INTEGER DEFAULT 0'); } catch { /* already there */ }
try { db.exec("ALTER TABLE books ADD COLUMN tagged TEXT DEFAULT ''"); } catch { /* already there */ }
try { db.exec("ALTER TABLE books ADD COLUMN tag_series TEXT DEFAULT ''"); } catch { /* already there */ }
try { db.exec('ALTER TABLE books ADD COLUMN series_no INTEGER DEFAULT 0'); } catch { /* already there */ }
try { db.exec("ALTER TABLE books ADD COLUMN parent_series TEXT DEFAULT ''"); } catch { /* already there */ }

// A listener became an account in 2.7.0. Every name that was already there is
// approved — locking the household out of its own listening history to add a
// login would be a poor trade — and carries no password until it signs in and
// chooses one. The admin page lists those, so a name nobody claims can be seen
// and removed rather than sitting there for ever.
for (const [column, kind] of [
  ['state', "TEXT DEFAULT 'approved'"], ['pass', "TEXT DEFAULT ''"], ['salt', "TEXT DEFAULT ''"],
  ['reason', "TEXT DEFAULT ''"], ['knows_admin', 'INTEGER DEFAULT 0'],
  ['requested_at', "TEXT DEFAULT ''"], ['decided_at', "TEXT DEFAULT ''"],
  ['last_seen', "TEXT DEFAULT ''"], ['first_seen', "TEXT DEFAULT ''"],
  // the admin may hand out downloading below the top level
  ['may_download', 'INTEGER DEFAULT 0'],
]) {
  try { db.exec(`ALTER TABLE users ADD COLUMN ${column} ${kind}`); } catch { /* already there */ }
}

// descriptions stored before iTunes normalisation data was filtered out of them
for (const b of db.prepare("SELECT id, description FROM books WHERE description <> ''").all()) {
  if (/^[0-9a-f]{6,8}( +[0-9a-f]{6,8})+$/i.test(b.description.trim())) {
    db.prepare("UPDATE books SET description = '' WHERE id = ?").run(b.id);
  }
}

// places kept in books that no longer exist, from before the trigger above
db.exec('DELETE FROM progress WHERE book_id NOT IN (SELECT id FROM books)');

// Narrators that are really the author: a scan used to take the artist tag when
// there was no composer one, and an audiobook's artist is its author. Only the
// ones the files do not carry a narrator tag for can be known to have come from
// there, so those are the ones cleared; where the file itself says it, it stands.
db.exec(`UPDATE books SET narrator = '' WHERE narrator <> '' AND narrator = author
         AND (tagged IS NULL OR tagged NOT LIKE '%narrator%')`);

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

// Google decides what a volume answer contains from where the request comes from,
// and series data belongs to the Play catalogue of a country. Left to the server's
// own address it can answer with no series at all, so the country is said outright.
// Which of Google's catalogues answers. Series data belongs to a country's Play
// catalogue, so this decides how much of it comes back — and asking for a
// catalogue that does not match the server's own address is answered, often
// enough, with "service temporarily unavailable". It is a preference, not a
// secret, so it is set in the page; the container variable is what a fresh
// database starts from, and an empty setting means "let Google decide", which
// sends no country at all.
export const GOOGLE_COUNTRY_KEY = 'googleCountry';
export const googleCountry = () => {
  const saved = getSetting(GOOGLE_COUNTRY_KEY, null);
  const raw = saved === null ? (process.env.GOOGLE_COUNTRY || 'US') : saved;
  return raw.trim().toUpperCase().slice(0, 2);
};

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
