import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { db, DATA_DIR } from './db.js';

// Cover files are named after the image itself, so a book that gets new artwork
// leaves its old file behind. Nothing reads those any more, but they are not
// rubbish either: they are moved aside rather than deleted.
const coversDir = () => path.join(DATA_DIR, 'covers');
const dupesDir = () => path.join(coversDir(), 'duplicates');
const isImage = (name) => /\.(jpe?g|png)$/i.test(name);

export const ZIP_AT = 1000;

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
export function zipDuplicates(stamp) {
  const names = loose();
  if (!names.length) throw new Error('There is nothing in the duplicates folder to zip');
  const zip = path.join(dupesDir(), `covers-${stamp}.zip`);
  writeZip(zip, names.map((name) => ({ name, body: fs.readFileSync(path.join(dupesDir(), name)) })));
  for (const name of names) fs.rmSync(path.join(dupesDir(), name), { force: true });
  return { zip, zipped: names.length, bytes: fs.statSync(zip).size };
}

// --- a zip file, written by hand ----------------------------------------
// One archive of small images does not justify a dependency, and the format is
// three structures: a header per file, a directory of those, and an end record.
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
};

function writeZip(out, files) {
  const parts = [];
  const dir = [];
  let offset = 0;
  for (const f of files) {
    const data = zlib.deflateRawSync(f.body);
    const crc = crc32(f.body);
    const name = Buffer.from(f.name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(8, 8);           // deflate
    local.writeUInt16LE(0x0021, 12);     // 1 Jan 1980, the format's zero date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(f.body.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(0x0021, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(f.body.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    dir.push(entry, name);

    offset += local.length + name.length + data.length;
  }
  const central = Buffer.concat(dir);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(out, Buffer.concat([...parts, central, end]));
}
