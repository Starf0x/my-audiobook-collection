// What a wrong password costs the asker.
//
// Two places compare a password now — the admin's and every listener's — and a
// rule with two readers drifts, so it lives here. Per address, and deliberately
// so: the point is to slow one machine down, not to lock the house because
// somebody in it mistyped. Five tries free, then a wait that doubles from half a
// second to thirty.
const tries = new Map();
const FREE = 5;
const MOST = 30000;
const FORGET = MOST * 4;

// How long this address still has to wait, in milliseconds.
export function waitFor(who) {
  const said = tries.get(who || '');
  if (!said || said.n <= FREE) return 0;
  const wait = Math.min(MOST, 500 * 2 ** (said.n - FREE - 1));
  return Math.max(0, said.at + wait - Date.now());
}

// Throw if this address is still waiting. The error carries `retryAfter`, which
// the route wrapper turns into a 429 with the header on it.
export function mustWait(who) {
  const left = waitFor(who);
  if (!left) return;
  const e = new Error(`Too many tries. Wait ${Math.ceil(left / 1000)} second(s).`);
  e.retryAfter = Math.ceil(left / 1000);
  throw e;
}

export function wrong(who) {
  const said = tries.get(who || '') || { n: 0, at: 0 };
  tries.set(who || '', { n: said.n + 1, at: Date.now() });
  // a container runs for months; what is long past its wait is not worth keeping
  if (tries.size > 1000) {
    for (const [k, v] of tries) if (Date.now() - v.at > FORGET) tries.delete(k);
  }
}

export const right = (who) => tries.delete(who || '');
