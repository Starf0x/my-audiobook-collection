// The listening page: browse, play, keep your place. Nothing here changes the
// collection, so it is the page to share. The Admin button leads to the full one.
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
const esc = (s) => String(s ?? '').replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const state = { user: localStorage.user || '', genre: null, author: null, book: null, track: 0 };

// --- admin button -------------------------------------------------------
$('#adminBtn').onclick = async () => {
  const p = await api('/api/admin').catch(() => ({ required: false, admin: true }));
  if (!p.required || p.admin) return location.assign('/admin');
  $('#adminWhy').textContent = 'The password opens the page that can scan, import, tag, move and delete.';
  $('#adminPass').value = '';
  $('#admin').showModal();
};
$('#adminCancel').onclick = () => $('#admin').close();
$('#adminGo').onclick = async () => {
  try {
    await post('/api/admin/unlock', { password: $('#adminPass').value });
    location.assign('/admin');
  } catch (e) { toast(e.message); }
};

// --- who is listening ---------------------------------------------------
async function loadUsers() {
  const users = await api('/api/users');
  $('#user').innerHTML = users.map((u) => `<option${u === state.user ? ' selected' : ''}>${esc(u)}</option>`).join('')
    || '<option value="">(no user)</option>';
  state.user = $('#user').value || '';
  localStorage.user = state.user;
  return users;
}

async function askWho(users, cancellable) {
  $('#whoList').innerHTML = users.length
    ? `<label>Pick a name</label><div class="row" style="flex-wrap:wrap">${users
      .map((u) => `<button data-who="${esc(u)}">${esc(u)}</button>`).join('')}</div>`
    : '';
  $('#whoClose').hidden = !cancellable;
  const pick = async (name) => {
    state.user = localStorage.user = name;
    $('#who').close();
    await loadUsers();
    $('#user').value = name;
    await Promise.all([loadStats(), loadHome()]);
  };
  $('#whoList').querySelectorAll('button[data-who]').forEach((b) => { b.onclick = () => pick(b.dataset.who); });
  $('#whoGo').onclick = async () => {
    const name = $('#whoName').value.trim();
    if (!name) return toast('Fill in a name first.');
    try { await post('/api/users', { name }); } catch (e) { return toast(e.message); }
    $('#whoName').value = '';
    await pick(name);
  };
  $('#whoClose').onclick = () => $('#who').close();
  $('#who').showModal();
}

$('#user').onchange = () => { state.user = localStorage.user = $('#user').value; loadStats(); loadHome(); };

async function loadStats() {
  const s = await api('/api/stats?user=' + encodeURIComponent(state.user));
  $('#status').innerHTML = [
    [s.books, 'audiobooks'], [s.files, 'files'], [s.done, 'listened'], [s.todo, 'not listened'],
  ].map(([n, label]) => `<span><strong>${n.toLocaleString()}</strong> ${label}</span>`).join('')
    // which build is answering, so "is this the new one?" has an answer on screen
    + (s.version ? `<span class="ver">v${esc(s.version)}</span>` : '');
}

// --- shelves ------------------------------------------------------------
const tile = (b, resumable) => {
  const at = Math.min(b.track_idx + 1, b.tracks || 1);
  const pct = b.done ? 100 : b.tracks ? (at / b.tracks) * 100 : 0;
  return `<div class="tile" data-id="${b.id}" data-genre="${esc(b.genre)}" data-author="${esc(b.author)}"
       data-resume="${resumable ? 1 : 0}" title="${esc(b.title)}">
    <img src="/api/cover/${b.id}?v=${b.coverV || 0}" alt="">
    <div class="t">${esc(b.title)}</div>
    <div class="a">${esc(b.author)}</div>
    ${b.series ? `<div class="a series-of">${esc(b.series)}${b.series_no ? ' · book ' + b.series_no : ''}</div>` : ''}
    ${resumable ? `<div class="tbar"><div style="width:${pct}%"></div></div>
      <div class="a">${b.done ? 'Listened' : `Track ${at} of ${b.tracks}`}</div>
      <button class="tplay" data-play="${b.id}" data-resume="1"${b.finished ? ' data-again="1"' : ''}>${b.finished ? '▶ Play again' : '▶ Resume'}</button>` : ''}
  </div>`;
};

const shelf = (title, items, resumable) => !items.length ? '' :
  `<div class="shelf"><div class="shelf-title">${title}</div>
     <div class="tiles">${items.map((b) => tile(b, resumable)).join('')}</div></div>`;

async function loadHome() {
  loadListened();
  $('#q').value = '';
  document.querySelectorAll('#genres li, #authors li').forEach((e) => e.classList.remove('active'));
  $('#authors ul').innerHTML = '';
  const d = await api('/api/home?user=' + encodeURIComponent(state.user));
  $('#books .list').innerHTML = shelf('Continue listening', d.continue, true)
    + shelf('Recently added', d.recent, false)
    || '<div class="empty">Nothing here yet.</div>';
  $('#books .list').querySelectorAll('.tile').forEach((t) => {
    t.onclick = () => (t.dataset.resume === '1'
      ? playBook(Number(t.dataset.id))
      : openInLibrary(t.dataset.genre, t.dataset.author));
  });
  $('#books .list').querySelectorAll('button[data-play]').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); playBook(Number(b.dataset.play)); };
  });
  markPlaying();
}
$('#home').onclick = loadHome;
// --- the books you are done with ---------------------------------------
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

// the name of the app is the way back to the shelves, wherever you are
$('#brand').onclick = loadHome;

async function openInLibrary(genre, author) {
  const gli = [...document.querySelectorAll('#genres li[data-name]')].find((l) => l.dataset.name === genre);
  await selectGenre(genre, gli);
  const ali = [...document.querySelectorAll('#authors li')].find((l) => l.dataset.name === author);
  await selectAuthor(author, ali);
}

// --- browsing -----------------------------------------------------------
// Each genre lists its series underneath it, so the next book of one is two
// clicks away without knowing who wrote it.
// Which genres are showing their series, kept in the browser so the column looks
// the same when you come back to it.
const openGenres = new Set(JSON.parse(localStorage.openGenres || '[]'));

function showSeriesOf(genre, open) {
  if (open) openGenres.add(genre); else openGenres.delete(genre);
  localStorage.openGenres = JSON.stringify([...openGenres]);
  document.querySelectorAll(`#genres li[data-genre="${CSS.escape(genre)}"]`).forEach((li) => { li.hidden = !open; });
  const row = [...document.querySelectorAll('#genres li[data-name]')].find((l) => l.dataset.name === genre);
  const twist = row && row.querySelector('.twist');
  if (twist) twist.textContent = open ? '▾' : '▸';
}

async function loadGenres() {
  const list = await api('/api/genres');
  $('#genres ul').innerHTML = list.map((g) => {
    const has = (g.series || []).length;
    return `<li data-name="${esc(g.name)}">
      <span class="who">${has ? '<span class="twist">▸</span>' : ''}${esc(g.name)}</span>
      <span class="count">${g.books}</span></li>`
      + (g.series || []).map((s) => `<li class="series-in-genre" hidden
          data-genre="${esc(g.name)}" data-series="${esc(s.name)}">
          <span class="who">${esc(s.name)}</span><span class="count">${s.books}</span></li>`).join('');
  }).join('')
    || '<li class="empty">Nothing here yet.</li>';
  $('#genres ul').querySelectorAll('li[data-name]').forEach((li) => {
    li.onclick = (e) => {
      // only the arrow folds and unfolds; the name just selects the genre
      if (e.target.classList.contains('twist')) return showSeriesOf(li.dataset.name, !openGenres.has(li.dataset.name));
      selectGenre(li.dataset.name, li);
    };
  });
  $('#genres ul').querySelectorAll('li[data-series]').forEach((li) => {
    li.onclick = () => selectSeries(li.dataset.genre, li.dataset.series, li);
  });
  for (const g of list) if (openGenres.has(g.name)) showSeriesOf(g.name, true);
}

async function selectSeries(genre, series, li) {
  state.genre = genre;
  state.author = null;
  document.querySelectorAll('#genres li, #authors li').forEach((e) => e.classList.remove('active'));
  if (li) li.classList.add('active');
  const authors = await api('/api/authors?genre=' + encodeURIComponent(genre));
  $('#authors ul').innerHTML = authors.map((a) =>
    `<li data-name="${esc(a.name)}"><span>${esc(a.name)}</span><span class="count">${a.books}</span></li>`).join('');
  $('#authors ul').querySelectorAll('li').forEach((el) => { el.onclick = () => selectAuthor(el.dataset.name, el); });
  const books = await api(`/api/books?genre=${encodeURIComponent(genre)}&series=${encodeURIComponent(series)}`
    + `&user=${encodeURIComponent(state.user)}`);
  drawBooks(books, series);
}

async function selectGenre(genre, li) {
  state.genre = genre;
  document.querySelectorAll('#genres li').forEach((e) => e.classList.remove('active'));
  if (li) li.classList.add('active');
  const list = await api('/api/authors?genre=' + encodeURIComponent(genre));
  $('#authors ul').innerHTML = list.map((a) =>
    `<li data-name="${esc(a.name)}"><span>${esc(a.name)}</span><span class="count">${a.books}</span></li>`).join('');
  $('#authors ul').querySelectorAll('li').forEach((el) => { el.onclick = () => selectAuthor(el.dataset.name, el); });
  $('#books .list').innerHTML = '<div class="empty">Select an author.</div>';
  show('authors');
}

async function selectAuthor(author, li) {
  state.author = author;
  document.querySelectorAll('#authors li').forEach((e) => e.classList.remove('active'));
  if (li) li.classList.add('active');
  const books = await api(`/api/books?genre=${encodeURIComponent(state.genre)}&author=${encodeURIComponent(author)}`
    + `&user=${encodeURIComponent(state.user)}`);
  drawBooks(books, '');
}

function drawBooks(books, heading, kind = 'Series') {
  // anything drawn here that is not a search result means the box no longer says
  // what is on screen
  if (kind !== 'Search') $('#q').value = '';
  let html = heading ? `<div class="series-head">${kind} · ${esc(heading)}</div>` : '';
  let series = heading;
  for (const b of books) {
    const author = b.author;
    if (!heading && b.series !== series) {
      series = b.series;
      if (series) html += `<div class="series-head">Series · ${esc(series)}</div>`;
    }
    html += `<div class="card" data-started="${b.started ? 1 : 0}">
      <div class="cover" data-glyph="▶">
        <img src="/api/cover/${b.id}?v=${b.coverV || 0}" alt=""
          onclick="playBook(${b.id})" title="Play or pause">
        <label class="listened">
          <input type="checkbox" ${b.done ? 'checked' : ''} onchange="setListened(${b.id}, this)"> Listened
        </label>
      </div>
      <div>
        <h3><span class="note ${b.done ? 'done' : b.started ? 'part' : 'new'}"
              title="${b.done ? 'Listened' : b.started ? 'Partly listened' : 'Not listened yet'}">&#9835;</span>
          ${esc(b.title)}</h3>
        <div class="sub">${esc(author)}</div>
        ${b.series ? `<div class="sub series-of">Series · ${esc(b.series)}${b.series_no ? ' · book ' + b.series_no : ''}</div>` : ''}
        <div class="sub" style="margin-top:6px">
          ${b.year ? `<span class="badge">${esc(b.year)}</span>` : ''}
          ${b.narrator ? `<span class="badge">Narrator: ${esc(b.narrator)}</span>` : ''}
          ${b.duration ? `<span class="badge">${hms(b.duration)}</span>` : ''}
        </div>
        <div class="desc">${esc(b.description) || 'No description.'}</div>
      </div>
      <div class="actions"><button onclick="playBook(${b.id})" data-resume="${b.started || b.done ? 1 : 0}"${b.finished ? ' data-again="1"' : ''}>${b.finished ? '▶ Play again' : b.started || b.done ? '▶ Resume' : '▶ Play'}</button></div>
    </div>`;
  }
  $('#books .list').innerHTML = html || '<div class="empty">No books.</div>';
  markPlaying();
  show('books');
}


// --- which column is on screen -----------------------------------------
// A phone has room for one of the three columns at a time; this says which, and
// the stylesheet does the rest. A wide screen shows all three and ignores it.
// One step out of the book column: back to the authors of the genre being
// browsed, or to the genres themselves when there is no author on screen.
const outOfBooks = () => (!document.body.classList.contains('maintenance')
  && (state.author || state.series) ? 'authors' : 'genres');

const show = (col) => {
  document.body.dataset.col = col;
  // the button says where it goes, not just "back"
  $('#backCol').textContent = outOfBooks() === 'authors' ? '‹ Authors' : '‹ Genres';
};
$('#backGenres').onclick = () => show('genres');
$('#backCol').onclick = () => show(outOfBooks());
$('#toBooks').onclick = () => show('books');

// --- the search box -----------------------------------------------------
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

// --- player -------------------------------------------------------------
const audio = $('#audio');

window.playBook = async function (id) {
  // The same book again: the button that started it is the one that stops it —
  // unless it has run out, where pressing it means playing it again, and that has
  // to go through the loading below: it starts at the top and takes the tick off.
  if (state.book && state.book.id === id && !audio.ended) {
    if (audio.paused) audio.play().catch(() => {}); else audio.pause();
    return;
  }
  if (!state.user) return toast('Pick a name first.');
  const book = await api(`/api/books/${id}?user=${encodeURIComponent(state.user)}`);
  // A book that was finished is played again from the beginning: its kept place
  // is the end of the last track, which would play a few seconds and stop. And
  // listening to it again means it is not a book you are done with, so the tick
  // comes off — the same thing Start again from the beginning does.
  if (book.finished) {
    book.progress = null;
    if (state.user) {
      await post('/api/listened', { user: state.user, bookId: id, done: false }).catch(() => {});
    }
  }
  state.book = book;
  $('#player').hidden = false;
  $('#pCover').src = `/api/cover/${id}?v=${book.coverV || 0}`;
  // every file of this book in one archive, which is what a download of an
  // audiobook means; the name comes from the server, so it is the book's
  $('#pGet').href = `/api/download/${id}`;
  $('#pTitle').textContent = book.title;
  $('#trackSelect').innerHTML = book.tracks.map((t, i) => `<option value="${i}">${i + 1}. ${esc(t.title)}</option>`).join('');
  const at = Math.min(book.progress ? book.progress.track_idx : 0, book.tracks.length - 1);
  playTrack(Math.max(0, at), book.progress ? book.progress.position : 0);
};

function playTrack(idx, position = 0) {
  const t = state.book.tracks[idx];
  if (!t) return;
  state.track = idx;
  $('#trackSelect').value = idx;
  $('#pTrack').textContent = `${idx + 1}/${state.book.tracks.length} · ${t.title}`;
  audio.src = `/api/stream/${t.id}`;
  audio.onloadedmetadata = () => { if (position) audio.currentTime = position; };
  audio.play().catch(() => {});
}

// Whatever offers to play the book that is playing says what pressing it will do
// now — the card in the library, and the tile on the shelf — and everything else
// still says Play.
function markPlaying() {
  const playing = state.book ? state.book.id : 0;
  const label = (button, id) => {
    const mine = id === playing;
    // a book with a place kept in it is resumed, whether or not it is the one
    // loaded in the player: after a reload nothing is loaded, and the shelf still
    // means "carry on with this"
    const kept = button.dataset.resume === '1';
    const again = button.dataset.again === '1';
    button.textContent = mine
      ? (audio.paused ? '▶ Resume' : '⏸ Pause')
      : (again ? '▶ Play again' : kept ? '▶ Resume' : '▶ Play');
    button.classList.toggle('playing', mine && !audio.paused);
    // it has a place kept in it from now on, so it stays a Resume when another
    // book takes over — and it is not a finished book any more either
    if (mine) {
      button.dataset.resume = '1';
      delete button.dataset.again;
    }
  };
  document.querySelectorAll('#books .card .actions button[onclick^="playBook"]').forEach((b) => {
    label(b, Number(b.getAttribute('onclick').match(/\d+/)[0]));
  });
  document.querySelectorAll('#books button[data-play]').forEach((b) => label(b, Number(b.dataset.play)));
  // and the picture itself, which is a play button too: it shows what a click on
  // it will do, and stays lit while that book is playing
  document.querySelectorAll('#books .card .cover').forEach((cover) => {
    const img = cover.querySelector('img[onclick^="playBook"]');
    const mine = img && Number(img.getAttribute('onclick').match(/\d+/)[0]) === playing;
    cover.dataset.glyph = mine && !audio.paused ? '⏸' : '▶';
    cover.classList.toggle('playing', !!mine && !audio.paused);
  });
}
// --- the cover's own menu -----------------------------------------------
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
const showCoverMenu = (book, x, y) => {
  $('#cmTitle').textContent = book.title || 'This book';
  const done = coverMenu.querySelector('[data-act="listened"]');
  if (done) done.textContent = doneNow(book.id) ? '☐ Mark as not listened' : '☑ Mark as listened';
  coverMenu.dataset.id = String(book.id);
  coverMenu.hidden = false;
  // opened at the pointer, then pulled back inside the window
  const box = coverMenu.getBoundingClientRect();
  coverMenu.style.left = `${Math.max(6, Math.min(x, window.innerWidth - box.width - 6))}px`;
  coverMenu.style.top = `${Math.max(6, Math.min(y, window.innerHeight - box.height - 6))}px`;
};
document.addEventListener('contextmenu', (e) => {
  const book = bookOfCover(e.target);
  if (!book) return;
  e.preventDefault();
  showCoverMenu(book, e.clientX, e.clientY);
});
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
const doneNow = (id) => {
  const tick = tickOf(id);
  if (tick) return tick.checked;
  return !!(state.book && state.book.id === id && state.book.progress && state.book.progress.done);
};

onMenu('restart', async () => {
  const id = Number(coverMenu.dataset.id);
  const wasDone = doneNow(id);
  const tick = tickOf(id);
  hideCoverMenu();
  if (!state.user) return toast('Create or select a user first.');
  try {
    // a book being listened to again has not been listened to: the tick comes off,
    // which is also what clears the place kept in it
    if (wasDone) {
      if (tick) { tick.checked = false; await setListened(id, tick); }
      else await post('/api/listened', { user: state.user, bookId: id, done: false });
    }
    // and then it starts at the top, or the player would pick the old place up
    await post('/api/progress', { user: state.user, bookId: id, trackIdx: 0, position: 0 });
  } catch (e) { return toast(e.message); }
  if (state.book && state.book.id === id) return playTrack(0, 0);
  return playBook(id);
});

onMenu('listened', async () => {
  const id = Number(coverMenu.dataset.id);
  const want = !doneNow(id);
  hideCoverMenu();
  // a card on screen owns the tick, its glyph and its button: let it do the work
  const tick = tickOf(id);
  if (tick) {
    tick.checked = want;
    return setListened(id, tick);
  }
  if (!state.user) return toast('Create or select a user first.');
  try { await post('/api/listened', { user: state.user, bookId: id, done: want }); }
  catch (e) { return toast(e.message); }
  if (state.book && state.book.id === id) {
    state.book.progress = { ...(state.book.progress || { track_idx: 0, position: 0 }), done: want };
  }
  toast(want ? 'Marked as listened.' : 'Marked as not listened.');
  return loadStats();
});

onMenu('download', () => {
  const id = coverMenu.dataset.id;
  hideCoverMenu();
  // a link the browser saves, the same address the player's ⤓ uses
  const a = document.createElement('a');
  a.href = `/api/download/${id}`;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
});

$('#pCover').onclick = () => {
  if (!state.book) return;
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
};
// --- the transport ------------------------------------------------------
// A browser's own audio controls cannot be recoloured: the timeline lives in a
// shadow tree the page may not touch, which is why the line that says how far
// into a track you are was whatever grey the browser felt like. So the controls
// are ours, and the <audio> element is only the engine underneath.
const clock = (s) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = String(Math.floor(s % 60)).padStart(2, '0');
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

// the yellow runs to where you are; the rest is the track behind it
const paint = (el, fraction) => el.style.setProperty('--played', `${(fraction * 100).toFixed(2)}%`);

let dragging = false;
const drawTime = () => {
  const total = audio.duration;
  $('#pAt').textContent = clock(audio.currentTime);
  $('#pOf').textContent = isFinite(total) ? clock(total) : '—';
  if (dragging) return;
  const at = isFinite(total) && total > 0 ? audio.currentTime / total : 0;
  $('#seek').value = String(Math.round(at * 1000));
  paint($('#seek'), at);
};
audio.addEventListener('timeupdate', drawTime);
audio.addEventListener('durationchange', drawTime);
audio.addEventListener('loadedmetadata', drawTime);
audio.addEventListener('emptied', drawTime);

const seekTo = () => {
  const at = Number($('#seek').value) / 1000;
  paint($('#seek'), at);
  if (isFinite(audio.duration)) audio.currentTime = at * audio.duration;
};
$('#seek').oninput = () => { dragging = true; paint($('#seek'), Number($('#seek').value) / 1000); };
$('#seek').onchange = () => { dragging = false; seekTo(); };

$('#pPlay').onclick = () => {
  if (!state.book) return;
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
};
const drawPlay = () => {
  $('#pPlay').textContent = audio.paused ? '▶' : '⏸';
  $('#pPlay').classList.toggle('playing', !audio.paused);
};
audio.addEventListener('play', drawPlay);
audio.addEventListener('pause', drawPlay);
audio.addEventListener('ended', drawPlay);

// volume, kept per browser: the one thing the native controls did that a page
// cannot get back by itself
const VOL = 'volume';
audio.volume = Math.min(1, Math.max(0, Number(localStorage[VOL] ?? 1)));
$('#vol').value = String(Math.round(audio.volume * 100));
paint($('#vol'), audio.volume);
const drawVol = () => {
  $('#pVolBtn').textContent = audio.muted || !audio.volume ? '🔇' : '🔊';
  paint($('#vol'), audio.muted ? 0 : audio.volume);
};
$('#vol').oninput = () => {
  audio.muted = false;
  audio.volume = Number($('#vol').value) / 100;
  localStorage[VOL] = String(audio.volume);
  drawVol();
};
$('#pVolBtn').onclick = () => { audio.muted = !audio.muted; drawVol(); };
drawVol();
drawPlay();
drawTime();

audio.addEventListener('play', markPlaying);
audio.addEventListener('pause', markPlaying);
audio.addEventListener('ended', markPlaying);

$('#trackSelect').onchange = (e) => playTrack(Number(e.target.value));
// The last track running out is the end of the book: it has been listened to, and
// the tick has to say so — the counts, the shelves and the Listened section all
// read the tick. Any other track just leads into the next one.
audio.onended = () => {
  if (state.book && state.track >= state.book.tracks.length - 1) return finishedListening();
  return playTrack(state.track + 1);
};

async function finishedListening() {
  const id = state.book.id;
  saveProgress();
  if (!state.user) return;
  try { await post('/api/listened', { user: state.user, bookId: id, done: true }); } catch { return; }
  // the card of that book, if it happens to be on screen, without a redraw
  const tick = document.querySelector(`.card .listened input[onchange*="setListened(${id},"]`);
  if (tick) {
    tick.checked = true;
    const note = tick.closest('.card').querySelector('.note');
    if (note) { note.className = 'note done'; note.title = 'Listened'; }
  }
  loadStats();
  loadListened();
  markPlaying();
}
audio.onpause = saveProgress;
setInterval(() => { if (!audio.paused) saveProgress(); }, 10000);
window.addEventListener('beforeunload', saveProgress);

function saveProgress() {
  if (!state.book || !state.user || !audio.currentTime) return;
  post('/api/progress', { user: state.user, bookId: state.book.id, trackIdx: state.track, position: audio.currentTime })
    .catch(() => {});
}

window.setListened = async function (id, box) {
  if (!state.user) { box.checked = !box.checked; return toast('Pick a name first.'); }
  try {
    await post('/api/listened', { user: state.user, bookId: id, done: box.checked });
    const card = box.closest('.card');
    // unticking cleared the place kept in it, so the card is a fresh book again
    if (!box.checked) card.dataset.started = '0';
    const started = card.dataset.started === '1';
    const note = card.querySelector('.note');
    note.className = 'note ' + (box.checked ? 'done' : started ? 'part' : 'new');
    note.title = box.checked ? 'Listened' : started ? 'Partly listened' : 'Not listened yet';
    const play = card.querySelector('.actions button[onclick^="playBook"]');
    if (play) {
      play.dataset.resume = box.checked || started ? '1' : '0';
      markPlaying();
    }
    loadStats();
  } catch (e) {
    box.checked = !box.checked;
    toast(e.message);
  }
};

(async () => {
  const remembered = localStorage.user || '';
  // this browser has been here before: say so, or the server would not know which
  // names are its own to offer
  if (remembered) await post('/api/users', { name: remembered }).catch(() => {});
  const users = await loadUsers();
  await loadGenres();
  await loadStats();
  await loadHome();
  if (!users.length || !users.includes(remembered)) await askWho(users, users.length > 0);
})();
