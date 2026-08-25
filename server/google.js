import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import NodeID3 from 'node-id3';
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
    title: it.volumeInfo.title || '',
    author: (it.volumeInfo.authors || []).join(', '),
    year: (it.volumeInfo.publishedDate || '').slice(0, 4),
    genre: (it.volumeInfo.categories || [])[0] || '',
    description: it.volumeInfo.description || '',
    thumbnail: (it.volumeInfo.imageLinks || {}).thumbnail || '',
  }));
}

export const tagProgress = { running: false, done: 0, total: 0, current: '', written: 0, error: '' };

export async function applyMetadata(book, pick, writeTags) {
  // set before the first await so a poll right after the request sees it
  if (writeTags) Object.assign(tagProgress, { running: true, done: 0, total: 0, current: '', written: 0, error: '' });
  try {
    return await apply_(book, pick, writeTags);
  } finally {
    // whatever failed, the bar must stop spinning
    tagProgress.running = false;
  }
}

async function apply_(book, pick, writeTags) {
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
  db.prepare('UPDATE books SET title = ?, narrator = ?, year = ?, description = ?, cover = ? WHERE id = ?')
    .run(pick.title || book.title, pick.narrator || book.narrator,
         pick.year || book.year, pick.description || book.description, cover, book.id);

  if (!writeTags) return { written: 0 };

  {
    const coverFile = cover && !cover.startsWith('file:') ? path.join(DATA_DIR, 'covers', cover) : null;
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
      // the genre folder is what this library is organised by, so it wins over
      // a Google category like "Fiction"
      genre: book.genre,
      composer: pick.narrator || book.narrator || '',
      ...(description ? { comment: { language: 'eng', text: description } } : {}),
      ...(coverFile && fs.existsSync(coverFile) ? { APIC: coverFile } : {}),
    };
    // an empty value would write an empty frame, which reads back as "present"
    for (const [k, v] of Object.entries(tags)) if (!v) delete tags[k];
    const files = db.prepare('SELECT path FROM tracks WHERE book_id = ? ORDER BY idx').all(book.id)
      .map((t) => t.path).filter((p) => p.toLowerCase().endsWith('.mp3'));
    tagProgress.total = files.length;
    // renumber in the order the tracks already play, zero padded to at least two digits
    const width = Math.max(2, String(files.length).length);
    const total = String(files.length).padStart(width, '0');
    try {
      for (const [i, file] of files.entries()) {
        tagProgress.current = path.basename(file);
        const trackNumber = `${String(i + 1).padStart(width, '0')}/${total}`;
        if (NodeID3.update({ ...tags, trackNumber }, file) === true) tagProgress.written++;
        tagProgress.done++;
        // yield so the status endpoint can answer while writing
        await new Promise((r) => setImmediate(r));
      }
    } catch (e) {
      tagProgress.error = e.message;
    }
    if (tagProgress.written) {
      const present = [
        ['album', tags.album], ['title', tags.title], ['artist', tags.artist], ['album artist', tags.performerInfo],
        ['narrator', tags.composer], ['genre', tags.genre], ['year', tags.year],
        ['description', tags.comment?.text], ['cover', tags.APIC], ['track no', true],
      ].filter(([, v]) => v).map(([k]) => k).join(',');
      db.prepare('UPDATE books SET tagged = ? WHERE id = ?').run(present, book.id);
    }
  }
  return { written: tagProgress.written };
}
