// Browsing the collection: the parts the listening page and the admin page do
// the same way.
//
// The two pages are different jobs — one plays books and changes nothing, the
// other files and tags and deletes — but they show the same shelves, the same
// tiles, the same search, the same Listened section and the same cover menu.
// Those were two copies for a long time, one in shelf.js and one in app.js,
// and twenty-two declarations of them had drifted to byte-identical. Two copies
// of a thing that must agree is a way of finding out later that it does not.
//
// **Load it first.** Both page scripts use `$`, `api`, `post`, `esc`, `toast`
// and `hms` in their own top-level code, so those have to exist before either
// runs. What this file does not have is anything a page must decide for itself:
// `state`, `drawBooks`, `loadHome`, `loadGenres`, the genre and author columns
// and the cover menu's contents all stay with the page, and the functions here
// call them by name. That is the whole seam — this file asks the page for what
// only the page knows, and the page never reaches back in here.

const $ = (s) => document.querySelector(s);

const api = async (url, opts) => {
  const r = await fetch(url, opts);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || r.statusText);
  return d;
};

const post = (url, body) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const toast = (msg) => { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2600); };

const hms = (s) => !s ? '' : `${Math.floor(s / 3600)}h ${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}m`;

// folder names and Google descriptions land in markup; a quote or < would break the card
const esc = (s) => String(s ?? '').replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// --- the line of numbers under everything --------------------------------
async function loadStats() {
  const s = await api('/api/stats?user=' + encodeURIComponent(state.user));
  $('#status').innerHTML = [
    [s.books, 'audiobooks'], [s.files, 'files'], [s.done, 'listened'], [s.todo, 'not listened'],
  ].map(([n, label]) => `<span><strong>${n.toLocaleString()}</strong> ${label}</span>`).join('')
    // which build is answering, so "is this the new one?" has an answer on screen
    + (s.version ? `<span class="ver">v${esc(s.version)}</span>` : '');
}

// --- shelves and their tiles ---------------------------------------------
// A book with no art of its own gets a cover drawn from its title, so every
// tile in the row is a cover.
const tile = (b, resumable) => {
  const at = Math.min(b.track_idx + 1, b.tracks || 1);
  // how far in, in time: counting tracks would stand full from the first minute
  // of a book that is one long file
  const pct = b.percent ?? (b.done ? 100 : 0);
  // and for such a book "Track 1 of 1" says nothing, so it says the time instead
  const how = b.done ? 'Listened'
    : b.tracks > 1 ? `Track ${at} of ${b.tracks}`
      : `${hms(b.into || 0) || '0h 00m'} of ${hms(b.duration) || '—'}`;
  return `<div class="tile" data-id="${b.id}" data-genre="${esc(b.genre)}" data-author="${esc(b.author)}"
       data-resume="${resumable ? 1 : 0}" title="${esc(b.title)}">
    <img src="/api/cover/${b.id}?v=${b.coverV || 0}" alt="" loading="lazy" decoding="async">
    ${heart(b.id)}
    <div class="t">${esc(b.title)}</div>
    <div class="a">${esc(b.author)}</div>
    ${b.series ? `<div class="a series-of">${esc(b.series)}${b.series_no ? ' · book ' + b.series_no : ''}</div>` : ''}
    ${resumable ? `<div class="tbar"><div style="width:${pct}%"></div></div>
      <div class="a">${how}</div>
      <button class="tplay" data-play="${b.id}" data-resume="1"${b.finished ? ' data-again="1"' : ''}>${b.finished ? '▶ Play again' : '▶ Resume'}</button>` : ''}
  </div>`;
};

const shelf = (title, items, resumable) => !items.length ? '' :
  `<div class="shelf"><div class="shelf-title">${title}</div>
     <div class="tiles">${items.map((b) => tile(b, resumable)).join('')}</div></div>`;

// --- what has been listened to -------------------------------------------
// A section of its own in the column beside the genres: the row is not there
// while there is nothing on it, and pressing it puts those books in the pane —
// the same cards as anywhere else, so a finished book can be played again from
// here without going looking for it.
async function loadListened() {
  const books = await api('/api/listened?user=' + encodeURIComponent(state.user)).catch(() => []);
  $('#listenedCount').textContent = books.length;
  // the title goes with the row: a heading over nothing is not a section
  $('#listenedTitle').hidden = !books.length;
  $('#listenedRows').hidden = !books.length;
  return books;
}

$('#listenedList').onclick = async () => {
  // this view browses by author, so the authors column stays where it is
  document.body.classList.remove('maintenance');
  document.querySelectorAll('#genres li').forEach((e) => e.classList.remove('active'));
  $('#listenedList').classList.add('active');
  state.genre = null;
  state.author = null;
  state.series = null;
  const books = await loadListened();
  state.listenedBooks = books;
  if (!books.length) {
    $('#authors ul').innerHTML = '';
    $('#books .list').innerHTML = '<div class="empty">You have not finished a book yet.</div>';
    return show('books');
  }
  // the authors of those books in the middle column, with how many each
  const authors = [...new Set(books.map((b) => b.author))].sort((a, b) => a.localeCompare(b));
  $('#authors ul').innerHTML = authors.map((name) => `<li data-name="${esc(name)}">
      <span class="who">${esc(name)}</span>
      <span class="count">${books.filter((b) => b.author === name).length}</span></li>`).join('');
  $('#authors ul').querySelectorAll('li').forEach((li) => {
    li.onclick = () => listenedOf(li.dataset.name, li);
  });
  await drawBooks(books, `${books.length} book${books.length === 1 ? '' : 's'}`, 'Listened');
};

// What one author has been listened to, in the order a series reads: the series
// line above each group is drawBooks' own, so a series says which book it is.
async function listenedOf(name, li) {
  document.querySelectorAll('#authors li').forEach((e) => e.classList.remove('active'));
  if (li) li.classList.add('active');
  const books = (state.listenedBooks || []).filter((b) => b.author === name)
    .sort((a, b) => (a.series || '').localeCompare(b.series || '')
      || (a.series_no || 0) - (b.series_no || 0)
      || a.title.localeCompare(b.title));
  await drawBooks(books, '');
}

// The name of the app is the way back to the shelves, wherever you are. Called
// rather than handed over, because each page declares its own `loadHome` and
// this file is loaded before either of them: naming it here would be reading it
// before it exists.
$('#brand').onclick = () => loadHome();

// --- the genre column ----------------------------------------------------
// Each genre lists its series underneath it: a series belongs to a genre, and a
// reader looking for the next book of one is not looking for its author first.
// Which genres are showing their series. Kept in the browser, so the column
// looks the same when you come back to it.
const openGenres = new Set(JSON.parse(localStorage.openGenres || '[]'));

// --- which column is on screen -------------------------------------------
const show = (col) => {
  document.body.dataset.col = col;
  // the button says where it goes, not just "back"
  $('#backCol').textContent = outOfBooks() === 'authors' ? '‹ Authors' : '‹ Genres';
};
$('#backGenres').onclick = () => show('genres');
$('#backCol').onclick = () => show(outOfBooks());
$('#toBooks').onclick = () => show('books');

// --- the search box ------------------------------------------------------
// The words are looked for in anything a book is filed or described by, and the
// results take over the book column. Emptying the box puts back what was there.
let searchSoon;

async function runSearch() {
  const q = $('#q').value.trim();
  if (!q) {
    if (state.series) return selectSeries(state.genre, state.series, null);
    if (state.author) return selectAuthor(state.author, null);
    return loadHome();
  }
  const rows = await api(`/api/search?q=${encodeURIComponent(q)}&user=${encodeURIComponent(state.user)}`);
  document.body.classList.remove('maintenance');
  if (!rows.length) {
    $('#books .list').innerHTML = `<div class="empty">Nothing matches "${esc(q)}".</div>`;
    show('books');
    return;
  }
  await drawBooks(rows, `${q} · ${rows.length} book${rows.length === 1 ? '' : 's'}`, 'Search');
}
$('#q').oninput = () => { clearTimeout(searchSoon); searchSoon = setTimeout(runSearch, 200); };
$('#q').onkeydown = (e) => {
  if (e.key === 'Escape') $('#q').value = '';
  if (e.key !== 'Enter' && e.key !== 'Escape') return;
  clearTimeout(searchSoon);
  runSearch();
};

// --- the cover menu ------------------------------------------------------
// Right-click a cover — or hold it, on a phone, where there is no right button —
// and everything a cover can offer beyond playing is there: over again, the
// Listened tick, the whole book, and on the admin page its metadata.
const coverMenu = $('#coverMenu');

const bookOfCover = (el) => {
  const img = el.closest('img, .tile');
  if (!img) return null;
  if (img.id === 'pCover') return state.book ? { id: state.book.id, title: state.book.title } : null;
  const tile = img.closest('.tile');
  if (tile) return { id: Number(tile.dataset.id), title: tile.querySelector('.t')?.textContent || '' };
  const card = img.closest('.card');
  const play = card && card.querySelector('[onclick^="playBook"]');
  if (!play) return null;
  // the heading carries a note glyph saying how far along the book is: the words
  // are the text of the heading itself, not of the span inside it
  const words = [...(card.querySelector('h3')?.childNodes || [])]
    .filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join(' ');
  return { id: Number(play.getAttribute('onclick').match(/\d+/)[0]), title: words.trim() };
};

const hideCoverMenu = () => { coverMenu.hidden = true; };

// no right button on a touch screen: hold the cover instead
let held = null;

let fromHold = false;
document.addEventListener('touchstart', (e) => {
  const book = bookOfCover(e.target);
  if (!book) return;
  const at = e.touches[0];
  held = setTimeout(() => {
    held = null;
    fromHold = true;
    showCoverMenu(book, at.clientX, at.clientY);
  }, 550);
}, { passive: true });
for (const ended of ['touchend', 'touchmove', 'touchcancel']) {
  document.addEventListener(ended, () => { clearTimeout(held); held = null; }, { passive: true });
}
// Lifting the finger after a hold sends a click at the cover: without swallowing
// it the tap would start the book and shut the menu it had just opened. Captured,
// so it never reaches the picture underneath.
document.addEventListener('click', (e) => {
  if (coverMenu.contains(e.target)) return;
  if (fromHold) {
    fromHold = false;
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  hideCoverMenu();
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCoverMenu(); });
window.addEventListener('scroll', hideCoverMenu, true);

// Only the admin page has the last two of these, so an item that is not there is
// not wired: one block of code, two pages.
const onMenu = (act, fn) => {
  const button = coverMenu.querySelector(`[data-act="${act}"]`);
  if (button) button.onclick = fn;
};

// Whether this book is ticked off, as far as the page knows: the tick on its card
// if a card is on screen, otherwise what the player was told when it loaded it.
const tickOf = (id) => document.querySelector(`.card .listened input[onchange*="setListened(${id},"]`);
