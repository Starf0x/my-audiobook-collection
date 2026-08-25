import crypto from 'node:crypto';

// One password guards everything that changes the collection, and it is set on
// the container (ADMIN_PASSWORD) rather than in the app: one place, which
// survives an emptied appdata folder and cannot drift from the template.
// Without one set, the app behaves as it always did — whoever opens it may do
// anything — which is what a private install looks like.

const sessions = new Set(); // unlocked browsers, forgotten on restart

const envPassword = () => process.env.ADMIN_PASSWORD || '';
export const adminRequired = () => !!envPassword();

// A salt made at startup: the password is never stored, only compared.
const bootSalt = crypto.randomBytes(16).toString('hex');
const hash = (password) => crypto.scryptSync(password, bootSalt, 32).toString('hex');

export function unlock(password) {
  if (!adminRequired()) return { token: '', admin: true };
  const stored = hash(envPassword());
  const given = hash(password || '');
  // constant time: both sides are hex of the same length
  const ok = crypto.timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(stored, 'hex'));
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
