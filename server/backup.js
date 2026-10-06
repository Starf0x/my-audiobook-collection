// A copy of the database, kept beside it.
//
// The audiobooks live on a share and survive almost anything. Everything this
// app knows about them does not: where each person is in each book, the accounts
// and their passwords, the completions a level is counted from, the hearts, what
// was downloaded — all of it is in one file, `library.db`, and until now there
// was no second copy of it anywhere. The files on disk cannot rebuild any of it.
// Losing that file loses years of listening, quietly, and nothing would say so
// until somebody opened the app and found themselves a stranger to it.
//
// `VACUUM INTO` rather than a file copy. A copy taken while the app is running
// can catch a half-written page and produce a file that opens and is wrong,
// which is worse than no backup at all; `VACUUM INTO` is a transaction, so what
// it writes is the database as it stood at one moment. It also writes a compact
// copy, which is why these are smaller than the original.
//
// They go in `DATA_DIR/backups`, beside the database: the same volume the owner
// already keeps, so a backup of their appdata takes these with it. That is not
// an off-site copy and is not pretended to be — it is for the loss that actually
// happens, which is a file going wrong rather than a disk going away.
import fs from 'node:fs';
import path from 'node:path';
import { db, DATA_DIR } from './db.js';

export const KEEP = 7;
const EVERY = 24 * 60 * 60 * 1000;
const dir = () => path.join(DATA_DIR, 'backups');

// `library-2026-10-06.db`: one a day, named for the day, so a second run on the
// same day replaces that day's rather than making a second of it.
const nameFor = (when) => `library-${new Date(when).toISOString().slice(0, 10)}.db`;

export function listBackups() {
  try {
    return fs.readdirSync(dir())
      .filter((f) => /^library-\d{4}-\d{2}-\d{2}\.db$/.test(f))
      .sort()
      .map((f) => {
        const full = path.join(dir(), f);
        return { name: f, bytes: fs.statSync(full).size, at: fs.statSync(full).mtime.toISOString() };
      });
  } catch {
    return [];
  }
}

// Takes one, drops the oldest beyond KEEP, and answers what it did. It never
// throws: a backup that cannot be written must not stop the app serving books,
// and the reason is worth more in the log than in a stack.
export function backupNow(when = Date.now()) {
  try {
    fs.mkdirSync(dir(), { recursive: true });
    const to = path.join(dir(), nameFor(when));
    // VACUUM INTO refuses a file that is already there, and today's may be
    const tmp = `${to}.writing`;
    fs.rmSync(tmp, { force: true });
    // the path goes into SQL, so a quote in it would end the string early
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    fs.rmSync(to, { force: true });
    fs.renameSync(tmp, to);

    const old = listBackups().slice(0, -KEEP);
    for (const b of old) fs.rmSync(path.join(dir(), b.name), { force: true });
    const size = fs.statSync(to).size;
    console.log(`Backed up the database to ${to} (${Math.round(size / 1024)} kB)`
      + (old.length ? `, and dropped ${old.length} older` : ''));
    return { name: nameFor(when), bytes: size, dropped: old.length };
  } catch (e) {
    console.error(`Could not back up the database: ${e.message}`);
    return { error: e.message };
  }
}

// One at startup, so a container that is restarted often still leaves copies,
// and one a day after that. `unref` so this timer alone never holds the process
// open — the suites start the app and expect to be able to leave.
export function scheduleBackups() {
  backupNow();
  setInterval(() => backupNow(), EVERY).unref();
}
