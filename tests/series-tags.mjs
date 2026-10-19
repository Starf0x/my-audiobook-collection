// series-tags — the series a book's files say, and taking it off again.
//
// The owner's "Outlanders 50 - Janus Trap" read Series · 123 on its card, and the
// dialog could not remove it. Three things were wrong, and each is asked here
// of real MP3s with real frames in them, scanned the way the app scans:
//
//  * a number on its own was taken as a series' name — "123" in a frame made a
//    series nobody could explain, and one already kept survived every scan;
//  * a series that lived only in the tags could not be cleared: an empty
//    series from the dialog reads as "nothing to say", and even cleared in the
//    database the next scan read it back out of the files;
//  * a SERIES text frame was never read at all — the scanner looked for a
//    shape music-metadata does not produce.
//
// Run: node tests/series-tags.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import NodeID3 from 'node-id3';
import { parseFile } from 'music-metadata';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HERE = path.join(ROOT, 'fixtures', 'series-tags-test');
const LIB = path.join(HERE, 'audiobooks');
const DATA = path.join(HERE, 'data');

let failed = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
};

// one silent MPEG frame, repeated: a file the readers accept as audio
const FRAME = Buffer.from(`fffb10c4${'00'.repeat(100)}`, 'hex');
const mp3 = (n) => Buffer.concat(Array(n).fill(FRAME));

fs.rmSync(HERE, { recursive: true, force: true });
// Filed straight under the author, so no folder names a series: whatever the
// card says comes from the files.
const book = (title, tags = null) => {
  const dir = path.join(LIB, 'Science Fiction', 'James Axler', title);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '01.mp3');
  fs.writeFileSync(file, mp3(40));
  if (tags) NodeID3.update(tags, file);
  return file;
};
book('Janus Trap', { title: 'Janus Trap', album: 'Janus Trap', contentGroup: '123' });
const outlanders = book('Doom Dynasty', { title: 'Doom Dynasty', album: 'Doom Dynasty', contentGroup: 'Outlanders 50' });
book('Skydark Spawn', {
  title: 'Skydark Spawn', album: 'Skydark Spawn',
  userDefinedText: [{ description: 'series', value: 'Deathlands' }],
});
book('Untagged Book');

fs.mkdirSync(DATA, { recursive: true });
process.env.DATA_DIR = DATA;
const { db, setSetting } = await import('../server/db.js');
const { scan } = await import('../server/scan.js');
const { applyMetadata } = await import('../server/google.js');

setSetting('libraries', JSON.stringify([{ path: LIB, asGenre: false }]));
await scan();

const row = (title) => db.prepare('SELECT * FROM books WHERE title = ?').get(title);
const said = (title) => {
  const b = row(title);
  return b ? [b.tag_series, b.series_no] : null;
};

// --- what the files say -------------------------------------------------------
check('a frame holding only a number gives no series', said('Janus Trap'), ['', 0]);
check('a frame holding a name and a number gives both', said('Doom Dynasty'), ['Outlanders', 50]);
check('and a SERIES text frame is read at all', said('Skydark Spawn'), ['Deathlands', 0]);

// A number kept before this rule, on a book whose files say nothing: the next
// scan lets go of it rather than keeping it for ever.
db.prepare("UPDATE books SET tag_series = '123' WHERE title = 'Untagged Book'").run();
await scan();
check('a number kept from before is let go of by the next scan', said('Untagged Book'), ['', 0]);

// --- taking a series off --------------------------------------------------------
// A lookup whose series was unticked sends an empty one, and that must leave the
// book's series exactly where it is.
await applyMetadata(row('Skydark Spawn'), { series: '' }, false);
check('an empty series from a lookup leaves the series alone', said('Skydark Spawn'), ['Deathlands', 0]);

// The dialog, emptied and saved with the tags written: gone from the book and
// from the files, so the next scan has nothing to read back.
await applyMetadata(row('Doom Dynasty'), { clearSeries: true }, true);
check('cleared, the series comes off the book', said('Doom Dynasty'), ['', 0]);
const inFile = await parseFile(outlanders);
check('and out of the files', inFile.common.grouping ?? '', '');
await scan();
check('so a scan afterwards does not read it back', said('Doom Dynasty'), ['', 0]);

console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
