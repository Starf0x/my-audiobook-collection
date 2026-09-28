// Listeners, as accounts.
//
// What this replaces: a listener used to be a name in a table and nothing else,
// and the listening page answered whoever could reach it. Names were kept apart
// only by a cookie the browser wrote itself, which was honest about what it was
// — "what keeps one person out of another person's place in a book is that a
// browser is only ever offered the names it has said itself" — and is not a
// door.
//
// Now: somebody asks for an account with a name, a password they choose, a
// reason and whether they know the admin. It sits as `pending` until the admin
// approves it. A signed-in browser holds a random token in an HttpOnly cookie
// that is good for seven days and moves with them — every request they make
// pushes it out again, and seven quiet days end it.
//
// The rules that matter, in one place so they cannot drift:
//
//  * A password is never stored. scrypt with a random salt per account, off the
//    main thread (the synchronous one blocks the only thread this server has,
//    and these routes ask for no password to reach), compared with
//    `timingSafeEqual`.
//  * A wrong password costs the address that gave it (`guessing.js`).
//  * Only an `approved` account can sign in, and the check is here rather than
//    in a route, because there are several routes.
//  * A session token is 32 random bytes and is the only thing the cookie holds.
//    Nothing about the person is in it, so nothing about the person can be
//    changed by editing it.
import crypto from 'node:crypto';
import { db } from './db.js';
import { mustWait, wrong, right } from './guessing.js';
import { levelOf, mayDownload } from './levels.js';

export const WEEK = 7 * 24 * 60 * 60 * 1000;
const A_NAME = 40;
const SHORTEST = 8;

// The admin is one account and it is not in this table: it comes from the
// container, the way the password always has, so it survives an emptied appdata
// folder and cannot be changed from inside the app.
export const adminName = () => (process.env.ADMIN_USER || '').trim();

const scrypt = (password, salt) => new Promise((ok, no) => {
  crypto.scrypt(password, salt, 32, (err, key) => (err ? no(err) : ok(key)));
});

// A name is what appears in every list, on every card and in every message, so
// it is bounded and has no control characters in it. It is also the key of the
// table, so two people cannot have one that differs only by case or by spaces.
export function asName(said) {
  return String(said ?? '')
    .replace(new RegExp('[\\u0000-\\u001f\\u007f]', 'g'), ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, A_NAME);
}

const q = {
  byName: db.prepare('SELECT * FROM users WHERE name = ? COLLATE NOCASE'),
  all: db.prepare('SELECT * FROM users ORDER BY name'),
  add: db.prepare(`INSERT INTO users (name, state, pass, salt, reason, knows_admin, requested_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)`),
  setPass: db.prepare('UPDATE users SET pass = ?, salt = ? WHERE name = ?'),
  setState: db.prepare('UPDATE users SET state = ?, decided_at = ? WHERE name = ?'),
  seen: db.prepare('UPDATE users SET last_seen = ?, first_seen = COALESCE(NULLIF(first_seen, %s), ?) WHERE name = ?'
    .replace('%s', "''")),
  drop: db.prepare('DELETE FROM users WHERE name = ?'),
  session: db.prepare('SELECT * FROM listener_sessions WHERE token = ?'),
  open: db.prepare('INSERT INTO listener_sessions (token, name, made, seen) VALUES (?, ?, ?, ?)'),
  touch: db.prepare('UPDATE listener_sessions SET seen = ? WHERE token = ?'),
  close: db.prepare('DELETE FROM listener_sessions WHERE token = ?'),
  closeAllOf: db.prepare('DELETE FROM listener_sessions WHERE name = ?'),
  stale: db.prepare('DELETE FROM listener_sessions WHERE seen < ?'),
};

export const find = (name) => q.byName.get(asName(name)) || null;
export const everyone = () => q.all.all();

// --- asking for one ------------------------------------------------------
export async function requestAccount({ name, password, reason, knowsAdmin }) {
  const who = asName(name);
  if (!who) throw new Error('Fill in the name you want to listen under.');
  if (who.toLowerCase() === adminName().toLowerCase() && adminName()) {
    throw new Error('That name is the administrator’s.');
  }
  const said = String(password ?? '');
  if (said.length < SHORTEST) throw new Error(`A password of at least ${SHORTEST} characters, please.`);
  const why = String(reason ?? '').replace(new RegExp('[\\u0000-\\u001f\\u007f]', 'g'), ' ').trim().slice(0, 500);
  if (why.length < 10) throw new Error('Say in a sentence why you would like access.');
  if (find(who)) throw new Error('There is already an account with that name. Ask the administrator.');

  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scrypt(said, salt);
  q.add.run(who, 'pending', key.toString('hex'), salt, why, knowsAdmin ? 1 : 0, new Date().toISOString());
  return { name: who, reason: why, knowsAdmin: !!knowsAdmin };
}

// --- the admin deciding --------------------------------------------------
export function decide(name, state) {
  const row = find(name);
  if (!row) throw new Error('No such account.');
  if (!['approved', 'denied', 'pending'].includes(state)) throw new Error('Unknown state.');
  q.setState.run(state, new Date().toISOString(), row.name);
  // somebody who is no longer approved is no longer signed in anywhere
  if (state !== 'approved') q.closeAllOf.run(row.name);
  return find(row.name);
}

// The admin handing somebody downloading before they have earned it, or taking
// it back. The level still earns it on its own: this is a grant beside that, not
// a switch that can turn it off.
export function grantDownload(name, may) {
  const row = find(name);
  if (!row) throw new Error('No such account.');
  db.prepare('UPDATE users SET may_download = ? WHERE name = ?').run(may ? 1 : 0, row.name);
  return { name: row.name, granted: !!may, mayDownload: mayDownload(finishedCount(row.name), may) };
}

// Removing an account takes everything that was only about that person with it:
// where they were in every book, what they had finished, what they had hearted,
// and any browser still signed in as them. The books are untouched.
export function remove(name) {
  const row = find(name);
  if (!row) throw new Error('No such account.');
  q.closeAllOf.run(row.name);
  db.prepare('DELETE FROM progress WHERE user = ?').run(row.name);
  db.prepare('DELETE FROM favourites WHERE user = ?').run(row.name);
  db.prepare('DELETE FROM completions WHERE user = ?').run(row.name);
  db.prepare('DELETE FROM downloads WHERE user = ?').run(row.name);
  q.drop.run(row.name);
  return { removed: row.name };
}

// --- signing in ----------------------------------------------------------
// `claim` is the one door left open for the names that existed before accounts
// did: they are approved and carry no password, so the first sign-in sets one.
export async function signIn({ name, password, from = '' }) {
  mustWait(from);
  const row = find(name);
  const said = String(password ?? '');
  // One sentence for "no such name" and for "wrong password", or this route
  // tells anybody who asks which names exist.
  const no = () => {
    wrong(from);
    return new Error('That name and password do not go together.');
  };
  if (!row) throw no();
  if (row.state === 'pending') throw new Error('That account is waiting for the administrator to approve it.');
  if (row.state !== 'approved') throw new Error('That account cannot sign in.');

  if (!row.pass) {
    // a name from before accounts existed: it is claimed by choosing a password
    if (said.length < SHORTEST) {
      const e = new Error(`That name has no password yet. Choose one of at least ${SHORTEST} characters.`);
      e.claim = true;
      throw e;
    }
    const salt = crypto.randomBytes(16).toString('hex');
    q.setPass.run((await scrypt(said, salt)).toString('hex'), salt, row.name);
  } else {
    const key = await scrypt(said, row.salt);
    const kept = Buffer.from(row.pass, 'hex');
    if (key.length !== kept.length || !crypto.timingSafeEqual(key, kept)) throw no();
  }
  right(from);
  return { name: row.name, token: openSession(row.name), claimed: !row.pass };
}

function openSession(name) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date().toISOString();
  forgetStale();
  q.open.run(token, name, now, now);
  q.seen.run(now, now, name);
  return token;
}

const forgetStale = () => q.stale.run(new Date(Date.now() - WEEK).toISOString());

export const tokenIn = (req, cookie = 'listener') => {
  const raw = req.headers.cookie || '';
  const hit = raw.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${cookie}=`));
  return hit ? hit.slice(cookie.length + 1) : '';
};

// Who this request is, or '' — and the session moves with them: every request
// pushes the seven days out again, which is what "seven days of quiet" means.
export function listenerOf(req) {
  const token = tokenIn(req);
  if (!token) return '';
  const s = q.session.get(token);
  if (!s) return '';
  if (Date.now() - Date.parse(s.seen || s.made || 0) > WEEK) {
    q.close.run(token);
    return '';
  }
  const row = find(s.name);
  if (!row || row.state !== 'approved') {
    q.close.run(token);
    return '';
  }
  const now = new Date().toISOString();
  q.touch.run(now, token);
  // last_seen is a day-level thing on the admin page, so it is not written on
  // every request: once an hour is enough and keeps this off the write path
  if (!row.last_seen || Date.now() - Date.parse(row.last_seen) > 3600000) q.seen.run(now, now, row.name);
  return row.name;
}

export function signOut(req) {
  const token = tokenIn(req);
  if (token) q.close.run(token);
}

// What the admin page shows: who they are, when they were last here, and how
// much they have listened to. The numbers come from the same places the rest of
// the app counts from, so they cannot disagree with it.
// A book played to its end. Written once per person per book — finishing it a
// second time is the same accomplishment — and never taken away again: that is
// what makes it a record of what somebody has done rather than a view of what
// they are doing. The title comes along because a book can be deleted later and
// the reading still happened.
export function finishedABook(user, bookId) {
  const who = asName(user);
  if (!who || !bookId) return false;
  const book = db.prepare('SELECT title FROM books WHERE id = ?').get(Number(bookId));
  const already = db.prepare('SELECT 1 FROM completions WHERE user = ? AND book_id = ?')
    .get(who, Number(bookId));
  if (already) return false;
  db.prepare('INSERT INTO completions (user, book_id, title, at) VALUES (?, ?, ?, ?)')
    .run(who, Number(bookId), book?.title || '', new Date().toISOString());
  return true;
}

export const finishedCount = (user) =>
  db.prepare('SELECT COUNT(*) AS n FROM completions WHERE user = ?').get(asName(user) || '').n;

// Whole books taken away. Kept per person because the admin's statistics say
// who took what, and because Discord is told.
export function tookABook(user, bookId, title) {
  const who = asName(user);
  if (!who) return;
  db.prepare('INSERT INTO downloads (user, book_id, title, at) VALUES (?, ?, ?, ?)')
    .run(who, Number(bookId) || 0, String(title || ''), new Date().toISOString());
}

export const downloadsOf = (user, most = 25) => db.prepare(
  'SELECT book_id, title, at FROM downloads WHERE user = ? ORDER BY at DESC LIMIT ?')
  .all(asName(user) || '', most);

export function withStats() {
  return everyone().map((u) => {
    const kept = db.prepare(`SELECT COUNT(*) AS started,
        COALESCE(SUM(CASE WHEN done = 1 THEN 1 ELSE 0 END), 0) AS finished
      FROM progress WHERE user = ?`).get(u.name);
    const seconds = db.prepare(`SELECT COALESCE(SUM(CASE WHEN p.done = 1 THEN b.duration ELSE
        COALESCE((SELECT SUM(t.duration) FROM tracks t
                  WHERE t.book_id = b.id AND t.idx < p.track_idx), 0) + p.position END), 0) AS s
      FROM progress p JOIN books b ON b.id = p.book_id WHERE p.user = ?`).get(u.name).s;
    const hearts = db.prepare('SELECT COUNT(*) AS n FROM favourites WHERE user = ?').get(u.name).n;
    const done = finishedCount(u.name);
    const level = levelOf(done);
    const took = downloadsOf(u.name);
    const sessions = db.prepare('SELECT COUNT(*) AS n FROM listener_sessions WHERE name = ?').get(u.name).n;
    const days = u.last_seen ? Math.floor((Date.now() - Date.parse(u.last_seen)) / 86400000) : null;
    return {
      name: u.name,
      state: u.state || 'approved',
      reason: u.reason || '',
      knowsAdmin: !!u.knows_admin,
      requestedAt: u.requested_at || '',
      decidedAt: u.decided_at || '',
      lastSeen: u.last_seen || '',
      daysAgo: days,
      hasPassword: !!u.pass,
      signedIn: sessions,
      started: kept.started,
      finished: kept.finished,
      hours: Math.round((seconds / 3600) * 10) / 10,
      favourites: hearts,
      // what they have actually finished, which is what the level is made of —
      // `finished` above is how many they have ticked, and the two can differ
      completed: done,
      level,
      mayDownload: mayDownload(done, u.may_download),
      granted: !!u.may_download,
      downloads: took,
    };
  });
}
