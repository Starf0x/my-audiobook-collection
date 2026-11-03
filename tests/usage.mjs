// usage — the daily check-in to a usage webhook: off unless set, once a day, and the day
// count going up by one each new day.
//
// Run: node tests/usage.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'fixtures', 'usage-test', 'data');
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
process.env.DATA_DIR = DATA;
delete process.env.HOST_HOSTNAME;

let failed = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
};

const sent = [];
let answer = 201;
globalThis.fetch = async (url, init) => {
  sent.push({ url, token: init.headers['X-Webhook-Token'], body: JSON.parse(init.body) });
  return { ok: answer < 300, status: answer };
};
const { reportOnce, kind } = await import('../server/usage.js');
const at = (d) => new Date(`${d}T09:30:00`);

check('nothing is sent while it is not set', await reportOnce('1.0.0', at('2026-11-03')), null);
process.env.USAGE_URL = 'https://usage.example.com/webhook';
process.env.USAGE_TOKEN = 'test-token';
await reportOnce('1.0.0', at('2026-11-03'));
check('set, it reports with the token in the header', [sent.length, sent[0].url, sent[0].token],
  [1, 'https://usage.example.com/webhook', 'test-token']);
check('the app, its version, the day, what it runs as and day one',
  [sent[0].body.appName, sent[0].body.version, sent[0].body.date, sent[0].body.dck, sent[0].body.days],
  ['My Audiobook Collection', '1.0.0', '2026-11-03', kind() === 'DCK', 1]);
check('without HOST_HOSTNAME the computer is the hostname', sent[0].body.computerName, os.hostname());
await reportOnce('1.0.0', at('2026-11-03'));
check('and only once that day', sent.length, 1);
process.env.HOST_HOSTNAME = 'Tower';   // what Unraid passes to every container
await reportOnce('1.0.0', at('2026-11-04'));
check('the next day it reports again, a day further', [sent.length, sent[1].body.days], [2, 2]);
check('with HOST_HOSTNAME the computer is the server, not the container id',
  sent[1].body.computerName, 'Tower');
answer = 500;
await reportOnce('1.0.0', at('2026-11-06'));
answer = 201;
await reportOnce('1.0.0', at('2026-11-06'));
check('a refused report is tried again, and the days count from the first', [sent.length, sent[3].body.days], [4, 4]);

// --- the built-in collector, for an ordinary install that sets nothing ----
// No own URL, but a token is present, so it goes to the address baked into the
// app — and with a random id in place of the real machine name.
delete process.env.USAGE_URL;
await reportOnce('1.0.0', at('2026-11-08'));
const def = sent[sent.length - 1];
check('with no own URL it reports to the built-in collector',
  def.url, 'https://hkjhykihflhfg5.the-airheads.com/webhook');
check('and sends a random id, never the real server name',
  [def.body.computerName !== 'Tower', def.body.computerName !== os.hostname(), def.body.computerName.length],
  [true, true, 36]);
await reportOnce('1.0.0', at('2026-11-09'));
check('and the same random id on another day', sent[sent.length - 1].body.computerName, def.body.computerName);

// --- turning it off -------------------------------------------------------
const { db, setSetting } = await import('../server/db.js');
process.env.USAGE_OPTOUT = '1';
let n = sent.length;
await reportOnce('1.0.0', at('2026-11-10'));
check('USAGE_OPTOUT sends nothing', sent.length, n);
delete process.env.USAGE_OPTOUT;
setSetting('usageOptOut', '1');
n = sent.length;
await reportOnce('1.0.0', at('2026-11-11'));
check('and the admin switch sends nothing', sent.length, n);
setSetting('usageOptOut', '0');

// Close the database first: Windows will not remove a folder with an open file in it.
db.close();
fs.rmSync(path.dirname(DATA), { recursive: true, force: true });
console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
