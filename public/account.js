// Signing in, asking for an account, and the hearts. Both pages carry this, and
// it is one file rather than two so the rule cannot drift — the way the player
// is one file for three pages.
//
// It is loaded after the page's own script and uses what that declares ($, api,
// post, esc, toast, state), and it is what starts the page: the page script
// defines `window.begin` and does nothing until this calls it, because there is
// nothing to draw for somebody who is not signed in.
const gate = $('#gate');

const showGate = (which) => {
  $('#gateSignIn').hidden = which !== 'in';
  $('#gateAsk').hidden = which !== 'ask';
  if (!gate.open) gate.showModal();
  ($('#' + (which === 'in' ? 'giName' : 'gaName'))).focus();
};

const said = (where, text) => { $(where).textContent = text || ''; };

async function whoAmI() {
  const me = await api('/api/account/me').catch(() => ({ signedIn: false, required: true }));
  state.user = me.name || '';
  state.admin = !!me.admin;
  if (me.name) localStorage.user = me.name;
  $('#whoAmI').textContent = me.name || '';
  $('#signOut').hidden = !me.signedIn;
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
  gate.close();
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
  $('#authors ul').innerHTML = '';
  if (!books.length) {
    $('#books .list').innerHTML = '<div class="empty">Nothing hearted yet. The ♥ on a book puts it here.</div>';
    return show('books');
  }
  return drawBooks(books, `${books.length} book${books.length === 1 ? '' : 's'}`, 'Favourites');
};

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
