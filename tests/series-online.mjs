// series-online — choosing the right Wikidata entry, and refusing to guess.
//
// The hard part of asking the world about a series is not the request, it is
// that a name is not an identifier: "The Dark Tower" is a novel series, an album,
// a film and a video game, and Wikidata answered with all four when this was
// first tried. The entry is chosen by what the shelf already holds; where
// nothing matches, the answer has to be "could not tell" rather than another
// series' volumes reported as yours.
//
// The answers below are the shapes Wikidata really returns — taken from live
// calls while this was written — handed to the module through its `ask`, so the
// choosing can be checked without asking anybody's free service on every run.
//
// Run: node tests/series-online.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.DATA_DIR = path.join(ROOT, 'fixtures', 'series-online-test', 'data');
fs.rmSync(path.dirname(process.env.DATA_DIR), { recursive: true, force: true });
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const { volumesOf } = await import('../server/wikidata.js');

let failed = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
};

const hit = (id, label, description) => ({ id, label, description });
const member = (series, title, ordinal) => ({
  series: { value: `http://www.wikidata.org/entity/${series}` },
  itemLabel: { value: title },
  ...(ordinal ? { ordinal: { value: String(ordinal) } } : {}),
});

// What Wikidata really answers for this name: four things, one of them the books
const DARK_TOWER_SEARCH = {
  search: [
    hit('Q7729016', 'The Dark Tower', 'album by Nox Arcana'),
    hit('Q123739779', 'The Dark Tower', '2025 video game'),
    hit('Q280898', 'The Dark Tower', 'novel series by Stephen King'),
    hit('Q21647114', 'The Dark Tower', '2017 film directed by Nikolaj Arcel'),
  ],
};
const DARK_TOWER_MEMBERS = {
  results: {
    bindings: [
      member('Q280898', 'The Little Sisters of Eluria', 0),
      member('Q280898', 'The Dark Tower: The Gunslinger', 1),
      member('Q280898', 'The Dark Tower II: The Drawing of the Three', 2),
      member('Q280898', 'The Dark Tower III: The Waste Lands', 3),
      member('Q280898', 'The Dark Tower IV: Wizard and Glass', 4),
      member('Q280898', 'The Dark Tower V: Wolves of the Calla', 5),
      member('Q280898', 'The Dark Tower VI: Song of Susannah', 6),
      member('Q280898', 'The Dark Tower VII: The Dark Tower', 7),
      member('Q280898', 'The Dark Tower: The Wind Through the Keyhole', 8),
    ],
  },
};

const asker = (search, sparql) => async (url) => {
  if (url.includes('wbsearchentities')) return search;
  if (url.includes('/sparql')) return sparql;
  throw new Error(`unexpected call: ${url}`);
};

// --- the shelf picks the entry -----------------------------------------
const ours = ['Gunslinger', 'The Drawing of the Three', 'Wizard and Glass'];
const found = await volumesOf('The Dark Tower', ours,
  { ask: asker(DARK_TOWER_SEARCH, DARK_TOWER_MEMBERS) });
check('the novel series is chosen over the album, the film and the game', found.id, 'Q280898');
check('and it says which one it took', [found.label, found.description],
  ['The Dark Tower', 'novel series by Stephen King']);
check('the volumes come back in order', found.volumes, [1, 2, 3, 4, 5, 6, 7, 8]);
check('the one with no ordinal is counted, not numbered', found.unnumbered, 1);
check('and the titles it has are kept, so a missing number has a name',
  found.titles.find((t) => t.no === 6)?.title, 'The Dark Tower VI: Song of Susannah');
check('it says how much of the shelf it recognised', found.matched, 3);

// --- and refuses where nothing matches ---------------------------------
// The same answer, asked about a shelf holding something else entirely: this is
// the case that must not report another series' volumes as yours.
const elsewhere = await volumesOf('The Dark Tower ', ['Gone Girl', 'The Shining'],
  { ask: asker(DARK_TOWER_SEARCH, DARK_TOWER_MEMBERS) });
check('a series whose volumes match nothing here is refused', elsewhere.found, false);
check('and it says why, naming what it found instead',
  /different series/.test(elsewhere.why) && /novel series by Stephen King/.test(elsewhere.why), true);

// --- nothing that is a series ------------------------------------------
const noSeries = await volumesOf('Piranesi', ['Piranesi'], {
  ask: asker({ search: [hit('Q1', 'Piranesi', '2020 novel by Susanna Clarke')] }, { results: { bindings: [] } }),
});
check('a name that is a book, not a series, is not answered', noSeries.found, false);
check('and says so in words', /nothing it lists is a series of books/.test(noSeries.why), true);

// --- nothing at all ----------------------------------------------------
const nothing = await volumesOf('Zzz Nonexistent Saga', ['A book'],
  { ask: asker({ search: [] }, { results: { bindings: [] } }) });
check('a name Wikidata has never heard of is answered plainly', nothing.found, false);
check('with a reason, not a silence', /nothing under that name/.test(nothing.why), true);

// --- the service being down is not "complete" --------------------------
const down = await volumesOf('Mistborn', ['The Final Empire'], {
  ask: async () => { throw new Error('fetch failed'); },
});
check('an endpoint that will not answer is not a verdict', down.found, false);
check('and the failure is quoted rather than swallowed',
  /could not be reached: fetch failed/.test(down.why), true);

// --- one name, two shelves ---------------------------------------------
// What is cached is what Wikidata said, never the conclusion: which entry is
// the right one depends on the books asked about, and two series can share a
// name inside one collection. Caching the verdict handed the second one the
// first one's — which is how this was found.
let asked = 0;
const shared = async (url) => { asked++; return asker(DARK_TOWER_SEARCH, DARK_TOWER_MEMBERS)(url); };
const mine = await volumesOf('Twice Asked', ours, { ask: shared });
const theirs = await volumesOf('Twice Asked', ['Gone Girl', 'The Shining'], { ask: shared });
check('the same name is asked of Wikidata once', asked, 2); // one search, one sparql
check('but judged for each shelf on its own', [mine.found, theirs.found], [true, false]);

// --- one series is asked about once ------------------------------------
let calls = 0;
const counting = asker(DARK_TOWER_SEARCH, DARK_TOWER_MEMBERS);
const once = async (url) => { calls++; return counting(url); };
await volumesOf('Wheel of Repetition', ours, { ask: once });
const before = calls;
await volumesOf('Wheel of Repetition', ours, { ask: once });
check('a series asked about twice is only asked of Wikidata once', calls, before);

// --- what it learned outlives the process ------------------------------
// Only the timestamp used to be kept. A restart then left the pane saying
// "Wikidata last asked 15:21" with nothing under it, and an authors column that
// had silently lost everybody Wikidata had found — which is how this was
// reported: "I ran the search, refreshed, and the author column is gone."
const { checkSeriesOnline, onlineProgress } = await import('../server/wikidata.js');
await checkSeriesOnline([{
  genre: 'Fantasy', name: 'The Dark Tower', author: 'Stephen King',
  titles: ours, have: [1, 2, 4, 5], highest: 5,
}], { ask: asker(DARK_TOWER_SEARCH, DARK_TOWER_MEMBERS) });
check('a run leaves its answer where the page reads it', onlineProgress.series.length, 1);
check('and the author it belongs to, which the column is built from',
  onlineProgress.series[0].author, 'Stephen King');

// a second instance of the module is what a restarted container looks like
const restarted = await import('../server/wikidata.js?restarted=1');
check('a restart still has the answer', restarted.onlineProgress.series.map((r) => r.name),
  ['The Dark Tower']);
check('and the authors with it', restarted.onlineProgress.series.map((r) => r.author),
  ['Stephen King']);
check('counted, so the pane knows it was asked rather than saying "not asked yet"',
  [restarted.onlineProgress.total, restarted.onlineProgress.done], [1, 1]);
check('and the date it was asked is still there too',
  restarted.lastOnlineAt() === onlineProgress.at, true);

console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
