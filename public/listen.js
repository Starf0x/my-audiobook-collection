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
  if (!p.required || p.admin) return location.assign('index.html');
  $('#adminWhy').textContent = 'The password opens the page that can scan, import, tag, move and delete.';
  $('#adminPass').value = '';
  $('#admin').showModal();
};
$('#adminCancel').onclick = () => $('#admin').close();
$('#adminGo').onclick = async () => {
  try {
    await post('/api/admin/unlock', { password: $('#adminPass').value });
    location.assign('index.html');
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
$('#addUser').onclick = async () => askWho(await api('/api/users').catch(() => []), true);

async function loadStats() {
  const s = await api('/api/stats?user=' + encodeURIComponent(state.user));
  $('#status').innerHTML = [
    [s.books, 'audiobooks'], [s.files, 'files'], [s.done, 'listened'], [s.todo, 'not listened'],
  ].map(([n, label]) => `<span><strong>${n.toLocaleString()}</strong> ${label}</span>`).join('');
}

// --- shelves ------------------------------------------------------------
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
}
$('#home').onclick = loadHome;

async function openInLibrary(genre, author) {
  const gli = [...document.querySelectorAll('#genres li[data-name]')].find((l) => l.dataset.name === genre);
  await selectGenre(genre, gli);
  const ali = [...document.querySelectorAll('#authors li')].find((l) => l.dataset.name === author);
  await selectAuthor(author, ali);
}

// --- browsing -----------------------------------------------------------
async function loadGenres() {
  const list = await api('/api/genres');
  $('#genres ul').innerHTML = list.map((g) =>
    `<li data-name="${esc(g.name)}"><span>${esc(g.name)}</span><span class="count">${g.books}</span></li>`).join('')
    || '<li class="empty">Nothing here yet.</li>';
  $('#genres ul').querySelectorAll('li[data-name]').forEach((li) => { li.onclick = () => selectGenre(li.dataset.name, li); });
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
        </div>
        <div class="desc">${esc(b.description) || 'No description.'}</div>
      </div>
      <div class="actions"><button onclick="playBook(${b.id})">▶ Play</button></div>
    </div>`;
  }
  $('#books .list').innerHTML = html || '<div class="empty">No books.</div>';
}

// --- player -------------------------------------------------------------
const audio = $('#audio');

window.playBook = async function (id) {
  if (!state.user) return toast('Pick a name first.');
  const book = await api(`/api/books/${id}?user=${encodeURIComponent(state.user)}`);
  state.book = book;
  $('#player').hidden = false;
  $('#pCover').src = `/api/cover/${id}?v=${book.coverV || 0}`;
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

window.setListened = async function (id, box) {
  if (!state.user) { box.checked = !box.checked; return toast('Pick a name first.'); }
  try {
    await post('/api/listened', { user: state.user, bookId: id, done: box.checked });
    const card = box.closest('.card');
    const note = card.querySelector('.note');
    const started = card.dataset.started === '1';
    note.className = 'note ' + (box.checked ? 'done' : started ? 'part' : 'new');
    note.title = box.checked ? 'Listened' : started ? 'Partly listened' : 'Not listened yet';
    loadStats();
  } catch (e) {
    box.checked = !box.checked;
    toast(e.message);
  }
};

(async () => {
  const remembered = localStorage.user || '';
  const users = await loadUsers();
  await loadGenres();
  await loadStats();
  await loadHome();
  if (!users.length || !users.includes(remembered)) await askWho(users, users.length > 0);
})();
