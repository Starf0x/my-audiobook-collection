// Telling Discord.
//
// Three things are worth a message: somebody asked for an account, somebody
// signed in, and somebody started or stopped a book. All three carry text that
// came from a person — a listener's name, a book's title, the reason on a
// request — so all three are cleaned before they go out.
//
// What that cleaning is for, precisely:
//
//  * `@everyone` and `@here` in a name would ring every phone in a server.
//    `allowed_mentions: { parse: [] }` is the real fix, because it is Discord's
//    own switch and does not depend on guessing at their syntax; the stripping
//    below is so the message still reads as words.
//  * Backticks and newlines would break out of the formatting and let a title
//    write its own lines, the way a title could once write playlist lines.
//  * A message is bounded. A book with a very long title is a book, not a way
//    to fill somebody's channel.
//
// The address itself is checked too: only Discord's own webhook host, only
// https, and no redirects — a webhook URL is a thing this server posts to on
// its own, so it is not a free "post this anywhere" button for whoever can
// reach the settings.
import { getSetting, setSetting } from './db.js';

export const KEY = 'discordWebhook';
const MOST = 1800;
const TIMEOUT = 8000;

// What the page is told, never the URL itself: it is a secret in the sense that
// anybody holding it can post into that channel.
export const lastSaid = { at: '', what: '', error: '', sent: 0 };

export const webhookSet = () => !!getSetting(KEY, '');

// A Discord webhook and nothing else.
export function asWebhook(said) {
  const raw = String(said || '').trim();
  if (!raw) return '';
  let at;
  try {
    at = new URL(raw);
  } catch {
    throw new Error('That is not an address.');
  }
  if (at.protocol !== 'https:') throw new Error('A webhook address is https.');
  const host = at.hostname.toLowerCase();
  if (!['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com'].includes(host)) {
    throw new Error('That is not a Discord webhook address — it looks like '
      + 'https://discord.com/api/webhooks/…');
  }
  if (!at.pathname.startsWith('/api/webhooks/')) {
    throw new Error('A Discord webhook address has /api/webhooks/ in it.');
  }
  return at.toString();
}

export function saveWebhook(said) {
  // "-" forgets it, the way the Home Assistant token does
  if (String(said).trim() === '-') {
    setSetting(KEY, '');
    return { set: false };
  }
  setSetting(KEY, asWebhook(said));
  return { set: webhookSet() };
}

// Text from a person, made safe to put in a line of a Discord message.
export const plain = (said, most = 120) => String(said ?? '')
  .replace(new RegExp('[\\u0000-\\u001f\\u007f]', 'g'), ' ')
  .replace(/[`*_~|\\]/g, '')
  .replace(/@(everyone|here)/gi, '@​o$1')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, most);

// One at a time, in order. A burst of these is a burst at somebody else's
// service, and two messages racing would arrive in the wrong order anyway.
let queue = Promise.resolve();

export function say(what) {
  const url = getSetting(KEY, '');
  if (!url) return Promise.resolve({ skipped: 'no webhook set' });
  const text = String(what || '').slice(0, MOST);
  queue = queue.then(() => post(url, text)).catch(() => {});
  return queue;
}

async function post(url, content) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (res.status === 429) {
      // their own figure, believed within reason
      const said = Number((await res.json().catch(() => ({}))).retry_after) || 1;
      await new Promise((r) => setTimeout(r, Math.min(10000, said * 1000)));
      return post(url, content);
    }
    if (!res.ok) {
      Object.assign(lastSaid, { error: `Discord answered ${res.status}.`, at: new Date().toISOString() });
      return { ok: false };
    }
    Object.assign(lastSaid, {
      at: new Date().toISOString(), what: content.slice(0, 120), error: '', sent: lastSaid.sent + 1,
    });
    return { ok: true };
  } catch (e) {
    Object.assign(lastSaid, {
      error: e.name === 'TimeoutError' ? 'Discord did not answer within eight seconds.' : e.message,
      at: new Date().toISOString(),
    });
    return { ok: false };
  }
}

// --- the three things worth saying ---------------------------------------
// The reason is the whole point of the message — it is what the admin decides
// on. An empty one says so in words rather than leaving a bare `>`, which
// Discord draws as nothing at all: a message that looks as though the app forgot
// to send the reason, where in fact none arrived.
export const askedForAnAccount = (who) => say(`📩 **${plain(who.name, 40)}** would like an account.`
  + `\n> ${plain(who.reason, 400) || '_(no reason given)_'}`
  + `\n_They say they ${who.knowsAdmin ? 'do' : 'do **not**'} know the administrator._`);

export const signedIn = (name) => say(`🔑 **${plain(name, 40)}** signed in.`);

export const startedListening = (name, title, author) =>
  say(`▶️ **${plain(name, 40)}** started *${plain(title)}*${author ? ` by ${plain(author, 60)}` : ''}.`);

export const tookTheBook = (name, title, author) =>
  say(`⤓ **${plain(name, 40)}** downloaded *${plain(title)}*${author ? ` by ${plain(author, 60)}` : ''}.`);

export const reachedALevel = (name, level) =>
  say(`${level.icon} **${plain(name, 40)}** reached **${plain(level.name, 60)}** — `
    + `${level.finished} books finished.`);

export const stoppedListening = (name, title, how) =>
  say(`⏹️ **${plain(name, 40)}** ${how === 'finished' ? 'finished' : 'stopped'} *${plain(title)}*.`);
