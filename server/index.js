import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { db, getSetting, setSetting, getLibraries, DATA_DIR } from './db.js';
import { scan, progress } from './scan.js';
import { lookup, applyMetadata } from './google.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(path.dirname(url.fileURLToPath(import.meta.url)), '../public')));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(400).json({ error: e.message }));

// --- users -------------------------------------------------------------
app.get('/api/users', (req, res) => res.json(db.prepare('SELECT name FROM users ORDER BY name').all().map((u) => u.name)));
app.post('/api/users', (req, res) => {
  const name = (req.body.name || '').trim();
  if (name) db.prepare('INSERT OR IGNORE INTO users (name) VALUES (?)').run(name);
  res.json({ ok: true });
});

// --- settings ----------------------------------------------------------
app.get('/api/settings', (req, res) => res.json({
  libraries: getLibraries(),
  googleApiKey: getSetting('googleApiKey'),
}));
app.post('/api/settings', (req, res) => {
  setSetting('libraries', JSON.stringify(req.body.libraries || []));
  setSetting('googleApiKey', req.body.googleApiKey || '');
  res.json({ ok: true });
});

// folder picker: list sub-directories of a server path
app.get('/api/browse', (req, res) => {
  const dir = req.query.path || '/';
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => path.resolve(dir, e.name))
    .sort();
  res.json({ path: path.resolve(dir), parent: path.dirname(path.resolve(dir)), entries });
});

app.post('/api/scan', (req, res) => { if (!progress.running) scan(); res.json({ started: true }); });
app.get('/api/scan/status', (req, res) => res.json(progress));

// --- library -----------------------------------------------------------
app.get('/api/genres', (req, res) => res.json(
  db.prepare('SELECT genre AS name, COUNT(*) AS books FROM books GROUP BY genre ORDER BY genre').all()));

app.get('/api/authors', (req, res) => res.json(
  db.prepare('SELECT author AS name, COUNT(*) AS books FROM books WHERE genre = ? GROUP BY author ORDER BY author')
    .all(req.query.genre)));

app.get('/api/books', (req, res) => res.json(
  db.prepare(`SELECT id, title, series, narrator, year, description, cover, duration
              FROM books WHERE genre = ? AND author = ?
              ORDER BY series IS NULL, series, title`).all(req.query.genre, req.query.author)));

app.get('/api/books/:id', (req, res) => {
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(Number(req.params.id));
  if (!book) return res.status(404).json({ error: 'Not found' });
  book.tracks = db.prepare('SELECT id, idx, title, duration FROM tracks WHERE book_id = ? ORDER BY idx').all(book.id);
  book.progress = db.prepare('SELECT track_idx, position FROM progress WHERE user = ? AND book_id = ?')
    .get(req.query.user || '', book.id) || null;
  res.json(book);
});

app.get('/api/cover/:id', (req, res) => {
  const cover = db.prepare('SELECT cover FROM books WHERE id = ?').get(Number(req.params.id))?.cover;
  if (!cover) return res.status(404).end();
  const file = cover.startsWith('file:') ? cover.slice(5) : path.join(DATA_DIR, 'covers', cover);
  fs.existsSync(file) ? res.sendFile(file) : res.status(404).end();
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
app.get('/api/lookup/:id', wrap(async (req, res) => {
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(Number(req.params.id));
  res.json(await lookup(book, req.query.q));
}));

app.post('/api/apply/:id', wrap(async (req, res) => {
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(Number(req.params.id));
  res.json(await applyMetadata(book, req.body.pick, !!req.body.writeTags));
}));

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`My Audiobook Collection on :${port} (data: ${DATA_DIR})`));
