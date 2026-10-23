// ma-accounts — Music Assistant signs in as an account, and never makes one.
//
// Up to 2.14.152 `/login` took any username that came with MA_TOKEN and did
// `INSERT OR IGNORE INTO users (name)`. The table's defaults make that row
// approved with no password, which is exactly what `signIn` lets the first comer
// claim by choosing a password — so the token and a made-up name were an account
// on the listening page. And a name inside a token was believed for as long as
// the token lived, after the account was removed or refused.
//
// What has to stay true: an unknown, pending or denied name is refused and
// nothing is written; an approved account and the administrator are let in; a
// token stops working the moment its account does; the bare MA_TOKEN is still
// the nameless listener; and a name from before accounts can still be claimed
// on the listening page, because that door is not Music Assistant's to close.
//
// Run: node tests/ma-accounts.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HERE = path.join(ROOT, 'fixtures', 'ma-accounts-test');
const DATA = path.join(HERE, 'data');
const PORT = 8549;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'test-ma-token';

let failed = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
};

fs.rmSync(HERE, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
process.env.DATA_DIR = DATA;
const { db } = await import('../server/db.js');
db.exec('DELETE FROM users;');
const person = db.prepare('INSERT INTO users (name, state, pass, salt) VALUES (?, ?, ?, ?)');
// pass and salt are only ever compared by `signIn`, which these names never reach
person.run('Robin', 'approved', 'ab'.repeat(32), 'cd'.repeat(16));
person.run('Alex', 'approved', 'ab'.repeat(32), 'cd'.repeat(16));
person.run('Sam', 'pending', 'ab'.repeat(32), 'cd'.repeat(16));
person.run('Dana', 'denied', 'ab'.repeat(32), 'cd'.repeat(16));
// a name from before accounts: approved, no password yet
person.run('Old Name', 'approved', '', '');
const rows = () => db.prepare('SELECT name FROM users ORDER BY name').all().map((r) => r.name);
const before = rows();

const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')],
  { env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), MA_TOKEN: TOKEN,
      ADMIN_USER: 'Quinn', ADMIN_PASSWORD: 'a very good password' },
    stdio: 'inherit' });

const up = async () => {
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${BASE}/api/admin`); return true; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  return false;
};

const login = async (username, password = TOKEN) => {
  const r = await fetch(`${BASE}/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
};
const me = async (token) => (await fetch(`${BASE}/api/me`, {
  headers: { Authorization: `Bearer ${token}` } })).status;
const forged = (name) => `${Buffer.from(name, 'utf8').toString('base64url')}.${TOKEN}`;

try {
  if (!await up()) throw new Error(`the server never answered on ${PORT}`);

  // --- a name this app does not know ------------------------------------
  const stranger = await login('Stranger');
  check('an unknown name is refused', stranger.status, 401);
  check('in the words a wrong token gets', stranger.body.error, 'Invalid username or password');
  check('and nothing is added for it', rows(), before);
  const claim = await fetch(`${BASE}/api/account/signin`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Stranger', password: 'my own password' }),
  });
  check('so there is nothing on the listening page to claim', claim.ok, false);
  check('and the try added nothing either', rows(), before);

  // --- pending, denied, and the wrong token -----------------------------
  check('a pending account is refused', (await login('Sam')).status, 401);
  check('a denied account is refused', (await login('Dana')).status, 401);
  check('an approved name with the wrong token is refused', (await login('Robin', 'nope')).status, 401);
  check('none of that wrote anything', rows(), before);

  // --- the ones that may -------------------------------------------------
  const robin = await login('Robin');
  check('an approved account signs in', robin.status, 200);
  check('as itself', robin.body.user?.username, 'Robin');
  check('in any case, under the name as it is kept', (await login('robin')).body.user?.username, 'Robin');
  check('and its token answers', await me(robin.body.user?.token), 200);

  const quinn = await login('quinn');
  check('the administrator signs in', quinn.status, 200);
  check('under their own name', quinn.body.user?.username, 'Quinn');
  check('without becoming a row', rows(), before);

  const nameless = await login('');
  check('no name with the token is still the nameless listener', nameless.status, 200);
  check('the bare token still answers', await me(TOKEN), 200);

  // --- a token is only as good as its account, now ----------------------
  check('a token for a name nobody has is refused', await me(forged('Ghost')), 401);
  check('and for a pending one', await me(forged('Sam')), 401);
  check('and for a denied one', await me(forged('Dana')), 401);
  check('and in the query, the way a player fetches audio', (await fetch(
    `${BASE}/api/libraries?token=${encodeURIComponent(forged('Ghost'))}`)).status, 401);

  const alex = (await login('Alex')).body.user?.token;
  check('Alex is in', await me(alex), 200);
  db.prepare('DELETE FROM users WHERE name = ?').run('Alex');
  check('and out again once the account is removed', await me(alex), 401);

  db.prepare("UPDATE users SET state = 'denied' WHERE name = ?").run('Robin');
  check('a token stops answering when its account is refused', await me(robin.body.user?.token), 401);
  check('and that account can no longer sign in', (await login('Robin')).status, 401);

  // --- the door that stays open -----------------------------------------
  const old = await fetch(`${BASE}/api/account/signin`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Old Name', password: 'chosen at last' }),
  });
  check('a name from before accounts is still claimed on the listening page', old.status, 200);
  check('by choosing its password', (await old.json()).claimed, true);
} finally {
  server.kill();
  await new Promise((done) => {
    if (server.exitCode !== null || server.signalCode !== null) return done();
    server.on('exit', done);
    return setTimeout(done, 2000).unref?.();
  });
}

console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
