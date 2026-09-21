// Which volumes a series actually has, asked of Wikidata.
//
// The line under a series head counts the numbers the collection already
// carries, so it can say "book 3 is missing" but never "there is a book 8".
// Nothing on this machine knows that a later volume was ever published, and
// Google cannot say either: its Books API has `isComplete` on a series — whether
// the reeks is finished — but no endpoint that lists the volumes of one.
//
// Wikidata does, and it is structured rather than prose: a work is `part of the
// series` (P179) with a `series ordinal` (P1545). That is two requests and no
// key. §7.3's rule — "do not add a second service to fill the gap" — was about
// filling in a book's *metadata*, which is still Google's alone; this asks a
// different question, and is the only source that can answer it.
//
// What it cannot promise, said here rather than discovered later:
//
// * **A name is not an identifier.** "The Dark Tower" is a novel series, an
//   album, a film and a video game. The right one is chosen by what the
//   collection already holds — the candidate whose volumes match the titles on
//   the shelf — and where nothing matches, the answer is "could not tell",
//   never a guess.
// * **Their ordinals are not always yours.** Wikidata has *The Wind Through the
//   Keyhole* as book 8 of The Dark Tower; it was published eighth and reads
//   fourth-and-a-half. Novellas and companion volumes often have no ordinal at
//   all. So a number this reports as missing is worth looking at, not obeying.
import { getSetting } from './db.js';

const SEARCH = 'https://www.wikidata.org/w/api.php';
const SPARQL = 'https://query.wikidata.org/sparql';

// Wikimedia asks for a User-Agent that says who is calling and where to
// complain. A tool that hides behind a browser string is one they are entitled
// to block, and rightly.
const AGENT = 'my-audiobook-collection (+https://github.com/Starf0x/my-audiobook-collection)';
// Searching a name comes back at once. The query service runs a real query
// against all of Wikidata and, measured here, sometimes takes far longer than a
// dozen seconds — three series in one run were lost to a 12-second limit that
// was simply too short for it.
const TIMEOUT = 12000;
const SPARQL_TIMEOUT = 30000;

// Their endpoints are free and shared. One series at a time, with a pause
// between, and never a burst: this asks for a favour, it does not buy a service.
//
// The two are not alike, and measuring said so. Searching a name is cheap and
// 350 ms apart is fine; the query service runs a real query and answered **429**
// for two of seven series at that spacing — on a collection of fifty that would
// be most of them. It gets more than three times the room, and a refusal is
// waited out rather than reported as "this series has no volumes".
export const GAP = 350;
export const SPARQL_GAP = 1200;
const SLOW_DOWN = 429;
let nextSlot = 0;

const wait = (ms) => new Promise((go) => setTimeout(go, ms));

async function inTurn(fn, gap = GAP) {
  const at = Math.max(Date.now(), nextSlot);
  nextSlot = at + gap;
  const sleep = at - Date.now();
  if (sleep > 0) await wait(sleep);
  return fn();
}

// One retry, after however long they asked for. Twice in a row is them saying
// no rather than "not yet", and the reason is passed on in words.
async function patiently(fn, gap) {
  try {
    return await inTurn(fn, gap);
  } catch (e) {
    // asked to slow down, or simply slow: both are worth one more try after a
    // pause. Anything else is an answer, and an answer is passed on.
    const again = e.status === SLOW_DOWN || e.name === 'TimeoutError' || /timeout/i.test(e.message);
    if (!again) throw e;
    await wait(Math.min(30000, Math.max(2000, (e.retryAfter || 5) * 1000)));
    return inTurn(fn, gap);
  }
}

// What Wikidata said, kept for the life of the process — the *answer*, never the
// conclusion drawn from it. Which entry is the right one depends on the books
// the question was asked about, and two series can share a name inside one
// collection; caching the verdict would hand the second one the first one's.
const remembered = new Map();

const defaultAsk = async (url) => {
  const r = await fetch(url, {
    headers: { 'User-Agent': AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(url.startsWith(SPARQL) ? SPARQL_TIMEOUT : TIMEOUT),
  });
  if (!r.ok) {
    const e = new Error(r.status === SLOW_DOWN
      ? 'Wikidata asked for a slower pace and would not answer twice running'
      : `Wikidata answered ${r.status}`);
    e.status = r.status;
    e.retryAfter = Number(r.headers.get('retry-after')) || 0;
    throw e;
  }
  return r.json();
};

// Reduced to letters and digits, the way titles are compared elsewhere here: a
// subtitle, a colon or a roman numeral must not stop two names being the same.
const plain = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// How much one candidate's volumes look like the shelf. A name alone proves
// nothing — this is what tells the novel series from the film of the same name.
const overlap = (theirs, ours) => {
  const mine = ours.map(plain).filter(Boolean);
  return theirs.filter((t) => {
    const them = plain(t);
    return them && mine.some((m) => m === them || m.includes(them) || them.includes(m));
  }).length;
};

const sparqlFor = (ids) => `SELECT ?series ?item ?itemLabel ?ordinal WHERE {
  VALUES ?series { ${ids.map((id) => `wd:${id}`).join(' ')} }
  ?item wdt:P179 ?series .
  OPTIONAL { ?item p:P179 ?st . ?st ps:P179 ?series ; pq:P1545 ?ordinal . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,nl,de,fr". }
}`;

// What Wikidata holds for one series, or why it could not say.
export async function volumesOf(name, ourTitles = [], { ask = defaultAsk } = {}) {
  const key = plain(name);
  if (!key) return { found: false, why: 'This series has no name to ask about.' };
  const said = remembered.has(key) ? remembered.get(key) : await fetchSeries(name, ask);
  // A refusal or a timeout is not an answer and must not be remembered as one,
  // or pressing the button again would report the same failure without asking.
  if (said.error) return { found: false, why: said.error };
  remembered.set(key, said);
  return choose(name, said, ourTitles);
}

// The two requests, and nothing decided by them.
async function fetchSeries(name, ask) {
  let hits;
  try {
    const url = `${SEARCH}?action=wbsearchentities&search=${encodeURIComponent(name)}`
      + '&language=en&uselang=en&type=item&limit=8&format=json&origin=*';
    hits = (await patiently(() => ask(url), GAP)).search || [];
  } catch (e) {
    return { error: `Wikidata could not be reached: ${e.message}` };
  }
  if (!hits.length) return { hits: [], maybe: [], rows: [] };

  // Only the ones that describe themselves as a series of written things: the
  // album and the film of the same name are not what is being asked about.
  const maybe = hits.filter((h) => /series|trilogy|saga|cycle/i.test(h.description || ''))
    .filter((h) => !/film|movie|video game|album|song|tv|television/i.test(h.description || ''))
    .slice(0, 3);
  if (!maybe.length) return { hits, maybe: [], rows: [] };

  try {
    const url = `${SPARQL}?format=json&query=${encodeURIComponent(sparqlFor(maybe.map((m) => m.id)))}`;
    return { hits, maybe, rows: (await patiently(() => ask(url), SPARQL_GAP))?.results?.bindings || [] };
  } catch (e) {
    return { error: `Wikidata could not be asked for the volumes: ${e.message}` };
  }
}

// Which of the candidates is this shelf's series, decided every time rather than
// remembered: the answer depends on the books asked about.
function choose(name, said, ourTitles) {
  const { hits, maybe, rows } = said;
  if (!hits.length) return { found: false, why: 'Wikidata has nothing under that name.' };
  if (!maybe.length) {
    return { found: false, why: `Wikidata knows "${name}", but nothing it lists is a series of books.` };
  }

  // Group what came back by which candidate it belongs to, then let the shelf
  // decide which candidate is the right one.
  const byId = new Map();
  for (const row of rows) {
    const id = String(row.series?.value || '').split('/').pop();
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push({
      title: row.itemLabel?.value || '',
      ordinal: Number(String(row.ordinal?.value ?? '').replace(/[^0-9].*$/, '')) || 0,
    });
  }
  let best = null;
  for (const m of maybe) {
    const items = byId.get(m.id) || [];
    if (!items.length) continue;
    const score = overlap(items.map((i) => i.title), ourTitles);
    if (!best || score > best.score || (score === best.score && items.length > best.items.length)) {
      best = { id: m.id, label: m.label, description: m.description || '', items, score };
    }
  }
  if (!best) return { found: false, why: `Wikidata knows "${name}" but lists no volumes for it.` };
  // A candidate nothing on the shelf matches is a series with the same name, not
  // this one. Say so rather than report its volumes as yours.
  if (!best.score && ourTitles.length) {
    return {
      found: false,
      why: `Wikidata's "${best.label}" (${best.description}) holds none of the books you have `
        + 'under this name, so it is probably a different series.',
    };
  }

  const numbered = [...new Set(best.items.map((i) => i.ordinal).filter((n) => n > 0))].sort((a, b) => a - b);
  return {
    found: true,
    id: best.id,
    label: best.label,
    description: best.description,
    url: `https://www.wikidata.org/wiki/${best.id}`,
    volumes: numbered,
    highest: numbered.length ? numbered[numbered.length - 1] : 0,
    unnumbered: best.items.filter((i) => !i.ordinal).length,
    matched: best.score,
    titles: best.items.sort((a, b) => a.ordinal - b.ordinal).map((i) => ({ no: i.ordinal, title: i.title })),
    why: '',
  };
}

// --- the whole collection, one series at a time --------------------------
// Network work over every series is minutes rather than seconds, so it runs the
// way a scan does: on the server, reporting through a progress object, and never
// started by a page loading.
export const onlineProgress = {
  running: false, done: 0, total: 0, current: '', found: 0, error: '', at: '', series: [],
};

export const ONLINE_KEY = 'seriesOnlineAt';

export async function checkSeriesOnline(all, { ask = defaultAsk } = {}) {
  Object.assign(onlineProgress, {
    running: true, done: 0, total: all.length, current: '', found: 0, error: '', series: [],
  });
  try {
    for (const s of all) {
      onlineProgress.current = s.name;
      // eslint-disable-next-line no-await-in-loop -- one at a time is the point
      const said = await volumesOf(s.name, s.titles);
      const row = { genre: s.genre, name: s.name, author: s.author || '',
        have: s.have, highest: s.highest, ...said };
      if (said.found) {
        onlineProgress.found++;
        // A volume is yours if you have its **number** or its **title**. The
        // number alone was not enough and said so on the first real run: a
        // series whose books carry no numbers had every volume reported as
        // missing, when they were sitting on the shelf unnumbered.
        const ours = s.titles.map(plain).filter(Boolean);
        const here = (v) => s.have.includes(v.no)
          || ours.some((m) => {
            const them = plain(v.title);
            return them && (m === them || m.includes(them) || them.includes(m));
          });
        row.missing = said.titles.filter((v) => v.no && !here(v)).map((v) => v.no);
        // and what it could not place either way, so the reader knows the
        // comparison was by title where the numbers ran out
        row.byTitle = !s.have.length;
      }
      onlineProgress.series.push(row);
      onlineProgress.done++;
    }
    onlineProgress.at = new Date().toISOString();
    return onlineProgress.series;
  } catch (e) {
    onlineProgress.error = e.message;
    throw e;
  } finally {
    onlineProgress.running = false;
  }
}

export const lastOnlineAt = () => getSetting(ONLINE_KEY, '');
