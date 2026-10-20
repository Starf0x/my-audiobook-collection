// Putting a folder's ownership and modes right, all the way down.
//
// The Folder permissions check in Settings says what each folder lets this app
// do; the owner asked for the other half — a button that makes it so, in the
// subfolders too (2.14.112). His `Juvenile Fiction` read `0:0 · 755` beside
// genres at `1000:100 · 777`: made as root, by a run before PUID was set, and
// so a folder he could not write in from his own share.
//
// Only the folders that check lists — the libraries and the import folder — and
// only by their exact path: this changes ownership on a disk, and the request
// that asks for it must not be able to name anywhere else.
import fs from 'node:fs';
import path from 'node:path';
import { getLibraries, getSetting } from './db.js';

// Who the files should belong to. PUID and PGID when they are set, which is
// what the container was told; otherwise this process, when it is not root;
// otherwise whoever owns the folder above — the share's own owner, the same hint
// `user.js` takes for the data folder. Root with nothing to go on is refused:
// handing a collection to root is the thing this exists to undo.
const num = (raw) => {
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isInteger(n) && n >= 0 ? n : null;
};

export function ownerFor(dir) {
  const puid = num(process.env.PUID);
  const pgid = num(process.env.PGID);
  if (puid !== null && pgid !== null) return { uid: puid, gid: pgid, from: 'PUID and PGID' };
  const me = typeof process.getuid === 'function' ? process.getuid() : null;
  if (me === null) return { uid: null, gid: null, from: 'this platform has no owners to set' };
  if (me !== 0) return { uid: me, gid: process.getgid(), from: 'the user this app runs as' };
  try {
    const above = fs.statSync(path.dirname(path.resolve(dir)));
    if (above.uid !== 0) return { uid: above.uid, gid: above.gid, from: `the owner of ${path.dirname(dir)}` };
  } catch { /* not there: nothing to follow */ }
  return null;
}

// The modes a folder and a file should have: everything the umask allows. With
// UMASK=000, which is Unraid's, that is 777 and 666 — what the rest of the owner's
// collection already had.
export const modesFor = (umask = process.umask()) => ({
  dir: 0o777 & ~umask,
  file: 0o666 & ~umask,
});

// The folders it may be asked about, by the path the check showed.
export function fixable() {
  const out = getLibraries().map((l) => l.path).filter(Boolean);
  const imp = getSetting('importPath');
  if (imp) out.push(imp);
  return out;
}

let running = false;

// Walk the tree and put each thing right, counting what changed and what could
// not be. Symlinks are left alone — following one could lead off the share, and
// changing the link itself means nothing. A failure is counted and the walk
// goes on: one root-owned file must not stop the other ten thousand.
export async function fixTree(root, { owner, modes } = {}) {
  if (running) throw new Error('A permission fix is already running. Wait for it to finish.');
  running = true;
  const said = { folders: 0, files: 0, changed: 0, failed: 0, firstFailures: [] };
  const fail = (p, e) => {
    said.failed++;
    if (said.firstFailures.length < 5) said.firstFailures.push(`${p}: ${e.code || e.message}`);
  };
  const visit = async (p) => {
    let st;
    try { st = await fs.promises.lstat(p); } catch (e) { return fail(p, e); }
    if (st.isSymbolicLink()) return undefined;
    const dir = st.isDirectory();
    if (dir) said.folders++; else said.files++;
    let touched = false;
    if (owner && owner.uid !== null && (st.uid !== owner.uid || st.gid !== owner.gid)) {
      try { await fs.promises.chown(p, owner.uid, owner.gid); touched = true; } catch (e) { fail(p, e); }
    }
    const want = dir ? modes.dir : modes.file;
    if ((st.mode & 0o777) !== want) {
      try { await fs.promises.chmod(p, want); touched = true; } catch (e) { fail(p, e); }
    }
    if (touched) said.changed++;
    if (!dir) return undefined;
    let names = [];
    try { names = await fs.promises.readdir(p); } catch (e) { return fail(p, e); }
    for (const n of names) await visit(path.join(p, n)); // eslint-disable-line no-await-in-loop
    return undefined;
  };
  try {
    await visit(root);
  } finally {
    running = false;
  }
  return said;
}

// A library folder that is not there any more, taken off the list. Only one that
// is really gone: a folder that answers is not forgotten by this, however it was
// asked. Nothing is taken off by itself — a share that is not mounted for a
// moment would otherwise lose every library it holds.
export function forgetLibrary(dir, setLibraries) {
  if (fs.existsSync(dir)) throw new Error(`${dir} is there, so it is not forgotten.`);
  const libs = getLibraries();
  const left = libs.filter((l) => l.path !== dir);
  if (left.length === libs.length) throw new Error(`${dir} is not one of the libraries.`);
  setLibraries(left);
  return { forgotten: dir, left: left.length };
}
