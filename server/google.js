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

export async function lookup(book, search) {
  const key = googleKey();
  if (!key) throw new Error('No Google Books API key. Set GOOGLE_API_KEY on the container (the Unraid template has a field for it) and restart.');
  Object.assign(lookupProgress, { running: true, attempt: 0, retryUntil: 0 });
  try {
    return await search_(book, search, key);
  } finally {
    lookupProgress.running = false;
  }
}

async function search_(book, search, key) {
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
  return (data.items || []).map((it) => ({
    ...seriesOf(it.volumeInfo),
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

// Google Books has no series field in the answer it gives for a volume, but it
// does put the series in the title's brackets ("The Final Empire (Mistborn, #1)")
// or in the subtitle ("The Stormlight Archive, Book 2"). Both are read here, and
// the brackets come off the title so the album tag does not carry them.
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
const SHAPES = [
  // Mistborn, #1 · The Stormlight Archive, Book 2 · The Expanse #1 · Discworld 8
  // · The Dark Tower V. The number has to be there; what announces it need not be.
  new RegExp(`^(.+?)[,:]?\\s*(?:#\\s*|(?:${LABEL})\\s*#?\\s*)?(${NO})$`, 'i'),
  // Book 3 of The Expanse · Volume Two in the Wheel of Time Series
  new RegExp(`^(?:${LABEL})\\s*(${NO})\\s+(?:of|in)\\s+(.+)$`, 'i'),
  // A Mistborn Novel · An Expanse Story
  /^an?\s+(.+?)\s+(?:novel|novella|story|mystery|thriller|adventure|book)$/i,
  // The Wheel of Time Series
  /^(.+?)\s+(?:series|saga|cycle)$/i,
];
const seriesIn = (chunk) => {
  const text = (chunk || '').replace(/\s+/g, ' ').trim();
  for (const [i, shape] of SHAPES.entries()) {
    const m = text.match(shape);
    if (!m) continue;
    // the second shape names the number first, the others name it last
    const name = (i === 1 ? m[2] : m[1])
      .replace(/[\s,:]+$/, '')
      .replace(/\s+(?:series|saga)$/i, '')
      // "in the Wheel of Time" is a sentence around the name; "of The Expanse"
      // hands over a name that begins with its own article, so the capital stays
      .replace(/^the\s+/, '')
      .trim();
    const no = i === 1 ? numberOf(m[1]) : numberOf(m[2]);
    // "Book 1 of 3" is not a series called "Book 1 of", and a number is not a name
    const empty = !name || /^\d+$/.test(name) || new RegExp(`^(?:${LABEL}|#)\\b`, 'i').test(name);
    if (!empty && name.length <= 60) return { series: name, seriesNo: no };
  }
  return null;
};
export function seriesOf(info = {}) {
  const title = info.title || '';
  // the brackets at the end of a title, if that is what they hold
  const bracket = title.match(/^(.*\S)\s*[([]([^()[\]]+)[)\]]\s*$/);
  const found = (bracket && seriesIn(bracket[2])) || seriesIn(info.subtitle) || null;
  // Google sometimes knows the number even when the words do not say it
  const told = numberOf(info.seriesInfo?.bookDisplayNumber);
  return {
    title: found && bracket && seriesIn(bracket[2]) ? bracket[1] : title,
    series: found ? found.series : '',
    seriesNo: found ? found.seriesNo || told : 0,
  };
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
