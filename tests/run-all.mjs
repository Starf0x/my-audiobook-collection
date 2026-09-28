// Every suite that runs anywhere, one after another. `npm test` is this.
//
// Not every suite is in here. The ones that drive a headless browser need Edge
// with a debugging port, and `covers-zip` asks PowerShell to unpack the archive
// it made — both are worth having and neither belongs in a run that has to work
// on a build machine, so they are named below rather than quietly left out.
//
// Suites run one at a time on purpose: several of them start a server on a fixed
// port and build a fixture library in a folder of their own.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const PORTABLE = [
  'series-complete',
  'series-online',
  'abs-contract',
  'safe-paths',
  'half-done',
  'outward',
  'one-at-a-time',
];

// what this runner does not run, and why — said out loud rather than forgotten
const ELSEWHERE = {
  'covers-zip': 'unpacks with PowerShell, so it needs Windows',
  'plays-on': 'drives headless Edge over CDP',
};

const one = (name) => new Promise((done) => {
  const p = spawn(process.execPath, [path.join(HERE, `${name}.mjs`)], { stdio: 'inherit' });
  p.on('close', (code) => done(code === 0));
  p.on('error', () => done(false));
});

const failed = [];
for (const name of PORTABLE) {
  console.log(`\n--- ${name} ---`);
  // eslint-disable-next-line no-await-in-loop -- one at a time is the point
  if (!await one(name)) failed.push(name);
}

console.log('');
for (const [name, why] of Object.entries(ELSEWHERE)) console.log(`(not run here: ${name} — ${why})`);
console.log(failed.length
  ? `\n${failed.length} suite(s) FAILED: ${failed.join(', ')}`
  : `\n${PORTABLE.length} suites, all checks passed`);
process.exit(failed.length ? 1 : 0);
