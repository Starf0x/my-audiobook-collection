import crypto from 'node:crypto';
import { getSetting, setSetting } from './db.js';

// One administrator governs everything that changes the collection, and there is
// always one. Two places it can come from, and the container wins:
//
//  * **the container** — `ADMIN_USER` and `ADMIN_PASSWORD`. One place, which
//    survives an emptied appdata folder and cannot drift from the template.
//  * **the app** — a name and a password chosen at the gate on first run, kept
//    hashed in `settings`. For an install with nothing set on the container,
//    which is most of them.
//
// Until one of those exists the app is **unclaimed**: the gate asks for an
// administrator to be made and nothing else answers at all. It used to run open
// instead — no password set meant whoever opened it could do anything, which was
// called a private install. On a home network that is a collection, a set of
// listening positions and everybody's accounts, readable and deletable by
// anything that can reach the port, with nothing on screen to say so.
//
// The container still wins where it is set, which is also the way out of a
// forgotten in-app password: set `ADMIN_PASSWORD`, restart, and the stored one
// is ignored.

const sessions = new Map(); // token -> when it was made; forgotten on restart

// A session is not forever. Nothing here logs anybody out on purpose, so without
// this a token handed to a browser in March still opened the page in December.
const KEEP = 30 * 24 * 60 * 60 * 1000;

const envPassword = () => process.env.ADMIN_PASSWORD || '';
const envName = () => (process.env.ADMIN_USER || '').trim();

const NAME = 'adminName';
const HASH = 'adminHash';
const SALT = 'adminSalt';
const storedName = () => getSetting(NAME, '').trim();
const storedPass = () => ({ hash: getSetting(HASH, ''), salt: getSetting(SALT, '') });

// Which of the two is governing, or neither.
//
//  * `env`       — the container says so, and it wins.
//  * `stored`    — somebody made one at the gate.
//  * `unclaimed` — nobody has yet, and nothing in the app answers until they do.
export function adminState() {
  if (envPassword()) return 'env';
  const kept = storedPass();
  return kept.hash && kept.salt && storedName() ? 'stored' : 'unclaimed';
}

export const unclaimed = () => adminState() === 'unclaimed';

// An administrator governs this app, always. This used to be "is an
// ADMIN_PASSWORD set", and everything that reads it — who a write belongs to,
// who a read belongs to, whether a listener needs an account — took `false` to
// mean "no locks here".
export const adminRequired = () => true;

// What to call them. The container's name where it governs, otherwise the one
// chosen at the gate. Empty while unclaimed, which is the one time nobody is
// being called anything.
export const adminName = () => (adminState() === 'env' ? envName() : storedName());

// A salt made at startup: the password is never stored, only compared.
const bootSalt = crypto.randomBytes(16).toString('hex');

// scrypt is meant to be slow, which is the point of it and also the trap: the
// synchronous one blocks the only thread this server has, and this route asks
// for no password to reach. Thirty guesses a second was thirty times a fifth of
// a second with nothing else being served — the app went away while somebody
// typed. The work is done off-thread now, and the stored side is worked out once
// rather than on every attempt.
const hashWith = (password, salt) => new Promise((ok, no) => {
  crypto.scrypt(password, salt, 32, (err, key) => (err ? no(err) : ok(key)));
});
// The container's password is compared through a salt made at startup: it is
// never written down, so the salt need not outlive the process. One chosen at
// the gate is written down, so it carries a salt of its own.
const hash = (password) => hashWith(password, bootSalt);
let storedHash = null;

// And a wrong password costs the asker something. Per address, because the point
// is to slow one machine down rather than to lock the house when somebody
// mistypes: five tries, then a wait that doubles to half a minute.
const wrong = new Map();
const FREE = 5;
const MOST_WAIT = 30000;

export function waitFor(who) {
  const said = wrong.get(who);
  if (!said || said.tries <= FREE) return 0;
  const wait = Math.min(MOST_WAIT, 500 * 2 ** (said.tries - FREE - 1));
  return Math.max(0, said.at + wait - Date.now());
}

// How short a password may be. The same floor a listener's account has: a
// number chosen so a person types something rather than a letter, not so it
// survives a determined attack — the backoff above is what does that.
export const SHORTEST = 8;

// Make the administrator, on an app that has none. Once only: with one in place
// this refuses, so a page left open at the gate cannot be used to replace a
// password that somebody has since set.
export async function claim(name, password, who = '') {
  if (!unclaimed()) throw new Error('This app already has an administrator.');
  const wanted = String(name || '').trim();
  if (wanted.length < 2) throw new Error('Choose a name of at least 2 characters.');
  if (String(password || '').length < SHORTEST) {
    throw new Error(`Choose a password of at least ${SHORTEST} characters.`);
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await hashWith(String(password), salt);
  setSetting(NAME, wanted);
  setSetting(SALT, salt);
  setSetting(HASH, key.toString('hex'));
  // Signed in at once: having just chosen the password, being asked for it is
  // a question with no purpose.
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now());
  wrong.delete(who);
  return { token, admin: true, name: wanted };
}

export async function unlock(password, who = '') {
  if (unclaimed()) throw new Error('This app has no administrator yet. Make one first.');
  const left = waitFor(who);
  if (left) {
    const e = new Error(`Too many tries. Wait ${Math.ceil(left / 1000)} second(s).`);
    e.retryAfter = Math.ceil(left / 1000);
    throw e;
  }
  let given;
  let want;
  if (adminState() === 'env') {
    if (!storedHash) storedHash = await hash(envPassword());
    want = storedHash;
    given = await hash(String(password || ''));
  } else {
    const kept = storedPass();
    want = Buffer.from(kept.hash, 'hex');
    given = await hashWith(String(password || ''), kept.salt);
  }
  // constant time: both sides are 32 bytes
  const ok = given.length === want.length && crypto.timingSafeEqual(given, want);
  if (!ok) {
    const said = wrong.get(who) || { tries: 0, at: 0 };
    wrong.set(who, { tries: said.tries + 1, at: Date.now() });
    if (wrong.size > 1000) for (const [k, v] of wrong) if (Date.now() - v.at > MOST_WAIT * 4) wrong.delete(k);
    throw new Error('That is not the password');
  }
  wrong.delete(who);
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now());
  return { token, admin: true };
}

export function lock(token) {
  sessions.delete(token);
}

const tokenOf = (req) => {
  const raw = req.headers.cookie || '';
  const hit = raw.split(';').map((c) => c.trim()).find((c) => c.startsWith('admin='));
  return hit ? hit.slice(6) : '';
};

export const isAdmin = (req) => {
  // Nobody is the administrator of an app that has none. This used to answer
  // `true` for everybody when no password was set, which is what made an
  // unconfigured install open to whoever could reach it.
  if (unclaimed()) return false;
  const token = tokenOf(req);
  const made = sessions.get(token);
  if (!made) return false;
  if (Date.now() - made > KEEP) {
    sessions.delete(token);
    return false;
  }
  return true;
};

// Guard for everything that writes: settings, scanning, tags, files, the trash.
export const requireAdmin = (req, res, next) => (isAdmin(req)
  ? next()
  : res.status(403).json({ error: 'Only the admin can change things here. Unlock first.' }));

export { tokenOf };
