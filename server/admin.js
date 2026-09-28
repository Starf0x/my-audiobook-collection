import crypto from 'node:crypto';

// One password guards everything that changes the collection, and it is set on
// the container (ADMIN_PASSWORD) rather than in the app: one place, which
// survives an emptied appdata folder and cannot drift from the template.
// Without one set, the app behaves as it always did — whoever opens it may do
// anything — which is what a private install looks like.

const sessions = new Map(); // token -> when it was made; forgotten on restart

// A session is not forever. Nothing here logs anybody out on purpose, so without
// this a token handed to a browser in March still opened the page in December.
const KEEP = 30 * 24 * 60 * 60 * 1000;

const envPassword = () => process.env.ADMIN_PASSWORD || '';
export const adminRequired = () => !!envPassword();

// A salt made at startup: the password is never stored, only compared.
const bootSalt = crypto.randomBytes(16).toString('hex');

// scrypt is meant to be slow, which is the point of it and also the trap: the
// synchronous one blocks the only thread this server has, and this route asks
// for no password to reach. Thirty guesses a second was thirty times a fifth of
// a second with nothing else being served — the app went away while somebody
// typed. The work is done off-thread now, and the stored side is worked out once
// rather than on every attempt.
const hash = (password) => new Promise((ok, no) => {
  crypto.scrypt(password, bootSalt, 32, (err, key) => (err ? no(err) : ok(key)));
});
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

export async function unlock(password, who = '') {
  if (!adminRequired()) return { token: '', admin: true };
  const left = waitFor(who);
  if (left) {
    const e = new Error(`Too many tries. Wait ${Math.ceil(left / 1000)} second(s).`);
    e.retryAfter = Math.ceil(left / 1000);
    throw e;
  }
  if (!storedHash) storedHash = await hash(envPassword());
  const given = await hash(String(password || ''));
  // constant time: both sides are 32 bytes
  const ok = crypto.timingSafeEqual(given, storedHash);
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
  if (!adminRequired()) return true;
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
