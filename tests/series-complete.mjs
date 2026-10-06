// series-complete — what a series head says the collection is missing.
//
// The rule reads volume numbers out of the database, so this suite builds its
// library as rows rather than as files: no scan runs, and nothing here touches
// audio. Every shape the sentence has to cover gets a series of its own, and the
// last two exist to catch the ways it could be got wrong — a series split between
// two authors (counted whole, never over the books on screen) and a series nobody
// has numbered (which must say so rather than claim a verdict).
//
// Run: node tests/series-complete.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'fixtures', 'series-complete-test', 'data');
const PORT = 8532;
const BASE = `http://127.0.0.1:${PORT}`;

let failed = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
};

// --- the library -------------------------------------------------------
fs.rmSync(path.dirname(DATA), { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
process.env.DATA_DIR = DATA;
const { db } = await import('../server/db.js');

const BOOKS = [
  // a gap in the middle
  ['Fantasy', 'Stephen King', 'The Dark Tower', 'Gunslinger', 1],
  ['Fantasy', 'Stephen King', 'The Dark Tower', 'The Drawing of the Three', 2],
  ['Fantasy', 'Stephen King', 'The Dark Tower', 'Wizard and Glass', 4],
  ['Fantasy', 'Stephen King', 'The Dark Tower', 'Wolves of the Calla', 5],
  // a run with nothing absent from it
  ['Fantasy', 'Brandon Sanderson', 'Mistborn', 'The Final Empire', 1],
  ['Fantasy', 'Brandon Sanderson', 'Mistborn', 'The Well of Ascension', 2],
  ['Fantasy', 'Brandon Sanderson', 'Mistborn', 'The Hero of Ages', 3],
  // a gap, and a book with no number that may be it
  ['Fantasy', 'Robin Hobb', 'Farseer', 'Assassin the First', 1],
  ['Fantasy', 'Robin Hobb', 'Farseer', 'Assassin the Third', 3],
  ['Fantasy', 'Robin Hobb', 'Farseer', 'A Tale With No Number', 0],
  // numbered nowhere
  ['Fantasy', 'Ursula K. Le Guin', 'Earthsea', 'A Wizard of Earthsea', 0],
  ['Fantasy', 'Ursula K. Le Guin', 'Earthsea', 'The Tombs of Atuan', 0],
  // one book on its own
  ['Fantasy', 'Susanna Clarke', 'Piranesi', 'Piranesi', 0],
  // one series, two authors
  ['Fantasy', 'Anne Author', 'Shared World', 'The First Turn', 1],
  ['Fantasy', 'Bert Bookman', 'Shared World', 'The Second Turn', 2],
  ['Fantasy', 'Anne Author', 'Shared World', 'The Third Turn', 3],
  // one book of a series the second volume of, so a gap can start at book 1
  ['Fantasy', 'Cora Coauthor', 'Late Start', 'The Second Book', 2],
  ['Fantasy', 'Cora Coauthor', 'Late Start', 'The Third Book', 3],
  // two volumes gone at once, so the ordering of the collection-wide list has
  // something to order by: every other gap here is a single volume
  ['Fantasy', 'Dana Digger', 'Wide Gap', 'The First Hole', 1],
  ['Fantasy', 'Dana Digger', 'Wide Gap', 'The Fourth Hole', 4],
];
const add = db.prepare(`INSERT INTO books (path, genre, author, series, title, series_no, duration)
                        VALUES (?, ?, ?, ?, ?, ?, 3600)`);
for (const [genre, author, series, title, no] of BOOKS) {
  add.run(`/audiobooks/${genre}/${author}/${series}/${title}`, genre, author, series, title, no);
}

// --- the server --------------------------------------------------------
const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')],
  { env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT) }, stdio: 'inherit' });

const get = async (query) => {
  const r = await fetch(`${BASE}/api/books?${query}`);
  if (!r.ok) throw new Error(`${r.status} on ${query}`);
  return r.json();
};

// Keeps whatever the last attempt said. This swallowed it, so a run that failed
// here could only report "the server never answered" — the symptom, and nothing
// about a port someone else holds or a server that threw on the way up. It has
// gone wrong once, in a whole-suite run, and could not be reproduced in two
// after it; the next time, this will say what it was rather than leave another
// afternoon to guesswork.
let lastSaid = '';
const up = async () => {
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${BASE}/api/stats`); return true; } catch (e) {
      lastSaid = `${e.name}: ${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ''}`;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return false;
};

try {
  if (!await up()) throw new Error(`the server never answered on ${PORT} — last tried: ${lastSaid}`);

  const bySeries = async (name) => (await get(`genre=Fantasy&series=${encodeURIComponent(name)}`)).series[0];
  const byAuthor = async (name) => (await get(`genre=Fantasy&author=${encodeURIComponent(name)}`));

  // the numbers themselves
  const dark = await bySeries('The Dark Tower');
  check('a gap in the middle is the number nothing sits on', dark.missing, [3]);
  check('and it is said in one line', dark.says, 'Missing: book 3.');
  check('the highest is the end of the run, never a guess past it', dark.highest, 5);

  const mist = await bySeries('Mistborn');
  check('a whole run claims the run and nothing more', mist.says, 'Book 1 to 3 are all here.');
  check('a whole run is missing nothing', mist.missing, []);

  const late = await bySeries('Late Start');
  check('a series whose first book is absent is missing book 1', late.missing, [1]);

  // books with no number qualify the answer rather than being ignored
  const farseer = await bySeries('Farseer');
  check('a gap beside an unnumbered book is still a gap', farseer.missing, [2]);
  check('and the unnumbered book is counted', farseer.unnumbered, 1);
  check('and said, because it may be the missing one', farseer.says,
    'Missing: book 2. 1 book(s) here carry no volume number, so what is missing may be among them.');

  // where no verdict can be given, it says so rather than staying silent
  const earthsea = await bySeries('Earthsea');
  check('a series nobody numbered claims nothing', earthsea.missing, []);
  check('and says why there is no answer', earthsea.says,
    'No volume numbers here, so nothing can be said about what is missing.');

  const alone = await bySeries('Piranesi');
  check('one book is a folder, not a series to judge', alone.says, '');

  // the whole series, not the books on screen
  const anne = await byAuthor('Anne Author');
  check('browsing by author shows that author\'s share', anne.books.map((b) => b.series_no), [1, 3]);
  check('but the gap is counted over the whole series', anne.series[0].missing, []);
  check('so a shared series reads as whole from either author', anne.series[0].says, 'Book 1 to 3 are all here.');
  const bert = await byAuthor('Bert Bookman');
  check('and the same from the other one', bert.series[0].says, 'Book 1 to 3 are all here.');

  // the cards still arrive with it
  const one = await get('genre=Fantasy&series=Mistborn');
  check('the books come back beside the series state', one.books.length, 3);
  check('every series on an author page gets a state', (await byAuthor('Robin Hobb')).series.length, 1);

  // --- the whole collection at once, for Settings ------------------------
  const all = await (await fetch(`${BASE}/api/series-gaps`)).json();
  check('every series in the collection is looked at', all.looked, 8);
  check('only the ones with a hole are listed, biggest hole first then by name',
    all.gaps.map((s) => s.name), ['Wide Gap', 'Farseer', 'Late Start', 'The Dark Tower']);
  check('the two-volume hole is the one at the top', all.gaps[0].missing, [2, 3]);
  check('and each says which volumes are gone',
    all.gaps.map((s) => s.missing), [[2, 3], [2], [1], [3]]);
  check('a whole series is not in the list', all.gaps.some((s) => s.name === 'Mistborn'), false);
  check('nor is a single book', all.gaps.some((s) => s.name === 'Piranesi'), false);
  check('a series nobody numbered is named apart, not counted as whole',
    all.unnumbered.map((s) => s.name), ['Earthsea']);
  check('and it carries its genre, so a row can be opened', all.unnumbered[0].genre, 'Fantasy');
  check('a gap row names the author whose shelf it is, for the column that browses by author',
    all.gaps.map((s) => s.author), ['Dana Digger', 'Robin Hobb', 'Cora Coauthor', 'Stephen King']);
  check('a gap row carries what a row needs to open the series',
    [all.gaps[0].genre, all.gaps[0].books, all.gaps[0].highest], ['Fantasy', 2, 4]);
} finally {
  server.kill();
}

console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
