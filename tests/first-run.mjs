// first-run — an app nobody is the administrator of yet.
//
// It used to run open. With no `ADMIN_PASSWORD` set, `adminRequired()` was false,
// `isAdmin()` answered true for everybody, and the whole collection, every
// listening position and all the accounts were there for anything that could
// reach the port — with nothing on screen to say so. That was called a private
// install and it was a reasonable thing to offer in 2.0; it is not a reasonable
// default to leave somebody on.
//
// Now the app refuses to be used until somebody is made the administrator, and
// the gate asks for one. Three routes answer while that is true and nothing else
// does. What is checked here:
//
//   * nothing opens, and what does says why;
//   * a bad name or a short password is refused and nothing is written;
//   * claiming works, signs the claimer in, and opens the app;
//   * claiming twice does not replace a password somebody has since set;
//   * the administrator is in the database, so a restart keeps it;
//   * `ADMIN_PASSWORD` on the container wins, which is the way back in after a
//     forgotten one.
//
// Run: node tests/first-run.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HERE = path.join(ROOT, 'fixtures', 'first-run-test');
const DATA = path.join(HERE, 'data');
const PORT = 8546;
const BASE = `http://127.0.0.1:${PORT}`;

let failed = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
};

fs.rmSync(HERE, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
process.env.DATA_DIR = DATA;
process.env.PORT = String(PORT);
// The whole point: nothing on the container.
delete process.env.ADMIN_USER;
delete process.env.ADMIN_PASSWORD;

const { db } = await import('../server/db.js');
await import('../server/index.js');
await new Promise((r) => setTimeout(r, 700));

let cookie = '';
const call = async (how, where, body) => {
  const r = await fetch(`${BASE}${where}`, {
    method: how,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const got = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  return { status: r.status, cookies: got, body: await r.json().catch(() => ({})) };
};
const get = (where) => call('GET', where);
const post = (where, body) => call('POST', where, body);

// --- nothing opens --------------------------------------------------------
const shut = [];
for (const where of ['/api/stats', '/api/genres', '/api/home', '/api/books/1',
  '/api/accounts', '/api/listened', '/api/settings', '/api/untagged']) {
  // eslint-disable-next-line no-await-in-loop -- one after another is fine here
  shut.push((await get(where)).status);
}
check('with no administrator, nothing in the app answers', [...new Set(shut)], [401]);
check('and the refusal says what is wrong rather than "sign in first"',
  [(await get('/api/stats')).body.unclaimed,
    /no administrator/.test((await get('/api/stats')).body.error)], [true, true]);

// The three that must answer, or the page cannot draw the card that fixes it.
check('the page can still ask what state this is', (await get('/api/admin')).body,
  { required: true, admin: false, unclaimed: true });
check('and who it is, which every page asks before drawing anything',
  (await get('/api/account/me')).status, 200);

// --- a claim that should not be taken -------------------------------------
check('a name of one character is refused',
  (await post('/api/admin/claim', { name: 'F', password: 'a good long one' })).body.error,
  'Choose a name of at least 2 characters.');
check('and a short password is refused',
  (await post('/api/admin/claim', { name: 'Morgan', password: 'short' })).body.error,
  'Choose a password of at least 8 characters.');
check('and neither wrote anything: the app is still unclaimed',
  (await get('/api/admin')).body.unclaimed, true);
check('nor is there a half-made administrator in the database',
  db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key IN ('adminName','adminHash','adminSalt')").get().n, 0);

// --- making one -----------------------------------------------------------
const made = await post('/api/admin/claim', { name: 'Morgan', password: 'a good long one' });
check('a name and a long enough password makes the administrator',
  [made.status, made.body.ok, made.body.name], [200, true, 'Morgan']);
check('and signs them in on the spot, having just chosen the password',
  /^admin=[a-f0-9]{48}$/.test(made.cookies), true);
cookie = made.cookies;

check('the app opens', (await get('/api/stats')).status, 200);
check('and knows who it opened for',
  [(await get('/api/account/me')).body.name, (await get('/api/account/me')).body.admin],
  ['Morgan', true]);
check('and is not unclaimed any more', (await get('/api/admin')).body.unclaimed, false);

// --- and only once --------------------------------------------------------
// A page left sitting at the gate must not be a way to replace a password
// somebody has since set.
const twice = await post('/api/admin/claim', { name: 'Somebody Else', password: 'another long one' });
check('claiming it again is refused',
  [twice.status, twice.body.error], [400, 'This app already has an administrator.']);
check('and the administrator is unchanged', (await get('/api/account/me')).body.name, 'Morgan');

// --- kept, so a restart keeps it ------------------------------------------
// The password is never stored, only a scrypt of it with a salt of its own —
// the container's is compared through a salt made at startup, which is why that
// one needs no row.
const kept = Object.fromEntries(db.prepare(
  "SELECT key, value FROM settings WHERE key IN ('adminName','adminHash','adminSalt')").all()
  .map((r) => [r.key, r.value]));
check('the administrator is in the database, so it survives a restart',
  [kept.adminName, kept.adminHash.length, kept.adminSalt.length], ['Morgan', 64, 32]);
check('and the password itself is nowhere in there',
  Object.values(kept).some((v) => String(v).includes('a good long one')), false);

// --- and the page of accounts is told which one it is ---------------------
// That page says where the administrator's password lives. There are two
// answers now and it used to give only the first, telling somebody who made
// their account at the gate to go and edit a container variable that is not
// what let them in. It cannot work that out for itself — `ADMIN_PASSWORD` is
// not something a browser can see — so the answer travels with the accounts.
//
// This is the half `pages` cannot check: it stubs the route, so a server that
// quietly stopped sending this would leave every administrator reading the
// container wording again and every check there still passing.
check('the accounts page is told the administrator was made here',
  (await get('/api/accounts')).body.adminFrom, 'stored');

// --- the container wins ---------------------------------------------------
// Which is the way back in after a forgotten in-app password: set it on the
// container, restart, and the stored pair is ignored.
const admin = await import('../server/admin.js');
check('with nothing on the container, the stored one governs', admin.adminState(), 'stored');
process.env.ADMIN_USER = 'morgan';
process.env.ADMIN_PASSWORD = 'the container one';
check('and with one set, the container does', [admin.adminState(), admin.adminName()], ['env', 'morgan']);
check('and the accounts page is told that too, so it says the right thing',
  [(await get('/api/accounts')).body.adminFrom, (await get('/api/accounts')).body.admin],
  ['env', 'morgan']);
check("the container's password opens it",
  await admin.unlock('the container one', 'a').then(() => true).catch(() => false), true);
check('and the stored one no longer does',
  await admin.unlock('a good long one', 'b').then(() => true).catch((e) => e.message),
  'That is not the password');

console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
