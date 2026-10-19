// to-player — on a phone, pressing Play goes to the player page.
//
// `/player` existed, but nothing took anybody there except the cover in the
// bar, so the owner pressed Play on his phone and stayed on the shelf. The hand-over
// was then written and left switched off behind a `false &&`, which no check
// noticed. This one reads both functions out of `public/player.js` and runs
// them, so a switch like that turns it red.
//
// Run: node tests/to-player.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
};

const source = fs.readFileSync(path.join(ROOT, 'public', 'player.js'), 'utf8');
const line = (name) => {
  const m = source.match(new RegExp(`^const ${name} = .*;$`, 'm'));
  if (!m) throw new Error(`player.js no longer declares ${name} on one line`);
  return m[0];
};
const block = (name) => {
  const from = source.indexOf(`const ${name} = `);
  if (from < 0) throw new Error(`player.js no longer declares ${name}`);
  const to = source.indexOf('\n};', from);
  if (to < 0) throw new Error(`cannot find the end of ${name}`);
  return source.slice(from, to + 3);
};

// Everything the two reach for, made up here: the screen width, the address,
// the tab's storage and who is signed in.
const world = (wide, at, storage) => {
  const env = { narrow: () => !wide, location: { pathname: at, href: at }, sessionStorage: storage, state: { user: 'Mario' } };
  // eslint-disable-next-line no-new-func -- the point is to run the shipped code
  const run = new Function('env', `const { narrow, location, sessionStorage, state } = env;
    const CARRY = 'carry'; let handingOver = false;
    ${line('goesToPlayer')}
    ${block('handOver')}
    return { goesToPlayer, handOver, handing: () => handingOver };`);
  return { env, ...run(env) };
};

{
  const w = world(false, '/', {});
  check('a phone on the shelf goes to the player', w.goesToPlayer(), true);
  check('and the hand-over says it went', w.handOver(7, 2, 31.5), true);
  check('to /player', w.env.location.href, '/player');
  check('carrying the book, its place and the reader, playing',
    JSON.parse(w.env.sessionStorage.carry), { who: 'Mario', id: 7, track: 2, position: 31.5, playing: true });
  check('and the page being left will not overwrite that carry', w.handing(), true);
}
check('a wide screen stays where it is', world(true, '/', {}).goesToPlayer(), false);
check('the player page does not send a book to itself', world(false, '/player', {}).goesToPlayer(), false);
{
  const refuses = new Proxy({}, { set() { throw new Error('QuotaExceededError'); } });
  const w = world(false, '/', refuses);
  check('a tab that cannot carry plays where it is', w.handOver(7, 0, 0), false);
  check('and goes nowhere', w.env.location.href, '/');
}

console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
