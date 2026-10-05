// ogg-lengths — a tag meant for an MP3, bolted onto a file that is not one.
//
// Taggers written for MP3 put an ID3 tag on the front of `.ogg`, `.flac` and
// `.m4b` files as well. The demuxer will not look past it, and `music-metadata`
// does not throw about it — it answers with no container at all, which this app
// reads as "nothing in it that a reader recognises as audio". Four of Frank's
// books sat in the library for weeks with a length of 0 and no tags, and the
// reason was written into a comment in `convert.js` in 2.3.40, where the
// converter learned to step over the tag and the scan was not told.
//
// So this builds the case rather than describing it: a real Ogg Vorbis file,
// then the same one with an ID3 tag bolted on the front, and asks the scan.
//
// Needs ffmpeg to make the audio, which the image has from 2.3.0 on. Without it
// the suite says so and passes nothing, rather than passing on an empty library.
//
// Run: node tests/ogg-lengths.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HERE = path.join(ROOT, 'fixtures', 'ogg-lengths-test');
const LIB = path.join(HERE, 'audiobooks');
const DATA = path.join(HERE, 'data');

let failed = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
};

const ffmpeg = (args) => execFileSync('ffmpeg', ['-v', 'error', ...args]);
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  console.log('(no ffmpeg here, and this suite needs one to make an Ogg: nothing checked)');
  process.exit(0);
}

fs.rmSync(HERE, { recursive: true, force: true });
const book = path.join(LIB, 'Fantasy', 'Test Author', 'The Tagged Book');
fs.mkdirSync(book, { recursive: true });
fs.mkdirSync(DATA, { recursive: true });

// seven seconds of silence, really encoded, so the header carries a real length
const plain = path.join(HERE, 'plain.ogg');
ffmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '7', '-c:a', 'libvorbis', '-y', plain]);
const audio = fs.readFileSync(plain);

// An ID3v2 tag of its own: 'ID3', version, flags, then the size as four
// seven-bit bytes, big endian — which is the shape `id3Skip` reads back.
const id3 = (bytes) => {
  const head = Buffer.alloc(10);
  head.write('ID3', 0, 'latin1');
  head[3] = 3;
  for (let i = 0; i < 4; i++) head[9 - i] = (bytes >> (7 * i)) & 0x7f;
  return Buffer.concat([head, Buffer.alloc(bytes)]);
};

// one file as it should be, one with a tag in front of it
fs.writeFileSync(path.join(book, '01 - Clean.ogg'), audio);
fs.writeFileSync(path.join(book, '02 - Tagged.ogg'), Buffer.concat([id3(1000), audio]));

process.env.DATA_DIR = DATA;
const { db, setSetting } = await import('../server/db.js');
const { scan } = await import('../server/scan.js');

setSetting('libraries', JSON.stringify([{ path: LIB, asGenre: false }]));
await scan();

const row = db.prepare('SELECT id, title, duration FROM books').get();
check('the book is found', !!row, true);
const tracks = db.prepare('SELECT title, duration FROM tracks WHERE book_id = ? ORDER BY idx').all(row?.id);

// The one without a tag has always worked; it is here so that a failure of the
// other one cannot be blamed on the fixture or on ffmpeg.
check('the plain file has its length', Math.round(tracks[0]?.duration || 0), 7);
check('and so does the one with an ID3 tag in front of it',
  Math.round(tracks[1]?.duration || 0), 7);
check('so the book is as long as both of them', Math.round(row?.duration || 0), 14);

// The same mistake had a second face: a file the reader made nothing of was
// written down as having no audio in it, so the book turned up on *Broken on
// disk* as well as showing no length.
const broken = db.prepare('SELECT reason, detail FROM broken').all();
check('and neither file is called unreadable', broken, []);

console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
