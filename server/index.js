// First of all: who this process writes as, before any folder is created.
import { writingAs } from './user.js';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import crypto from 'node:crypto';
import { db, getSetting, setSetting, getLibraries, DATA_DIR } from './db.js';
import { scan, progress, lastSkipped } from './scan.js';
import { lookup, applyMetadata, writeProgress, anyWriting, lookupProgress, probeSeries } from './google.js';
import { candidates, genreFolders, importBook, compareWithExisting, skipImport, listReplaced,
  deleteReplaced, deleteAllReplaced, fileProgress, importState, lookAgain, clean } from './import.js';
import { adminRequired, unlock, lock, isAdmin, requireAdmin, tokenOf } from './admin.js';
import { tidyCovers, deleteDuplicates, zipDuplicates } from './covers.js';
import { placeholderCover } from './placeholder.js';
import { validateAll, recheck, listBroken, forget, checkProgress } from './validate.js';
import { startTagAll, stopTagAll, tagStatus, settleTagAll, tagAllWorking } from './tagall.js';
import { moveBook, moveToGenre, deleteToTrash, listTrash, restoreFromTrash, purge, emptyTrash, purgeExpired, KEEP_DAYS } from './trash.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

// Addresses without file names in them. The listening page is the one that gets
// handed around, so it is the bare address; the page that changes the collection
// is /admin. The old file names still answer, with a redirect, so a bookmark or
// an old link does not break. index: false, or express.static would serve
// index.html at / before these ever ran.
const PUBLIC = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '../public');
const page = (name) => (req, res) => res.sendFile(path.join(PUBLIC, name));
app.get('/', page('listen.html'));
app.get('/admin', page('index.html'));
app.get('/listen.html', (req, res) => res.redirect('/'));
app.get('/index.html', (req, res) => res.redirect('/admin'));
app.use(express.static(PUBLIC, { index: false }));

// Covers are named after the image itself, so this marker in the URL changes
// exactly when the picture does, and a browser may then keep it for a week. A
// book with no picture gets one drawn from its title, so that names it instead.
const coverV = (b) => crypto.createHash('md5')
  .update(b.cover || `title:${b.title || ''}`).digest('hex').slice(0, 12);

// Which build is answering. Without it there is no way to tell from the outside
// whether a container has actually been updated.
const VERSION = JSON.parse(fs.readFileSync(path.join(PUBLIC, '../package.json'), 'utf8')).version;

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(400).json({ error: e.message }));

// --- who may change things ---------------------------------------------
app.get('/api/admin', (req, res) => res.json({
  required: adminRequired(), admin: isAdmin(req),
}));

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

// --- what the app can actually do with the folders ----------------------
// The answer to "why can I not write in my own collection": who this process is,
// and what each folder lets it do. It writes a file and removes it again rather
// than reading the mode and guessing.
const canWrite = (dir) => {
  const probe = path.join(dir, `.write-test-${process.pid}`);
  try {
    fs.writeFileSync(probe, 'x');
    fs.rmSync(probe);
    return { canWrite: true, why: '' };
  } catch (e) {
    return { canWrite: false, why: e.code || e.message };
  }
};

const look = (what, dir) => {
  const out = { what, path: dir, exists: false, owner: '', mode: '', canWrite: false, why: '' };
  if (!dir) return { ...out, why: 'not set' };
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch (e) {
    return { ...out, why: e.code === 'ENOENT' ? 'not there' : (e.code || e.message) };
  }
  out.exists = true;
  out.owner = `${stat.uid}:${stat.gid}`;
  out.mode = (stat.mode & 0o777).toString(8).padStart(3, '0');
  return { ...out, ...canWrite(dir) };
};

app.get('/api/permissions', requireAdmin, (req, res) => {
  const places = [look('Database and covers', DATA_DIR)];
  for (const lib of getLibraries()) places.push(look('Library', lib.path));
  const importPath = getSetting('importPath');
  if (importPath) places.push(look('Import folder', importPath));
  // one book, to show what the collection's own folders look like
  const book = db.prepare('SELECT path FROM books LIMIT 1').get();
  if (book) places.push(look('A book folder', book.path));
  res.json({ writingAs: writingAs(), places });
});

// --- users -------------------------------------------------------------
// A listener has no password, so what keeps one person out of another person's
// place in a book is that a browser is only ever offered the names it has said
// itself. A browser that has never been here is offered nothing and has to type
// a name; the names it has used are kept in a cookie of its own.
const WHO = 'whoami';

const claimed = (req) => {
  const raw = (req.headers.cookie || '').split(';').map((c) => c.trim())
    .find((c) => c.startsWith(`${WHO}=`));
  if (!raw) return [];
  try {
    const names = JSON.parse(Buffer.from(raw.slice(WHO.length + 1), 'base64url').toString());
    return Array.isArray(names) ? names.filter((n) => typeof n === 'string' && n) : [];
  } catch {
    return []; // a cookie we did not write, or one that was cut short
  }
};

const claim = (res, names) => res.setHeader('Set-Cookie',
  `${WHO}=${Buffer.from(JSON.stringify(names)).toString('base64url')}`
  + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=34560000');

app.get('/api/users', (req, res) => {
  const known = new Set(db.prepare('SELECT name FROM users').all().map((u) => u.name));
  res.json(claimed(req).filter((n) => known.has(n)).sort());
});

app.post('/api/users', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.json({ ok: true });
  db.prepare('INSERT OR IGNORE INTO users (name) VALUES (?)').run(name);
  const names = claimed(req);
  if (!names.includes(name)) names.push(name);
  claim(res, names);
  res.json({ ok: true });
});

// --- settings ----------------------------------------------------------
app.get('/api/settings', requireAdmin, (req, res) => res.json({
  libraries: getLibraries(),
  importPath: getSetting('importPath'),
}));
app.post('/api/settings', requireAdmin, (req, res) => {
  setSetting('libraries', JSON.stringify(req.body.libraries || []));
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

function ensureGenre(rawName, rawParent) {
  const name = clean(rawName || '');
  if (!name) throw new Error('A genre needs a name');
  const parent = (rawParent || genreParent()).trim();
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
  return { dir, existed, registered: !inRoot && !listed };
}

app.post('/api/genres', requireAdmin, wrap(async (req, res) =>
  res.json(ensureGenre(req.body.name, req.body.parent))));

// --- import ------------------------------------------------------------
app.get('/api/files/status', (req, res) => res.json(fileProgress));
app.get('/api/import/state', requireAdmin, (req, res) => {
  lookAgain(); // whoever is watching the panel is why the folder gets looked at
  res.json(importState);
});
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
// Is a book with this genre, author and title already there, and how do the two
// copies compare? Asked before an import, so nothing is overwritten unseen.
app.get('/api/import/compare', requireAdmin, wrap(async (req, res) =>
  res.json(await compareWithExisting(req.query))));
// Not importing it: the folder stays, renamed so it says so, and is not offered again
app.post('/api/import/skip', requireAdmin, wrap(async (req, res) => res.json(skipImport(req.body.source))));
app.post('/api/import', requireAdmin, wrap(async (req, res) => res.json(await importBook(req.body))));

// --- writing tags into the whole collection -----------------------------
// Runs on the server, so closing the page does not stop it, and what is left of
// it is a queue in the database, so it can be picked up again later.
app.get('/api/tagall/status', (req, res) => res.json(tagStatus()));
app.post('/api/tagall', requireAdmin, wrap(async (req, res) => {
  // the run would reach the book that is being written and count it as failed
  if (anyWriting()) {
    throw new Error('A tag write is running on one book. Wait for it to finish, then start the whole collection.');
  }
  res.json(startTagAll());
}));
app.post('/api/tagall/stop', requireAdmin, (req, res) => res.json(stopTagAll()));

// --- checking the books against the disk --------------------------------
// Opens every file of every book, so it is only ever started by hand.
app.get('/api/validate/status', (req, res) => res.json(checkProgress));
app.post('/api/validate', requireAdmin, (req, res) => {
  if (!checkProgress.running) validateAll(Date.now()).catch(() => {});
  res.json({ started: true });
});
app.get('/api/broken', requireAdmin, (req, res) => res.json(listBroken()));
app.post('/api/broken/:id/recheck', requireAdmin, wrap(async (req, res) => res.json(await recheck(req.params.id))));
// files still there: to the trash, so they can come back. Nothing there: forget the book.
app.post('/api/broken/:id/delete', requireAdmin, wrap(async (req, res) => {
  const book = db.prepare('SELECT path FROM books WHERE id = ?').get(Number(req.params.id));
  if (!book) throw new Error('Book not found');
  res.json(fs.existsSync(book.path)
    ? { ...await deleteToTrash(req.params.id, Date.now()), trashed: true }
    : forget(req.params.id));
}));

// --- cover files no book uses any more ---------------------------------
app.post('/api/covers/tidy', requireAdmin, wrap(async (req, res) => res.json(tidyCovers())));
app.post('/api/covers/duplicates/delete', requireAdmin, wrap(async (req, res) => res.json(deleteDuplicates())));
app.post('/api/covers/duplicates/zip', requireAdmin, wrap(async (req, res) => res.json(zipDuplicates(Date.now()))));

// --- copies an import replaced -----------------------------------------
app.get('/api/replaced', requireAdmin, (req, res) => res.json(listReplaced()));
// before /api/replaced/:id, which would otherwise read "all" as an id
app.post('/api/replaced/all', requireAdmin, wrap(async (req, res) => res.json(deleteAllReplaced())));
app.post('/api/replaced/:id', requireAdmin, wrap(async (req, res) => res.json(deleteReplaced(req.params.id))));

// --- move and delete ---------------------------------------------------
app.post('/api/move/:id', requireAdmin, wrap(async (req, res) => res.json(await moveBook(req.params.id, req.body))));

app.get('/api/trash', requireAdmin, (req, res) => res.json({ keepDays: KEEP_DAYS, items: listTrash(Date.now()) }));
// before /api/trash/:id, which would otherwise read "empty" as a book id
app.post('/api/trash/empty', requireAdmin, wrap(async (req, res) => res.json(emptyTrash())));
app.post('/api/trash/:id', requireAdmin, wrap(async (req, res) => res.json(await deleteToTrash(req.params.id, Date.now()))));
app.post('/api/trash/:id/restore', requireAdmin, wrap(async (req, res) => res.json(await restoreFromTrash(req.params.id))));
app.post('/api/trash/:id/purge', requireAdmin, wrap(async (req, res) => res.json(purge(req.params.id))));

app.post('/api/scan', requireAdmin, (req, res) => {
  if (!progress.running) scan(req.body.path || '');
  res.json({ started: true });
});
app.get('/api/scan/status', (req, res) => res.json(progress));
// What the last scan walked past, and why: the answer to "it found fewer books
// than I have". Empty until a scan has run in this container.
app.get('/api/skipped', requireAdmin, (req, res) => res.json(lastSkipped()));

// --- library -----------------------------------------------------------
// A series is a folder where the collection has one, and whatever the files call
// it where it does not, so a book filed straight under its author still shows up
// in the series it belongs to.
const SERIES = "NULLIF(COALESCE(NULLIF(b.series, ''), NULLIF(b.tag_series, '')), '')";
app.get('/api/stats', (req, res) => {
  const books = db.prepare('SELECT COUNT(*) AS n FROM books').get().n;
  const files = db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n;
  const done = db.prepare('SELECT COUNT(*) AS n FROM progress WHERE user = ? AND done = 1').get(req.query.user || '').n;
  res.json({ books, files, done, todo: books - done, version: VERSION });
});

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
                               ${SERIES} AS series, b.series_no,
                               (SELECT COUNT(*) FROM tracks t WHERE t.book_id = b.id) AS tracks
                        FROM progress p JOIN books b ON b.id = p.book_id
                        WHERE p.user = ? AND (p.position > 0 OR p.done = 1)
                        ORDER BY p.updated DESC LIMIT 12`).all(req.query.user || '')
    .map((b) => ({ ...b, coverV: coverV(b) })),
  recent: db.prepare(`SELECT b.id, b.title, b.author, b.genre, b.cover, ${SERIES} AS series, b.series_no
                      FROM books b ORDER BY b.id DESC LIMIT 12`).all()
    .map((b) => ({ ...b, coverV: coverV(b) })),
}));

app.get('/api/genres', (req, res) => {
  const genres = db.prepare('SELECT genre AS name, COUNT(*) AS books FROM books GROUP BY genre ORDER BY genre').all();
  const series = db.prepare(`SELECT b.genre, ${SERIES} AS name, COUNT(*) AS books
                             FROM books b WHERE ${SERIES} IS NOT NULL
                             GROUP BY b.genre, name ORDER BY name`).all();
  res.json(genres.map((g) => ({ ...g, series: series.filter((s) => s.genre === g.name).map(({ name, books }) => ({ name, books })) })));
});

app.get('/api/authors', (req, res) => res.json(
  db.prepare('SELECT author AS name, COUNT(*) AS books FROM books WHERE genre = ? GROUP BY author ORDER BY author')
    .all(req.query.genre)));

// Books of one author, or of one series: the same card either way.
app.get('/api/books', (req, res) => {
  const bySeries = !!req.query.series;
  const rows = db.prepare(`SELECT b.id, b.title, ${SERIES} AS series, b.series_no, b.author, b.narrator, b.year,
                                  b.description, b.cover, b.duration, b.tagged,
                                  p.done, p.position > 0 AS started
                           FROM books b LEFT JOIN progress p ON p.book_id = b.id AND p.user = ?
                           WHERE b.genre = ? AND ${bySeries ? `${SERIES} = ?` : 'b.author = ?'}
                           ORDER BY series IS NULL, series, b.series_no, b.title`)
    .all(req.query.user || '', req.query.genre, bySeries ? req.query.series : req.query.author);
  res.json(rows.map((b) => ({ ...b, coverV: coverV(b) })));
});

// The box at the top of the page. Every word has to appear somewhere in the
// book — its title, author, genre, series, narrator or description — so
// "sanderson mist" finds Mistborn without knowing which field holds what.
const HAYSTACK = ['b.title', 'b.author', 'b.genre', 'b.series', 'b.tag_series', 'b.narrator', 'b.description']
  .map((c) => `COALESCE(${c}, '')`).join(` || ' ' || `);

app.get('/api/search', (req, res) => {
  const words = (req.query.q || '').trim().split(/\s+/).filter(Boolean).slice(0, 6);
  if (!words.length || words.join('').length < 2) return res.json([]);
  const rows = db.prepare(`SELECT b.id, b.title, ${SERIES} AS series, b.series_no, b.author, b.narrator, b.year,
                                  b.genre, b.description, b.cover, b.duration, b.tagged,
                                  p.done, p.position > 0 AS started
                           FROM books b LEFT JOIN progress p ON p.book_id = b.id AND p.user = ?
                           WHERE ${words.map(() => `${HAYSTACK} LIKE ?`).join(' AND ')}
                           -- a title match is what you were most likely after
                           ORDER BY CASE WHEN b.title LIKE ? THEN 0 WHEN b.author LIKE ? THEN 1 ELSE 2 END,
                                    b.author, b.series_no, b.title
                           LIMIT 200`)
    .all(req.query.user || '', ...words.map((w) => `%${w}%`), `%${words[0]}%`, `%${words[0]}%`);
  res.json(rows.map((b) => ({ ...b, coverV: coverV(b) })));
});

app.post('/api/listened', (req, res) => {
  const { user, bookId, done } = req.body;
  if (!user) return res.status(400).json({ error: 'No user' });
  // Unticking it says "I have not listened to this", so the place kept in it goes
  // with the tick: the book leaves Continue listening and starts from the top.
  if (!done) {
    db.prepare('DELETE FROM progress WHERE user = ? AND book_id = ?').run(user, Number(bookId));
    return res.json({ ok: true, cleared: true });
  }
  db.prepare(`INSERT INTO progress (user, book_id, track_idx, position, done, updated)
    VALUES (?, ?, 0, 0, 1, datetime('now'))
    ON CONFLICT(user, book_id) DO UPDATE SET done = 1, updated = excluded.updated`)
    .run(user, bookId);
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
  book.coverV = coverV(book);
  res.json(book);
});

app.get('/api/cover/:id', (req, res) => {
  const book = db.prepare('SELECT cover, title, author FROM books WHERE id = ?').get(Number(req.params.id));
  if (!book) return res.status(404).end();
  // No art, or art that is no longer on disk: a drawn cover rather than a hole
  // in the shelf. It is derived from the title, so it may be cached like a file.
  const drawn = () => res.type('image/svg+xml')
    .set('Cache-Control', 'public, max-age=604800').send(placeholderCover(book));
  if (!book.cover) return drawn();
  const file = book.cover.startsWith('file:') ? book.cover.slice(5) : path.join(DATA_DIR, 'covers', book.cover);
  if (!fs.existsSync(file)) return drawn();
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
// What Google says about series, over a stretch of the collection. The key is on
// this container, so this is the only place the question can actually be asked;
// the answer is a table to read and to send on. One search per book, plus what a
// series costs, so it is deliberately a handful of books and not the library.
app.get('/api/lookup/series-report', requireAdmin, wrap(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 15, 1), 40);
  // the ones with nothing yet first: they are the ones the report is about
  const books = db.prepare(`SELECT id, title, author, series, tag_series FROM books
                            ORDER BY (COALESCE(NULLIF(series, ''), NULLIF(tag_series, '')) IS NOT NULL),
                                     author, title LIMIT ?`).all(limit);
  res.json({ books: await probeSeries(books) });
}));

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

// one write per book, so the bar that follows one asks for that book by name
app.get('/api/apply/status', (req, res) => res.json(writeProgress(req.query.book)));

app.post('/api/apply/:id', requireAdmin, wrap(async (req, res) => {
  let book = db.prepare('SELECT * FROM books WHERE id = ?').get(Number(req.params.id));
  if (!book) return res.status(404).json({ error: 'Book not found' });
  // the whole-collection run is writing these same files: one writer at a time
  if (req.body.writeTags && tagAllWorking()) {
    throw new Error('The whole-collection tag write is running. Stop it in Settings first.');
  }
  // a genre is a folder, so taking Google's genre files the book there first,
  // and the tag write below then carries the genre it ended up in
  let moved = '';
  if (req.body.genre && req.body.genre !== book.genre) {
    ensureGenre(req.body.genre);
    moved = req.body.genre;
    await moveToGenre(book.id, req.body.genre);
    book = db.prepare('SELECT * FROM books WHERE id = ?').get(book.id);
  }
  res.json({ ...await applyMetadata(book, req.body.pick, !!req.body.writeTags), moved });
}));

// drop whatever outstayed its keep-days, at startup and once a day after that,
// so a container that runs for months still clears its trash
settleTagAll();
purgeExpired(Date.now());
setInterval(() => purgeExpired(Date.now()), 24 * 60 * 60 * 1000).unref();

const port = process.env.PORT || 8523;
app.listen(port, () => console.log(`My Audiobook Collection on :${port} (data: ${DATA_DIR})`));
