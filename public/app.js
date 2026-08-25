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
  if (perm.required && !perm.admin) location.replace('listen.html');
  $('#adminBtn').hidden = !perm.required;
}

$('#adminBtn').onclick = async () => {
  await post('/api/admin/lock', {});
  location.replace('listen.html');
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

async function loadStats() {
  const s = await api('/api/stats?user=' + encodeURIComponent(state.user));
  $('#status').innerHTML = [
    [s.books, 'audiobooks'], [s.files, 'files'], [s.done, 'listened'], [s.todo, 'not listened'],
  ].map(([n, label]) => `<span><strong>${n.toLocaleString()}</strong> ${label}</span>`).join('');
}

// --- landing view ------------------------------------------------------
// A book with no cover falls back to the app icon, so the row keeps its grid.
const tile = (b, resumable) => {
  const at = Math.min(b.track_idx + 1, b.tracks || 1);
  const pct = b.done ? 100 : b.tracks ? (at / b.tracks) * 100 : 0;
  return `<div class="tile" data-id="${b.id}" data-genre="${esc(b.genre)}" data-author="${esc(b.author)}"
       data-resume="${resumable ? 1 : 0}" title="${esc(b.title)}">
    <img src="/api/cover/${b.id}?v=${b.coverV || 0}" onerror="this.src='icon-128.png'" alt="">
    <div class="t">${esc(b.title)}</div>
    <div class="a">${esc(b.author)}</div>
    ${resumable ? `<div class="tbar"><div style="width:${pct}%"></div></div>
      <div class="a">${b.done ? 'Listened' : `Track ${at} of ${b.tracks}`}</div>` : ''}
  </div>`;
};

const shelf = (title, items, resumable) => !items.length ? '' :
  `<div class="shelf"><div class="shelf-title">${title}</div>
     <div class="tiles">${items.map((b) => tile(b, resumable)).join('')}</div></div>`;

async function loadHome() {
  document.body.classList.remove('maintenance');
  document.querySelectorAll('#genres li, #authors li').forEach((e) => e.classList.remove('active'));
  $('#authors ul').innerHTML = '';
  const d = await api('/api/home?user=' + encodeURIComponent(state.user));
  const html = shelf('Continue listening', d.continue, true) + shelf('Recently added', d.recent, false);
  $('#books .list').innerHTML = html
    || '<div class="empty">Nothing here yet — add a library folder in Settings and scan.</div>';
  $('#books .list').querySelectorAll('.tile').forEach((t) => {
    t.onclick = () => (t.dataset.resume === '1'
      ? playBook(Number(t.dataset.id))
      : openInLibrary(t.dataset.genre, t.dataset.author));
  });
}

async function openInLibrary(genre, author) {
  const gli = [...document.querySelectorAll('#genres ul li[data-name]')].find((l) => l.dataset.name === genre);
  await selectGenre(genre, gli);
  const ali = [...document.querySelectorAll('#authors li')].find((l) => l.dataset.name === author);
  await selectAuthor(author, ali);
}

// --- browsing ----------------------------------------------------------
async function loadGenres() {
  const list = await api('/api/genres');
  $('#genres ul').innerHTML = list.map((g) =>
    `<li data-name="${esc(g.name)}"><span>${esc(g.name)}</span><span class="count">${g.books}</span></li>`).join('')
    || '<li class="empty">No genres — add a library folder in Settings and scan.</li>';
  $('#genres ul').querySelectorAll('li[data-name]').forEach((li) => { li.onclick = () => selectGenre(li.dataset.name, li); });
}

async function selectGenre(genre, li) {
  document.body.classList.remove('maintenance');
  state.genre = genre;
  document.querySelectorAll('#genres li').forEach((e) => e.classList.remove('active'));
  if (li) li.classList.add('active');
  const list = await api('/api/authors?genre=' + encodeURIComponent(genre));
  $('#authors ul').innerHTML = list.map((a) =>
    `<li data-name="${esc(a.name)}"><span>${esc(a.name)}</span><span class="count">${a.books}</span></li>`).join('');
  $('#authors ul').querySelectorAll('li').forEach((el) => { el.onclick = () => selectAuthor(el.dataset.name, el); });
  $('#books .list').innerHTML = '<div class="empty">Select an author.</div>';
}

async function selectAuthor(author, li) {
  state.author = author;
  document.querySelectorAll('#authors li').forEach((e) => e.classList.remove('active'));
  if (li) li.classList.add('active');
  const books = await api(`/api/books?genre=${encodeURIComponent(state.genre)}&author=${encodeURIComponent(author)}`
    + `&user=${encodeURIComponent(state.user)}`);
  let html = '';
  let series = '';
  for (const b of books) {
    if (b.series !== series) {
      series = b.series;
      if (series) html += `<div class="series-head">Series · ${esc(series)}</div>`;
    }
    html += `<div class="card" data-started="${b.started ? 1 : 0}">
      <div class="cover">
        <img src="/api/cover/${b.id}?v=${b.coverV || 0}" onerror="this.style.visibility='hidden'" alt="">
        <label class="listened">
          <input type="checkbox" ${b.done ? 'checked' : ''} onchange="setListened(${b.id}, this)"> Listened
        </label>
      </div>
      <div>
        <h3><span class="note ${b.done ? 'done' : b.started ? 'part' : 'new'}"
              title="${b.done ? 'Listened' : b.started ? 'Partly listened' : 'Not listened yet'}">&#9835;</span>
          ${esc(b.title)}</h3>
        <div class="sub">${esc(author)}${b.series ? ' · ' + esc(b.series) : ''}</div>
        <div class="sub" style="margin-top:6px">
          ${b.year ? `<span class="badge">${esc(b.year)}</span>` : ''}
          ${b.narrator ? `<span class="badge">Narrator: ${esc(b.narrator)}</span>` : ''}
          ${b.duration ? `<span class="badge">${hms(b.duration)}</span>` : ''}
          ${b.tagged
            ? `<span class="badge tagged" title="Tags found in the MP3 files">In MP3: ${esc(b.tagged.split(',').join(', '))}</span>`
            : '<span class="badge untagged" title="The MP3 files carry none of these tags">Not in MP3</span>'}
        </div>
        <div class="desc">${esc(b.description) || 'No description.'}</div>
      </div>
      <div class="actions">
        <button onclick="playBook(${b.id})">▶ Play</button>
        <button class="ghost" onclick="findMeta(${b.id})">Find metadata</button>
        <button class="ghost" onclick="writeTags(${b.id})">Write into MP3s</button>
        <button class="ghost" onclick="editMeta(${b.id})">Edit metadata</button>
        <div class="row2">
          <button class="ghost" onclick="moveBook(${b.id})">Move…</button>
          <button class="ghost danger" onclick="trashBook(${b.id})">Delete…</button>
        </div>
      </div>
    </div>`;
  }
  $('#books .list').innerHTML = html || '<div class="empty">No books.</div>';
}

// --- player ------------------------------------------------------------
const audio = $('#audio');

window.playBook = async function (id) {
  if (!state.user) return toast('Create or select a user first.');
  const book = await api(`/api/books/${id}?user=${encodeURIComponent(state.user)}`);
  state.book = book;
  $('#player').hidden = false;
  $('#pCover').src = `/api/cover/${id}?v=${book.coverV || 0}`;
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

$('#trackSelect').onchange = (e) => playTrack(Number(e.target.value));
audio.onended = () => playTrack(state.track + 1);
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
    const note = box.closest('.card').querySelector('.note');
    const started = box.closest('.card').dataset.started === '1';
    note.className = 'note ' + (box.checked ? 'done' : started ? 'part' : 'new');
    note.title = box.checked ? 'Listened' : started ? 'Partly listened' : 'Not listened yet';
    loadStats();
  } catch (e) {
    box.checked = !box.checked;
    toast(e.message);
  }
};

// Writes tags while the bar at the bottom follows the file count.
async function writeWithProgress(id, pick) {
  const until = { finished: false };
  const request = post(`/api/apply/${id}`, { pick, writeTags: true })
    .catch((e) => ({ error: e.message }))
    .then((r) => { until.finished = true; return r; });
  const p = await trackProgress('/api/apply/status', 'Writing tags…', until);
  const r = await request;
  const failure = r.error || p.error;
  $('#progressText').textContent = failure
    ? 'Writing tags failed: ' + failure
    : `${r.written} MP3 file(s) tagged.`;
  hideProgressSoon();
  // the maintenance list and its count depend on what is in the files
  loadUntagged().then(() => { if ($('#needsTags').classList.contains('active')) $('#needsTags').click(); });
  return !failure;
}

// Write what the app already knows about the book into its MP3 files.
window.writeTags = (id) => writeWithProgress(id, {});

// A run of books, one at a time, so the bar can show where it is.
async function writeMany(books) {
  $('#progress').hidden = false;
  let failed = 0;
  for (const [i, b] of books.entries()) {
    $('#progressBar').style.width = ((i + 1) / books.length) * 100 + '%';
    $('#progressText').textContent = `${i + 1} / ${books.length} · ${b.title}`;
    const r = await post(`/api/apply/${b.id}`, { pick: {}, writeTags: true }).catch(() => null);
    if (!r) failed++;
  }
  $('#progressText').textContent = `Tags written into ${books.length - failed} of ${books.length} book(s).`;
  hideProgressSoon();
  loadUntagged();
}

$('#tagAll').onclick = async () => {
  const books = await api('/api/allbooks');
  if (!confirm(`Write tags into every MP3 of all ${books.length} book(s)? This rewrites the files.`)) return;
  $('#settings').close();
  await writeMany(books);
  if (state.author) selectAuthor(state.author, null);
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
  if (showBar) await trackProgress('/api/files/status', 'Reading the import folder…', until);
  const r = await request;
  if (showBar) $('#progress').hidden = true;
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
  let seen = null;
  importWatch = setInterval(async () => {
    if (!$('#importList').classList.contains('active')) return clearInterval(importWatch);
    const state = await api('/api/import/state').catch(() => null);
    if (!state) return;
    showFreshness(state);
    if (seen === null) seen = state.changed;
    if (state.changed !== seen && !state.building) {
      seen = state.changed;
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
    $('#importDlg').close();
    const body = {
      source: c.path, genre: $('#iGenre').value, author: $('#iAuthor').value.trim(),
      series: $('#iSeries').value.trim(), title: $('#iTitle').value.trim(),
    };
    const { ok, r } = await fileWork('/api/import', body, 'Import');
    if (ok) {
      // the server files the book itself, so there is nothing to rescan
      $('#progressText').textContent = `Imported into ${r.dest}`;
      await refreshLibrary();
    }
    $('#importList').onclick('keep');
  };
  $('#importDlg').showModal();
}
$('#closeImport').onclick = () => $('#importDlg').close();

// Everything the library counts feeds off the same data, so refresh it together.
// The shelves included: a book that just arrived belongs under Recently added.
async function refreshLibrary() {
  await Promise.all([loadGenres(), loadStats(), loadUntagged(), loadTrash(), importCountOnly()]);
  if (state.author) selectAuthor(state.author, null);
  else if (!document.body.classList.contains('maintenance')) await loadHome();
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
  $('#progressText').textContent = failure ? `${label} failed: ${failure}` : `${label} done.`;
  hideProgressSoon(failure ? 15000 : 3000);
  return { ok: !failure, r };
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
  $('#emptyTrash').onclick = async () => {
    if (!confirm(`Delete the files of all ${d.items.length} item(s) for good?`)) return;
    await post('/api/trash/empty', {}).catch((e) => toast(e.message));
    $('#trashList').click();
  };
  $('#books .list').querySelectorAll('button[data-restore]').forEach((b) => {
    b.onclick = async () => {
      await fileWork(`/api/trash/${b.dataset.restore}/restore`, {}, 'Put back');
      await refreshLibrary();
      $('#trashList').click();
    };
  });
  $('#books .list').querySelectorAll('button[data-purge]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Delete these files for good?')) return;
      await post(`/api/trash/${b.dataset.purge}/purge`, {}).catch((e) => toast(e.message));
      $('#trashList').click();
    };
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
        ${b.fixable.length ? `<button onclick="writeTags(${b.id})">Write into MP3s</button>` : ''}
        <button class="ghost" onclick="findMeta(${b.id})">Find metadata</button>
      </div>
    </div>`).join('')}`;
  $('#tagFixable').onclick = () => {
    if (confirm(`Write tags into ${fixable.length} book(s)?`)) writeMany(fixable).then(() => $('#needsTags').click());
  };
};

window.editMeta = async function (id) {
  const b = await api(`/api/books/${id}`);
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

window.findMeta = async function (id, query) {
  $('#lookupBody').innerHTML = '';
  if (!$('#lookup').open) {
    const b = await api(`/api/books/${id}`);
    $('#lookupQuery').value = [b.title, b.author].filter(Boolean).join(' ');
    $('#lookup').showModal();
  }
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
        <div class="sub">${esc(c.author)}${c.year ? ' · ' + esc(c.year) : ''}${c.genre ? ' · ' + esc(c.genre) : ''}</div>
        <div class="desc">${esc(c.description)}</div>
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
  const pick = window._cands[i];
  $('#lookup').close();
  if (writeTags) {
    await writeWithProgress(id, pick);
  } else {
    try { await post(`/api/apply/${id}`, { pick, writeTags: false }); toast('Metadata applied.'); }
    catch (e) { return toast(e.message); }
  }
  if (state.author) selectAuthor(state.author, null);
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

$('#savePass').onclick = async () => {
  const password = $('#setPass').value;
  if (password && password.length < 4) return toast('Use at least four characters.');
  if (!password && !confirm('Remove the password, so anyone can change the collection?')) return;
  try {
    await post('/api/admin/password', { password });
    $('#setPass').value = '';
    toast(password ? 'Password set. Other browsers can only listen now.' : 'Password removed.');
    await loadPerm();
    showPassState();
  } catch (e) { toast(e.message); }
};

let fromEnv = { password: false };

function showPassState() {
  if (fromEnv.password) {
    $('#passState').textContent = 'The password comes from the container template (ADMIN_PASSWORD). Change it there.';
    return;
  }
  $('#passState').textContent = perm.required
    ? 'A password is set. Browsers that have not unlocked can only browse and play.'
    : 'No password: anyone who opens the app can change everything.';
}

$('#openSettings').onclick = async () => {
  const s = await api('/api/settings');
  libs = s.libraries;
  libsAtOpen = JSON.stringify(libs);
  $('#setPass').disabled = !!s.passwordFromEnv;
  $('#savePass').disabled = !!s.passwordFromEnv;
  fromEnv = { password: !!s.passwordFromEnv };
  $('#importPath').value = s.importPath || '';
  renderLibs();
  showPassState();
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
  if (JSON.stringify(libs) !== libsAtOpen) startScan();
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
async function trackProgress(statusUrl, label, until) {
  $('#progress').hidden = false;
  $('#progressBar').style.width = '0';
  $('#progressText').textContent = label;
  let started = false;
  let waited = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, 300));
    const p = await api(statusUrl).catch(() => null);
    if (!p) return { error: 'lost contact with the server' };
    if (p.running) started = true;
    if (p.total) {
      $('#progressBar').style.width = (p.done / p.total) * 100 + '%';
      $('#progressText').textContent = `${p.done} / ${p.total} · ${p.current}`;
    }
    if (until ? until.finished : (started ? !p.running : (waited += 300) > 3000)) return p;
  }
}

function hideProgressSoon(ms = 3000) {
  setTimeout(() => { $('#progress').hidden = true; }, ms);
}

async function startScan() {
  try {
    await post('/api/scan', {});
  } catch (e) { return finishScan(e.message); }
  const p = await trackProgress('/api/scan/status', 'Looking for books…');
  finishScan(p.error, p);
}

function finishScan(error, p) {
  if (error) {
    $('#progressText').textContent = 'Scan failed: ' + error;
    return;
  }
  $('#progressText').textContent = p.warning
    ? `Scan complete: ${p.books} book(s) — ${p.warning}`
    : `Scan complete: ${p.books} book(s).`;
  $('#progressText').classList.toggle('warn', !!p.warning);
  loadGenres();
  loadStats();
  hideProgressSoon(p.warning ? 30000 : 3000);
}

$('#scan').onclick = startScan;

// A name first: the whole point of the app is remembering where you were.
(async () => {
  // read the remembered name first: loadUsers falls back to the first name in
  // the list and writes that back, which would hide that this browser is new
  const remembered = localStorage.user || '';
  await loadPerm();
  const users = await loadUsers();
  await loadGenres();
  await Promise.all([loadStats(), loadUntagged(), importCountOnly(), loadTrash()]);
  await loadHome();
  if (!users.length || !users.includes(remembered)) await askWho(users, users.length > 0);
})();
