import crypto from 'node:crypto';
import { getSetting, setSetting } from './db.js';

// One password guards everything that changes the collection. Without one set,
// the app behaves as it always did: whoever opens it may do anything. With one
// set, a browser has to unlock before any changing request is accepted, and
// everyone else can browse, play and keep their own place in a book.

const sessions = new Set(); // unlocked browsers, forgotten on restart

// A password in the container template wins over a stored one, so a fresh
// container is guarded from its first start and the template stays the truth.
const envPassword = () => process.env.ADMIN_PASSWORD || '';
export const passwordFromEnv = () => !!envPassword();
const bootSalt = crypto.randomBytes(16).toString('hex');

const hash = (password, salt) =>
  crypto.scryptSync(password, salt, 32).toString('hex');

export const adminRequired = () => !!envPassword() || !!getSetting('adminHash');

export function setPassword(password) {
  if (passwordFromEnv()) {
    throw new Error('The password comes from the container template (ADMIN_PASSWORD). Change it there.');
  }
  if (!password) {
    setSetting('adminHash', '');
    setSetting('adminSalt', '');
    sessions.clear();
    return { required: false };
  }
  if (password.length < 4) throw new Error('Use at least four characters');
  const salt = crypto.randomBytes(16).toString('hex');
  setSetting('adminSalt', salt);
  setSetting('adminHash', hash(password, salt));
  sessions.clear(); // everyone unlocks again with the new password
  return { required: true };
}

export function unlock(password) {
  if (!adminRequired()) return { token: '', admin: true };
  const stored = envPassword()
    ? hash(envPassword(), bootSalt)
    : getSetting('adminHash');
  const given = hash(password || '', envPassword() ? bootSalt : getSetting('adminSalt'));
  // constant time: both sides are hex of the same length
  const ok = given.length === stored.length
    && crypto.timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(stored, 'hex'));
  if (!ok) throw new Error('That is not the password');
  const token = crypto.randomBytes(24).toString('hex');
  sessions.add(token);
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

export const isAdmin = (req) => !adminRequired() || sessions.has(tokenOf(req));

// Guard for everything that writes: settings, scanning, tags, files, the trash.
export const requireAdmin = (req, res, next) => (isAdmin(req)
  ? next()
  : res.status(403).json({ error: 'Only the admin can change things here. Unlock first.' }));

export { tokenOf };
