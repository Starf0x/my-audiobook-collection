// What "finished" means, in one place.
//
// Three things in this app have meant some version of the word, and they are not
// the same thing. Keeping them apart is deliberate; keeping the *rule* for each
// in one place is what this file is for, because two of them used to be worked
// out in two files and drifted:
//
//   * `progress.done` — **ticked**. Somebody said they are done with this book,
//     by hand or by playing it out. It can be taken off again. It is an input to
//     the question below, not an answer anybody should be shown on its own.
//   * `completions`   — **played to the end**. What this app watched happen,
//     kept for ever and never rewritten (§7.12b). Levels are counted from it, so
//     ticking a book by hand cannot earn one. That lives in `listeners.js`,
//     because it is a record about a listener rather than a place in a book.
//   * `countsAsRead()` here — **ticked, or sitting at the end anyway**. The
//     question every list and every count of "listened" asks. Not stored: worked
//     out from a row as it is served.
//
// The last one being worked out rather than stored is the whole reason it has to
// be in one place. A tick is written once, under the rules as they stood at that
// moment; counting as read is decided now, under the rules as they stand now. A
// database old enough to hold rows from before this app ticked a book that
// played out, or re-scanned since so a track's real duration moved the end of it
// under a place already kept, has rows where the two disagree — and then a page
// that counts ticks and a list that counts reads sit on one screen saying four
// and one, with nothing to say which is right. That is 2.10.32: `/api/stats` and
// the accounts page both asked the stored question, and both now ask this one.
//
// This file imports nothing but the database, so both `index.js` and
// `listeners.js` can have it without either importing the other.
import { db } from './db.js';

// A book counts as read when the tick says so, or when the place kept in it sits
// at the end of its last track: pressing Resume on one of those plays its last
// seconds and stops, so it is offered again from the top instead. The grace is a
// tenth of the track and never more than a minute — a player rarely stops on the
// second, and a flat minute would call the whole of a short track the end of it.
//
// This used to be called `isFinished`, which is the name Audiobookshelf uses on
// the wire for something else — its field is the tick alone — so the same word
// meant two things one file apart, in `abs.js` and here.
export const countsAsRead = (b) => !!b.done
  || (b.track_idx >= b.tracks - 1 && b.trackSeconds > 0
      && b.position >= b.trackSeconds - Math.min(60, b.trackSeconds / 10));

// The four numbers `countsAsRead` asks for, for one book. Callers that already
// have a row with `done`, `track_idx`, `position`, `tracks` and `trackSeconds`
// on it do not need this.
export const keptOne = db.prepare(`SELECT p.done, p.track_idx, p.position,
    (SELECT COUNT(*) FROM tracks t WHERE t.book_id = p.book_id) AS tracks,
    (SELECT t.duration FROM tracks t WHERE t.book_id = p.book_id AND t.idx = p.track_idx) AS trackSeconds
  FROM progress p WHERE p.user = ? AND p.book_id = ?`);

const keptAll = db.prepare(`SELECT p.done, p.track_idx, p.position,
    (SELECT COUNT(*) FROM tracks t WHERE t.book_id = p.book_id) AS tracks,
    (SELECT t.duration FROM tracks t WHERE t.book_id = p.book_id AND t.idx = p.track_idx) AS trackSeconds
  FROM progress p JOIN books b ON b.id = p.book_id WHERE p.user = ?`);

// How many books this listener has read, by the rule above. The join to `books`
// is not decoration: a place can outlive the book it names between a scan
// dropping the book and the trigger clearing the row, and a count that included
// those would be larger than any list could ever show.
//
// It counts in JavaScript rather than SQL on purpose. The rule says the same
// thing either way until somebody changes one of them, and the point of this
// file is that there is nothing to keep in step.
export const readCount = (user) => keptAll.all(user || '').filter(countsAsRead).length;
