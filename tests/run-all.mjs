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

// Output goes straight through, as it always has, and the last few lines of each
// suite are kept as well. A suite that fails says why at the moment it fails —
// `series-complete` carries a whole paragraph about a port somebody else might
// hold, and prints what the last attempt actually said — and then forty more
// suites' worth of `ok` scrolls over it. Once that paragraph was read as "one
// suite(s) FAILED" and nothing else, because the run was piped through a `grep`
// that only kept the lines the reader thought mattered. The tally at the end
// repeats it, where the eye already is.
const MOST = 14;
// What a failing suite said, worth repeating at the end. Two kinds of line, and
// the difference matters:
//
//  * the ones that name the fault — `FAIL …` and the `got`/`want` under it, and
//    anything that threw. A suite that fails its third check and then passes
//    forty more has the answer at the top, so a plain tail of the output is
//    forty lines of `ok` and nothing else. That is what happened.
//  * otherwise the tail, which is where a suite that died says so.
//
// Stack frames are dropped from both. A throw prints its message and then twenty
// lines of `at wrapModuleLoad (node:internal/modules/…)`, which would push the
// sentence out of a bounded tail — and the frames are still above, in the run
// itself. The summary is for the sentence.
const NAMES_IT = /^(FAIL|Error|.*Error:)|^\s+(got|want)\b/;
const A_FRAME = /^\s+at\s/;

const one = (name) => new Promise((done) => {
  const p = spawn(process.execPath, [path.join(HERE, `${name}.mjs`)], { stdio: ['inherit', 'pipe', 'pipe'] });
  const flagged = [];
  let tail = [];
  // one per stream: a chunk rarely ends on a newline, and a single shared
  // leftover would glue the end of a stdout line to the start of a stderr one
  const follow = (stream, to) => {
    let rest = '';
    stream.on('data', (chunk) => {
      to.write(chunk);
      const lines = (rest + chunk).split('\n');
      rest = lines.pop();
      for (const line of lines) {
        if (A_FRAME.test(line)) continue;
        if (NAMES_IT.test(line) && flagged.length < MOST) flagged.push(line);
        tail = [...tail, line].slice(-MOST);
      }
    });
  };
  follow(p.stdout, process.stdout);
  follow(p.stderr, process.stderr);
  const said = () => (flagged.length ? flagged : tail).join('\n').trim();
  p.on('close', (code) => done({ ok: code === 0, kept: said() }));
  p.on('error', (e) => done({ ok: false, kept: `${said()}\n${e.message}`.trim() }));
});

const failed = [];
for (const name of PORTABLE) {
  console.log(`\n--- ${name} ---`);
  // eslint-disable-next-line no-await-in-loop -- one at a time is the point
  const { ok, kept } = await one(name);
  if (!ok) failed.push({ name, kept });
}

console.log('');
for (const [name, why] of Object.entries(ELSEWHERE)) console.log(`(not run here: ${name} — ${why})`);
if (!failed.length) {
  console.log(`\n${PORTABLE.length} suites, all checks passed`);
  process.exit(0);
}
for (const { name, kept } of failed) {
  console.log(`\n--- ${name}, what it said ---\n${kept.trim()}`);
}
console.log(`\n${failed.length} suite(s) FAILED: ${failed.map((f) => f.name).join(', ')}`);
process.exit(1);
