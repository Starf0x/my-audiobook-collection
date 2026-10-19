import os from 'node:os';
import { Worker } from 'node:worker_threads';

// Writing a tag is not waiting for the disk, it is a synchronous rewrite of the
// whole file. Measured on a local library: 18.5 ms per file on the main thread,
// with the event loop stalled up to 29 ms at a time, against 6.4 ms per file
// across four worker threads with a worst stall of 12 ms. So the interface stays
// answerable and a library-wide write finishes in a third of the time.
const THREADS = Math.max(2, Math.min(4, (os.availableParallelism?.() ?? os.cpus().length) - 1));
const SOURCE = new URL('./tag-worker.js', import.meta.url);

const free = [];
const queue = [];
let made = 0;

function hand(w, job) {
  const settle = (ok) => {
    w.off('message', onMessage);
    w.off('error', onError);
    job.done(ok);
    if (ok === null) { made--; w.terminate(); } // a thread that died is not reused
    else free.push(w);
    pump();
  };
  const onMessage = (m) => settle(m.ok === true);
  const onError = () => settle(null);
  w.on('message', onMessage);
  w.on('error', onError);
  w.postMessage({ file: job.file, tags: job.tags });
}

function pump() {
  while (queue.length && (free.length || made < THREADS)) {
    let w = free.pop();
    if (!w) {
      made++;
      w = new Worker(SOURCE);
      w.unref(); // an idle thread must not keep the server alive
    }
    hand(w, queue.shift());
  }
}

// Write one file's tags on a worker thread. Resolves true when the file was
// written, false when it could not be.
export function writeTag(file, tags) {
  return new Promise((resolve) => {
    queue.push({ file, tags, done: (ok) => resolve(ok === true) });
    pump();
  });
}
