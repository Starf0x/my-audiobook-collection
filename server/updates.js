// Is there a newer version, and can this install take it.
//
// The app prints its version in the line of numbers under every page, which
// answers "is this the new one?" only if you already knew what the new one was.
// This is the other half: what the newest released version is, and what to do
// about it from here.
//
// **It never updates itself.** The app runs as PUID, not root — `user.js` drops
// before anything is created — so it can neither write in `/opt` nor restart a
// systemd unit, and that is a good thing rather than an obstacle to work around.
// A web page that can run a root script is a web page that can run a root script
// whoever reaches it, and with no ADMIN_PASSWORD set this one is open to the
// network by design. What it can do is ask: it writes a file in its own data
// folder, and a root-owned unit watching for that file does the update. The root
// side only ever does one fixed thing, so asking for it is not an escalation.
import fs from 'node:fs';
import path from 'node:path';

// The same line `db.js` uses, rather than importing it: this module needs the
// folder's name and nothing else, and importing `db.js` opens the database as a
// side effect — which makes "is 2.11.64 newer than 2.9.80?" a question that
// cannot be asked without one.
const DATA_DIR = process.env.DATA_DIR || '/data';

export const REPO = 'Starf0x/my-audiobook-collection';
const TAGS = `https://api.github.com/repos/${REPO}/tags?per_page=100`;

// Where the app lives, when it lives in a folder rather than an image.
const APP_DIR = '/opt/my-audiobook-collection';
const UNIT = 'my-audiobook-collection.service';
// The file the app writes to ask for an update, and the one the updater writes
// back with what happened. Both in DATA_DIR because that is the only folder the
// app is certain to own.
export const ASK = path.join(DATA_DIR, 'update-wanted');
export const SAID = path.join(DATA_DIR, 'update-said.json');

// "2.11.64" against "2.9.80": by number, part by part, because a string compare
// puts 2.9.80 above 2.11.64 and would offer an update backwards.
const parts = (v) => String(v || '').replace(/^v/, '').split('.').map((n) => Number(n) || 0);
export const newer = (a, b) => {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
};

// How this copy was installed, which decides what can be offered.
//
//  * `lxc`    — a git checkout with a systemd unit beside it, and the updater
//               installed. One button.
//  * `folder` — a git checkout without the updater: the same update, by hand.
//  * `image`  — Docker. Updating is pulling a new image, which is the host's
//               job and not something this app could do if it wanted to.
export function howInstalled() {
  if (fs.existsSync(path.join(APP_DIR, '.git'))) {
    return fs.existsSync(`/etc/systemd/system/${UNIT}`) ? 'lxc' : 'folder';
  }
  return 'image';
}

// GitHub allows sixty unauthenticated calls an hour per address, and the answer
// changes a few times a week. Asked at most once an hour, and a failure is
// remembered for ten minutes rather than retried on every page load — an app
// that cannot reach GitHub must not spend its time finding that out again.
let asked = { at: 0, newest: '', error: '' };
const HOUR = 60 * 60 * 1000;
const SULK = 10 * 60 * 1000;

export async function newestRelease({ force = false } = {}) {
  const age = Date.now() - asked.at;
  if (!force && asked.at && age < (asked.error ? SULK : HOUR)) return asked;
  try {
    const r = await fetch(TAGS, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': REPO },
      signal: AbortSignal.timeout(8000),
      // Where this asks is fixed and nothing in a request reaches it, so a
      // redirect could only ever take it somewhere it did not mean to go.
      redirect: 'error',
    });
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
    const tags = await r.json();
    // Highest by version, not first in the list: the API orders them its own
    // way, and "the newest" is a question about numbers.
    const names = (Array.isArray(tags) ? tags : []).map((t) => t && t.name).filter(Boolean);
    const newest = names.reduce((best, n) => (newer(n, best) ? n : best), '');
    if (!newest) throw new Error('no released versions found');
    asked = { at: Date.now(), newest: newest.replace(/^v/, ''), error: '' };
  } catch (e) {
    asked = { at: Date.now(), newest: asked.newest, error: e.message };
  }
  return asked;
}

// What the updater left behind about the last run, if it has run.
export function lastUpdate() {
  try {
    return JSON.parse(fs.readFileSync(SAID, 'utf8'));
  } catch {
    return null;
  }
}

// Ask for the update. Writing the file is the whole of it: a path unit owned by
// root is watching, and the service it starts does the work and restarts this
// app. So the answer goes out before any of that happens, and the page finds out
// it worked by the app coming back on a new version.
export function askForUpdate() {
  if (howInstalled() !== 'lxc') throw new Error('This copy cannot update itself; see Settings for how it is done here.');
  fs.writeFileSync(ASK, new Date().toISOString());
  return { asked: true };
}

export const waiting = () => fs.existsSync(ASK);
