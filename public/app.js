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

const state = { user: localStorage.user || '', genre: null, author: null, book: null, track: 0 };

// --- users -------------------------------------------------------------
async function loadUsers() {
  const users = await api('/api/users');
  $('#user').innerHTML = users.map((u) => `<option${u === state.user ? ' selected' : ''}>${u}</option>`).join('')
    || '<option value="">(no user)</option>';
  state.user = $('#user').value || '';
  localStorage.user = state.user;
}
$('#user').onchange = () => { state.user = localStorage.user = $('#user').value; };
$('#addUser').onclick = async () => {
  const name = prompt('User name');
  if (!name) return;
  await post('/api/users', { name });
  state.user = name;
  await loadUsers();
};

// --- browsing ----------------------------------------------------------
async function loadGenres() {
  const list = await api('/api/genres');
  $('#genres ul').innerHTML = list.map((g) =>
    `<li data-name="${g.name}"><span>${g.name}</span><span class="count">${g.books}</span></li>`).join('')
    || '<li class="empty">No genres — add a library folder in Settings and scan.</li>';
  $('#genres ul').querySelectorAll('li[data-name]').forEach((li) => { li.onclick = () => selectGenre(li.dataset.name, li); });
}

async function selectGenre(genre, li) {
  state.genre = genre;
  document.querySelectorAll('#genres li').forEach((e) => e.classList.remove('active'));
  if (li) li.classList.add('active');
  const list = await api('/api/authors?genre=' + encodeURIComponent(genre));
  $('#authors ul').innerHTML = list.map((a) =>
    `<li data-name="${a.name}"><span>${a.name}</span><span class="count">${a.books}</span></li>`).join('');
  $('#authors ul').querySelectorAll('li').forEach((el) => { el.onclick = () => selectAuthor(el.dataset.name, el); });
  $('#books .list').innerHTML = '<div class="empty">Select an author.</div>';
}

async function selectAuthor(author, li) {
  state.author = author;
  document.querySelectorAll('#authors li').forEach((e) => e.classList.remove('active'));
  if (li) li.classList.add('active');
  const books = await api(`/api/books?genre=${encodeURIComponent(state.genre)}&author=${encodeURIComponent(author)}`);
  let html = '';
  let series = '';
  for (const b of books) {
    if (b.series !== series) {
      series = b.series;
      if (series) html += `<div class="series-head">Series · ${series}</div>`;
    }
    html += `<div class="card">
      <img src="/api/cover/${b.id}" onerror="this.style.visibility='hidden'" alt="">
      <div>
        <h3>${b.title}</h3>
        <div class="sub">${author}${b.series ? ' · ' + b.series : ''}</div>
        <div class="sub" style="margin-top:6px">
          ${b.year ? `<span class="badge">${b.year}</span>` : ''}
          ${b.narrator ? `<span class="badge">Narrator: ${b.narrator}</span>` : ''}
          ${b.duration ? `<span class="badge">${hms(b.duration)}</span>` : ''}
        </div>
        <div class="desc">${b.description || 'No description.'}</div>
      </div>
      <div class="actions">
        <button onclick="playBook(${b.id})">▶ Play</button>
        <button class="ghost" onclick="findMeta(${b.id})">Find metadata</button>
        <button class="ghost" onclick="writeTags(${b.id})">Write into MP3s</button>
        <button class="ghost" onclick="editMeta(${b.id})">Edit metadata</button>
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
  $('#pCover').src = `/api/cover/${id}`;
  $('#pTitle').textContent = book.title;
  $('#trackSelect').innerHTML = book.tracks.map((t, i) => `<option value="${i}">${i + 1}. ${t.title}</option>`).join('');
  playTrack(book.progress ? book.progress.track_idx : 0, book.progress ? book.progress.position : 0);
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
// Write what the app already knows about the book into its MP3 files.
window.writeTags = async function (id) {
  try {
    const r = await post(`/api/apply/${id}`, { pick: {}, writeTags: true });
    toast(`${r.written} MP3 file(s) tagged.`);
  } catch (e) { toast(e.message); }
};

window.editMeta = async function (id) {
  const b = await api(`/api/books/${id}`);
  $('#eTitle').value = b.title || '';
  $('#eAuthor').value = b.author || '';
  $('#eNarrator').value = b.narrator || '';
  $('#eYear').value = b.year || '';
  $('#eDescription').value = b.description || '';
  const save = async (writeTags) => {
    const pick = {
      title: $('#eTitle').value.trim(), author: $('#eAuthor').value.trim(),
      narrator: $('#eNarrator').value.trim(), year: $('#eYear').value.trim(),
      description: $('#eDescription').value.trim(),
    };
    try {
      const r = await post(`/api/apply/${id}`, { pick, writeTags });
      toast(writeTags ? `Saved, ${r.written} MP3 file(s) tagged.` : 'Saved.');
      $('#edit').close();
      if (state.author) selectAuthor(state.author, null);
    } catch (e) { toast(e.message); }
  };
  $('#saveEdit').onclick = () => save(false);
  $('#saveEditTags').onclick = () => save(true);
  $('#edit').showModal();
};
$('#closeEdit').onclick = () => $('#edit').close();

window.findMeta = async function (id, query) {
  $('#lookupBody').innerHTML = 'Searching Google Books…';
  if (!$('#lookup').open) {
    const b = await api(`/api/books/${id}`);
    $('#lookupQuery').value = [b.title, b.author].filter(Boolean).join(' ');
    $('#lookup').showModal();
  }
  $('#lookupSearch').onclick = () => findMeta(id, $('#lookupQuery').value.trim());
  try {
    const cands = await api(`/api/lookup/${id}` + (query ? '?q=' + encodeURIComponent(query) : ''));
    window._cands = cands;
    $('#lookupBody').innerHTML = cands.length ? cands.map((c, i) => `<div class="cand">
      ${c.thumbnail ? `<img src="${c.thumbnail}" alt="">` : ''}
      <div style="flex:1">
        <strong>${c.title}</strong>
        <div class="sub">${c.author}${c.year ? ' · ' + c.year : ''}${c.genre ? ' · ' + c.genre : ''}</div>
        <div class="desc">${c.description || ''}</div>
        <div class="row">
          <button onclick="applyMeta(${id},${i},false)">Use metadata</button>
          <button class="ghost" onclick="applyMeta(${id},${i},true)">Use + write into MP3s</button>
        </div>
      </div></div>`).join('')
      : '<div class="empty">No match on Google Books. Adjust the search above and try again, or use <em>Edit metadata</em> to fill it in yourself.</div>';
  } catch (e) {
    $('#lookupBody').innerHTML = `<div class="empty">${e.message}</div>`;
  }
};

window.applyMeta = async function (id, i, writeTags) {
  try {
    const r = await post(`/api/apply/${id}`, { pick: window._cands[i], writeTags });
    toast(writeTags ? `Metadata applied, ${r.written} MP3 file(s) tagged.` : 'Metadata applied.');
    $('#lookup').close();
    if (state.author) selectAuthor(state.author, null);
  } catch (e) { toast(e.message); }
};
$('#closeLookup').onclick = () => $('#lookup').close();

// --- settings ----------------------------------------------------------
let libs = [];
let libsAtOpen = '[]';
function renderLibs() {
  $('#libList').innerHTML = libs.map((l, i) =>
    `<li><span>${l}</span><button data-i="${i}">✕</button></li>`).join('') || '<li class="empty">None yet.</li>';
  $('#libList').querySelectorAll('button').forEach((b) => {
    b.onclick = () => { libs.splice(Number(b.dataset.i), 1); renderLibs(); };
  });
}
$('#openSettings').onclick = async () => {
  const s = await api('/api/settings');
  libs = s.libraries;
  libsAtOpen = JSON.stringify(libs);
  $('#apiKey').value = s.googleApiKey;
  renderLibs();
  $('#browser').hidden = true;
  $('#settings').showModal();
};
$('#addLib').onclick = () => {
  const p = $('#libPath').value.trim();
  if (p) { addLib(p); $('#libPath').value = ''; }
};
$('#closeSettings').onclick = () => $('#settings').close();
$('#saveSettings').onclick = async () => {
  await post('/api/settings', { libraries: libs, googleApiKey: $('#apiKey').value.trim() });
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
      `<li><span data-p="${e}">📁 ${e.split(/[\\/]/).pop()}</span>
       <button data-add="${e}">${libs.includes(e) ? '✓ added' : '+ Add'}</button></li>`).join('')
      || '<li class="empty">No sub-folders.</li>';
    $('#browserList').querySelectorAll('span[data-p]').forEach((s) => { s.onclick = () => browse(s.dataset.p); });
    $('#browserList').querySelectorAll('button[data-add]').forEach((b) => { b.onclick = () => addLib(b.dataset.add, b); });
    $('#browseUp').onclick = () => browse(d.parent);
  } catch (e) { toast(e.message); }
}
function addLib(p, btn) {
  if (!libs.includes(p)) { libs.push(p); renderLibs(); }
  if (btn) btn.textContent = '✓ added';
}
$('#browseBtn').onclick = () => browse($('#libPath').value.trim() || '/');
$('#browsePick').onclick = () => addLib(browsePath);

async function startScan() {
  $('#progress').hidden = false;
  $('#progressBar').style.width = '0';
  $('#progressText').textContent = 'Looking for books…';
  try {
    await post('/api/scan', {});
  } catch (e) { return finishScan(e.message); }

  while (true) {
    await new Promise((r) => setTimeout(r, 400));
    const p = await api('/api/scan/status');
    $('#progressBar').style.width = (p.total ? (p.done / p.total) * 100 : 0) + '%';
    $('#progressText').textContent = p.total ? `${p.done} / ${p.total} · ${p.current}` : 'Looking for books…';
    if (!p.running) return finishScan(p.error, p);
  }
}

function finishScan(error, p) {
  if (error) {
    $('#progressText').textContent = 'Scan failed: ' + error;
    return;
  }
  $('#progressText').textContent = `Scan complete: ${p.books} book(s).`;
  loadGenres();
  setTimeout(() => { $('#progress').hidden = true; }, 3000);
}

$('#scan').onclick = startScan;

loadUsers().then(loadGenres);
