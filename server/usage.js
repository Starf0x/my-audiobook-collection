// A daily usage check-in (2.14.468): once a day the app says it is running — the
// version, Docker or not, and how many days it has been going — so the author can
// see whether the app is worth developing further. An update reports straight away,
// also when today's check-in has already gone out.
//
// It is disclosed, not hidden: the admin page says it happens and lets you turn it
// off, and so does the README. It can be switched off with the toggle there or with
// USAGE_OPTOUT=1. By default it reports to the author's own collector; an operator
// who wants their own numbers instead points USAGE_URL (and USAGE_TOKEN) at their
// own server.
//
// What it sends is deliberately thin and not personal: the app name, the version,
// Docker yes/no, the number of days this install has been running, and — to the
// default collector — a random id made once per install, never the real machine
// name. Nothing about the books or the people listening is ever sent. A failure is
// logged and tried again at the next hourly look; it never stops the app.
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { getSetting, setSetting } from './db.js';

// The author's own collector, so an ordinary install is counted without anyone
// setting anything. It is in plain sight on purpose — this is disclosed telemetry,
// not a hidden phone-home.
const DEFAULT_URL = 'https://hkjhykihflhfg5.the-airheads.com/webhook';
// The token that collector expects. It ships in this public code on purpose.
const DEFAULT_TOKEN = Buffer.from(
  'ZjgwMjRlYzQ5YThmYTljN2NhZjlmYTg0MTdmOWUzNjhjZGFhYzkwYjhmZWQ1N2ZhY2Q5NjQzMzEwNzMxOWYwOQ==',
  'base64').toString();

const SINCE = 'usageSince'; // the first day this install reported, yyyy-mm-dd
const LAST = 'usageLast'; // the last day a report arrived
const LAST_VERSION = 'usageLastVersion'; // the version that report carried
const OPT_OUT = 'usageOptOut'; // '1' when the admin has switched the check-in off
const INSTALL_ID = 'usageInstallId'; // a random id, made once, for the default collector
const EVERY = 60 * 60 * 1000;

const day = (d = new Date()) => d.toLocaleDateString('sv-SE'); // yyyy-mm-dd, local
export const kind = () => (fs.existsSync('/.dockerenv') ? 'DCK' : 'LXC');
// days counted from the first one, that one included: day one is 1
export const daysSince = (since, today) =>
  Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / 86400000) + 1;

// off when the admin has unticked it, or USAGE_OPTOUT is set
export const optedOut = () => process.env.USAGE_OPTOUT === '1' || getSetting(OPT_OUT) === '1';

const installId = () => {
  let id = getSetting(INSTALL_ID);
  if (!id) { id = crypto.randomUUID(); setSetting(INSTALL_ID, id); }
  return id;
};

export async function reportOnce(version, now = new Date()) {
  if (optedOut()) return null;
  const ownUrl = process.env.USAGE_URL; // an operator pointing it at their own server
  const url = ownUrl || DEFAULT_URL;
  const token = process.env.USAGE_TOKEN || (ownUrl ? '' : DEFAULT_TOKEN);
  if (!url || !token) return null;
  const today = day(now);
  if (getSetting(LAST) === today && getSetting(LAST_VERSION) === version) return null;
  const since = getSetting(SINCE) || today;
  const body = {
    appName: 'My Audiobook Collection',
    version,
    date: today,
    time: now.toLocaleTimeString('sv-SE'),
    // the default collector gets a random, anonymous id — never the real name — so
    // installs can be counted without anyone being identifiable. An operator who set
    // their own URL asked for their own numbers, so they get their own machine's name
    // (Unraid passes the server's name as HOST_HOSTNAME; the container id would churn).
    computerName: ownUrl ? (process.env.HOST_HOSTNAME || os.hostname()) : installId(),
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
    setSetting(LAST_VERSION, version);
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
