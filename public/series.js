// Series to complete: the holes in your own numbering, what Wikidata knows you
// do not have, and the authors column that browses them. Out of app.js since
// 2.14.152, as it was written. Loaded right after app.js, whose helpers it uses
// (`work`, `show`, `newBar`, `selectSeries`); app.js reaches back into it only
// from inside functions that run later — `loadSeriesCount`, `goodreadsLink`.

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
// Goodreads, as a place to look a book up (2.14.136): wherever a book or a
// series is being looked for — a missing volume, a series short of some, a book
// somebody asked for. Its own search, not a guessed page: it lands on the book
// when the words are close, and lists the candidates when they are not. Title
// before author, which is how its search ranks best.
const goodreadsLink = (words, label = 'Goodreads', look = 'linkish') => {
  const q = words.filter(Boolean).join(' ');
  return q ? `<a class="${look} goodreads" href="https://www.goodreads.com/search?q=${encodeURIComponent(q)}"
    target="_blank" rel="noopener" title="Look for “${esc(q)}” on Goodreads, in a new tab">${label}</a>` : '';
};

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
    ${goodreadsLink([title || `${name} ${no}`, author])}
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
      title="Copy “author - series” to search for it">⧉ copy</button>
    ${goodreadsLink([r.name, r.author], 'on Goodreads ↗')}</div>
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
      title="Copy “author - series” to search for it">⧉ copy</button>
    ${goodreadsLink([g.name, g.author], 'on Goodreads ↗')}</div>
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
