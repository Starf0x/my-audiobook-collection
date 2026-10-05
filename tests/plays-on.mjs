// plays-on — the book goes on playing when you move between the app's pages.
//
// The app is three documents: / , /admin and /ha. Every switch between them
// destroys the <audio> element, so "it keeps playing" has to be built. This
// suite walks all five switches the interface offers and asserts the book is
// still playing on the other side, at the place it had reached.
//
// Run:  node plays-on.mjs            (headless)
//       node plays-on.mjs --window   (watch it happen)
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// One level up from tests/, not two: this suite was written where it used to
// live, a directory deeper, and when tests/ was committed in 2.6.64 the path
// came with it. It has been starting `…/Projects/server/index.js` — which does
// not exist — ever since, and the spec called it "run by hand" so nobody did.
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
// and its library, database and browser profile go in fixtures/ with every
// other suite's, rather than being built inside tests/ next to the source
const MINE = join(root, 'fixtures', 'plays-on-test');
const LIB = join(MINE, 'audiobooks');
const DATA = join(MINE, 'data');
const PROFILE = join(MINE, 'edge-profile');
// Whichever Chromium-family browser this machine has. It was one hard-coded
// Windows path, which is why this suite could not run on the build machine and
// so ran nowhere for two major features. Any of these will do — the suite only
// speaks CDP to it — and `PLAYS_ON_BROWSER` names one that is somewhere else.
const BROWSERS = {
  win32: [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
  linux: [
    '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ],
  darwin: [
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ],
};
function findBrowser() {
  const said = process.env.PLAYS_ON_BROWSER;
  if (said) {
    if (!existsSync(said)) throw new Error(`PLAYS_ON_BROWSER names ${said}, which is not there`);
    return said;
  }
  const tried = BROWSERS[process.platform] || [];
  const found = tried.find((p) => existsSync(p));
  if (found) return found;
  throw new Error(`no Chromium-family browser on this ${process.platform} machine.`
    + ` Looked for:\n  ${tried.join('\n  ')}\n`
    + 'Set PLAYS_ON_BROWSER to one, or install Edge, Chrome or Chromium.');
}
// The app has accounts now, so this walks it the way it is really reached: the
// administrator signs in at the gate and both pages open. Running it with no
// password would test the private install instead — a real arrangement, but not
// the one with a sign-in card standing over the page the player lives on.
const ADMIN = 'tester';
const PASSWORD = 'a very good password';
const PORT = 8531;
const CDP = 9334;
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { passed++; console.log(`ok   ${label}`); } else {
    failed++;
    console.log(`FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
  }
}

// --- the library --------------------------------------------------------
// One silent MPEG-1 Layer III frame, 32 kbps, 44.1 kHz: 104 bytes, of which
// four are the header. Repeat it and you have a file a browser really plays,
// for as long as you like, without a sound coming out of the machine.
const FRAME = Buffer.from(`fffb10c4${'00'.repeat(100)}`, 'hex');
const mp3 = (seconds) => Buffer.concat(Array(Math.round(seconds * 44100 / 1152)).fill(FRAME));

function buildLibrary() {
  rmSync(LIB, { recursive: true, force: true });
  rmSync(DATA, { recursive: true, force: true });
  const book = join(LIB, 'Fantasy', 'Test Author', 'The Long Book');
  mkdirSync(book, { recursive: true });
  // long tracks: the book must still be playing minutes into the suite
  writeFileSync(join(book, '01 - One.mp3'), mp3(300));
  writeFileSync(join(book, '02 - Two.mp3'), mp3(300));
  mkdirSync(DATA, { recursive: true });
}

// --- the server ---------------------------------------------------------
async function portFree(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(700) });
    return false;
  } catch { return true; }
}

async function startServer() {
  if (!await portFree(PORT)) {
    throw new Error(`something is already listening on ${PORT} — an answer from it is not this app's`);
  }
  const server = spawn(process.execPath, [join(root, 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: DATA,
      ADMIN_USER: ADMIN,
      ADMIN_PASSWORD: PASSWORD,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  for (let i = 0; i < 80; i++) {
    try {
      // one of the four routes that answer without an account: `/api/admin` is
      // behind the gate now and would say 401 for ever, which reads as a server
      // that never started
      const r = await fetch(`${BASE}/api/account/me`, { signal: AbortSignal.timeout(700) });
      if (r.ok) return server;
    } catch { /* still starting */ }
    await sleep(250);
  }
  throw new Error('the app never came up');
}

// Everything this suite asks of the app before the browser exists is asked as
// the administrator, because setting the library and scanning it are the
// administrator's to do.
let cookie = '';
const post = (path, body) => fetch(BASE + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify(body),
}).then((r) => r.json());
const get = (path) => fetch(BASE + path, { headers: cookie ? { Cookie: cookie } : {} });

async function signInOverHttp() {
  const r = await fetch(`${BASE}/api/account/signin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: ADMIN, password: PASSWORD }),
  });
  cookie = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('the app would not let the administrator in');
}

async function scanLibrary() {
  await signInOverHttp();
  await post('/api/settings', { libraries: [LIB], importPath: '' });
  await post('/api/scan', {});
  for (let i = 0; i < 120; i++) {
    const s = await (await get('/api/scan/status')).json();
    if (!s.running) break;
    await sleep(250);
  }
  const books = await (await get(`/api/search?q=${encodeURIComponent('The Long Book')}`)).json();
  if (!books.length) throw new Error('the scan found no books — the fixture is wrong, not the app');
  return books[0];
}

// --- the browser --------------------------------------------------------
const args = [
  `--remote-debugging-port=${CDP}`,
  `--user-data-dir=${PROFILE}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=msEdgeIdentityFre,msImplicitSignin',
];
// a desktop-sized window on purpose: below the app's breakpoint it shows one
// column at a time, and this suite is not about the phone layout
args.push('--window-size=1400,900');
if (!process.argv.includes('--window')) args.push('--headless=new');
// A build machine has no sound card and no desktop. Muting keeps a missing
// audio device from being the reason a book will not play — the suite reads
// `currentTime`, which moves whether or not anything is audible — and the
// sandbox needs the kernel namespaces a container usually does not give.
if (process.platform !== 'win32') {
  args.push('--mute-audio', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu');
}

let ws;
let nextId = 0;
const waiting = new Map();
const broke = [];

// A profile of its own, emptied first: a kept one carries cookies and
// sessionStorage, which here means the session the last run signed in with and
// the book it was carrying — the next run would start already signed in, with a
// player on screen before it had played anything, and the first check of all
// says there must not be one.
//
// A run that was killed leaves Edge holding that folder, and Windows then
// refuses to delete it: the suite used to die on EPERM and every later run died
// the same way until somebody noticed the stray processes. So a folder that
// cannot be emptied is not reused — this run takes a clean one beside it.
function freshProfile() {
  try {
    rmSync(PROFILE, { recursive: true, force: true });
    mkdirSync(PROFILE, { recursive: true });
    return PROFILE;
  } catch {
    const mine = `${PROFILE}-${process.pid}`;
    rmSync(mine, { recursive: true, force: true });
    mkdirSync(mine, { recursive: true });
    console.log('(the usual browser profile is held by something; using one of its own)');
    return mine;
  }
}

async function startBrowser() {
  const profile = freshProfile();
  const browser = findBrowser();
  const theseArgs = args.map((a) => a.replace(PROFILE, profile));
  console.log(`(browser: ${browser})`);
  // Its output is kept rather than thrown away. This used to be `stdio:
  // 'ignore'`, and when the browser would not start on the build machine all
  // the suite could say was "never opened its debugging port" — which is the
  // symptom, and says nothing about a missing library or a refused sandbox.
  // The build machine sets DBUS_SESSION_BUS_ADDRESS to something Chromium cannot
  // parse, and it spends seconds retrying a session bus that is not there and
  // that a headless browser does not need. Handing it an address that fails at
  // once rather than slowly is most of why this used to take nearly half a
  // minute to open its port.
  const env = process.platform === 'win32' ? process.env
    : { ...process.env, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/dev/null' };
  const edge = spawn(browser, [...theseArgs, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env });
  const said = [];
  for (const pipe of [edge.stdout, edge.stderr]) pipe.on('data', (d) => said.push(String(d)));
  let gone = null;
  edge.on('exit', (code, signal) => { gone = `exit ${code}${signal ? ` on ${signal}` : ''}`; });

  // Ninety seconds, which is not generosity but arithmetic: on the build machine
  // a cold Edge took 28 seconds to open its port on the run that passed and more
  // than 30 on the one that did not — the same commit, one job each way. A wait
  // that the usual case finishes just inside is a coin toss, not a timeout. It
  // costs nothing when the browser is quick, because this stops the moment the
  // port answers or the process exits.
  let url = '';
  for (let i = 0; i < 360 && !url && !gone; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
      url = (list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || {}).webSocketDebuggerUrl || '';
    } catch { /* not listening yet */ }
    if (!url) await sleep(250);
  }
  if (!url) {
    // it may still be running even though it never answered, and leaving it
    // would hold the profile folder and break the next run the same way
    edge.kill();
    throw new Error(`the browser never opened its debugging port${gone ? ` (${gone})` : ''}`
      + `\n  ran: ${browser} ${theseArgs.join(' ')}`
      + `\n  it said: ${said.join('').trim().slice(0, 1500) || '(nothing at all)'}`);
  }
  ws = new WebSocket(url);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error('cannot talk to the browser')); });
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    // The player was lifted out of two page scripts into one. A name left
    // behind would throw where nothing else looks, so the console is read.
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      broke.push(`${d.url || 'page'}:${d.lineNumber}: ${d.exception?.description || d.text}`);
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error'
      && msg.params.entry.source !== 'network') {
      broke.push(msg.params.entry.text);
    }
    if (!msg.id || !waiting.has(msg.id)) return;
    const { ok, no } = waiting.get(msg.id);
    waiting.delete(msg.id);
    if (msg.error) no(new Error(msg.error.message)); else ok(msg.result);
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  return edge;
}

const send = (method, params = {}) => new Promise((ok, no) => {
  const id = ++nextId;
  waiting.set(id, { ok, no });
  ws.send(JSON.stringify({ id, method, params }));
});

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};

async function waitFor(expression, what, ms = 8000) {
  for (let i = 0; i < ms / 100; i++) {
    const v = await evaluate(expression).catch(() => false);
    if (v) return true;
    await sleep(100);
  }
  // say what the page looked like instead, or this reads as "the app is broken"
  const seen = await evaluate(`JSON.stringify({
    at: location.pathname,
    col: document.body.dataset.col,
    // a dialog left open makes the whole document inert: clicks land nowhere
    openDialogs: [...document.querySelectorAll('dialog')].filter((d) => d.open).map((d) => d.id),
    genres: [...document.querySelectorAll('#genres ul li')].map((e) => e.textContent).slice(0, 5),
    authors: [...document.querySelectorAll('#authors ul li')].map((e) => e.textContent).slice(0, 5),
    books: (document.querySelector('#books .list') || {}).innerHTML?.slice(0, 300),
  })`).catch(() => '(and the page would not say)');
  throw new Error(`gave up waiting for ${what}\n  page: ${seen}`);
}

const atPage = (path) => waitFor(
  `document.readyState === 'complete' && location.pathname === ${JSON.stringify(path)}`,
  `the ${path} page`,
);

async function goto(url, path) {
  await send('Page.navigate', { url });
  await atPage(path);
}

// A trusted click: dispatched as real input, because element.click() is not a
// user gesture and the browser's autoplay rules count only real ones.
async function click(selector) {
  const box = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!box) throw new Error(`nothing clickable at ${selector}`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }
}

// Clicked by the words on it, not by position in a list: the column beside the
// genres also holds the Listened row, which is an <li> too and is hidden.
async function clickText(selector, text) {
  const box = await evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((e) => e.textContent.includes(${JSON.stringify(text)}));
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!box) throw new Error(`no visible ${selector} reading "${text}"`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }
}

const shows = (selector, text) => `[...document.querySelectorAll(${JSON.stringify(selector)})]
  .some((e) => e.textContent.includes(${JSON.stringify(text)}) && e.getBoundingClientRect().height > 0)`;

// what the player on this page is doing, whichever page it is
const snap = () => evaluate(`(() => {
  const a = document.querySelector('#audio');
  const foot = document.querySelector('#player');
  return {
    hasPlayer: !!foot && !foot.hidden,
    title: (document.querySelector('#pTitle') || {}).textContent || '',
    track: (document.querySelector('#trackSelect') || {}).value ?? '',
    paused: a ? a.paused : null,
    at: a ? a.currentTime : null,
  };
})()`);

// playing means the clock is really moving, not merely that paused is false
async function reallyPlaying() {
  const first = await snap();
  await sleep(1200);
  const then = await snap();
  return { ...then, moving: then.at > first.at, wasAt: first.at };
}

// Where it picked up, in seconds. A page that loaded nothing reports null here,
// and an empty player reports 0 — `null >= anything` and `0 >= -1` would both
// quietly pass, so a real place past the start is demanded.
// Bounded on both sides: it must not have gone backwards to the start, and it
// must not have landed somewhere else entirely in the book.
const carriedOn = (now, before) => typeof now.wasAt === 'number'
  && now.wasAt > 0 && now.wasAt >= before - 1 && now.wasAt <= before + 5;

// a wait that reports rather than ends the run, for the steps that are the
// thing under test: the rest of the checks are still worth seeing
const settle = (expression, ms = 8000) => waitFor(expression, '', ms).catch(() => false);

// The page has to fetch the book and seek before there is anything to read, so
// a measurement taken the instant it lands reads zero however well it works.
// This waits for the pick-up and no longer: if it never comes, the checks below
// fail on their own rather than being waited into passing.
const pickedUp = () => settle(
  `document.querySelector('#audio') && document.querySelector('#audio').currentTime > 0`, 5000,
);

// --- the walk -----------------------------------------------------------
async function run() {
  buildLibrary();
  const server = await startServer();
  const book = await scanLibrary();
  console.log(`(library: "${book.title}" by ${book.author})\n`);
  const edge = await startBrowser();

  try {
    // First, before a note has been played in this tab: a page opened cold must
    // not put a player on screen. Asked last it would prove nothing — by then
    // the tab has a book loaded, and leaving any page writes it down again.
    await goto(`${BASE}/admin`, '/admin');
    await sleep(800);
    check('nothing played, nothing carried', (await snap()).hasPlayer, false);

    // Signing in, the way somebody does. Until 2.7.0 this was a "who is
    // listening?" dialog and a name typed into it; it is an account now, and
    // the card is a plain element rather than a modal <dialog> — the top layer
    // belongs to whatever the browser and its extensions put there (2.7.32).
    // Nothing below this works until it is done: the page draws nothing for
    // somebody who is not signed in, because account.js is what calls `begin`.
    await goto(`${BASE}/`, '/');
    await waitFor(`!document.querySelector('#gate').hidden`, 'the sign-in card');
    await click('#giName');
    await send('Input.insertText', { text: ADMIN });
    await click('#giPass');
    await send('Input.insertText', { text: PASSWORD });
    await click('#giGo');
    await waitFor(`document.querySelector('#gate').hidden`, 'the sign-in card to go');
    await waitFor(shows('#genres li', 'Fantasy'), 'the Fantasy genre');

    // browse to the book and press its Play button — a real click, which is what
    // gives this page the right to make a sound in the first place
    await clickText('#genres li', 'Fantasy');
    await waitFor(shows('#authors li', 'Test Author'), 'the author');
    await clickText('#authors li', 'Test Author');
    await waitFor(`document.querySelector('#books .card .actions button')`, 'the book card');
    await click('#books .card .actions button');
    await waitFor(`document.querySelector('#audio').currentTime > 0.5`, 'the book to start');

    const started = await reallyPlaying();
    check('it plays on the listening page to begin with', started.moving, true);
    const title = started.title;

    // 1. / -> /admin, by the Admin button
    let before = (await snap()).at;
    await click('#toAdmin');
    await atPage('/admin');
    await pickedUp();
    let now = await reallyPlaying();
    check('/ to /admin: the player is there', now.hasPlayer, true);
    check('/ to /admin: it is the same book', now.title, title);
    check('/ to /admin: it is not paused', now.paused, false);
    check('/ to /admin: the clock is moving', now.moving, true);
    check('/ to /admin: it carried on from where it was', carriedOn(now, before), true);

    // 2. /admin -> /ha, through the Settings pulldown
    before = (await snap()).at;
    await click('#settingsMenu summary');
    await click('#openHa');
    await atPage('/ha');
    await pickedUp();
    now = await reallyPlaying();
    check('/admin to /ha: the player is there', now.hasPlayer, true);
    check('/admin to /ha: it is the same book', now.title, title);
    check('/admin to /ha: it is not paused', now.paused, false);
    check('/admin to /ha: the clock is moving', now.moving, true);
    check('/admin to /ha: it carried on from where it was', carriedOn(now, before), true);
    // the one thing a check cannot judge: whether that page, which is laid out
    // quite differently, has room for a player at the foot of it
    if (process.argv.includes('--shot')) {
      const png = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(here, 'ha-with-player.png'), Buffer.from(png.data, 'base64'));
      console.log('     (wrote ha-with-player.png)');
    }

    // 3. /ha -> /admin
    before = (await snap()).at;
    await click('#toAdmin');
    await atPage('/admin');
    await pickedUp();
    now = await reallyPlaying();
    check('/ha to /admin: it is still playing', now.moving && !now.paused, true);
    check('/ha to /admin: it carried on from where it was', carriedOn(now, before), true);

    // 4. /ha -> / , by the button on that page. Reached by clicking, the way a
    // reader gets there: a navigation the suite makes itself carries no gesture,
    // and would be measuring something else entirely.
    await click('#settingsMenu summary');
    await click('#openHa');
    await atPage('/ha');
    await settle(`document.querySelector('#audio') && document.querySelector('#audio').currentTime > 0`);
    before = (await snap()).at;
    await click('#toListen');
    await atPage('/');
    await pickedUp();
    now = await reallyPlaying();
    check('/ha to /: it is still playing', now.moving && !now.paused, true);
    check('/ha to /: it carried on from where it was', carriedOn(now, before), true);

    // 5. paused stays paused: a page switch must not start a book by itself
    await click('#pPlay');
    await sleep(300);
    check('pausing pauses it', (await snap()).paused, true);
    const pausedAt = (await snap()).at;
    await click('#toAdmin');
    await atPage('/admin');
    await settle(`document.querySelector('#audio') && document.querySelector('#audio').currentTime > 0`);
    const after = await reallyPlaying();
    check('a paused book comes back loaded', after.hasPlayer, true);
    check('a paused book comes back at its place', Math.abs(after.at - pausedAt) < 2, true);
    check('a paused book does NOT start playing by itself', after.paused, true);
    check('and its clock is not moving', after.moving, false);

    check('and not one page threw anything along the way', broke, []);
  } finally {
    ws.close();
    edge.kill();
    server.kill();
  }
}

run().then(() => {
  console.log(`\n${passed} ok, ${failed} FAIL`);
  if (!failed) console.log('all checks passed');
  process.exit(failed ? 1 : 0);
}).catch((e) => {
  console.error(`\nthe suite itself broke: ${e.message}`);
  process.exit(2);
});
