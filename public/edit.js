// The edit dialog, the cover that goes in it, and the metadata lookup behind it.
//
// This is what happens to one book: Edit opens it, the cover can be pasted or
// dropped or picked, *Find metadata* asks Google and offers what came back, and
// Save writes the lot. Three dialogs' worth of behaviour — `#edit`, `#lookup`
// and the cover box inside the first — which hang together and touch nothing
// else: the only names the rest of the page uses from here are `editMeta` and
// `findMeta`, both of which are reached from a button.
//
// What it uses from `app.js` it uses when a button is pressed, never at load:
// `state`, `fileWork`, `backToView`, `refreshLibrary`, `toClipboard`. So this
// loads after `app.js`, like `maint.js`, and all it does at load is hang
// handlers on the dialogs that `index.html` already has.
//
// It was the middle of a 2402-line `app.js`. The cover's own rule is worth
// repeating here because it is the one people trip over: the bytes go up the
// moment a picture is pasted, but nothing is written to the book until Save.
// This dialog's Cancel has always meant cancel.

// --- the cover in the edit dialog ---------------------------------------
// A cover is the one field of a book that cannot be typed, and the way people
// already have one in hand is the clipboard: right-click an image anywhere,
// *Copy image*, Ctrl+V. The paste is taken wherever it lands in the dialog —
// a clipboard carrying a picture means the picture, whichever field has focus —
// and a text paste into a field is left alone, which is what the `file` test is.
//
// The bytes go up at once and come back as a name in covers/, but nothing is
// written to the book until Save: this dialog's Cancel has always meant cancel,
// and a cover that changes the moment it is pasted would quietly break that.
const MOST_COVER = 12 * 1024 * 1024;
let pastedCover = null;
let pastedShown = '';

const showCover = (src) => { $('#eCover').src = src; };

function forgetPastedCover() {
  if (pastedShown) URL.revokeObjectURL(pastedShown);
  pastedShown = '';
  pastedCover = null;
  $('#eCoverUndo').hidden = true;
}

async function takeCover(file) {
  if (!file) return;
  if (file.size > MOST_COVER) {
    return toast(`That picture is ${kb(file.size)} — a cover has to be under ${kb(MOST_COVER)}.`);
  }
  let said;
  try {
    const r = await fetch('/api/cover', {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
    // the same care as api(): a refusal is not always JSON, and reading it as
    // JSON turns a sentence the owner could act on into a parse error
    const text = await r.text();
    said = text ? JSON.parse(text) : {};
    if (!r.ok) throw new Error(said.error || `The server answered ${r.status}.`);
  } catch (e) {
    return toast(e.message);
  }
  forgetPastedCover();
  pastedCover = said.cover;
  pastedShown = URL.createObjectURL(file);
  showCover(pastedShown);
  $('#eCoverUndo').hidden = false;
  return toast(`${said.what} cover ready, ${kb(said.bytes)}. It is kept when you save.`);
}

const pictureIn = (data) => {
  const item = [...(data?.items || [])].find((i) => i.kind === 'file' && /^image\//.test(i.type));
  return item ? item.getAsFile() : null;
};

$('#edit').addEventListener('paste', (e) => {
  const file = pictureIn(e.clipboardData);
  // no picture on the clipboard: this is somebody pasting text into a field
  if (!file) return;
  e.preventDefault();
  takeCover(file);
});

$('#eCoverBox').addEventListener('dragover', (e) => {
  e.preventDefault();
  $('#eCoverBox').classList.add('over');
});
$('#eCoverBox').addEventListener('dragleave', () => $('#eCoverBox').classList.remove('over'));
$('#eCoverBox').addEventListener('drop', (e) => {
  e.preventDefault();
  $('#eCoverBox').classList.remove('over');
  takeCover(pictureIn(e.dataTransfer) || (e.dataTransfer.files || [])[0]);
});

$('#eCoverPick').onclick = () => $('#eCoverFile').click();
$('#eCoverFile').onchange = (e) => {
  takeCover(e.target.files[0]);
  e.target.value = ''; // or choosing the same file twice would not fire again
};

// `over` is a chosen lookup result: the fields open filled with it, so what
// Google offered is read and corrected before anything is saved. It also carries
// what this dialog has no field for — the cover and the series number — so those
// are not lost on the way through. `genre` is the one picked in the lookup.
window.editMeta = async function (id, over, genre) {
  const b = await api(`/api/books/${id}`);
  const v = { ...b, ...(over || {}) };
  // where it sits on disk and how many files it is made of, at the foot of the dialog
  const files = (b.tracks || []).length;
  $('#ePath').textContent = `${b.path || ''} · ${files} file${files === 1 ? '' : 's'}`;
  $('#eTitle').value = v.title || '';
  $('#eAuthor').value = v.author || '';
  // a result with no series, or one whose series was unticked, leaves the book
  // where it is filed: an empty field here would move it out of its series folder
  $('#eSeries').value = (over && over.series) || b.folderSeries || b.series || '';
  // and a result that names no number leaves the one the book already has: an
  // empty field here would take it off on the next save
  $('#eSeriesNo').value = (over && over.seriesNo) || b.series_no || '';
  $('#eNarrator').value = v.narrator || '';
  $('#eYear').value = v.year || '';
  $('#eDescription').value = v.description || '';
  // The cover it has now, asked for afresh every time this opens. A book with no
  // art gets one drawn, and that answer is cached until midnight — so the plain
  // address would go on showing yesterday's drawing after art was pasted onto
  // the book, in the one dialog whose whole job is changing the picture. Seen
  // happening: cover saved, file on disk, and the dialog still drawing.
  const ownCover = `/api/cover/${id}?t=${Date.now()}`;
  forgetPastedCover();
  showCover(ownCover);
  $('#eCoverUndo').onclick = () => { forgetPastedCover(); showCover(ownCover); };
  const wasSeries = b.folderSeries || b.series || '';
  const save = async (writeTags) => {
    const pick = {
      ...(over || {}),
      title: $('#eTitle').value.trim(), author: $('#eAuthor').value.trim(),
      narrator: $('#eNarrator').value.trim(), year: $('#eYear').value.trim(),
      description: $('#eDescription').value.trim(),
      // the series goes in as well, so the tag says what the folder says and the
      // number below it has a series to belong to
      series: $('#eSeries').value.trim(),
      seriesNo: Number($('#eSeriesNo').value) || 0,
      // only when one was pasted: an absent key leaves the book's own art alone,
      // and an empty string would read as "no cover" on the way through
      ...(pastedCover ? { cover: pastedCover } : {}),
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
      await writeWithProgress(id, pick, genre);
    } else {
      try { await post(`/api/apply/${id}`, { pick, genre, writeTags: false }); toast('Saved.'); }
      catch (e) { return toast(e.message); }
    }
    // a genre change moves the book, and can add a genre folder to the left column
    if (genre) await loadGenres();
    await refreshLibrary();
  };
  $('#saveEdit').onclick = () => save(false);
  $('#saveEditTags').onclick = () => save(true);
  $('#edit').showModal();
};
$('#closeEdit').onclick = () => $('#edit').close();
// Cancel, Escape and Save all end here. Save has already read the pasted name
// into its pick by now, so letting go of it is safe wherever the dialog closes
// from — and the picture being previewed is a blob this page has to release.
$('#edit').addEventListener('close', forgetPastedCover);

$('#edit').addEventListener('click', async (e) => {
  const button = e.target.closest('button.copy');
  if (!button) return;
  const value = $('#' + button.dataset.copy).value;
  if (!value) return toast('That field is empty.');
  toast((await toClipboard(value)) ? 'Copied.' : 'The browser would not copy that.');
});

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
        + 'Goes into the book and into the tags. <em>Use metadata</em> puts it in the Series field of '
        + 'Edit metadata, which is a folder: saving there moves the book into it.'}</div>`;
}

// Find metadata opens the dialog with the search it would have made, and waits.
// A folder name is often nearly right and rarely exactly right, so asking Google
// before the owner has read the words spends a request on the wrong book.
// Which of Google's catalogues this lookup will ask, said in the dialog itself:
// it decides how much series data comes back, and a catalogue that does not match
// the server is what "Google Books is busy" usually is.
async function sayWhere() {
  const s = await api('/api/settings').catch(() => null);
  if (!s) return;
  const where = s.googleCountries?.find((c) => c.code === (s.googleCountry || ''));
  $('#lookupWhere').textContent = 'Asking www.googleapis.com'
    + (s.googleCountry
      ? ` for the ${where ? where.name.replace(/ —.*/, '') : s.googleCountry} catalogue (${s.googleCountry})`
      : ', letting it choose the catalogue')
    + ' — Settings changes that.';
}

window.findMeta = async function (id) {
  const book = await api(`/api/books/${id}`);
  sayWhere();
  $('#lookupQuery').value = [book.title, book.author].filter(Boolean).join(' ');
  $('#lookupBody').innerHTML = '<div class="empty">Change the search if you like, '
    + 'then press Search.</div>';
  $('#lookupProgress').hidden = true;
  const search = () => lookMeta(id, $('#lookupQuery').value.trim());
  $('#lookupSearch').onclick = search;
  $('#lookupQuery').onkeydown = (e) => { if (e.key === 'Enter') search(); };
  if (!$('#lookup').open) $('#lookup').showModal();
  $('#lookupQuery').focus();
  $('#lookupQuery').select();
};

window.lookMeta = async function (id, query, deep = false) {
  $('#lookupBody').innerHTML = '';
  const book = await api(`/api/books/${id}`);
  const known = new Set((await api('/api/genrefolders').catch(() => ({ folders: [] })))
    .folders.map((g) => g.genre.toLowerCase()));
  const state_ = { finished: false };
  const poll = pollLookup(state_);
  try {
    const cands = await api(`/api/lookup/${id}?deep=${deep ? 1 : 0}`
      + (query ? '&q=' + encodeURIComponent(query) : ''));
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
          <button onclick="useMeta(${id},${i})">Use metadata</button>
          <button class="ghost" onclick="applyMeta(${id},${i},true)">Use + write into MP3s</button>
        </div>
      </div></div>`).join('')
      : '<div class="empty">No match on Google Books. Adjust the search above and try again, or use <em>Edit metadata</em> to fill it in yourself.</div>';
    // One question is what a lookup costs now. The series hunt is a request per
    // result and two more besides, which is a great deal to spend on every book —
    // and on a key Google refuses at random it is what made lookups fail at all.
    if (cands.length && !deep && cands.some((c) => !c.series)) {
      $('#lookupBody').insertAdjacentHTML('beforeend',
        '<div class="row"><button id="digSeries" class="ghost">Look harder for the series</button>'
        + '<span class="hint">Asks Google about each result, its ebook edition and its other '
        + 'records — a few more requests.</span></div>');
      $('#digSeries').onclick = () => work($('#digSeries'), 'The series hunt',
        () => lookMeta(id, query, true), false);
    }
  } catch (e) {
    // escaped like everything else that lands in markup: this message is a
    // sentence from the server, and one of them quotes what Google answered
    $('#lookupBody').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  } finally {
    state_.finished = true;
    await poll;
  }
};

// the result as the pickers beside it leave it: the author chosen from the ones
// credited, and the series only if it was left ticked
function pickOf(i) {
  const chosen = $(`#ca${i}`) ? $(`#ca${i}`).value : '';
  const keepSeries = $(`#cs${i}`) ? $(`#cs${i}`).checked : true;
  return {
    ...window._cands[i],
    ...(chosen ? { author: chosen } : {}),
    ...(keepSeries ? {} : { series: '', seriesNo: 0 }),
  };
}

// Use metadata saves nothing itself: it opens Edit metadata on the result that
// was chosen, which is where the owner reads it, changes what is wrong and saves.
window.useMeta = function (id, i) {
  const pick = pickOf(i);
  const genre = $(`#cg${i}`) ? $(`#cg${i}`).value : '';
  $('#lookup').close();
  editMeta(id, pick, genre);
};

window.applyMeta = async function (id, i, writeTags) {
  const pick = pickOf(i);
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

