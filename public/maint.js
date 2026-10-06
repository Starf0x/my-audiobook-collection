// The maintenance column, and the file operations it leads to.
//
// The admin page's left column has two halves. The top one browses the
// collection — genres, authors, series — and that is `browse.js`, shared with
// the listening page. The bottom one is this: the lists that exist because
// something needs doing. Not counted, Broken, Replaced, To convert, Converted,
// Trash, Needs tags — and Move… and Delete…, which are what those lists are for.
//
// They all work the same way, which is why they are one file. Each is a count
// loaded at startup, a row in the column, and an `onclick` that fills the two
// columns beside it; each ends by putting its own list back rather than throwing
// the reader somewhere else. Nothing above them in `app.js` reaches in here —
// what crosses the seam goes the other way, and only at the moment a button is
// pressed: `fileWork`, `refreshLibrary`, `backToView` and `MAINTENANCE_ROWS`
// stay in `app.js`, because importing and the edit dialog use them too.
//
// This was the bottom quarter of a 2402-line `app.js`. `browse.js` had already
// shown the shape of the problem: a file nobody can hold in their head is a file
// where two copies of something drift apart without anybody noticing.
//
// **Load it after app.js**, which declares `state`. Nothing here runs at load
// beyond hanging handlers on rows that `index.html` already has.

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

// --- maintenance: books that are not MP3 --------------------------------
// An .m4b or .ogg book plays, but its tags cannot be written, so it never leaves
// Needs tags. Converting it makes every chapter a track — which is what this app
// calls a chapter — and keeps the file it came from under Converted.
async function loadConvertible() {
  const d = await api('/api/convertible')
    .catch((e) => ({ tools: false, books: [], why: `The server would not say: ${e.message}` }));
  state.convertible = d.books;
  state.convertTools = d.tools;
  // missing is one answer and uploaded-but-will-not-run is another
  state.convertWhy = d.why
    || (d.tools ? '' : 'This container is older than 2.3.0, which is where converting came in. '
      + 'Update it to the newest build.');
  $('#convertCount').textContent = d.books.length;
  return d;
}

async function loadConverted() {
  const items = await api('/api/converted').catch(() => []);
  $('#convertedCount').textContent = items.length || '0';
  return items;
}

// One book, with the bar at the bottom following the minutes of audio through it
async function runConvert(id) {
  const until = { finished: false };
  const request = post(`/api/convert/${id}`, {}).catch((e) => ({ error: e.message }))
    .then((r) => { until.finished = true; return r; });
  const p = await trackProgress('/api/convert/status', 'Converting', until);
  const r = await request;
  const failure = r.error || p.error;
  p.bar.say(failure ? `Converting failed: ${failure}` : `Converted: ${r.files} file(s) kept under Converted.`, !!failure);
  p.bar.done(failure ? 15000 : 4000);
  await refreshLibrary();
}

$('#convertList').onclick = async () => {
  document.body.classList.add('maintenance');
  document.querySelectorAll('#genres li').forEach((el) => el.classList.remove('active'));
  $('#convertList').classList.add('active');
  $('#authors ul').innerHTML = '';
  const { tools, books, why } = await loadConvertible();
  if (!books.length) {
    $('#books .list').innerHTML = '<div class="empty">Every book is MP3 already.</div>';
    return show('books');
  }
  $('#books .list').innerHTML = `<div class="row pager">
      <span class="hint">${books.length} book(s) whose files are not MP3, so their tags cannot be written.
        Each chapter becomes a track; the file it came from is kept under <em>Converted</em>.</span>
    </div>
    ${tools ? '' : `<div class="empty">${esc(why)} Converting is off until that is put right.</div>`}
    ${books.map((b) => `<div class="fix">
      <div>
        <strong>${esc(b.title)}</strong>
        <div class="sub">${esc(b.genre)} · ${esc(b.author)}${b.series ? ' · ' + esc(b.series) : ''}</div>
        <div class="sub">${b.others} of ${b.files} file(s) are ${esc(b.kinds)}${b.duration ? ' · ' + hms(b.duration) : ''}</div>
      </div>
      <div class="actions">
        <button data-convert="${b.id}"${tools ? '' : ' disabled'}>Convert to MP3</button>
      </div>
    </div>`).join('')}`;
  $('#books .list').querySelectorAll('button[data-convert]').forEach((b) => {
    b.onclick = () => work(b, 'The conversion', () => runConvert(Number(b.dataset.convert)), false);
  });
  show('books');
};

$('#convertedList').onclick = async () => {
  document.body.classList.add('maintenance');
  document.querySelectorAll('#genres li').forEach((el) => el.classList.remove('active'));
  $('#convertedList').classList.add('active');
  $('#authors ul').innerHTML = '';
  const items = await loadConverted();
  if (!items.length) {
    $('#books .list').innerHTML = '<div class="empty">Nothing converted yet. The .m4b and .ogg files of a '
      + 'book that has been converted are kept here until you delete them.</div>';
    return show('books');
  }
  $('#books .list').innerHTML = `<div class="row pager">
      <span class="hint">${items.length} book(s) converted, their original files kept beside the library</span>
      <div class="spacer"></div><button id="cAll" class="danger">Delete them all</button>
    </div>` + items.map((r) => `<div class="fix">
    <div>
      <strong>${esc(r.title)}</strong>
      <div class="sub">${esc(r.genre)} · ${esc(r.author)}${r.series ? ' · ' + esc(r.series) : ''}</div>
      <div class="sub">${r.files} file(s) · ${kb(r.bytes)} · converted ${new Date(r.converted_at).toLocaleString()}</div>
      <div class="sub">${esc(r.path)}${r.onDisk ? '' : ' — the folder is gone'}</div>
    </div>
    <div class="actions"><button class="danger" data-del="${r.id}">Delete now</button></div>
  </div>`).join('');
  $('#books .list').querySelectorAll('button[data-del]').forEach((b) => {
    b.onclick = () => work(b, 'The delete', async () => {
      if (!confirm('Delete the original files of this book for good?')) return;
      try { await post(`/api/converted/${b.dataset.del}`, {}); } catch (e) { return toast(e.message); }
      toast('Deleted.');
      $('#convertedList').click();
    });
  });
  const all = $('#books #cAll');
  if (all) all.onclick = () => work(all, 'The delete', async () => {
    if (!confirm(`Delete the originals of all ${items.length} converted books for good?`)) return;
    try { await post('/api/converted/all', {}); } catch (e) { return toast(e.message); }
    toast('Deleted.');
    $('#convertedList').click();
  });
  show('books');
};

window.moveBook = async function (id) {
  const b = await api(`/api/books/${id}`);
  // The genres, from the folders — not from `/api/import`, which this asked for
  // the same list and which throws when there is no import folder set, or when
  // there is one and the share it names is not mounted. Moving a book has
  // nothing to do with importing, and this is an inline handler: the throw went
  // nowhere anybody would see, so the Move… button did nothing at all on an
  // install that had never imported. It also walked the whole import folder to
  // fill a dropdown.
  //
  // Caught as well, because the dialog is still worth opening without the list:
  // the genre the book already has is in it either way, so a move within a genre
  // — which is most of them — still works.
  const folders = (await api('/api/genrefolders').catch(() => ({ folders: [] }))).folders || [];
  const genres = [...new Set(folders.map((g) => g.genre).concat(b.genre || []))].filter(Boolean).sort();
  $('#mGenre').innerHTML = genres.map((g) =>
    `<option${g === b.genre ? ' selected' : ''}>${esc(g)}</option>`).join('');
  $('#mAuthor').value = b.author || '';
  $('#mSeries').value = b.folderSeries || b.series || '';
  $('#mTitle').value = b.title || '';
  const preview = () => {
    const parts = [$('#mAuthor').value.trim(), $('#mSeries').value.trim(), $('#mTitle').value.trim()].filter(Boolean);
    // A book that lives in a part of a series has five folders above it and this
    // dialog writes four, so a move takes it out of the part. `clean()` turns a
    // slash into a dash, so typing the two levels into the Series box makes one
    // folder named for both rather than the nesting back. Said here because the
    // alternative is a book quietly leaving the series it was filed under.
    $('#mWhere').textContent = `Moves to ${$('#mGenre').value} / ${parts.join(' / ')}`
      + (b.parent_series ? ` — out of ${b.parent_series} / ${b.series}, which this cannot write` : '');
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

// The rows themselves, for the whole list or for one author's share of it, with
// the write-them-all button above whatever is being shown.
function drawFix(list) {
  const fixable = list.filter((b) => b.fixable.length);
  const lookup = list.filter((b) => b.needsLookup.length);
  $('#books .list').innerHTML = `
    <div class="row" style="margin-bottom:4px">
      ${fixable.length ? `<button id="tagFixable">Write into ${fixable.length} book(s)</button>` : ''}
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
        <button class="ghost" onclick="showUntagged(${b.id})"
          title="Open this book where it lives in the library">Show the book</button>
      </div>
    </div>`).join('')}`;
  if ($('#tagFixable')) {
    $('#tagFixable').onclick = () => {
      if (!confirm(`Write tags into ${fixable.length} book(s)?`)) return;
      work($('#tagFixable'), 'The tag write', () => writeMany(fixable), false).then(() => $('#needsTags').click());
    };
  }
  show('books');
}

// The row knows the book; the button hands over an id and nothing else. Every
// inline handler on this page passes numbers and `this` — a title or an author
// in one would have to be escaped for an HTML attribute and for JavaScript at
// once, and the first person to copy the pattern would get it wrong.
function showUntagged(id) {
  const b = (state.untagged || []).find((x) => x.id === id);
  if (b) jumpToBook(b.id, b.genre, b.author);
}

// One author's books that need tags, the way the genres column opens an author
function untaggedOf(name, li) {
  document.querySelectorAll('#authors li').forEach((e) => e.classList.remove('active'));
  if (li) li.classList.add('active');
  state.untaggedAuthor = name;
  drawFix((state.untagged || []).filter((b) => b.author === name)
    .sort((a, b) => a.title.localeCompare(b.title)));
}

$('#needsTags').onclick = async () => {
  // this list browses by author, like the genres do, so the authors column stays
  document.body.classList.remove('maintenance');
  document.querySelectorAll('#genres li').forEach((e) => e.classList.remove('active'));
  $('#needsTags').classList.add('active');
  state.genre = null;
  state.author = null;
  state.series = null;
  $('#books .list').innerHTML = '<div class="empty">Checking the files…</div>';
  const list = await loadUntagged();
  state.untagged = list;
  if (!list.length) {
    $('#authors ul').innerHTML = '';
    state.untaggedAuthor = null;
    $('#books .list').innerHTML = '<div class="empty">Every book carries all required tags.</div>';
    return show('books');
  }
  const authors = [...new Set(list.map((b) => b.author))].sort((a, b) => a.localeCompare(b));
  $('#authors ul').innerHTML = authors.map((name) => `<li data-name="${esc(name)}">
      <span class="who">${esc(name)}</span>
      <span class="count">${list.filter((b) => b.author === name).length}</span></li>`).join('');
  $('#authors ul').querySelectorAll('li').forEach((li) => {
    li.onclick = () => untaggedOf(li.dataset.name, li);
  });
  // writing tags for a book redraws this list: the author being worked through
  // is where the owner was, so that is what comes back
  const was = authors.includes(state.untaggedAuthor) ? state.untaggedAuthor : null;
  if (was) {
    return untaggedOf(was, [...$('#authors ul').querySelectorAll('li')]
      .find((e) => e.dataset.name === was));
  }
  state.untaggedAuthor = null;
  drawFix(list);
};

