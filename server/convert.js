import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { db, DATA_DIR, getLibraries } from './db.js';
import { addOne } from './scan.js';
import { writeTag } from './tagpool.js';

// ffmpeg and ffprobe are not in the image: they are uploaded in Settings and kept
// here, so the container stays small and nothing is fetched behind the owner's
// back. They have to be static Linux builds for the architecture the container
// runs on — `-version` is asked of them once, which is the proof that they run.
export const BIN_DIR = path.join(DATA_DIR, 'bin');
export const TOOLS = ['ffmpeg', 'ffprobe'];
// the container is Linux; the suites run this server on Windows, where a program
// is only a program with its extension
export const toolAt = (name) =>
  path.join(BIN_DIR, process.platform === 'win32' ? `${name}.exe` : name);
export const haveTools = () => TOOLS.every((t) => fs.existsSync(toolAt(t)));

export function toolStatus() {
  return TOOLS.map((name) => {
    const file = toolAt(name);
    if (!fs.existsSync(file)) return { name, present: false, version: '', error: '' };
    const size = fs.statSync(file).size;
    const r = spawnSync(file, ['-version'], { encoding: 'utf8', timeout: 15000 });
    // what it says about itself, or why it will not run: a file that was uploaded
    // for the wrong architecture fails here and nowhere else
    const line = String(r.stdout || '').split('\n')[0].trim();
    return {
      name, present: true, size,
      version: r.status === 0 ? line : '',
      error: r.status === 0 ? '' : (r.error?.code === 'ENOEXEC'
        ? 'This file will not run here: it is not a build for this container’s architecture.'
        : (r.error?.message || String(r.stderr || '').split('\n')[0] || `exited ${r.status}`)),
    };
  });
}

export function saveTool(name, tmpFile) {
  if (!TOOLS.includes(name)) throw new Error(`Not a tool this app runs: ${name}`);
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const dest = toolAt(name);
  // the copy that is there has to go first, or a newer build cannot replace it:
  // renaming over a program that has just been run is refused
  fs.rmSync(dest, { force: true });
  fs.renameSync(tmpFile, dest);
  fs.chmodSync(dest, 0o755);
  return toolStatus().find((t) => t.name === name);
}

// --- running them ------------------------------------------------------
const run = (file, args, onOut) => new Promise((resolve, reject) => {
  const p = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  p.stdout.on('data', (d) => { if (onOut) onOut(String(d)); else out += d; });
  // the last of it is what a failure is explained with; the rest is banner
  p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
  p.on('error', (e) => reject(new Error(`${path.basename(file)} would not run: ${e.message}`)));
  p.on('close', (code) => (code === 0 ? resolve(out)
    : reject(new Error(err.trim().split('\n').filter(Boolean).pop() || `${path.basename(file)} exited ${code}`))));
});

async function probe(file) {
  const out = await run(toolAt('ffprobe'),
    ['-v', 'quiet', '-print_format', 'json', '-show_chapters', '-show_format', file]);
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
    '-i', src, '-vn', '-map_metadata', '0', '-c:a', 'libmp3lame', '-q:a', '4'];
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
  await run(toolAt('ffmpeg'), ['-hide_banner', '-nostdin', '-y', '-i', src, '-an', '-vframes', '1', dest])
    .catch(() => { fs.rmSync(dest, { force: true }); });
}

export async function convertBook(id) {
  if (!haveTools()) {
    throw new Error('ffmpeg and ffprobe have not been uploaded yet — Settings → Conversion tools.');
  }
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
