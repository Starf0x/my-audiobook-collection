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

console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
