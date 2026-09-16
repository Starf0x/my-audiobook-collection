import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { db, getLibraries } from './db.js';
import { addOne } from './scan.js';
import { writeTag } from './tagpool.js';

// ffmpeg and ffprobe come with the image, so they are always the build that image
// is for and there is nothing to install. `-version` is still asked of them,
// because "it is in the container" is a claim the code can check.
export const TOOLS = ['ffmpeg', 'ffprobe'];
export const toolAt = (name) => name;

// Nothing, or why converting is not on offer. It should say nothing at all: an
// answer here means a container built before they were part of the image.
export function toolsWhy() {
  const bad = toolStatus().find((t) => !t.version);
  if (!bad) return '';
  // a reason is the whole point of this function: never an empty one
  return bad.error || `${bad.name} is in this container but said nothing when asked for its version.`;
}

// What the operating system says when a file that was uploaded is not a program
// it can run. "spawn ENOEXEC" on its own sends nobody anywhere.
const wontRun = (file, e) => {
  const name = path.basename(file);
  const code = e?.code || (/ENOEXEC|EACCES|ENOENT/.exec(e?.message || '') || [])[0] || '';
  if (code === 'ENOENT') {
    return new Error(`${name} is not in this container. It is part of the image from 2.3.0 on: `
      + 'update the container to the newest build.');
  }
  return new Error(`${name} would not run (${code || 'no code'}): ${e?.message || 'no reason given'}`);
};

// Once both have answered, that stands: they are in the image and cannot change
// under a running container. Asking again every time cost four processes per page
// load — and the first ask after a start can fail on its own, which then switched
// converting off for as long as that page was open.
let answered = null;

export function toolStatus() {
  if (answered) return answered;
  const now = statusNow();
  if (now.every((t) => t.version)) answered = now;
  return now;
}

function statusNow() {
  return TOOLS.map((name) => {
    const file = toolAt(name);
    const r = spawnSync(file, ['-version'], { encoding: 'utf8', timeout: 15000 });
    // what it says about itself, which is also the proof that it is there and runs
    const line = String(r.stdout || '').split('\n')[0].trim();
    return {
      name,
      version: r.status === 0 ? line : '',
      error: r.status === 0 ? ''
        : (r.error ? wontRun(file, r.error).message
          : (String(r.stderr || '').split('\n')[0] || `${name} exited ${r.status}`)),
    };
  });
}

// --- running them ------------------------------------------------------
const run = (file, args, onOut) => new Promise((resolve, reject) => {
  let p;
  // spawn throws for some of these rather than raising an error event, and a
  // throw in here would reject with the bare libuv message
  try {
    p = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { return reject(wontRun(file, e)); }
  let out = '';
  let err = '';
  p.stdout.on('data', (d) => { if (onOut) onOut(String(d)); else out += d; });
  // the last of it is what a failure is explained with; the rest is banner
  p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
  p.on('error', (e) => reject(wontRun(file, e)));
  p.on('close', (code) => (code === 0 ? resolve(out)
    : reject(new Error(err.trim().split('\n').filter(Boolean).pop() || `${path.basename(file)} exited ${code}`))));
});

// An .ogg (or .flac, or .m4b) with an ID3 tag bolted on the front. Taggers meant
// for MP3 write one anyway, and the Ogg demuxer will not look past it: the whole
// file comes back as "Invalid data found when processing input", and so it does
// from the scan, which is why such a book shows no length either. The tag says
// how long it is, and ffmpeg can be told to skip exactly that much. On an MP3 the
// tag belongs where it is and is never skipped.
function id3Skip(file) {
  if (/\.mp3$/i.test(file)) return 0;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(10);
    if (fs.readSync(fd, head, 0, 10, 0) < 10) return 0;
    if (head.toString('latin1', 0, 3) !== 'ID3') return 0;
    // four seven-bit bytes, big endian, and the ten of the header itself
    return ((head[6] & 0x7f) << 21 | (head[7] & 0x7f) << 14
      | (head[8] & 0x7f) << 7 | (head[9] & 0x7f)) + 10;
  } catch {
    // whatever is wrong with this file, ffprobe is about to say it in words
    return 0;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// before -i, because it is how the input is opened
const skipArgs = (file) => {
  const n = id3Skip(file);
  return n ? ['-skip_initial_bytes', String(n)] : [];
};

async function probe(file) {
  // -v error, never -v quiet: quiet throws away the one line that says what is
  // wrong with the file, and "ffprobe exited 1" sends nobody anywhere
  const out = await run(toolAt('ffprobe'),
    ['-v', 'error', ...skipArgs(file), '-print_format', 'json', '-show_chapters', '-show_format', file])
    // which file, out of the forty a book can be made of
    .catch((e) => { throw new Error(`${path.basename(file)}: ${e.message}`); });
  const j = JSON.parse(out || '{}');
  const chapters = (j.chapters || [])
    .map((c) => ({ start: Number(c.start_time) || 0, end: Number(c.end_time) || 0, title: String(c.tags?.title || '').trim() }))
    .filter((c) => c.end > c.start)
    .sort((a, b) => a.start - b.start);
  return { duration: Number(j.format?.duration) || 0, chapters };
}

// a chapter title becomes a file name, so it may hold nothing a path cannot
const safeName = (s) => s.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70);

export const convertProgress = {
  running: false, done: 0, total: 0, current: '', error: '', book: 0,
};

// Every book whose files are not all MP3: what the list in the column offers, and
// what the tag writer cannot touch until it has been converted.
export function convertible() {
  const books = db.prepare(`SELECT b.id, b.genre, b.author, b.series, b.title, b.path, b.duration,
      (SELECT COUNT(*) FROM tracks t WHERE t.book_id = b.id) AS files
    FROM books b ORDER BY b.author, b.title`).all();
  // which kinds of file, counted per book: the extension is a JavaScript job, not
  // something to take a string apart for in SQL
  const by = new Map();
  for (const t of db.prepare("SELECT book_id, path FROM tracks WHERE LOWER(path) NOT LIKE '%.mp3'").all()) {
    const seen = by.get(t.book_id) || { others: 0, kinds: new Set() };
    seen.others++;
    seen.kinds.add(path.extname(t.path).toLowerCase().replace('.', ''));
    by.set(t.book_id, seen);
  }
  return books.filter((b) => by.has(b.id))
    .map((b) => ({ ...b, others: by.get(b.id).others, kinds: [...by.get(b.id).kinds].sort().join(', ') }));
}

export function listConverted() {
  return db.prepare('SELECT * FROM converted ORDER BY converted_at DESC').all()
    .map((r) => ({ ...r, onDisk: fs.existsSync(r.path) }));
}

export function deleteConverted(id) {
  const r = db.prepare('SELECT * FROM converted WHERE id = ?').get(Number(id));
  if (!r) throw new Error('Not on the converted list');
  fs.rmSync(r.path, { recursive: true, force: true });
  db.prepare('DELETE FROM converted WHERE id = ?').run(r.id);
  return { deleted: 1 };
}

export function deleteAllConverted() {
  let n = 0;
  for (const r of listConverted()) { deleteConverted(r.id); n++; }
  return { deleted: n };
}

// where the originals are kept: beside the trash, inside the library folder the
// book lives in, so moving them is a move and not a copy across volumes
function keepRootFor(bookPath) {
  const here = path.resolve(bookPath);
  const entry = getLibraries().find((l) => here === path.resolve(l.path)
    || here.startsWith(path.resolve(l.path) + path.sep));
  if (!entry) throw new Error(`That book is not inside a library folder: ${bookPath}`);
  return path.join(path.resolve(entry.path), '.converted');
}

// One source file. A chapter becomes a track, which is what this app calls a
// chapter: ffmpeg writes the lot in one pass and the pieces are named and titled
// after the chapters afterwards.
async function convertOne(src, startNo, onSeconds) {
  const { duration, chapters } = await probe(src);
  const dir = path.dirname(src);
  const stem = path.basename(src, path.extname(src));
  const cuts = chapters.slice(1).map((c) => c.start.toFixed(3));
  const part = path.join(dir, `.converting-${process.pid}-`);
  const args = ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats',
    ...skipArgs(src), '-i', src, '-vn', '-map_metadata', '0', '-c:a', 'libmp3lame', '-q:a', '4'];
  if (cuts.length) {
    args.push('-f', 'segment', '-segment_times', cuts.join(','), '-reset_timestamps', '1', `${part}%03d.mp3`);
  } else {
    args.push(`${part}000.mp3`);
  }
  let seen = 0;
  await run(toolAt('ffmpeg'), args, (text) => {
    for (const line of text.split('\n')) {
      // out_time, not out_time_ms: that one is microseconds in some builds and
      // milliseconds in others, and a bar must not depend on which
      const m = /^out_time=(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(line.trim());
      if (!m) continue;
      const secs = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      if (secs > seen) { onSeconds(secs - seen); seen = secs; }
    }
  });
  if (duration > seen) onSeconds(duration - seen);

  const made = fs.readdirSync(dir).filter((f) => f.startsWith(path.basename(part))).sort();
  const named = [];
  made.forEach((file, i) => {
    const title = chapters[i]?.title || (made.length > 1 ? `Chapter ${i + 1}` : stem);
    const no = String(startNo + i).padStart(2, '0');
    let dest = path.join(dir, `${no} - ${safeName(title) || stem}.mp3`);
    if (fs.existsSync(dest)) dest = path.join(dir, `${no} - ${safeName(title) || stem} (${Date.now()}).mp3`);
    fs.renameSync(path.join(dir, file), dest);
    named.push({ file: dest, title });
  });
  return named;
}

// the picture the source carried: written beside the audio, where a scan and the
// tag writer both read a cover from, since -vn drops it out of the MP3s
async function coverFrom(src) {
  const dir = path.dirname(src);
  if (['cover.jpg', 'folder.jpg', 'front.jpg'].some((n) => fs.existsSync(path.join(dir, n)))) return;
  const dest = path.join(dir, 'cover.jpg');
  await run(toolAt('ffmpeg'), ['-hide_banner', '-nostdin', '-y', ...skipArgs(src), '-i', src,
    '-an', '-vframes', '1', dest])
    .catch(() => { fs.rmSync(dest, { force: true }); });
}

export async function convertBook(id) {
  // asked before a single file is touched: a tool that will not run must not be
  // found out halfway through a book
  const why = toolsWhy();
  if (why) throw new Error(why);
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(Number(id));
  if (!book) throw new Error('Book not found');
  const sources = db.prepare(`SELECT path FROM tracks WHERE book_id = ? AND LOWER(path) NOT LIKE '%.mp3'
                              ORDER BY idx`).all(book.id).map((t) => t.path)
    .filter((p) => fs.existsSync(p));
  if (!sources.length) throw new Error('Every file of that book is already an MP3.');

  let seconds = 0;
  for (const src of sources) seconds += (await probe(src)).duration;
  Object.assign(convertProgress, {
    running: true, done: 0, total: Math.max(1, Math.round(seconds / 60)),
    current: book.title, error: '', book: book.id,
  });
  let done = 0;
  const onSeconds = (s) => {
    done += s;
    convertProgress.done = Math.min(convertProgress.total, Math.round(done / 60));
  };

  const keep = path.join(keepRootFor(book.path), `${Date.now()}-${path.basename(book.path)}`);
  try {
    await coverFrom(sources[0]);
    let no = 1;
    let bytes = 0;
    for (const src of sources) {
      const made = await convertOne(src, no, onSeconds);
      no += made.length;
      // the chapter's name is the track's name, which is what the player lists
      for (const m of made) await writeTag(m.file, { title: m.title });
      bytes += fs.statSync(src).size;
      fs.mkdirSync(keep, { recursive: true });
      fs.renameSync(src, path.join(keep, path.basename(src)));
    }
    db.prepare(`INSERT INTO converted (path, was_path, genre, author, series, title, files, bytes, converted_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(keep, book.path, book.genre, book.author, book.series, book.title,
        sources.length, bytes, new Date().toISOString());
    // the book is its new files now: read the folder again
    await addOne({ genre: book.genre, author: book.author, series: book.series, dir: book.path, force: true });
    return { files: sources.length, kept: keep };
  } catch (e) {
    convertProgress.error = e.message;
    throw e;
  } finally {
    convertProgress.running = false;
  }
}
