// One job at a time, on the server.
//
// The page already refuses to start a second job while one is running — that is
// `work()` in app.js, and it is what keeps somebody from pressing Import twice.
// But a guard in a page guards one page. Two browsers, a phone beside a laptop,
// a reload in the middle of an import: each of those is a second request the
// page never knew about, and what they reach are routes that move folders,
// rename them and delete them.
//
// So the rule lives here as well, and here it is the real one. A job that moves
// files takes this; a second one is answered 409 with the name of the job it is
// waiting for, which is a sentence the page can show.
//
// Tag writes are deliberately not in it: each one touches only its own book's
// files and has its own single-writer guard in google.js, so two books can be
// written at once — that is measured and wanted (§7.3).
let holder = '';
let since = 0;

export const busyWith = () => holder;

// Take it, or say what has it. The name is what the page shows, so it reads like
// something a person started: "The import", "The conversion".
export function take(what) {
  if (holder) {
    const e = new Error(`${holder} is still running. Wait for it to finish.`);
    e.status = 409;
    e.busyWith = holder;
    throw e;
  }
  holder = what;
  since = Date.now();
  return () => {
    // only the holder may let go: a late finish must not free somebody else's job
    if (holder === what && since) {
      holder = '';
      since = 0;
    }
  };
}

// Run `fn` holding it, and let go however it ends.
export async function alone(what, fn) {
  const done = take(what);
  try {
    return await fn();
  } finally {
    done();
  }
}
