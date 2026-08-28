import crypto from 'node:crypto';

// A book with no cover art used to be a hole in the shelf: the app icon in one
// place, a hidden image in another. This draws one instead — the same 2:3 shape
// as real art, in the colours of the interface, with the title on it so a shelf
// of coverless books is still readable. It is an SVG, so it costs nothing to
// send and stays sharp at every size the app shows a cover in.
//
// The hue comes from the title, so two books next to each other rarely get the
// same one, and the whole shelf turns a little every day: the two colours are one
// hue and its partner, and the pair is spun by the day of the month it is read on.
// 37° a day is enough to see and coprime with 360, so a shelf takes a year to come
// back round.
const hueOf = (seed) => parseInt(crypto.createHash('md5').update(seed).digest('hex').slice(0, 4), 16) % 360;

// Which day it is where the server is, counted from the epoch. Taken as an
// argument everywhere below so a test can ask for another day than today.
export const dayIndex = (when = new Date()) => Math.floor(
  (when.getTime() - when.getTimezoneOffset() * 60000) / 86400000);

// How long a drawn cover may be kept: until the day turns, and never less than a
// minute. Its colours change then, so a week — which is right for a real picture —
// would hold yesterday's on screen.
export const untilTomorrow = (when = new Date()) => {
  const midnight = new Date(when);
  midnight.setHours(24, 0, 0, 0);
  return Math.max(60, Math.floor((midnight.getTime() - when.getTime()) / 1000));
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

// Greedy wrap on a guess at how wide a character is: nothing here can measure
// text, and for a title of a few words a guess is close enough.
function wrap(text, size) {
  const perLine = Math.max(6, Math.floor(318 / (size * 0.53)));
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= perLine || !line) line = next;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

// The longer the title, the smaller it is set, the way a designer would. A title
// that will not fit even at the smallest size ends in an ellipsis.
function fit(title) {
  for (const [size, maxLines] of [[40, 4], [33, 5], [27, 6]]) {
    const lines = wrap(title, size);
    if (lines.length <= maxLines) return { size, lines };
    if (size === 27) {
      const kept = lines.slice(0, maxLines);
      kept[maxLines - 1] += '…';
      return { size, lines: kept };
    }
  }
}

export function placeholderCover({ title, author, day = dayIndex() }) {
  const name = (title || '').trim() || 'Untitled';
  const h = (hueOf(name) + day * 37) % 360;
  const h2 = (h + 42) % 360;
  const { size, lines } = fit(name);
  // gradient ids are global to whatever document the picture ends up in, so they
  // carry the colours that made them: two of these covers side by side in one page
  // would otherwise both be painted with the first one's gradient
  const id = `${h}x${day % 1000}`;
  // The block sits on the bottom edge: author last, title above it.
  const authorY = 548;
  const bottom = author ? authorY - 40 : authorY;
  const first = bottom - (lines.length - 1) * (size * 1.16);
  const body = lines.map((l, i) => `<text x="42" y="${(first + i * size * 1.16).toFixed(1)}"
      font-size="${size}" font-weight="700" fill="#f2f4f8">${esc(l)}</text>`).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 600" width="400" height="600"
  font-family="Segoe UI, system-ui, -apple-system, Helvetica, Arial, sans-serif">
  <defs>
    <linearGradient id="g${id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${h}, 34%, 19%)"/>
      <stop offset="1" stop-color="hsl(${h2}, 42%, 8%)"/>
    </linearGradient>
    <radialGradient id="glow${id}" cx="0.12" cy="0.04" r="0.9">
      <stop offset="0" stop-color="hsl(${h}, 85%, 62%)" stop-opacity="0.34"/>
      <stop offset="1" stop-color="hsl(${h}, 85%, 62%)" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glow2${id}" cx="0.95" cy="0.98" r="0.85">
      <stop offset="0" stop-color="hsl(${h2}, 80%, 58%)" stop-opacity="0.26"/>
      <stop offset="1" stop-color="hsl(${h2}, 80%, 58%)" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="400" height="600" fill="url(#g${id})"/>
  <rect width="400" height="600" fill="url(#glow${id})"/>
  <rect width="400" height="600" fill="url(#glow2${id})"/>
  <!-- the spine, so it reads as a book rather than a coloured tile -->
  <rect width="22" height="600" fill="#000" opacity="0.28"/>
  <rect x="22" width="1.4" height="600" fill="#fff" opacity="0.12"/>
  <!-- headphones: what kind of book this is, said quietly -->
  <g fill="none" stroke="#fff" opacity="0.15">
    <path d="M126 250 A 78 78 0 0 1 282 250" stroke-width="15" stroke-linecap="round"/>
    <rect x="110" y="246" width="32" height="78" rx="16" fill="#fff" stroke="none"/>
    <rect x="266" y="246" width="32" height="78" rx="16" fill="#fff" stroke="none"/>
  </g>
  <text x="42" y="62" font-size="14" font-weight="600" letter-spacing="4.5"
    fill="#fff" opacity="0.42">AUDIOBOOK</text>
  <rect x="42" y="${(first - size - 20).toFixed(1)}" width="46" height="4" rx="2"
    fill="hsl(${h2}, 90%, 68%)" opacity="0.9"/>
  ${body}
  ${author ? `<text x="42" y="${authorY}" font-size="20" letter-spacing="1.6"
    fill="#fff" opacity="0.66">${esc(String(author).toUpperCase())}</text>` : ''}
  <rect x="0.75" y="0.75" width="398.5" height="598.5" fill="none" stroke="#fff" opacity="0.09"/>
</svg>`;
}
