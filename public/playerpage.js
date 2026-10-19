// What `/player` needs before `player.js` is loaded over the top of it.
//
// The same shape `ha.js` has for the Home Assistant page: its own `$`, `api`,
// `post`, `toast` and `state`, because this page carries the player without
// carrying the library. `browse.js` and `shelf.js` are about genres, authors
// and shelves, none of which is on this screen.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const api = async (url, opts) => {
  const r = await fetch(url, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
};
const post = (url, body) => api(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
});

let toastTimer;
const toast = (text) => {
  $('#toast').textContent = text;
  $('#toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 4000);
};

const state = { user: localStorage.user || '', genre: null, author: null, book: null, track: 0 };

$('#back').onclick = () => { location.href = '/'; };
$('#toShelves').onclick = () => { location.href = '/'; };

// Who is signed in, in the corner. Not a sign-in card: this page is reached
// from a page that already asked, and somebody who is not signed in has no book
// to be playing. They are sent to the one that does ask.
(async () => {
  const me = await api('/api/account/me').catch(() => ({ signedIn: false }));
  if (!me.signedIn) return void location.replace('/');
  state.user = me.name || '';
  if (me.name) localStorage.user = me.name;
  $('#whoAmI').textContent = me.name || '';
  return undefined;
})();

// Nothing is playing, and nothing was carried in — a typed address, or a
// bookmark opened cold. Say so and offer the way back, rather than a screen of
// empty controls that do nothing.
//
// It waits for the pick-up: `player.js` asks the server whose the carried book
// is before it loads anything, so a book that *is* coming has not arrived yet
// when this runs. Two seconds is the slack for that question, not a guess at
// how long a book takes to load — `state.book` is set the moment the pick-up
// decides, long before any audio has been fetched.
setTimeout(() => {
  if (state.book) return;
  $('#now').hidden = true;
  $('#empty').hidden = false;
}, 2000);
