// The admin page: everything the listening page does, and everything that
// changes the collection — scanning, importing, tagging, filing, converting,
// deleting.
//
// The browsing half is in browse.js, which loads first and is the same file
// this page and the listening page both use. What is here is this page's own:
// the jobs, the dialogs, and the versions of drawBooks, loadHome, loadGenres
// and the column functions that know about editing.
const state = { user: localStorage.user || '', genre: null, author: null, book: null, track: 0 };

// --- which column is on screen -----------------------------------------
// A phone has room for one of the three columns at a time; this says which, and
// the stylesheet does the rest. A wide screen shows all three and ignores it.
// One step out of the book column: back to the authors of the genre being
// browsed, or to the genres themselves when there is no author on screen.
// Listened and Needs tags browse by author without a genre being chosen, so the
// column having rows is what says there is an author step to go back to.
const outOfBooks = () => (!document.body.classList.contains('maintenance')
  && (state.author || state.series || document.querySelector('#authors li')) ? 'authors' : 'genres');

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
// Who is listening is the session now: the picker and the "Who is listening?"
// dialog went with the open page they belonged to. account.js fills the name
// in and offers the way out.
$('#home').onclick = loadHome;
// --- the books you are done with ---------------------------------------

// --- landing view ------------------------------------------------------


// `{ refresh: true }`: coming back to these shelves — `homeOnScreen` in
// browse.js says why that clears nothing and may end up drawing nothing.
async function loadHome(opts) {
  const refresh = !!(opts && opts.refresh === true);
  if (!refresh) {
    loadListened();
    document.body.classList.remove('maintenance');
    $('#q').value = '';
    document.querySelectorAll('#genres li, #authors li').forEach((e) => e.classList.remove('active'));
    $('#authors ul').innerHTML = '';
  }
  const d = await api('/api/home?user=' + encodeURIComponent(state.user));
  if (refresh && !homeOnScreen()) return;
  // The book you are in the middle of, as the card it is everywhere else —
  // cover, series, year, how long, what it is about, and the one button. A tile
  // says the title and a sliver of progress; this is what you actually came
  // back for, so it is what the page opens with.
  const [carryOn, ...alsoGoing] = d.continue;
  const html = (carryOn ? cardFor(carryOn, false, 'carry-on') : '')
    + shelf('Continue listening', alsoGoing, true) + shelf('Recently added', d.recent, false);
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
  // the card has an author, a year and maybe a genre on it, like any other
  wireCardLinks();
}

async function openInLibrary(genre, author) {
  const gli = [...document.querySelectorAll('#genres ul li[data-name]')].find((l) => l.dataset.name === genre);
  await selectGenre(genre, gli);
  const ali = [...document.querySelectorAll('#authors li')].find((l) => l.dataset.name === author);
  await selectAuthor(author, ali);
}

// The same, and then to the book itself. A maintenance list names books by
// title, and the thing somebody wants next is usually the book: its cover, its
// description, the rest of what its author has. Without this the way there is to
// read the genre and author off the row and find them by hand in two columns.
//
// The card is marked rather than merely scrolled to, because an author with
// forty books lands the right one somewhere in a wall of identical cards. The
// mark takes itself off: it says "this is the one you asked for", which stops
// being true as soon as the page has been looked at.
async function jumpToBook(id, genre, author) {
  await openInLibrary(genre, author);
  const card = document.querySelector(`.card[data-id="${id}"]`);
  if (!card) return;                       // moved or deleted since the list was built
  card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  card.classList.add('found');
  setTimeout(() => card.classList.remove('found'), 2600);
}

// --- browsing ----------------------------------------------------------
async function loadGenres() {
  const list = await api('/api/genres');
  $('#genres ul').innerHTML = list.map((g) => {
    const has = (g.series || []).length;
    return `<li data-name="${esc(g.name)}">
      <span class="who">${has ? '<span class="twist">▸</span>' : ''}${esc(g.name)}</span>
      <span class="count">${g.books}</span></li>`
      + seriesRows(g);
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
  $('#genres ul').querySelectorAll('li[data-whole]').forEach((li) => {
    li.onclick = () => selectWholeSeries(li.dataset.genre, li.dataset.whole, li);
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
  const r = await api(`/api/books?genre=${encodeURIComponent(genre)}&series=${encodeURIComponent(series)}`
    + `&user=${encodeURIComponent(state.user)}`);
  await drawBooks(r.books, series, 'Series', r.series);
}

// A whole series, parts and all, for an author who writes in them. The pane is
// drawn by `drawBooks`, which already puts a heading above each run of books
// that share a series — so the parts arrive as parts without anything new being
// taught to it, in the order the parent names them.
async function selectWholeSeries(genre, parent, li) {
  document.body.classList.remove('maintenance');
  state.genre = genre;
  state.series = '';
  state.author = null;
  document.querySelectorAll('#genres li, #authors li').forEach((e) => e.classList.remove('active'));
  const row = li || [...document.querySelectorAll('#genres li[data-whole]')]
    .find((l) => l.dataset.genre === genre && l.dataset.whole === parent);
  if (row) row.classList.add('active');
  const authors = await api('/api/authors?genre=' + encodeURIComponent(genre));
  $('#authors ul').innerHTML = authors.map((a) =>
    `<li data-name="${esc(a.name)}"><span>${esc(a.name)}</span><span class="count">${a.books}</span></li>`).join('');
  $('#authors ul').querySelectorAll('li').forEach((el) => { el.onclick = () => selectAuthor(el.dataset.name, el); });
  const r = await api(`/api/books?genre=${encodeURIComponent(genre)}&parent=${encodeURIComponent(parent)}`
    + `&user=${encodeURIComponent(state.user)}`);
  // No heading of its own: given one, drawBooks draws that instead of a head per
  // series, and a head per part is the whole point of reading a series this way.
  await drawBooks(r.books, '', 'Series', r.series);
}

async function selectAuthor(author, li) {
  state.author = author;
  state.series = '';
  document.querySelectorAll('#authors li').forEach((e) => e.classList.remove('active'));
  document.querySelectorAll('#genres li[data-series]').forEach((e) => e.classList.remove('active'));
  const row = li || [...document.querySelectorAll('#authors li')].find((l) => l.dataset.name === author);
  if (row) row.classList.add('active');
  const r = await api(`/api/books?genre=${encodeURIComponent(state.genre)}&author=${encodeURIComponent(author)}`
    + `&user=${encodeURIComponent(state.user)}`);
  await drawBooks(r.books, '', 'Series', r.series);
  authorHead(state.genre, author, r.books.length);
}

// `states` is what /api/books says each series on the page is missing; the lists
// that do not come from there — Listened, a search — simply have none.
// One book, as a card. Lifted out of `drawBooks` so the home page can draw the
// book you are in the middle of with the same template rather than a second
// copy of it — a card that said something subtly different from every other
// card would be a thing to keep in step for ever.
const cardFor = (b, apart = false, extra = '') => `<div class="card${apart ? ' apart' : ''}${extra ? ` ${extra}` : ''}" data-id="${b.id}" data-started="${b.started ? 1 : 0}">
      <div class="cover" data-glyph="▶">
        <img src="/api/cover/${b.id}?v=${b.coverV || 0}" alt="" loading="lazy" decoding="async"
          onclick="playBook(${b.id})" title="Play or pause">
        ${heart(b.id)}
        <label class="listened">
          <input type="checkbox" ${b.done ? 'checked' : ''} onchange="setListened(${b.id}, this)"> Listened
        </label>
        <!-- Listened is this listener's; Unabridged is the book's, so only the
             admin page offers it. Off means nobody has said so, not "abridged". -->
        <label class="listened unabridged"
          title="The whole book, not a shortened reading of it. Nothing in the files says this, so it is yours to state.">
          <input type="checkbox" ${b.unabridged ? 'checked' : ''} onchange="setUnabridged(${b.id}, this)"> Unabridged
        </label>
      </div>
      <div>
        <h3><span class="note ${b.done ? 'done' : b.started ? 'part' : 'new'}"
              title="${b.done ? 'Listened' : b.started ? 'Partly listened' : 'Not listened yet'}">&#9835;</span>
          ${esc(b.title)}</h3>
        <div class="sub">${byLine(b)}</div>
        ${seriesLine(b)}
        <div class="sub" style="margin-top:6px">
          ${genreBadge(b)}
          ${yearBadge(b)}
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

async function drawBooks(books, heading, kind = 'Series', states = []) {
  // anything drawn here that is not a search result means the box no longer says
  // what is on screen
  if (kind !== 'Search') $('#q').value = '';
  const howComplete = (name) => {
    const s = states.find((x) => x.name === name);
    return s && s.says
      ? `<div class="series-gap${s.missing.length ? ' missing' : ''}">${esc(s.says)}</div>` : '';
  };
  let html = heading ? `<div class="series-head">${kind} · ${esc(heading)}</div>` + howComplete(heading) : '';
  let series = heading || '';
  // A run of books in no series gets no heading of its own, so nothing marks
  // where the series above it stopped and the cards run together — which is how
  // a standalone book came to read as the next volume of the series above it.
  // A heading separates one run from the next; where there is no heading, this
  // does.
  let apart = false;
  for (const b of books) {
    const author = b.author;
    apart = false;
    if (!heading && (b.series || '') !== series) {
      series = b.series || '';
      // A part names the series it is part of, so a whole series read in one
      // view says which movement each run of books belongs to.
      if (series) {
        html += `<div class="series-head">Series · ${b.parent ? `${esc(b.parent)} · ` : ''}${esc(series)}</div>`
          + howComplete(series);
      } else {
        apart = true;
      }
    }
    html += cardFor(b, apart);
  }
  $('#books .list').innerHTML = html || '<div class="empty">No books.</div>';
  markPlaying();
  // the author, the year and the genre on each card are each a way somewhere
  wireCardLinks();
  show('books');
}


// --- the search box -----------------------------------------------------
// --- the cover's own menu -----------------------------------------------
const showCoverMenu = (book, x, y) => {
  $('#cmTitle').textContent = book.title || 'This book';
  const done = coverMenu.querySelector('[data-act="listened"]');
  if (done) done.textContent = doneNow(book.id) ? '☐ Mark as not listened' : '☑ Mark as listened';
  // converting says nothing about a book that is already MP3
  $('#cmConvert').hidden = !(state.convertible || []).some((b) => b.id === book.id);
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

// only on the books it means something for, which the Needs converting list knows
onMenu('convert', async () => {
  const id = Number(coverMenu.dataset.id);
  hideCoverMenu();
  // asked again here rather than trusted from page load: the answer to that one
  // is kept for the life of the page, and a container that restarted in the
  // meantime would go on being reported as one that cannot convert
  await loadConvertible();
  if (!state.convertTools) return toast(state.convertWhy);
  if (!confirm('Convert this book to MP3? Each chapter becomes a track, and the files it came from '
    + 'are kept under Converted.')) return;
  runConvert(id);
});
onMenu('edit', () => { const id = Number(coverMenu.dataset.id); hideCoverMenu(); editMeta(id); });
onMenu('find', () => { const id = Number(coverMenu.dataset.id); hideCoverMenu(); findMeta(id); });

// --- metadata lookup ---------------------------------------------------
// The book's own, not a listener's: it changes the collection, so only this page
// offers it and only the admin may post it. The box says so at once and the
// server decides, putting it back if it disagrees — the same way a heart does.
window.setUnabridged = async function (id, box) {
  const on = box.checked;
  try {
    await post(`/api/books/${id}/unabridged`, { on });
  } catch (e) {
    box.checked = !on;
    toast(e.message);
  }
};

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
  // `why` is the case where nothing threw and the files still were not written:
  // the answer carries it, because the bar may have stopped polling before the
  // progress object learned of it
  //
  // The request that did the work decides. `p.error` is only ever a complaint
  // about *following* it — and it used to come first, so a write that finished
  // perfectly was reported as "Writing tags failed: lost contact with the
  // server" because one status poll out of hundreds went unanswered. It is read
  // now only when the request itself came back with nothing to say.
  const failure = r.error || r.why || (r.written === undefined ? p.error : '');
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
  // A run that failed on books says how many and what the last one said. "Thirty
  // failed" on its own sends the reader through thirty books by hand.
  const wrong = s.failed
    ? ` ${s.failed} book(s) could not be written${s.lastFailure ? ` — the last was ${s.lastFailure}` : ''}.`
    : '';
  if (s.state === 'running') return `Writing tags: ${s.done} of ${s.total} book(s) done, ${s.left} to go. Now: ${s.current}`;
  if (s.state === 'paused') return `Stopped at ${s.done} of ${s.total} book(s) — ${s.left} still to go. Start again to carry on.${wrong}`;
  if (s.state === 'done') return `Last run: ${s.written} file(s) tagged in ${s.done} book(s).${wrong}`;
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
//
// And what to do about it, on the row (2.14.112). A library or the import folder
// that is there gets *Fix*: its owner and modes put right all the way down. A
// library that is not there any more gets *Forget*, which takes it off the list
// — it is never taken off by itself, since a share not mounted for a moment
// would lose every library on it.
const permAction = (p) => {
  if (p.what !== 'Library' && p.what !== 'Import folder') return '';
  if (p.exists) {
    return `<button class="ghost perm-fix" data-fix="${esc(p.path)}"
      title="Give everything under this folder to the right owner, with the right modes">Fix</button>`;
  }
  return p.what === 'Library' && p.why === 'not there'
    ? `<button class="ghost perm-forget" data-forget="${esc(p.path)}"
        title="This folder is gone: take it off the list of libraries">Forget</button>`
    : '';
};
$('#permsOut').addEventListener('click', async (e) => {
  const fix = e.target.closest('[data-fix]');
  const forget = e.target.closest('[data-forget]');
  if (fix) {
    const where = fix.dataset.fix;
    if (!confirm(`Put the owner and modes right for everything in\n${where}?\n\nNothing is moved or deleted.`)) return;
    await work(fix, 'Putting permissions right', async () => {
      const r = await post('/api/permissions/fix', { path: where }).catch((x) => ({ error: x.message }));
      if (r.error) return toast(r.error);
      toast(`${r.changed} of ${r.folders + r.files} put right in ${where}`
        + (r.owner ? ` — now ${r.owner}, ${r.modes.dir}/${r.modes.file}` : '')
        + (r.failed ? `. ${r.failed} could not be: ${r.firstFailures[0]}` : '.'));
      return $('#checkPerms').onclick();
    }, false);
  } else if (forget) {
    const where = forget.dataset.forget;
    const r = await post('/api/permissions/forget', { path: where }).catch((x) => ({ error: x.message }));
    if (r.error) return toast(r.error);
    toast(`${where} is no longer a library.`);
    await $('#checkPerms').onclick();
  }
  return undefined;
});

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
      <td>${permAction(p)}</td>
    </tr>`).join('');
  $('#permsOut').innerHTML = `<p class="hint">${esc(said)}</p>
    <table class="cmp"><tr><th>What</th><th>Where</th><th>Owner · mode</th><th></th><th></th></tr>${rows}</table>`;
};

// Home Assistant has a page of its own: an address, a token and media players are
// more than a dialog section can hold.
$('#toHa').onclick = () => { location.href = '/ha'; };

// --- accounts -------------------------------------------------------------
// Who may listen, who has asked to, and what each of them has done with it.
// A request is the only thing here that needs deciding, so the count beside the
// row is the number of those and not the number of accounts: a count that never
// changes is a count nobody reads.
async function loadAccounts() {
  const d = await api('/api/accounts').catch(() => ({ accounts: [] }));
  state.accounts = d.accounts;
  state.adminName = d.admin;
  const waiting = d.accounts.filter((a) => a.state === 'pending').length;
  counts('accountList', waiting);
  $('#accountList').classList.toggle('wants', !!waiting);
  return d;
}

// --- books somebody has asked for -----------------------------------------
// The count is the open ones, for the same reason the accounts row counts the
// pending: those are the ones that need something doing. A request that has
// been answered or turned down is history, and history does not want a number
// in a column.
async function loadRequests() {
  const d = await api('/api/requests').catch(() => ({ requests: [], open: 0 }));
  state.requests = d.requests;
  counts('requestList', d.open);
  $('#requestList').classList.toggle('wants', !!d.open);
  return d;
}

const askedWhen = (iso) => (iso ? new Date(iso).toLocaleDateString() : '');

// One row per request. The open ones carry what can be done about them; the
// settled ones carry what was done, because "you turned this down in March, and
// this is what you said" is the question somebody asks later.
const requestRow = (r) => `<div class="fix" data-request="${r.id}">
    <div>
      <strong>${esc(r.title)}</strong>
      <div class="sub">${esc(r.author)} · asked by ${esc(r.who)}${r.asked_at ? ` · ${esc(askedWhen(r.asked_at))}` : ''}</div>
      ${r.note ? `<div class="sub">“${esc(r.note)}”</div>` : ''}
      ${r.state === 'filled' ? `<div class="sub"><span class="badge tagged">Here${r.bookTitle ? ` · ${esc(r.bookTitle)}` : ''}</span></div>` : ''}
      ${r.state === 'declined' ? `<div class="sub"><span class="badge untagged">Turned down</span> ${esc(r.said || '')}</div>` : ''}
    </div>
    <div class="actions">
      <!-- First, because it is the first thing done with a request: take the
           words and go and look. The same "author - title" the Series to
           complete pane copies, and the same handler: the one on #books
           catches every .copy-search inside it, so this needed no second one.
           (No backticks in this comment — it lives in a template literal.) -->
      <button class="ghost copy-search" data-copy-text="${esc([r.author, r.title].filter(Boolean).join(' - '))}"
        title="Copy “${esc([r.author, r.title].filter(Boolean).join(' - '))}” to search for it">⧉ Copy</button>
      ${r.state === 'open' ? `
      <button class="ghost" data-act="link">It is here now…</button>
      <button class="ghost" data-act="decline">Not this one…</button>` : `
      <button class="ghost danger" data-act="forget">Forget</button>`}
    </div>
  </div>`;

async function showRequests() {
  document.body.classList.add('maintenance');
  document.querySelectorAll('#genres li, #authors li').forEach((e) => e.classList.remove('active'));
  $('#requestList').classList.add('active');
  const d = await loadRequests();
  const rows = d.requests || [];
  $('#books .list').innerHTML = `<div class="series-head">Requests · ${d.open} waiting</div>`
    + (rows.length ? rows.map(requestRow).join('')
      : '<div class="empty">Nobody has asked for anything yet.</div>');
  show('books');

  $('#books .list').querySelectorAll('[data-request]').forEach((row) => {
    const id = Number(row.dataset.request);
    const act = (name) => row.querySelector(`[data-act="${name}"]`);
    if (act('decline')) {
      act('decline').onclick = async () => {
        const said = prompt('Why not? The person who asked will be told this.');
        if (said === null) return;
        await post(`/api/requests/${id}/decline`, { said }).catch((e) => toast(e.message));
        showRequests();
      };
    }
    if (act('link')) {
      // By hand, for what the normalised match will not catch. The book is
      // named rather than picked from a list of eleven hundred: the admin has
      // just put it there and knows what it is called.
      act('link').onclick = async () => {
        const name = prompt('Which book? Type enough of its title to find it.');
        if (!name) return;
        const found = await api(`/api/search?q=${encodeURIComponent(name)}`).catch(() => []);
        if (!found.length) return toast('No book here by that name.');
        const pick = found.length === 1 ? found[0]
          : found.find((b) => confirm(`Is it “${b.title}” by ${b.author}?`));
        if (!pick) return toast('Left as it was.');
        await post(`/api/requests/${id}/link`, { bookId: pick.id }).catch((e) => toast(e.message));
        return showRequests();
      };
    }
    if (act('forget')) {
      act('forget').onclick = async () => {
        if (!confirm('Forget this request? It leaves their statistics too.')) return;
        await post(`/api/requests/${id}/forget`, {}).catch((e) => toast(e.message));
        showRequests();
      };
    }
  });
}

$('#requestList').onclick = showRequests;

// The accounts themselves live on a page of their own now (`accounts.js`): a
// row per person with numbers on it wants width and stillness, and the column
// beside a library is neither. This row is the way there, and it keeps the
// count because that is the one thing worth seeing without going to look.
$('#accountList').onclick = () => { location.href = '/accounts'; };

// --- is there a newer version ---------------------------------------------
// The version in the line of numbers answers "is this the new one?" only for
// somebody who already knows what the new one is. This says it outright, and
// where it can be taken from here, offers to.
//
// `ask` is the button: without it the server answers from what it last heard,
// since GitHub allows sixty questions an hour and the answer changes weekly.
const HOW_TO_UPDATE = {
  image: 'This is the Docker image. Updating it is pulling a new one — on Unraid, '
    + '<em>Force update</em> in the Docker tab; with compose, <code>docker compose pull &amp;&amp; '
    + 'docker compose up -d</code>. Nothing here could do that for you.',
  folder: 'This is a checkout without the updater beside it. From a shell in the container: '
    + '<code>cd /opt/my-audiobook-collection &amp;&amp; git fetch --tags &amp;&amp; '
    + 'git checkout "$(git tag --sort=-v:refname | head -1)" &amp;&amp; npm ci --omit=dev</code>, '
    + 'then restart it.',
  lxc: 'Installing it stops the app for a moment and starts it again on the new version. '
    + 'Your database, settings and audiobooks are not touched. '
    + 'The same thing from a shell: <code>my-audiobook-collection-update</code>.',
};

// A red dot on the icon, and the way to act on it in the pulldown. Both say the
// same thing and both are drawn from the same answer: there is a newer version,
// and this install can take it. Settings is three clicks away and nobody opens
// it to find out whether there is news, so the news comes to the page instead.
// The menu entry is removed again the moment there is nothing to install — once
// the update has run, the next answer says so and takes it away.
function showUpdate(u) {
  const behind = !!(u && u.behind);
  $('#updateDot').hidden = !behind;
  $('#updateDot').title = behind ? `Update available: v${u.newest}` : '';
  $('#installUpdate').hidden = !(behind && u.canInstall);
}

// What the dot knows on a fresh page. The answer is the server's cached one —
// GitHub is asked at most once an hour however many browsers load the page —
// and a listener never sees it, since the route is the admin's.
async function updateMark() {
  if (perm.required && !perm.admin) return;
  const u = await api('/api/update').catch(() => null);
  if (u) showUpdate(u);
}

async function loadUpdate(ask) {
  $('#updateState').textContent = ask ? 'Asking GitHub…' : 'Looking…';
  const u = await api(`/api/update${ask ? '?ask=1' : ''}`).catch((e) => ({ error: e.message }));
  showUpdate(u);
  const last = u.last;
  // The update restarts the app, so the page that asked for it never hears how
  // it went — the updater leaves word behind instead, and this is where it is
  // read. Only worth saying when it failed, or when it is news.
  const said = last && last.said ? `<br><span class="warn">Last update: ${esc(last.said)}</span>` : '';

  if (u.error && !u.newest) {
    $('#updateState').innerHTML = `Running <strong>v${esc(u.running || '')}</strong>. `
      + `Could not ask GitHub: ${esc(u.error)}.${said}`;
    $('#updateNow').hidden = true;
    $('#updateHow').innerHTML = '';
    return;
  }
  if (u.behind) {
    $('#updateState').innerHTML = `Running <strong>v${esc(u.running)}</strong> — `
      + `<strong class="warn">v${esc(u.newest)} is out</strong>.${said}`;
    $('#updateNow').hidden = !u.canInstall;
  } else {
    $('#updateState').innerHTML = `Running <strong>v${esc(u.running)}</strong>, `
      + `<strong class="ok">the newest there is</strong>.${said}`;
    $('#updateNow').hidden = true;
  }
  $('#updateHow').innerHTML = HOW_TO_UPDATE[u.how] || '';
}

$('#updateCheck').onclick = () => work($('#updateCheck'), 'Asking GitHub', () => loadUpdate(true), false);

// Asking for the update, from the button in Settings or from the pulldown. The
// same thing either way, so it is written once.
const askForUpdate = (button) => work(button, 'Updating', async () => {
  if (!confirm('Install the newer version?\n\nThe app stops for a moment and comes back on it. '
    + 'Your database, settings and audiobooks are not touched.')) return null;
  const was = await version();
  const r = await post('/api/update', {}).catch((e) => ({ error: e.message }));
  if (r.error) return `It could not: ${r.error}`;
  // From here the app is being stopped and started under us, so there is no
  // answer coming: say what will happen and let the page find out by watching.
  say('<strong>Updating…</strong> the app stops for a moment. '
    + 'This page reloads when it is back on the new version.');
  waitForItBack(was, r.at);
  return 'Asked. It restarts on its own.';
}, false);

$('#updateNow').onclick = () => askForUpdate($('#updateNow'));
$('#installUpdate').onclick = () => { shutMenu(); askForUpdate(null); };

// Updating takes minutes and the page it was started from is usually shut by
// then, so what it has to say is said in two places: the line in Settings, and a
// toast, which is on the screen wherever the reader is.
function say(html, loud = false) {
  const line = $('#updateState');
  if (line) line.innerHTML = html;
  if (loud) toast(html.replace(/<[^>]+>/g, ''));
}

const version = () => fetch('/api/stats')
  .then((r) => (r.ok ? r.json() : null)).then((d) => (d && d.version) || '').catch(() => '');

// Wait for the app to come back **on a different version**, then reload so the
// page is the new version's own.
//
// "It answers" was the old signal, and it is not one: nothing has stopped yet
// when the button is pressed — the app only writes a file, and the path unit has
// to notice it, stop the service, fetch and run `npm ci` — so the app answers
// happily for the next half minute and the page reloaded itself into the old
// version straight away. Worse, when it never came back the poll ran out after
// four minutes in silence, leaving "Updating…" on the screen for ever with
// nothing to say whether it had worked. The version is the one honest signal:
// it changes exactly when the new code is running.
//
// And a bar while it waits, with the step the updater is on (2.14.96). It used
// to say "Updating…" in the line in Settings and nothing else — and pressed from
// the pulldown, Settings is shut, so there was nothing on screen at all while
// the container worked for minutes. The bar is the one every long job uses, at
// the foot of the page wherever the reader is. For two of the steps the app is
// down and cannot be asked; the bar says that, rather than calling it a failure.
const updateSteps = (p) => (p && p.of ? `Step ${Math.min(p.step, p.of)} of ${p.of}: ${p.doing}` : '');
function waitForItBack(was, askedAt = '') {
  const bar = newBar('Updating: waiting for the updater to start');
  bar.at(2);
  let tries = 0;
  let last = null;
  const stop = (ms) => { clearInterval(look); bar.done(ms); };
  const look = setInterval(async () => {
    tries += 1;
    let refused = false;
    const r = await fetch('/api/update/progress')
      .then((x) => {
        // Answered, but not to this page: the app is up and this page is no
        // longer signed in. That was taken for "still restarting" and waited on
        // for ever (2.14.120) — the app answers a 401 the moment it is back.
        refused = x.status === 401 || x.status === 403;
        return x.ok ? x.json() : null;
      }).catch(() => null);
    if (refused) {
      bar.at(100);
      bar.say('The app is back, but this page is no longer signed in. Reload it to sign in and see the version.', true);
      say('<strong class="warn">The app is back, but this page is no longer signed in.</strong> '
        + 'Reload it to sign in; the version line says whether the update took.', true);
      stop(30000);
      return;
    }
    const now = r ? r.running : '';
    if (now && was && now !== was) {
      bar.at(100);
      bar.say(`Updated to v${now}. Reloading…`);
      stop(1500);
      // The reload throws this message away with the page, so the news is left
      // where the new page will find it and said there instead.
      try { sessionStorage.setItem('updated-to', now); } catch { /* private window */ }
      say(`<strong class="ok">Updated to v${esc(now)}.</strong> Reloading…`, true);
      setTimeout(() => location.reload(), 1200);
      return;
    }
    // What the updater has said, if it is about this run and not a past one. As
    // times, not as text: the script writes local time with an offset and the
    // app writes UTC, and the two compared as strings are hours apart.
    const fresh = (q) => q && (q.step === 0 || !askedAt
      || Date.parse(q.at) >= Date.parse(askedAt) - 2000);
    if (r && fresh(r.progress)) last = r.progress;
    const p = last;
    if (p && p.done) {
      // finished without the version changing: already the newest, or it failed
      bar.at(100);
      if (p.ok) {
        bar.say(p.said ? `Nothing to install: ${p.said}.` : 'Finished.');
        say(`<strong class="ok">Nothing to install</strong> — ${esc(p.said || 'already the newest')}.`, true);
      } else {
        bar.say(`The update failed: ${p.said || 'see journalctl -u my-audiobook-collection-update'}`, true);
        say(`<strong class="warn">The update failed:</strong> ${esc(p.said || '')} — <code>journalctl -u `
          + 'my-audiobook-collection-update</code> in the container says more.', true);
      }
      stop(p.ok ? 6000 : 20000);
      return;
    }
    // The request picked up but no step written: an updater installed before
    // 2.14.96 says nothing while it works. It is working, though, and that much
    // can be said — the request file is gone the moment it starts.
    if (r && p && p.step === 0 && r.asked === false) {
      bar.at(10);
      bar.say('Updating: the updater is working on it — the bar shows its steps from the next update on');
    } else if (p && p.of) {
      bar.at(Math.max(2, Math.round((p.step / p.of) * 100)));
      bar.say(r ? `Updating: ${updateSteps(p)}`
        : `Updating: ${updateSteps(p)} — the app is restarting, so this waits for it`);
    } else if (!r) {
      bar.say('Updating: the app is restarting, so this waits for it');
    }
    if (tries > 300) { // ten minutes, then stop pretending to watch
      bar.say('It is taking longer than it should. Reload the page to look again.', true);
      stop(20000);
      say('<strong class="warn">It is taking longer than it should.</strong> The app is still on '
        + `v${esc(was)}. Reload the page to look again; <code>journalctl -u `
        + 'my-audiobook-collection-update</code> in the container says what happened.', true);
    }
  }, 2000);
}

// And on the page that comes up afterwards: the update ran, this is the version
// it ran to, and nothing else would have said so.
function sayIfUpdated() {
  let to = '';
  try { to = sessionStorage.getItem('updated-to') || ''; sessionStorage.removeItem('updated-to'); } catch { /* private window */ }
  if (to) toast(`Updated to v${to}.`);
}

// --- the database's own copies --------------------------------------------
// Said out loud, because a backup that fails quietly is believed for months and
// then is not there. The newest one's date is the whole of the answer.
async function loadBackups() {
  const d = await api('/api/backups').catch(() => ({ items: [] }));
  const items = d.items || [];
  const newest = items[items.length - 1];
  const kB = (n) => `${Math.max(1, Math.round(n / 1024)).toLocaleString()} kB`;
  $('#backupState').innerHTML = newest
    ? `<strong class="ok">Last copy ${esc(new Date(newest.at).toLocaleString())}</strong>, `
      + `${kB(newest.bytes)} — ${items.length} kept of ${d.keep}, in <code>${esc(d.folder)}</code>.`
    : '<strong class="warn">No copy yet.</strong> One is taken when the app starts and once a day '
      + 'after that; if this stays empty, the server log says why.';
}

$('#backupNow').onclick = () => work($('#backupNow'), 'Backing up', async () => {
  const r = await post('/api/backups', {});
  await loadBackups();
  return r.error ? `It could not: ${r.error}` : `Copied to ${r.name}.`;
});

// --- telling Discord ------------------------------------------------------
async function loadHook() {
  const d = await api('/api/notify').catch(() => ({ set: false, last: {} }));
  const last = d.last || {};
  $('#hookState').innerHTML = d.set
    ? `<strong class="ok">A webhook is saved.</strong> ${last.error
      ? `<span class="missing">The last line failed: ${esc(last.error)}</span>`
      : last.at ? `Last line sent ${esc(new Date(last.at).toLocaleString())} (${last.sent} in all).`
        : 'Nothing sent yet.'}`
    : '<strong class="warn">No webhook saved.</strong> Nothing is sent anywhere.';
}

$('#hookSave').onclick = () => work($('#hookSave'), 'Saving the webhook', async () => {
  const url = $('#hookUrl').value.trim();
  if (!url) return toast('Paste the webhook address first.');
  try { await post('/api/notify', { webhook: url }); } catch (e) { return toast(e.message); }
  $('#hookUrl').value = '';
  toast('Saved. It is never shown back to this page.');
  return loadHook();
});

$('#hookTest').onclick = () => work($('#hookTest'), 'The test line', async () => {
  try { await post('/api/notify/test', {}); } catch (e) { return toast(e.message); }
  await loadHook();
  return toast('Sent — look in the channel.');
});

$('#hookForget').onclick = () => work($('#hookForget'), 'Forgetting the webhook', async () => {
  if (!confirm('Forget the webhook? Nothing will be sent anywhere until a new one is saved.')) return undefined;
  await post('/api/notify', { webhook: '-' }).catch((e) => toast(e.message));
  toast('Forgotten.');
  return loadHook();
});

// --- Series to complete -------------------------------------------------
// Two questions in one list, and they are answered by different things. What is
// missing *between* the volumes you have is counted from your own numbers, free
// and certain. Whether a volume exists that you do not have is nothing this app
// can know, so Wikidata is asked — one series at a time, on the server, with a
// bar, because it is network work over the whole collection.
function onlineWords(s) {
  if (s.running) return `Asking Wikidata: ${s.done} of ${s.total} series. Now: ${s.current}`;
  if (s.error) return `The check stopped: ${s.error}`;
  if (!s.total) return 'Not asked yet.';
  return `Asked about ${s.total} series; Wikidata knew ${s.found}.`;
}

// A volume that is not here, as one line.
//
// It used to be a full card — a drawn cover, a heading, the author, badges, a
// sentence of explanation and three buttons — on the grounds that a missing book
// is still a book and that is what a reader is looking for. With sixty-eight
// series to complete and several volumes short in each, that is several hundred
// cards: a page nobody scrolls, where the one question being asked — *which
// books am I missing?* — needs a card's worth of reading per answer.
//
// So the series is the thing with a heading, and what is missing from it is a
// list under it. The number and the title, which is the whole answer; a copy
// button, because what you do next is paste it into a shop or a search; and
// Wikipedia where there is a title to look up.
//
// Wikipedia by its own search rather than a guessed article address: measured,
// `index.php?search=` answers 302 straight to the article when the name is a
// page — *The Dark Tower III: The Waste Lands* and *Dragonriders of Pern* both
// land on theirs — and where there is no article it shows the search instead of
// a red link. A volume with no title of its own has nothing to look up, so it
// gets no link; the series head has one.
const missingLine = ({ name, author, no, title }) => {
  const search = [author, title || `${name} ${no}`].filter(Boolean).join(' - ');
  const wiki = title
    ? `<a class="linkish" href="https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(title)}"
        target="_blank" rel="noopener" title="Read about ${esc(title)} on Wikipedia, in a new tab">↗</a>`
    : '';
  // A title and who wrote it, on every line (2.14.128). A hole in the
  // collection's own numbering knows no title of its own, and said "title
  // unknown" six times down a series, with the author nowhere on the line. Where
  // Wikidata knows the series its titles are used (see `drawSeriesPane`); where
  // nothing does, the line says which book of which series it is — something to
  // search for, rather than an admission.
  return `<li class="missing-vol">
    <span class="no">${esc(String(no))}</span>
    <span class="what">${title ? esc(title) : `<em>${esc(name)}, book ${esc(String(no))}</em>`}</span>
    ${author ? `<span class="by">${esc(author)}</span>` : ''}
    <button class="copy-search linkish" data-copy-text="${esc(search)}"
      title="Copy “${esc(search)}” to search for it">⧉</button>${wiki}
  </li>`;
};

// The series' name in the head is the way to it: the genre opened, the series
// selected under it, the author marked beside it, and its books. It was a
// separate "open in library" on the holes in your own numbering and nothing at
// all on what Wikidata found, and the owner wanted the name itself to go there.
const seriesLink = (s) => `<button class="open-series linkish" data-genre="${esc(s.genre || '')}"
    data-series="${esc(s.name)}" data-author="${esc(s.author || '')}"
    title="${esc(s.name)}${s.author ? ` by ${esc(s.author)}` : ''}, in the library">${esc(s.name)}</button>`;

// One series, headed the way the library heads a series, with its own copy
// button: what you paste into a shop or a search is the series, not one volume.
const missingSeries = (r) => `<div class="series-head">Series · ${seriesLink(r)}
    <button class="copy-search linkish" data-copy-text="${esc([r.author, r.name].filter(Boolean).join(' - '))}"
      title="Copy “author - series” to search for it">⧉ copy</button></div>
  <div class="series-gap missing">${r.missing.length} of ${r.volumes.length} volume(s) not here${r.byTitle
  ? ' — your books in it carry no numbers, so this was matched by title' : ''}
    <a class="linkish" href="${esc(r.url)}" target="_blank" rel="noopener">on Wikidata ↗</a></div>
  <ul class="missing-vols">${r.titles.filter((v) => v.no && r.missing.includes(v.no))
  .map((v) => missingLine({ name: r.name, author: r.author, no: v.no, title: v.title })).join('')}</ul>`;

// The same, for a hole in the collection's own numbering. There is no title to
// show — nothing here knows what book 9 is called — so the number is the name,
// and the series head carries the sentence that qualifies the whole group.
const ownGapSeries = (g, known = {}) => `<div class="series-head">Series · ${seriesLink(g)}
    <button class="copy-search linkish" data-copy-text="${esc([g.author, g.name].filter(Boolean).join(' - '))}"
      title="Copy “author - series” to search for it">⧉ copy</button></div>
  <div class="series-gap missing">${esc(g.says)}${g.unnumbered
  ? ` ${g.unnumbered} book(s) here carry no volume number, so one of these may be among them.`
  : ''}</div>
  <ul class="missing-vols">${g.missing
  .map((no) => missingLine({ name: g.name, author: g.author, no, title: known[no] || '' })).join('')}</ul>`;

// The pane, browsed the way the library is: this author's missing volumes, or
// everybody's when no author is picked.
function drawSeriesPane(gaps, online, author = null) {
  // What Wikidata calls each volume of a series it knows, for the holes in your
  // own numbering of that same series: it knows titles that the numbers alone
  // cannot. Matched on genre and name, the way the two lists name a series.
  const titlesFor = (g) => {
    const r = (online.series || []).find((s) => s.found && s.genre === g.genre && s.name === g.name);
    return Object.fromEntries(((r && r.titles) || []).filter((v) => v.no && v.title).map((v) => [v.no, v.title]));
  };
  const short = (online.series || []).filter((r) => r.found && r.missing && r.missing.length)
    .filter((r) => !author || r.author === author)
    .sort((a, b) => (a.genre || '').localeCompare(b.genre || '')
      || (a.author || '').localeCompare(b.author || '') || a.name.localeCompare(b.name));
  const whole = (online.series || []).filter((r) => r.found && !(r.missing || []).length);
  const silent = (online.series || []).filter((r) => !r.found);

  const header = `<div class="row pager">
      <span class="hint">${online.lastAt
    ? `Wikidata last asked ${new Date(online.lastAt).toLocaleString()}`
    : 'Wikidata has not been asked yet'}</span>
      <div class="spacer"></div>
      <button id="askWikidata" class="ghost">Check every series against Wikidata</button>
    </div>`;

  // What is certain comes first and stays apart: these are holes between books
  // you own, counted here, not asked of anybody.
  const mineGaps = gaps.gaps.filter((g) => !author || g.author === author);
  const own = mineGaps.length
    ? `<div class="series-head">Missing between the books you have —
        ${mineGaps.reduce((n, g) => n + g.missing.length, 0)} book(s)</div>`
      + mineGaps.map((g) => ownGapSeries(g, titlesFor(g))).join('')
    : '';

  // said even where nothing is missing: "no gaps" and "nothing numbered to
  // judge" are different answers, and only one of them is good news
  const unnumbered = author ? [] : (gaps.unnumbered || []);
  const cannotCount = unnumbered.length
    ? `<p class="hint">${unnumbered.length} series with no volume numbers at all, so
       ${unnumbered.length === 1 ? 'its' : 'their'} own books can say nothing about gaps:
       ${unnumbered.map((s) => esc(`${s.genre} · ${s.name}`)).join(', ')}.
       Wikidata can still be asked about ${unnumbered.length === 1 ? 'it' : 'those'}, and matches
       by title.</p>`
    : '';

  const found = short.length ? short.map(missingSeries).join('')
    : `<div class="empty">${online.total
      ? 'Nothing Wikidata knows of is missing here.'
      : 'Not asked yet — press <em>Check every series against Wikidata</em> above.'}</div>`;

  // Only when looking at everything: per author these would be noise.
  const rest = author ? '' : (whole.length ? `<p class="hint">${whole.length} series are complete as
        far as Wikidata knows: ${whole.map((r) => esc(r.name)).join(', ')}.</p>` : '')
    + (silent.length ? '<div class="series-head">It could not say</div>'
      + silent.map((r) => `<div class="fix"><div><strong>${esc(r.name)}</strong>
          <div class="sub">${esc(r.genre)}${r.author ? ` · ${esc(r.author)}` : ''}</div>
          <div class="sub">${esc(r.why)}</div></div></div>`).join('') : '');

  $('#books .list').innerHTML = header + own + cannotCount
    + '<div class="series-head">Volumes Wikidata knows and you do not have</div>'
    + found + rest;
  $('#books #askWikidata').onclick = askWikidata;
}

// Which author is being looked at, kept outside the drawing: the Wikidata check
// answers one series a second and the whole view is drawn again each time, so
// without this the column would throw you back to Every author while you read.
let seriesAuthor = null;

// The authors column, filled with whoever is short of something — the same shape
// as browsing the library, so the way in is the way you already know.
function drawSeriesAuthors(gaps, online) {
  const short = new Map();
  const add = (name, n) => short.set(name || '', (short.get(name || '') || 0) + n);
  for (const g of gaps.gaps) add(g.author, g.missing.length);
  for (const r of (online.series || [])) {
    if (r.found && (r.missing || []).length) add(r.author, r.missing.length);
  }
  const names = [...short.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  // an author whose last gap has just been answered away is no longer there to
  // stay on, and a pane filtered to a name with no rows would read as empty
  if (seriesAuthor !== null && !short.has(seriesAuthor)) seriesAuthor = null;
  const mark = (name) => (name === (seriesAuthor ?? '') ? ' class="active"' : '');
  $('#authors ul').innerHTML = `<li data-name=""${mark('')}>
      <span>Every author</span><span class="count">${[...short.values()]
    .reduce((n, v) => n + v, 0)}</span></li>`
    + names.map(([name, n]) => `<li data-name="${esc(name)}"${mark(name)}>
        <span>${esc(name) || 'author unknown'}</span><span class="count">${n}</span></li>`).join('');
  $('#authors ul').querySelectorAll('li').forEach((li) => {
    li.onclick = () => {
      $('#authors ul').querySelectorAll('li').forEach((o) => o.classList.remove('active'));
      li.classList.add('active');
      seriesAuthor = li.dataset.name || null;
      drawSeriesPane(gaps, online, seriesAuthor);
      show('books');
    };
  });
}

// The column and the pane are one view, and both are drawn from the same pair of
// answers. Drawing only the pane was the bug: Wikidata would find four volumes
// missing under an author the column had never heard of, and the row's own count
// said five series while the column could only lead you to three of them.
function drawSeriesBoth(gaps, online) {
  drawSeriesAuthors(gaps, online);
  drawSeriesPane(gaps, online, seriesAuthor);
}

let onlineWatch = null;
let lastGaps = { gaps: [], looked: 0 };

async function askWikidata() {
  try { await post('/api/series-online', {}); } catch (e) { return toast(e.message); }
  const bar = newBar('Checking series');
  clearInterval(onlineWatch);
  onlineWatch = setInterval(async () => {
    const s = await api('/api/series-online/status').catch(() => null);
    if (!s) return;
    if (s.total) bar.at((s.done / s.total) * 100);
    bar.say(onlineWords(s), !!s.error);
    const open = () => $('#seriesList').classList.contains('active');
    if (open()) drawSeriesBoth(lastGaps, s);
    if (!s.running) {
      clearInterval(onlineWatch);
      onlineWatch = null;
      bar.done(s.error ? 15000 : 4000);
      // the count beside the row and the view itself come from one read, or the
      // row can say five series while the pane shows what it knew a second ago
      const fresh = await loadSeriesCount();
      if (open()) drawSeriesBoth(fresh.gaps, fresh.online);
    }
  }, 1000);
  return undefined;
}

// The count beside the row: the series with a hole in them, from both kinds of
// answer, because a reader does not care which of the two found it.
async function loadSeriesCount() {
  const [gaps, online] = await Promise.all([
    api('/api/series-gaps').catch(() => ({ gaps: [], looked: 0 })),
    api('/api/series-online/status').catch(() => ({ series: [] })),
  ]);
  lastGaps = gaps;
  const names = new Set(gaps.gaps.map((g) => `${g.genre}/${g.name}`));
  for (const r of (online.series || [])) {
    if (r.found && (r.missing || []).length) names.add(`${r.genre}/${r.name}`);
  }
  counts('seriesList', names.size);
  return { gaps, online };
}

$('#seriesList').onclick = async () => {
  // this view browses by author, so the authors column stays where it is —
  // `maintenance` is what hides that column and takes the app down to two,
  // which is why the list it was written for sets it and Listened does not
  document.body.classList.remove('maintenance');
  document.querySelectorAll('#genres li').forEach((el) => el.classList.remove('active'));
  $('#seriesList').classList.add('active');
  seriesAuthor = null;
  $('#authors ul').innerHTML = '<li class="empty">Counting…</li>';
  $('#books .list').innerHTML = '<div class="empty">Counting…</div>';
  show('authors');
  const { gaps, online } = await loadSeriesCount();
  drawSeriesBoth(gaps, online);
};

// The two buttons on these rows. The copy puts "author - thing" on the
// clipboard, which is what a search box or a shop wants; the other leaves this
// list for the series itself in the library, which is where the missing book
// would be filled in — it was the one thing the Settings list could do that
// this pane could not, and moving a list means moving what it could do.
$('#books').addEventListener('click', async (e) => {
  const open = e.target.closest('.open-series');
  if (open) {
    document.body.classList.remove('maintenance');
    $('#seriesList').classList.remove('active');
    // unfold the genre first, or the series it lands on is the one row in the
    // column that cannot be seen
    showSeriesOf(open.dataset.genre, true);
    await selectSeries(open.dataset.genre, open.dataset.series, null);
    // and whose it is, marked in the authors column the series view fills —
    // the series is what is selected, so this is said, not browsed to
    const who = [...document.querySelectorAll('#authors li')].find((l) => l.dataset.name === open.dataset.author);
    if (who) who.classList.add('active');
    return;
  }
  const button = e.target.closest('.copy-search');
  if (!button) return;
  const text = button.dataset.copyText || '';
  if (!text) return;
  toast((await toClipboard(text)) ? `Copied: ${text}` : 'The browser would not copy that.');
});

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


// A maintenance row is a job waiting to be done, so a row with nothing waiting
// is not drawn. A column of nine zeroes says only that the column is long, and
// the one number that mattered — 68 series to complete — had to be found among
// eight noughts.
//
// Two rows do not follow the rule. *Import* is not a count of work: it reads "–"
// until a folder is set, and it is the way to set one. And any row that is the
// view currently on screen stays, whatever its count — emptying the trash from
// inside the trash must not pull the list out from under the reader, and the
// list redraws itself after every such change.
//
// The count is the `.count` inside the row, found rather than named: the row ids
// and the count ids do not share a pattern (`convertList`/`convertCount`), and a
// table mapping one to the other would be a second thing to keep in step.
const counts = (rowId, n) => {
  const row = $(`#${rowId}`);
  row.querySelector('.count').textContent = String(n);
  row.hidden = !n && !row.classList.contains('active');
};

// Everything the library counts feeds off the same data, so refresh it together.
// The shelves included: a book that just arrived belongs under Recently added.
const MAINTENANCE_ROWS = ['needsTags', 'convertList', 'convertedList', 'brokenList', 'skippedList', 'requestList',
  'importList', 'replacedList', 'trashList',
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
    loadReplaced(), loadBroken(), loadSkipped(), loadListened(), loadConvertible(),
    loadConverted(), loadSeriesCount(), loadAccounts(), loadRequests(), importCountOnly()]);
  await backToView();
}

// --- anything that moves files on disk -----------------------------------
// Runs a file operation while the bar at the bottom follows it. Importing and
// the edit dialog's genre change are here; moving, deleting and the maintenance
// lists are in `maint.js` and call this, which is why it stays on this side of
// the seam rather than going with them.
async function fileWork(url, body, label) {
  const until = { finished: false };
  const request = post(url, body).catch((e) => ({ error: e.message }))
    .then((r) => { until.finished = true; return r; });
  const p = await trackProgress('/api/files/status', label, until);
  const r = await request;
  // the request that did the work decides; `p.error` only ever complains about
  // following it, so it is read when the request itself said nothing at all
  const failure = r.error || (r && Object.keys(r).length ? '' : p.error);
  p.bar.say(failure ? `${label} failed: ${failure}` : `${label} done.`, !!failure);
  p.bar.done(failure ? 15000 : 3000);
  return { ok: !failure, r, bar: p.bar };
}

// The copy button beside every field goes through `toClipboard`, which is in
// `copy.js` since the Home Assistant page needed it as well.

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
$('#openAccounts').onclick = () => { shutMenu(); location.href = '/accounts'; };

$('#openSettings').onclick = async () => {
  shutMenu();
  const s = await api('/api/settings');
  libs = s.libraries;
  libsAtOpen = JSON.stringify(libs);
  $('#importPath').value = s.importPath || '';
  // which of Google's catalogues answers, straight from the server's own list
  $('#googleCountry').innerHTML = (s.googleCountries || [])
    .map((c) => `<option value="${esc(c.code)}"${c.code === (s.googleCountry || '') ? ' selected' : ''}>`
      + `${esc(c.name)}${c.code ? ` (${esc(c.code)})` : ''}</option>`).join('');
  await showTagAll();
  // whether a Discord webhook is saved, and how the last line went
  await loadHook();
  // and when the database was last copied, which is the one thing nobody thinks
  // to look at until the day it matters
  await loadBackups();
  // and whether there is a newer version, from what the server last heard: the
  // button beside it is what asks GitHub again
  loadUpdate(false);
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
  await post('/api/settings', {
    libraries: libs,
    importPath: $('#importPath').value.trim(),
    googleCountry: $('#googleCountry').value,
  });
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

// How many polls in a row may go unanswered before the bar gives up: six
// seconds' worth. One was enough before, and one is nothing — a reverse proxy
// hiccup, a moment of wifi, a request that arrived while the server was busy.
// The work is on the server and carries on whatever this page can reach, so a
// failure to *read* the progress is not the job failing. The owner saw "Writing tags
// failed: lost contact with the server" on a tag write that had almost certainly
// finished perfectly well.
const KEEP_ASKING = 20;

async function trackProgress(statusUrl, label, until) {
  const bar = newBar(label);
  let started = false;
  let waited = 0;
  let missed = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, 300));
    const p = await api(statusUrl).catch(() => null);
    if (!p) {
      // The request that is doing the work came back while this was failing:
      // it has the answer, and there is nothing left to follow.
      if (until && until.finished) return { bar };
      if ((missed += 1) < KEEP_ASKING) {
        bar.say(`${label} — the server is not answering, still trying…`);
        // eslint-disable-next-line no-continue -- the loop is the retry
        continue;
      }
      return { error: 'lost contact with the server', bar };
    }
    missed = 0;
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
  loadConvertible().then(() => { if ($('#convertList').classList.contains('active')) $('#convertList').click(); });
}

for (const id of MAINTENANCE_ROWS) {
  $('#' + id).addEventListener('click', () => show('books'));
}

$('#scan').onclick = () => work($('#scan'), 'The scan', startScan);

// Nothing is drawn until somebody is signed in: `account.js` calls this once it
// knows who is asking. This page is the admin's, so it also sends anybody who is
// merely a listener back to the shelves — that check is `loadPerm`.
window.begin = async () => {
  // First, both of them, and before anything that loads: this is news about the
  // page itself and it does not depend on a single row being drawn. Last in the
  // list is where they were, and a column that failed to load took the words
  // "it worked" down with it — which is the one moment they were needed.
  sayIfUpdated();
  await loadPerm();
  updateMark();
  await loadGenres();
  await Promise.all([loadScanChoices(), loadStats(), loadUntagged(), importCountOnly(), loadTrash(),
    loadReplaced(), loadBroken(), loadSkipped(), loadConvertible(), loadConverted(),
    loadSeriesCount(), loadAccounts(), loadRequests()]);
  await loadHome();
  // a genre asked for from the player on another page; after the shelves, so
  // it is what ends up on screen
  await openGenreAsked();
  // a scan another browser started is still running: follow it instead of
  // offering a button that would only be refused
  const tagging = await api('/api/tagall/status').catch(() => null);
  if (tagging && tagging.state === 'running') watchTagAll();
  const scanning = await api('/api/scan/status').catch(() => null);
  if (scanning && scanning.running) {
    work($('#scan'), 'The scan', async () => finishScan(null, await trackProgress('/api/scan/status', 'Looking for books…')));
  }
  // and a conversion, for the same reason: it runs for minutes, so the page is
  // reloaded during one far more often than during anything else here
  const converting = await api('/api/convert/status').catch(() => null);
  if (converting && converting.running) window.followConvert?.();
};
