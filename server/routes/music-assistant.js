// The Music Assistant face of the app: the Audiobookshelf calls its provider
// makes. Out of index.js since 2.14.152, as it was written — it touches nothing
// else in the app, and index.js had grown to two thousand lines. Mounted where
// the block stood, so the routes keep their order.
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { db } from '../db.js';
import { sameSecret } from '../ha.js';
import { enabled as absEnabled, inboundToken as absToken, listener as absListener,
  loginResponse as absLogin, libraries as absLibraries, books as absBooks, book as absBook,
  minifiedItem as absMinified, expandedItem as absExpanded, user as absUser,
  progressOf as absProgress, writeProgressFromWhole as absWriteProgress,
  socketOpen as absSocketOpen, socketPoll as absSocketPoll, socketSay as absSocketSay,
  author as absAuthor, seriesWithProgress as absSeries, filteredBooks as absFiltered,
  playbackSession as absSession, openSession as absOpenSession,
  syncSession as absSyncSession, closeSession as absCloseSession,
  syncFromLocal as absSyncFromLocal } from '../abs.js';

export function mountMusicAssistant(app, { VERSION, sendCover }) {
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
    if (!sameSecret(String((req.body || {}).password || ''), absToken())) {
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
  // Served, not redirected to: a redirect carries neither the token in the query
  // nor a cookie, so Music Assistant followed it into the session gate and got a
  // shelf of blanks. `forMA` has already said who this is.
  app.get('/api/items/:id/cover', forMA, (req, res) => sendCover(req, res, req.params.id));

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
    res.json(absSession(b, req.listener, req, VERSION));
  });

  // A session by its id, and what happens to it while a book plays. The first of
  // these is the one that decides whether anything plays at all for a listener
  // signed in with a password: Music Assistant serves each part of the book
  // through an address of its own, and that address looks the session up here
  // before redirecting to the file.
  app.get('/api/session/:id', forMA, (req, res) => {
    const s = absOpenSession(req.params.id, req, VERSION, req.listener);
    if (!s) return res.status(404).end();
    res.json(s);
  });

  app.post('/api/session/:id/sync', forMA, (req, res) =>
    (absSyncSession(req.params.id, req.body, req.listener) ? res.json({}) : res.status(404).end()));

  app.post('/api/session/:id/close', forMA, (req, res) =>
    (absCloseSession(req.params.id, req.body, req.listener) ? res.json({}) : res.json({})));

  // Sessions a player kept while it was offline. This app has nothing to reconcile
  // — the position it is told is the position — so they are taken and answered.
  app.post('/api/session/local', forMA, (req, res) => {
    absSyncFromLocal(req.listener, req.body);
    res.json({});
  });
  app.post('/api/session/local-all', forMA, (req, res) => {
    for (const s of ((req.body || {}).sessions || [])) absSyncFromLocal(req.listener, s);
    res.json({});
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
    // The client sends this in three separate calls — isFinished on its own, then
    // a percentage, then the duration with the seconds — so only the one that
    // carries `isFinished` may decide the tick. Reading a missing field as false
    // would let the last of the three rub out a book the first had just finished.
    const tick = 'isFinished' in said ? said.isFinished === true : undefined;
    if (Number.isFinite(seconds)) {
      absWriteProgress(req.listener, b.id, seconds, tick);
    } else if (tick === true) {
      absWriteProgress(req.listener, b.id, b.duration || 0, true);
    } else if (tick === false) {
      // "not finished", with no position: take the tick off and leave the place
      absWriteProgress(req.listener, b.id, absProgress(req.listener, b)?.currentTime || 0, false);
    }
    res.json(absProgress(req.listener, b) || {});
  });
}
