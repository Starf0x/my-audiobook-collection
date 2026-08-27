import { db } from './db.js';
import { applyMetadata, newTagProgress } from './google.js';

// Writing tags into a whole collection is an hour of work on a big share, so it
// runs here rather than in the browser: closing the page, or losing it, does not
// stop it. What is left to do is a queue in the database, which is what makes it
// resumable — after a stop, and after the container restarts mid-run.

const q = {
  run: db.prepare('SELECT * FROM tagrun WHERE id = 1'),
  put: db.prepare(`INSERT INTO tagrun (id, total, done, written, failed, state, current, started_at, finished_at)
                   VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET total = excluded.total, done = excluded.done,
                     written = excluded.written, failed = excluded.failed, state = excluded.state,
                     current = excluded.current, started_at = excluded.started_at,
                     finished_at = excluded.finished_at`),
  set: db.prepare('UPDATE tagrun SET done = ?, written = ?, failed = ?, current = ?, state = ? WHERE id = 1'),
  state: db.prepare('UPDATE tagrun SET state = ?, current = ?, finished_at = ? WHERE id = 1'),
  fill: db.prepare('INSERT OR IGNORE INTO tagqueue (book_id) SELECT id FROM books'),
  clear: db.prepare('DELETE FROM tagqueue'),
  next: db.prepare(`SELECT b.* FROM tagqueue t JOIN books b ON b.id = t.book_id
                    ORDER BY b.genre, b.author, b.title LIMIT 1`),
  drop: db.prepare('DELETE FROM tagqueue WHERE book_id = ?'),
  left: db.prepare('SELECT COUNT(*) AS n FROM tagqueue'),
  // a queued book that no longer exists would stall the run
  prune: db.prepare('DELETE FROM tagqueue WHERE book_id NOT IN (SELECT id FROM books)'),
};

let working = false;   // is the loop running in this process
let stopping = false;
// its own count, so the bar of a single book's write never mixes with this one
const mine = newTagProgress();

export const tagAllWorking = () => working;

const now = () => new Date().toISOString();

export function tagStatus() {
  const run = q.run.get();
  const left = q.left.get().n;
  if (!run) return { state: 'idle', total: 0, done: 0, written: 0, failed: 0, left: 0, current: '', running: false };
  return { ...run, left, running: working };
}

async function loop() {
  if (working) return;
  working = true;
  stopping = false;
  try {
    q.prune.run();
    for (;;) {
      if (stopping) {
        q.state.run('paused', 'Stopped', now());
        return;
      }
      const book = q.next.get();
      if (!book) {
        const run = q.run.get() || {};
        q.state.run('done', `Finished: ${run.written || 0} file(s) tagged in ${run.done || 0} book(s)`, now());
        return;
      }
      const run = q.run.get();
      q.set.run(run.done, run.written, run.failed, book.title, 'running');
      let written = 0;
      let failed = 0;
      try {
        ({ written } = await applyMetadata(book, {}, true, mine));
      } catch {
        failed = 1; // one unreadable book must not stop the rest of the run
      }
      // Both together, or a container stopped between them leaves a book off the
      // queue that the count never counted: done + left would no longer be the
      // total, and the run would report one book short of what it wrote.
      db.exec('BEGIN');
      q.drop.run(book.id);
      q.set.run(run.done + 1, run.written + written, run.failed + failed, book.title, 'running');
      db.exec('COMMIT');
      // let the server answer requests between books
      await new Promise((r) => setImmediate(r));
    }
  } finally {
    working = false;
  }
}

// Start a new run, or pick up one that was stopped or interrupted.
export function startTagAll() {
  const run = q.run.get();
  const left = q.left.get().n;
  if (working) return { ...tagStatus(), already: true };

  if (left && run && run.state !== 'done') {
    q.state.run('running', 'Resuming…', null);   // resume: the queue is what is left
  } else {
    q.clear.run();
    q.fill.run();
    q.put.run(q.left.get().n, 0, 0, 0, 'running', 'Starting…', now(), null);
  }
  loop().catch(() => {});
  return tagStatus();
}

export function stopTagAll() {
  if (!working) {
    const run = q.run.get();
    if (run && run.state === 'running') q.state.run('paused', 'Stopped', now());
    return tagStatus();
  }
  stopping = true;
  return { ...tagStatus(), stopping: true };
}

// A run that was going when the container stopped is left paused, not restarted:
// writing to files is not something to begin again on its own.
export function settleTagAll() {
  const run = q.run.get();
  if (run && run.state === 'running') {
    q.state.run('paused', 'Stopped when the app restarted', now());
  }
}
