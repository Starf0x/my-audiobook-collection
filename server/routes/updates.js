// Is there a newer version, asking for it, how the update is getting on, and
// the database's own copies. Out of index.js since 2.14.152, as it was
// written, and mounted where it stood.
import path from 'node:path';
import { DATA_DIR } from '../db.js';
import { newestRelease, howInstalled, askForUpdate, lastUpdate, waiting as updateWaiting, newer, updateProgress } from '../updates.js';
import { progress } from '../scan.js';
import { requireAdmin } from '../admin.js';
import { listBackups, backupNow, KEEP as BACKUPS_KEPT } from '../backup.js';

export function mountUpdates(app, { VERSION, wrap }) {
  // --- is there a newer version ---------------------------------------------
  // The line of numbers says which version is answering, which tells you whether
  // this is the new one only if you already knew what the new one was. This is the
  // other half.
  //
  // Asking GitHub is slow and rate-limited, so `newestRelease` caches; `?ask=1` is
  // the button in Settings saying look again now.
  app.get('/api/update', requireAdmin, wrap(async (req, res) => {
    const seen = await newestRelease({ force: req.query.ask === '1' });
    const how = howInstalled();
    res.json({
      running: VERSION,
      newest: seen.newest,
      error: seen.error,
      behind: !!seen.newest && newer(seen.newest, VERSION),
      how,
      // Only an LXC install can take it from here. An image is updated by pulling
      // a new one, which is the host's job; a plain folder has the same two
      // commands but nothing root-owned to run them.
      canInstall: how === 'lxc',
      asked: updateWaiting(),
      last: lastUpdate(),
    });
  }));

  // Asks. It does not update: the app runs as PUID and can neither write in /opt
  // nor restart a unit, so it leaves a file and a root-owned path unit does the
  // work — and restarts this process in the middle of it, which is why the answer
  // goes out first and the page learns it worked by the version changing.
  app.post('/api/update', requireAdmin, (req, res) => {
    try {
      return res.json(askForUpdate());
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  });

  // Where the update has got to, for the bar. Asked every couple of seconds while
  // one runs; for two of its steps the app is down and this does not answer, and
  // the page says so rather than reading that as the update failing. `asked` is
  // whether root's side has picked the request up yet — the file is gone once it
  // has.
  app.get('/api/update/progress', requireAdmin, (req, res) => res.json({
    running: VERSION,
    progress: updateProgress(),
    asked: updateWaiting(),
  }));

  app.get('/api/backups', requireAdmin, (req, res) => res.json({
    folder: path.join(DATA_DIR, 'backups'), keep: BACKUPS_KEPT, items: listBackups(),
  }));
  app.post('/api/backups', requireAdmin, (req, res) => res.json(backupNow()));
}
