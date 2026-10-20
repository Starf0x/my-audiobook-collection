// restart — the administrator is still signed in after the app restarts.
//
// The owner pressed Install and the bar sat on "the app is restarting, so this
// waits for it" for ever (2.14.120). An update is a restart, and the
// administrator's sessions were kept in memory: the page that asked was signed
// out by the very thing it was waiting for, and every answer after was a 401
// that it took for the app still being down.
//
// So this restarts it for real — a server process stopped and started again on
// the same data — and asks with the cookie from before. And once more with a
// new ADMIN_PASSWORD, because a restart used to be what ended an old password's
// sessions, and that must still be so.
//
// Run: node tests/restart.mjs
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'fixtures', 'restart-test', 'data');
const PORT = 8619;
const BASE = `http://127.0.0.1:${PORT}`;

let failed = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
};

fs.rmSync(path.dirname(DATA), { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });

// whether something already answers on the port: another run's server, or
// something else entirely, would make every answer below somebody else's
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
const start = async (password) => {
  server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), ADMIN_USER: 'morgan', ADMIN_PASSWORD: password },
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
const call = async (how, where, body, cookie = '') => {
  const r = await fetch(`${BASE}${where}`, {
    method: how,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const cookies = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  return { status: r.status, cookies, body: await r.json().catch(() => ({})) };
};

try {
  await start('a very good password');
  const signed = await call('POST', '/api/account/signin', { name: 'morgan', password: 'a very good password' });
  const cookie = signed.cookies;
  check('signed in as the administrator, the update route answers',
    (await call('GET', '/api/update/progress', null, cookie)).status, 200);

  await stop();
  await start('a very good password');
  const after = await call('GET', '/api/update/progress', null, cookie);
  check('and after a restart, with the same cookie, it still does — and says which version runs',
    [after.status, typeof after.body.running], [200, 'string']);
  check('as do the administrator\'s other pages', (await call('GET', '/api/accounts', null, cookie)).status, 200);

  // a new password on the container, and a restart: the old sessions end
  await stop();
  await start('a different password now');
  check('a restart with a new ADMIN_PASSWORD ends the sessions of the old one',
    [401, 403].includes((await call('GET', '/api/accounts', null, cookie)).status), true);
} finally {
  await stop();
}

console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
