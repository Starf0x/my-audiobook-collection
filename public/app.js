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

const state = { user: localStorage.user || '', genre: null, author: null, book: null, track: 0 };

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

// --- one job at a time, and tag writes beside each other ----------------
// A job that moves files or rewrites the library runs alone: it greys the button
// that started it and everything else that would start work. Without that, a slow
// import invites a second click on the same book, and the question about the copy
// already in the library comes back while it is running.
//
// Tag writes are the exception. Each one touches only its own book's files and
// keeps its own count, so two books — two series — can be written at the same
// time. They still hold back the jobs that would move those files underneath them.
let job = '';
let writes = 0;

async function work(button, what, fn, alone = true) {
  if (job) { toast(`${job} is still running. Wait for it to finish.`); return null; }
  if (alone && writes) { toast('A tag write is still running. Wait for it to finish.'); return null; }
  if (alone) {
    job = what;
    document.body.classList.add('working');
  } else {
    writes++;
    document.body.classList.add('writing');
  }
  if (button) button.disabled = true;
  try {
    return await fn();
  } finally {
    if (alone) {
      job = '';
      document.body.classList.remove('working');
    } else if (--writes === 0) {
      document.body.classList.remove('writing');
    }
    if (button) button.disabled = false;
  }
}

// --- admin or listener --------------------------------------------------
// With no password set everyone is admin, which is how a private install works.
// With one set, a browser that has not unlocked can browse, play and keep its
// own place, and the controls that change the collection are not drawn at all.
const perm = { required: false, admin: true };

// This is the page that changes things, so it is for an unlocked browser only.
// Everyone else is sent to the listening page.
async function loadPerm() {
  const p = await api('/api/admin').catch(() => ({ required: false, admin: true }));
  perm.required = p.required;
  perm.admin = p.admin;
  if (perm.required && !perm.admin) location.replace('/');
  $('#adminBtn').hidden = !perm.required;
}

$('#adminBtn').onclick = async () => {
  await post('/api/admin/lock', {});
  location.replace('/');
};

// --- users -------------------------------------------------------------
async function loadUsers() {
  const users = await api('/api/users');
  $('#user').innerHTML = users.map((u) => `<option${u === state.user ? ' selected' : ''}>${esc(u)}</option>`).join('')
    || '<option value="">(no user)</option>';
  state.user = $('#user').value || '';
  localStorage.user = state.user;
  return users;
}

// Asked on a first visit, and whenever this browser remembers a name the server
// does not know: without a name there is nowhere to keep a playback position.
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

async function loadStats() {
  const s = await api('/api/stats?user=' + encodeURIComponent(state.user));
  $('#status').innerHTML = [
    [s.books, 'audiobooks'], [s.files, 'files'], [s.done, 'listened'], [s.todo, 'not listened'],
  ].map(([n, label]) => `<span><strong>${n.toLocaleString()}</strong> ${label}</span>`).join('')
    // which build is answering, so "is this the new one?" has an answer on screen
    + (s.version ? `<span class="ver">v${esc(s.version)}</span>` : '');
}

// --- landing view ------------------------------------------------------
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
    <img src="/api/cover/${b.id}?v=${b.coverV || 0}" alt="">
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

async function loadHome() {
  loadListened();
  document.body.classList.remove('maintenance');
  $('#q').value = '';
  document.querySelectorAll('#genres li, #authors li').forEach((e) => e.classList.remove('active'));
  $('#authors ul').innerHTML = '';
  const d = await api('/api/home?user=' + encodeURIComponent(state.user));
  const html = shelf('Continue listening', d.continue, true) + shelf('Recently added', d.recent, false);
  $('#books .list').innerHTML = html
    || '<div class="empty">Nothing here yet — add a library folder in Settings and scan.</div>';
  show('books');
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

async function openInLibrary(genre, author) {
  const gli = [...document.querySelectorAll('#genres ul li[data-name]')].find((l) => l.dataset.name === genre);
  await selectGenre(genre, gli);
  const ali = [...document.querySelectorAll('#authors li')].find((l) => l.dataset.name === author);
  await selectAuthor(author, ali);
}

// --- browsing ----------------------------------------------------------
// Each genre lists its series underneath it: a series belongs to a genre, and a
// reader looking for the next book of one is not looking for its author first.
// Which genres are showing their series. Kept in the browser, so the column
// looks the same when you come back to it.
const openGenres = new Set(JSON.parse(localStorage.openGenres || '[]'));
const rememberOpen = () => { localStorage.openGenres = JSON.stringify([...openGenres]); };

function showSeriesOf(genre, open) {
  if (open) openGenres.add(genre); else openGenres.delete(genre);
  rememberOpen();
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
    || '<li class="empty">No genres — add a library folder in Settings and scan.</li>';

  $('#genres ul').querySelectorAll('li[data-name]').forEach((li) => {
    li.onclick = (e) => {
      // only the arrow folds and unfolds; the name selects the genre and leaves
      // the series list as it was
      if (e.target.classList.contains('twist')) return showSeriesOf(li.dataset.name, !openGenres.has(li.dataset.name));
      selectGenre(li.dataset.name, li);
    };
  });
  $('#genres ul').querySelectorAll('li[data-series]').forEach((li) => {
    li.onclick = () => selectSeries(li.dataset.genre, li.dataset.series, li);
  });
  // put back whatever was open before
  for (const g of list) if (openGenres.has(g.name)) showSeriesOf(g.name, true);
}

async function selectGenre(genre, li) {
  document.body.classList.remove('maintenance');
  state.genre = genre;
  state.series = '';
  document.querySelectorAll('#genres li').forEach((e) => e.classList.remove('active'));
  if (li) li.classList.add('active');
  const list = await api('/api/authors?genre=' + encodeURIComponent(genre));
  $('#authors ul').innerHTML = list.map((a) =>
    `<li data-name="${esc(a.name)}"><span>${esc(a.name)}</span><span class="count">${a.books}</span></li>`).join('');
  $('#authors ul').querySelectorAll('li').forEach((el) => { el.onclick = () => selectAuthor(el.dataset.name, el); });
  $('#books .list').innerHTML = '<div class="empty">Select an author, or a series under the genre.</div>';
  show('authors');
}

// One series, in reading order where the files number it
async function selectSeries(genre, series, li) {
  document.body.classList.remove('maintenance');
  state.genre = genre;
  state.series = series;
  state.author = null;
  document.querySelectorAll('#genres li, #authors li').forEach((e) => e.classList.remove('active'));
  const row = li || [...document.querySelectorAll('#genres li[data-series]')]
    .find((l) => l.dataset.genre === genre && l.dataset.series === series);
  if (row) row.classList.add('active');
  const authors = await api('/api/authors?genre=' + encodeURIComponent(genre));
  $('#authors ul').innerHTML = authors.map((a) =>
    `<li data-name="${esc(a.name)}"><span>${esc(a.name)}</span><span class="count">${a.books}</span></li>`).join('');
  $('#authors ul').querySelectorAll('li').forEach((el) => { el.onclick = () => selectAuthor(el.dataset.name, el); });
  await drawBooks(await api(`/api/books?genre=${encodeURIComponent(genre)}&series=${encodeURIComponent(series)}`
    + `&user=${encodeURIComponent(state.user)}`), series);
}

async function selectAuthor(author, li) {
  state.author = author;
  state.series = '';
  document.querySelectorAll('#authors li').forEach((e) => e.classList.remove('active'));
  document.querySelectorAll('#genres li[data-series]').forEach((e) => e.classList.remove('active'));
  const row = li || [...document.querySelectorAll('#authors li')].find((l) => l.dataset.name === author);
  if (row) row.classList.add('active');
  const books = await api(`/api/books?genre=${encodeURIComponent(state.genre)}&author=${encodeURIComponent(author)}`
    + `&user=${encodeURIComponent(state.user)}`);
  await drawBooks(books, '');
}

async function drawBooks(books, heading, kind = 'Series') {
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
          ${b.tagged
            ? `<span class="badge tagged" title="Tags found in the MP3 files"><span class="wide">In MP3: ${esc(b.tagged.split(',').join(', '))}</span><span class="narrow">In MP3: ${b.tagged.split(',').length} tags</span></span>`
            : '<span class="badge untagged" title="The MP3 files carry none of these tags">Not in MP3</span>'}
        </div>
        <div class="desc">${esc(b.description) || 'No description.'}</div>
      </div>
      <div class="actions">
        <button onclick="playBook(${b.id})" data-resume="${b.started || b.done ? 1 : 0}"${b.finished ? ' data-again="1"' : ''}>${b.finished ? '▶ Play again' : b.started || b.done ? '▶ Resume' : '▶ Play'}</button>
        <button class="ghost" onclick="findMeta(${b.id})">Find metadata</button>
        <button class="ghost" onclick="writeTags(${b.id}, this)">Write into MP3s</button>
        <button class="ghost" onclick="editMeta(${b.id})">Edit metadata</button>
        <div class="row2">
          <button class="ghost" onclick="moveBook(${b.id})">Move…</button>
          <button class="ghost danger" onclick="trashBook(${b.id})">Delete…</button>
        </div>
      </div>
    </div>`;
  }
  $('#books .list').innerHTML = html || '<div class="empty">No books.</div>';
  markPlaying();
  show('books');
}


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

// --- player ------------------------------------------------------------
const audio = $('#audio');

window.playBook = async function (id) {
  // The same book again: the button that started it is the one that stops it —
  // unless it has run out, where pressing it means playing it again, and that has
  // to go through the loading below: it starts at the top and takes the tick off.
  if (state.book && state.book.id === id && !audio.ended) {
    if (audio.paused) audio.play().catch(() => {}); else audio.pause();
    return;
  }
  if (!state.user) return toast('Create or select a user first.');
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
  // a saved track index can outlive the files it pointed at
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

onMenu('edit', () => { const id = Number(coverMenu.dataset.id); hideCoverMenu(); editMeta(id); });
onMenu('find', () => { const id = Number(coverMenu.dataset.id); hideCoverMenu(); findMeta(id); });

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

// --- metadata lookup ---------------------------------------------------
window.setListened = async function (id, box) {
  if (!state.user) { box.checked = !box.checked; return toast('Create or select a user first.'); }
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

// Writes tags while the bar at the bottom follows the file count.
// One write per book in this page as well as on the server: the card, the Needs
// tags row, the edit dialog and the lookup dialog all end up here, and the button
// that was pressed is not the only way in. The server refuses a second write on
// the same book too — this is so the answer is a sentence rather than an error.
const writingBooks = new Set();

async function writeWithProgress(id, pick, genre, title = '') {
  if (writingBooks.has(id)) {
    toast(`${title || 'That book'} is already being written. Wait for it to finish.`);
    return false;
  }
  writingBooks.add(id);
  try {
    return await write_(id, pick, genre, title);
  } finally {
    writingBooks.delete(id);
  }
}

async function write_(id, pick, genre, title) {
  const until = { finished: false };
  const request = post(`/api/apply/${id}`, { pick, genre, writeTags: true })
    .catch((e) => ({ error: e.message }))
    .then((r) => { until.finished = true; return r; });
  // by book, both in the bar's label and in what it asks the server: with two
  // writes running, one shared count and one shared label say nothing
  const p = await trackProgress(`/api/apply/status?book=${id}`,
    title ? `Writing tags · ${title}` : 'Writing tags…', until);
  const r = await request;
  const failure = r.error || p.error;
  p.bar.say(failure ? `Writing tags failed${title ? ' · ' + title : ''}: ${failure}`
    : `${title ? title + ': ' : ''}${r.written} MP3 file(s) tagged.`, !!failure);
  p.bar.done(failure ? 15000 : 3000);
  // the maintenance list and its count depend on what is in the files
  loadUntagged().then(() => { if ($('#needsTags').classList.contains('active')) $('#needsTags').click(); });
  return !failure;
}

// Write what the app already knows about the book into its MP3 files.
window.writeTags = (id, button) => {
  // the card or the row it was pressed on names the book, for its own bar
  const title = button?.closest('.card, .fix')?.querySelector('h3, strong')
    ?.textContent.replace('♫', '').replace(/\s+/g, ' ').trim() || '';
  return work(button, 'A tag write', () => writeWithProgress(id, {}, '', title), false);
};

// A run of books, one at a time, so the bar can show where it is.
async function writeMany(books) {
  const bar = newBar('Writing tags…');
  let failed = 0;
  for (const [i, b] of books.entries()) {
    bar.at(((i + 1) / books.length) * 100);
    bar.say(`Writing tags ${i + 1} / ${books.length} · ${b.title}`);
    if (writingBooks.has(b.id)) { failed++; continue; } // that one is being written already
    writingBooks.add(b.id);
    const r = await post(`/api/apply/${b.id}`, { pick: {}, writeTags: true }).catch(() => null);
    writingBooks.delete(b.id);
    if (!r) failed++;
  }
  bar.say(`Tags written into ${books.length - failed} of ${books.length} book(s).`, failed > 0);
  bar.done(failed ? 15000 : 3000);
  loadUntagged();
}

// --- the whole collection, written on the server ------------------------
// It outlives the page, so the page only starts it, follows it and stops it.
let tagWatch = null;

function tagAllWords(s) {
  if (s.state === 'running') return `Writing tags: ${s.done} of ${s.total} book(s) done, ${s.left} to go. Now: ${s.current}`;
  if (s.state === 'paused') return `Stopped at ${s.done} of ${s.total} book(s) — ${s.left} still to go. Start again to carry on.`;
  if (s.state === 'done') return `Last run: ${s.written} file(s) tagged in ${s.done} book(s).`;
  return 'Not started.';
}

async function showTagAll(s) {
  const status = s || await api('/api/tagall/status').catch(() => ({ state: 'idle' }));
  $('#tagAllState').textContent = tagAllWords(status);
  $('#tagAll').textContent = status.state === 'paused' ? 'Carry on writing tags' : 'Write tags into all MP3s';
  $('#tagAll').disabled = status.state === 'running';
  $('#tagAllStop').hidden = status.state !== 'running';
  return status;
}

// One bar that follows the run wherever it was started, and lets go when it ends
function watchTagAll() {
  if (tagWatch) return;
  const bar = newBar('Writing tags…');
  tagWatch = setInterval(async () => {
    const s = await api('/api/tagall/status').catch(() => null);
    if (!s) return;
    if (s.total) bar.at((s.done / s.total) * 100);
    bar.say(tagAllWords(s), s.state === 'paused');
    showTagAll(s);
    if (s.state !== 'running') {
      clearInterval(tagWatch);
      tagWatch = null;
      bar.done(s.state === 'paused' ? 8000 : 5000);
      loadUntagged();
      if (state.author) selectAuthor(state.author, null);
    }
  }, 1000);
}

$('#tagAll').onclick = async () => {
  const s = await api('/api/tagall/status').catch(() => ({ state: 'idle' }));
  const going = s.state === 'paused'
    ? confirm(`Carry on writing tags? ${s.left} book(s) are still to go.`)
    : confirm('Write tags into every MP3 of every book?\n\nThis rewrites the files and takes a long '
      + 'time on a big collection. It runs on the server, so you can close this page; stopping it '
      + 'keeps its place.');
  if (!going) return;
  await post('/api/tagall', {});
  $('#settings').close();
  watchTagAll();
};

$('#tagAllStop').onclick = async () => {
  await post('/api/tagall/stop', {}).catch((e) => toast(e.message));
  await showTagAll();
};

// --- import: file a folder from the import path under a genre and author ---
// Reading a tag per book takes a moment on a full import folder, so the bar
// follows it. Errors are handed back rather than swallowed into "nothing found".
// The count comes off the kept list without touching the folder, so opening the
// app never starts a minute of tag reading.
async function importCountOnly() {
  const st = await api('/api/import/state').catch(() => null);
  $('#importCount').textContent = st && st.cachedAt ? st.count : '–';
}

async function loadImport(showBar, refresh) {
  const until = { finished: false };
  const request = api('/api/import' + (refresh ? '?refresh=1' : ''))
    .then((d) => ({ d }), (e) => ({ error: e.message }))
    .then((r) => { until.finished = true; return r; });
  // The bar only means anything while the list is actually being read: handed
  // back from the kept list, the answer is there before the first poll.
  const p = showBar ? await trackProgress('/api/files/status', 'Reading the import folder…', until) : null;
  const r = await request;
  if (p) p.bar.done(0);
  $('#importCount').textContent = r.d ? r.d.candidates.length : '–';
  return r;
}

const PER_PAGE = 10;
let importPage = 0;
let importData = null;
let importWatch = null;

$('#importList').onclick = async (e) => {
  document.body.classList.add('maintenance');
  document.querySelectorAll('#genres li').forEach((el) => el.classList.remove('active'));
  $('#importList').classList.add('active');
  $('#authors ul').innerHTML = '';
  if (e !== 'keep') importPage = 0;
  $('#books .list').innerHTML = '<div class="empty">Looking in the import folder…</div>';
  const { d, error } = await loadImport(true);
  if (error) {
    $('#books .list').innerHTML = `<div class="empty missing">${esc(error)}</div>`;
    return;
  }
  importData = d;
  drawImportPage();
  watchImportFolder();
};

function drawImportPage() {
  const d = importData;
  if (!d.genres.length) {
    $('#books .list').innerHTML = '<div class="empty missing">No genre folders to import into. '
      + 'Add a library folder in Settings and scan first.</div>';
    return;
  }
  if (!d.candidates.length) {
    $('#books .list').innerHTML = `<div class="empty">No audiobook folders found in ${esc(d.path)}.</div>`;
    return;
  }
  const pages = Math.max(1, Math.ceil(d.candidates.length / PER_PAGE));
  importPage = Math.min(importPage, pages - 1);
  const from = importPage * PER_PAGE;
  const page = d.candidates.slice(from, from + PER_PAGE);
  const pager = `<div class="row pager">
    <button id="iPrev" class="ghost"${importPage ? '' : ' disabled'}>‹ Previous</button>
    <span class="hint">${from + 1}–${from + page.length} of ${d.candidates.length} · page ${importPage + 1} of ${pages}</span>
    <button id="iNext" class="ghost"${importPage + 1 < pages ? '' : ' disabled'}>Next ›</button>
    <div class="spacer"></div>
    <span class="hint" id="iFresh"></span>
    <button id="iReread" class="ghost">Read again</button>
  </div>`;
  $('#books .list').innerHTML = pager + page.map((c, i) => `<div class="fix">
    <div>
      <strong>${esc(c.name)}</strong>
      <div class="sub">${esc(c.where)}</div>
      <div class="sub">${c.files} file(s)${c.album ? ' · album: ' + esc(c.album) : ''}${c.artist ? ' · author: ' + esc(c.artist) : ''}</div>
    </div>
    <div class="actions"><button data-pick="${from + i}">Import this</button></div>
  </div>`).join('') + pager;
  document.querySelectorAll('#books button[data-pick]').forEach((b) => {
    b.onclick = () => importForm(d, d.candidates[Number(b.dataset.pick)]);
  });
  document.querySelectorAll('#books #iPrev').forEach((b) => { b.onclick = () => { importPage--; drawImportPage(); }; });
  document.querySelectorAll('#books #iNext').forEach((b) => { b.onclick = () => { importPage++; drawImportPage(); }; });
  document.querySelectorAll('#books #iReread').forEach((b) => {
    b.onclick = async () => {
      const { d: fresh, error } = await loadImport(true, true);
      if (error) return toast(error);
      importData = fresh;
      drawImportPage();
    };
  });
  showFreshness();
}

function showFreshness(state) {
  const when = importData && importData.cachedAt
    ? new Date(importData.cachedAt).toTimeString().slice(0, 5) : '';
  document.querySelectorAll('#books #iFresh').forEach((s) => {
    s.textContent = state && state.checking ? 'checking the folder…' : (when ? `list read at ${when}` : '');
  });
}

// While the panel is open, ask the server whether it found the folder changed;
// it re-reads on its own, so all this does is pick the new list up.
function watchImportFolder() {
  clearInterval(importWatch);
  importWatch = setInterval(async () => {
    if (!$('#importList').classList.contains('active')) return clearInterval(importWatch);
    const state = await api('/api/import/state').catch(() => null);
    if (!state) return;
    showFreshness(state);
    // The list on screen is the one read at importData.cachedAt. If the server
    // has read the folder since, that is a newer list and this one is out of
    // date. Counting the changes instead missed the first one, because the count
    // had already gone up before this watch took its first look — which is how an
    // emptied import folder stayed on screen with every book still in it.
    if (importData && state.cachedAt && state.cachedAt !== importData.cachedAt && !state.building) {
      const { d } = await loadImport(false);
      if (d) { importData = d; drawImportPage(); toast('The import folder changed — list updated.'); }
    }
  }, 2000);
}

// A dialog rather than a panel: with a long candidate list a form appended below
// it lands off screen, which looks exactly like the button doing nothing.
function importForm(d, c) {
  $('#iSource').textContent = `From ${c.where} · ${c.files} file(s)`;
  $('#iFound').innerHTML = '';
  $('#iGenre').innerHTML = d.genres.map((g) =>
    `<option${g === c.genre ? ' selected' : ''}>${esc(g)}</option>`).join('');
  $('#iAuthor').value = c.artist || '';
  $('#iSeries').value = c.series || '';
  $('#iTitle').value = c.album || c.name;
  const preview = () => {
    const parts = [$('#iAuthor').value.trim(), $('#iSeries').value.trim(), $('#iTitle').value.trim()].filter(Boolean);
    $('#iWhere').textContent = `Moves into ${$('#iGenre').value} / ${parts.join(' / ')}`;
  };
  ['iGenre', 'iAuthor', 'iSeries', 'iTitle'].forEach((id) => { $('#' + id).oninput = preview; $('#' + id).onchange = preview; });
  preview();
  // Look the book up before its folder name is settled, and fill the fields in
  // from a result rather than typing them.
  $('#iLookup').onclick = async () => {
    const q = [$('#iTitle').value.trim(), $('#iAuthor').value.trim()].filter(Boolean).join(' ');
    if (!q) return toast('Fill in a title or author to search for.');
    $('#iFound').innerHTML = '<p class="hint">Searching Google Books…</p>';
    try {
      const found = await api('/api/lookup?q=' + encodeURIComponent(q));
      $('#iFound').innerHTML = found.length ? found.slice(0, 4).map((r, i) => `<div class="cand">
        ${r.thumbnail ? `<img src="${esc(r.thumbnail)}" alt="">` : ''}
        <div style="flex:1">
          <strong>${esc(r.title)}</strong>
          <div class="sub">${esc(r.author)}${r.year ? ' · ' + esc(r.year) : ''}</div>
          <div class="row"><button data-use="${i}">Use this</button></div>
        </div></div>`).join('') : '<p class="hint missing">No match. Adjust the title or author and try again.</p>';
      $('#iFound').querySelectorAll('button[data-use]').forEach((b) => {
        b.onclick = () => {
          const r = found[Number(b.dataset.use)];
          if (r.title) $('#iTitle').value = r.title;
          if (r.author) $('#iAuthor').value = r.author;
          $('#iFound').innerHTML = '';
          preview();
        };
      });
    } catch (e) {
      $('#iFound').innerHTML = `<p class="hint missing">${esc(e.message)}</p>`;
    }
  };

  $('#iGo').onclick = async () => {
    const body = {
      source: c.path, genre: $('#iGenre').value, author: $('#iAuthor').value.trim(),
      series: $('#iSeries').value.trim(), title: $('#iTitle').value.trim(),
    };
    // Never overwrite a book unseen: if one is already there, the two copies are
    // compared first and it is the admin who decides which one the library keeps.
    // That reads every file of both, so it is not instant on a share.
    const bar = newBar('Looking at what is already there…');
    const clash = await api('/api/import/compare?' + new URLSearchParams(body)).catch(() => ({ exists: false }));
    bar.done(0);
    if (clash.exists) return askConflict(body, clash);
    $('#importDlg').close();
    await work($('#iGo'), 'The import', () => runImport(body));
  };
  $('#importDlg').showModal();
}
$('#closeImport').onclick = () => $('#importDlg').close();

async function runImport(body) {
  const { ok, r, bar } = await fileWork('/api/import', body, 'Import');
  if (!ok) {
    // the candidate is still there: back to the list so it can be tried again
    $('#importList').onclick('keep');
    return;
  }
  // the server files the book as it moves it, so there is nothing to rescan;
  // open the genre and author it landed under, which is where it now is
  bar.say(r.replacedPath
    ? `Imported into ${r.dest}, the copy that was there is now ${r.replacedPath}`
    : `Imported into ${r.dest}`);
  await refreshLibrary();
  if (r.genre && r.author) await openInLibrary(r.genre, r.author);
  toast(`${r.title} is now under ${r.genre} / ${r.author}. Import is in the left column for the next one.`);
}

// --- two copies of the same book ---------------------------------------
const kb = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB'
  : n >= 1e6 ? (n / 1e6).toFixed(0) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' kB');
const hm = (s) => (!s ? '—' : `${Math.floor(s / 3600)}h ${String(Math.round(s % 3600 / 60)).padStart(2, '0')}m`);

function askConflict(body, clash) {
  const { existing: a, incoming: b } = clash;
  // the numbers that decide it: bit rate first, then how complete the copy is
  const rows = [
    ['Bit rate', `${a.bitrate || '—'} kbps`, `${b.bitrate || '—'} kbps`, Math.sign(b.bitrate - a.bitrate)],
    ['Sample rate', `${a.sampleRate ? (a.sampleRate / 1000).toFixed(1) + ' kHz' : '—'}`,
      `${b.sampleRate ? (b.sampleRate / 1000).toFixed(1) + ' kHz' : '—'}`, Math.sign(b.sampleRate - a.sampleRate)],
    ['Channels', a.channels || '—', b.channels || '—', Math.sign(b.channels - a.channels)],
    ['Format', `${esc(a.codec || '—')}${a.lossless ? ' · lossless' : ''}`,
      `${esc(b.codec || '—')}${b.lossless ? ' · lossless' : ''}`, Math.sign(b.lossless - a.lossless)],
    ['Playing time', hm(a.duration), hm(b.duration), Math.sign(Math.round(b.duration / 60) - Math.round(a.duration / 60))],
    ['Files', a.files, b.files, 0],
    ['Size', kb(a.bytes), kb(b.bytes), 0],
  ];
  $('#cWhere').textContent = `A book already sits in ${clash.dest}`;
  $('#cTable').innerHTML = `<table class="cmp">
    <tr><th></th><th>In the library now</th><th>The new copy</th></tr>
    ${rows.map(([label, l, r, better]) => `<tr><td>${label}</td>
      <td class="${better < 0 ? 'better' : ''}">${l}</td>
      <td class="${better > 0 ? 'better' : ''}">${r}</td></tr>`).join('')}
  </table>`;
  const d = (b.bitrate || 0) - (a.bitrate || 0);
  const mins = Math.round((b.duration - a.duration) / 60);
  $('#cVerdict').textContent = [
    d > 0 ? `The new copy is ${d} kbps higher.` : d < 0 ? `The new copy is ${-d} kbps lower.` : 'Both are the same bit rate.',
    mins > 1 ? `It is ${mins} minutes longer.` : mins < -1 ? `It is ${-mins} minutes shorter.` : 'The playing time matches.',
  ].join(' ');

  $('#cCancel').onclick = () => $('#conflict').close();
  $('#cReplace').onclick = async () => {
    $('#conflict').close();
    $('#importDlg').close();
    await work($('#cReplace'), 'The import', () => runImport({ ...body, replace: true }));
  };
  $('#cSkip').onclick = async () => {
    $('#conflict').close();
    $('#importDlg').close();
    try {
      const r = await post('/api/import/skip', { source: body.source });
      toast(`Left in the import folder as ${r.skipped.split(/[\\/]/).pop()}`);
    } catch (e) { toast(e.message); }
    $('#importList').onclick('keep');
  };
  $('#conflict').showModal();
}

// --- cover files no book uses any more ---------------------------------
// Who the app writes as, and what each folder lets it do.
$('#checkPerms').onclick = async () => {
  $('#permsOut').innerHTML = '<p class="hint">Looking…</p>';
  let r;
  try { r = await api('/api/permissions'); } catch (e) { return toast(e.message); }
  const who = r.writingAs;
  const said = who.uid === null
    ? 'This platform has no user to write as (Windows), so nothing is dropped.'
    : `Writing as ${who.uid}:${who.gid}, umask ${who.umask}`
      + (who.asked.PUID || who.asked.PGID
        ? ` — asked for ${who.asked.PUID || '?'}:${who.asked.PGID || '?'}`
        : ' — PUID and PGID are not set on the container');
  const rows = r.places.map((p) => `<tr>
      <td>${esc(p.what)}</td>
      <td class="mono">${esc(p.path || '—')}</td>
      <td>${p.exists ? esc(p.owner) + ' · ' + esc(p.mode) : esc(p.why || 'not there')}</td>
      <td class="${p.canWrite ? 'better' : 'worse'}">${p.canWrite ? 'can write' : 'cannot write'
    + (p.why ? ' (' + esc(p.why) + ')' : '')}</td>
    </tr>`).join('');
  $('#permsOut').innerHTML = `<p class="hint">${esc(said)}</p>
    <table class="cmp"><tr><th>What</th><th>Where</th><th>Owner · mode</th><th></th></tr>${rows}</table>`;
};

// Home Assistant has a page of its own: an address, a token and media players are
// more than a dialog section can hold.
$('#toHa').onclick = () => { location.href = '/ha'; };

// What Google answered for a stretch of books, as a table to read and to send on.
// Its own request count per book is the part worth seeing: a series in the title
// is free, and everything else is not.
$('#seriesReport').onclick = () => work($('#seriesReport'), 'The series report', async () => {
  $('#seriesOut').innerHTML = '<p class="hint">Asking Google, one book at a time…</p>';
  let r;
  try { r = await api(`/api/lookup/series-report?limit=${$('#seriesReportN').value}`); }
  catch (e) { $('#seriesOut').innerHTML = ''; return toast(e.message); }
  const found = r.books.filter((b) => b.series).length;
  const rows = r.books.map((b) => {
    const said = [b.seriesId ? 'id ' + b.seriesId : '', b.orderNumber !== '' && b.orderNumber !== undefined ? 'order ' + b.orderNumber : '',
      b.bookDisplayNumber ? 'shows ' + b.bookDisplayNumber : '', b.shortSeriesBookTitle ? '“' + b.shortSeriesBookTitle + '”' : '']
      .filter(Boolean).join(' · ');
    return `<tr>
      <td>${esc(b.title)}<div class="hint">${esc(b.author)}${b.has ? ' · filed under ' + esc(b.has) : ''}</div></td>
      <td>${esc(b.googleTitle || '—')}${b.subtitle ? `<div class="hint">${esc(b.subtitle)}</div>` : ''}</td>
      <td class="${b.series ? 'better' : 'worse'}">${b.series
        ? esc(b.series) + (b.seriesNo ? ' · book ' + b.seriesNo : '')
        : esc(b.error || 'nothing')}${b.series || !b.why ? '' : `<div class="hint">${esc(b.why)}</div>`}</td>
      <td>${esc(b.from || '—')}${said ? `<div class="hint">${esc(said)}</div>` : ''}</td>
      <td>${1 + (b.asked || []).length}${b.inSearch ? '<div class="hint">came with the search</div>' : ''}</td>
    </tr>`;
  }).join('');
  $('#seriesOut').innerHTML = `<p class="hint">${found} of ${r.books.length} book(s) got a series.</p>
    <table class="cmp"><tr><th>Book</th><th>Google’s title</th><th>Series</th><th>From</th><th>Calls</th></tr>${rows}</table>`;
});

$('#tidyCovers').onclick = () => work($('#tidyCovers'), 'The cover tidy-up', async () => {
  try {
    const r = await post('/api/covers/tidy', {});
    const where = `${r.duplicates} file(s) in covers/duplicates`;
    if (!r.tooMany) return toast(`${r.moved} unused cover(s) moved aside, ${r.kept} still in use. Now ${where}.`);
    // more than a thousand: they are either not worth keeping, or worth keeping as one file
    if (confirm(`${r.moved} unused cover(s) moved aside. There are now ${where}, `
      + `which is more than ${r.zipAt}.\n\nDelete them?\n\nCancel keeps them, zipped into one file.`)) {
      const d = await post('/api/covers/duplicates/delete', {});
      toast(`${d.deleted} cover file(s) deleted.`);
    } else {
      const z = await post('/api/covers/duplicates/zip', {});
      toast(`${z.zipped} cover file(s) zipped into ${z.zip.split(/[\\/]/).pop()} (${kb(z.bytes)}), loose files removed.`);
    }
  } catch (e) {
    toast(e.message);
  }
});

// --- books the disk does not back up any more ---------------------------
const WHY = {
  gone: 'The folder is gone',
  empty: 'No audio files left in the folder',
  unreadable: 'The folder cannot be read',
  damaged: 'Files that cannot be read',
  changed: 'Files have changed on disk',
};

// What the last scan walked past. The row is not there at all when there is
// nothing in it: an empty list is not worth a place in the column.
async function loadSkipped() {
  const items = await api('/api/skipped').catch(() => []);
  $('#skippedCount').textContent = items.length || '0';
  $('#skippedList').hidden = !items.length;
  return items;
}

const WHY_SKIPPED = {
  deeper: 'A folder deeper than the layout reads',
  unsupported: 'Files this app does not read',
  empty: 'Nothing to read in it',
  loose: 'Audio outside a book folder',
  aside: 'Set aside by an import',
  unreadable: 'The folder could not be read',
};

$('#skippedList').onclick = async () => {
  document.body.classList.add('maintenance');
  document.querySelectorAll('#genres li').forEach((el) => el.classList.remove('active'));
  $('#skippedList').classList.add('active');
  $('#authors ul').innerHTML = '';
  const items = await loadSkipped();
  const said = items.length
    ? `${items.length} folder(s) the last scan walked past — nothing here was deleted or changed`
    : 'The last scan counted everything it walked past';
  // A folder with audio in it can be filed: give it a genre, an author and a
  // title and it is moved where those say, with the same words written into its
  // files. The reasons that are not about a misplaced folder — nothing in it, a
  // format this app does not read, a folder it may not open — have nothing to file.
  const rows = (reason) => items.filter((i) => i.reason === reason).map((i) => `<div class="fix">
      <div>
        <strong>${esc(i.path.split(/[\\/]/).pop())}</strong>
        <div class="sub missing">${esc(i.detail)}</div>
        <div class="sub path">${esc(i.path)}</div>
      </div>
      ${FILEABLE.includes(reason)
        ? `<div><button data-file="${esc(i.path)}" data-reason="${esc(reason)}">File this book…</button></div>`
        : ''}
    </div>`).join('');
  $('#books .list').innerHTML = `<div class="row pager"><span class="hint">${esc(said)}</span></div>`
    + [...new Set(items.map((i) => i.reason))]
      .map((reason) => `<div class="series-head">${esc(WHY_SKIPPED[reason] || reason)}</div>${rows(reason)}`)
      .join('');
  $('#books .list').querySelectorAll('button[data-file]').forEach((b) => {
    b.onclick = () => askToFile(b.dataset.file, b.dataset.reason);
  });
};

// Which of the reasons a folder was walked past can be put right by filing it.
const FILEABLE = ['deeper', 'loose', 'aside'];

// Give the folder a genre, an author and a title: that decides where it goes, and
// the same words are written into its files.
async function askToFile(source, reason) {
  let guess;
  try { guess = await api(`/api/skipped/guess?path=${encodeURIComponent(source)}&reason=${encodeURIComponent(reason)}`); }
  catch (e) { return toast(e.message); }
  $('#fWhat').textContent = source;
  $('#fFound').textContent = guess.files
    ? `${guess.files} audio file(s)${guess.discs.length > 1 ? ` in ${guess.discs.length} sub-folders, which are put together in order` : ''}.`
    : 'No audio found in it.';
  $('#fGenre').innerHTML = guess.genres
    .map((g) => `<option${g === guess.genre ? ' selected' : ''}>${esc(g)}</option>`).join('');
  $('#fAuthor').value = guess.author || '';
  $('#fSeries').value = guess.series || '';
  $('#fTitle').value = guess.title || '';
  $('#fTags').checked = true;
  const where = () => {
    const genre = $('#fGenre').value;
    const author = $('#fAuthor').value.trim();
    const title = $('#fTitle').value.trim();
    const parts = [genre, author, $('#fSeries').value.trim(), title].filter(Boolean);
    $('#fWhere').textContent = genre && author && title
      ? `It goes to ${parts.join(' / ')}`
      : 'A genre, an author and a title are needed.';
  };
  ['#fGenre', '#fAuthor', '#fSeries', '#fTitle'].forEach((sel) => { $(sel).oninput = where; $(sel).onchange = where; });
  where();
  $('#fGo').onclick = () => work($('#fGo'), 'Filing the book', async () => {
    const body = {
      source, reason, genre: $('#fGenre').value,
      author: $('#fAuthor').value.trim(), series: $('#fSeries').value.trim(),
      title: $('#fTitle').value.trim(), writeTags: $('#fTags').checked,
    };
    let r;
    try { r = await post('/api/skipped/file', body); } catch (e) { return toast(e.message); }
    $('#fileIn').close();
    toast(`Filed under ${r.genre} / ${r.author}${r.series ? ' / ' + r.series : ''} / ${r.title}`
      + `${r.written ? `, and written into ${r.written} file(s)` : ''}.`);
    // the book is in the library now, so the columns and the counts have moved
    await Promise.all([loadGenres(), loadStats(), loadUntagged(), loadSkipped()]);
    $('#skippedList').click();
  });
  $('#fCancel').onclick = () => $('#fileIn').close();
  $('#fileIn').showModal();
}

async function loadBroken() {
  const items = await api('/api/broken').catch(() => []);
  $('#brokenCount').textContent = items.length || '0';
  return items;
}

async function validateAll() {
  await post('/api/validate', {});
  const p = await trackProgress('/api/validate/status', 'Reading every book…');
  p.bar.say(p.error
    ? 'The check stopped: ' + p.error
    : `Checked ${p.done} book(s): ${p.broken} with something wrong.`, !!p.error || !!p.broken);
  p.bar.done(p.broken ? 15000 : 4000);
  await loadBroken();
  if ($('#brokenList').classList.contains('active') || p.broken) $('#brokenList').click();
}

$('#validateAll').onclick = () => {
  if (!confirm('Open every file of every book?\n\nThis reads your whole collection, so on a large '
    + 'one it takes a long time — minutes, not seconds. You can keep listening while it runs.')) return;
  $('#settings').close();
  return work($('#validateAll'), 'The disk check', validateAll);
};

$('#brokenList').onclick = async () => {
  document.body.classList.add('maintenance');
  document.querySelectorAll('#genres li').forEach((el) => el.classList.remove('active'));
  $('#brokenList').classList.add('active');
  $('#authors ul').innerHTML = '';
  const items = await loadBroken();
  const header = `<div class="row pager">
      <span class="hint">${items.length
    ? `${items.length} book(s) the disk no longer backs up`
    : 'Nothing wrong with what was checked'}</span>
      <div class="spacer"></div><button id="bAgain" class="ghost">Check every book again</button>
    </div>`;
  $('#books .list').innerHTML = header + (items.length ? items.map((b) => `<div class="fix">
    <div>
      <strong>${esc(b.title)}</strong>
      <div class="sub">${esc(b.genre)} · ${esc(b.author)}</div>
      <div class="sub missing">${esc(WHY[b.reason] || b.reason)} — ${esc(b.detail)}</div>
      <div class="sub">${esc(b.path)}${b.onDisk ? '' : ' — not on disk'}</div>
    </div>
    <div class="actions">
      <button data-recheck="${b.id}">Check again</button>
      <button class="ghost danger" data-drop="${b.id}">${b.onDisk ? 'Delete…' : 'Forget it'}</button>
    </div>
  </div>`).join('')
    : '<div class="empty">Nothing here. <em>Check every book against the disk</em> in Settings '
      + 'looks for folders that are gone and files that cannot be read.</div>');

  $('#books #bAgain').onclick = () => work($('#books #bAgain'), 'The disk check', validateAll);
  $('#books .list').querySelectorAll('button[data-recheck]').forEach((b) => {
    b.onclick = () => work(b, 'The check', async () => {
      const r = await post(`/api/broken/${b.dataset.recheck}/recheck`, {}).catch((e) => ({ error: e.message }));
      if (r.error) return toast(r.error);
      toast(r.ok ? 'Nothing wrong with it now.' : `Still not right: ${r.detail}`);
      await loadBroken();
      $('#brokenList').click();
    });
  });
  $('#books .list').querySelectorAll('button[data-drop]').forEach((b) => {
    b.onclick = () => work(b, 'The delete', async () => {
      const onDisk = b.textContent.startsWith('Delete');
      if (!confirm(onDisk
        ? 'Move this book and its files to the trash?'
        : 'Forget this book? Its files are already gone, so only the library entry and the saved positions go.')) return;
      const r = await post(`/api/broken/${b.dataset.drop}/delete`, {}).catch((e) => ({ error: e.message }));
      if (r.error) return toast(r.error);
      toast(r.trashed ? 'Moved to the trash.' : `Forgotten: ${r.forgotten}`);
      await refreshLibrary();
      $('#brokenList').click();
    });
  });
};

// --- copies an import replaced -----------------------------------------
async function loadReplaced() {
  const items = await api('/api/replaced').catch(() => []);
  $('#replacedCount').textContent = items.length || '0';
  return items;
}

$('#replacedList').onclick = async () => {
  document.body.classList.add('maintenance');
  document.querySelectorAll('#genres li').forEach((el) => el.classList.remove('active'));
  $('#replacedList').classList.add('active');
  $('#authors ul').innerHTML = '';
  const items = await loadReplaced();
  if (!items.length) {
    $('#books .list').innerHTML = '<div class="empty">Nothing replaced. An import that replaces a book '
      + 'leaves the old copy here until you delete it.</div>';
    return;
  }
  $('#books .list').innerHTML = `<div class="row pager">
      <span class="hint">${items.length} older ${items.length === 1 ? 'copy' : 'copies'}, kept where they were and renamed</span>
      <div class="spacer"></div><button id="rAll" class="danger">Delete them all</button>
    </div>` + items.map((r) => `<div class="fix">
    <div>
      <strong>${esc(r.title)}</strong>
      <div class="sub">${esc(r.genre)} · ${esc(r.author)}${r.series ? ' · ' + esc(r.series) : ''}</div>
      <div class="sub">${r.files} file(s) · ${kb(r.bytes)} · ${esc(r.quality)} · replaced ${new Date(r.replaced_at).toLocaleString()}</div>
      <div class="sub">${esc(r.path)}${r.onDisk ? '' : ' — the folder is gone'}</div>
    </div>
    <div class="actions"><button class="danger" data-del="${r.id}">Delete now</button></div>
  </div>`).join('');
  $('#books .list').querySelectorAll('button[data-del]').forEach((b) => {
    b.onclick = () => work(b, 'The delete', async () => {
      if (!confirm('Delete this older copy and its files for good?')) return;
      try { await post(`/api/replaced/${b.dataset.del}`, {}); } catch (e) { return toast(e.message); }
      toast('Deleted.');
      $('#replacedList').click();
    });
  });
  const all = $('#books #rAll');
  if (all) all.onclick = () => work(all, 'The delete', async () => {
    if (!confirm(`Delete all ${items.length} replaced copies and their files for good?`)) return;
    try { await post('/api/replaced/all', {}); } catch (e) { return toast(e.message); }
    toast('Deleted.');
    $('#replacedList').click();
  });
};

// Everything the library counts feeds off the same data, so refresh it together.
// The shelves included: a book that just arrived belongs under Recently added.
const MAINTENANCE_ROWS = ['needsTags', 'brokenList', 'skippedList', 'importList', 'replacedList', 'trashList',
  // not maintenance, but a view of its own in the same column, and the same rule
  // holds: what is drawn again after a change is what was on screen
  'listenedList'];

// The view that is on screen, drawn again after something changed. A maintenance
// list is a view too: applying metadata to a book from Needs tags must put that
// list back, not throw you into the library or onto the shelves.
async function backToView() {
  const open = MAINTENANCE_ROWS.find((id) => $('#' + id).classList.contains('active'));
  if (open) return $('#' + open).click();
  if (state.series) return selectSeries(state.genre, state.series, null);
  if (state.author) return selectAuthor(state.author, null);
  return loadHome();
}

async function refreshLibrary() {
  await Promise.all([loadGenres(), loadStats(), loadUntagged(), loadTrash(),
    loadReplaced(), loadBroken(), loadSkipped(), loadListened(), importCountOnly()]);
  await backToView();
}

// --- move and delete ---------------------------------------------------
// Runs a file operation while the bar at the bottom follows it.
async function fileWork(url, body, label) {
  const until = { finished: false };
  const request = post(url, body).catch((e) => ({ error: e.message }))
    .then((r) => { until.finished = true; return r; });
  const p = await trackProgress('/api/files/status', label, until);
  const r = await request;
  const failure = r.error || p.error;
  p.bar.say(failure ? `${label} failed: ${failure}` : `${label} done.`, !!failure);
  p.bar.done(failure ? 15000 : 3000);
  return { ok: !failure, r, bar: p.bar };
}

window.moveBook = async function (id) {
  const b = await api(`/api/books/${id}`);
  const { genres } = await api('/api/import');
  $('#mGenre').innerHTML = genres.map((g) =>
    `<option${g === b.genre ? ' selected' : ''}>${esc(g)}</option>`).join('');
  $('#mAuthor').value = b.author || '';
  $('#mSeries').value = b.folderSeries || b.series || '';
  $('#mTitle').value = b.title || '';
  const preview = () => {
    const parts = [$('#mAuthor').value.trim(), $('#mSeries').value.trim(), $('#mTitle').value.trim()].filter(Boolean);
    $('#mWhere').textContent = `Moves to ${$('#mGenre').value} / ${parts.join(' / ')}`;
  };
  ['mGenre', 'mAuthor', 'mSeries', 'mTitle'].forEach((k) => { $('#' + k).oninput = preview; $('#' + k).onchange = preview; });
  preview();
  $('#doMove').onclick = async () => {
    $('#move').close();
    const body = {
      genre: $('#mGenre').value, author: $('#mAuthor').value.trim(),
      series: $('#mSeries').value.trim(), title: $('#mTitle').value.trim(),
    };
    const { ok } = await fileWork(`/api/move/${id}`, body, 'Move');
    if (ok) { await refreshLibrary(); openInLibrary(body.genre, body.author); }
  };
  $('#move').showModal();
};
$('#closeMove').onclick = () => $('#move').close();

window.trashBook = async function (id) {
  const b = await api(`/api/books/${id}`);
  if (!confirm(`Move “${b.title}” and its files to the trash?\n\nThey are kept for 30 days, `
    + 'and you can put them back or empty the trash yourself.')) return;
  const { ok } = await fileWork(`/api/trash/${id}`, {}, 'Delete');
  if (ok) await refreshLibrary();
};

// --- trash --------------------------------------------------------------
async function loadTrash() {
  const d = await api('/api/trash').catch(() => ({ items: [] }));
  $('#trashCount').textContent = d.items.length;
  return d;
}

$('#trashList').onclick = async () => {
  document.body.classList.add('maintenance');
  document.querySelectorAll('#genres li').forEach((e) => e.classList.remove('active'));
  $('#trashList').classList.add('active');
  $('#authors ul').innerHTML = '';
  const d = await loadTrash();
  if (!d.items.length) {
    $('#books .list').innerHTML = '<div class="empty">The trash is empty.</div>';
    return;
  }
  $('#books .list').innerHTML = `
    <div class="row" style="margin-bottom:4px">
      <button id="emptyTrash" class="danger">Empty trash (${d.items.length})</button>
      <span class="hint">Files are kept ${d.keepDays} days after deleting, then dropped on their own.</span>
    </div>
    ${d.items.map((t) => `<div class="fix">
      <div>
        <strong>${esc(t.title)}</strong>
        <div class="sub">${esc(t.genre)} · ${esc(t.author)}${t.series ? ' · ' + esc(t.series) : ''} · ${t.files} file(s)</div>
        <div class="sub">Deleted ${esc(t.deleted_at.slice(0, 16).replace('T', ' '))} ·
          ${t.onDisk ? `${t.daysLeft} day(s) left` : '<span class="missing">files already gone</span>'}</div>
      </div>
      <div class="actions">
        ${t.onDisk ? `<button data-restore="${t.id}">Put back</button>` : ''}
        <button class="ghost danger" data-purge="${t.id}">Delete now</button>
      </div>
    </div>`).join('')}`;
  $('#emptyTrash').onclick = () => work($('#emptyTrash'), 'Emptying the trash', async () => {
    if (!confirm(`Delete the files of all ${d.items.length} item(s) for good?`)) return;
    await post('/api/trash/empty', {}).catch((e) => toast(e.message));
    $('#trashList').click();
  });
  $('#books .list').querySelectorAll('button[data-restore]').forEach((b) => {
    b.onclick = () => work(b, 'Putting the book back', async () => {
      await fileWork(`/api/trash/${b.dataset.restore}/restore`, {}, 'Put back');
      await refreshLibrary();
      $('#trashList').click();
    });
  });
  $('#books .list').querySelectorAll('button[data-purge]').forEach((b) => {
    b.onclick = () => work(b, 'The delete', async () => {
      if (!confirm('Delete these files for good?')) return;
      await post(`/api/trash/${b.dataset.purge}/purge`, {}).catch((e) => toast(e.message));
      $('#trashList').click();
    });
  });
};

// --- maintenance: books whose files miss required tags -------------------
async function loadUntagged() {
  const list = await api('/api/untagged').catch(() => []);
  $('#needsTagsCount').textContent = list.length;
  return list;
}

$('#needsTags').onclick = async () => {
  document.body.classList.add('maintenance');
  document.querySelectorAll('#genres li').forEach((e) => e.classList.remove('active'));
  $('#needsTags').classList.add('active');
  $('#authors ul').innerHTML = '';
  $('#books .list').innerHTML = '<div class="empty">Checking the files…</div>';
  const list = await loadUntagged();
  if (!list.length) {
    $('#books .list').innerHTML = '<div class="empty">Every book carries all required tags.</div>';
    return;
  }
  const fixable = list.filter((b) => b.fixable.length);
  const lookup = list.filter((b) => b.needsLookup.length);
  $('#books .list').innerHTML = `
    <div class="row" style="margin-bottom:4px">
      <button id="tagFixable">Write into ${fixable.length} book(s)</button>
      <span class="hint">${lookup.length} book(s) also miss data this app does not have yet —
        use Find metadata on those.</span>
    </div>
    ${list.map((b) => `<div class="fix">
      <div>
        <strong>${esc(b.title)}</strong>
        <div class="sub">${esc(b.genre)} · ${esc(b.author)}</div>
        ${b.fixable.length ? `<div class="sub">Writing adds: ${esc(b.fixable.join(', '))}</div>` : ''}
        ${b.needsLookup.length ? `<div class="sub missing">Not known yet: ${esc(b.needsLookup.join(', '))}</div>` : ''}
      </div>
      <div class="actions">
        ${b.fixable.length ? `<button onclick="writeTags(${b.id}, this)">Write into MP3s</button>` : ''}
        <button class="ghost" onclick="findMeta(${b.id})">Find metadata</button>
      </div>
    </div>`).join('')}`;
  $('#tagFixable').onclick = () => {
    if (!confirm(`Write tags into ${fixable.length} book(s)?`)) return;
    work($('#tagFixable'), 'The tag write', () => writeMany(fixable), false).then(() => $('#needsTags').click());
  };
};

window.editMeta = async function (id) {
  const b = await api(`/api/books/${id}`);
  // where it sits on disk and how many files it is made of, at the foot of the dialog
  const files = (b.tracks || []).length;
  $('#ePath').textContent = `${b.path || ''} · ${files} file${files === 1 ? '' : 's'}`;
  $('#eTitle').value = b.title || '';
  $('#eAuthor').value = b.author || '';
  $('#eSeries').value = b.folderSeries || b.series || '';
  $('#eNarrator').value = b.narrator || '';
  $('#eYear').value = b.year || '';
  $('#eDescription').value = b.description || '';
  const wasSeries = $('#eSeries').value;
  const save = async (writeTags) => {
    const pick = {
      title: $('#eTitle').value.trim(), author: $('#eAuthor').value.trim(),
      narrator: $('#eNarrator').value.trim(), year: $('#eYear').value.trim(),
      description: $('#eDescription').value.trim(),
    };
    $('#edit').close();
    // The series is a folder level, so a change to it has to move the book, or
    // the next scan would read the old folders and undo it. The folder keeps its
    // own name: renaming that is what Move… is for.
    if ($('#eSeries').value.trim() !== wasSeries) {
      const { ok } = await fileWork(`/api/move/${id}`, {
        genre: b.genre, author: b.author, series: $('#eSeries').value.trim(),
        title: b.path.split(/[\\/]/).pop(),
      }, 'Move');
      if (!ok) return;
    }
    if (writeTags) {
      await writeWithProgress(id, pick);
    } else {
      try { await post(`/api/apply/${id}`, { pick, writeTags: false }); toast('Saved.'); }
      catch (e) { return toast(e.message); }
    }
    await refreshLibrary();
  };
  $('#saveEdit').onclick = () => save(false);
  $('#saveEditTags').onclick = () => save(true);
  $('#edit').showModal();
};
$('#closeEdit').onclick = () => $('#edit').close();

// Follows the lookup through its retry ladder while the request is in flight.
async function pollLookup(state_) {
  $('#lookupProgress').hidden = false;
  $('#lookupBar').style.width = '0';
  $('#lookupState').textContent = 'Contacting Google Books…';
  while (!state_.finished) {
    await new Promise((r) => setTimeout(r, 300));
    const p = await api('/api/lookup/status').catch(() => null);
    if (!p || state_.finished) break;
    $('#lookupBar').style.width = (p.attempt / p.attempts) * 100 + '%';
    $('#lookupState').textContent = p.retryIn
      ? `Google Books is busy — attempt ${p.attempt} of ${p.attempts} failed, retrying in ${p.retryIn}s`
      : `Attempt ${p.attempt} of ${p.attempts}…`;
  }
  $('#lookupProgress').hidden = true;
}

// The genre a book is filed under is a folder, so Google's categories are
// offered as a choice rather than applied: picking another one moves the book.
function genreChoice(i, current, suggested, known) {
  const options = suggested.filter((g) => g.toLowerCase() !== current.toLowerCase());
  if (!options.length) return '';
  return `<label>Genre</label>
    <select id="cg${i}">
      <option value="">${esc(current)} — keep</option>
      ${options.map((g) => `<option value="${esc(g)}">${esc(g)}${known.has(g.toLowerCase()) ? '' : ' — new folder'}</option>`).join('')}
    </select>
    <div class="hint">Another genre moves the book into that genre's folder, and writes it into the tags.</div>`;
}

// Two people wrote this book, and only one name can be the folder. So the pair
// is a choice about what goes into the files, and the folder is left alone.
function authorChoice(i, current, authors) {
  if (!authors || authors.length < 2) return '';
  const both = authors.join(', ');
  const options = [both, ...authors, current].filter((a, k, all) => a && all.indexOf(a) === k);
  return `<label>Author</label>
    <select id="ca${i}">
      ${options.map((a) => `<option value="${esc(a)}"${a === both ? ' selected' : ''}>${esc(a)}${a === current ? ' — as filed now' : ''}</option>`).join('')}
    </select>
    <div class="hint">${authors.length} authors are credited. What you pick goes into the artist and
      album artist tags; the author folder keeps its name.</div>`;
}

// Google has no series field, so the series is read out of the title and the
// subtitle: a guess, shown as one, and refusable. Ticked it names the series in
// the book and in its files; it never moves the book, which is a folder job.
function seriesChoice(i, book, c) {
  // no series, and why not: without this the dialog simply says nothing, and the
  // reason is on the server where Google was asked
  if (!c.series) return c.why ? `<div class="hint">No series: ${esc(c.why)}</div>` : '';
  const said = esc(c.series) + (c.seriesNo ? `, book ${c.seriesNo}` : '');
  const filed = book.series || book.tag_series || '';
  // a series Google keeps on another of its records of this book, not on this one
  const WHERE = {
    edition: 'another edition of this book',
    ebook: 'its ebook edition',
    record: 'another of its records of this book',
  };
  const borrowed = c.fromEdition ? `Google names it on ${esc(WHERE[c.fromEdition] || c.fromEdition)}. ` : '';
  return `<label class="pick"><input type="checkbox" id="cs${i}" checked> Series: <strong>${said}</strong></label>
    <div class="hint">${borrowed}${filed.toLowerCase() === c.series.toLowerCase()
      ? 'The series this book is already filed under.'
      : (filed ? `Filed under <em>${esc(filed)}</em> now. ` : '')
        + 'Goes into the book and into the tags. It does not move the book: a series folder is <em>Edit metadata</em>.'}</div>`;
}

window.findMeta = async function (id, query) {
  $('#lookupBody').innerHTML = '';
  const book = await api(`/api/books/${id}`);
  if (!$('#lookup').open) {
    $('#lookupQuery').value = [book.title, book.author].filter(Boolean).join(' ');
    $('#lookup').showModal();
  }
  const known = new Set((await api('/api/genrefolders').catch(() => ({ folders: [] })))
    .folders.map((g) => g.genre.toLowerCase()));
  $('#lookupSearch').onclick = () => findMeta(id, $('#lookupQuery').value.trim());
  const state_ = { finished: false };
  const poll = pollLookup(state_);
  try {
    const cands = await api(`/api/lookup/${id}` + (query ? '?q=' + encodeURIComponent(query) : ''));
    window._cands = cands;
    $('#lookupBody').innerHTML = cands.length ? cands.map((c, i) => `<div class="cand">
      ${c.thumbnail ? `<img src="${esc(c.thumbnail)}" alt="">` : ''}
      <div style="flex:1">
        <strong>${esc(c.title)}</strong>
        <div class="sub">${esc(c.author)}${c.year ? ' · ' + esc(c.year) : ''}</div>
        <div class="desc">${esc(c.description)}</div>
        ${authorChoice(i, book.author, c.authors || [])}
        ${seriesChoice(i, book, c)}
        ${genreChoice(i, book.genre, c.genres || [], known)}
        <div class="row">
          <button onclick="applyMeta(${id},${i},false)">Use metadata</button>
          <button class="ghost" onclick="applyMeta(${id},${i},true)">Use + write into MP3s</button>
        </div>
      </div></div>`).join('')
      : '<div class="empty">No match on Google Books. Adjust the search above and try again, or use <em>Edit metadata</em> to fill it in yourself.</div>';
  } catch (e) {
    $('#lookupBody').innerHTML = `<div class="empty">${e.message}</div>`;
  } finally {
    state_.finished = true;
    await poll;
  }
};

window.applyMeta = async function (id, i, writeTags) {
  const chosen = $(`#ca${i}`) ? $(`#ca${i}`).value : '';
  const keepSeries = $(`#cs${i}`) ? $(`#cs${i}`).checked : true;
  const pick = {
    ...window._cands[i],
    ...(chosen ? { author: chosen } : {}),
    ...(keepSeries ? {} : { series: '', seriesNo: 0 }),
  };
  const genre = $(`#cg${i}`) ? $(`#cg${i}`).value : '';
  $('#lookup').close();
  if (writeTags) {
    await writeWithProgress(id, pick, genre);
  } else {
    try { await post(`/api/apply/${id}`, { pick, genre, writeTags: false }); toast('Metadata applied.'); }
    catch (e) { return toast(e.message); }
  }
  // a genre change moves the book, and can add a genre folder to the left column
  if (genre) await loadGenres();
  await backToView();
};
$('#closeLookup').onclick = () => $('#lookup').close();

// --- settings ----------------------------------------------------------
let libs = [];
let libsAtOpen = '[]';
function renderLibs() {
  $('#libList').innerHTML = libs.map((l, i) =>
    `<li><span>${esc(l.path)}</span>
       <label class="asgenre" title="This folder is one genre, rather than a folder holding genre folders">
         <input type="checkbox" data-g="${i}"${l.asGenre ? ' checked' : ''}> Is a Genre
       </label>
       <button data-i="${i}">✕</button></li>`).join('') || '<li class="empty">None yet.</li>';
  $('#libList').querySelectorAll('input[data-g]').forEach((c) => {
    c.onchange = () => { libs[Number(c.dataset.g)].asGenre = c.checked; };
  });
  $('#libList').querySelectorAll('button[data-i]').forEach((b) => {
    b.onclick = () => { libs.splice(Number(b.dataset.i), 1); renderLibs(); };
  });
}
async function loadGenreFolders() {
  const d = await api('/api/genrefolders').catch(() => ({ folders: [], suggestedParent: '' }));
  $('#genreList').innerHTML = d.folders.length
    ? d.folders.map((g) => `<li><span>${esc(g.genre)}</span><span class="hint">${esc(g.path)}</span></li>`).join('')
    : '<li class="empty">None yet.</li>';
  if (!$('#genreParent').value) $('#genreParent').value = d.suggestedParent || '';
}

$('#addGenre').onclick = async () => {
  const name = $('#newGenre').value.trim();
  if (!name) return toast('Give the genre a name.');
  try {
    const r = await post('/api/genres', { name, parent: $('#genreParent').value.trim() });
    $('#newGenre').value = '';
    toast(r.existed ? `That folder was already there: ${r.dir}` : `Created ${r.dir}`);
    // a new genre folder can add a library entry, so read the settings back
    const s = await api('/api/settings');
    libs = s.libraries;
    libsAtOpen = JSON.stringify(libs);
    renderLibs();
    await loadGenreFolders();
  } catch (e) { toast(e.message); }
};

// The pulldown over the two kinds of settings. It closes itself whatever happens
// next — picking something, pressing Escape, or clicking anywhere else — or it
// would sit open over the page it just opened.
const settingsMenu = $('#settingsMenu');
const shutMenu = () => settingsMenu.removeAttribute('open');
document.addEventListener('click', (e) => {
  if (settingsMenu.open && !settingsMenu.contains(e.target)) shutMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && settingsMenu.open) shutMenu();
});
$('#openHa').onclick = () => { shutMenu(); location.href = '/ha'; };

$('#openSettings').onclick = async () => {
  shutMenu();
  const s = await api('/api/settings');
  libs = s.libraries;
  libsAtOpen = JSON.stringify(libs);
  $('#importPath').value = s.importPath || '';
  await showTagAll();
  renderLibs();
  await loadGenreFolders();
  $('#browser').hidden = true;
  $('#settings').showModal();
};
$('#addLib').onclick = () => {
  const p = $('#libPath').value.trim();
  if (p) { addLib(p); $('#libPath').value = ''; }
};
$('#closeSettings').onclick = () => $('#settings').close();
$('#saveSettings').onclick = async () => {
  await post('/api/settings', { libraries: libs, importPath: $('#importPath').value.trim() });
  $('#settings').close();
  toast('Settings saved.');
  await loadScanChoices();
  if (JSON.stringify(libs) !== libsAtOpen) work($('#scan'), 'The scan', startScan);
};

let browsePath = '/';
async function browse(p) {
  try {
    const d = await api('/api/browse?path=' + encodeURIComponent(p));
    browsePath = d.path;
    $('#browser').hidden = false;
    $('#browserPath').textContent = d.path;
    $('#browserList').innerHTML = d.entries.map((e) =>
      `<li><span data-p="${esc(e)}">📁 ${esc(e.split(/[\\/]/).pop())}</span>
       <button data-add="${esc(e)}">${libs.some((l) => l.path === e) ? '✓ added' : '+ Add'}</button></li>`).join('')
      || '<li class="empty">No sub-folders.</li>';
    $('#browserList').querySelectorAll('span[data-p]').forEach((s) => { s.onclick = () => browse(s.dataset.p); });
    $('#browserList').querySelectorAll('button[data-add]').forEach((b) => { b.onclick = () => addLib(b.dataset.add, b); });
    $('#browseUp').onclick = () => browse(d.parent);
  } catch (e) { toast(e.message); }
}
function addLib(p, btn) {
  if (!libs.some((l) => l.path === p)) { libs.push({ path: p, asGenre: false }); renderLibs(); }
  if (btn) btn.textContent = '✓ added';
}
$('#browseBtn').onclick = () => browse($('#libPath').value.trim() || '/');
$('#browsePick').onclick = () => addLib(browsePath);
$('#browseImportPick').onclick = () => { $('#importPath').value = browsePath; $('#browser').hidden = true; };
$('#browseImport').onclick = () => browse($('#importPath').value.trim() || '/');

// Drives the bar at the bottom from a {running, done, total, current} endpoint.
// `until` lets the caller stop as soon as its own request has returned; without
// it the bar follows the server's running flag.
// One bar per job, side by side. Jobs can overlap — a scan another browser
// started, a tag write here, the import folder being read in the background —
// and sharing one bar made each of them look like the others' progress.
function newBar(label) {
  const el = document.createElement('div');
  el.className = 'job';
  el.innerHTML = '<div class="track"><div class="fill"></div></div><span class="say"></span>';
  el.querySelector('.say').textContent = label;
  $('#progress').hidden = false;
  $('#progress').append(el);
  return {
    at(pct) { el.querySelector('.fill').style.width = pct + '%'; },
    say(text, warn) {
      el.querySelector('.say').textContent = text;
      el.querySelector('.say').classList.toggle('warn', !!warn);
    },
    done(ms = 3000) {
      setTimeout(() => {
        el.remove();
        if (!$('#progress').children.length) $('#progress').hidden = true;
      }, ms);
    },
  };
}

async function trackProgress(statusUrl, label, until) {
  const bar = newBar(label);
  let started = false;
  let waited = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, 300));
    const p = await api(statusUrl).catch(() => null);
    if (!p) return { error: 'lost contact with the server', bar };
    if (p.running) started = true;
    if (p.total) {
      bar.at((p.done / p.total) * 100);
      bar.say(`${label} ${p.done} / ${p.total} · ${p.current}`);
    }
    if (until ? until.finished : (started ? !p.running : (waited += 300) > 3000)) return { ...p, bar };
  }
}

async function loadScanChoices() {
  const s = await api('/api/settings').catch(() => ({ libraries: [] }));
  const libs = s.libraries || [];
  // each option says what pressing the button will do, closed or open
  $('#scanWhich').innerHTML = ['<option value="">Scan all libraries</option>']
    .concat(libs.map((l) => `<option value="${esc(l.path)}">Scan ${esc(l.path)}</option>`)).join('');
  $('#scanWhich').hidden = libs.length < 2;
}

async function startScan() {
  try {
    await post('/api/scan', { path: $('#scanWhich').value });
  } catch (e) { return finishScan(e.message); }
  const p = await trackProgress('/api/scan/status', 'Looking for books…');
  finishScan(p.error, p);
}

function finishScan(error, p) {
  if (error) {
    if (p && p.bar) { p.bar.say('Scan failed: ' + error, true); p.bar.done(15000); }
    else toast('Scan failed: ' + error);
    return;
  }
  // What it found, what it walked past, and anything odd about the folders — all
  // three, since a warning used to hide the rest
  const said = [`Scan complete: ${p.books} book(s).`];
  if (p.skipped) {
    said.push(`${p.skipped} folder(s) were not counted — see Not counted in the left column.`);
  }
  if (p.warning) said.push(p.warning);
  p.bar.say(said.join(' '), !!(p.warning || p.skipped));
  p.bar.done(p.warning || p.skipped ? 30000 : 3000);
  loadGenres();
  loadStats();
  // A scan re-reads what every file carries and drops books whose folders are
  // gone, so both maintenance counts are stale the moment it finishes — and so is
  // either list, if it is the one on screen.
  loadUntagged().then(() => { if ($('#needsTags').classList.contains('active')) $('#needsTags').click(); });
  loadBroken().then(() => { if ($('#brokenList').classList.contains('active')) $('#brokenList').click(); });
  loadSkipped().then(() => { if ($('#skippedList').classList.contains('active')) $('#skippedList').click(); });
}

for (const id of MAINTENANCE_ROWS) {
  $('#' + id).addEventListener('click', () => show('books'));
}

$('#scan').onclick = () => work($('#scan'), 'The scan', startScan);

// A name first: the whole point of the app is remembering where you were.
(async () => {
  // read the remembered name first: loadUsers falls back to the first name in
  // the list and writes that back, which would hide that this browser is new
  const remembered = localStorage.user || '';
  // this browser has been here before: say so, or the server would not know which
  // names are its own to offer
  if (remembered) await post('/api/users', { name: remembered }).catch(() => {});
  await loadPerm();
  const users = await loadUsers();
  await loadGenres();
  await Promise.all([loadScanChoices(), loadStats(), loadUntagged(), importCountOnly(), loadTrash(),
    loadReplaced(), loadBroken(), loadSkipped()]);
  await loadHome();
  if (!users.length || !users.includes(remembered)) await askWho(users, users.length > 0);
  // a scan another browser started is still running: follow it instead of
  // offering a button that would only be refused
  const tagging = await api('/api/tagall/status').catch(() => null);
  if (tagging && tagging.state === 'running') watchTagAll();
  const scanning = await api('/api/scan/status').catch(() => null);
  if (scanning && scanning.running) {
    work($('#scan'), 'The scan', async () => finishScan(null, await trackProgress('/api/scan/status', 'Looking for books…')));
  }
})();
