// Books somebody has asked for and the collection has not got.
//
// A listener types an author and a title; the administrator is told, goes and
// finds it, and drops it in. When the scan picks the book up, the request that
// asked for it is answered without anybody having to remember it was open — the
// book becomes that person's favourite and they are told the next time they
// open the app.
//
// **Matching is the whole of the difficulty.** The person asking types what
// they remember; the book arrives named whatever the file was named. So the two
// are compared normalised — case, punctuation, a leading article and the word
// "the" inside a name all taken off — and even then it will miss: *Mistborn*
// asked for, *Mistborn: The Final Empire* delivered. So the administrator can
// tie a request to a book by hand, and that is not a fallback bolted on but
// half of the design: an automatic match that silently never happens is worse
// than no automatic match, because nothing says so.
//
// What this does **not** do is guess twice. A request is answered by exactly
// one book, and a match that is not exact enough to be certain is left for a
// person, because the cost of a wrong match is somebody's favourite being a
// book they did not ask for.
import { db } from './db.js';

// How two names are compared.
//
// Lowercased, accents folded, anything that is not a letter or a digit turned
// into a single space, and a leading article dropped. "The Dark Tower" and
// "dark tower" meet here; so do "Mistborn (Book 1)" and "Mistborn Book 1".
//
// Deliberately **not** a fuzzy distance. An edit distance of two makes *Dune*
// match *June*, and a wrong match hands somebody a favourite they did not ask
// for and closes a request they are still waiting on. Exact-after-normalising
// is a rule a person can predict, and what it misses the administrator ties by
// hand.
export const norm = (s) => String(s ?? '')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/^(the|a|an) /, '')
  .trim();

const key = (author, title) => `${norm(author)}\u0000${norm(title)}`;

const row = (r) => (r ? { ...r, told: !!r.told } : null);

// --- asking ---------------------------------------------------------------

export function askFor({ who, author, title, note = '' }) {
  const asked = { who: String(who || '').trim(), author: String(author || '').trim(), title: String(title || '').trim() };
  if (!asked.who) throw new Error('Sign in first.');
  if (!asked.author || !asked.title) throw new Error('An author and a title, please — both.');
  if (asked.author.length > 200 || asked.title.length > 300) throw new Error('That is longer than a name.');
  // The same person asking for the same book twice is one request, not two.
  // They have probably forgotten, and two rows would be two things for the
  // administrator to decide about.
  const open = db.prepare("SELECT * FROM requests WHERE who = ? AND state = 'open'").all(asked.who);
  const already = open.find((r) => key(r.author, r.title) === key(asked.author, asked.title));
  if (already) return { ...row(already), again: true };

  const id = db.prepare(`INSERT INTO requests (who, author, title, note, state, asked_at)
                         VALUES (?, ?, ?, ?, 'open', ?)`)
    .run(asked.who, asked.author, asked.title, String(note || '').slice(0, 500), new Date().toISOString())
    .lastInsertRowid;
  return row(db.prepare('SELECT * FROM requests WHERE id = ?').get(id));
}

// --- reading --------------------------------------------------------------

export const openOnes = () => db.prepare("SELECT * FROM requests WHERE state = 'open' ORDER BY asked_at").all().map(row);

export const howManyOpen = () => db.prepare("SELECT COUNT(*) AS n FROM requests WHERE state = 'open'").get().n;

// Everything, newest decision first, with the book's title where one answered
// it — the administrator's list, and the per-person counts on the accounts page
// come off the same rows.
export const all = () => db.prepare(`
  SELECT r.*, b.title AS bookTitle, b.author AS bookAuthor
  FROM requests r LEFT JOIN books b ON b.id = r.book_id
  ORDER BY CASE r.state WHEN 'open' THEN 0 ELSE 1 END, r.asked_at DESC`).all().map(row);

export const of_ = (who) => db.prepare(`
  SELECT r.*, b.title AS bookTitle FROM requests r LEFT JOIN books b ON b.id = r.book_id
  WHERE r.who = ? ORDER BY r.asked_at DESC`).all(String(who || '')).map(row);

// What one person has asked for, counted. On the accounts page beside their
// books and their hours: a person who has asked for nine things and had one is
// a different person to talk to than one who has asked for one.
export const tallyFor = (who) => {
  const rows = of_(who);
  return {
    asked: rows.length,
    open: rows.filter((r) => r.state === 'open').length,
    filled: rows.filter((r) => r.state === 'filled').length,
    declined: rows.filter((r) => r.state === 'declined').length,
  };
};

// --- answering ------------------------------------------------------------

// The news this person has not been shown yet: a book that arrived, or a
// request that was turned down. Read once and marked, because it is news and
// not a state — being told twice that a book arrived is being told wrong.
export const newsFor = (who) => db.prepare(`
  SELECT r.*, b.title AS bookTitle FROM requests r LEFT JOIN books b ON b.id = r.book_id
  WHERE r.who = ? AND r.told = 0 AND r.state IN ('filled', 'declined')
  ORDER BY r.decided_at`).all(String(who || '')).map(row);

export const markTold = (ids) => {
  const some = (ids || []).map(Number).filter(Number.isInteger);
  if (!some.length) return 0;
  const mark = db.prepare('UPDATE requests SET told = 1 WHERE id = ?');
  for (const id of some) mark.run(id);
  return some.length;
};

// Tie a request to a book: the automatic path and the by-hand one both end
// here, so there is one place where "answered" is written down and one place
// where the heart is put on.
export function fill(id, bookId, { heart }) {
  const r = db.prepare("SELECT * FROM requests WHERE id = ? AND state = 'open'").get(Number(id));
  if (!r) throw new Error('That request is not open.');
  const book = db.prepare('SELECT id, title, author FROM books WHERE id = ?').get(Number(bookId));
  if (!book) throw new Error('No such book.');
  db.prepare("UPDATE requests SET state = 'filled', book_id = ?, decided_at = ?, told = 0 WHERE id = ?")
    .run(book.id, new Date().toISOString(), r.id);
  // Asked for and now here, so it is one of theirs. The request was the saying
  // so; this is only writing it down where the app keeps such things.
  try { heart(r.who, book.id); } catch { /* a heart is not worth failing the fill for */ }
  return { ...row(db.prepare('SELECT * FROM requests WHERE id = ?').get(r.id)), book };
}

export function decline(id, said) {
  const r = db.prepare("SELECT * FROM requests WHERE id = ? AND state = 'open'").get(Number(id));
  if (!r) throw new Error('That request is not open.');
  db.prepare("UPDATE requests SET state = 'declined', said = ?, decided_at = ?, told = 0 WHERE id = ?")
    .run(String(said || '').slice(0, 300), new Date().toISOString(), r.id);
  return row(db.prepare('SELECT * FROM requests WHERE id = ?').get(r.id));
}

export function forget(id) {
  const n = db.prepare('DELETE FROM requests WHERE id = ?').run(Number(id)).changes;
  return { gone: n > 0 };
}

// --- the automatic half ---------------------------------------------------

// Books have arrived. Answer whatever they answer.
//
// Given the ids of books that are new — or no ids at all, meaning "look at the
// whole collection", which is what a first scan after a request wants — this
// matches each open request against them on the normalised author and title.
//
// One book answers at most one request, and one request is answered by at most
// one book: two people asking for the same book both get it, since the match is
// per request, but a single request never picks between two books. Where two
// books normalise the same, the lower id wins — arbitrary, but fixed, so the
// same scan twice does the same thing.
export function fillFrom(bookIds, { heart }) {
  const open = openOnes();
  if (!open.length) return [];
  const books = (bookIds && bookIds.length)
    ? db.prepare(`SELECT id, title, author FROM books WHERE id IN (${bookIds.map(() => '?').join(',')})`)
      .all(...bookIds.map(Number))
    : db.prepare('SELECT id, title, author FROM books').all();

  const byKey = new Map();
  for (const b of books.sort((x, y) => x.id - y.id)) {
    const k = key(b.author, b.title);
    if (!byKey.has(k)) byKey.set(k, b);
  }

  const answered = [];
  for (const r of open) {
    const b = byKey.get(key(r.author, r.title));
    if (!b) continue;
    try { answered.push(fill(r.id, b.id, { heart })); } catch { /* raced with a by-hand fill */ }
  }
  return answered;
}
