// First of all: who this process writes as, before any folder is created.
import { writingAs } from './user.js';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import crypto from 'node:crypto';
import { db, getSetting, setSetting, getLibraries, DATA_DIR, googleCountry, GOOGLE_COUNTRY_KEY } from './db.js';
import { scan, progress, lastSkipped, forgetSkipped } from './scan.js';
import { lookup, applyMetadata, writeProgress, anyWriting, lookupProgress, probeSeries,
  GOOGLE_COUNTRIES } from './google.js';
import { candidates, genreFolders, importBook, compareWithExisting, skipImport, listReplaced,
  deleteReplaced, deleteAllReplaced, fileProgress, importState, lookAgain, clean } from './import.js';
import { adminRequired, unlock, lock, isAdmin, requireAdmin, tokenOf } from './admin.js';
import { tidyCovers, deleteDuplicates, zipDuplicates } from './covers.js';
import { placeholderCover, dayIndex, untilTomorrow } from './placeholder.js';
import { uniqueNames, zipLength, writeZipTo } from './zip.js';
import { guessFor, fileSkipped } from './skipped.js';
import { haState, bookPlaylist, tokenOk, inboundToken, baseUrl as baseUrlOf, haSettings, saveHaSettings, haPing, haPlayers,
  haEntities, haPush, haPlay, lastPush, rememberRequest, scheduleHaPush } from './ha.js';
import { validateAll, recheck, listBroken, forget, checkProgress } from './validate.js';
import { startTagAll, stopTagAll, tagStatus, settleTagAll, tagAllWorking } from './tagall.js';
import { moveBook, moveToGenre, deleteToTrash, listTrash, restoreFromTrash, purge, emptyTrash, purgeExpired, KEEP_DAYS } from './trash.js';
import { toolsWhy, convertible, convertBook, convertProgress,
  listConverted, deleteConverted, deleteAllConverted } from './convert.js';
import { enabled as absEnabled, inboundToken as absToken, listener as absListener,
  loginResponse as absLogin, libraries as absLibraries, books as absBooks, book as absBook,
  minifiedItem as absMinified, expandedItem as absExpanded, user as absUser,
  progressOf as absProgress, writeProgressFromWhole as absWriteProgress,
  socketOpen as absSocketOpen, socketPoll as absSocketPoll, socketSay as absSocketSay,
  author as absAuthor, seriesWithProgress as absSeries, filteredBooks as absFiltered,
  LIB as ABS_LIB } from './abs.js';

const absLibraryId = () => ABS_LIB;

const app = express();
app.use(express.json({ limit: '1mb' }));

// Music Assistant's Audiobookshelf client joins its base address and an endpoint
// that already starts with a slash, so every call arrives as `//api/…`. Express
// does not read that as `/api/…`, and without this the whole integration answers
// 404 while looking, from the outside, like a server that is simply not there.
app.use((req, res, next) => {
  while (req.url.startsWith('//')) req.url = req.url.slice(1);
  next();
});

// Addresses without file names in them. The listening page is the one that gets
// handed around, so it is the bare address; the page that changes the collection
// is /admin. The old file names still answer, with a redirect, so a bookmark or
// an old link does not break. index: false, or express.static would serve
// index.html at / before these ever ran.
const PUBLIC = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '../public');
const page = (name) => (req, res) => res.sendFile(path.join(PUBLIC, name));
app.get('/', page('listen.html'));
app.get('/admin', page('index.html'));
app.get('/ha', page('ha.html'));
app.get('/listen.html', (req, res) => res.redirect('/'));
app.get('/index.html', (req, res) => res.redirect('/admin'));
app.use(express.static(PUBLIC, { index: false }));

// Covers are named after the image itself, so this marker in the URL changes
// exactly when the picture does, and a browser may then keep it for a week. A
// book with no picture gets one drawn from its title and the day — the drawn
// colours turn over at midnight — so both go into the marker, or a browser would
// show yesterday's picture until the week was out.
const coverV = (b) => crypto.createHash('md5')
  .update(b.cover || `title:${b.title || ''}:day${dayIndex()}`).digest('hex').slice(0, 12);

// Which build is answering. Without it there is no way to tell from the outside
// whether a container has actually been updated.
const VERSION = JSON.parse(fs.readFileSync(path.join(PUBLIC, '../package.json'), 'utf8')).version;

// A failure becomes a 400 with the reason in it — unless the answer has already
// started, as it has when a download breaks off half way: setting a status then
// throws, and a throw inside this catch is an unhandled rejection, which ends the
// process. Nothing can be said to that reader any more, so the connection goes.
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  if (res.headersSent) return res.destroyed ? undefined : res.destroy();
  return res.status(400).json({ error: e.message });
});

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
  googleCountry: googleCountry(),
  googleCountries: GOOGLE_COUNTRIES,
}));
app.post('/api/settings', requireAdmin, wrap(async (req, res) => {
  setSetting('libraries', JSON.stringify(req.body.libraries || []));
  setSetting('importPath', req.body.importPath || '');
  // two letters or nothing: nothing leaves the country off the requests
  // altogether, which is Google deciding from the server's own address
  if (req.body.googleCountry !== undefined) {
    // judged whole, never cut down first: slicing "Nederland" to "NE" would make a
    // typo into another country's catalogue without a word
    const said = String(req.body.googleCountry || '').trim().toUpperCase();
    if (said && !/^[A-Z]{2}$/.test(said)) throw new Error(`Not a country code: ${req.body.googleCountry}`);
    setSetting(GOOGLE_COUNTRY_KEY, said);
  }
  res.json({ ok: true });
}));

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

// --- ogg and m4b to mp3 ------------------------------------------------
// wrapped, because this one runs two programs and a query: a throw here would
// otherwise be an HTML error page, which the page reads as "no reason given"
app.get('/api/convertible', requireAdmin, wrap(async (req, res) => {
  const why = toolsWhy();
  res.json({ tools: !why, why, books: convertible() });
}));
app.get('/api/convert/status', (req, res) => res.json(convertProgress));
app.post('/api/convert/:id', requireAdmin, wrap(async (req, res) => {
  if (convertProgress.running) throw new Error('A book is being converted already. Wait for it to finish.');
  res.json(await convertBook(req.params.id));
}));

app.get('/api/converted', requireAdmin, (req, res) => res.json(listConverted()));
// before /api/converted/:id, which would otherwise read "all" as an id
app.post('/api/converted/all', requireAdmin, wrap(async (req, res) => res.json(deleteAllConverted())));
app.post('/api/converted/:id', requireAdmin, wrap(async (req, res) => res.json(deleteConverted(req.params.id))));

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

// What to put in the fields for a folder the scan walked past: where it sits says
// the genre and the author, the first file usually says the title.
app.get('/api/skipped/guess', requireAdmin, wrap(async (req, res) =>
  res.json(await guessFor(req.query.path || '', req.query.reason || ''))));

// File it where the given genre, author and title say it belongs, and write those
// words into its files, so what put it there is what it carries.
app.post('/api/skipped/file', requireAdmin, wrap(async (req, res) => {
  const filed = await fileSkipped(req.body || {});
  forgetSkipped(req.body.source);
  let written = 0;
  if (req.body.writeTags && filed.id) {
    const book = db.prepare('SELECT * FROM books WHERE id = ?').get(filed.id);
    const done = await applyMetadata(book, {
      title: book.title, series: req.body.series || '', seriesNo: 0,
    }, true);
    written = done.written;
  }
  res.json({ ...filed, written });
}));

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
// A book is finished when the tick says so, or when the place kept in it sits at
// the end of its last track: pressing Resume on one of those plays its last
// seconds and stops, so it is offered again from the top instead. The grace is a
// tenth of the track and never more than a minute — a player rarely stops on the
// second, and a flat minute would call the whole of a short track the end of it.
const isFinished = (b) => !!b.done
  || (b.track_idx >= b.tracks - 1 && b.trackSeconds > 0
      && b.position >= b.trackSeconds - Math.min(60, b.trackSeconds / 10));
// what the listener is in the middle of, the track they are on, and the seconds
// of the tracks already behind them — so how far into a book a place is can be
// said in time rather than in tracks, which is the only honest way to say it for a
// book that is one long file
const KEPT = `p.track_idx, p.position, p.done,
  (SELECT COALESCE(SUM(t.duration), 0) FROM tracks t
     WHERE t.book_id = b.id AND t.idx < p.track_idx) AS behindSeconds,
  (SELECT COUNT(*) FROM tracks t WHERE t.book_id = b.id) AS tracks,
  (SELECT t.duration FROM tracks t WHERE t.book_id = b.id AND t.idx = p.track_idx) AS trackSeconds`;

// Every book a listener has a place kept in, newest first, each saying whether
// they are done with it. Two views read this: the shelf of what you are in the
// middle of, and the Listened section in the column.
const keptBooks = (user) => db.prepare(`SELECT b.id, b.title, b.author, b.genre, b.cover, ${KEPT},
                                               b.narrator, b.year, b.description, b.duration, b.tagged,
                                               ${SERIES} AS series, b.series_no
                                        FROM progress p JOIN books b ON b.id = p.book_id
                                        WHERE p.user = ? AND (p.position > 0 OR p.done = 1)
                                        ORDER BY p.updated DESC`).all(user || '')
  .map(({ trackSeconds, behindSeconds, ...b }) => {
    const finished = isFinished({ ...b, trackSeconds });
    const into = (behindSeconds || 0) + (b.position || 0);
    return {
      ...b,
      coverV: coverV(b),
      started: b.position > 0,
      finished,
      // where the place is in the book, as a share of the whole: a tick or a
      // finished book is all of it, whatever the numbers say
      into: Math.round(into),
      percent: finished ? 100
        : Math.max(0, Math.min(100, b.duration ? Math.round((into / b.duration) * 100) : 0)),
    };
  });

// The books this listener is done with. Not a shelf: it is a section in the
// column, so the whole list goes, however long it is.
app.get('/api/listened', (req, res) =>
  res.json(keptBooks(req.query.user).filter((b) => b.finished)));

app.get('/api/home', (req, res) => {
  const kept = keptBooks(req.query.user);
  res.json({
    continue: kept.filter((b) => !b.finished).slice(0, 12),
    recent: db.prepare(`SELECT b.id, b.title, b.author, b.genre, b.cover, ${SERIES} AS series, b.series_no
                        FROM books b ORDER BY b.id DESC LIMIT 12`).all()
      .map((b) => ({ ...b, coverV: coverV(b) })),
  });
});

app.get('/api/genres', (req, res) => {
  const genres = db.prepare('SELECT genre AS name, COUNT(*) AS books FROM books GROUP BY genre ORDER BY genre').all();
  const series = db.prepare(`SELECT b.genre, ${SERIES} AS name, COUNT(*) AS books
                             FROM books b WHERE ${SERIES} IS NOT NULL
                             GROUP BY b.genre, name ORDER BY name`).all();
  res.json(genres.map((g) => ({ ...g, series: series.filter((s) => s.genre === g.name).map(({ name, books }) => ({ name, books })) })));
});

// Every series the collection has a hole in, in one pass. It is the same count as
// the line under a series head (§7.10a), asked of the whole library instead of the
// series on one page — the rule is not repeated here, `seriesState` is called for
// each, so the two can never disagree.
//
// Nothing is asked of Google, so this costs no quota and needs no key; it is a
// button rather than something a page loads by itself only because a large
// collection is a query per series.
//
// Three groups come back, because "we cannot say" is an answer and hiding it
// would read as "nothing missing": the series with a gap, a count of those whose
// books carry no volume numbers at all, and the total looked at.
app.get('/api/series-gaps', requireAdmin, (req, res) => {
  const all = db.prepare(`SELECT b.genre, ${SERIES} AS name FROM books b
                          WHERE ${SERIES} IS NOT NULL
                          GROUP BY b.genre, name`).all();
  const states = all.map((s) => ({ genre: s.genre, ...seriesState(s.genre, s.name) }));
  res.json({
    looked: states.length,
    // the biggest holes first: one missing volume of nine is a different morning's
    // work from six of eight
    gaps: states.filter((s) => s.missing.length).sort((a, b) => b.missing.length - a.missing.length
      || a.genre.localeCompare(b.genre) || a.name.localeCompare(b.name)),
    unnumbered: states.filter((s) => s.books > 1 && !s.highest)
      .map(({ genre, name, books }) => ({ genre, name, books }))
      .sort((a, b) => a.genre.localeCompare(b.genre) || a.name.localeCompare(b.name)),
  });
});

app.get('/api/authors', (req, res) => res.json(
  db.prepare('SELECT author AS name, COUNT(*) AS books FROM books WHERE genre = ? GROUP BY author ORDER BY author')
    .all(req.query.genre)));

// Whether a series is all there. Only the volume numbers can say it: the books of
// one series that carry a number are laid out from 1 to the highest, and the
// numbers with no book on them are the ones the collection does not have. Nothing
// here can know that a book *after* the highest was ever published, so it never
// claims more than "1 to N are here" — and where books carry no number at all, the
// honest answer is that none can be given.
//
// Counted over the whole series, not over the books on screen: browsing by author
// shows one author's share of a series, and a gap in that is not a gap in the
// collection.
//
// The sentence it comes with is built here rather than in the pages because the
// library page and the listening page both draw these heads, and a rule with two
// readers drifts.
const andList = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const saysOf = (books, highest, missing, unnumbered) => {
  // one book on its own is a folder, not a series to check
  if (books < 2) return '';
  const noNumber = unnumbered ? ` ${unnumbered} book(s) here carry no volume number` : '';
  if (!highest) return 'No volume numbers here, so nothing can be said about what is missing.';
  if (missing.length) {
    return `Missing: book ${andList(missing)}.`
      + (noNumber ? `${noNumber}, so what is missing may be among them.` : '');
  }
  return (highest === 1 ? 'Book 1 is here.' : `Book 1 to ${highest} are all here.`)
    + (noNumber ? `${noNumber}.` : '');
};

const seriesState = (genre, name) => {
  const nos = db.prepare(`SELECT b.series_no AS no FROM books b
                          WHERE b.genre = ? AND ${SERIES} = ?`).all(genre, name).map((r) => r.no);
  const numbered = [...new Set(nos.filter((n) => n > 0))].sort((a, b) => a - b);
  const unnumbered = nos.filter((n) => !n).length;
  const highest = numbered.length ? numbered[numbered.length - 1] : 0;
  const missing = [];
  for (let n = 1; n <= highest; n++) if (!numbered.includes(n)) missing.push(n);
  return { name, books: nos.length, highest, missing, unnumbered,
           says: saysOf(nos.length, highest, missing, unnumbered) };
};

// Books of one author, or of one series: the same card either way, and with them
// what each series on the page is missing.
app.get('/api/books', (req, res) => {
  const bySeries = !!req.query.series;
  const rows = db.prepare(`SELECT b.id, b.title, ${SERIES} AS series, b.series_no, b.author, b.narrator, b.year,
                                  b.description, b.cover, b.duration, b.tagged,
                                  p.position > 0 AS started, ${KEPT}
                           FROM books b LEFT JOIN progress p ON p.book_id = b.id AND p.user = ?
                           WHERE b.genre = ? AND ${bySeries ? `${SERIES} = ?` : 'b.author = ?'}
                           ORDER BY series IS NULL, series, b.series_no, b.title`)
    .all(req.query.user || '', req.query.genre, bySeries ? req.query.series : req.query.author);
  res.json({
    books: rows.map(({ trackSeconds, ...b }) => ({ ...b, coverV: coverV(b),
      finished: isFinished({ ...b, trackSeconds }) })),
    series: [...new Set(rows.map((b) => b.series).filter(Boolean))]
      .map((name) => seriesState(req.query.genre, name)),
  });
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
                                  p.position > 0 AS started, ${KEPT}
                           FROM books b LEFT JOIN progress p ON p.book_id = b.id AND p.user = ?
                           WHERE ${words.map(() => `${HAYSTACK} LIKE ?`).join(' AND ')}
                           -- a title match is what you were most likely after
                           ORDER BY CASE WHEN b.title LIKE ? THEN 0 WHEN b.author LIKE ? THEN 1 ELSE 2 END,
                                    b.author, b.series_no, b.title
                           LIMIT 200`)
    .all(req.query.user || '', ...words.map((w) => `%${w}%`), `%${words[0]}%`, `%${words[0]}%`);
  res.json(rows.map(({ trackSeconds, ...b }) => ({ ...b, coverV: coverV(b),
    finished: isFinished({ ...b, trackSeconds }) })));
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
  book.progress = db.prepare('SELECT track_idx, position, done FROM progress WHERE user = ? AND book_id = ?')
    .get(req.query.user || '', book.id) || null;
  // The folder it actually sits in may name a series the library does not call one
  // (a series of a single book). The move dialog has to prefill from the folders,
  // or moving without editing anything would quietly flatten that level away.
  const here = path.resolve(book.path);
  const gf = genreFolders().find((g) => here.startsWith(path.resolve(g.path) + path.sep));
  const rel = gf ? path.relative(path.resolve(gf.path), here).split(path.sep) : [];
  book.folderSeries = rel.length >= 3 ? rel[1] : '';
  book.coverV = coverV(book);
  // the same question for the player: a finished book starts at the top
  const on = book.progress ? book.tracks[book.progress.track_idx] : null;
  book.finished = !!book.progress && isFinished({
    done: book.progress.done, track_idx: book.progress.track_idx,
    position: book.progress.position, tracks: book.tracks.length,
    trackSeconds: on ? on.duration : 0,
  });
  res.json(book);
});

app.get('/api/cover/:id', (req, res) => {
  const book = db.prepare('SELECT cover, title, author FROM books WHERE id = ?').get(Number(req.params.id));
  if (!book) return res.status(404).end();
  // No art, or art that is no longer on disk: a drawn cover rather than a hole
  // in the shelf. It is derived from the title, so it may be cached like a file.
  // kept only until the day turns, when its two colours move on
  const drawn = () => res.type('image/svg+xml')
    .set('Cache-Control', `public, max-age=${untilTomorrow()}`).send(placeholderCover(book));
  if (!book.cover) return drawn();
  const file = book.cover.startsWith('file:') ? book.cover.slice(5) : path.join(DATA_DIR, 'covers', book.cover);
  if (!fs.existsSync(file)) return drawn();
  // with the marker the URL names one picture, so it need not be asked for again
  res.sendFile(file, req.query.v ? { maxAge: '7d', immutable: true } : {});
});

// --- playback ----------------------------------------------------------
// --- Home Assistant ----------------------------------------------------
// Two answers and no component: a JSON document to poll, and a playlist to hand
// to a media player. Both refuse when HA_TOKEN is set and not said.
const forHA = (req, res, next) => (tokenOk(req)
  ? next()
  : res.status(401).json({ error: 'HA_TOKEN is set on this container; pass it as ?token= or a Bearer header.' }));

app.get('/api/ha', forHA, (req, res) => res.json(haState(req, VERSION)));

app.get('/api/ha/book/:id.m3u', forHA, (req, res) => {
  const from = Math.max(0, Number(req.query.from) || 0);
  const list = bookPlaylist(req, Number(req.params.id), from);
  if (!list) return res.status(404).type('text/plain').send('No such book, or no files in it.');
  // audio/x-mpegurl is what players expect of an .m3u; utf-8 for the titles
  res.type('audio/x-mpegurl; charset=utf-8').send(list);
});

// The book to carry on with, as one address that never changes: HA can point a
// media player at this and get whatever the listener is in the middle of.
app.get('/api/ha/continue.m3u', forHA, (req, res) => {
  const state = haState(req, VERSION);
  const first = state.continue.find((b) => !b.listened) || state.continue[0];
  if (!first) return res.status(404).type('text/plain').send('Nothing to continue.');
  const list = bookPlaylist(req, first.id, first.track - 1);
  if (!list) return res.status(404).type('text/plain').send('That book has no files.');
  res.type('audio/x-mpegurl; charset=utf-8')
    // so an automation can seek without asking the JSON as well
    .set('X-Audiobook-Id', String(first.id))
    .set('X-Audiobook-Seek', String(first.position))
    .send(list);
});

// --- Music Assistant, through its Audiobookshelf provider ---------------
// Why the app answers as Audiobookshelf at all is in abs.js. These are the calls
// `aioaudiobookshelf` makes; each one hands back the shape that client will
// parse, and nothing here touches the rest of the app.
//
// Off unless MA_TOKEN is set: without it every address below is not there at all,
// rather than there and refusing, so a default install grows no new surface.
const forMA = (req, res, next) => {
  if (!absEnabled()) return res.status(404).end();
  const who = absListener(req);
  if (who === null) return res.status(401).json({ error: 'Bad token' });
  req.listener = who;
  next();
};

// Music Assistant asks for a username and a password. The password is MA_TOKEN;
// the username is which listener this is, so a position it reports lands on the
// right person — and a name it has not seen before is one this app now knows,
// exactly as the listening page's own dialog would have added it.
app.post('/login', (req, res) => {
  if (!absEnabled()) return res.status(404).end();
  const name = String((req.body || {}).username || '').trim();
  if (String((req.body || {}).password || '') !== absToken()) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  if (name) db.prepare('INSERT OR IGNORE INTO users (name) VALUES (?)').run(name);
  res.json(absLogin(name, VERSION));
});

// the same answer for a client configured with a token instead of a password
app.post('/api/authorize', forMA, (req, res) => res.json(absLogin(req.listener, VERSION)));
app.post('/logout', forMA, (req, res) => res.json({}));

// The socket its client opens at setup, before it asks anything else. Engine.IO
// speaks in plain text bodies rather than JSON, so this one route reads its own.
app.get('/socket.io/', (req, res) => {
  if (!absEnabled()) return res.status(404).end();
  return req.query.sid ? absSocketPoll(req, res) : absSocketOpen(res);
});
app.post('/socket.io/', express.text({ type: () => true, limit: '64kb' }), (req, res) => {
  if (!absEnabled()) return res.status(404).end();
  return absSocketSay(req, res);
});

app.get('/api/libraries', forMA, (req, res) => res.json({ libraries: absLibraries() }));
app.get('/api/libraries/:id', forMA, (req, res) => {
  const lib = absLibraries()[0];
  // the provider asks for the library with its filter data in one call
  if (String(req.query.include || '').includes('filterdata')) {
    const all = absBooks();
    return res.json({
      library: lib,
      issues: 0,
      numUserPlaylists: 0,
      filterdata: {
        authors: [...new Set(all.map((b) => b.author))].map((n) => ({ id: `au-${Buffer.from(n).toString('base64url')}`, name: n })),
        genres: [...new Set(all.map((b) => b.genre))],
        tags: [],
        series: [...new Set(all.map((b) => b.series).filter(Boolean))]
          .map((n) => ({ id: `se-${Buffer.from(n).toString('base64url')}`, name: n })),
        narrators: [...new Set(all.map((b) => b.narrator).filter(Boolean))],
        languages: [],
      },
    });
  }
  res.json(lib);
});

// One page of the collection. The client pages through with limit and page, and
// asks for the minified shape unless it says otherwise.
// Every paged listing goes through this, and the reason is worth stating: the
// client's pager is a `while True` that only stops when a page comes back with
// no results in it. A listing that ignores `page` and answers with everything
// each time is an infinite loop inside Music Assistant, not a wrong answer — it
// spins, and the reader sees a folder that never opens. So a page past the end
// must be empty, and a request with no limit is still one page of everything
// followed by nothing.
const paged = (req, all, shape) => {
  const limit = Math.max(0, Number(req.query.limit) || 0);
  const page = Math.max(0, Number(req.query.page) || 0);
  const from = limit ? page * limit : 0;
  const slice = limit ? all.slice(from, from + limit) : (page ? [] : all);
  return { total: all.length, limit, page, results: slice.map(shape) };
};

app.get('/api/libraries/:id/items', forMA, (req, res) =>
  res.json(paged(req, absFiltered(req.query.filter), absMinified)));

// Series are the one grouping this app keeps besides the folders, and they are
// what Music Assistant turns into collapsible collections.
app.get('/api/libraries/:id/series', forMA, (req, res) => {
  const all = absBooks().filter((b) => b.series);
  const names = [...new Set(all.map((b) => b.series))];
  res.json(paged(req, names, (name) => {
    const mine = all.filter((b) => b.series === name);
    return {
      id: `se-${Buffer.from(name).toString('base64url')}`,
      name,
      nameIgnorePrefix: name,
      libraryItemIds: mine.map((b) => String(b.id)),
      numBooks: mine.length,
      addedAt: 0,
      updatedAt: Date.now(),
      books: mine.map(absMinified),
    };
  }));
});

app.get('/api/libraries/:id/authors', forMA, (req, res) => {
  const all = absBooks();
  const names = [...new Set(all.map((b) => b.author))];
  res.json({ authors: names.map((name) => ({
    id: `au-${Buffer.from(name).toString('base64url')}`,
    name,
    addedAt: 0,
    updatedAt: Date.now(),
    numBooks: all.filter((b) => b.author === name).length,
  })) });
});

app.get('/api/libraries/:id/narrators', forMA, (req, res) => {
  const all = absBooks().filter((b) => b.narrator);
  const names = [...new Set(all.map((b) => b.narrator))];
  res.json({ narrators: names.map((name) => ({
    id: `na-${Buffer.from(name).toString('base64url')}`,
    name,
    numBooks: all.filter((b) => b.narrator === name).length,
  })) });
});

// This app has no collections, playlists or shelves of Audiobookshelf's kind.
// An empty answer of the right shape is the honest one: the provider reads it,
// finds nothing, and moves on — where a 404 would read as a broken server.
app.get('/api/libraries/:id/collections', forMA, (req, res) => res.json(paged(req, [], (x) => x)));
app.get('/api/libraries/:id/playlists', forMA, (req, res) => res.json(paged(req, [], (x) => x)));
app.get('/api/libraries/:id/personalized', forMA, (req, res) => res.json([]));

// Browsing into an author or a series asks for it by id. These are the two the
// page walks into from the Authors and Series folders, and a 404 here is what a
// reader sees as a wordless "NotFoundError".
app.get('/api/authors/:id', forMA, (req, res) => {
  const a = absAuthor(req.params.id);
  if (!a) return res.status(404).end();
  res.json(a);
});

app.get('/api/series/:id', forMA, (req, res) => {
  const s = absSeries(req.params.id, req.listener);
  if (!s) return res.status(404).end();
  res.json(s);
});

app.get('/api/items/batch/get', forMA, (req, res) => res.status(404).end());
app.post('/api/items/batch/get', forMA, (req, res) => {
  const ids = ((req.body || {}).libraryItemIds || []).map(Number);
  res.json({ libraryItems: ids.map((id) => absBook(id)).filter(Boolean)
    .map((b) => absExpanded(b, req)) });
});

app.get('/api/items/:id', forMA, (req, res) => {
  const b = absBook(req.params.id);
  if (!b) return res.status(404).end();
  res.json(absExpanded(b, req));
});

// The cover and the audio, at the addresses the item says they are at. Both take
// the token in the query, because a player fetches them itself and sends no
// header of ours.
app.get('/api/items/:id/cover', forMA, (req, res) =>
  res.redirect(`/api/cover/${Number(req.params.id)}`));

app.get('/api/items/:id/file/:trackId', forMA, (req, res) => {
  const track = db.prepare('SELECT path FROM tracks WHERE id = ? AND book_id = ?')
    .get(Number(req.params.trackId), Number(req.params.id));
  if (!track || !fs.existsSync(track.path)) return res.status(404).end();
  res.sendFile(track.path);
});

// A playback session: this app streams the files straight out, so there is
// nothing to open or keep. The answer says what it would have been.
app.post('/api/items/:id/play', forMA, (req, res) => {
  const b = absBook(req.params.id);
  if (!b) return res.status(404).end();
  const item = absExpanded(b, req);
  res.json({
    id: `pl-${b.id}-${Date.now()}`,
    userId: `us-${Buffer.from(req.listener || '').toString('base64url')}`,
    libraryId: absLibraryId(),
    libraryItemId: String(b.id),
    mediaType: 'book',
    mediaMetadata: item.media.metadata,
    chapters: item.media.chapters,
    displayTitle: b.title,
    displayAuthor: b.author,
    coverPath: b.cover || null,
    duration: item.media.duration,
    playMethod: 0,
    mediaPlayer: 'music-assistant',
    startTime: 0,
    currentTime: 0,
    audioTracks: item.media.tracks,
    libraryItem: item,
  });
});

app.get('/api/me', forMA, (req, res) => res.json(absUser(req.listener)));

app.get('/api/me/progress/:id', forMA, (req, res) => {
  const b = absBook(req.params.id);
  const p = b && absProgress(req.listener, b);
  if (!p) return res.status(404).end();
  res.json(p);
});

// What Music Assistant reports back while someone listens there. It is seconds
// into the whole book, which this app keeps as a track and a position inside it.
app.patch('/api/me/progress/:id', forMA, (req, res) => {
  const b = absBook(req.params.id);
  if (!b) return res.status(404).end();
  const said = req.body || {};
  const seconds = Number(said.currentTime);
  if (Number.isFinite(seconds)) {
    absWriteProgress(req.listener, b.id, seconds, said.isFinished === true);
  } else if (said.isFinished === true) {
    absWriteProgress(req.listener, b.id, b.duration || 0, true);
  }
  res.json(absProgress(req.listener, b) || {});
});

// --- the Home Assistant page -------------------------------------------
// This half talks to HA rather than waiting to be asked, so it is the admin's to
// set up: an address, a long-lived token from HA, and which listener to report on.
app.get('/api/ha/config', requireAdmin, (req, res) => {
  rememberRequest(req);
  res.json({
    ...haSettings(),
    lastPush,
    listeners: db.prepare('SELECT name FROM users ORDER BY name').all().map((u) => u.name),
    base: baseUrlOf(req),
  });
});

app.post('/api/ha/config', requireAdmin, (req, res) => {
  const saved = saveHaSettings(req.body || {});
  rememberRequest(req);
  scheduleHaPush(VERSION);
  res.json(saved);
});

app.post('/api/ha/test', requireAdmin, wrap(async (req, res) => res.json(await haPing())));
app.get('/api/ha/players', requireAdmin, wrap(async (req, res) => res.json(await haPlayers())));

// what would be written into HA, without writing it
app.get('/api/ha/entities', requireAdmin, (req, res) => res.json(
  haEntities(req, VERSION).map(([entity, state, attributes]) => ({ entity, state, attributes }))));

app.post('/api/ha/push', requireAdmin, wrap(async (req, res) => {
  rememberRequest(req);
  res.json(await haPush(req, VERSION));
}));

// Playing a book is the one of these an automation may want to call, so the token
// meant for Home Assistant is accepted here as well as an admin session. Only when
// one is actually set: an unset HA_TOKEN must not open this to the whole network.
const adminOrHA = (req, res, next) => (isAdmin(req) || (inboundToken() && tokenOk(req))
  ? next()
  : res.status(401).json({ error: 'Admin only, or set HA_TOKEN on the container and pass it as ?token=.' }));

app.post('/api/ha/play', adminOrHA, wrap(async (req, res) => {
  rememberRequest(req);
  res.json(await haPlay(req, { ...(req.body || {}), version: VERSION }));
}));

// The whole book, as one archive. The browser's own player offered a download of
// the single track that happened to be playing; a book is not one track, so this
// is all of its files. Stored rather than deflated, so the length is known and the
// browser can show how far along it is.
app.get('/api/download/:id', wrap(async (req, res) => {
  const book = db.prepare('SELECT id, title, author FROM books WHERE id = ?').get(Number(req.params.id));
  if (!book) return res.status(404).json({ error: 'Book not found' });
  const files = db.prepare('SELECT path FROM tracks WHERE book_id = ? ORDER BY idx').all(book.id)
    .map((t) => t.path)
    .filter((f) => fs.existsSync(f));
  if (!files.length) return res.status(404).json({ error: 'None of this book’s files are on disk.' });
  const names = uniqueNames(files);
  const entries = files.map((file, i) => ({
    name: names[i], path: file, size: fs.statSync(file).size,
  }));
  // a file name Windows and macOS will both accept
  const stem = [book.author, book.title].filter(Boolean).join(' - ')
    .replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || `book-${book.id}`;
  res.set({
    'Content-Type': 'application/zip',
    'Content-Length': String(zipLength(entries)),
    // both spellings: the plain one for old clients, the encoded one for accents
    'Content-Disposition': `attachment; filename="${stem.replace(/[^ -~]/g, '_')}.zip"; `
      + `filename*=UTF-8''${encodeURIComponent(stem)}.zip`,
    'Cache-Control': 'no-store',
  });
  await writeZipTo(res, entries);
}));

app.get('/api/stream/:trackId', (req, res) => {
  const track = db.prepare('SELECT path FROM tracks WHERE id = ?').get(Number(req.params.trackId));
  if (!track || !fs.existsSync(track.path)) return res.status(404).end();
  res.sendFile(track.path); // sendFile handles Range requests
});

// What a listener has done with one book, and the track they are on: the same
// four numbers `isFinished` asks for.
const keptOne = db.prepare(`SELECT p.done, p.track_idx, p.position,
    (SELECT COUNT(*) FROM tracks t WHERE t.book_id = p.book_id) AS tracks,
    (SELECT t.duration FROM tracks t WHERE t.book_id = p.book_id AND t.idx = p.track_idx) AS trackSeconds
  FROM progress p WHERE p.user = ? AND p.book_id = ?`);
const tickIt = db.prepare('UPDATE progress SET done = 1 WHERE user = ? AND book_id = ?');

app.post('/api/progress', (req, res) => {
  const { user, bookId, trackIdx, position } = req.body;
  if (!user) return res.status(400).json({ error: 'No user' });
  db.prepare(`INSERT INTO progress (user, book_id, track_idx, position, updated) VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user, book_id) DO UPDATE SET track_idx = excluded.track_idx,
      position = excluded.position, updated = excluded.updated`)
    .run(user, bookId, trackIdx, position);
  // A place at the end of the last track means the book has been listened to, so
  // the tick says so — whoever moved it there, the player or Home Assistant. It is
  // only ever set here: taking it off again is unticking it, or starting the book
  // over, both of which say so outright.
  const kept = keptOne.get(user, Number(bookId));
  if (kept && !kept.done && isFinished(kept)) tickIt.run(user, Number(bookId));
  res.json({ ok: true, done: !!(kept && (kept.done || isFinished(kept))) });
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
  // deep: the series hunt, which costs a request per result and two more besides
  res.json(await lookup(book, req.query.q, null, req.query.deep === '1'));
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

// a container that was already set up keeps pushing to Home Assistant on its own// Places that were already at the end of a last track before the tick was set
// for them: those books have been listened to, and every count and list reads the
// tick, so it has to say so.
for (const row of db.prepare(`SELECT p.user, p.book_id, p.track_idx, p.position, p.done,
      (SELECT COUNT(*) FROM tracks t WHERE t.book_id = p.book_id) AS tracks,
      (SELECT t.duration FROM tracks t WHERE t.book_id = p.book_id AND t.idx = p.track_idx) AS trackSeconds
    FROM progress p WHERE p.done = 0`).all()) {
  if (isFinished(row)) tickIt.run(row.user, row.book_id);
}

scheduleHaPush(VERSION);

const port = process.env.PORT || 8523;
app.listen(port, () => console.log(`My Audiobook Collection on :${port} (data: ${DATA_DIR})`));
