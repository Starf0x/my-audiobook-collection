import os from 'node:os';

// Reading a tag is almost all waiting: on a share every read is a round trip to
// a disk that may still be spinning up. Measured on a real share, one book at a
// time cost 1160 ms and eight at a time 376 ms — three times faster for the same
// work, because the waits overlap instead of queueing.
//
// Two pieces: LANES caps how many reads are ever in flight at once, whatever
// asks for them, and pool() keeps that many items moving through a list. Only
// the reads themselves take a lane, so a pool of books whose files each take a
// lane cannot deadlock against itself.
export const LANES = Math.max(2, Math.min(8, (os.availableParallelism?.() ?? os.cpus().length) - 1));

let inFlight = 0;
const waiting = [];

// One disk read, in its turn.
export async function lane(fn) {
  if (inFlight >= LANES) await new Promise((go) => waiting.push(go));
  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
    const go = waiting.shift();
    if (go) go();
  }
}

// Work through a list with several items on the go, in order of finishing rather
// than in order: the caller keeps whatever order it needs itself.
export async function pool(items, fn, lanes = LANES) {
  let at = 0;
  const out = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(lanes, items.length) }, async () => {
    while (at < items.length) {
      const mine = at++;
      out[mine] = await fn(items[mine], mine);
    }
  }));
  return out;
}
