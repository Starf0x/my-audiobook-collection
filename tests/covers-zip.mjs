// covers-zip — the duplicates archive, after the hand-written zip writer here
// was dropped for the streaming one a book download already uses.
//
// An archive is either readable by the tools people have or it is rubbish, and
// nothing in the app can tell the difference. So this writes one, unpacks it
// with Windows' own Expand-Archive, and compares every file byte for byte.
//
// Run: node tests/covers-zip.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HERE = path.join(ROOT, 'fixtures', 'covers-zip-test');
const DATA = path.join(HERE, 'data');

let failed = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
};

fs.rmSync(HERE, { recursive: true, force: true });
const dupes = path.join(DATA, 'covers', 'duplicates');
fs.mkdirSync(dupes, { recursive: true });

// three files that are not text: a zip that mangles bytes has to show it
const made = new Map();
for (const [name, size] of [['one.jpg', 5000], ['two.png', 131072], ['three.jpg', 7]]) {
  const body = Buffer.alloc(size);
  for (let i = 0; i < size; i++) body[i] = (i * 31 + name.length * 7) & 0xff;
  fs.writeFileSync(path.join(dupes, name), body);
  made.set(name, body);
}

process.env.DATA_DIR = DATA;
const { zipDuplicates } = await import('../server/covers.js');

const out = await zipDuplicates(20260921);
check('every loose cover went in', out.zipped, 3);
check('and the archive is on disk', fs.existsSync(out.zip), true);
check('with the size it reported', fs.statSync(out.zip).size, out.bytes);
check('the loose copies are gone', fs.readdirSync(dupes).filter((n) => !n.endsWith('.zip')), []);
check('it begins with the zip magic', fs.readFileSync(out.zip).subarray(0, 4).toString('hex'), '504b0304');

// Windows' own unpacker, which is what the owner has
const to = path.join(HERE, 'unpacked');
execFileSync('powershell', ['-NoProfile', '-Command',
  `Expand-Archive -LiteralPath '${out.zip}' -DestinationPath '${to}' -Force`], { stdio: 'pipe' });

const back = fs.readdirSync(to).sort();
check('PowerShell unpacks all three', back, ['one.jpg', 'three.jpg', 'two.png']);
for (const [name, body] of made) {
  check(`${name} comes back byte for byte`, fs.readFileSync(path.join(to, name)).equals(body), true);
}

console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
