import fs from 'node:fs';
import path from 'node:path';

// Who the app writes as.
//
// Left alone, a container runs as root, and every folder it creates on your share
// belongs to root with mode 755 — so the app can write there and you cannot. That
// is what makes an import land in a folder you are then refused permission to
// touch. Unraid's convention is PUID and PGID (99 and 100 for nobody:users), and
// UMASK for the mode; this honours all three, and drops to that user before
// anything is created or opened.
//
// Imported first in server/index.js, because the database module creates its own
// folder the moment it is loaded.

const num = (name) => {
  const raw = process.env[name];
  const n = Number(raw);
  return raw && Number.isInteger(n) && n >= 0 ? n : null;
};

if (process.env.UMASK) {
  const mask = parseInt(process.env.UMASK, 8);
  if (Number.isInteger(mask)) process.umask(mask);
}

let uid = num('PUID');
let gid = num('PGID');

// Nothing set, and running as root: write as whoever owns the data folder. On
// Unraid that folder is under appdata and belongs to nobody:users, which is what
// the shares expect — and a container that creates root-owned folders in someone's
// collection leaves them unable to touch their own files. Better to take the hint
// than to need a setting nobody knew about.
if (uid === null && gid === null && typeof process.getuid === 'function' && process.getuid() === 0) {
  const where = process.env.DATA_DIR || '/data';
  for (const p of [where, path.dirname(where)]) {
    try {
      const s = fs.statSync(p);
      if (s.uid !== 0) {
        uid = s.uid;
        gid = s.gid;
        console.log(`Nothing said who to write as, so following ${p}: ${uid}:${gid}`);
        break;
      }
    } catch { /* not there: try the folder above, then give up */ }
  }
}

if (uid !== null && gid !== null && typeof process.setuid !== 'function') {
  // Windows, for instance: say so, or a PUID that does nothing looks like a PUID
  // that worked.
  console.log(`PUID and PGID are set (${uid}:${gid}), but this platform cannot change user`);
}

if (uid !== null && gid !== null && typeof process.setuid === 'function') {
  const dataDir = process.env.DATA_DIR || '/data';
  // The folder may have been made by an earlier run as root: hand it over before
  // giving up the rights to do so, or the app cannot open its own database.
  const own = (p) => {
    try {
      const s = fs.statSync(p);
      if (s.uid !== uid || s.gid !== gid) fs.chownSync(p, uid, gid);
      if (s.isDirectory()) for (const e of fs.readdirSync(p)) own(path.join(p, e));
    } catch { /* not there, or not ours to change: the next step will say so */ }
  };
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    own(dataDir);
    process.setgid(gid);
    process.setuid(uid);
    console.log(`Running as ${uid}:${gid}` + (process.env.UMASK ? `, umask ${process.env.UMASK}` : ''));
  } catch (e) {
    console.log(`Could not run as ${uid}:${gid} (${e.message}) — carrying on as `
      + `${typeof process.getuid === 'function' ? process.getuid() : 'is'}`);
  }
}

// What the rest of the app should say when asked who it is writing as.
export const writingAs = () => ({
  uid: typeof process.getuid === 'function' ? process.getuid() : null,
  gid: typeof process.getgid === 'function' ? process.getgid() : null,
  umask: process.umask().toString(8).padStart(3, '0'),
  asked: { PUID: process.env.PUID || '', PGID: process.env.PGID || '', UMASK: process.env.UMASK || '' },
});
