// A zip of a whole book, streamed.
//
// The browser's own audio controls used to offer a download of the one track that
// was playing. A book is not one file, so the app offers the book: every audio
// file it is made of, in one archive.
//
// Nothing is held in memory. The files are **stored**, not deflated — an MP3 is
// already compressed, so deflating it costs CPU for nothing — which has a second
// benefit: with the sizes known from the disk beforehand, the exact length of the
// archive can be worked out before a byte is sent, so the browser can show how
// far along the download is instead of a spinner with no end.
//
// The format, for whoever has to touch this: a local header per file, the file's
// bytes, a data descriptor (the CRC is only known once the bytes have gone past),
// then a directory of all of it and an end record. ZIP64 fields appear only where
// a file, an offset or the archive itself passes 4 GB, because some readers still
// dislike seeing them where they are not needed.
import fs from 'node:fs';
import path from 'node:path';

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crcOf = (buf, running) => {
  let c = running;
  for (const b of buf) c = CRC[(c ^ b) & 0xFF] ^ (c >>> 8);
  return c >>> 0;
};

const BIG = 0xFFFFFFFF;
const FLAGS = 0x0008 | 0x0800; // a data descriptor follows; the name is UTF-8
const NO_DATE = 0x0021; // 1 Jan 1980, the format's own zero

// What one entry adds to the archive, so the total can be promised up front.
const entryBytes = (name, size) => {
  const n = Buffer.byteLength(name, 'utf8');
  const zip64 = size > BIG;
  return 30 + n + (zip64 ? 20 : 0) // local header, name, its zip64 extra
    + size
    + (zip64 ? 24 : 16); // data descriptor
};
const dirBytes = (name, size, offset) => {
  const n = Buffer.byteLength(name, 'utf8');
  const fields = (size > BIG ? 16 : 0) + (offset > BIG ? 8 : 0);
  return 46 + n + (fields ? fields + 4 : 0);
};

// Every name in one archive has to be unique, and two discs can both hold a
// "01.mp3": the second one becomes "01 (2).mp3" rather than overwriting the first.
export function uniqueNames(files) {
  const seen = new Map();
  return files.map((file) => {
    const base = path.basename(file);
    const n = (seen.get(base.toLowerCase()) || 0) + 1;
    seen.set(base.toLowerCase(), n);
    if (n === 1) return base;
    const dot = base.lastIndexOf('.');
    return dot > 0 ? `${base.slice(0, dot)} (${n})${base.slice(dot)}` : `${base} (${n})`;
  });
}

// How long the archive will be, exactly. Only possible because nothing is
// compressed; the moment anything is deflated this has to go.
export function zipLength(entries) {
  let offset = 0;
  let central = 0;
  let anyBig = false;
  for (const e of entries) {
    central += dirBytes(e.name, e.size, offset);
    offset += entryBytes(e.name, e.size);
    if (e.size > BIG) anyBig = true;
  }
  const needs64 = anyBig || offset > BIG || central > BIG || entries.length > 0xFFFF;
  return offset + central + (needs64 ? 56 + 20 : 0) + 22;
}

const local = (name, size) => {
  const n = Buffer.from(name, 'utf8');
  const zip64 = size > BIG;
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(zip64 ? 45 : 20, 4);
  head.writeUInt16LE(FLAGS, 6);
  head.writeUInt16LE(0, 8); // stored
  head.writeUInt16LE(NO_DATE, 12);
  // crc and both sizes are zero here and given in the descriptor below
  head.writeUInt16LE(n.length, 26);
  head.writeUInt16LE(zip64 ? 20 : 0, 28);
  if (!zip64) return Buffer.concat([head, n]);
  const extra = Buffer.alloc(20);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(16, 2);
  // placeholders: the descriptor carries the real numbers
  return Buffer.concat([head, n, extra]);
};

const descriptor = (crc, size) => {
  const zip64 = size > BIG;
  const d = Buffer.alloc(zip64 ? 24 : 16);
  d.writeUInt32LE(0x08074b50, 0);
  d.writeUInt32LE(crc, 4);
  if (zip64) {
    d.writeBigUInt64LE(BigInt(size), 8);
    d.writeBigUInt64LE(BigInt(size), 16);
  } else {
    d.writeUInt32LE(size, 8);
    d.writeUInt32LE(size, 12);
  }
  return d;
};

const dirEntry = ({ name, size, crc, offset }) => {
  const n = Buffer.from(name, 'utf8');
  const bigSize = size > BIG;
  const bigOffset = offset > BIG;
  const extraLen = (bigSize ? 16 : 0) + (bigOffset ? 8 : 0);
  const e = Buffer.alloc(46);
  e.writeUInt32LE(0x02014b50, 0);
  e.writeUInt16LE(bigSize || bigOffset ? 45 : 20, 4);
  e.writeUInt16LE(bigSize || bigOffset ? 45 : 20, 6);
  e.writeUInt16LE(FLAGS, 8);
  e.writeUInt16LE(0, 10); // stored
  e.writeUInt16LE(NO_DATE, 14);
  e.writeUInt32LE(crc, 16);
  e.writeUInt32LE(bigSize ? BIG : size, 20);
  e.writeUInt32LE(bigSize ? BIG : size, 24);
  e.writeUInt16LE(n.length, 28);
  e.writeUInt16LE(extraLen ? extraLen + 4 : 0, 30);
  e.writeUInt32LE(bigOffset ? BIG : offset, 42);
  if (!extraLen) return Buffer.concat([e, n]);
  const extra = Buffer.alloc(extraLen + 4);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(extraLen, 2);
  let at = 4;
  if (bigSize) {
    extra.writeBigUInt64LE(BigInt(size), at); at += 8;
    extra.writeBigUInt64LE(BigInt(size), at); at += 8;
  }
  if (bigOffset) extra.writeBigUInt64LE(BigInt(offset), at);
  return Buffer.concat([e, n, extra]);
};

const endRecords = (count, centralSize, centralAt) => {
  const needs64 = count > 0xFFFF || centralSize > BIG || centralAt > BIG;
  const parts = [];
  if (needs64) {
    const z = Buffer.alloc(56);
    z.writeUInt32LE(0x06064b50, 0);
    z.writeBigUInt64LE(44n, 4);
    z.writeUInt16LE(45, 12);
    z.writeUInt16LE(45, 14);
    z.writeBigUInt64LE(BigInt(count), 24);
    z.writeBigUInt64LE(BigInt(count), 32);
    z.writeBigUInt64LE(BigInt(centralSize), 40);
    z.writeBigUInt64LE(BigInt(centralAt), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(centralAt + centralSize), 8);
    loc.writeUInt32LE(1, 16);
    parts.push(z, loc);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(needs64 ? 0xFFFF : count, 8);
  end.writeUInt16LE(needs64 ? 0xFFFF : count, 10);
  end.writeUInt32LE(needs64 ? BIG : centralSize, 12);
  end.writeUInt32LE(needs64 ? BIG : centralAt, 16);
  parts.push(end);
  return Buffer.concat(parts);
};

// Write the archive to a stream, one file at a time. Backpressure is respected:
// a book is bigger than any socket buffer, and ignoring `write`'s answer is how a
// container runs out of memory sending one.
export async function writeZipTo(out, entries) {
  const dir = [];
  let offset = 0;
  const put = (buf) => new Promise((ok, no) => {
    if (out.write(buf)) return ok();
    out.once('drain', ok);
    out.once('error', no);
  });

  for (const e of entries) {
    const head = local(e.name, e.size);
    await put(head);
    let crc = 0xFFFFFFFF;
    let sent = 0;
    const file = fs.createReadStream(e.path, { highWaterMark: 1 << 20 });
    for await (const chunk of file) {
      // never more than was promised: a file that grew since the stat would push
      // every later offset out and leave the reader with a broken directory
      const piece = sent + chunk.length > e.size ? chunk.subarray(0, e.size - sent) : chunk;
      crc = crcOf(piece, crc);
      sent += piece.length;
      await put(piece);
      if (sent >= e.size) break;
    }
    file.destroy();
    // The length promised in Content-Length came from the size on disk. A file
    // that grew or shrank while it was being read would break the promise, so
    // pad or cut to what was promised rather than send a broken archive.
    if (sent < e.size) {
      const pad = Buffer.alloc(Math.min(e.size - sent, 1 << 20));
      let left = e.size - sent;
      while (left > 0) {
        const piece = left >= pad.length ? pad : pad.subarray(0, left);
        crc = crcOf(piece, crc);
        await put(piece);
        left -= piece.length;
      }
      sent = e.size;
    }
    crc = (crc ^ 0xFFFFFFFF) >>> 0;
    await put(descriptor(crc, e.size));
    dir.push({ name: e.name, size: e.size, crc, offset });
    offset += head.length + e.size + (e.size > BIG ? 24 : 16);
  }

  const central = Buffer.concat(dir.map(dirEntry));
  await put(central);
  await put(endRecords(dir.length, central.length, offset));
  out.end();
}
