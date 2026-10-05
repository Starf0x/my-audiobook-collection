import fs from 'node:fs';
import path from 'node:path';
import { db, DATA_DIR } from './db.js';
import { writeZipTo } from './zip.js';

// Cover files are named after the image itself, so a book that gets new artwork
// leaves its old file behind. Nothing reads those any more, but they are not
// rubbish either: they are moved aside rather than deleted.
const coversDir = () => path.join(DATA_DIR, 'covers');
const dupesDir = () => path.join(coversDir(), 'duplicates');
const isImage = (name) => /\.(jpe?g|png)$/i.test(name);

// What a cover file may be, decided by the bytes rather than by anything that
// came with them. This file keeps `.jpg` and `.png` and nothing else — `isImage`
// just above is the same rule — and those are the two an MP3 tag takes without
// argument, so anything else is named rather than renamed: a WebP written into
// covers/ would be passed over by the tidy-up and shrug its way into a tag no
// player would draw.
//
// It lives here rather than beside either of the two routes that need it,
// because both have to answer the same way: one takes a picture pasted by the
// admin, the other a thumbnail a lookup offered, and for a while only the first
// of them asked.
export const pictureKind = (b) => {
  const starts = (n, ...bytes) => b.length > n && bytes.every((v, i) => b[i] === v);
  if (starts(3, 0xff, 0xd8, 0xff)) return { ext: '.jpg', what: 'JPEG' };
  if (starts(8, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { ext: '.png', what: 'PNG' };
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF'
    && b.subarray(8, 12).toString('latin1') === 'WEBP') return { what: 'WebP' };
  if (b.length > 4 && b.subarray(0, 3).toString('latin1') === 'GIF') return { what: 'GIF' };
  return null;
};

const ZIP_AT = 1000;

const loose = () => (fs.existsSync(dupesDir())
  ? fs.readdirSync(dupesDir(), { withFileTypes: true })
    .filter((e) => e.isFile() && isImage(e.name)).map((e) => e.name)
  : []);

export function tidyCovers() {
  const used = new Set(db.prepare("SELECT DISTINCT cover FROM books WHERE cover IS NOT NULL AND cover <> ''")
    .all().map((r) => r.cover)
    // a cover taken from the book's own folder stays there, it was never copied
    .filter((c) => !c.startsWith('file:')));

  fs.mkdirSync(dupesDir(), { recursive: true });
  let moved = 0;
  let kept = 0;
  for (const e of fs.readdirSync(coversDir(), { withFileTypes: true })) {
    if (!e.isFile() || !isImage(e.name)) continue;
    if (used.has(e.name)) { kept++; continue; }
    const to = path.join(dupesDir(), e.name);
    fs.rmSync(to, { force: true }); // the same image moved aside twice: overwrite
    fs.renameSync(path.join(coversDir(), e.name), to);
    moved++;
  }
  const duplicates = loose().length;
  return { moved, kept, duplicates, tooMany: duplicates > ZIP_AT, zipAt: ZIP_AT };
}

export function deleteDuplicates() {
  let deleted = 0;
  for (const name of loose()) { fs.rmSync(path.join(dupesDir(), name), { force: true }); deleted++; }
  return { deleted };
}

// Keeping them, but as one file: everything loose goes into a zip beside them and
// the loose copies go. Any zip made earlier is left alone.
//
// The archive is written by `zip.js`, which a book download already uses. There
// used to be a second implementation here, with its own CRC table, whose comment
// promised it held one file at a time and whose last line concatenated every one
// of them. One zip writer, and it is the one that streams.
export async function zipDuplicates(stamp) {
  const names = loose();
  if (!names.length) throw new Error('There is nothing in the duplicates folder to zip');
  const zip = path.join(dupesDir(), `covers-${stamp}.zip`);
  const entries = names.map((name) => {
    const from = path.join(dupesDir(), name);
    return { name, path: from, size: fs.statSync(from).size };
  });
  const out = fs.createWriteStream(zip);
  await writeZipTo(out, entries);
  await new Promise((ok, no) => { out.on('close', ok); out.on('error', no); });
  for (const name of names) fs.rmSync(path.join(dupesDir(), name), { force: true });
  return { zip, zipped: names.length, bytes: fs.statSync(zip).size };
}
