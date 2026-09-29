// The listening page: browse, play, keep your place. Nothing here changes the
// collection, so it is the page to share. The Admin button leads to the full one.
//
// What this page shows the same way the admin page does — the shelves, the
// tiles, the search, Listened, the cover menu — is in browse.js, which loads
// first. What is here is what only this page decides: its own shelves, its own
// cards, and the columns beside them.
const state = { user: localStorage.user || '', genre: null, author: null, book: null, track: 0 };

// --- admin button -------------------------------------------------------
// One way in for everybody now: the sign-in card asks for a name as well as a
// password, and the administrator's name is one of them. So this button only
// goes there — the page itself sends back anybody who is merely a listener.
//
// It starts hidden and `whoAmI()` shows it to the administrator alone. That is
// tidiness rather than a lock: what keeps a listener out of the admin page is
// the page asking the server and being refused, not this button being absent.
$('#toAdmin').onclick = () => location.assign('/admin');

// --- who is listening ---------------------------------------------------
// Who is listening is the session now, not a name picked from a list: the old
// picker and the "Who is listening?" dialog are gone with the open page they
// belonged to. account.js fills in the name and offers the way out.

// --- shelves ------------------------------------------------------------


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

async function openInLibrary(genre, author) {
  const gli = [...document.querySelectorAll('#genres li[data-name]')].find((l) => l.dataset.name === genre);
  await selectGenre(genre, gli);
  const ali = [...document.querySelectorAll('#authors li')].find((l) => l.dataset.name === author);
  await selectAuthor(author, ali);
}

// --- browsing -----------------------------------------------------------

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
  const r = await api(`/api/books?genre=${encodeURIComponent(genre)}&series=${encodeURIComponent(series)}`
    + `&user=${encodeURIComponent(state.user)}`);
  drawBooks(r.books, series, 'Series', r.series);
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
  const r = await api(`/api/books?genre=${encodeURIComponent(state.genre)}&author=${encodeURIComponent(author)}`
    + `&user=${encodeURIComponent(state.user)}`);
  drawBooks(r.books, '', 'Series', r.series);
}

// `states` is what /api/books says each series on the page is missing; the lists
// that do not come from there — Listened, a search — simply have none.
function drawBooks(books, heading, kind = 'Series', states = []) {
  // anything drawn here that is not a search result means the box no longer says
  // what is on screen
  if (kind !== 'Search') $('#q').value = '';
  const howComplete = (name) => {
    const s = states.find((x) => x.name === name);
    return s && s.says
      ? `<div class="series-gap${s.missing.length ? ' missing' : ''}">${esc(s.says)}</div>` : '';
  };
  let html = heading ? `<div class="series-head">${kind} · ${esc(heading)}</div>` + howComplete(heading) : '';
  let series = heading;
  for (const b of books) {
    const author = b.author;
    if (!heading && b.series !== series) {
      series = b.series;
      if (series) html += `<div class="series-head">Series · ${esc(series)}</div>` + howComplete(series);
    }
    html += `<div class="card" data-started="${b.started ? 1 : 0}">
      <div class="cover" data-glyph="▶">
        <img src="/api/cover/${b.id}?v=${b.coverV || 0}" alt="" loading="lazy" decoding="async"
          onclick="playBook(${b.id})" title="Play or pause">
        ${heart(b.id)}
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

// --- the search box -----------------------------------------------------
// --- the cover's own menu -----------------------------------------------
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

// Nothing is drawn until somebody is signed in, so this page does not start
// itself: `account.js` calls it once it knows who is asking. There is no name
// to pick any more — the session says who you are.
window.begin = async () => {
  await loadGenres();
  await loadStats();
  await loadHome();
};
