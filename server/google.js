import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeTag } from './tagpool.js';
import { db, googleKey, DATA_DIR } from './db.js';

// Google Books answers 503 when it is briefly busy: wait and ask again.
const RETRY_AFTER = [10000, 20000, 30000];

const explain = (status, detail) => ({
  400: 'Google rejected the request. The API key looks invalid — check it in the container template or in Settings.',
  401: 'Google did not accept the API key. Check it in the container template or in Settings.',
  403: 'Google refused the key. Open Google Cloud Console and make sure the "Books API" is enabled for this key, and that no IP/website restriction blocks your server.',
  404: 'The Google Books service could not be found. Check the server\'s internet connection.',
  429: 'Too many requests: the Google Books daily quota or rate limit has been reached. Try again later.',
  503: 'Google Books is temporarily unavailable. Retried after 10, 20 and 30 seconds without success — try again later.',
}[status] || `Google Books replied with an unexpected error (HTTP ${status}).`) + (detail ? ` Google says: "${detail}"` : '');

export const lookupProgress = { running: false, attempt: 0, attempts: RETRY_AFTER.length + 1, retryUntil: 0 };

export async function lookup(book, search, trace = null) {
  const key = googleKey();
  if (!key) throw new Error('No Google Books API key. Set GOOGLE_API_KEY on the container (the Unraid template has a field for it) and restart.');
  Object.assign(lookupProgress, { running: true, attempt: 0, retryUntil: 0 });
  try {
    return await search_(book, search, key, trace);
  } finally {
    lookupProgress.running = false;
  }
}

async function search_(book, search, key, trace = null) {
  const q = search || `intitle:${book.title}` + (book.author ? ` inauthor:${book.author}` : '');
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=5&key=${key}`;

  let res;
  for (let attempt = 0; ; attempt++) {
    lookupProgress.attempt = attempt + 1;
    lookupProgress.retryUntil = 0;
    try {
      res = await fetch(url);
    } catch {
      throw new Error('Could not reach Google Books. The server appears to have no internet connection.');
    }
    if (res.status !== 503 || attempt === RETRY_AFTER.length) break;
    lookupProgress.retryUntil = Date.now() + RETRY_AFTER[attempt];
    await new Promise((r) => setTimeout(r, RETRY_AFTER[attempt]));
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(explain(res.status, body.error?.message));
  }
  const data = await res.json();
  const items = await Promise.all((data.items || []).map(async (it, i) => ({
    // only the first result is traced: a probe reports on the match, not the list
    it, series: await seriesFor(it, key, i === 0 ? trace : null),
  })));
  return items.map(({ it, series }) => ({
    ...series,
    author: (it.volumeInfo.authors || []).join(', '),
    // kept apart as well: a book two people wrote is a choice, not a string
    authors: it.volumeInfo.authors || [],
    year: (it.volumeInfo.publishedDate || '').slice(0, 4),
    // Google answers with categories like "Fiction / Fantasy / Epic": each part
    // is a genre worth offering, so the admin picks which one this book is filed as
    genres: [...new Set((it.volumeInfo.categories || [])
      .flatMap((c) => c.split(/[/,]/))
      .map((c) => c.trim())
      .filter(Boolean))].slice(0, 6),
    description: it.volumeInfo.description || '',
    thumbnail: (it.volumeInfo.imageLinks || {}).thumbnail || '',
  }));
}

// How Google keeps series, and what that costs to read.
//
// A volume carries `volumeInfo.seriesInfo`, and it holds no series NAME: only
// `volumeSeries[].seriesId` with `orderNumber` (the real sequence),
// `bookDisplayNumber` (for display only — it can read "2.5") and
// `shortSeriesBookTitle`, which is the *book's* title in the context of the
// series and so is sometimes the book's own name. The name lives behind
// `series/get?series_id=`. And `seriesInfo` is usually missing from a
// `volumes?q=` answer altogether, being on the volume rather than the result.
//
// So the series of one book can cost three requests. It is asked for in that
// order, stopping at the first answer, and nothing is asked at all where the
// title or subtitle already said it:
//
//   1. the text of the result            — free
//   2. GET volumes/<id> → seriesInfo     — one request, for the ids
//   3. GET series/get   → the name       — one request, cached by seriesId
//
// Every one of these may fail. None of them may take the lookup down with it: a
// series that cannot be read is a tick the dialog does not offer.
const ask = async (url) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
};

// seriesId -> name, for the life of the process. A collection's books share a
// handful of series, so this is what keeps a shelf's worth of lookups cheap.
const seriesNames = new Map();

async function seriesName(id, key) {
  if (!id) return '';
  if (seriesNames.has(id)) return seriesNames.get(id);
  const body = await ask(`https://www.googleapis.com/books/v1/series/get?series_id=${encodeURIComponent(id)}&key=${key}`);
  const name = (body?.series || []).find((s) => s.title)?.title || '';
  // remembered even when empty: a series Google will not name twice is still one
  // request per book otherwise
  seriesNames.set(id, name);
  return name;
}

// A whole number, or none: series_no is an integer, and a novella numbered "2.5"
// filed as 2 would sit on top of book 2 rather than beside it.
const whole = (raw) => {
  const s = String(raw ?? '').trim();
  return /^\d{1,3}$/.test(s) ? Number(s) : 0;
};

const numberIn = (info) => {
  const first = (info.volumeSeries || [])[0] || {};
  // orderNumber is the sequence; bookDisplayNumber is what Google prints
  return whole(first.orderNumber) || whole(info.bookDisplayNumber);
};

// `trace`, when given, is filled in with what Google actually sent and what was
// made of it. That is the only way to see this from outside: the answers come from
// a key the owner holds, on their server, so the checking has to happen there.
async function seriesFor(it, key, trace = null) {
  const text = seriesOf(it.volumeInfo);
  const here = it.volumeInfo?.seriesInfo || null;
  if (trace) {
    Object.assign(trace, {
      googleTitle: it.volumeInfo?.title || '', subtitle: it.volumeInfo?.subtitle || '',
      inSearch: !!here, asked: [],
    });
  }
  // the words named it: nothing to ask for, though a number Google already sent
  // fills in one the words left out
  if (text.series) {
    const no = text.seriesNo || (here ? numberIn(here) : 0);
    if (trace) Object.assign(trace, { from: text.from, series: text.series, seriesNo: no });
    return { ...text, seriesNo: no };
  }
  let info = here;
  if (!info) {
    if (trace) trace.asked.push('volume');
    info = (await ask(`https://www.googleapis.com/books/v1/volumes/${encodeURIComponent(it.id || '')}?key=${key}`))
      ?.volumeInfo?.seriesInfo;
  }
  if (!info) {
    if (trace) Object.assign(trace, { from: 'nothing', series: '', seriesNo: 0 });
    return text;
  }
  const first = (info.volumeSeries || [])[0] || {};
  const no = numberIn(info);
  if (trace) {
    Object.assign(trace, {
      seriesId: first.seriesId || '', orderNumber: first.orderNumber ?? '',
      bookDisplayNumber: info.bookDisplayNumber || '', shortSeriesBookTitle: info.shortSeriesBookTitle || '',
      bookType: first.seriesBookType || '',
    });
    if (first.seriesId && !seriesNames.has(first.seriesId)) trace.asked.push('series name');
  }
  const canonical = await seriesName(first.seriesId, key);
  const named = canonical
    // last resort, and the reason it is last: this field is a book title as often
    // as it is a series name
    || (info.shortSeriesBookTitle
      ? seriesIn(info.shortSeriesBookTitle, [VOLUME_ON_THE_END])?.series || info.shortSeriesBookTitle.trim()
      : '');
  const same = named.toLowerCase() === text.title.toLowerCase();
  const out = { title: text.title, series: same ? '' : named, seriesNo: same || !named ? 0 : no };
  if (trace) {
    Object.assign(trace, {
      from: out.series ? (canonical ? 'series name' : 'short title') : (named ? 'the book itself' : 'nothing'),
      series: out.series, seriesNo: out.seriesNo,
    });
  }
  return out;
}

// A search answer names the series in the title's brackets ("The Final Empire
// (Mistborn, #1)") or in the subtitle ("The Stormlight Archive, Book 2"), and
// where it names neither, Google's own seriesInfo does. All three are read here,
// and the brackets come off the title so the album tag does not carry them.
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
const numberOf = (raw) => {
  const s = (raw || '').trim().toLowerCase();
  if (/^\d{1,3}$/.test(s)) return Number(s);
  return WORDS[s] || ROMAN[s] || 0;
};
const NO = '\\d{1,3}|[ivx]{1,4}|one|two|three|four|five|six|seven|eight|nine|ten';
const LABEL = 'book|bk\\.?|vol\\.?|volume|part|no\\.?|nr\\.?|deel';
// Only these shapes count as a series. Anything else in brackets — "(Unabridged)",
// "(Penguin Classics)" — is not one, and guessing there would be worse than silence.
const VOLUME_ON_THE_END = {
  // Mistborn, #1 · The Stormlight Archive, Book 2 · The Expanse #1 · Discworld 8
  // · The Dark Tower V. The number has to be there; what announces it need not be.
  re: new RegExp(`^(.+?)[,:]?\\s*(?:#\\s*|(?:${LABEL})\\s*#?\\s*)?(${NO})$`, 'i'),
  numberFirst: false,
};
const SHAPES = [
  VOLUME_ON_THE_END,
  // Book 3 of The Expanse · Volume Two in the Wheel of Time Series
  { re: new RegExp(`^(?:${LABEL})\\s*(${NO})\\s+(?:of|in)\\s+(.+)$`, 'i'), numberFirst: true },
  // A Mistborn Novel · An Expanse Story
  { re: /^an?\s+(.+?)\s+(?:novel|novella|story|mystery|thriller|adventure|book)$/i, numberFirst: false },
  // The Wheel of Time Series
  { re: /^(.+?)\s+(?:series|saga|cycle)$/i, numberFirst: false },
];
const seriesIn = (chunk, shapes = SHAPES) => {
  const text = (chunk || '').replace(/\s+/g, ' ').trim();
  for (const { re, numberFirst } of shapes) {
    const m = text.match(re);
    if (!m) continue;
    const name = (numberFirst ? m[2] : m[1])
      .replace(/[\s,:]+$/, '')
      // "Series" describes; "Saga" and "Cycle" are part of names like The Twilight Saga
      .replace(/\s+series$/i, '')
      // "in the Wheel of Time" is a sentence around the name; "of The Expanse"
      // hands over a name that begins with its own article, so the capital stays
      .replace(/^the\s+/, '')
      .trim();
    const no = numberOf(numberFirst ? m[1] : m[2]);
    // "Book 1 of 3" is not a series called "Book 1 of", and a number is not a name
    const empty = !name || /^\d+$/.test(name) || new RegExp(`^(?:${LABEL}|#)\\b`, 'i').test(name);
    if (!empty && name.length <= 60) return { series: name, seriesNo: no };
  }
  return null;
};
// What the words of a result say, on their own: no request, no Google series data.
export function seriesOf(info = {}) {
  const title = info.title || '';
  // the brackets at the end of a title, if that is what they hold
  const bracket = title.match(/^(.*\S)\s*[([]([^()[\]]+)[)\]]\s*$/);
  const inBracket = bracket ? seriesIn(bracket[2]) : null;
  const clean = inBracket ? bracket[1] : title;
  const found = inBracket || seriesIn(info.subtitle);
  return {
    title: clean,
    series: found ? found.series : '',
    seriesNo: found ? found.seriesNo : 0,
    from: found ? (inBracket ? 'title' : 'subtitle') : '',
  };
}

// One book, asked about and reported on: what Google sent, what was read from it,
// and how many requests it took. For the report in Settings — Google can only be
// asked with the owner's key, from the owner's server.
export async function probeSeries(books) {
  const out = [];
  for (const b of books) {
    const trace = { title: b.title, author: b.author, has: b.series || b.tag_series || '' };
    try {
      const results = await lookup(b, '', trace);
      if (!results.length) trace.from = 'no result';
    } catch (e) {
      trace.error = e.message;
    }
    out.push(trace);
  }
  return out;
}

// What one tag write reports, for the bar that follows it. Every write has its
// own: two writers sharing one count is what made a bar read "193 / 157".
export const newTagProgress = () => ({ running: false, done: 0, total: 0, current: '', written: 0, error: '' });
const IDLE = newTagProgress();

// One writer per book, not one per server: two books — two series — can be
// written at the same time, since each write only ever touches its own files. The
// same book twice would be two writers on one file, which is worse than a wait.
const writers = new Map(); // book id -> the progress of the write running on it

export const writeProgress = (id) => writers.get(Number(id)) || IDLE;
export const anyWriting = () => writers.size > 0;

export async function applyMetadata(book, pick, writeTags, sink = null) {
  if (writeTags && writers.has(book.id)) {
    throw new Error('That book is already being written. Wait for it to finish.');
  }
  const progress = sink || newTagProgress();
  // registered before the first await, so a poll right after the request sees it
  if (writeTags) {
    Object.assign(progress, { running: true, done: 0, total: 0, current: '', written: 0, error: '' });
    writers.set(book.id, progress);
  }
  try {
    return await apply_(book, pick, writeTags, progress);
  } finally {
    // whatever failed, the bar must stop spinning
    progress.running = false;
    if (writeTags) writers.delete(book.id);
  }
}

async function apply_(book, pick, writeTags, progress) {
  let cover = book.cover;
  if (pick.thumbnail) {
    // a cover that will not download must not stop the metadata being applied
    try {
      const res = await fetch(pick.thumbnail.replace('http://', 'https://'));
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        cover = crypto.createHash('md5').update(buf).digest('hex') + '.jpg';
        fs.writeFileSync(path.join(DATA_DIR, 'covers', cover), buf);
      }
    } catch { /* keep the cover the book already had */ }
  }

  // author and genre stay as the folder tree named them: they are the navigation
  // keys, and a scan derives them from the folders anyway. Only the tag gets pick.
  // The series is the tag kind, not the folder kind: it names the series without
  // moving the book. Moving it is Edit metadata's Series field, which is a folder.
  const series = pick.series || book.tag_series || '';
  // one number, and the series the book is shown under has first claim on it: a
  // book living in a series folder must not be reordered inside it by a number
  // that belongs to another series entirely
  const numbers = pick.series && (!book.series || book.series.toLowerCase() === pick.series.toLowerCase());
  db.prepare(`UPDATE books SET title = ?, narrator = ?, year = ?, description = ?, cover = ?,
              tag_series = ?, series_no = ? WHERE id = ?`)
    .run(pick.title || book.title, pick.narrator || book.narrator,
         pick.year || book.year, pick.description || book.description, cover,
         series, numbers ? (pick.seriesNo || 0) : book.series_no || 0, book.id);

  if (!writeTags) return { written: 0 };

  {
    // A cover is either a file this app keeps or a picture beside the audio
    // (cover.jpg and its kind). Both go into the files: the Needs tags list
    // counts what the FILES carry, so skipping the second kind left a book asking
    // for a cover it already had, for ever.
    const kept = cover && !cover.startsWith('file:') ? path.join(DATA_DIR, 'covers', cover) : '';
    const beside = cover && cover.startsWith('file:') ? cover.slice(5) : '';
    const coverFile = [kept, beside].find((p) => p && fs.existsSync(p)) || null;
    const author = pick.author || book.author;
    const description = pick.description || book.description || '';
    const tags = {
      album: pick.title || book.title,
      // every file of a book carries the book title, not "018 of 132"; the track
      // number orders them and the player numbers the list itself
      title: pick.title || book.title,
      artist: author,
      performerInfo: author, // TPE2, the album artist
      year: pick.year || book.year,
      // the genre folder is what this library is organised by, and a Google
      // category only becomes one once the admin picks it and the book moves there
      genre: book.genre,
      composer: pick.narrator || book.narrator || '',
      // the grouping frame is where the series lives, with its number on the end
      // the way the app reads one back: without this the next scan, which trusts
      // the files, would drop the series again
      ...(series ? { contentGroup: series + (pick.seriesNo ? ` ${pick.seriesNo}` : '') } : {}),
      ...(description ? { comment: { language: 'eng', text: description } } : {}),
      ...(coverFile ? { APIC: coverFile } : {}),
    };
    // an empty value would write an empty frame, which reads back as "present"
    for (const [k, v] of Object.entries(tags)) if (!v) delete tags[k];
    const files = db.prepare('SELECT path FROM tracks WHERE book_id = ? ORDER BY idx').all(book.id)
      .map((t) => t.path).filter((p) => p.toLowerCase().endsWith('.mp3'));
    progress.total = files.length;
    // renumber in the order the tracks already play, zero padded to at least two digits
    const width = Math.max(2, String(files.length).length);
    const total = String(files.length).padStart(width, '0');
    try {
      // handed to worker threads: the queue in tagpool decides how many run at
      // once, so this may ask for every file of the book at the same time
      await Promise.all(files.map(async (file, i) => {
        const trackNumber = `${String(i + 1).padStart(width, '0')}/${total}`;
        progress.current = path.basename(file);
        if (await writeTag(file, { ...tags, trackNumber })) progress.written++;
        progress.done++;
      }));
    } catch (e) {
      progress.error = e.message;
    }
    if (progress.written) {
      const present = [
        ['album', tags.album], ['title', tags.title], ['artist', tags.artist], ['album artist', tags.performerInfo],
        ['narrator', tags.composer], ['genre', tags.genre], ['year', tags.year],
        ['description', tags.comment?.text], ['cover', tags.APIC], ['track no', true],
      ].filter(([, v]) => v).map(([k]) => k).join(',');
      db.prepare('UPDATE books SET tagged = ? WHERE id = ?').run(present, book.id);
    }
  }
  return { written: progress.written };
}
