// pages — the admin page's own logic, driven without a browser.
//
// Everything else here checks the server. The faults that have actually reached
// The owner were in the page: *Move…* that did nothing because the route it asked
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
// **Ask `broke` wherever a page is driven, not only where it is loaded.** The
// accounts page threw while wiring its rows for two weeks — the administrator's
// row has no *May listen* and the loop took it without looking, so `forEach`
// stopped there and every row after it was drawn with nothing wired. The
// harness collected that error every single run. Nothing read it, because these
// checks looked at the markup and markup was exactly what was right: the Delete
// buttons were all there, and none of them did anything.
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
async function open(page, replies = {}, before = null) {
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
  // jsdom has no `matchMedia`, and the player asks it whether this is a phone
  // — the cover is the way to `/player` there and play/pause everywhere else.
  // Answered "not a phone" by default; a check that is about the phone sets it.
  window.matchMedia = (query) => ({
    matches: !!window.__phone, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent: () => false,
  });
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

  // A hook for what the tab already held when the page opened — a carried book,
  // a remembered name. It has to run before the scripts do, because what those
  // scripts do *at load* is the thing some of these checks are about.
  if (before) before(window);

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
// reason to stop — Move… did nothing on the owner's machine for exactly that. So a
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

// --- and the player bar is written out twice, so it must stay one bar -------
// Both pages carry their own copy of that footer. One stylesheet and one
// `player.js` serve both, so a control added, renamed or rewrapped on one page
// and not the other is a bar that works here and not there — and the page that
// was missed is whichever one nobody opened. Nothing else compares them.
//
// `plays-on` is where the phone layout itself is checked, because that needs a
// browser with a layout engine; this is the half that needs only the markup.
{
  const [a, b] = await Promise.all([open('index.html'), open('listen.html')]);
  const bar = (d) => {
    const f = d.querySelector('#player');
    return {
      // the cover is a play button, so it is wrapped to carry the glyph
      wrapped: !!f.querySelector('.cover > #pCover'),
      // the one control in the bar that writes a file to the device says so
      download: f.querySelector('#pGet').textContent.replace(/\s+/g, ' ').trim(),
      // and every control is present and in one order
      controls: [...f.children].map((e) => e.id || e.className).filter(Boolean).join(','),
    };
  };
  const [one, two] = [bar(a.document), bar(b.document)];
  check('the player bar is the same on both pages, control for control', one, two);
  // How fast it is read: eleven steps, 1.0 to 2.0, and nothing below 1 — a
  // book read slower than it was recorded is a book read wrong.
  check('and the speed offers 1.0 to 2.0 in tenths, on both',
    [[...a.document.querySelectorAll('#pSpeed option')].map((o) => o.value),
      [...b.document.querySelectorAll('#pSpeed option')].map((o) => o.value)],
    [['1.0', '1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '1.7', '1.8', '1.9', '2.0'],
      ['1.0', '1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '1.7', '1.8', '1.9', '2.0']]);
  check('the cover is wrapped so it can say what a tap will do',
    [one.wrapped, two.wrapped], [true, true]);
  check('and the download says what it is, not only an arrow',
    [/Download/.test(one.download), /Download/.test(two.download)], [true, true]);
}

// --- Move… opens whatever the routes beside it say ------------------------
// `/api/import` refuses in every one of these, deliberately. Move… used to ask
// it for the list of genres, and that route throws when no import folder is set
// — and `moveBook` is an inline handler, so the throw went nowhere anybody would
// see and the button simply did nothing on an install that had never imported
// (2.9.8). Asking it again would fail here rather than on the owner's machine.
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
// Two of these are faults the owner reported on one screen. His own row read "no
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
    requests: { asked: 3, open: 1, filled: 1, declined: 1 },
  };
  const { document, broke } = await open('accounts.html', {
    '/api/accounts': {
      accounts: [
        { ...base, name: 'MorganB', isAdmin: true, hasPassword: false, lastSeen: day(0), daysAgo: 0, granted: true },
        { ...base, name: 'Donna', isAdmin: false, hasPassword: true, lastSeen: day(12), daysAgo: 12, granted: false,
          listening: [{ title: 'Abyss', author: 'Troy Denning', percent: 1, hours: 0.2, updated: day(1), via: 'music-assistant' }] },
        { ...base, requests: undefined, name: 'Newcomer', isAdmin: false, hasPassword: false, lastSeen: '', daysAgo: null,
          listening: [{ title: 'A Book', author: 'An Author', percent: 40, hours: 2, updated: day(1), via: 'page' }] },
      ],
    },
  });
  await settle(160);
  const rowOf = (name) => document.querySelector(`.account[data-name="${name}"]`);

  // Drawing the rows is half of it; the other half is the loop that hangs a
  // handler on every tick and button, and that loop threw. The administrator's
  // row has no *May listen* and no *Delete…*, and it took both without looking —
  // so `forEach` stopped there and every row after it was drawn with nothing
  // wired. The owner could not delete anybody.
  //
  // The page was saying so all along. These checks read the markup and never
  // asked whether anything had thrown, which is the whole reason the harness
  // collects it.
  check('wiring the rows throws nothing, however short a row is', broke, []);
  check('and every listener row can actually be deleted',
    ['Donna', 'Newcomer'].map((n) => typeof rowOf(n).querySelector('[data-drop]').onclick),
    ['function', 'function']);
  check('and their ticks are wired too, not just drawn',
    ['Donna', 'Newcomer'].flatMap((n) => [
      typeof rowOf(n).querySelector('[data-may-listen]').onchange,
      typeof rowOf(n).querySelector('[data-may-download]').onchange]),
    ['function', 'function', 'function', 'function']);
  check('the administrator’s own tick works as well, being the one it has',
    typeof rowOf('MorganB').querySelector('[data-may-download]').onchange, 'function');
  check('and the administrator has no Delete, which would not close that door anyway',
    rowOf('MorganB').querySelector('[data-drop]'), null);

  check('the administrator is named as one', rowOf('MorganB')?.querySelector('.badge')?.textContent, 'administrator');
  check('and is not told they have no password',
    /no password yet/.test(rowOf('MorganB').textContent), false);
  check('a listener who has never signed in still is',
    rowOf('Newcomer').querySelector('.badge.untagged')?.textContent, 'no password yet');
  // One tick on the administrator's row, and it is the one that reaches them.
  // *May listen* does not: that tick governs signing in and the administrator
  // does not come in that way, whichever of the two passwords is theirs. *May
  // download* does, because downloading is a thing a row on this page allows —
  // turned off on his own row, the owner went on downloading, and that is now a
  // refusal.
  check('the administrator’s row offers the one tick that governs them',
    [...rowOf('MorganB').querySelectorAll('.allowed input')]
      .map((i) => Object.keys(i.dataset)), [['mayDownload']]);
  check('and it is drawn from what that row says, rather than always the same way',
    [rowOf('MorganB').querySelector('.allowed input').checked,
      rowOf('Donna').querySelector('input[data-may-download]').checked], [true, false]);
  check('and are on a listener’s',
    [...rowOf('Donna').querySelectorAll('.allowed input')].map((i) => i.dataset.mayListen !== undefined
      || i.dataset.mayDownload !== undefined), [true, true]);
  // Where a kept place came from. The owner had a book on his own Continue
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
    /Last here: here today at \d\d?:\d\d/.test(rowOf('MorganB').textContent), true);
  check('while never is still never',
    /Last here: never signed in/.test(rowOf('Newcomer').textContent), true);

  // What they have asked for, beside what they have listened to. The number is
  // what they asked for; the line under it is what became of it, because nine
  // asked and one found is a different person to talk to than one and one.
  check('a row says what that person has asked for, and how it went',
    [/3\s*requested/.test(rowOf('MorganB').textContent.replace(/\s+/g, ' ')),
      /1 waiting · 1 here · 1 no/.test(rowOf('MorganB').textContent.replace(/\s+/g, ' '))],
    [true, true]);
  // An answer without it — an older server, a route that forgets — must not
  // take the page down. The loop that wires every row stops on a throw, and
  // every row after it is drawn with dead buttons; that has happened here once
  // already, over a different missing field.
  check('and an answer that does not carry them draws anyway, rather than nothing',
    [/0\s*requested/.test(rowOf('Newcomer').textContent.replace(/\s+/g, ' ')), broke], [true, []]);
}

// --- and which of the two administrators it is ----------------------------
// This page told everybody that the administrator signs in "with the name and
// password the container was given". Since 2.12.0 that is one of two answers:
// an administrator who made their account at the gate on first run signs in
// with a password kept here, hashed, and the container has nothing to do with
// it. Being told otherwise sends them to edit a variable that is not what let
// them in, and leaves out the one thing they would want — that setting it is
// the way back in if they forget.
//
// Three places said it: the badge, the line under *May download*, and the
// sentence at the top naming who you are. The server is the only thing that
// knows which, so it says, and all three read that one answer.
{
  const asAdmin = async (adminFrom) => {
    const page = await open('accounts.html', {
      '/api/accounts': {
        admin: 'MorganB',
        ...(adminFrom ? { adminFrom } : {}),
        accounts: [{
          name: 'MorganB', isAdmin: true, hasPassword: false, state: 'approved', granted: true,
          level: { name: 'Rookie Level', icon: '', at: 10, next: null },
          started: 1, finished: 1, completed: 1, hours: 1, favourites: 0, downloads: [],
          listening: [], signedIn: 1, reason: '', knowsAdmin: false, requestedAt: '', decidedAt: '',
          lastSeen: new Date().toISOString(), daysAgo: 0,
        }],
      },
    });
    await settle(160);
    const row = page.document.querySelector('.account[data-name="MorganB"]');
    return {
      badge: row.querySelector('.badge').title,
      beside: row.querySelector('.allowed .sub').textContent,
      top: page.document.querySelector('#whoRuns').textContent,
      broke: page.broke,
    };
  };

  {
    const { badge, beside, top, broke } = await asAdmin('stored');
    check('an administrator made at the gate is told where that password really is',
      [/kept here, hashed/.test(badge), /first opened/.test(badge)], [true, true]);
    check('and told that the container overrides it, which is the way back in',
      [/ADMIN_USER/.test(badge), /way back in/.test(badge)], [true, true]);
    check('and is not sent to a container variable as the thing they signed in with',
      /sign in with ADMIN_USER/.test(badge), false);
    check('the line beside May download follows the same answer',
      [/first opened/.test(beside), /container/.test(beside)], [true, false]);
    check('and so does the sentence naming who you are',
      /from the account made when this app was first opened/.test(top), true);
    check('with nothing thrown drawing any of it', broke, []);
  }
  {
    const { badge, beside, top } = await asAdmin('env');
    check('an administrator set on the container is still told exactly that',
      [/ADMIN_USER and ADMIN_PASSWORD/.test(badge), /set on the container/.test(badge),
        /first opened/.test(badge)], [true, true, false]);
    check('and the other two lines agree with it',
      [/container/.test(beside), /from the container/.test(top)], [true, true]);
  }
  {
    // An older server does not send it. Falling back to the container reading is
    // the safe half: it is what every install was until 2.12.0.
    const { badge } = await asAdmin('');
    check('and an answer that does not say which falls back to the container',
      /set on the container/.test(badge), true);
  }
  {
    // Neither version may claim this any more. *May download* reaches the
    // administrator, and the tick beside it says so — a badge still saying every
    // check lets them through would be the page contradicting itself.
    const said = await Promise.all(['stored', 'env'].map(asAdmin));
    check('and neither says every check lets them through, since one does not',
      said.map((s) => /every check/.test(s.badge)), [false, false]);
  }
}

// --- the maintenance column shows only what is waiting --------------------
// A row there is a job to be done. Nine of them reading 0 say only that the
// column is long: The owner had one number that mattered — 68 series to complete —
// among eight noughts. A row with nothing in it is not drawn.
//
// Import does not follow the rule: it is not a count of work, it reads "–" until
// an import folder is set, and it is the way to set one. Nor does a row that is
// the view on screen, whatever its count — emptying the trash from inside the
// trash must not pull the list out from under the reader.
{
  const shown = (document) => [...document.querySelectorAll('#maintRows li')]
    .filter((li) => !li.hidden).map((li) => li.id);

  // nothing waiting anywhere
  {
    const { document } = await open('index.html');
    await settle(160);
    check('with nothing waiting, only Import is there',
      shown(document), ['importList']);
    check('and it still says what it says when no folder is set',
      document.querySelector('#importCount').textContent, '–');
  }

  // some of them with something in them
  {
    const { document } = await open('index.html', {
      '/api/untagged': [{ id: 1, title: 'A', author: 'B', genre: 'C', fixable: ['album'], needsLookup: [] }],
      '/api/trash': { keepDays: 30, items: [{ id: 1, title: 'A', genre: 'C', author: 'B', files: 1, onDisk: true, daysLeft: 9, deleted_at: '2026-10-01T09:00:00Z' }] },
    });
    await settle(200);
    check('a row with something waiting is drawn, and the empty ones are not',
      shown(document), ['needsTags', 'importList', 'trashList']);
    check('and each says how much',
      [document.querySelector('#needsTagsCount').textContent,
        document.querySelector('#trashCount').textContent], ['1', '1']);
  }

  // the row you are standing in, emptied
  {
    const { window, document } = await open('index.html', {
      '/api/trash': { keepDays: 30, items: [{ id: 1, title: 'A', genre: 'C', author: 'B', files: 1, onDisk: true, daysLeft: 9, deleted_at: '2026-10-01T09:00:00Z' }] },
    });
    await settle(200);
    document.querySelector('#trashList').click();
    await settle(140);
    check('the trash is open and on screen',
      document.querySelector('#trashList').classList.contains('active'), true);
    window.eval("counts('trashList', 0)");
    check('and emptying it does not take the row away while you are in it',
      [document.querySelector('#trashList').hidden,
        document.querySelector('#trashCount').textContent], [false, '0']);
    document.querySelector('#trashList').classList.remove('active');
    window.eval("counts('trashList', 0)");
    check('it goes once you have gone somewhere else',
      document.querySelector('#trashList').hidden, true);
  }
}

// --- deleting an account, all the way through ----------------------------
// The check above says the button has a handler. This says the handler reaches
// the server, because "it has an onclick" and "pressing it deletes somebody" are
// not the same claim, and it was the second one the owner was missing.
{
  const asked = [];
  const row = (name, isAdmin) => ({
    name, isAdmin, hasPassword: true, granted: false, state: 'approved',
    level: { name: 'Rookie Level', icon: '', at: 10, next: null },
    started: 0, finished: 0, completed: 0, hours: 0, favourites: 0, downloads: [],
    listening: [], signedIn: 0, reason: '', knowsAdmin: false, requestedAt: '',
    decidedAt: '', lastSeen: '', daysAgo: null,
  });
  const { document } = await open('accounts.html', {
    '/api/accounts': (url, opts) => {
      if (opts && opts.method === 'POST') { asked.push(url); return { ok: true }; }
      // The administrator first on purpose: the row that used to stop the loop
      // has to be the one every other row is drawn after.
      return { accounts: [row('MorganB', true), row('Jonah', false)] };
    },
  });
  await settle(160);
  document.querySelector('.account[data-name="Jonah"] [data-drop]').click();
  await settle(140);
  check('pressing Delete on a listener really asks the server to remove them',
    asked.filter((u) => u.endsWith('/remove')), ['/api/accounts/Jonah/remove']);
}

// --- what Series to complete shows ---------------------------------------
// Every missing volume used to be a full card: a drawn cover, a heading, the
// author, badges, a sentence of explanation and three buttons. The owner had
// sixty-eight series short of something, which is several hundred cards — a page
// nobody scrolls, to answer *which books am I missing?*. The series keeps the
// heading; what is missing from it is a list of lines.
{
  const asked = [];
  const { window, document } = await open('index.html', {
    '/api/authors': [{ name: 'Brandon Sanderson', books: 2 }, { name: 'Stephen King', books: 5 }],
    '/api/books': (url) => {
      asked.push(url);
      return { books: [{ id: 9, title: 'The Way of Kings', author: 'Brandon Sanderson', genre: 'Fantasy',
        series: 'The Stormlight Archive', series_no: 1, duration: 60, tracks: 1 }], series: [] };
    },
  });
  await settle();

  // Two shapes feed this pane. A hole in the collection's own numbering knows a
  // number and no title; Wikidata knows both.
  const gaps = {
    looked: 2,
    gaps: [{
      genre: 'Fantasy', name: 'The Dark Tower', author: 'Stephen King',
      missing: [1, 3, 4], highest: 5, unnumbered: 0, says: 'Missing: book 1, 3 and 4.',
    }],
    unnumbered: [],
  };
  const online = {
    total: 1, lastAt: '2026-10-14T10:00:00Z',
    series: [{
      found: true, genre: 'Fantasy', name: 'The Stormlight Archive', author: 'Brandon Sanderson',
      label: 'The Stormlight Archive', description: 'a series', url: 'https://www.wikidata.org/wiki/Q1',
      volumes: [1, 2, 3, 4, 5], missing: [2, 4],
      titles: [{ no: 2, title: 'Words of Radiance' }, { no: 4, title: 'Rhythm of War' }],
    }],
  };
  window.eval(`drawSeriesBoth(${JSON.stringify(gaps)}, ${JSON.stringify(online)})`);
  await settle(120);

  check('a missing volume is a line, not a card',
    [document.querySelectorAll('#books .card').length,
      document.querySelectorAll('#books .missing-vol').length], [0, 5]);
  check('and the series is what carries the heading',
    [...document.querySelectorAll('#books .series-head')].map((h) => h.textContent.replace(/\s+/g, ' ').trim())
      .filter((t) => t.startsWith('Series')),
    ['Series · The Dark Tower ⧉ copy',
      'Series · The Stormlight Archive ⧉ copy']);

  // The series' name is the way to it, in both kinds of head: the genre, the
  // series selected under it, the author marked beside it, and its books.
  // The owner asked for it; it was an "open in library" on the first kind only.
  check('the name of every series short of something is a way to it',
    [...document.querySelectorAll('#books .series-head .open-series')]
      .map((b) => [b.textContent, b.dataset.genre, b.dataset.series, b.dataset.author]),
    [['The Dark Tower', 'Fantasy', 'The Dark Tower', 'Stephen King'],
      ['The Stormlight Archive', 'Fantasy', 'The Stormlight Archive', 'Brandon Sanderson']]);

  const lines = (series) => [...document.querySelectorAll('#books .missing-vols')]
    .map((ul) => [...ul.querySelectorAll('.missing-vol')].map((li) => [
      li.querySelector('.no').textContent, li.querySelector('.what').textContent]))[series];
  check('a hole in your own numbering lists the numbers, which is all it knows',
    lines(0), [['1', 'title unknown'], ['3', 'title unknown'], ['4', 'title unknown']]);
  check('and one Wikidata knows about lists the titles too',
    lines(1), [['2', 'Words of Radiance'], ['4', 'Rhythm of War']]);

  // What you do next with a line you cannot play.
  check('every line can be copied, as author - thing',
    [...document.querySelectorAll('#books .missing-vol .copy-search')].map((b) => b.dataset.copyText),
    ['Stephen King - The Dark Tower 1', 'Stephen King - The Dark Tower 3',
      'Stephen King - The Dark Tower 4',
      'Brandon Sanderson - Words of Radiance', 'Brandon Sanderson - Rhythm of War'],
  );
  check('a title can be looked up, and a bare number has nothing to look up',
    [...document.querySelectorAll('#books .missing-vols')]
      .map((ul) => ul.querySelectorAll('a[href*="wikipedia"]').length), [0, 2]);
  check('and the Wikidata entry is named once for the series, not once per volume',
    document.querySelectorAll('#books a[href*="wikidata"]').length, 1);

  // and pressing one goes there: wired, not merely drawn
  [...document.querySelectorAll('#books .series-head .open-series')]
    .find((b) => b.dataset.series === 'The Stormlight Archive')?.click();
  await settle(150);
  check('pressing a series name opens that series, in its genre',
    [window.eval('state.genre'), window.eval('state.series'),
      asked.some((u) => /series=The%20Stormlight%20Archive/.test(u))],
    ['Fantasy', 'The Stormlight Archive', true]);
  check('with its author marked beside it, and its books on screen',
    [[...document.querySelectorAll('#authors li.active')].map((l) => l.dataset.name),
      [...document.querySelectorAll('#books .card h3')].map((h) => h.textContent.replace(/[♫\s]+/g, ' ').trim())],
    [['Brandon Sanderson'], ['The Way of Kings']]);
}

// --- is there a newer version --------------------------------------------
// The line of numbers under every page says which version is answering, which
// tells you whether this is the new one only if you already knew what the new
// one was. Settings says it outright — and offers to install it exactly where
// that can work, which is an LXC install and nowhere else.
{
  const settings = async (update) => {
    const page = await open('index.html', { '/api/update': update });
    await settle();
    page.window.eval('loadUpdate(false)');
    await settle(120);
    return page.document;
  };

  {
    const d = await settings({ running: '2.11.64', newest: '2.11.64', behind: false, how: 'lxc', canInstall: true });
    check('on the newest version it says so, and offers nothing to do',
      [/the newest there is/.test(d.querySelector('#updateState').textContent),
        d.querySelector('#updateNow').hidden], [true, true]);
  }
  {
    const d = await settings({ running: '2.11.64', newest: '2.11.72', behind: true, how: 'lxc', canInstall: true });
    check('behind, it names both versions',
      d.querySelector('#updateState').textContent, 'Running v2.11.64 — v2.11.72 is out.');
    check('and an LXC install is offered the button',
      [d.querySelector('#updateNow').hidden,
        /stops the app for a moment/.test(d.querySelector('#updateHow').textContent)], [false, true]);
  }
  {
    const d = await settings({ running: '2.11.64', newest: '2.11.72', behind: true, how: 'image', canInstall: false });
    check('the image is told to pull a new one, and offered no button it cannot honour',
      [d.querySelector('#updateNow').hidden,
        /pulling a new one/.test(d.querySelector('#updateHow').textContent)], [true, true]);
  }
  {
    const d = await settings({ running: '2.11.64', newest: '', error: 'GitHub answered 403', how: 'lxc', canInstall: true });
    check('and with GitHub unreachable it says which version is running and why it cannot tell',
      [/v2\.11\.64/.test(d.querySelector('#updateState').textContent),
        /GitHub answered 403/.test(d.querySelector('#updateState').textContent),
        d.querySelector('#updateNow').hidden], [true, true, true]);
  }
  // The updater restarts the app, so the page that asked never hears how it
  // went: it leaves word behind, and that is where a failure has to surface.
  {
    const d = await settings({ running: '2.11.64', newest: '2.11.64', behind: false, how: 'lxc',
      canInstall: true, last: { ok: false, said: 'it updated but the service did not stay up' } });
    check('a failed update is reported even though it restarted whoever asked',
      /did not stay up/.test(d.querySelector('#updateState').textContent), true);
  }
}

// --- and saying so without opening Settings -------------------------------
// Settings is three clicks away and nobody opens it to find out whether there
// is news. So the news comes to the page: a red dot on the icon, and the way to
// act on it in the pulldown — which is removed again the moment there is
// nothing to install, because a menu entry that does nothing is worse than none.
{
  const marked = async (update) => {
    const page = await open('index.html', { '/api/update': update });
    await settle();
    page.window.eval('updateMark()');
    await settle(120);
    return page.document;
  };

  {
    const d = await marked({ running: '2.12.0', newest: '2.12.8', behind: true, how: 'lxc', canInstall: true });
    check('a newer version puts a dot on the icon and the way to take it in the menu',
      [d.querySelector('#updateDot').hidden, d.querySelector('#installUpdate').hidden],
      [false, false]);
    check('and the dot says which version it is about, since the icon cannot',
      d.querySelector('#updateDot').title, 'Update available: v2.12.8');
  }
  {
    const d = await marked({ running: '2.12.0', newest: '2.12.8', behind: true, how: 'image', canInstall: false });
    check('an install that cannot take it is still told, but offered nothing to click',
      [d.querySelector('#updateDot').hidden, d.querySelector('#installUpdate').hidden],
      [false, true]);
  }
  {
    const d = await marked({ running: '2.12.8', newest: '2.12.8', behind: false, how: 'lxc', canInstall: true });
    check('and on the newest version there is no dot and no entry',
      [d.querySelector('#updateDot').hidden, d.querySelector('#installUpdate').hidden],
      [true, true]);
  }
}

// --- and knowing when it is over ------------------------------------------
// The owner's: "wanneer de update is uitgevoerd, blijft de tekst Updating… gewoon
// staan. Het is niet duidelijk dat het klaar is."
//
// The page waited for the app to *answer* and reloaded on that. But nothing has
// stopped when the button is pressed — the app writes a file, and a root path
// unit has to notice it, stop the service, fetch and run `npm ci` — so it
// answers happily for the next half minute. Either the page reloaded itself
// straight back into the old version, or, when the app did not come back inside
// four minutes, the poll ran out in silence and left "Updating…" on the screen
// with nothing to say whether it had worked.
//
// The version is the one honest signal: it changes exactly when the new code is
// running. Both halves are checked here — that an app still answering on the
// old version is *not* taken for success, and that the new one is.
{
  // The poll is every two seconds and the reload is a second after that, which
  // is the right pace for a person and far too slow for a suite. The clock is
  // the environment, so the environment is what is wound on: `setInterval` runs
  // fast and `setTimeout` only records, which also keeps jsdom from being asked
  // to navigate — it cannot, and it would be a fault in `broke` if it tried.
  const watching = async (versions) => {
    let n = 0;
    const page = await open('index.html', {
      '/api/update': { running: '2.12.0', newest: '2.12.8', behind: true, how: 'lxc', canInstall: true },
      // The rest of the shape is what the page's own counters read; the version
      // is the only part this is about.
      '/api/stats': () => ({ books: 0, files: 0, done: 0, todo: 0, version: versions[Math.min(n++, versions.length - 1)] }),
    });
    await settle();
    const w = page.window;
    const tick = w.setInterval.bind(w);
    const slept = [];
    w.setInterval = (fn) => tick(fn, 5);
    w.setTimeout = (fn, ms) => { slept.push(ms); return 0; };
    w.eval("document.querySelector('#installUpdate').click()");
    await settle(200);
    return { d: page.document, slept, broke: page.broke, asked: n };
  };

  {
    // It comes back on a new version: said out loud, left where the page that
    // reloads will find it, and only then reloaded.
    const { d, slept, broke } = await watching(['2.12.0', '2.12.0', '2.12.8']);
    check('when the version changes it says so, in the words "Updated to"',
      /Updated to v2\.12\.8/.test(d.querySelector('#updateState').textContent), true);
    check('and leaves the news for the page it is about to throw away',
      d.defaultView.sessionStorage.getItem('updated-to'), '2.12.8');
    check('and only then reloads', slept.includes(1200), true);
    check('with nothing thrown along the way', broke, []);
  }
  {
    // It keeps answering on the old version, which is what it does for the
    // first half-minute of every update. Nothing may be claimed from that.
    const { d, slept, asked } = await watching(['2.12.0']);
    check('an app still on the old version is not mistaken for a finished update',
      [/Updated to/.test(d.querySelector('#updateState').textContent),
        d.defaultView.sessionStorage.getItem('updated-to'), slept.includes(1200)],
      [false, null, false]);
    check('and it is still being watched, rather than given up on',
      [asked > 3, /Updating/.test(d.querySelector('#updateState').textContent)], [true, true]);
  }
}

// --- the page that comes up afterwards -------------------------------------
// The reload throws the message away with the page, so the news is left behind
// and said on the other side. Without this the update is silent exactly where
// it matters: the app is new, and nothing on screen ever said it worked.
{
  const page = await open('index.html');
  await settle();
  page.window.sessionStorage.setItem('updated-to', '2.12.8');
  page.window.eval('sayIfUpdated()');
  await settle(120);
  check('the page that comes up after an update says so, once',
    [/Updated to v2\.12\.8/.test(page.document.body.textContent),
      page.window.sessionStorage.getItem('updated-to')],
    [true, null]);
}

// --- following a job the server is doing ---------------------------------
// The owner got "Writing tags failed: lost contact with the server" on a tag write
// that had almost certainly finished perfectly well. Two faults, one shape:
// `trackProgress` gave up on the *first* status poll that went unanswered, and
// `write_` then put that complaint ahead of the answer from the request that had
// actually done the work. The work is on the server and carries on whatever this
// page can reach — failing to *read* the progress is not the job failing.
{
  // a few polls refused, then answers: the common case, and it used to end here
  {
    let polls = 0;
    const { window } = await open('index.html', {
      '/api/apply/status': () => {
        polls += 1;
        if (polls <= 3) return { __status: 502, error: 'the proxy had a moment' };
        return { running: polls < 6, done: polls, total: 6, current: 'a file' };
      },
    });
    const p = await window.eval('trackProgress("/api/apply/status", "Writing tags")');
    check('a few unanswered polls are waited through, not treated as the job failing',
      [p.error || null, p.running, polls >= 6], [null, false, true]);
  }

  // the request that is doing the work comes back while the polls are failing
  {
    const { window } = await open('index.html', {
      '/api/apply/status': { __status: 502, error: 'the proxy had a moment' },
    });
    const p = await window.eval(`(async () => {
      const until = { finished: false };
      setTimeout(() => { until.finished = true; }, 400);
      return trackProgress('/api/apply/status', 'Writing tags', until);
    })()`);
    check('and when the work reports back, there is nothing left to follow',
      p.error || null, null);
  }

  // a server that really has gone: it gives up, rather than spinning for ever
  {
    const { window } = await open('index.html', {
      '/api/apply/status': { __status: 502, error: 'gone' },
    });
    const p = await window.eval('trackProgress("/api/apply/status", "Writing tags")');
    check('but a server that never answers is given up on, not waited for for ever',
      p.error, 'lost contact with the server');
  }

  // And the ordering that mislabelled the owner's write. It only shows when the
  // status is unreachable long enough for the bar to give up *and* the work
  // still finishes — a long write through an outage — so that is what this is:
  // the status never answers, and the write reports back after the bar has
  // stopped following it. Reading the bar's complaint first said the write
  // failed, which would have the owner run it again over files already written.
  {
    const { window, document } = await open('index.html', {
      '/api/apply/status': { __status: 502, error: 'gone the whole time' },
      '/api/apply': async () => {
        await new Promise((r) => setTimeout(r, 6800));
        return { written: 3 };
      },
    });
    await window.eval('write_(5, {}, "", "A Book")');
    await settle(150);
    const said = document.querySelector('#progress .say')?.textContent || '';
    check('a write that finished is reported as finishing, however the following went',
      [/3 MP3 file\(s\) tagged/.test(said), /failed/.test(said)], [true, false]);
  }
}

// --- what a card says about a book --------------------------------------
// The owner had *Warbreaker* drawn under *Oathbringer*'s "Series · The Stormlight
// Archive · book 3" and read it as part of that series. It is not: it has no
// series, so the card drew nothing where the series line goes. Cards stack, and
// an empty slot reads as the last thing said still applying. Absence is not a
// statement, so the card makes one.
//
// And *Unabridged*, which is a fact about the book rather than about a listener
// — so the admin page sets it and the listening page only shows it.
{
  const SOME = [
    { id: 1, title: 'Oathbringer', author: 'Brandon Sanderson', genre: 'Fantasy', series: 'The Stormlight Archive', series_no: 3, year: '2017', narrator: 'Graphic Audio', duration: 145440, description: 'A book.', unabridged: 1, tracks: 1 },
    { id: 2, title: 'Warbreaker', author: 'Brandon Sanderson', genre: 'Fantasy', series: null, series_no: 0, year: '2011', narrator: 'Brandon Sanderson', duration: 89760, description: 'Another.', unabridged: 0, tracks: 1 },
  ];
  for (const [page, sets] of [['index.html', true], ['listen.html', false]]) {
    // eslint-disable-next-line no-await-in-loop -- two pages, one after the other
    const { window, document } = await open(page);
    window.eval(`drawBooks(${JSON.stringify(SOME)}, '', 'Series', [])`);
    // eslint-disable-next-line no-await-in-loop -- as above
    await settle();
    const card = (id) => document.querySelector(`.card[data-id="${id}"]`);
    check(`${page}: a book in a series says which, and where in it`,
      card(1).querySelector('.series-of')?.textContent,
      'Series · The Stormlight Archive · book 3');
    check(`${page}: and a book in none says so, rather than leaving the slot empty`,
      card(2).querySelector('.no-series')?.textContent, 'No Series');
    check(`${page}: so the two cards never read as one run of books`,
      [!!card(1).querySelector('.no-series'), !!card(2).querySelector('.series-of')], [false, false]);
    // A series gets a heading above it, which is what separates one run from the
    // next. Books in no series get none, so the first of them carries the gap
    // instead — without it, it sits tight under the last volume of the series
    // above and reads as more of it, which is how this started.
    check(`${page}: and the run of books in no series is set apart from the series above`,
      [card(1).classList.contains('apart'), card(2).classList.contains('apart')], [false, true]);

    // and nothing to be set apart from, at the top of a list
    window.eval(`drawBooks(${JSON.stringify([SOME[1], SOME[0]])}, '', 'Series', [])`);
    // eslint-disable-next-line no-await-in-loop -- as above
    await settle();
    check(`${page}: a list that opens with one is not pushed down by a gap above nothing`,
      card(2).classList.contains('apart'), false);
    window.eval(`drawBooks(${JSON.stringify(SOME)}, '', 'Series', [])`);
    // eslint-disable-next-line no-await-in-loop -- as above
    await settle();

    const boxes = (id) => [...card(id).querySelectorAll('.listened')].map((l) => l.textContent.trim());
    if (sets) {
      check(`${page}: the admin page offers Unabridged under Listened`,
        boxes(1), ['Listened', 'Unabridged']);
      check('and each box shows what the book says',
        [card(1).querySelector('.unabridged input').checked,
          card(2).querySelector('.unabridged input').checked], [true, false]);
      check('and it hands over an id and the box, like every other inline handler',
        card(1).querySelector('.unabridged input').getAttribute('onchange'), 'setUnabridged(1, this)');
    } else {
      check(`${page}: the listening page does not offer it — a listener changes nothing`,
        boxes(1), ['Listened']);
      check('but is told, when the book says so',
        [/Unabridged/.test(card(1).textContent), /Unabridged/.test(card(2).textContent)], [true, false]);
    }
  }
}

// --- and the three things on it that are a way somewhere -------------------
// A card names the author, the year and — where it is not already the answer —
// the genre, and each of those is the start of the next question: *what else
// has this one written*, *what else is from 2015*, *what else is in Fantasy*.
// The answer was to read the word, find it in a column, and click that. A
// search made it worse: a result from any shelf at all, and the only way back
// to where it lives was to go hunting for the author's name.
//
// Both pages draw their own cards from their own `drawBooks`, so both are
// asked. The three helpers are in `browse.js`, which both load.
{
  // A card links what its payload carries. Every route sends the genre since
  // 2.14.48 — `/api/books` used to leave it off a view of one genre — so a card
  // with no genre is a book whose genre column is empty, and it alone has
  // nowhere to go.
  const ACROSS = [
    { id: 1, title: 'Oathbringer', author: "Brandon O'Sanderson", genre: 'Fantasy', year: '2017', duration: 60, tracks: 1 },
    { id: 2, title: 'A Shelved Book', author: 'Someone', genre: '', year: '', duration: 60, tracks: 1 },
  ];
  for (const page of ['index.html', 'listen.html']) {
    // eslint-disable-next-line no-await-in-loop -- two pages, one after the other
    const { window, document } = await open(page, {
      '/api/year': (url) => { window.__askedFor = String(url); return []; },
    });
    window.eval(`drawBooks(${JSON.stringify(ACROSS)}, '', 'Search', [])`);
    // eslint-disable-next-line no-await-in-loop -- as above
    await settle();
    const card = (id) => document.querySelector(`.card[data-id="${id}"]`);

    check(`${page}: the author on a card from across the shelves is a way to their shelf`,
      [!!card(1).querySelector('.by-author'), card(1).querySelector('.by-author')?.textContent],
      [true, "Brandon O'Sanderson"]);
    // The apostrophe is the whole reason these carry `data-` attributes rather
    // than an inline `onclick`: in one of those, the name ends the string
    // argument in the middle and what follows is whatever the rest spells.
    check('and a name with an apostrophe in it survives being put on the card',
      [card(1).querySelector('.by-author').dataset.author,
        card(1).querySelector('.by-author').dataset.genre],
      ["Brandon O'Sanderson", 'Fantasy']);
    check('the year is one too, carrying the year itself',
      card(1).querySelector('[data-year]')?.dataset.year, '2017');
    check('and the genre is said, which is the thing such a card does not otherwise say',
      card(1).querySelector('[data-genre]:not([data-author])')?.textContent, 'Fantasy');

    // A book that arrives with no genre — every route sends one since 2.14.48,
    // so this is a book with an empty genre column — has nowhere for any of
    // this to go, and none of it is drawn: the author is a plain line.
    check(`${page}: a card already on its own shelf gets none of it`,
      [!!card(2).querySelector('.by-author'), !!card(2).querySelector('[data-genre]'),
        !!card(2).querySelector('[data-year]'), card(2).querySelector('.sub').textContent.trim()],
      [false, false, false, 'Someone']);

    // and they are wired, not merely drawn — the fault every one of these
    // buttons would otherwise have in common
    let went = null;
    window.openInLibrary = (g, a) => { went = [g, a]; };
    card(1).querySelector('.by-author').click();
    // eslint-disable-next-line no-await-in-loop -- as above
    await settle();
    check('clicking the author opens their shelf, in the genre the card named',
      went, ['Fantasy', "Brandon O'Sanderson"]);

    card(1).querySelector('[data-year]').click();
    // eslint-disable-next-line no-await-in-loop -- as above
    await settle(150);
    check('and clicking the year asks for every book of it',
      /\/api\/year\?year=2017/.test(window.__askedFor || ''), true);

    // Whether to say the genre was asked of `state.genre` — what the *column*
    // has selected — and not of the card. Browse to an author, then search, and
    // the column is still holding that genre: every result came back with no
    // genre on it at all, which is the one view the badge exists for. Found by
    // looking, in a browser, after the checks above all passed.
    window.eval("state.genre = 'Fantasy'");
    window.eval(`drawBooks(${JSON.stringify(ACROSS)}, '', 'Search', [])`);
    // eslint-disable-next-line no-await-in-loop -- as above
    await settle();
    check('and a genre left selected in the column does not silence the badge',
      card(1).querySelector('[data-genre]:not([data-author])')?.textContent, 'Fantasy');
  }
}

// --- an author's books say where they are -------------------------------------
// On a phone one column is on screen at a time, so a tap on an author brought
// their books up with nothing to say whose they were or which genre they are in
// — the two columns that say so on a wide screen were somewhere off to the side.
// The owner asked for the genre and the author to be there. And the author on a
// home tile is a way to their books too, the same as on a card.
{
  const MINE = [
    { id: 7, title: 'Oathbringer', author: "Brandon O'Sanderson", genre: 'Fantasy', year: '2017', duration: 60, tracks: 1 },
    { id: 8, title: 'Warbreaker', author: "Brandon O'Sanderson", genre: 'Fantasy', year: '2011', duration: 60, tracks: 1 },
  ];
  for (const page of ['index.html', 'listen.html']) {
    // eslint-disable-next-line no-await-in-loop -- two pages, one after the other
    const { window, document } = await open(page, {
      '/api/books': { books: MINE, series: [] },
      '/api/authors': [{ name: "Brandon O'Sanderson", books: 2 }],
    });
    window.eval("state.genre = 'Fantasy'; state.user = 'tester'");
    // eslint-disable-next-line no-await-in-loop -- as above
    await window.eval(`selectAuthor("Brandon O'Sanderson", null)`);
    // eslint-disable-next-line no-await-in-loop -- as above
    await settle();
    const head = document.querySelector('#books .list .series-head.where');
    check(`${page}: an author's books are headed with the genre and the author`,
      head?.textContent.replace(/\s+/g, ' ').trim(), "Fantasy · Brandon O'Sanderson · 2 books");
    check('and it comes first, above the books',
      document.querySelector('#books .list').firstElementChild === head, true);
    check('and every card on it says its genre',
      [...document.querySelectorAll('#books .card')]
        .map((c) => c.querySelector('[data-genre]:not([data-author])')?.textContent),
      ['Fantasy', 'Fantasy']);
    let genreWent = null;
    window.selectGenre = (g) => { genreWent = g; };
    head?.querySelector('[data-genre]')?.click();
    check('and the genre in the head is a way into that genre', genreWent, 'Fantasy');

    // A tile's author: to their books, and *not* the tile's own click, which
    // starts or resumes the book.
    document.querySelector('#books .list').innerHTML = window.eval(
      `shelf('Recently added', ${JSON.stringify(MINE)}, false)`,
    );
    let tileTapped = false;
    document.querySelector('.tile').onclick = () => { tileTapped = true; };
    window.eval('wireCardLinks()');
    let went = null;
    window.openInLibrary = (g, a) => { went = [g, a]; };
    document.querySelector('.tile .by-author')?.click();
    check(`${page}: the author on a home tile opens their books`,
      [went, tileTapped], [['Fantasy', "Brandon O'Sanderson"], false]);
  }
}

// --- the genre in the player ---------------------------------------------------
// The owner missed it beside the author, in the bar and on `/player`, and wanted it
// to be a way there. On a page with the columns it opens the genre at once; on
// one without, it is written down and picked up once the shelves have loaded.
{
  const PLAYING = {
    id: 4, title: 'A Book', author: 'An Author', genre: 'Fantasy', coverV: 0, progress: null,
    tracks: [{ id: 41, idx: 0, title: 'One', duration: 600 }],
  };
  for (const page of ['index.html', 'listen.html']) {
    // eslint-disable-next-line no-await-in-loop -- two pages, one after the other
    const { window, document } = await open(page, { '/api/books': PLAYING });
    window.eval("state.user = 'tester'");
    // eslint-disable-next-line no-await-in-loop -- as above
    await window.playBook(4);
    // eslint-disable-next-line no-await-in-loop -- as above
    await settle();
    const g = document.querySelector('#pGenre');
    check(`${page}: the bar says the genre beside the author`,
      [g?.textContent, g?.hidden, document.querySelector('#pAuthor')?.textContent],
      ['Fantasy', false, 'An Author']);
    let opened = null;
    window.selectGenre = (name) => { opened = name; };
    g?.click();
    check('and pressing it opens that genre, here and now', opened, 'Fantasy');

    // asked for from `/player`, where there are no columns to open it in
    opened = null;
    window.sessionStorage.openGenre = 'Fantasy';
    // eslint-disable-next-line no-await-in-loop -- as above
    await window.eval('openGenreAsked()');
    check('a genre asked for on another page is opened once the shelves are here, and only once',
      [opened, window.sessionStorage.openGenre], ['Fantasy', undefined]);
  }
  // and a book with no genre says nothing, rather than a dot and an empty link
  const { window, document } = await open('listen.html', { '/api/books': { ...PLAYING, genre: '' } });
  window.eval("state.user = 'tester'");
  await window.playBook(4);
  await settle();
  check('a book with no genre shows none', document.querySelector('#pGenre')?.hidden, true);
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
    // With one book on the go there is no shelf — that book is the card — so
    // what says "the shelves are on screen" has to count the card too. It did
    // not, and coming back stopped refreshing for exactly the reader this was
    // written for: one book, listened to on a phone.
    check('what is on screen is marked, so a refresh can tell, card or shelf',
      !!document.querySelector('[data-shelf="Continue listening"], .card.carry-on'), true);
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

// --- how fast the book is read ---------------------------------------------
// Kept per browser like the volume, because it is a thing about the listener
// and not about the book. The part that breaks quietly: `playbackRate` belongs
// to the element's *current* source, so a new `src` puts it back to 1 — a book
// set to 1.4 would drop to normal at every chapter, and the reader would be
// left wondering whether they had imagined setting it.
{
  const BOOK = {
    id: 9, title: 'A Book', author: 'An Author', coverV: 0,
    tracks: [{ id: 91, idx: 0, title: 'One', duration: 600 },
      { id: 92, idx: 1, title: 'Two', duration: 600 }],
    progress: null,
  };
  const page = await open('listen.html', { '/api/books': BOOK });
  await settle();
  const { window } = page;
  const audio = page.document.querySelector('#audio');

  window.eval("document.querySelector('#pSpeed').value = '1.4';");
  window.eval("document.querySelector('#pSpeed').dispatchEvent(new Event('change'));");
  await settle();
  check('choosing a speed sets it, and writes it down for next time',
    [audio.playbackRate, window.localStorage.getItem('speed')], [1.4, '1.4']);

  // A chapter change is a new source. jsdom fires no media events of its own,
  // so the one the app listens for is sent here — what is being checked is
  // that the app listens for it at all, which is the whole of the fix.
  window.eval('state.book = ' + JSON.stringify(BOOK) + '; playTrack(1, 0, false);');
  audio.playbackRate = 1;
  audio.dispatchEvent(new window.Event('loadedmetadata'));
  await settle();
  check('and a new chapter does not quietly put it back to normal',
    audio.playbackRate, 1.4);

  // Nothing below 1, and nothing a page could be talked into by a stale value.
  // Seeded through the hook, before the scripts run: each `open` builds its own
  // window with its own `localStorage`, so setting it on the page above left
  // this one empty and the check passed for having nothing to read rather than
  // for refusing what it read.
  const other = await open('listen.html', { '/api/books': BOOK },
    (w) => w.localStorage.setItem('speed', '0.5'));
  await settle();
  check('a speed the app does not offer is ignored rather than honoured',
    [other.document.querySelector('#audio').playbackRate,
      other.window.localStorage.getItem('speed')], [1, '0.5']);
}

// --- the administrator's pane of what has been asked for -------------------
// A request is words somebody typed, and the first thing done with it is to go
// and look for the book online. So each row carries the same ⧉ copy the Series
// to complete pane carries, putting "author - title" on the clipboard — the
// same class and the same delegated handler, so there is one copy button in
// this app rather than two that drift.
{
  const ASKED = {
    open: 1,
    requests: [
      { id: 1, who: 'Mario', author: 'Robin Hobb', title: 'Assassin’s Apprentice', note: 'the Kramer one', state: 'open', asked_at: '2026-10-19T09:00:00.000Z' },
      { id: 2, who: 'Luigi', author: 'Patrick Rothfuss', title: 'The Name of the Wind', note: '', state: 'declined', said: 'not on audio', asked_at: '2026-10-18T09:00:00.000Z' },
    ],
  };
  const { window, document, broke } = await open('index.html', { '/api/requests': ASKED });
  await settle();
  window.eval('showRequests()');
  await settle(160);

  const rows = [...document.querySelectorAll('[data-request]')];
  check('every request is a row, settled ones included', rows.length, 2);
  check('and each carries the words to go and search with',
    rows.map((r) => r.querySelector('.copy-search')?.dataset.copyText),
    ['Robin Hobb - Assassin’s Apprentice', 'Patrick Rothfuss - The Name of the Wind']);
  // The handler is the one on `#books`, which is the point of reusing the
  // class — but a button that is drawn and never reached is the exact fault
  // this app has had before, so it is asked rather than assumed.
  {
    let copied = null;
    window.navigator.clipboard = { writeText: async (t) => { copied = t; } };
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    rows[0].querySelector('.copy-search').click();
    await settle(120);
    check('and pressing it really copies them', copied, 'Robin Hobb - Assassin’s Apprentice');
  }
  check('an open one offers what to do about it',
    [...rows[0].querySelectorAll('[data-act]')].map((b) => b.dataset.act), ['link', 'decline']);
  check('and a settled one says what was decided, and can be forgotten',
    [/not on audio/.test(rows[1].textContent),
      [...rows[1].querySelectorAll('[data-act]')].map((b) => b.dataset.act)],
    [true, ['forget']]);
  check('and wiring the pane throws nothing', broke, []);
}

// --- the page opens with the book you are in the middle of -----------------
// The owner, pointing at a screenshot: the book's own card, at the top, the way it
// is everywhere else. The home page led with a *tile* — a cover, a title and a
// sliver of progress — and the thing he had come back for was the thing with
// the least said about it. The card is what the rest of the app draws a book
// as: cover, series, year, how long, what it is about, Listened, and the one
// button. So the first of *Continue listening* is drawn as one, and the shelf
// under it keeps the others.
//
// `cardFor` is lifted out of `drawBooks` for this, rather than a second copy of
// that template — a card on the home page that said something subtly different
// from every other card is a thing to keep in step for ever.
{
  const KEPT = [
    { id: 1, title: 'The One I Am In', author: 'An Author', genre: 'Fantasy', year: '2015', duration: 600, description: 'About a thing.', started: 1, done: 0, percent: 40, tracks: 1 },
    { id: 2, title: 'Also Going', author: 'Another', genre: 'Fantasy', year: '2016', duration: 600, started: 1, done: 0, percent: 10, tracks: 1 },
    { id: 3, title: 'And A Third', author: 'A Third', genre: 'Fantasy', year: '2017', duration: 600, started: 1, done: 0, percent: 5, tracks: 1 },
  ];
  const home = async (page, kept) => {
    const p = await open(page, { '/api/home': { continue: kept, recent: [] } });
    await settle();
    p.window.eval('loadHome()');
    await settle(160);
    const list = p.document.querySelector('#books .list');
    return {
      opensWith: list.firstElementChild?.className || '',
      cardTitles: [...list.querySelectorAll('.card h3')].map((h) => h.textContent.replace(/\s+/g, ' ').trim()),
      tiles: [...list.querySelectorAll('.tile .t')].map((t) => t.textContent),
      headings: [...list.querySelectorAll('.shelf-title')].map((s) => s.textContent),
      broke: p.broke,
    };
  };

  for (const page of ['index.html', 'listen.html']) {
    // eslint-disable-next-line no-await-in-loop -- two pages, one after the other
    const full = await home(page, KEPT);
    check(`${page}: the page opens with a card, not a tile`, full.opensWith, 'card carry-on');
    check('and it is the book you are in the middle of',
      full.cardTitles.map((t) => t.replace('♫ ', '')), ['The One I Am In']);
    // Drawn twice — once as the card, again as the first tile — would be the
    // obvious way to get this wrong, and it reads as two different books.
    check('and that book is not also a tile below it', full.tiles, ['Also Going', 'And A Third']);
    check('the rest keep their shelf', full.headings, ['Continue listening']);
    check('and nothing throws drawing it', full.broke, []);

    // eslint-disable-next-line no-await-in-loop -- as above
    const one = await home(page, [KEPT[0]]);
    check('with one book there is a card and no shelf left over',
      [one.opensWith, one.tiles.length, one.headings], ['card carry-on', 0, []]);

    // eslint-disable-next-line no-await-in-loop -- as above
    const none = await home(page, []);
    check('and with nothing to carry on with, no card and no empty heading',
      [none.cardTitles.length, none.tiles.length, none.headings], [0, 0, []]);
  }
}

// --- the book a tab carries belongs to whoever was listening ---------------
// The owner: sign in as somebody else and you get the previous reader's Continue
// listening, in a private window too.
//
// A tab carries the book it was playing from one page of the app to the next,
// in `sessionStorage`. A tab outlives a sign-in, and that carry said *what* but
// never *who*: Mario listened, signed out, Luigi signed in at the same tab and
// refreshed — and the player came back holding Mario's book at Mario's
// position. The private window made no difference, sessionStorage being per tab
// rather than per person.
//
// It was not only shown. Picking the book up loads it, and the place is written
// back under whoever is signed in, so Luigi ended up with a progress row on a
// book he had never opened — which is what then appeared on his shelf. Checked
// against the real thing: in the reproduction, Luigi came away with a place in
// Mario's book.
{
  const BOOK = {
    id: 7, title: 'A Carried Book', author: 'An Author', genre: 'Fantasy', coverV: 0,
    tracks: [{ id: 71, idx: 0, title: 'One', duration: 600 }],
  };
  // `who` is what the **server** says, which is what `pickUp` asks. The tab's
  // own `state.user` is deliberately set to somebody else here: it is the thing
  // that used to be trusted, and the checks below are only honest if trusting
  // it would give a different answer.
  const carrying = async (carry, who) => {
    const page = await open('listen.html', {
      '/api/books': { ...BOOK, progress: null },
      '/api/account/me': { signedIn: !!who, name: who, admin: false, required: true },
    });
    page.window.eval('state.user = "somebody else"; state.book = null;');
    page.window.sessionStorage.setItem('carrying', JSON.stringify(carry));
    await page.window.pickUp();
    await settle();
    return {
      loaded: page.window.eval('state.book && state.book.id') || null,
      left: page.window.sessionStorage.getItem('carrying'),
      broke: page.broke,
    };
  };

  const mine = { who: 'Luigi', id: 7, track: 0, position: 120, playing: false };
  {
    const { loaded, left, broke } = await carrying(mine, 'Luigi');
    check('a tab carries its own reader’s book back, which is what this is for',
      [loaded, !!left], [7, true]);
    check('and nothing throws doing it', broke, []);
  }
  {
    // the reproduction, in one check
    const { loaded, left } = await carrying({ ...mine, who: 'Mario' }, 'Luigi');
    check('but somebody else’s book is not picked up by the next reader',
      loaded, null);
    check('and it is not left in the tab for them to find later', left, null);
  }
  {
    // written by a version that carried no name. Not ours to guess about.
    const { who, ...nameless } = mine;
    const { loaded, left } = await carrying(nameless, 'Luigi');
    check('a carry from before this carried a name is dropped, not assumed',
      [loaded, left], [null, null]);
  }
  {
    // Nobody signed in — the gate. Nothing is taken, and nothing is thrown
    // away either: the person about to sign in may be the one who left it, and
    // dropping it here would lose their own book on the way back in.
    const { loaded, left } = await carrying(mine, '');
    check('and nobody signed in takes nothing — but keeps it, it may be theirs',
      [loaded, !!left], [null, true]);
  }

  // Comparing against the tab's own `state.user` would not have closed this.
  // That is seeded from `localStorage` and holds the *previous* reader's name
  // until a page signs in, so the carry and the name agree with each other —
  // "Mario" against "Mario" — and the check passes itself. Asking the server is
  // the whole difference, and this is where that shows: a page sitting at the
  // gate, with both still in the tab and nobody signed in.
  {
    const page = await open('listen.html', {
      '/api/books': { ...BOOK, progress: null },
      '/api/account/me': { signedIn: false, name: '', admin: false, required: true },
      '/api/admin': { required: true, admin: false, unclaimed: false },
    }, (w) => {
      w.localStorage.setItem('user', 'Mario');
      w.sessionStorage.setItem("carrying", JSON.stringify({ who: "Mario", id: 7, track: 0, position: 120, playing: false }));
    });
    await settle(200);
    check('a page sitting at the gate picks up nothing, though the tab still holds both',
      [page.window.eval('state.book && state.book.id') || null,
        page.window.eval('state.user'),
        !page.document.querySelector('#gate').hidden],
      [null, '', true]);
  }

  // The other half: what gets written, and that signing out takes it away.
  {
    const page = await open('listen.html', { '/api/books': { ...BOOK, progress: null } });
    page.window.eval('state.user = "Mario"; state.book = ' + JSON.stringify(BOOK) + '; state.track = 0;');
    page.window.dispatchEvent(new page.window.Event('pagehide'));
    await settle();
    const said = JSON.parse(page.window.sessionStorage.getItem('carrying') || '{}');
    check('the carry records whose it is, which is the whole of the fix',
      [said.who, said.id], ['Mario', 7]);

    page.window.dropCarry();
    check('and signing out drops it rather than leaving it for the next reader',
      page.window.sessionStorage.getItem('carrying'), null);
  }
}

console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
