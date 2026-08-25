import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import crypto from 'node:crypto';
import { db, getSetting, setSetting, getLibraries, DATA_DIR } from './db.js';
import { scan, progress } from './scan.js';
import { lookup, applyMetadata, tagProgress, lookupProgress } from './google.js';
import { candidates, genreFolders, importBook, fileProgress, importState, clean } from './import.js';
import { adminRequired, setPassword, unlock, lock, isAdmin, requireAdmin, tokenOf } from './admin.js';
import { moveBook, deleteToTrash, listTrash, restoreFromTrash, purge, emptyTrash, purgeExpired, KEEP_DAYS } from './trash.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(path.dirname(url.fileURLToPath(import.meta.url)), '../public')));

// Covers are named after the image itself, so this marker in the URL changes
// exactly when the picture does, and a browser may then keep it for a week.
const coverV = (cover) => (cover ? crypto.createHash('md5').update(cover).digest('hex').slice(0, 12) : '');

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(400).json({ error: e.message }));

// --- who may change things ---------------------------------------------
app.get('/api/admin', (req, res) => res.json({ required: adminRequired(), admin: isAdmin(req) }));

app.post('/api/admin/unlock', wrap(async (req, res) => {
  const { token } = unlock(req.body.password);
  if (token) res.setHeader('Set-Cookie', `admin=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
  res.json({ admin: true });
}));

app.post('/api/admin/lock', (req, res) => {
  lock(tokenOf(req));
  res.setHeader('Set-Cookie', 'admin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ admin: false });
});

// Setting the first password needs no password: an unguarded app is being closed.
app.post('/api/admin/password', wrap(async (req, res) => {
  if (adminRequired() && !isAdmin(req)) return res.status(403).json({ error: 'Unlock first' });
  const r = setPassword(req.body.password || '');
  if (r.required) {
    const { token } = unlock(req.body.password);
    res.setHeader('Set-Cookie', `admin=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
  }
  res.json(r);
}));

// --- users -------------------------------------------------------------
app.get('/api/users', (req, res) => res.json(db.prepare('SELECT name FROM users ORDER BY name').all().map((u) => u.name)));
app.post('/api/users', (req, res) => {
  const name = (req.body.name || '').trim();
  if (name) db.prepare('INSERT OR IGNORE INTO users (name) VALUES (?)').run(name);
  res.json({ ok: true });
});

// --- settings ----------------------------------------------------------
app.get('/api/settings', requireAdmin, (req, res) => res.json({
  libraries: getLibraries(),
  googleApiKey: getSetting('googleApiKey'),
  importPath: getSetting('importPath'),
}));
app.post('/api/settings', requireAdmin, (req, res) => {
  setSetting('libraries', JSON.stringify(req.body.libraries || []));
  setSetting('googleApiKey', req.body.googleApiKey || '');
  setSetting('importPath', req.body.importPath || '');
  res.json({ ok: true });
});

// folder picker: list sub-directories of a server path
app.get('/api/browse', requireAdmin, (req, res) => {
  const dir = req.query.path || '/';
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => path.resolve(dir, e.name))
    .sort();
  res.json({ path: path.resolve(dir), parent: path.dirname(path.resolve(dir)), entries });
});

// --- genres ------------------------------------------------------------
// A genre is a folder. Where a library folder holds the genre folders, the new
// one only has to exist; where each genre folder is registered on its own, the
// new one has to be registered too.
const genreParent = () => {
  const libs = getLibraries();
  const root = libs.find((l) => !l.asGenre);
  if (root) return root.path;
  return libs.length ? path.dirname(path.resolve(libs[0].path)) : '';
};

app.get('/api/genrefolders', requireAdmin, (req, res) => res.json({
  folders: genreFolders(),
  suggestedParent: genreParent(),
}));

app.post('/api/genres', requireAdmin, wrap(async (req, res) => {
  const name = clean(req.body.name || '');
  if (!name) throw new Error('A genre needs a name');
  const parent = (req.body.parent || genreParent()).trim();
  if (!parent) throw new Error('Say which folder the genre folder goes in');
  if (!fs.existsSync(parent)) throw new Error(`That folder is not there: ${parent}`);

  const dir = path.join(parent, name);
  const existed = fs.existsSync(dir);
  if (!existed) fs.mkdirSync(dir, { recursive: true });

  const libs = getLibraries();
  const here = path.resolve(dir);
  const inRoot = libs.some((l) => !l.asGenre && here.startsWith(path.resolve(l.path) + path.sep));
  const listed = libs.some((l) => path.resolve(l.path) === here);
  if (!inRoot && !listed) {
    libs.push({ path: dir, asGenre: true });
    setSetting('libraries', JSON.stringify(libs));
  }
  res.json({ dir, existed, registered: !inRoot && !listed });
}));

// --- import ------------------------------------------------------------
app.get('/api/files/status', (req, res) => res.json(fileProgress));
app.get('/api/import/state', requireAdmin, (req, res) => res.json(importState));
app.get('/api/import', requireAdmin, wrap(async (req, res) => {
  const c = await candidates({ refresh: req.query.refresh === '1' });
  res.json({
    path: getSetting('importPath'),
    genres: genreFolders().map((g) => g.genre),
    candidates: c.items,
    cachedAt: c.cachedAt,
    fromCache: c.fromCache,
  });
}));
app.post('/api/import', requireAdmin, wrap(async (req, res) => res.json(await importBook(req.body))));

// --- move and delete ---------------------------------------------------
app.post('/api/move/:id', requireAdmin, wrap(async (req, res) => res.json(await moveBook(req.params.id, req.body))));

app.get('/api/trash', requireAdmin, (req, res) => res.json({ keepDays: KEEP_DAYS, items: listTrash(Date.now()) }));
// before /api/trash/:id, which would otherwise read "empty" as a book id
app.post('/api/trash/empty', requireAdmin, wrap(async (req, res) => res.json(emptyTrash())));
app.post('/api/trash/:id', requireAdmin, wrap(async (req, res) => res.json(await deleteToTrash(req.params.id, Date.now()))));
app.post('/api/trash/:id/restore', requireAdmin, wrap(async (req, res) => res.json(await restoreFromTrash(req.params.id))));
app.post('/api/trash/:id/purge', requireAdmin, wrap(async (req, res) => res.json(purge(req.params.id))));

app.post('/api/scan', requireAdmin, (req, res) => { if (!progress.running) scan(); res.json({ started: true }); });
app.get('/api/scan/status', (req, res) => res.json(progress));

// --- library -----------------------------------------------------------
app.get('/api/stats', (req, res) => {
  const books = db.prepare('SELECT COUNT(*) AS n FROM books').get().n;
  const files = db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n;
  const done = db.prepare('SELECT COUNT(*) AS n FROM progress WHERE user = ? AND done = 1').get(req.query.user || '').n;
  res.json({ books, files, done, todo: books - done });
});

// ids for the "write tags into every book" run, which the browser drives one by one
app.get('/api/allbooks', requireAdmin, (req, res) => res.json(
  db.prepare('SELECT id, title FROM books ORDER BY genre, author, title').all()));

const REQUIRED_TAGS = ['album', 'title', 'artist', 'album artist', 'genre', 'year', 'description', 'cover', 'track no'];

// books whose files miss one of the required tags, split into what writing can
// fix now and what has to be looked up first
app.get('/api/untagged', requireAdmin, (req, res) => {
  const rows = db.prepare(`SELECT id, genre, author, title, year, description, cover, tagged
                           FROM books ORDER BY genre, author, title`).all();
  res.json(rows.flatMap((b) => {
    const inFile = new Set((b.tagged || '').split(',').filter(Boolean));
    const missing = REQUIRED_TAGS.filter((f) => !inFile.has(f));
    if (!missing.length) return [];
    const known = {
      album: b.title, title: b.title, artist: b.author, 'album artist': b.author, genre: b.genre,
      year: b.year, description: b.description, cover: b.cover, 'track no': 1,
    };
    return [{
      id: b.id, genre: b.genre, author: b.author, title: b.title,
      fixable: missing.filter((f) => known[f]),
      needsLookup: missing.filter((f) => !known[f]),
    }];
  }));
});

// the landing view: what this user was listening to, and what turned up last
app.get('/api/home', (req, res) => res.json({
  continue: db.prepare(`SELECT b.id, b.title, b.author, b.genre, b.cover, p.track_idx, p.done,
                               (SELECT COUNT(*) FROM tracks t WHERE t.book_id = b.id) AS tracks
                        FROM progress p JOIN books b ON b.id = p.book_id
                        WHERE p.user = ? AND (p.position > 0 OR p.done = 1)
                        ORDER BY p.updated DESC LIMIT 12`).all(req.query.user || '')
    .map((b) => ({ ...b, coverV: coverV(b.cover) })),
  recent: db.prepare('SELECT id, title, author, genre, cover FROM books ORDER BY id DESC LIMIT 12').all()
    .map((b) => ({ ...b, coverV: coverV(b.cover) })),
}));

app.get('/api/genres', (req, res) => res.json(
  db.prepare('SELECT genre AS name, COUNT(*) AS books FROM books GROUP BY genre ORDER BY genre').all()));

app.get('/api/authors', (req, res) => res.json(
  db.prepare('SELECT author AS name, COUNT(*) AS books FROM books WHERE genre = ? GROUP BY author ORDER BY author')
    .all(req.query.genre)));

app.get('/api/books', (req, res) => res.json(
  db.prepare(`SELECT b.id, b.title, b.series, b.narrator, b.year, b.description, b.cover, b.duration, b.tagged,
                     p.done, p.position > 0 AS started
              FROM books b LEFT JOIN progress p ON p.book_id = b.id AND p.user = ?
              WHERE b.genre = ? AND b.author = ?
              ORDER BY b.series IS NULL, b.series, b.title`)
    .all(req.query.user || '', req.query.genre, req.query.author)
    .map((b) => ({ ...b, coverV: coverV(b.cover) }))));

app.post('/api/listened', (req, res) => {
  const { user, bookId, done } = req.body;
  if (!user) return res.status(400).json({ error: 'No user' });
  db.prepare(`INSERT INTO progress (user, book_id, track_idx, position, done, updated)
    VALUES (?, ?, 0, 0, ?, datetime('now'))
    ON CONFLICT(user, book_id) DO UPDATE SET done = excluded.done, updated = excluded.updated`)
    .run(user, bookId, done ? 1 : 0);
  res.json({ ok: true });
});

app.get('/api/books/:id', (req, res) => {
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(Number(req.params.id));
  if (!book) return res.status(404).json({ error: 'Not found' });
  book.tracks = db.prepare('SELECT id, idx, title, duration FROM tracks WHERE book_id = ? ORDER BY idx').all(book.id);
  book.progress = db.prepare('SELECT track_idx, position FROM progress WHERE user = ? AND book_id = ?')
    .get(req.query.user || '', book.id) || null;
  // The folder it actually sits in may name a series the library does not call one
  // (a series of a single book). The move dialog has to prefill from the folders,
  // or moving without editing anything would quietly flatten that level away.
  const here = path.resolve(book.path);
  const gf = genreFolders().find((g) => here.startsWith(path.resolve(g.path) + path.sep));
  const rel = gf ? path.relative(path.resolve(gf.path), here).split(path.sep) : [];
  book.folderSeries = rel.length >= 3 ? rel[1] : '';
  book.coverV = coverV(book.cover);
  res.json(book);
});

app.get('/api/cover/:id', (req, res) => {
  const cover = db.prepare('SELECT cover FROM books WHERE id = ?').get(Number(req.params.id))?.cover;
  if (!cover) return res.status(404).end();
  const file = cover.startsWith('file:') ? cover.slice(5) : path.join(DATA_DIR, 'covers', cover);
  if (!fs.existsSync(file)) return res.status(404).end();
  // with the marker the URL names one picture, so it need not be asked for again
  res.sendFile(file, req.query.v ? { maxAge: '7d', immutable: true } : {});
});

// --- playback ----------------------------------------------------------
app.get('/api/stream/:trackId', (req, res) => {
  const track = db.prepare('SELECT path FROM tracks WHERE id = ?').get(Number(req.params.trackId));
  if (!track || !fs.existsSync(track.path)) return res.status(404).end();
  res.sendFile(track.path); // sendFile handles Range requests
});

app.post('/api/progress', (req, res) => {
  const { user, bookId, trackIdx, position } = req.body;
  if (!user) return res.status(400).json({ error: 'No user' });
  db.prepare(`INSERT INTO progress (user, book_id, track_idx, position, updated) VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user, book_id) DO UPDATE SET track_idx = excluded.track_idx,
      position = excluded.position, updated = excluded.updated`)
    .run(user, bookId, trackIdx, position);
  res.json({ ok: true });
});

// --- metadata lookup ---------------------------------------------------
// before /api/lookup/:id, which would otherwise swallow "status"
app.get('/api/lookup/status', (req, res) => res.json({
  ...lookupProgress,
  retryIn: Math.max(0, Math.ceil((lookupProgress.retryUntil - Date.now()) / 1000)),
}));

// a lookup for something not in the library yet, such as a book being imported
app.get('/api/lookup', requireAdmin, wrap(async (req, res) => {
  if (!req.query.q) return res.status(400).json({ error: 'Nothing to search for' });
  res.json(await lookup({ title: '', author: '' }, req.query.q));
}));

app.get('/api/lookup/:id', requireAdmin, wrap(async (req, res) => {
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(Number(req.params.id));
  if (!book) return res.status(404).json({ error: 'Book not found' });
  res.json(await lookup(book, req.query.q));
}));

app.get('/api/apply/status', (req, res) => res.json(tagProgress));

app.post('/api/apply/:id', requireAdmin, wrap(async (req, res) => {
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(Number(req.params.id));
  if (!book) return res.status(404).json({ error: 'Book not found' });
  res.json(await applyMetadata(book, req.body.pick, !!req.body.writeTags));
}));

// drop whatever outstayed its keep-days, at startup and once a day after that,
// so a container that runs for months still clears its trash
purgeExpired(Date.now());
setInterval(() => purgeExpired(Date.now()), 24 * 60 * 60 * 1000).unref();

const port = process.env.PORT || 8523;
app.listen(port, () => console.log(`My Audiobook Collection on :${port} (data: ${DATA_DIR})`));
