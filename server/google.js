import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import NodeID3 from 'node-id3';
import { db, getSetting, DATA_DIR } from './db.js';

const explain = (status, detail) => ({
  400: 'Google rejected the request. The API key looks invalid — check it in Settings.',
  401: 'Google did not accept the API key. Check it in Settings.',
  403: 'Google refused the key. Open Google Cloud Console and make sure the "Books API" is enabled for this key, and that no IP/website restriction blocks your server.',
  404: 'The Google Books service could not be found. Check the server\'s internet connection.',
  429: 'Too many requests: the Google Books daily quota or rate limit has been reached. Try again later.',
}[status] || `Google Books replied with an unexpected error (HTTP ${status}).`) + (detail ? ` Google says: "${detail}"` : '');

export async function lookup(book) {
  const key = getSetting('googleApiKey');
  if (!key) throw new Error('No Google Books API key set yet. Open Settings and paste your key first.');
  const q = `intitle:${book.title}` + (book.author ? ` inauthor:${book.author}` : '');
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=5&key=${key}`;

  let res;
  try {
    res = await fetch(url);
  } catch {
    throw new Error('Could not reach Google Books. The server appears to have no internet connection.');
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

export async function applyMetadata(book, pick, writeTags) {
  let cover = book.cover;
  if (pick.thumbnail) {
    const res = await fetch(pick.thumbnail.replace('http://', 'https://'));
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      cover = crypto.createHash('md5').update(book.path).digest('hex') + '.jpg';
      fs.writeFileSync(path.join(DATA_DIR, 'covers', cover), buf);
    }
  }

  db.prepare('UPDATE books SET title = ?, author = ?, year = ?, description = ?, cover = ? WHERE id = ?')
    .run(pick.title || book.title, pick.author || book.author, pick.year || book.year,
         pick.description || book.description, cover, book.id);

  const written = [];
  if (writeTags) {
    const coverFile = cover && !cover.startsWith('file:') ? path.join(DATA_DIR, 'covers', cover) : null;
    const tags = {
      album: pick.title || book.title,
      artist: pick.author || book.author,
      year: pick.year || book.year,
      genre: pick.genre || book.genre,
      comment: { language: 'eng', text: pick.description || book.description || '' },
      ...(coverFile && fs.existsSync(coverFile) ? { APIC: coverFile } : {}),
    };
    for (const t of db.prepare('SELECT path FROM tracks WHERE book_id = ? ORDER BY idx').all(book.id)) {
      if (!t.path.toLowerCase().endsWith('.mp3')) continue;
      const ok = NodeID3.update(tags, t.path);
      if (ok === true) written.push(t.path);
    }
  }
  return { written: written.length };
}
