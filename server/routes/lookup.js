// Looking a book up in Google Books, and writing what was chosen. Out of
// index.js since 2.14.152, as it was written, and mounted where it stood.
import { db } from '../db.js';
import { lookup, applyMetadata, writeProgress, lookupProgress, probeSeries } from '../google.js';
import { requireAdmin } from '../admin.js';
import { tagAllWorking } from '../tagall.js';
import { moveToGenre } from '../trash.js';

export function mountLookup(app, { wrap, ensureGenre }) {
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
}
