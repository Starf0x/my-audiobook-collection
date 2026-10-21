// What the app can do with the folders, and putting it right: the Folder
// permissions table in Settings, its Fix and its Forget. Out of index.js since
// 2.14.152, as it was written, and mounted where it stood.
import { writingAs } from '../user.js';
import fs from 'node:fs';
import path from 'node:path';
import { db, getSetting, setSetting, getLibraries, DATA_DIR } from '../db.js';
import { requireAdmin } from '../admin.js';
import { forget } from '../validate.js';
import { ownerFor, modesFor, fixable, fixTree, forgetLibrary } from '../perms.js';

export function mountFolders(app, { wrap }) {
  // --- what the app can actually do with the folders ----------------------
  // The answer to "why can I not write in my own collection": who this process is,
  // and what each folder lets it do. It writes a file and removes it again rather
  // than reading the mode and guessing.
  const canWrite = (dir) => {
    const probe = path.join(dir, `.write-test-${process.pid}`);
    try {
      fs.writeFileSync(probe, 'x');
      fs.rmSync(probe);
      return { canWrite: true, why: '' };
    } catch (e) {
      return { canWrite: false, why: e.code || e.message };
    }
  };

  const look = (what, dir) => {
    const out = { what, path: dir, exists: false, owner: '', mode: '', canWrite: false, why: '' };
    if (!dir) return { ...out, why: 'not set' };
    let stat;
    try {
      stat = fs.statSync(dir);
    } catch (e) {
      return { ...out, why: e.code === 'ENOENT' ? 'not there' : (e.code || e.message) };
    }
    out.exists = true;
    out.owner = `${stat.uid}:${stat.gid}`;
    out.mode = (stat.mode & 0o777).toString(8).padStart(3, '0');
    return { ...out, ...canWrite(dir) };
  };

  app.get('/api/permissions', requireAdmin, (req, res) => {
    const places = [look('Database and covers', DATA_DIR)];
    for (const lib of getLibraries()) places.push(look('Library', lib.path));
    const importPath = getSetting('importPath');
    if (importPath) places.push(look('Import folder', importPath));
    // one book, to show what the collection's own folders look like
    const book = db.prepare('SELECT path FROM books LIMIT 1').get();
    if (book) places.push(look('A book folder', book.path));
    res.json({ writingAs: writingAs(), places });
  });

  // Put a library's or the import folder's ownership and modes right, all the way
  // down, and say what it did and what it could not (2.14.112). Only a folder the
  // check above lists, named exactly: this changes ownership on the share.
  app.post('/api/permissions/fix', requireAdmin, wrap(async (req, res) => {
    const dir = String((req.body || {}).path || '');
    if (!fixable().includes(dir)) throw Object.assign(new Error('Only a library or the import folder can be put right here.'), { status: 400 });
    if (!fs.existsSync(dir)) throw Object.assign(new Error(`${dir} is not there.`), { status: 400 });
    const owner = ownerFor(dir);
    if (!owner) {
      throw Object.assign(new Error('There is nobody to hand these to: the app runs as root and PUID and PGID '
        + 'are not set. Set them on the container to the user that owns the share — 99 and 100 on Unraid.'), { status: 400 });
    }
    const modes = modesFor();
    const said = await fixTree(dir, { owner, modes });
    res.json({
      path: dir, ...said,
      owner: owner.uid === null ? '' : `${owner.uid}:${owner.gid}`, ownerFrom: owner.from,
      modes: { dir: modes.dir.toString(8), file: modes.file.toString(8) },
    });
  }));

  // And a library folder that is gone, taken off the list. Asked for, never done
  // by itself: a share not mounted for a moment would lose every library on it.
  app.post('/api/permissions/forget', requireAdmin, wrap(async (req, res) => {
    try {
      res.json(forgetLibrary(String((req.body || {}).path || ''),
        (libs) => setSetting('libraries', JSON.stringify(libs))));
    } catch (e) {
      throw Object.assign(e, { status: 400 });
    }
  }));
}
