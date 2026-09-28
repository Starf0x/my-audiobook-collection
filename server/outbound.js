// Fetching something this app was told about, rather than something it knows.
//
// A cover thumbnail is an address that arrived in a request, and this server
// sits on a home network where it can reach things a browser on the internet
// cannot — the router's admin page, other containers, the metadata address cloud
// hosts keep at 169.254.169.254. Fetching whatever it is handed makes it a proxy
// into that network for whoever can reach the admin page, and an unbounded read
// makes a big file somebody else's way of filling this disk.
//
// So: https only, the name resolved and every address it answers with refused if
// it is private, no redirects at all, a timeout, a byte ceiling, and the answer
// has to say it is a picture. None of that makes this safe against an attacker
// who controls DNS — the name is resolved here and again by `fetch`, and between
// those two the answer can change — and that is written down rather than pretended
// away: what it stops is the ordinary case, which is the case that happens.
import dns from 'node:dns/promises';
import net from 'node:net';

export const MOST = 8 * 1024 * 1024;
const TIMEOUT = 10000;

// Everything that is not a public address. A cover never lives on one of these.
function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127
      || (a === 169 && b === 254)                 // link-local, and the cloud metadata address
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127)       // carrier NAT, which is where Tailscale sits
      || a >= 224;                                 // multicast and above
  }
  const low = String(ip).toLowerCase();
  if (low === '::' || low === '::1') return true;
  if (low.startsWith('fe8') || low.startsWith('fe9') || low.startsWith('fea') || low.startsWith('feb')) return true;
  if (low.startsWith('fc') || low.startsWith('fd')) return true;   // unique local
  if (low.startsWith('::ffff:')) return isPrivate(low.slice(7));   // v4 in v6 clothing
  return false;
}

// The picture at that address, as bytes, or a reason it was not fetched.
export async function picture(rawUrl, { most = MOST, timeout = TIMEOUT } = {}) {
  let at;
  try {
    at = new URL(String(rawUrl || ''));
  } catch {
    return { error: 'That is not an address.' };
  }
  if (at.protocol !== 'https:') return { error: 'Only https addresses are fetched.' };

  let addresses = [];
  try {
    addresses = await dns.lookup(at.hostname, { all: true });
  } catch (e) {
    return { error: `${at.hostname} could not be looked up (${e.code || e.message}).` };
  }
  if (!addresses.length) return { error: `${at.hostname} resolves to nothing.` };
  if (addresses.some((a) => isPrivate(a.address))) {
    return { error: `${at.hostname} is on this network, and this app does not fetch pictures from it.` };
  }

  let res;
  try {
    res = await fetch(at, {
      // a redirect is another address, and it would arrive unchecked
      redirect: 'error',
      signal: AbortSignal.timeout(timeout),
      headers: { Accept: 'image/*' },
    });
  } catch (e) {
    return { error: `${at.hostname} did not answer (${e.name === 'TimeoutError' ? 'timed out' : e.message}).` };
  }
  if (!res.ok) return { error: `${at.hostname} answered ${res.status}.` };
  const kind = String(res.headers.get('content-type') || '').split(';')[0].trim();
  if (!kind.startsWith('image/')) return { error: `${at.hostname} answered with ${kind || 'nothing'}, not a picture.` };

  // read it a chunk at a time, and stop the moment it is bigger than a cover
  const parts = [];
  let size = 0;
  try {
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > most) {
        await res.body.cancel?.();
        return { error: `${at.hostname} is sending more than ${Math.round(most / 1e6)} MB, which is not a cover.` };
      }
      parts.push(Buffer.from(chunk));
    }
  } catch (e) {
    return { error: `The picture from ${at.hostname} broke off: ${e.message}` };
  }
  return { bytes: Buffer.concat(parts), kind };
}
