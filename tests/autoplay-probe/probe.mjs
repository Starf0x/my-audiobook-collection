// Does a page that has only just loaded get to start playing sound?
//
// Four runs, in this order on purpose. The control runs first, before anything
// has played, so the browser's media engagement for this origin is at zero — and
// again at the end, because if the control stops failing the later runs prove
// nothing.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = join(here, 'edge-profile');
const PORT = 9333;
const BASE = 'http://127.0.0.1:8899';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });

// every argument its own array entry: this path has spaces in it
const headless = process.argv.includes('--headless');
const args = [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=msEdgeIdentityFre,msImplicitSignin',
];
if (headless) args.push('--headless=new');
args.push('about:blank');
console.log(headless ? '(headless)' : '(a real window)');
const edge = spawn(EDGE, args, { stdio: 'ignore' });

async function wsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not listening yet */ }
    await sleep(250);
  }
  throw new Error('the browser never opened its debugging port');
}

const ws = new WebSocket(await wsUrl());
await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error('cannot talk to the browser')); });

let nextId = 0;
const waiting = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && waiting.has(msg.id)) {
    const { ok, no } = waiting.get(msg.id);
    waiting.delete(msg.id);
    if (msg.error) no(new Error(msg.error.message));
    else ok(msg.result);
  }
};
const send = (method, params = {}) => new Promise((ok, no) => {
  const id = ++nextId;
  waiting.set(id, { ok, no });
  ws.send(JSON.stringify({ id, method, params }));
});

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false });
  return r.result.value;
};

await send('Page.enable');
await send('Runtime.enable');

async function goto(url) {
  await send('Page.navigate', { url });
  for (let i = 0; i < 80; i++) {
    const ready = await evaluate(`document.readyState === 'complete' && location.href.indexOf(${JSON.stringify(url)}) === 0`).catch(() => false);
    if (ready) return;
    await sleep(100);
  }
  throw new Error(`${url} never finished loading`);
}

// A trusted click, which is what a user gesture means: dispatched as real input,
// not as element.click(), which would not count.
async function click(selector) {
  const box = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!box) throw new Error(`no ${selector} on the page`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }
}

async function readProbe() {
  for (let i = 0; i < 60; i++) {
    const p = await evaluate('window.__probe && window.__probe.done ? JSON.stringify(window.__probe) : null').catch(() => null);
    if (p) return JSON.parse(p);
    await sleep(100);
  }
  throw new Error('page B never reported');
}

const results = [];
async function run(name, steps) {
  await goto('about:blank');
  await steps();
  const p = await readProbe();
  const playing = p.settled === 'resolved' && p.paused === false && p.currentTime > 0;
  results.push({ name, playing, ...p });
  console.log(`${playing ? 'PLAYS  ' : 'BLOCKED'}  ${name}`);
  console.log(`         ${p.settled}${p.error ? ' — ' + p.error : ''}, paused=${p.paused}, currentTime=${p.currentTime}`);
}

// 1. the control: B on its own, nothing clicked anywhere, no engagement yet
await run('B opened cold, no click anywhere', async () => {
  await goto(`${BASE}/b.html`);
});

// 2. what the app actually does: a click whose handler calls location.assign
await run('A played, then a button whose handler calls location.assign', async () => {
  await goto(`${BASE}/a.html`);
  await click('#play');
  await sleep(1200);
  const a = await evaluate('JSON.stringify(window.__a)');
  console.log(`         (A itself: ${a})`);
  await click('#go');
});

// 3. the same by a plain link
await run('A played, then a plain link clicked', async () => {
  await goto(`${BASE}/a.html`);
  await click('#play');
  await sleep(1200);
  await click('#link');
});

// 4. location.replace, which is how the admin page goes back to the listening one
await run('A played, then a button whose handler calls location.replace', async () => {
  await goto(`${BASE}/a.html`);
  await click('#play');
  await sleep(1200);
  await click('#rep');
});

// 5. the control again: if this one plays, the runs above proved nothing
await run('B cold again, after all that playing', async () => {
  await goto(`${BASE}/b.html`);
});

console.log('\n--- what this says ---');
const controls = [results[0], results[results.length - 1]];
const navs = results.slice(1, -1);
if (controls.some((r) => r.playing)) {
  console.log('VOID: a page with no gesture behind it played anyway, so nothing here');
  console.log('      distinguishes the gesture from the browser simply allowing it.');
} else if (navs.every((r) => r.playing)) {
  console.log('Every way the app navigates carries the permission to play into the new');
  console.log('page. Picking the book up on the other page will really carry on playing.');
} else {
  console.log('Not every way of navigating carries it — see which, above:');
  navs.forEach((r) => console.log(`  ${r.playing ? 'carries' : 'does not'}: ${r.name}`));
}

ws.close();
edge.kill();
process.exit(0);
