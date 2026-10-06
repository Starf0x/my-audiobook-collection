// Every suite that runs anywhere, one after another. `npm test` is this.
//
// Not every suite is in here. `plays-on` needs a real browser and takes longer
// than everything else together, and `covers-zip` asks PowerShell to unpack the
// archive it made — both are worth having and neither belongs in a run that has
// to work anywhere, so they are named below rather than quietly left out.
//
// `pages` is the middle ground between them: it drives the real page scripts,
// in jsdom, with no browser and no server. It needs the dev dependencies, which
// is why the workflow installs them for this job and the image does not.
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
  'accounts',
  'levels',
  'book-bar',
  'ogg-lengths',
  'sub-series',
  'moving',
  'pages',
];

// what this runner does not run, and why — said out loud rather than forgotten
const ELSEWHERE = {
  'covers-zip': 'unpacks with PowerShell, so it needs Windows',
  'plays-on': 'drives a real browser over CDP — `npm run test:ui`, and its own job in CI',
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
