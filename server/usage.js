// A daily check-in to a usage webhook (2.14.424): once a day, a line that says this
// app is running, which version, that it runs as a Docker container (DCK) or not
// (LXC), and how many days it has been running.
//
// Off unless USAGE_URL and USAGE_TOKEN are both set, and nothing about the
// collection or the people listening is sent. A failure is logged and tried again
// at the next hourly look; it never stops the app.
import fs from 'node:fs';
import os from 'node:os';
import { getSetting, setSetting } from './db.js';

const SINCE = 'usageSince'; // the first day this install reported, yyyy-mm-dd
const LAST = 'usageLast'; // the last day a report arrived
const EVERY = 60 * 60 * 1000;

const day = (d = new Date()) => d.toLocaleDateString('sv-SE'); // yyyy-mm-dd, local
export const kind = () => (fs.existsSync('/.dockerenv') ? 'DCK' : 'LXC');
// days counted from the first one, that one included: day one is 1
export const daysSince = (since, today) =>
  Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / 86400000) + 1;

export async function reportOnce(version, now = new Date()) {
  const url = process.env.USAGE_URL;
  const token = process.env.USAGE_TOKEN;
  if (!url || !token) return null;
  const today = day(now);
  if (getSetting(LAST) === today) return null;
  const since = getSetting(SINCE) || today;
  const body = {
    appName: 'My Audiobook Collection',
    version,
    date: today,
    time: now.toLocaleTimeString('sv-SE'),
    // In Docker, os.hostname() is the container id, which changes with every update, so
    // the webhook would see a new computer each time. Unraid passes the server's own name
    // as HOST_HOSTNAME; use that when it is there.
    computerName: process.env.HOST_HOSTNAME || os.hostname(),
    dck: kind() === 'DCK', // true in a Docker container
    days: daysSince(since, today),
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Token': token },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`answered ${res.status}`);
    setSetting(SINCE, since);
    setSetting(LAST, today);
    return body;
  } catch (e) {
    console.warn(`Usage check-in: not sent — ${e.message}`);
    return null;
  }
}

export function reportDaily(version) {
  reportOnce(version);
  setInterval(() => reportOnce(version), EVERY).unref?.();
}
