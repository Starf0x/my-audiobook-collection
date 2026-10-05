// An ID3 tag bolted on the front of a file that is not an MP3.
//
// Taggers meant for MP3 write one anyway, onto `.ogg`, `.flac` and `.m4b`. The
// demuxer will not look past it: ffmpeg says "Invalid data found when processing
// input" for the whole file, and `music-metadata` does something quieter and
// worse — it reports no container at all, which this app reads as "nothing in it
// that a reader recognises as audio". Four of Frank's books sat in the library
// for weeks with no length and no tags because of exactly this.
//
// The tag says how long it is, so both readers can be told where the audio
// really starts. It lives in a module of its own because the two that need it
// cannot reach each other: `convert.js` imports `scan.js`, so `scan.js` cannot
// import back.
//
// On an MP3 the tag belongs where it is and is never skipped.
import fs from 'node:fs';

export function id3Skip(file) {
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
    // whatever is wrong with this file, whoever opens it next will say so
    return 0;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
