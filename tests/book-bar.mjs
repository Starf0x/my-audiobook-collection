// book-bar — the player's bar measures the book, not the file playing.
//
// A book is usually many files. The bar under the player read
// `audio.currentTime / audio.duration`, which is the file: it filled up and
// started again at every track, and the numbers beside it counted the same way —
// a book 1:10 long, two minutes in, said "0:40 of 3:11". Frank sent a picture of
// exactly that. It is the 2.1.48 scar the other way round: there a tile counted
// tracks, so a one-file book stood full from its first minute.
//
// What is checked here is the arithmetic itself, read out of `public/player.js`
// and run — not a copy of it kept in step by hand, which would agree with itself
// for ever while the page did something else. The two functions are pure, which
// is why they are their own functions: everything around them is the DOM.
//
// Run: node tests/book-bar.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
};

// --- the real thing, lifted out of the page -------------------------------
// From `const <name> = ` to the `};` that closes it at the start of a line.
// Anything else — a rename, a reshape into a method — fails loudly here rather
// than leaving a check that tests nothing.
const source = fs.readFileSync(path.join(ROOT, 'public', 'player.js'), 'utf8');
const lift = (name) => {
  const from = source.indexOf(`const ${name} = `);
  if (from < 0) throw new Error(`player.js no longer declares ${name}`);
  const to = source.indexOf('\n};', from);
  if (to < 0) throw new Error(`cannot find the end of ${name}`);
  return source.slice(from, to + 3);
};

// `bookTime` reads `state`; nothing else of the page reaches these two.
const state = { book: null, track: 0 };
// eslint-disable-next-line no-new-func -- the point is to run the shipped code
const run = new Function('state', `${lift('bookTime')}\n${lift('trackAt')}\nreturn { bookTime, trackAt };`);
const { bookTime, trackAt } = run(state);

const book = (...durations) => ({ tracks: durations.map((d, i) => ({ idx: i, duration: d })) });

// --- how long the book is, and how far in this track starts ---------------
state.book = book(60, 10);
state.track = 0;
check('the book is as long as its files together', bookTime().total, 70);
check('and the first track starts at the beginning', bookTime().behind, 0);
state.track = 1;
check('the second starts where the first ended', bookTime().behind, 60);

state.book = book(1800, 1800, 1800);
state.track = 2;
check('three half-hours make an hour and a half', [bookTime().total, bookTime().behind], [5400, 3600]);

// --- when the sum cannot be trusted, say nothing --------------------------
// A book of one file is the case the old code got right by accident, and a
// length the scan never read would make the total a lie. Both fall back to the
// file, which is the one thing still certainly true.
state.book = book(3600);
state.track = 0;
check('a book of one file has nothing to add up', bookTime(), null);
state.book = book(60, 0, 60);
state.track = 0;
check('nor has one whose middle file has no length', bookTime(), null);
state.book = book(60, null, 60);
check('nor one with no length at all', bookTime(), null);
state.book = { tracks: [] };
check('nor a book with no files', bookTime(), null);

// --- which file holds a given second of the book --------------------------
const two = book(60, 10).tracks;
check('the start of the book is the start of the first file', trackAt(0, two), { idx: 0, offset: 0 });
check('seven seconds in is still the first file', trackAt(7, two), { idx: 0, offset: 7 });
check('the second the first file ends is the second file',
  trackAt(60, two), { idx: 1, offset: 0 });
check('sixty-three is three seconds into the second file',
  trackAt(63, two), { idx: 1, offset: 3 });

// The far right of the bar, and past it. The last track keeps the remainder:
// the bar is a place in the book, and there is no file after the last one.
check('the end of the book is the end of the last file', trackAt(70, two), { idx: 1, offset: 10 });
check('past the end stays in the last file', trackAt(999, two), { idx: 1, offset: 939 });
check('before the beginning is the beginning', trackAt(-5, two), { idx: 0, offset: 0 });
check('and a number that is not one is the beginning too',
  trackAt(undefined, two), { idx: 0, offset: 0 });

// Files of different lengths, because the walk exists for exactly that: a
// division by an average would land in the wrong file on every book like this.
const uneven = book(10, 600, 20).tracks;
check('a long middle file is walked into, not divided into',
  trackAt(300, uneven), { idx: 1, offset: 290 });
check('and the short one after it is found at the right second',
  trackAt(615, uneven), { idx: 2, offset: 5 });

console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
