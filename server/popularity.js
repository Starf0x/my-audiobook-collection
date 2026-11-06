// Fetch book popularity from Google Books API (no key needed for ratings)
// with Open Library as fallback. Rate-limited to 1 req/sec.
import { db } from './db.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Bayesian blend toward the midpoint (3.0) when count is low.
function toStars(avg, count) {
  if (!avg || avg < 1) return null;
  const weight = Math.min(count || 0, 20);
  const blended = (avg * weight + 3.0 * (20 - weight)) / 20;
  return Math.max(1, Math.min(5, Math.round(blended)));
}

async function fetchFromGoogle(title, author) {
  const q = encodeURIComponent(`intitle:${title} inauthor:${author}`);
  const url = `https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=5&printType=books`;
  const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(8000) });
  if (!r.ok) return null;
  const d = await r.json();
  if (!d.items || !d.items.length) return null;
  const best = d.items
    .filter((i) => i.volumeInfo?.averageRating)
    .sort((a, b) => (b.volumeInfo.ratingsCount || 0) - (a.volumeInfo.ratingsCount || 0))[0];
  if (!best) return null;
  return { avg: best.volumeInfo.averageRating, count: best.volumeInfo.ratingsCount || 0 };
}

async function fetchFromOpenLibrary(title, author) {
  const q = encodeURIComponent(`${title} ${author}`);
  const url = `https://openlibrary.org/search.json?q=${q}&limit=5&fields=ratings_average,ratings_count`;
  const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!r.ok) return null;
  const d = await r.json();
  if (!d.docs || !d.docs.length) return null;
  const best = d.docs
    .filter((doc) => doc.ratings_average)
    .sort((a, b) => (b.ratings_count || 0) - (a.ratings_count || 0))[0];
  if (!best) return null;
  return { avg: best.ratings_average, count: best.ratings_count || 0 };
}

export async function fetchBookPopularity(bookId) {
  const book = db.prepare('SELECT id, title, author FROM books WHERE id = ?').get(bookId);
  if (!book) return null;

  let result = null;
  try { result = await fetchFromGoogle(book.title, book.author); } catch { /* try fallback */ }

  if (!result) {
    try { result = await fetchFromOpenLibrary(book.title, book.author); } catch { /* skip */ }
  }

  const stars = result ? toStars(result.avg, result.count) : null;
  const now = new Date().toISOString().slice(0, 10);
  db.prepare('UPDATE books SET popularity_stars = ?, popularity_fetched_at = ? WHERE id = ?')
    .run(stars, now, bookId);
  return stars;
}

// In-memory state for the background update run
let running = false;
let runDone = 0;
let runTotal = 0;
let runStarted = '';

export function popularityStatus() {
  const lastDone = db.prepare("SELECT MAX(popularity_fetched_at) AS last FROM books WHERE popularity_fetched_at != ''").get();
  return { running, done: runDone, total: runTotal, started: runStarted, lastDone: lastDone?.last || '' };
}

export async function updateAllPopularity() {
  if (running) return;
  running = true;
  runDone = 0;
  runStarted = new Date().toISOString();
  const books = db.prepare('SELECT id FROM books ORDER BY id').all();
  runTotal = books.length;
  for (const { id } of books) {
    if (!running) break;
    try { await fetchBookPopularity(id); } catch { /* skip */ }
    runDone++;
    await sleep(1000);
  }
  running = false;
}

export function stopPopularityUpdate() {
  running = false;
}
