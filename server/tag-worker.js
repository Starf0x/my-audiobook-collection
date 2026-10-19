import { parentPort } from 'node:worker_threads';
import NodeID3 from 'node-id3';

// One file at a time, off the main thread. Writing a tag rewrites the whole MP3
// and node-id3 does it synchronously, so this is the one piece of work worth
// moving to a thread of its own.
parentPort.on('message', ({ file, tags }) => {
  let ok = false;
  try {
    ok = NodeID3.update(tags, file) === true;
  } catch { /* an unwritable file is reported, not thrown */ }
  parentPort.postMessage({ ok });
});
