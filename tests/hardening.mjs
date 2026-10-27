// hardening — what a review of the whole app turned up (2.14.144), each asked
// of a real server process:
//
//  1. asking for an account is limited: three an hour from one address, twenty
//     waiting at most — it was the one route open to anybody, and each request
//     cost a scrypt, a row and a message to Discord;
//  2. every answer says who may frame the page, not to sniff types, and to keep
//     the referrer at home, and Express no longer names itself;
//  3. a write whose Origin is another host is refused — SameSite=Lax does not
//     stop another app on the same machine;
//  5. an unhandled rejection is said and survived; an uncaught exception is
//     said and ends the process, for Docker or systemd to start it clean;
//  6. a sign-in clears away administrator sessions that can no longer open.
//
// (4, sessions kept hashed, is in `accounts`, beside the sessions themselves.)
//
// Run: node tests/hardening.mjs
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'fixtures', 'hardening-test', 'data');
const PORT = 8621;
const BASE = `http://127.0.0.1:${PORT}`;

let failed = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
};

fs.rmSync(path.dirname(DATA), { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });

const busy = () => new Promise((done) => {
  const s = net.connect(PORT, '127.0.0.1');
  s.once('connect', () => { s.destroy(); done(true); });
  s.once('error', () => done(false));
});
if (await busy()) {
  console.log(`FAIL port ${PORT} is already answering: free it and run again`);
  process.exit(1);
}

let server = null;
const start = async (env = {}) => {
  server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), ADMIN_USER: 'morgan', ADMIN_PASSWORD: 'a very good password', ...env },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    if (await busy()) return; // eslint-disable-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 100)); // eslint-disable-line no-await-in-loop
  }
  throw new Error('the server did not start');
};
const stop = () => new Promise((done) => {
  if (!server || server.exitCode !== null) return done();
  server.once('exit', () => done());
  server.kill();
  return setTimeout(done, 3000).unref?.();
});
const call = async (how, where, body, headers = {}) => {
  const r = await fetch(`${BASE}${where}`, {
    method: how,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const cookies = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  return { status: r.status, headers: r.headers, cookies, body: await r.json().catch(() => ({})) };
};
const db = () => new DatabaseSync(path.join(DATA, 'library.db'));
const ask = (n) => call('POST', '/api/account/request',
  { name: `Asker ${n}`, password: 'a good long one', reason: 'I would like to listen to these books' });

try {
  await start();

  // --- 2. the headers ----------------------------------------------------------
  const page = await call('GET', '/api/admin');
  check('every answer says only this app may frame it',
    [page.headers.get('content-security-policy'), page.headers.get('x-frame-options')],
    ["frame-ancestors 'self'", 'SAMEORIGIN']);
  check('and not to sniff types, and to keep the referrer at home',
    [page.headers.get('x-content-type-options'), page.headers.get('referrer-policy')], ['nosniff', 'same-origin']);
  check('and Express no longer names itself', page.headers.get('x-powered-by'), null);
  // an update's scripts are asked for again, not served stale by a proxy (2.14.391)
  const script = await call('GET', '/player.js');
  const listen = await call('GET', '/');
  check('the pages and their scripts are checked again on every load',
    [script.headers.get('cache-control'), listen.headers.get('cache-control')], ['no-cache', 'no-cache']);

  // The image's HEALTHCHECK, run exactly as the Dockerfile writes it (2.14.152):
  // a typo in it would show only as a container Docker calls unhealthy.
  {
    const docker = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
    const said = (docker.match(/HEALTHCHECK[^\n]*\\\n\s*CMD (\[.*\])/) || [])[1];
    const cmd = said ? JSON.parse(said) : null;
    const run = (port) => (cmd ? spawnSync(cmd[0] === 'node' ? process.execPath : cmd[0], cmd.slice(1),
      { env: { ...process.env, PORT: String(port) }, timeout: 10000 }).status : null);
    check('the image\'s health check passes against a running app, and fails where nothing answers',
      [!!cmd, run(PORT), run(PORT + 7)], [true, 0, 1]);
  }

  // --- 3. a write from another site ---------------------------------------------
  const signed = await call('POST', '/api/account/signin', { name: 'morgan', password: 'a very good password' });
  const admin = { Cookie: signed.cookies };
  check('a container password long enough raises nothing on the accounts page',
    (await call('GET', '/api/accounts', null, admin)).body.containerPasswordShort, false);
  check('a write whose Origin is another host is refused, cookie or not',
    (await call('POST', '/api/backups', null, { ...admin, Origin: 'http://192.168.2.200:9000' })).status, 403);
  check('one from this app\'s own page is done',
    (await call('POST', '/api/backups', null, { ...admin, Origin: BASE })).status, 200);
  check('and one with no Origin — a speaker, an automation — is left to the route',
    (await call('POST', '/api/backups', null, admin)).status, 200);
  check('a read is never refused for its Origin',
    (await call('GET', '/api/admin', null, { Origin: 'http://elsewhere.example' })).status, 200);

  // the HA page's settings: 06313c0 dropped haSettings from the import, so the read
  // was a 500 and the page showed empty fields after every update (2.14.270)
  check('the HA page can read its saved settings',
    (await call('GET', '/api/ha/config', null, admin)).status, 200);

  // --- the routes that moved out of index.js still answer (2.14.152) -------------
  // Moved as written into server/routes/, each mounted where its block stood. A
  // name left behind in index.js would only show when somebody pressed the
  // button, so each is asked once here — the answers they give with nothing
  // set up, not a 500 and not a missing route.
  {
    // a status, and for a refusal whether it was the route's own: a route that is
    // not there at all answers 404 too, with Express's HTML instead of JSON
    const ask = async (how, where, body) => {
      const r = await call(how, where, body, admin);
      return r.status < 400 ? r.status : `${r.status}${typeof r.body.error === 'string' ? ' own' : ' none'}`;
    };
    check('every route that moved out of index.js still answers as it did', [
      await ask('GET', '/api/permissions'),
      await ask('POST', '/api/permissions/fix', { path: '/nowhere' }),
      await ask('POST', '/api/permissions/forget', { path: '/nowhere' }),
      await ask('GET', '/api/update/progress'),
      await ask('GET', '/api/backups'),
      await ask('GET', '/api/lookup/status'),
      await ask('GET', '/api/apply/status'),
      await ask('POST', '/api/apply/999', { pick: {} }),
      await ask('GET', '/api/lookup/999'),
    ], [200, '400 own', '400 own', 200, 200, 200, 200, '404 own', '404 own']);
  }

  // --- 1. asking for an account --------------------------------------------------
  {
    const d = db();
    const add = d.prepare("INSERT INTO users (name, state, pass, salt) VALUES (?, 'pending', '', '')");
    for (let i = 0; i < 20; i++) add.run(`Waiting ${i}`);
    d.close();
  }
  const full = await ask(0);
  check('with twenty already waiting, another is turned away',
    [full.status, /Too many requests are already waiting/.test(full.body.error || '')], [400, true]);
  {
    const d = db();
    d.prepare("DELETE FROM users WHERE name LIKE 'Waiting %'").run();
    d.close();
  }
  const three = [await ask(1), await ask(2), await ask(3)].map((r) => r.status);
  const fourth = await ask(4);
  check('three requests an hour from one address are taken',
    three, [200, 200, 200]);
  check('and a fourth is told to wait, with how long',
    [fourth.status, Number(fourth.headers.get('retry-after')) > 0], [429, true]);
  {
    const d = db();
    check('and the one turned away left no row behind',
      d.prepare("SELECT COUNT(*) AS n FROM users WHERE name = 'Asker 4'").get().n, 0);
    d.close();
  }

  // --- 6. sessions that can no longer open --------------------------------------
  {
    const d = db();
    d.prepare('INSERT INTO admin_sessions (hash, made, under) VALUES (?, ?, ?)').run('old-one', 1, 'x');
    d.prepare('INSERT INTO admin_sessions (hash, made, under) VALUES (?, ?, ?)').run('other-password', Date.now(), 'not this one');
    d.close();
  }
  await call('POST', '/api/account/signin', { name: 'morgan', password: 'a very good password' });
  {
    const d = db();
    check('a sign-in clears away sessions past their time or under another password',
      d.prepare("SELECT COUNT(*) AS n FROM admin_sessions WHERE hash IN ('old-one', 'other-password')").get().n, 0);
    d.close();
  }

  // --- the folder browser stays where audiobooks can be (2.14.152) ----------------
  // It listed any folder on the machine. Here only BROWSE_ROOTS can be looked
  // in — /audiobooks and the rest are not on a test machine.
  await stop();
  const BOOKS = path.join(path.dirname(DATA), 'books');
  fs.mkdirSync(path.join(BOOKS, 'Fantasy', 'An Author'), { recursive: true });
  await start({ BROWSE_ROOTS: BOOKS });
  const again = await call('POST', '/api/account/signin', { name: 'morgan', password: 'a very good password' });
  const look = async (p) => (await call('GET', `/api/browse?path=${encodeURIComponent(p)}`, null, { Cookie: again.cookies })).body;
  const top = await look('/');
  const real = fs.realpathSync(BOOKS);
  check('the browser starts at the places audiobooks can be, not at /',
    [top.top, top.entries.includes(real)], [true, true]);
  const inside = await look(path.join(real, 'Fantasy'));
  check('and opens folders inside them',
    [inside.path, inside.entries, inside.parent], [path.join(real, 'Fantasy'), [path.join(real, 'Fantasy', 'An Author')], real]);
  check('going up from one of them comes back to the list',
    (await look(real)).parent, '/');
  const outside = await look(ROOT);
  check('and a folder outside them is not listed: it answers with the list, and says so',
    [outside.top, outside.refused, outside.entries.includes(ROOT)], [true, ROOT, false]);

  // --- a container password shorter than any other may be (2.14.152) ------------
  await stop();
  await start({ ADMIN_PASSWORD: 'short' });
  const weak = await call('POST', '/api/account/signin', { name: 'morgan', password: 'short' });
  check('a short ADMIN_PASSWORD still lets the administrator in, and the accounts page is told',
    [weak.status, (await call('GET', '/api/accounts', null, { Cookie: weak.cookies })).body.containerPasswordShort],
    [200, true]);

  // --- 2, again: a dashboard allowed to frame it ---------------------------------
  await stop();
  await start({ FRAME_ANCESTORS: "'self' http://192.168.2.200:8123" });
  const framed = await call('GET', '/api/admin');
  check('FRAME_ANCESTORS names who else may frame it, and the old header steps aside',
    [framed.headers.get('content-security-policy'), framed.headers.get('x-frame-options')],
    ["frame-ancestors 'self' http://192.168.2.200:8123", null]);
  // as systemd hands it over from the LXC settings file: quotes stripped
  await stop();
  await start({ FRAME_ANCESTORS: 'self http://192.168.2.200:8123' });
  check('and a bare self, which is what systemd leaves of the quotes, still means this app',
    (await call('GET', '/api/admin')).headers.get('content-security-policy'),
    "frame-ancestors 'self' http://192.168.2.200:8123");
} finally {
  await stop();
}

// --- 5. what nothing else caught ---------------------------------------------------
// The app's own process, with a fault set off after it has loaded.
const fault = (what) => spawnSync(process.execPath, ['--input-type=module', '-e', `
  await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'server', 'index.js')).href)});
  await new Promise((r) => setTimeout(r, 300));
  ${what}
  setTimeout(() => { console.log('STILL RUNNING'); process.exit(0); }, 500);
`], { env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT + 1), ADMIN_USER: 'morgan', ADMIN_PASSWORD: 'a very good password' }, encoding: 'utf8', timeout: 20000 });
const rejected = fault("Promise.reject(new Error('nobody waited on this'));");
check('an unhandled rejection is said, and the app goes on',
  [/unhandled rejection/.test(rejected.stderr), /STILL RUNNING/.test(rejected.stdout)], [true, true]);
const thrown = fault("setTimeout(() => { throw new Error('this one reached the top'); }, 0);");
check('an uncaught exception is said, and the process ends for a clean start',
  [/uncaught exception/.test(thrown.stderr), /STILL RUNNING/.test(thrown.stdout), thrown.status], [true, false, 1]);

console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
