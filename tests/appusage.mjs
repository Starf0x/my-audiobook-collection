// appusage — the daily line to AppUsage: off unless set, once a day, and the day
// count going up by one each new day.
//
// Run: node tests/appusage.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'fixtures', 'appusage-test', 'data');
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
process.env.DATA_DIR = DATA;

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
const { reportOnce, kind } = await import('../server/appusage.js');
const at = (d) => new Date(`${d}T09:30:00`);

check('nothing is sent while it is not set', await reportOnce('1.0.0', at('2026-11-03')), null);
process.env.APPUSAGE_URL = 'https://usage.example.com/webhook';
process.env.APPUSAGE_TOKEN = 'test-token';
await reportOnce('1.0.0', at('2026-11-03'));
check('set, it reports with the token in the header', [sent.length, sent[0].url, sent[0].token],
  [1, 'https://usage.example.com/webhook', 'test-token']);
check('the app, its version, the day, what it runs as and day one',
  [sent[0].body.appName, sent[0].body.version, sent[0].body.date, sent[0].body.dck, sent[0].body.days],
  ['My Audiobook Collection', '1.0.0', '2026-11-03', kind() === 'DCK', 1]);
await reportOnce('1.0.0', at('2026-11-03'));
check('and only once that day', sent.length, 1);
await reportOnce('1.0.0', at('2026-11-04'));
check('the next day it reports again, a day further', [sent.length, sent[1].body.days], [2, 2]);
answer = 500;
await reportOnce('1.0.0', at('2026-11-06'));
answer = 201;
await reportOnce('1.0.0', at('2026-11-06'));
check('a refused report is tried again, and the days count from the first', [sent.length, sent[3].body.days], [4, 4]);

fs.rmSync(path.dirname(DATA), { recursive: true, force: true });
console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
