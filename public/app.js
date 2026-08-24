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

// --- users -------------------------------------------------------------
async function loadUsers() {
  const users = await api('/api/users');
  $('#user').innerHTML = users.map((u) => `<option${u === state.user ? ' selected' : ''}>${esc(u)}</option>`).join('')
    || '<option value="">(no user)</option>';
  state.user = $('#user').value || '';
  localStorage.user = state.user;
}
$('#user').onchange = () => { state.user = localStorage.user = $('#user').value; loadStats(); };
$('#addUser').onclick = async () => {
  const name = prompt('User name');
  if (!name) return;
  await post('/api/users', { name });
  state.user = name;
  await loadUsers();
};

async function loadStats() {
  const s = await api('/api/stats?user=' + encodeURIComponent(state.user));
  $('#status').innerHTML = [
    [s.books, 'audiobooks'], [s.files, 'files'], [s.done, 'listened'], [s.todo, 'not listened'],
  ].map(([n, label]) => `<span><strong>${n.toLocaleString()}</strong> ${label}</span>`).join('');
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
        <img src="/api/cover/${b.id}" onerror="this.style.visibility='hidden'" alt="">
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
  $('#trackSelect').innerHTML = book.tracks.map((t, i) => `<option value="${i}">${i + 1}. ${esc(t.title)}</option>`).join('');
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
  $('#eNarrator').value = b.narrator || '';
  $('#eYear').value = b.year || '';
  $('#eDescription').value = b.description || '';
  const save = async (writeTags) => {
    const pick = {
      title: $('#eTitle').value.trim(), author: $('#eAuthor').value.trim(),
      narrator: $('#eNarrator').value.trim(), year: $('#eYear').value.trim(),
      description: $('#eDescription').value.trim(),
    };
    $('#edit').close();
    if (writeTags) {
      await writeWithProgress(id, pick);
    } else {
      try { await post(`/api/apply/${id}`, { pick, writeTags: false }); toast('Saved.'); }
      catch (e) { return toast(e.message); }
    }
    if (state.author) selectAuthor(state.author, null);
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

loadUsers().then(loadGenres).then(loadStats).then(loadUntagged);
