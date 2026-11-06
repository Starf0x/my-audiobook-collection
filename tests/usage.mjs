// usage — the daily check-in: once a day, anonymous id for the default
// collector, real hostname for a custom USAGE_URL, and opt-out works.
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
delete process.env.USAGE_URL;
delete process.env.USAGE_TOKEN;
delete process.env.USAGE_OPTOUT;   // run-all switches it off for every other suite

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

// --- built-in collector: active by default (DEFAULT_TOKEN is baked in) ----
await reportOnce('1.0.0', at('2026-11-03'));
check('by default it reports to the built-in collector',
  sent[0].url, 'https://hkjhykihflhfg5.the-airheads.com/webhook');
check('the app, its version, the day, what it runs as and day one',
  [sent[0].body.appName, sent[0].body.version, sent[0].body.date, sent[0].body.dck, sent[0].body.days],
  ['My Audiobook Collection', '1.0.0', '2026-11-03', kind() === 'DCK', 1]);
check('sends a random id, never the real server name',
  [sent[0].body.computerName !== os.hostname(), sent[0].body.computerName.length],
  [true, 36]);
await reportOnce('1.0.0', at('2026-11-03'));
check('and only once that day', sent.length, 1);
await reportOnce('1.0.0', at('2026-11-04'));
check('the next day it reports again, a day further',
  [sent.length, sent[1].body.days], [2, 2]);
check('and the same random id on another day',
  sent[1].body.computerName, sent[0].body.computerName);

// --- own URL: operator pointing it at their own server --------------------
process.env.USAGE_URL = 'https://usage.example.com/webhook';
process.env.USAGE_TOKEN = 'test-token';
await reportOnce('1.0.0', at('2026-11-05'));
check('with own URL it reports there with the custom token',
  [sent[2].url, sent[2].token],
  ['https://usage.example.com/webhook', 'test-token']);
check('without HOST_HOSTNAME the computer is the hostname', sent[2].body.computerName, os.hostname());
process.env.HOST_HOSTNAME = 'Tower';   // what Unraid passes to every container
await reportOnce('1.0.0', at('2026-11-06'));
check('with HOST_HOSTNAME the computer is the server, not the container id',
  sent[3].body.computerName, 'Tower');
answer = 500;
await reportOnce('1.0.0', at('2026-11-07'));
answer = 201;
await reportOnce('1.0.0', at('2026-11-07'));
check('a refused report is tried again, and the days count from the first', [sent.length, sent[5].body.days], [6, 5]);
await reportOnce('1.0.1', at('2026-11-07'));
check('an update reports the same day, with the new version and the same day count',
  [sent.length, sent[6]?.body.version, sent[6]?.body.days], [7, '1.0.1', 5]);
await reportOnce('1.0.1', at('2026-11-07'));
check('and only once for that version', sent.length, 7);
answer = 500;
await reportOnce('1.0.2', at('2026-11-07'));
answer = 201;
await reportOnce('1.0.2', at('2026-11-07'));
check('a refused update report is tried again', [sent.length, sent[8]?.body.version], [9, '1.0.2']);

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
