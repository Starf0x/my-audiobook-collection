// plays-on — the book goes on playing when you move between the app's pages.
//
// The app is three documents: / , /admin and /ha. Every switch between them
// destroys the <audio> element, so "it keeps playing" has to be built. This
// suite walks all five switches the interface offers and asserts the book is
// still playing on the other side, at the place it had reached.
//
// Run:  node plays-on.mjs            (headless)
//       node plays-on.mjs --window   (watch it happen)
import { spawn, spawnSync } from 'node:child_process';
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
  const edge = spawn(browser, [...theseArgs, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const said = [];
  for (const pipe of [edge.stdout, edge.stderr]) pipe.on('data', (d) => said.push(String(d)));
  // Only a *failed* exit means give up. The process that is spawned is a
  // launcher: recent Edge starts the browser proper in a tree of its own and
  // lets the launcher return 0 straight away, so "it exited" says nothing about
  // whether a browser is coming. Treating any exit as failure stopped the wait
  // the instant the hand-over happened, and the suite reported a browser that
  // never opened its port while the port was open and answering.
  let gone = null;
  edge.on('exit', (code, signal) => {
    if (code !== 0 || signal) gone = `exit ${code}${signal ? ` on ${signal}` : ''}`;
  });

  // Ninety seconds, which is not generosity but arithmetic: on the build machine
  // a cold Edge took 28 seconds to open its port on the run that passed and more
  // than 30 on the one that did not — the same commit, one job each way. A wait
  // that the usual case finishes just inside is a coin toss, not a timeout. It
  // costs nothing when the browser is quick, because this stops the moment the
  // port answers or the process exits.
  //
  // And it says how long it took, so the next argument about this number is had
  // with a measurement instead of a theory. The first one was not: the session
  // bus the browser complains about looked like the cost, and handing it a
  // different address changed nothing that could be seen.
  const startedAt = Date.now();
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
    killTree(edge);
    throw new Error(`the browser never opened its debugging port${gone ? ` (${gone})` : ''}`
      + `\n  ran: ${browser} ${theseArgs.join(' ')}`
      + `\n  it said: ${said.join('').trim().slice(0, 1500) || '(nothing at all)'}`);
  }
  console.log(`(its debugging port answered after ${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
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

// A browser is a tree of processes — the one that was spawned, then a renderer,
// a GPU process, a network service and more. `child.kill()` kills the one that
// was spawned and leaves the rest, which go on holding the profile folder and
// the debugging port. Nine of them had piled up across one session before a run
// finally could not open its port and said the browser had never answered.
// And the tree cannot be reached through the launcher, which has usually gone by
// then. What every one of those processes does carry is the profile folder on
// its command line — this suite's own, under fixtures — so that is what they are
// found by. Nothing outside that folder is touched, so a browser the owner is
// using is never a candidate.
const killTree = (child) => {
  child.kill();
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    return;
  }
  const mine = PROFILE.replace(/\\/g, '\\\\');
  spawnSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" `
    + `| Where-Object { $_.CommandLine -like '*${mine.split('\\').pop()}*' } `
    + '| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'],
  { stdio: 'ignore' });
};

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
    // and the home shelves, which `begin` draws *after* the genres: browsing
    // before they land lets them draw over the author's books, and a whole run
    // once broke on "gave up waiting for the book card" with the shelf on screen
    await waitFor(`document.querySelector('#books .list .shelf, #books .list .card')`, 'the home shelves');

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

    // 6. the phone, which is the one layout no other suite can see
    //
    // The owner sent a screenshot with five faults on one screen: Sign out stranded
    // in the middle of the top row, the bar carrying its own pause button next
    // to a cover that is the same button, a bare ⤓ beside a volume slider, ✕
    // parked mid-bar, and the chapter line — the longest text in the bar —
    // clipped to 45% of the width.
    //
    // Every one of those is a computed position, and `pages` cannot see a single
    // one: jsdom has no layout engine, so a stylesheet that puts a control in
    // the wrong place is a change nothing in the suites notices. This is the
    // only suite with a real one. The note at the top of this file says it is
    // not about the phone layout, and that was true until the phone layout was
    // the thing being reported.
    // The long chapter name is not a phone problem, it only showed up as one.
    // A desktop window is wider, and the select grew wider still: 498px, a bar
    // of 1436 inside a window of 1265, and a sideways scrollbar on the page. So
    // it is asked here too, at the width the suite has been running at all
    // along, before anything is told it is a phone.
    const wide = await evaluate(`(() => {
      const sel = document.querySelector('#trackSelect');
      sel.dataset.was = sel.options[0].textContent;
      sel.options[0].textContent = '23. 23 - A Memory of Light - Chapter 23 - The Last Battle Begins At Dawn';
      const was = { sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        selectWidth: Math.round(sel.getBoundingClientRect().width) };
      sel.options[0].textContent = sel.dataset.was;
      return was;
    })()`);
    check('a long chapter name does not widen the page on a desktop either',
      [wide.sideways, wide.selectWidth <= 240], [false, true]);
    // On a wide screen the speed is chosen in the bar, so what is left at that
    // speed is shown beside it — on screen, asked of its box and not its text,
    // since a hidden span answers `textContent` just as happily.
    const barLeft = await evaluate(`(() => {
      const el = document.querySelector('footer #pLeft');
      if (!el) return { missing: true };
      const r = el.getBoundingClientRect();
      return { says: el.textContent, w: Math.round(r.width),
        shown: getComputedStyle(el).display !== 'none' };
    })()`);
    check('on a desktop the bar says how long is left, beside the speed',
      [barLeft.shown, barLeft.w > 0, /^\S.* left/.test(barLeft.says || '')], [true, true, true]);

    // Pressing Play on a desktop stays on the shelf, which is the half of the
    // next section that has to be asked at this width. `/player` is the phone's
    // answer to a bar with no room in it; a desktop window holds the shelf and
    // the bar at once, and taking the whole window away to show one book would
    // be a loss there rather than a gain. Asked of a *paused* book, so this is a
    // press that starts one — the very press that leaves the page on a phone.
    await goto(`${BASE}/`, '/');
    await pickedUp();
    // the shelf is drawn after `/api/home` answers, which can be after the
    // player has picked the book up — ask for the card, do not assume it
    await waitFor(`document.querySelector('.card[data-id]')`, 'the carry-on card');
    const theBook = await evaluate(`(() => {
      const c = document.querySelector('.card[data-id]');
      return c ? c.dataset.id : null;
    })()`);
    const press = `.card[data-id="${theBook}"] .actions button`;
    await click(press);
    await sleep(500);
    check('pressing Play on a desktop stays on the shelf',
      [await evaluate('location.pathname'), (await snap()).paused], ['/', false]);
    // and back to paused, which is how the phone pass below expects to find it
    await evaluate(`document.querySelector('#audio').pause()`);
    await sleep(200);

    await send('Emulation.setDeviceMetricsOverride', {
      width: 375, height: 812, deviceScaleFactor: 1, mobile: true,
    });
    // Straight there rather than by a button: the checks above are about
    // carrying a book between pages and this one is about where the controls
    // land, so the listening page is a destination here, not a journey. It has
    // to be that page and not the admin one — Sign out is only on this header.
    await goto(`${BASE}/`, '/');
    await pickedUp();
    // The bar's own button, not the cover: on a phone the cover is the way to
    // `/player`, which is checked at the end of this section.
    await click('#pPlay');
    // Waiting for the clock to move, not for `paused` to turn false. `play()`
    // clears `paused` on the spot and the `play` event — which is what redraws
    // the glyph — is a task behind it, so a wait on `paused` lets the glyph be
    // read in the gap between the two and the check fails for the suite's own
    // timing rather than for anything the app did.
    const resumedAt = await evaluate(`document.querySelector('#audio').currentTime`);
    await waitFor(`document.querySelector('#audio').currentTime > ${resumedAt + 0.3}`,
      'the book to be playing again');

    const phone = await evaluate(`(() => {
      const box = (s) => {
        const e = document.querySelector(s);
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, right: r.right, top: r.top, shown: getComputedStyle(e).display !== 'none', text: e.textContent.trim() };
      };
      const bar = document.querySelector('#player').getBoundingClientRect();
      const head = document.querySelector('header').getBoundingClientRect();
      return {
        width: innerWidth,
        bar: { left: bar.left, right: bar.right, width: bar.width },
        head: { right: head.right },
        signOut: box('#signOut'), brand: box('#brand'),
        cover: box('#player .cover'), close: box('#pClose'),
        track: box('#trackSelect'), seek: box('#seek'),
        play: box('#pPlay'), get: box('#pGet'),
        glyph: document.querySelector('#player .cover').dataset.glyph,
        getSays: document.querySelector('#pGet').textContent.trim(),
      };
    })()`);

    check('the phone really is a phone', phone.width, 375);
    // The bug the owner reported first, and the one no amount of looking at a short
    // chapter name would have found. A `<select>` sizes itself to its widest
    // option and a flex item's automatic minimum is its content, so one long
    // chapter made the bar wider than the window and gave the whole page a
    // sideways scrollbar — on the phone *and* on the desktop.
    const stretched = await evaluate(`(() => {
      const sel = document.querySelector('#trackSelect');
      sel.dataset.was = sel.options[0].textContent;
      sel.options[0].textContent = '23. 23 - A Memory of Light - Chapter 23 - The Last Battle Begins At Dawn';
      const bar = document.querySelector('#player').getBoundingClientRect();
      const r = sel.getBoundingClientRect();
      return {
        selectWidth: Math.round(r.width), barWidth: Math.round(bar.width),
        pastTheBar: r.right > bar.right + 1,
        sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    })()`);
    check('a chapter with a long name stays inside the bar',
      [stretched.pastTheBar, stretched.selectWidth <= stretched.barWidth], [false, true]);
    check('and does not give the page a sideways scrollbar', stretched.sideways, false);
    await evaluate(`(() => {
      const sel = document.querySelector('#trackSelect');
      sel.options[0].textContent = sel.dataset.was;
    })()`);
    // Sign out sat next to the name in the middle of the row, because the block
    // that names who is signed in had nothing to take up the space beside it.
    check('Sign out is at the right edge of the header, not adrift in the middle',
      phone.head.right - phone.signOut.right < 20, true);
    check('and it is above the app’s own name, not beside it',
      phone.signOut.top < phone.brand.top, true);
    // The owner's screenshot: the column's sticky head ("‹ Back  Books  Home") had
    // the text of a card scroll under it, and the card's cover and its heart
    // slide over it. A sticky element with no z-index is painted in page order,
    // and everything positioned after it — the cover, the heart, a tile — comes
    // later. Asked of pixels, not markup: scroll the heart under the head and
    // ask the browser what it would hit there. The shelf is padded out so it
    // can scroll at all; the padding goes again before anything else is asked.
    const under = await evaluate(`(() => {
      const col = document.querySelector('#books');
      const head = col.querySelector('.col-title');
      const heart = col.querySelector('.heart');
      if (!head || !heart) return { missing: !head ? 'head' : 'heart' };
      const pad = document.createElement('div');
      pad.style.height = '2000px';
      col.appendChild(pad);
      col.scrollTop = 0;
      const h = head.getBoundingClientRect();
      const was = heart.getBoundingClientRect();
      col.scrollTop = (was.top + was.height / 2) - (h.top + h.height / 2);
      const at = heart.getBoundingClientRect();
      const hit = document.elementFromPoint(at.left + at.width / 2, h.top + h.height / 2);
      const result = { under: at.top < h.bottom && at.bottom > h.top, onTop: !!hit && head.contains(hit) };
      pad.remove();
      col.scrollTop = 0;
      return result;
    })()`);
    check('a cover scrolled under the column head goes behind it, heart and all',
      [under.under, under.onTop], [true, true]);
    // The bar keeps its own play/pause, and it says what it does rather than
    // leaving a glyph in a box to be recognised. It was taken out once, on the
    // grounds that the cover beside it is the same button — but the cover is
    // something you have to already know, and the card's button is only on
    // screen while you are looking at that book.
    check('the bar has its own play/pause', phone.play.shown, true);
    check('and it says what pressing it does, not only a glyph',
      /Pause|Resume|Play/.test(phone.play.text), true);
    // One width whatever it says. The bar wraps on a phone, so what its row
    // demands decides how many rows the bar has and therefore how tall it is —
    // and "▶ Resume" is wider than "⏸ Pause". On a screen with less to spare
    // than that difference, pressing pause wraps the row, the bar gains a row,
    // and it moves up under the thumb mid-press. The owner reported exactly that on
    // a Galaxy S25; it was never reproduced here, where the row had 28px of
    // slack, which is roughly what a different system font is worth.
    //
    // So this does not check that the bar stays put — it checks the thing that
    // could move it. The clock is held to one width for the same reason, or a
    // book crossing an hour does the same thing on its own.
    const labels = await evaluate(`(() => {
      const b = document.querySelector('#pPlay');
      const was = b.textContent;
      const widths = {};
      for (const t of ['⏸ Pause', '▶ Resume', '▶ Play']) {
        b.textContent = t;
        widths[t] = Math.round(b.getBoundingClientRect().width);
      }
      b.textContent = was;
      const tick = document.querySelector('#pOf');
      const tickWas = tick.textContent;
      tick.textContent = '9:59';
      const short = Math.round(tick.getBoundingClientRect().width);
      tick.textContent = tickWas;
      return { widths, short, reserved: Math.round(tick.getBoundingClientRect().width) };
    })()`);
    check('and it is one width whatever it says, so pressing it moves nothing',
      new Set(Object.values(labels.widths)).size, 1);
    check('and the clock has a width of its own rather than the time’s',
      labels.short >= 30, true);
    // And the cover is no longer a third one. The owner counted three play/pause
    // buttons on one phone screen — the card's, the bar's, and the cover's —
    // and he was right. On a phone the cover is the way to the player's own
    // page instead, and says so rather than wearing a ⏸ that does not pause.
    check('the cover is not a third play/pause on a phone', phone.glyph, '⤢');
    // ✕ was parked mid-bar beside the chapter pulldown.
    check('✕ is at the top right of the bar',
      [phone.bar.right - phone.close.right < 20, Math.abs(phone.close.top - phone.cover.top) < 6],
      [true, true]);
    // The longest text in the bar had the narrowest box.
    check('the chapter line has the whole width',
      phone.track.w > phone.bar.width - 30, true);
    check('and so does the seek line', phone.seek.w > phone.bar.width - 30, true);
    // A lone arrow beside a volume slider, on a screen with no hovering to read
    // a title from, for the one control that writes a file to the device.
    check('the download says what it is', /Download/.test(phone.getSays), true);
    check('and it is on the same row as the clock, not on one of its own',
      Math.abs(phone.get.top - phone.seek.top) > 10 && phone.get.top < phone.seek.top, true);

    // 7. `/player`: the player and nothing else.
    //
    // The owner sent a video of the listening page on his phone — a column to
    // scroll past, with the book he was listening to somewhere in it, and
    // three buttons that all start and stop the same book. This is the answer:
    // one screen, one book, one play/pause, nothing to scroll.
    //
    // Reached by pressing Play on a book, and by tapping the cover in the bar.
    // It is a page of its own, so the book is carried across and picked up —
    // the same carry that already moves a book between `/`, `/admin` and `/ha`.
    //
    // The press is the one that was missing. `/player` was built and nothing
    // led to it but the cover, so a reader who pressed Play on a phone stayed
    // on the shelf with the cramped bar at the bottom — the very thing the page
    // was built to replace. The owner pressed play on his phone, did not see it,
    // and that is the whole of the bug.
    //
    // From an empty bar first, which is the press that matters most: the first
    // one of the day, with nothing in hand, taking the way through loading the
    // book rather than the short cut for the one already there.
    await click('#pClose');
    await sleep(300);
    check('the bar can be put away', (await snap()).hasPlayer, false);
    await click(press);
    await atPage('/player');
    await pickedUp();
    const pressed = await reallyPlaying();
    check('pressing Play on a phone opens the player page, playing',
      [pressed.title.length > 0, pressed.moving], [true, true]);

    await click('#back');
    await atPage('/');
    await pickedUp();
    // the shelf is drawn when `/api/home` answers, which can be after the player
    // has picked the book up — the same race as the desktop press above, and it
    // broke a whole run once
    await waitFor(`document.querySelector(${JSON.stringify(press)})`, 'the card to press again');

    // A press that stops a book is not a press that starts one, and carrying
    // somebody off to the player page to put a book down would be an odd thing
    // for a pause to do.
    await click(press);
    await sleep(500);
    const stopped = await snap();
    check('a press that stops a book stays on the shelf',
      [await evaluate('location.pathname'), stopped.paused], ['/', true]);

    // and the same press again, now that it starts rather than stops: the short
    // cut for the book already in hand, which is a second way into `playBook`
    // and would be a second way to stay on the shelf by mistake.
    await click(press);
    await atPage('/player');
    await pickedUp();
    const again = await reallyPlaying();
    check('pressing it again goes there and carries on where it stopped',
      [again.moving, carriedOn(again, stopped.at)], [true, true]);

    await click('#back');
    await atPage('/');
    await pickedUp();

    const wasPlaying = (await snap()).title;
    await click('#pCover');
    await atPage('/player');
    await pickedUp();

    const onPlayer = await evaluate(`(() => {
      const box = (s) => {
        const e = document.querySelector(s);
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) };
      };
      const doc = document.documentElement;
      return {
        title: (document.querySelector('#pTitle') || {}).textContent || '',
        author: (document.querySelector('#pAuthor') || {}).textContent || '',
        genre: (document.querySelector('#pGenre') || {}).textContent || '',
        genreW: Math.round((document.querySelector('#pGenre') || { getBoundingClientRect: () => ({ width: 0 }) })
          .getBoundingClientRect().width),
        chapter: (document.querySelector('#pTrack') || {}).textContent || '',
        play: box('#pPlay'), prev: box('#pPrev'), next: box('#pNext'),
        cover: box('#pCover'), seek: box('#seek'),
        // what is NOT here, which is half of what was asked for
        howManyPlayButtons: document.querySelectorAll(
          '#pPlay, .card .actions button, .tile .tplay, #books .cover').length,
        hasVolume: !!document.querySelector('#vol'),
        speeds: [...document.querySelectorAll('#pSpeed option')].map((o) => o.value),
        back10: !!document.querySelector('#pBack10'), fwd10: !!document.querySelector('#pFwd10'),
        hasChapterList: !!document.querySelector('#trackSelect'),
        scrollsDown: doc.scrollHeight > doc.clientHeight + 1,
        scrollsSideways: doc.scrollWidth > doc.clientWidth + 1,
        within: box('#now').bottom <= innerHeight + 1,
      };
    })()`);

    check('the player page carries the book that was playing', onPlayer.title, wasPlaying);
    check('and says who wrote it and which chapter this is',
      [onPlayer.author.length > 0, /\d+\/\d+/.test(onPlayer.chapter)], [true, true]);
    check('there is exactly one play/pause on it, and it is a thumb’s worth',
      [onPlayer.howManyPlayButtons, onPlayer.play.w >= 60, onPlayer.play.h >= 60],
      [1, true, true]);
    check('with a chapter back and a chapter on beside it',
      [!!onPlayer.prev, !!onPlayer.next], [true, true]);

    // Ten seconds back and ten on — the length of the sentence you just missed.
    // Through the *book*, not the file: ten back from a moment into a chapter
    // is the end of the one before, and a reader who meant "say that again"
    // does not care where the file boundary fell.
    // In the *second* chapter, which is the whole point of the next three
    // checks: in the first one the position in the book and the position in the
    // file are the same number, so a skip that forgot about the chapters before
    // it would land in exactly the right place and look correct.
    await click('#pNext');
    await sleep(600);
    // Paused, or the clock moves under the measurement and every number below
    // is the skip plus however long the step took.
    await evaluate(`document.querySelector('#audio').pause()`);
    await sleep(200);
    // Read off the clock the page shows, which is the position in the *book* —
    // `audio.currentTime` is the position in the file, and the two differ by
    // every chapter before this one. It is also what the reader is looking at,
    // so a skip that moves the audio and not the clock is still a bug.
    const where = () => evaluate(`(() => {
      const said = document.querySelector('#pAt').textContent.split(':').map(Number);
      const at = said.reduce((n, part) => n * 60 + part, 0);
      return { at, paused: document.querySelector('#audio').paused };
    })()`);
    const was = await where();
    await click('#pFwd10');
    await sleep(500);
    const on = await where();
    await click('#pBack10');
    await sleep(500);
    const back = await where();
    check('ten seconds on really moves ten seconds on',
      Math.abs((on.at - was.at) - 10) < 1.5, true);
    check('and ten back comes back to where it was',
      Math.abs(back.at - was.at) < 1.5, true);
    check('and neither starts a paused book playing',
      [on.paused, back.paused], [true, true]);

    // And over the edge of a chapter, which is the path the two above never
    // take: inside one chapter a skip only moves `currentTime`, and it is
    // crossing into another that loads a new file and has to decide whether to
    // play it. A reader who paused and then pressed ⟲10 has not asked for the
    // book to start again.
    await evaluate(`(() => {
      const a = document.querySelector('#audio');
      a.currentTime = 2;
      a.pause();
    })()`);
    await sleep(300);
    const chapterWas = await evaluate(`document.querySelector('#pTrack').textContent`);
    await click('#pBack10');
    await sleep(700);
    const over = await evaluate(`(() => ({
      chapter: document.querySelector('#pTrack').textContent,
      paused: document.querySelector('#audio').paused,
    }))()`);
    check('ten back near the start of a chapter steps into the one before',
      [over.chapter !== chapterWas, /^1\//.test(over.chapter)], [true, true]);
    check('and that does not start it playing either', over.paused, true);
    check('and nothing to scroll, either way',
      [onPlayer.scrollsDown, onPlayer.scrollsSideways, onPlayer.within], [false, false, true]);
    // The two the owner did not ask for: a phone has volume buttons on its side,
    // and the chapter list is a page away.
    check('and none of what was left off it',
      [onPlayer.hasVolume, onPlayer.hasChapterList], [false, false]);
    check('the cover is the biggest thing on it, which is the point',
      onPlayer.cover.h > onPlayer.play.h * 2, true);
    check('and the ten-second steps are both there',
      [onPlayer.back10, onPlayer.fwd10], [true, true]);
    // 1.0 to 2.0 in tenths, and nothing below 1: a book read slower than it was
    // recorded is a book read wrong.
    check('how fast it is read is a pulldown of eleven, 1.0 to 2.0',
      [onPlayer.speeds.length, onPlayer.speeds[0], onPlayer.speeds.at(-1)], [11, '1.0', '2.0']);

    // What is left follows the speed; how long the book is does not. The owner
    // asked for the first and chose to keep the second. Asked of a paused book,
    // so no timeupdate comes along to redraw it: the speed itself has to.
    // The minutes are worked out here from the two clocks the page shows, so
    // the check asks "is it the book's remainder over the speed", not "is it
    // some number".
    //
    // Two evaluates with the wait between them in here, not one async function:
    // `evaluate` does not await a promise, so an async one hands back `{}` — and
    // `{}.minutes === {}.want` is true, which is how the first draft of these
    // passed with nothing on the page at all.
    const atSpeed = async (speed) => {
      await evaluate(`(() => {
        const sel = document.querySelector('#pSpeed');
        sel.value = '${speed}';
        sel.dispatchEvent(new Event('change'));
      })()`);
      await sleep(300);
      return evaluate(`(() => {
      const secs = (t) => t.split(':').map(Number).reduce((n, p) => n * 60 + p, 0);
      const at = secs(document.querySelector('#pAt').textContent);
      const total = secs(document.querySelector('#pOf').textContent);
      const says = (document.querySelector('#pLeft') || {}).textContent || '';
      const m = says.match(/^(?:(\\d+)h )?(\\d+)m left/);
      return { says, total, rate: document.querySelector('#audio').playbackRate,
        minutes: m ? Number(m[1] || 0) * 60 + Number(m[2]) : null,
        want: Math.round((total - at) / ${speed} / 60) };
    })()`);
    };
    const normal = await atSpeed('1.0');
    const fast = await atSpeed('2.0');
    // `typeof … 'number'` first: without it an empty answer matches itself
    check('the player page says how long is left',
      [typeof normal.want, typeof normal.minutes, normal.minutes === normal.want, /×/.test(normal.says)],
      ['number', 'number', true, false]);
    check('and at 2× it is half of that, and says at what speed',
      [fast.rate, typeof fast.minutes, fast.minutes === fast.want, / at 2\.0×$/.test(fast.says)],
      [2, 'number', true, true]);
    check('while the length of the book stays the length of the book',
      [typeof fast.total, fast.total > 0, fast.total], ['number', true, normal.total]);
    // back to normal, which is what everything after this expects
    await atSpeed('1.0');

    // and the way back
    await click('#back');
    await atPage('/');
    check('and the way back to the shelves carries the book with it',
      (await reallyPlaying()).title, wasPlaying);

    // The genre beside the author, on screen and not only in the markup, and a
    // way into it. From `/player` there are no columns to open it in, so the
    // shelves open on it — with the book still going.
    check('the player page says the genre beside the author, on screen',
      [onPlayer.genre, onPlayer.genreW > 0], ['Fantasy', true]);
    await goto(`${BASE}/player`, '/player');
    await pickedUp();
    await click('#pGenre');
    await atPage('/');
    await waitFor(`[...document.querySelectorAll('#genres li.active')].some((l) => l.dataset.name === 'Fantasy')`,
      'the genre to be opened');
    const inGenre = await evaluate(`(() => ({
      col: document.body.dataset.col,
      authors: [...document.querySelectorAll('#authors li')].map((l) => l.dataset.name),
    }))()`);
    await pickedUp();
    check('and pressing it there opens that genre on the shelves, the book still playing',
      [inGenre.col, inGenre.authors.includes('Test Author'), (await reallyPlaying()).title],
      ['authors', true, wasPlaying]);

    await send('Emulation.clearDeviceMetricsOverride');

    check('and not one page threw anything along the way', broke, []);
  } finally {
    ws.close();
    killTree(edge);
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
