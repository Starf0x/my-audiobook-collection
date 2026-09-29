// Signing in, asking for an account, and the hearts. Both pages carry this, and
// it is one file rather than two so the rule cannot drift — the way the player
// is one file for three pages.
//
// It is loaded after the page's own script and uses what that declares ($, api,
// post, esc, toast, state), and it is what starts the page: the page script
// defines `window.begin` and does nothing until this calls it, because there is
// nothing to draw for somebody who is not signed in.
const gate = $('#gate');

// Shown and hidden with an attribute rather than `showModal()`. See the comment
// above the markup: the top layer belongs to whatever the browser and its
// extensions put there, and a page that keeps taking it is a page a password
// manager switches itself off on.
// The reason box is emptied when the form is opened, unless the person has
// typed in it themselves. Two requests arrived whose reason was this page's own
// hint sentence — twice, word for word, from one browser — and nothing in this
// app writes into that box. `autocomplete="off"` did not stop it, so rather than
// guess again at what fills it (an extension, a restore, a writing assistant),
// this empties it at the moment the form is shown, whatever put it there. The
// flag is so that typing survives switching between the two halves of the card.
const showGate = (which) => {
  $('#gateSignIn').hidden = which !== 'in';
  $('#gateAsk').hidden = which !== 'ask';
  const why = $('#gaWhy');
  if (which === 'ask' && why && !why.dataset.typed) why.value = '';
  gate.hidden = false;
  ($('#' + (which === 'in' ? 'giName' : 'gaName'))).focus();
};
if ($('#gaWhy')) $('#gaWhy').addEventListener('input', (e) => { e.target.dataset.typed = '1'; });
const closeGate = () => { gate.hidden = true; };

const said = (where, text) => { $(where).textContent = text || ''; };

window.whoAmI = whoAmI;
async function whoAmI() {
  const me = await api('/api/account/me').catch(() => ({ signedIn: false, required: true }));
  state.user = me.name || '';
  state.admin = !!me.admin;
  if (me.name) localStorage.user = me.name;
  // The name, with what they have earned under it: an icon beside the name and
  // the level's name below it. Below ten books there is no icon — a level
  // everybody starts at is not an accomplishment, and a badge saying so is noise
  // — but the line under the name is there anyway, saying how many books to the
  // first level. Something to work towards is worth more in that space than a
  // gap, and the gap read as a bug rather than as an answer.
  const level = me.level || {};
  state.level = level;
  state.mayDownload = me.mayDownload !== false;
  document.body.classList.toggle('may-download', state.mayDownload);
  const under = level.name || (level.next
    ? `${level.next.at - (level.finished || 0)} to ${level.next.name}` : '');
  $('#whoAmI').innerHTML = me.name
    ? `<span class="me">${level.icon
      ? `<span class="badge-icon" title="${esc(level.name)}">${level.icon}</span>` : ''}${esc(me.name)}</span>`
      + (under ? `<span class="level">${esc(under)}</span>` : '')
    : '';
  $('#signOut').hidden = !me.signedIn;
  // The listening page's way through to the admin page, shown to the one person
  // it is any use to. It is not on the admin page, where that id is the Lock
  // button, so this asks whether it is there at all.
  if ($('#toAdmin')) $('#toAdmin').hidden = !me.admin;
  return me;
}

$('#signOut').onclick = async () => {
  await post('/api/account/signout', {}).catch(() => {});
  location.reload();
};

// --- the two forms --------------------------------------------------------
$('#giAsk').onclick = () => showGate('ask');
$('#gaBack').onclick = () => showGate('in');

const signIn = async () => {
  said('#giSaid', '');
  const name = $('#giName').value.trim();
  const password = $('#giPass').value;
  if (!name || !password) return said('#giSaid', 'Both, please.');
  try {
    await post('/api/account/signin', { name, password });
  } catch (e) {
    return said('#giSaid', e.message);
  }
  closeGate();
  return started();
};
$('#giGo').onclick = signIn;
for (const id of ['giName', 'giPass']) {
  $('#' + id).onkeydown = (e) => { if (e.key === 'Enter') signIn(); };
}

$('#gaGo').onclick = async () => {
  said('#gaSaid', '');
  try {
    await post('/api/account/request', {
      name: $('#gaName').value.trim(),
      password: $('#gaPass').value,
      reason: $('#gaWhy').value.trim(),
      knowsAdmin: $('#gaKnows').checked,
    });
  } catch (e) {
    return said('#gaSaid', e.message);
  }
  $('#gateAsk').innerHTML = '<p class="hint">Asked. The administrator has been told, and once '
    + 'they approve it you can sign in with the name and password you just chose. '
    + 'Nothing else is needed from you.</p>';
  return undefined;
};

// --- the hearts -----------------------------------------------------------
// The heart is drawn by whatever draws a card, and this keeps the two places it
// shows — the card and the count in the left column — saying the same thing.
const hearted = new Set();

window.isHearted = (id) => hearted.has(Number(id));

window.heart = (id) => `<button class="heart${hearted.has(Number(id)) ? ' on' : ''}"
  data-heart="${id}" title="${hearted.has(Number(id)) ? 'In your favourites' : 'Add to your favourites'}"
  aria-pressed="${hearted.has(Number(id))}">♥</button>`;

async function loadFavourites() {
  const list = await api('/api/favourites').catch(() => []);
  hearted.clear();
  for (const b of list) hearted.add(Number(b.id));
  $('#favCount').textContent = String(list.length);
  $('#favTitle').hidden = !list.length;
  $('#favRows').hidden = !list.length;
  return list;
}
window.loadFavourites = loadFavourites;

// One listener for every heart on the page, so a redraw needs no rewiring.
document.addEventListener('click', async (e) => {
  const button = e.target.closest('.heart');
  if (!button) return;
  e.preventDefault();
  e.stopPropagation();
  const id = Number(button.dataset.heart);
  const on = !hearted.has(id);
  // the page says so at once; the server is what decides, and puts it back if
  // it disagrees
  button.classList.toggle('on', on);
  button.setAttribute('aria-pressed', String(on));
  if (on) hearted.add(id); else hearted.delete(id);
  try {
    const r = await post(`/api/favourites/${id}`, { on });
    $('#favCount').textContent = String(r.count);
    $('#favTitle').hidden = !r.count;
    $('#favRows').hidden = !r.count;
    // the favourites list is what is on screen: draw it again
    if ($('#favList').classList.contains('active')) $('#favList').click();
  } catch (err) {
    button.classList.toggle('on', !on);
    if (on) hearted.delete(id); else hearted.add(id);
    toast(err.message);
  }
}, true);

$('#favList').onclick = async () => {
  document.body.classList.remove('maintenance');
  document.querySelectorAll('#genres li').forEach((el) => el.classList.remove('active'));
  $('#favList').classList.add('active');
  state.genre = null;
  state.author = null;
  state.series = null;
  const books = await loadFavourites();
  state.favouriteBooks = books;
  if (!books.length) {
    $('#authors ul').innerHTML = '';
    $('#books .list').innerHTML = '<div class="empty">Nothing hearted yet. The ♥ on a book puts it here.</div>';
    return show('books');
  }
  // The authors of those books in the middle column, with how many each — the
  // same as Listened does, because a view and the column beside it are one
  // view. This column was cleared and never filled, so Favourites showed an
  // empty Authors heading beside a shelf of books that plainly had authors.
  const authors = [...new Set(books.map((b) => b.author))].sort((a, b) => a.localeCompare(b));
  $('#authors ul').innerHTML = authors.map((name) => `<li data-name="${esc(name)}">
      <span class="who">${esc(name)}</span>
      <span class="count">${books.filter((b) => b.author === name).length}</span></li>`).join('');
  $('#authors ul').querySelectorAll('li').forEach((li) => {
    li.onclick = () => favouritesOf(li.dataset.name, li);
  });
  return drawBooks(books, `${books.length} book${books.length === 1 ? '' : 's'}`, 'Favourites');
};

// What one author has been hearted, in the order a series reads.
async function favouritesOf(name, li) {
  document.querySelectorAll('#authors li').forEach((e) => e.classList.remove('active'));
  if (li) li.classList.add('active');
  const books = (state.favouriteBooks || []).filter((b) => b.author === name)
    .sort((a, b) => (a.series || '').localeCompare(b.series || '')
      || (a.series_no || 0) - (b.series_no || 0)
      || a.title.localeCompare(b.title));
  await drawBooks(books, '');
}

// --- starting the page ----------------------------------------------------
async function started() {
  await whoAmI();
  await loadFavourites();
  return window.begin();
}

(async () => {
  const me = await whoAmI();
  if (me.signedIn || !me.required) return started();
  return showGate('in');
})();
