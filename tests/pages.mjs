// pages — the admin page's own logic, driven without a browser.
//
// Everything else here checks the server. The faults that have actually reached
// Frank were in the page: *Move…* that did nothing because the route it asked
// threw, Favourites with an empty Authors column, a book number dropped on save,
// a series head that named the wrong thing. Every one was found by hand, because
// the only thing that could drive a page was `plays-on`, which needs a browser
// and runs on one machine.
//
// So the page is loaded into jsdom with its scripts, and asked questions. Two
// things make that work and both are worth knowing:
//
//  * The scripts go in as real `<script>` elements, not `window.eval`. A classic
//    script's `const` lands in the window's lexical scope and the next script
//    sees it; an `eval` keeps it to itself, so `browse.js` would define `$` and
//    `app.js` would not find it.
//  * They are appended *after* the window is fitted with what jsdom has not got
//    — `showModal`, `scrollIntoView` — and with a `fetch` the test answers for.
//    The page's own `<script src>` tags are taken out of the HTML first, or they
//    would run before any of that was in place.
//
// Loading them is itself a check: two scripts declaring the same name is a
// SyntaxError that stops a page dead, and that shows up here as the page failing
// to load rather than as a grep over the source.
//
// Run: node tests/pages.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// jsdom is the one dev dependency this project has, and `--omit=dev` is what
// the image is built with. Said plainly, because the alternative is a module
// resolution trace in the middle of `npm test`.
let JSDOM; let VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = await import('jsdom'));
} catch {
  console.log('FAIL pages needs jsdom, which is a dev dependency: run `npm ci`, not `npm ci --omit=dev`.');
  process.exit(1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

let failed = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
};

// What a page asks for before it has been told anything. Only the routes whose
// shape the page relies on are here; anything else refuses, and the page's own
// `.catch(() => …)` supplies the empty shape — which is how it copes with a
// route that is off or a share that is not mounted, so it is also how it should
// cope here. A route that gains a caller with no fallback shows up as a fault
// rather than quietly passing on a `{}` that happens not to be read.
const EMPTY = {
  '/api/admin': { required: true, admin: true },
  '/api/account': { name: 'tester', admin: true, signedIn: true, required: true, level: {}, mayDownload: true },
  '/api/genres': [],
  '/api/genrefolders': { folders: [{ genre: 'Fantasy', path: '/audiobooks/Fantasy' }], suggestedParent: '' },
  '/api/authors': [],
  '/api/home': { continue: [], recent: [] },
  '/api/stats': { books: 0, files: 0, done: 0, todo: 0, version: 'test' },
  '/api/listened': { books: [] },
  '/api/favourites': [],
  '/api/untagged': [],
  '/api/settings': {},
};
const REFUSED = { __status: 404, error: 'not answered by this harness' };

// Which scripts a page loads, and in which order, is read off the page rather
// than listed here. A second copy of that list would be a thing to keep in step
// — and the order is the whole point: browse.js declares what the page script
// uses at its own top level, so a page that loaded them the other way round
// would be broken in the browser and fine here.
const scriptsOf = (html) => [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);

// A page's scripts run in this process, so a promise it never settles arrives
// here as an unhandled rejection — which by default takes the whole run down on
// the first one, reported as a node crash rather than as the page being at
// fault. They go to whichever page is open instead.
let faults = [];
process.on('unhandledRejection', (e) => faults.push(`unhandled: ${e && e.message || e}`));

// Opens a page and hands back its window. `replies` is consulted first, by the
// longest matching path, then EMPTY, then a refusal; a function is called with
// the URL so a test can answer differently per call.
async function open(page, replies = {}) {
  const broke = [];
  faults = broke;
  const console_ = new VirtualConsole();
  console_.on('jsdomError', (e) => broke.push(e.message));

  const source = fs.readFileSync(path.join(PUBLIC, page), 'utf8');
  const scripts = scriptsOf(source);
  const html = source.replace(/<script src="[^"]+"><\/script>/g, '');
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: 'http://localhost/', virtualConsole: console_,
  });
  const { window } = dom;

  const answerFor = (url) => {
    const where = String(url).split('?')[0];
    const all = { ...EMPTY, ...replies };
    const key = Object.keys(all).filter((k) => where === k || where.startsWith(`${k}/`))
      .sort((a, b) => b.length - a.length)[0];
    return key === undefined ? REFUSED : all[key];
  };
  window.fetch = async (url, opts) => {
    const answer = answerFor(url);
    const body = typeof answer === 'function' ? await answer(String(url), opts) : answer;
    if (body && body.__status) {
      return { ok: false, status: body.__status, json: async () => body, text: async () => JSON.stringify(body) };
    }
    return { ok: true, status: 200, json: async () => (body ?? {}), text: async () => JSON.stringify(body ?? {}) };
  };

  // what jsdom has not got, and these pages use
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  window.Element.prototype.scrollIntoView = function () {};
  window.confirm = () => true;
  // jsdom has no media playback, and `play()` there throws — which every caller
  // in the app catches, so "did it start playing?" cannot be asked of `paused`.
  // It is asked of this instead.
  window.HTMLMediaElement.prototype.play = function () {
    this.pressedPlay = (this.pressedPlay || 0) + 1;
    return Promise.resolve();
  };
  window.HTMLMediaElement.prototype.pause = function () {};
  // jsdom calls a fresh document `prerender`, and so `hidden`. A page somebody
  // is looking at says `visible`, and the code that picks a place back up when
  // the reader returns asks exactly that — left alone, every such check would
  // pass by never running.
  Object.defineProperty(window.document, 'visibilityState', { value: 'visible', configurable: true });
  Object.defineProperty(window.document, 'hidden', { value: false, configurable: true });

  for (const file of scripts) {
    const tag = window.document.createElement('script');
    tag.textContent = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
    window.document.body.appendChild(tag);
  }
  await new Promise((r) => setTimeout(r, 60));
  return { window, document: window.document, broke, scripts };
}

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

// Driving a handler that throws is the fault being looked for here, not a
// reason to stop — Move… did nothing on Frank's machine for exactly that. So a
// throw is a named failure and the rest of the suite still runs.
const drive = async (label, fn) => {
  try {
    await fn();
    return true;
  } catch (e) {
    failed++;
    console.log(`FAIL ${label}\n       threw ${e.message}`);
    return false;
  }
};

// --- both pages load at all -----------------------------------------------
// Which is the check that two scripts never declare the same name: one `const $`
// too many and the page is a SyntaxError, and nothing below this would run.
for (const [page, own] of [['index.html', 'app.js'], ['listen.html', 'shelf.js']]) {
  const { window, broke, scripts } = await open(page);
  check(`${page} loads its scripts without complaint`, broke, []);
  check(`${page} loads the shared half before its own`,
    scripts.indexOf('browse.js') < scripts.indexOf(own) && scripts.includes('browse.js'), true);
  check(`and they share one scope, so ${page} has both halves`,
    [window.eval('typeof $'), window.eval('typeof seriesRows'), window.eval('typeof drawBooks')],
    ['function', 'function', 'function']);
}
// The third page stands on its own — no browse.js, no player — so it only has to
// load and draw.
{
  const { broke } = await open('accounts.html');
  check('accounts.html loads its scripts without complaint', broke, []);
}

// --- Move… opens whatever the routes beside it say ------------------------
// `/api/import` refuses in every one of these, deliberately. Move… used to ask
// it for the list of genres, and that route throws when no import folder is set
// — and `moveBook` is an inline handler, so the throw went nowhere anybody would
// see and the button simply did nothing on an install that had never imported
// (2.9.8). Asking it again would fail here rather than on Frank's machine.
const NO_IMPORT = { __status: 400, error: 'No import folder set yet. Add one in Settings.' };

{
  const { window, document } = await open('index.html', {
    '/api/import': NO_IMPORT,
    '/api/books': {
      id: 7, title: 'A Book', author: 'An Author', genre: 'Fantasy', series: 'A Series',
      folderSeries: 'A Series', tracks: [{ id: 1 }], path: '/audiobooks/Fantasy/An Author/A Series/A Book',
    },
  });
  await drive('Move… runs to the end', () => window.moveBook(7));
  await settle();
  check('Move… opens', document.querySelector('#move').open, true);
  check('offering the genres the folders have',
    [...document.querySelectorAll('#mGenre option')].map((o) => o.textContent), ['Fantasy']);
  check('filled in from the book', [
    document.querySelector('#mAuthor').value,
    document.querySelector('#mSeries').value,
    document.querySelector('#mTitle').value,
  ], ['An Author', 'A Series', 'A Book']);
  check('and saying where the book would land',
    document.querySelector('#mWhere').textContent,
    'Moves to Fantasy / An Author / A Series / A Book');
}

// The genre list is worth having and not worth waiting on: the genre the book
// is already in is in the dropdown either way, and a move within a genre — most
// of them — still works with the folder list unavailable.
{
  const { window, document } = await open('index.html', {
    '/api/import': NO_IMPORT,
    '/api/genrefolders': { __status: 500, error: 'that share is not mounted' },
    '/api/books': {
      id: 7, title: 'A Book', author: 'An Author', genre: 'Fantasy',
      folderSeries: '', tracks: [{ id: 1 }],
    },
  });
  await drive('Move… runs to the end with no folder list', () => window.moveBook(7));
  await settle();
  check('Move… opens although the folder list refused', document.querySelector('#move').open, true);
  check('with the one genre it can be sure of',
    [...document.querySelectorAll('#mGenre option')].map((o) => o.textContent), ['Fantasy']);
}

// A book inside a part of a series cannot be written by a dialog of four
// folders, and is told so rather than quietly leaving its part (2.9.8).
{
  const { window, document } = await open('index.html', {
    '/api/import': NO_IMPORT,
    '/api/books': {
      id: 8, title: 'Book One', author: 'Jane Deep', genre: 'Fantasy', series: 'First Movement',
      parent_series: 'The Great Cycle', folderSeries: 'First Movement', tracks: [{ id: 1 }],
      path: '/audiobooks/Fantasy/Jane Deep/The Great Cycle/First Movement/Book One',
    },
  });
  await drive('Move… runs to the end for a book in a part', () => window.moveBook(8));
  await settle();
  check('a book in a part is told what a move would cost it',
    document.querySelector('#mWhere').textContent,
    'Moves to Fantasy / Jane Deep / First Movement / Book One'
      + ' — out of The Great Cycle / First Movement, which this cannot write');
}

// --- Favourites draws the authors beside the books ------------------------
// It shipped with none: the handler cleared `#authors ul` and never filled it,
// so the heading stood over nothing beside books that plainly had authors
// (2.7.64).
{
  const books = [
    { id: 1, title: 'One', author: 'Anne Author', genre: 'Fantasy', tracks: 1, duration: 60 },
    { id: 2, title: 'Two', author: 'Anne Author', genre: 'Fantasy', tracks: 1, duration: 60 },
    { id: 3, title: 'Three', author: 'Bert Bookman', genre: 'Fantasy', tracks: 1, duration: 60 },
  ];
  const { window, document } = await open('listen.html', { '/api/favourites': books });
  document.querySelector('#favList').click();
  await settle(140);
  check('Favourites lists the authors of what is hearted',
    [...document.querySelectorAll('#authors ul li')].map((li) => li.dataset.name),
    ['Anne Author', 'Bert Bookman']);
  check('with how many each',
    [...document.querySelectorAll('#authors ul li .count')].map((e) => e.textContent), ['2', '1']);
  check('and wires each one to a handler that exists',
    [window.eval('typeof favouritesOf'), typeof document.querySelector('#authors ul li')?.onclick],
    ['function', 'function']);
}

// --- a series published in parts, in the genre column ----------------------
{
  const { window } = await open('index.html');
  const rows = window.eval(`seriesRows({ name: 'Fantasy', series: [
      { name: 'A Plain Series', parent: '', books: 2 },
      { name: 'First Movement', parent: 'The Great Cycle', books: 3 },
      { name: 'Second Movement', parent: 'The Great Cycle', books: 1 } ] })`);
  const dom = new JSDOM(`<ul>${rows}</ul>`);
  const shown = [...dom.window.document.querySelectorAll('li')].map((li) => [
    li.className.replace('series-in-genre', '').trim(),
    li.dataset.whole || li.dataset.series,
  ]);
  check('a parent is a row, with its parts indented under it, and the plain one apart', shown, [
    ['is-parent', 'The Great Cycle'],
    ['in-part', 'First Movement'],
    ['in-part', 'Second Movement'],
    ['', 'A Plain Series'],
  ]);
}

// --- Needs tags hands you the book ----------------------------------------
{
  const { window, document } = await open('index.html', {
    '/api/untagged': [{
      id: 5, title: 'A Book', author: 'An Author', genre: 'Fantasy',
      fixable: ['album'], needsLookup: [],
    }],
  });
  document.querySelector('#needsTags').click();
  await settle(140);
  const buttons = [...document.querySelectorAll('#books .fix button')].map((b) => b.textContent.trim());
  check('a row offers the book itself as well as the two things to do to it',
    buttons, ['Write into MP3s', 'Find metadata', 'Show the book']);
  check('and the button hands over an id and nothing else',
    document.querySelector('#books .fix button[onclick^="showUntagged"]')?.getAttribute('onclick'),
    'showUntagged(5)');
  check('which the page knows how to answer', typeof window.showUntagged, 'function');
}

// --- the two halves app.js was split into ---------------------------------
// `maint.js` and `edit.js` came out of a 2402-line `app.js` in 2.10.24, and the
// seam is the thing worth checking: each calls into `app.js` at the moment a
// button is pressed — `fileWork`, `backToView`, `state`, `toClipboard` — and
// `app.js` reaches back only through `editMeta` and `findMeta`, which are also
// reached from a button. A name left behind on the wrong side of that line is a
// handler that throws on the first click and nowhere else.

// maint.js: a maintenance list draws its rows, and the actions on them
{
  const { document } = await open('index.html', {
    '/api/trash': {
      keepDays: 30,
      items: [
        { id: 1, title: 'Gone One', genre: 'Fantasy', author: 'An Author', files: 3, onDisk: true, daysLeft: 12, deleted_at: '2026-10-01T09:30:00Z' },
        { id: 2, title: 'Gone Two', genre: 'Fantasy', author: 'An Author', files: 1, onDisk: false, daysLeft: 0, deleted_at: '2026-09-02T11:00:00Z' },
      ],
    },
  });
  document.querySelector('#trashList').click();
  await settle(140);
  check('the trash lists what is in it',
    [...document.querySelectorAll('#books .fix strong')].map((e) => e.textContent), ['Gone One', 'Gone Two']);
  check('and says how long each has',
    /12 day\(s\) left/.test(document.querySelector('#books .list').textContent), true);
  check('a book whose files are already gone cannot be put back, only dropped',
    [...document.querySelectorAll('#books .fix')].map((f) => [...f.querySelectorAll('.actions button')]
      .map((b) => b.textContent.trim())),
    [['Put back', 'Delete now'], ['Delete now']]);
  check('and emptying it is offered with the count on it',
    document.querySelector('#emptyTrash')?.textContent, 'Empty trash (2)');
}

// edit.js: the dialog opens filled from the book
{
  const { window, document } = await open('index.html', {
    '/api/books': {
      id: 9, title: 'A Book', author: 'An Author', genre: 'Fantasy', series: 'A Series',
      folderSeries: 'A Series', series_no: 3, narrator: 'A Narrator', year: '1998',
      description: 'What it is about.', path: '/audiobooks/Fantasy/An Author/A Series/A Book',
      tracks: [{ id: 1 }, { id: 2 }],
    },
  });
  await drive('Edit runs to the end', () => window.editMeta(9));
  await settle();
  check('Edit opens', document.querySelector('#edit').open, true);
  check('filled in from the book', [
    document.querySelector('#eTitle').value, document.querySelector('#eAuthor').value,
    document.querySelector('#eSeries').value, document.querySelector('#eSeriesNo').value,
    document.querySelector('#eNarrator').value, document.querySelector('#eYear').value,
  ], ['A Book', 'An Author', 'A Series', '3', 'A Narrator', '1998']);
  check('and saying where it lives and what it is made of',
    document.querySelector('#ePath').textContent,
    '/audiobooks/Fantasy/An Author/A Series/A Book · 2 files');
  // The number the sub-series work dropped on save: a result that names none
  // must leave the one the book has, rather than clearing the field (2.9.56).
  await drive('Edit runs to the end over a result', () => window.editMeta(9, { title: 'From Google' }));
  await settle();
  check('a lookup result that names no number leaves the book its own',
    [document.querySelector('#eTitle').value, document.querySelector('#eSeriesNo').value],
    ['From Google', '3']);
}

// --- a row on the page of accounts ----------------------------------------
// Two of these are faults Frank reported on one screen. His own row read "no
// password yet" beside a name he types a password for every week, and *May
// download* turned off did not stop him downloading — both because the
// administrator's name can also be a listener row, and the page drew it as an
// ordinary one. And "Last here" had never carried a date at all: the row knew
// when, said "12 days ago", and threw the rest away.
{
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
  const base = {
    state: 'approved', level: { name: 'Rookie Level', icon: '', at: 10, next: { at: 20, name: 'Listener Level' } },
    started: 5, finished: 4, completed: 1, hours: 3.2, favourites: 2, downloads: [],
    listening: [], signedIn: 1, reason: '', knowsAdmin: false, requestedAt: '', decidedAt: '',
  };
  const { document } = await open('accounts.html', {
    '/api/accounts': {
      accounts: [
        { ...base, name: 'FrankyB', isAdmin: true, hasPassword: false, lastSeen: day(0), daysAgo: 0, granted: true },
        { ...base, name: 'Donna', isAdmin: false, hasPassword: true, lastSeen: day(12), daysAgo: 12, granted: false,
          listening: [{ title: 'Abyss', author: 'Troy Denning', percent: 1, hours: 0.2, updated: day(1), via: 'music-assistant' }] },
        { ...base, name: 'Newcomer', isAdmin: false, hasPassword: false, lastSeen: '', daysAgo: null,
          listening: [{ title: 'A Book', author: 'An Author', percent: 40, hours: 2, updated: day(1), via: 'page' }] },
      ],
    },
  });
  await settle(160);
  const rowOf = (name) => document.querySelector(`.account[data-name="${name}"]`);
  check('the administrator is named as one', rowOf('FrankyB')?.querySelector('.badge')?.textContent, 'administrator');
  check('and is not told they have no password',
    /no password yet/.test(rowOf('FrankyB').textContent), false);
  check('a listener who has never signed in still is',
    rowOf('Newcomer').querySelector('.badge.untagged')?.textContent, 'no password yet');
  // One tick on the administrator's row, and it is the one that reaches them.
  // *May listen* does not: they sign in with the container's password, which no
  // tick here can take away. *May download* does, because downloading is a thing
  // a row on this page allows — turned off on his own row, Frank went on
  // downloading, and that is now a refusal.
  check('the administrator’s row offers the one tick that governs them',
    [...rowOf('FrankyB').querySelectorAll('.allowed input')]
      .map((i) => Object.keys(i.dataset)), [['mayDownload']]);
  check('and it is drawn from what that row says, rather than always the same way',
    [rowOf('FrankyB').querySelector('.allowed input').checked,
      rowOf('Donna').querySelector('input[data-may-download]').checked], [true, false]);
  check('and are on a listener’s',
    [...rowOf('Donna').querySelectorAll('.allowed input')].map((i) => i.dataset.mayListen !== undefined
      || i.dataset.mayDownload !== undefined), [true, true]);
  // Where a kept place came from. Frank had a book on his own Continue
  // listening that somebody else was listening to — correctly under his name,
  // because a player signs in as one listener and writes every position against
  // that name — and nothing on the page said so.
  check('a place a player kept is named as theirs',
    /↷ Music Assistant/.test(rowOf('Donna').textContent), true);
  check('and one kept by the page is not labelled at all, since that is the usual case',
    /↷/.test(rowOf('Newcomer').textContent), false);

  // the date, which is the thing that was missing
  check('Last here carries the date, not only how long ago',
    /Last here: 12 days ago · \d/.test(rowOf('Donna').textContent), true);
  check('and the hour for somebody who was here today',
    /Last here: here today at \d\d?:\d\d/.test(rowOf('FrankyB').textContent), true);
  check('while never is still never',
    /Last here: never signed in/.test(rowOf('Newcomer').textContent), true);
}

// --- coming back after listening somewhere else ---------------------------
// A place is kept on the server, so listening on a phone moves it for every
// page — and nothing here ever read it again. A desktop left open showed where
// you were when you opened it, however long ago that was.
//
// And `playBook` short-circuits for the book already in the bar, playing from
// this tab's own `currentTime` and writing that back: a desktop open and paused
// would overwrite the place the phone had moved on. So the place is picked up
// when the page comes back, before a press can act on the stale one.
{
  const BOOK = {
    id: 4, title: 'A Book', author: 'An Author', genre: 'Fantasy', coverV: 0,
    tracks: [{ id: 41, idx: 0, title: 'One', duration: 600 },
      { id: 42, idx: 1, title: 'Two', duration: 600 },
      { id: 43, idx: 2, title: 'Three', duration: 600 }],
  };
  const openAt = async (progress) => {
    const page = await open('listen.html', {
      '/api/books': { ...BOOK, progress },
    });
    page.window.eval('state.user = "tester"; state.book = null;');
    return page;
  };

  // the bar holding track 1, paused, while the phone has moved on to track 3
  {
    const { window, document } = await openAt({ track_idx: 2, position: 30, done: 0 });
    window.eval(`state.book = ${JSON.stringify(BOOK)}; state.track = 0;`);
    await window.placeMayHaveMoved();
    await settle();
    check('the place moved elsewhere is picked up',
      [window.eval('state.track'), document.querySelector('#pTrack').textContent],
      [2, '3/3 · Three']);
    check('and it is not started playing — coming back to a page is not a press',
      document.querySelector('#audio').pressedPlay, undefined);
  }

  // the same place, said twice: this tab wrote it a moment ago
  {
    const { window } = await openAt({ track_idx: 0, position: 0, done: 0 });
    window.eval(`state.book = ${JSON.stringify(BOOK)}; state.track = 0;`);
    const before = window.eval('document.querySelector("#audio").src');
    await window.placeMayHaveMoved();
    await settle();
    check('a place that has not moved is left alone, so this does not fight the player',
      [window.eval('state.track'), window.eval('document.querySelector("#audio").src')], [0, before]);
  }

  // this tab is the one playing: it is the one moving the place, and taking the
  // server's would drag it backwards under the listener
  {
    const { window, document } = await openAt({ track_idx: 2, position: 30, done: 0 });
    window.eval(`state.book = ${JSON.stringify(BOOK)}; state.track = 0;`);
    Object.defineProperty(document.querySelector('#audio'), 'paused', { value: false });
    await window.placeMayHaveMoved();
    await settle();
    check('a tab that is playing keeps its own place, rather than being dragged back',
      window.eval('state.track'), 0);
  }

  // nothing in the bar at all
  {
    const { window } = await openAt({ track_idx: 2, position: 30, done: 0 });
    await window.placeMayHaveMoved();
    await settle();
    check('and with no book in the bar there is nothing to pick up',
      window.eval('state.book'), null);
  }

  // the shelves, which is what is actually on screen when somebody comes back
  {
    const { window, document } = await open('listen.html', {
      '/api/home': { continue: [{ id: 4, title: 'A Book', author: 'An Author', genre: 'Fantasy', tracks: 3, track_idx: 0, duration: 1800, percent: 5 }], recent: [] },
    });
    await settle(140);
    check('the Continue listening shelf is marked, so a refresh can tell it is on screen',
      !!document.querySelector('[data-shelf="Continue listening"]'), true);
    window.eval('window.loadHome = () => { window.askedAgain = (window.askedAgain || 0) + 1; };');
    // A page that has just loaded gets a focus of its own, and that is not a
    // return. Nothing happens until it has actually been away.
    window.dispatchEvent(new window.Event('focus'));
    await settle();
    check('a page that has only just loaded is not "coming back"',
      window.eval('window.askedAgain || 0'), 0);

    window.dispatchEvent(new window.Event('blur'));
    window.dispatchEvent(new window.Event('focus'));
    await settle();
    check('and coming back to the page asks for the shelves again',
      window.eval('window.askedAgain || 0'), 1);
    // twice in a moment is one return: these two events fire together as often
    // as not, and two redraws of the same thing is a flicker
    window.dispatchEvent(new window.Event('focus'));
    await settle();
    check('but twice in a moment is still one return', window.eval('window.askedAgain || 0'), 1);
  }
}

console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
