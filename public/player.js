// The player, and it belongs to all three pages.
//
// The app is three documents — / , /admin and /ha — and moving between them
// throws the <audio> element away with the rest of the page. So the book being
// listened to is written down on the way out and picked up on the way in, and
// the player itself lives here rather than twice over in the page scripts.
//
// This file is loaded after the page's own script and leans on what that
// declares: $, api, post, toast, and a `state` object with user, book and
// track. The markup it drives is <footer id="player">, the same on every page
// — except `/player`, which is the player and nothing else and carries only
// some of the controls.
//
// Hence `maybe`: a page is allowed not to have a control. `/player` shows the
// cover, the chapter, the seek line and one play/pause, and has no volume
// slider, no chapter pulldown, no download and nothing to close — a phone has
// buttons on its side for the volume, and the rest is a page away. Reaching
// straight for those and finding `null` is a page that dies at load with the
// rest of the player unbuilt, which is worse than a page with fewer buttons.
const audio = $('#audio');
const maybe = (sel, fn) => { const el = $(sel); if (el) fn(el); return el; };

window.playBook = async function (id, carried) {
  // The same book again: the button that started it is the one that stops it —
  // unless it has run out, where pressing it means playing it again, and that has
  // to go through the loading below: it starts at the top and takes the tick off.
  // A book carried in from the previous page is not a press at all, so it never
  // takes this way out.
  if (!carried && state.book && state.book.id === id && !audio.ended) {
    // A press that starts a book goes to the player page; a press that stops one
    // stays where it is. Taking somebody away from the shelf to put a book down
    // would be an odd thing for a pause to do.
    if (audio.paused) {
      if (goesToPlayer() && handOver(id, state.track, audio.currentTime || 0)) return;
      audio.play().catch(() => {});
    } else audio.pause();
    return;
  }
  // a book carried in, or shown because a speaker plays it, needs no name (2.14.391)
  if (!state.user && !carried) return toast('Pick a name first.');
  const book = await api(`/api/books/${id}?user=${encodeURIComponent(state.user)}`);
  // A book that was finished is played again from the beginning: its kept place
  // is the end of the last track, which would play a few seconds and stop. And
  // listening to it again means it is not a book you are done with, so the tick
  // comes off — the same thing Start again from the beginning does. None of that
  // applies to a book that was already playing a moment ago on another page.
  if (book.finished && !carried) {
    book.progress = null;
    if (state.user) {
      await post('/api/listened', { user: state.user, bookId: id, done: false }).catch(() => {});
    }
  }
  state.book = book;
  // the bar, on the pages that have one. /player *is* the player and has none.
  maybe('#player', (el) => { el.hidden = false; });
  $('#pCover').src = `/api/cover/${id}?v=${book.coverV || 0}`;
  // every file of this book in one archive, which is what a download of an
  // audiobook means; the name comes from the server, so it is the book's
  maybe('#pGet', (el) => { el.href = `/api/download/${id}`; });
  $('#pTitle').textContent = book.title;
  // who wrote it, under the title: the player is where somebody listens for
  // hours, and the title alone does not say where the book came from
  $('#pAuthor').textContent = book.author || '';
  maybe('#pGenre', (el) => {
    el.textContent = book.genre || '';
    el.dataset.genre = book.genre || '';
    el.title = book.genre ? `Everything in ${book.genre}` : '';
    el.hidden = !book.genre;
  });
  maybe('#trackSelect', (el) => { el.innerHTML = book.tracks.map((t, i) => `<option value="${i}">${i + 1}. ${esc(t.title)}</option>`).join(''); });
  // a saved track index can outlive the files it pointed at
  const said = carried ? carried.track : (book.progress ? book.progress.track_idx : 0);
  const at = Math.max(0, Math.min(said, book.tracks.length - 1));
  // On a phone this is where the press ends: the book is known, its place is
  // known, and the player page is where it is listened to. A book arriving in a
  // carry is not a press and is already home.
  if (!carried && goesToPlayer()
    && handOver(id, at, book.progress ? book.progress.position : 0)) return;
  // whether a carried book plays again is for the page it arrived on to decide,
  // once it knows whether it was playing when it left the last one
  playTrack(at, carried ? carried.position : (book.progress ? book.progress.position : 0), !carried);
};

function playTrack(idx, position = 0, andPlay = true) {
  const t = state.book.tracks[idx];
  if (!t) return;
  state.track = idx;
  maybe('#trackSelect', (el) => { el.value = idx; });
  $('#pTrack').textContent = `${idx + 1}/${state.book.tracks.length} · ${t.title}`;
  drawSteps();
  audio.src = `/api/stream/${t.id}`;
  audio.onloadedmetadata = () => { if (position) audio.currentTime = position; };
  if (andPlay) audio.play().catch(() => {});
}

// Whatever offers to play the book that is playing says what pressing it will do
// now — the card in the library, and the tile on the shelf — and everything else
// still says Play. The Home Assistant page has neither, and these find nothing.
// Sounding here, or — with a speaker chosen in the bar — on that speaker
// (2.14.347): the cards said Resume while the speaker played the book.
let sounding = () => !audio.paused;
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
      ? (!sounding() ? '▶ Resume' : '⏸ Pause')
      : (again ? '▶ Play again' : kept ? '▶ Resume' : '▶ Play');
    button.classList.toggle('playing', mine && sounding());
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
    cover.dataset.glyph = mine && sounding() ? '⏸' : '▶';
    cover.classList.toggle('playing', !!mine && sounding());
  });
}

// The cover in the bar. On a wide screen it is a third way to start and stop
// the book, which is useful there and is how every other cover in the app
// behaves. On a phone it is the **way to the player**: The owner counted three
// play/pause buttons on one screen — the card's, the bar's, and this — and he
// was right that it is too many. One of them had to become something else, and
// the cover is the one that already looks like a thing you tap to see the book
// rather than a thing you tap to stop it.
//
// Asked of the window's width at the moment of the tap, not of a flag worked
// out at load: a phone that is turned on its side is a wider screen, and the
// breakpoint is the stylesheet's own.
const narrow = () => window.matchMedia('(max-width: 720px)').matches;
maybe('#pCover', (el) => {
  el.onclick = () => {
    if (!state.book) return;
    if (narrow()) { location.href = '/player'; return; }
    if (audio.paused) audio.play().catch(() => {}); else audio.pause();
  };
});

// Nothing is being listened to any more, so the bar has nothing to say and goes.
// The place is written down first — putting the player away is not losing where
// you were — and the carried book goes with it: `pagehide` only writes a carry
// while a book is loaded, so an old one left in sessionStorage would have the
// next page of the app pick the book straight back up and put the bar back.
// Paused is not this: a book you stopped for a moment is still the book you are
// listening to, and the bar is how you carry on with it.
function closePlayer() {
  saveProgress();
  audio.pause();
  state.book = null;
  maybe('#player', (el) => { el.hidden = true; });
  sessionStorage.removeItem(CARRY);
  markPlaying();
}
maybe('#pClose', (el) => { el.onclick = closePlayer; });

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

// How far into the *book*, not into the file that happens to be playing. A book
// is usually many files, and a bar that fills up and starts again five times
// says nothing about the book: it is the mistake the tiles made in 2.1.48, the
// other way round. The track lengths arrive with the book, so the ones before
// this track are how far in it starts.
//
// Returns null when the sum cannot be trusted — a book of one file, where the
// two are the same thing anyway, or a track whose length the scan never read
// (an unreadable file reports 0). One missing length makes the total a lie, and
// the bar then shows the one thing still certainly true: where you are in this
// file. The numbers beside it say which of the two is being shown.
const bookTime = () => {
  const tracks = (state.book && state.book.tracks) || [];
  if (tracks.length < 2) return null;
  let behind = 0;
  let total = 0;
  for (let i = 0; i < tracks.length; i++) {
    const d = Number(tracks[i].duration);
    if (!isFinite(d) || d <= 0) return null;
    if (i < state.track) behind += d;
    total += d;
  }
  return { behind, total, tracks };
};

// Which file holds a given second of the book, and how far into that file it
// falls. Walks rather than divides, because the files are not the same length.
// The last track keeps whatever is left over, so a second past the end of the
// book lands at the end of the book and not in a track that is not there.
const trackAt = (seconds, tracks) => {
  let left = Math.max(0, Number(seconds) || 0);
  let idx = 0;
  while (idx < tracks.length - 1 && left >= Number(tracks[idx].duration)) {
    left -= Number(tracks[idx].duration);
    idx++;
  }
  return { idx, offset: left };
};

// How long is left, in the time it will actually take. The length of the book
// beside it stays the length of the book — that is a fact about the recording —
// but what is left is a question about the listener, and somebody reading at
// 1.5× has two thirds of it to sit through. Asked of `playbackRate` rather than
// of the setting, so it says what the engine is really doing.
//
// Shown beside wherever the speed is chosen: on `/player` a line of its own
// between the two clocks, and in the bar on a wide screen next to the speed
// pulldown. A phone's bar has neither — the speed lives on `/player` there —
// so the length carries it as a tooltip as well.
const howLong = (s) => {
  const m = Math.round(s / 60);
  if (m < 1) return 'under a minute';
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
};
const drawLeft = (at, total) => {
  const rate = audio.playbackRate > 0 ? audio.playbackRate : 1;
  const left = isFinite(total) && total > 0 ? Math.max(0, total - at) / rate : NaN;
  const says = !isFinite(left) ? ''
    : `${howLong(left)} left${Math.abs(rate - 1) > 0.001 ? ` at ${rate.toFixed(1)}×` : ''}`;
  maybe('#pLeft', (el) => { el.textContent = says; });
  $('#pOf').title = says ? `${says} · the book is ${clock(total)} long` : '';
};

// The genre beside the author, and a way into it. On a page with the library's
// columns it opens the genre there and then. `/player` and `/ha` have none, so
// it is written down and the shelves open on it — `openGenreAsked` in
// `browse.js` reads it once they have loaded. The book is carried across the
// way every move between pages carries it.
const goToGenre = (genre) => {
  if (!genre) return;
  if (typeof window.selectGenre === 'function' && document.querySelector('#genres')) {
    const li = [...document.querySelectorAll('#genres li[data-name]')].find((l) => l.dataset.name === genre);
    window.selectGenre(genre, li);
    return;
  }
  try { sessionStorage.openGenre = genre; } catch { /* nowhere to keep it: the shelves open as they are */ }
  location.href = '/';
};
maybe('#pGenre', (el) => {
  // the bar itself is a way to `/player` on a phone, and this is not that
  el.onclick = (e) => { e.stopPropagation(); goToGenre(el.dataset.genre); };
});

let dragging = false;
const drawTime = () => {
  const book = bookTime();
  const total = book ? book.total : audio.duration;
  const at = book ? book.behind + (audio.currentTime || 0) : audio.currentTime;
  $('#pAt').textContent = clock(at);
  $('#pOf').textContent = isFinite(total) ? clock(total) : '—';
  drawLeft(at, total);
  if (dragging) return;
  const f = isFinite(total) && total > 0 ? at / total : 0;
  $('#seek').value = String(Math.round(f * 1000));
  paint($('#seek'), f);
};
audio.addEventListener('timeupdate', drawTime);
audio.addEventListener('durationchange', drawTime);
audio.addEventListener('loadedmetadata', drawTime);
audio.addEventListener('emptied', drawTime);
// a new speed changes what is left at once, not at the next timeupdate — which
// never comes while the book is paused
audio.addEventListener('ratechange', drawTime);

// Dragging the bar now means a place in the book, so it may land in another
// file: walk the tracks until the seconds left fit inside one, and load it at
// that offset. Whether it then plays is whatever it was doing before — seeking
// a paused book is still a paused book.
const seekTo = () => {
  const f = Number($('#seek').value) / 1000;
  paint($('#seek'), f);
  const book = bookTime();
  if (!book) {
    if (isFinite(audio.duration)) audio.currentTime = f * audio.duration;
    return;
  }
  // half a second short of the end, so dragging to the far right lands inside
  // the last track rather than on the edge that ends the book
  const target = Math.max(0, Math.min(f * book.total, book.total - 0.5));
  const { idx, offset } = trackAt(target, book.tracks);
  if (idx === state.track) { audio.currentTime = offset; return; }
  playTrack(idx, offset, !audio.paused);
};
$('#seek').oninput = () => { dragging = true; paint($('#seek'), Number($('#seek').value) / 1000); };
$('#seek').onchange = () => { dragging = false; seekTo(); };

$('#pPlay').onclick = () => {
  if (!state.book) return;
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
};
// What the button does next, in a word as well as a glyph. A lone ⏸ in a box is
// readable once you know the bar; the word is what makes it the obvious control
// on a screen where it is the only one — and *Resume* rather than *Play* when
// there is a place to carry on from, which is the thing the reader is actually
// about to do.
const drawPlay = () => {
  const playing = !audio.paused;
  const word = playing ? 'Pause' : (audio.currentTime > 0 ? 'Resume' : 'Play');
  // The word in a span of its own, so a screen can leave it out. The bar needs
  // it — a lone ⏸ in a row of controls has to be recognised — and `/player`
  // does not: there the button is round, in the middle, and the only thing on
  // the screen that could be pressed.
  $('#pPlay').innerHTML = `<span class="glyph">${playing ? '⏸' : '▶'}</span><span class="word">${word}</span>`;
  $('#pPlay').classList.toggle('playing', !audio.paused);
  // And the bar's own cover. On a wide screen it is the same button, and the
  // glyph says what a tap will do, the way every other cover in the app does.
  // On a phone it is the way to `/player`, so it says *that* instead — a ⏸ on
  // something that does not pause is worse than no glyph at all.
  const cover = $('#pCover')?.parentElement;
  if (cover && cover.classList.contains('cover')) {
    cover.dataset.glyph = narrow() ? '⤢' : (audio.paused ? '▶' : '⏸');
    cover.classList.toggle('playing', narrow() ? false : !audio.paused);
  }
};
audio.addEventListener('play', drawPlay);
audio.addEventListener('pause', drawPlay);
audio.addEventListener('ended', drawPlay);

// volume, kept per browser: the one thing the native controls did that a page
// cannot get back by itself
// --- how fast it is read --------------------------------------------------
//
// Kept per browser like the volume, because it is a thing about the listener
// and not about the book: somebody who reads at 1.4 reads everything at 1.4.
// It has to be set again on every track, because `playbackRate` belongs to the
// element's current source and a new `src` puts it back to 1 — which is why a
// book used to drop back to normal speed at every chapter.
//
// 1.0 to 2.0 in tenths. Nothing below 1: a book read slower than it was
// recorded is a book read wrong, and nobody has ever asked for it.
const SPEED = 'speed';
const SPEEDS = Array.from({ length: 11 }, (_, i) => (1 + i / 10).toFixed(1));
const speedWanted = () => {
  const said = Number(localStorage[SPEED]);
  return SPEEDS.includes(said.toFixed(1)) ? said : 1;
};
const applySpeed = () => { audio.playbackRate = speedWanted(); };
maybe('#pSpeed', (el) => {
  el.innerHTML = SPEEDS.map((s) => `<option value="${s}">${s}×</option>`).join('');
  el.value = speedWanted().toFixed(1);
  el.onchange = () => {
    localStorage[SPEED] = el.value;
    applySpeed();
    toast(`Reading at ${el.value}× speed.`);
  };
});
// A new source starts at 1, so this runs on every one rather than once.
audio.addEventListener('loadedmetadata', applySpeed);
audio.addEventListener('play', applySpeed);
applySpeed();

const VOL = 'volume';
// The volume is kept per browser whether or not the page draws a slider for it:
// `/player` has none, and a book opened there still plays at the volume the
// reader last chose somewhere else.
audio.volume = Math.min(1, Math.max(0, Number(localStorage[VOL] ?? 1)));
maybe('#vol', (el) => { el.value = String(Math.round(audio.volume * 100)); paint(el, audio.volume); });
const drawVol = () => {
  maybe('#pVolBtn', (el) => { el.textContent = audio.muted || !audio.volume ? '🔇' : '🔊'; });
  maybe('#vol', (el) => paint(el, audio.muted ? 0 : audio.volume));
};
maybe('#vol', (el) => {
  el.oninput = () => {
    audio.muted = false;
    audio.volume = Number(el.value) / 100;
    localStorage[VOL] = String(audio.volume);
    drawVol();
  };
});
maybe('#pVolBtn', (el) => { el.onclick = () => { audio.muted = !audio.muted; drawVol(); }; });
drawVol();
drawPlay();
drawTime();

audio.addEventListener('play', markPlaying);
audio.addEventListener('pause', markPlaying);
audio.addEventListener('ended', markPlaying);

maybe('#trackSelect', (el) => { el.onchange = (e) => playTrack(Number(e.target.value)); });

// A chapter back and a chapter on, for the page that has no pulldown. Back from
// the first and on from the last do nothing rather than wrapping round: a book
// is read in one direction, and landing on chapter 35 from chapter 1 is never
// what somebody meant. Whether it plays afterwards is what it was doing before.
const step = (by) => {
  if (!state.book) return;
  const to = state.track + by;
  if (to < 0 || to >= state.book.tracks.length) return;
  playTrack(to, 0, !audio.paused);
};
maybe('#pPrev', (el) => { el.onclick = () => step(-1); });
maybe('#pNext', (el) => { el.onclick = () => step(1); });

// Ten seconds back and ten on — the length of the sentence you just missed,
// which is what these are always for.
//
// Through the *book*, not the file: ten seconds back from a minute into chapter
// eight is the end of chapter seven, and a reader who meant "say that again"
// does not care where the file boundary fell. The same walk `seekTo` does when
// the bar is dragged, so the two cannot disagree about where a second is.
const nudge = (by) => {
  if (!state.book) return;
  const book = bookTime();
  if (!book) {
    audio.currentTime = Math.max(0, (audio.currentTime || 0) + by);
    return;
  }
  const target = Math.max(0, Math.min(book.behind + (audio.currentTime || 0) + by, book.total - 0.5));
  const { idx, offset } = trackAt(target, book.tracks);
  if (idx === state.track) { audio.currentTime = offset; drawTime(); return; }
  playTrack(idx, offset, !audio.paused);
};
maybe('#pBack10', (el) => { el.onclick = () => nudge(-10); });
maybe('#pFwd10', (el) => { el.onclick = () => nudge(10); });

// and they go dim at the ends, so the page says where it is in the book
const drawSteps = () => {
  const n = state.book ? state.book.tracks.length : 0;
  maybe('#pPrev', (el) => { el.disabled = !n || state.track <= 0; });
  maybe('#pNext', (el) => { el.disabled = !n || state.track >= n - 1; });
};
// The last track running out is the end of the book: it has been listened to, and
// the tick has to say so — the counts, the shelves and the Listened section all
// read the tick. Any other track just leads into the next one.
audio.onended = () => {
  if (state.book && state.track >= state.book.tracks.length - 1) return finishedListening();
  return playTrack(state.track + 1);
};

async function finishedListening() {
  const id = state.book.id;
  // it has run out: there is nothing left to carry on with, so the bar goes the
  // same way it does when it is put away by hand. This saves the place too, and
  // it happens before the returns below, so a book that runs out with nobody
  // named does not leave a dead bar standing.
  closePlayer();
  if (!state.user) return;
  // played: the last track ran out, which is what counts towards a level — a
  // tick pressed by hand does not
  let said;
  try { said = await post('/api/listened', { user: state.user, bookId: id, done: true, played: true }); } catch { return; }
  // reaching a level is worth saying to the person who reached it
  if (said && said.level && said.level.name) {
    toast(`${said.level.icon} ${said.level.name} — ${said.level.finished} books finished.`);
    if (typeof whoAmI === 'function') whoAmI();
  }
  // the card of that book, if it happens to be on screen, without a redraw
  const tick = document.querySelector(`.card .listened input[onchange*="setListened(${id},"]`);
  if (tick) {
    tick.checked = true;
    const card = tick.closest('.card');
    const note = card.querySelector('.note');
    if (note) { note.className = 'note done'; note.title = 'Listened'; }
    // and its button is the one that has to say what pressing it does now. While
    // the bar stood there it was the thing you would have gone back to; with the
    // bar gone, a book you have just finished is one to play again — never a
    // Resume, which would mean the last seconds of it.
    const play = card.querySelector('.actions button[onclick^="playBook"]');
    if (play) play.dataset.again = '1';
  }
  // the pages with lists of their own redraw them; the Home Assistant page has
  // neither, and is not asked for what it does not have
  if (typeof loadStats === 'function') loadStats();
  if (typeof loadListened === 'function') loadListened();
  markPlaying();
}

// --- what is playing, for whoever is being told about it ------------------
// Only the changes, and only from here: a position arriving every ten seconds
// says somebody is listening, never that they just pressed play. The server
// decides what to do with it — today that is a line in Discord, if one is set up.
let announced = 0;
const nowPlaying = (on, how) => {
  const id = state.book ? state.book.id : announced;
  if (!id) return;
  if (on && announced === id) return;
  if (!on && announced !== id) return;
  announced = on ? id : 0;
  post('/api/playing', { bookId: id, playing: on, how }).catch(() => {});
};
audio.addEventListener('play', () => nowPlaying(true));
audio.addEventListener('pause', () => { if (!audio.ended) nowPlaying(false, 'paused'); });
audio.addEventListener('ended', () => {
  // the last track running out is the end of the book; any other leads into the
  // next one and is not a stop
  if (state.book && state.track >= state.book.tracks.length - 1) nowPlaying(false, 'finished');
});
window.addEventListener('pagehide', () => { if (announced) nowPlaying(false, 'left the page'); });

// an event object is the first argument of a handler, and would read as "leaving"
audio.onpause = () => saveProgress();
setInterval(() => { if (!audio.paused) saveProgress(); }, 10000);

// The place this book is at on the server, taken up again by this tab.
//
// Called by `browse.js` when the page comes back to the foreground, which is
// when somebody has been listening on their phone and has come back to the
// desktop. Only while this tab is paused: a tab that is still playing is the one
// moving the place, and taking the server's would drag it backwards.
//
// This matters before a press, not after. `playBook` short-circuits for the book
// already in the bar and plays from this tab's own `currentTime` — so a desktop
// left open and paused would resume at its own stale place and write that back
// over the phone's. Picking the place up here is what stops that.
window.placeMayHaveMoved = async () => {
  if (!state.book || !audio.paused) return;
  const fresh = await api(`/api/books/${state.book.id}`).catch(() => null);
  const place = fresh && fresh.progress;
  if (!place) return;
  const here = { idx: state.track, at: audio.currentTime || 0 };
  const there = { idx: place.track_idx || 0, at: place.position || 0 };
  // A second either way is the same place said twice — this tab wrote it a
  // moment ago — and seeking on that would fight the player's own saves.
  if (there.idx === here.idx && Math.abs(there.at - here.at) < 2) return;
  state.book = fresh;
  // not played: the reader came back to the page, which is not a press
  playTrack(there.idx, there.at, false);
  toast('Picked up where you left off elsewhere.');
};

function saveProgress(leaving) {
  if (!state.book || !state.user || !audio.currentTime) return;
  // With a speaker chosen the server keeps the speaker's place (2.14.358): this
  // tab's own, from before the speaker started, wrote it back on leaving the page.
  if (remote.player) return;
  const place = { user: state.user, bookId: state.book.id, trackIdx: state.track, position: audio.currentTime };
  // On the way out of a page an ordinary request is cancelled along with the
  // document that made it. A beacon outlives it, which is the difference
  // between keeping the place and losing it at every switch between pages.
  if (leaving && navigator.sendBeacon) {
    navigator.sendBeacon('/api/progress', new Blob([JSON.stringify(place)], { type: 'application/json' }));
    return;
  }
  post('/api/progress', place).catch(() => {});
}

// --- carried from one page of the app to the next -----------------------
// sessionStorage, not localStorage: this is one tab carrying on where it was,
// not every window in the browser starting to play.
//
// It carries **who** as well as what. A tab outlives a sign-in: Mario listens,
// signs out, Luigi signs in at the same tab and refreshes — and the player came
// back holding Mario's book at Mario's position, because the carry belonged to
// the tab and nothing in it said whose it was. A private window made no
// difference, sessionStorage being per tab rather than per person. Worse than
// showing it: pressing play would then have written Mario's place into Luigi's
// progress for that book.
const CARRY = 'carrying';

// Somebody else's, or from before this carried a name at all. Either way it is
// not ours to pick up, and not ours to keep — the server has the real position,
// so nothing is lost by dropping it.
const dropCarry = () => { try { sessionStorage.removeItem(CARRY); } catch { /* private window */ } };
window.dropCarry = dropCarry;

// Starting a book on a phone *is* going to the player page.
//
// `/player` existed but nothing took anybody there except tapping the cover in
// the bar, which meant a reader who pressed Play on a card stayed on the shelf
// with the cramped bar at the bottom — the thing the separate page was built to
// replace. The owner pressed play on his phone and did not see it, which is the
// whole of the bug.
//
// It goes through the carry rather than through the address: the carry is
// already how a book crosses from one page to the next, and writing it here
// means `/player` picks the book up by the same route as every other page,
// playing included. Nothing is started on the page being left, so there is no
// blip of sound on the way out; `playing: true` is what tells the player page
// to start it on arrival, and `pickUp` already says so politely if the browser
// refuses to make a sound for a page it was not clicked into.
//
// A tab with no sessionStorage to write would be sent to a player page that
// could not know what to play, so it says it failed and the caller plays here
// instead. The page being left must not then overwrite the carry with what it
// honestly sees — a book sitting paused — hence `handingOver`.
let handingOver = false;
const goesToPlayer = () => narrow() && !location.pathname.startsWith('/player');
const handOver = (id, track, position) => {
  try {
    sessionStorage[CARRY] = JSON.stringify({ who: state.user, id, track, position, playing: true });
  } catch { return false; /* a tab that cannot carry is better off playing here */ }
  handingOver = true;
  location.href = '/player';
  return true;
};

// pagehide rather than beforeunload: it is the one a phone browser can be
// relied on to send when the page goes away.
window.addEventListener('pagehide', () => {
  saveProgress(true);
  if (handingOver || !state.book) return;
  sessionStorage[CARRY] = JSON.stringify({
    who: state.user,
    id: state.book.id,
    track: state.track,
    position: audio.currentTime,
    playing: !audio.paused && !audio.ended,
  });
});

// Whose carry it is, asked of the **server** rather than of this tab.
//
// `state.user` is seeded from `localStorage` before anything is asked, so it
// holds the *previous* reader's name until a page signs in — and comparing the
// carry against that would have it agree with itself. Asking also means this
// works on every page that loads the player, however that page boots: `/ha`
// loads `player.js` without `account.js`, so anything hung off the listening
// pages' `started()` would have quietly stopped the book carrying to the Home
// Assistant page, which is a thing `plays-on` checks and found.
// Once per page, however many things ask. It is called at load and again from
// `started()`, for the sign-in that happens without one — and two runs racing
// each other both call `playBook` on the same book, the second re-seeking the
// first to the carried position after it had already moved on. That is what
// `/ to /admin: it carried on from where it was` caught on the build machine,
// where the two are far enough apart to collide.
let pickingUp = false;

async function pickUp() {
  if (pickingUp) return;
  const said = sessionStorage[CARRY];
  if (!said) return;
  let carried;
  try { carried = JSON.parse(said); } catch { return dropCarry(); }
  const me = await api('/api/account/me').catch(() => null);
  const who = (me && me.name) || '';
  // Nobody signed in — the sign-in gate. Not ours to take and **not ours to
  // throw away**: the person about to sign in may be the one who left it, and
  // dropping it here would lose their own book on the way back in. `started()`
  // asks again once there is a name.
  if (!who) return;
  if (carried.who !== who) return dropCarry();
  pickingUp = true;
  // the book may have been deleted from the collection while this tab was open
  try { await playBook(carried.id, carried); } catch { return; }
  if (!carried.playing) return;
  // The click that brought the reader here is what lets this page make a sound;
  // arriving any other way — a typed address, a refresh — it may be refused, and
  // then the player is loaded and waiting rather than silently doing nothing.
  audio.play().catch((e) => toast(e.name === 'NotAllowedError'
    ? 'Press ▶ to carry on: this browser would not let the page start the sound by itself.'
    : `It could not carry on playing: ${e.name}`));
}

window.pickUp = pickUp;
// At load, on every page that has a player. It asks the server who this is
// before it takes anything, so the moment it runs no longer matters.
pickUp();

// --- where it plays: this browser, or a speaker Home Assistant knows -------
//
// Asked for by the owner (2.14.248): a pulldown in the bar, on a wide screen only,
// that sends the book to one of HA's media players instead of this tab — with one
// of them kept as the favourite, chosen first every time the page opens. It is
// there only while the app is connected to HA; without it there is nothing to
// pick from, and a pulldown with one entry is clutter.
//
// With a speaker chosen, this tab makes no sound of its own: whatever would start
// the <audio> element — the bar's button, a card's Resume, the cover — is caught
// on its way to playing and sent to the speaker instead, from the track and second
// the bar is at. Pressed again, it pauses or carries on the speaker.
const FAVOURITE = 'haFavourite';
const remote = { player: '', state: '', book: 0, poll: null };
const favourite = () => { try { return localStorage.getItem(FAVOURITE) || ''; } catch { return ''; } };

sounding = () => (remote.player ? remote.state === 'playing' : !audio.paused);
function drawRemote() {
  markPlaying();
  if (!remote.player) return drawPlay();
  const playing = remote.state === 'playing';
  const word = playing ? 'Pause' : (remote.book && remote.state === 'paused' ? 'Resume' : 'Play');
  $('#pPlay').innerHTML = `<span class="glyph">${playing ? '⏸' : '▶'}</span><span class="word">${word}</span>`;
  $('#pPlay').classList.toggle('playing', playing);
  drawWhere();
}

// The list of speakers is the app's own rather than a <select> (2.14.292): the
// owner asked for a star beside every speaker, and a native pulldown cannot hold
// a button in a row. The hidden <select> stays as the one place the choice lives.
function drawWhere() {
  const pick = $('#pWhere');
  if (!pick) return;
  const fav = favourite();
  const name = (o) => `${o.value && o.value === fav ? '★ ' : ''}${o.dataset.name}`;
  $('#pWhereBtn').textContent = `${name(pick.selectedOptions[0])} ▾`;
  $('#pWhereList').innerHTML = [...pick.options].map((o) => `<li${o.value === pick.value ? ' class="on"' : ''}>
      <button class="name" data-v="${esc(o.value)}">${esc(o.dataset.name)}</button>
      ${o.value ? `<button class="star${o.value === fav ? ' fav' : ''}" data-v="${esc(o.value)}"
        title="${o.value === fav ? 'The favourite — press to stop it being one' : 'Make this the favourite'}">${o.value === fav ? '★' : '☆'}</button>` : ''}
    </li>`).join('');
}

async function lookAtSpeaker() {
  if (!remote.player) return;
  const st = await api(`/api/ha/speaker?player=${encodeURIComponent(remote.player)}`).catch(() => null);
  if (!st) return;
  remote.state = st.state;
  if (st.state !== 'playing' && st.state !== 'paused') remote.book = 0;
  else if (st.bookId) {
    remote.book = st.bookId;
    await followSpeaker(st);
  }
  drawRemote();
}

// The bar shows the book the speaker plays and where it is in it (2.14.380), also
// when the speaker was started from HA: loaded here, never played here.
async function followSpeaker({ bookId, track = 0, position = 0 }) {
  if (!state.book || state.book.id !== bookId) {
    await window.playBook(bookId, { track, position }).catch(() => {});
    return;
  }
  if (state.track !== track) return playTrack(track, position, false);
  try {
    if (Math.abs((audio.currentTime || 0) - position) >= 2) audio.currentTime = position;
  } catch { /* not loaded yet: the next look sets it */ }
}

// The press itself: send the book, or pause and carry on the one already sent.
async function pressRemote() {
  if (!state.book) return;
  const id = state.book.id;
  try {
    if (remote.book === id && remote.state === 'playing') {
      await post('/api/ha/speaker/control', { player: remote.player, action: 'pause' });
      remote.state = 'paused';
    } else if (remote.book === id && remote.state === 'paused') {
      await post('/api/ha/speaker/control', { player: remote.player, action: 'play' });
      remote.state = 'playing';
    } else {
      // the speaker may have played on without this tab (its own button): start
      // from the server's place, not from this tab's stale one
      await window.placeMayHaveMoved();
      const r = await post('/api/ha/speaker/play', {
        player: remote.player, bookId: id, from: state.track || 0, seek: Math.round(audio.currentTime || 0),
        speed: speedWanted(), // played at that speed by the app (2.14.325)
      });
      remote.book = id;
      remote.state = 'playing';
      toast(`Playing on ${$('#pWhere').selectedOptions[0]?.dataset.name || r.player}.`);
    }
  } catch (e) {
    toast(e.message);
  }
  drawRemote();
}

function useWhere(player) {
  remote.player = player;
  remote.book = 0;
  remote.state = '';
  clearInterval(remote.poll);
  if (player) {
    audio.pause();
    remote.poll = setInterval(lookAtSpeaker, 5000);
    lookAtSpeaker();
  }
  drawRemote();
  drawWhere();
}

// A new speed while a speaker plays reaches the speaker too (2.14.325): the app
// starts the track again at that speed, from where the speaker had got to.
// The server keeps the speed too (2.14.336), so a book started from Home
// Assistant plays at it and a speaker playing for this listener follows a change.
const tellSpeed = (apply) => (state.user || remote.player
  ? post('/api/speed', { speed: speedWanted(), apply, player: remote.player }).catch(() => null) : null);
maybe('#pSpeed', (el) => el.addEventListener('change', async () => {
  const r = await tellSpeed(true);
  // said, with how long it took: a switch that is slow shows up here (2.14.380)
  if (r?.restarted?.length) toast(`The speaker plays at ${r.speed}× now (switched in ${Math.round(r.took / 1000)} s).`);
}));
// and once on opening, for a speed chosen before the server kept it — kept only,
// so opening the page on another device does not change what a speaker is doing
setTimeout(() => tellSpeed(false), 2000);

// whatever starts this tab's sound while a speaker is chosen goes to the speaker
audio.addEventListener('play', () => {
  if (!remote.player) return;
  audio.pause();
  pressRemote();
});
const ownPress = $('#pPlay').onclick;
$('#pPlay').onclick = () => (remote.player ? pressRemote() : ownPress());

async function offerSpeakers() {
  const bar = $('#player');
  if (!bar || location.pathname.startsWith('/player') || narrow()) return;
  const said = await api('/api/ha/speakers').catch(() => null);
  if (!said || !said.connected || !said.players.length) return;
  const box = document.createElement('span');
  box.id = 'pWhereBox';
  box.className = 'where';
  box.innerHTML = `<select id="pWhere" hidden>
      <option value="" data-name="This browser">This browser</option>
      ${said.players.map((p) => `<option value="${esc(p.entity_id)}" data-name="${esc(p.name)}">${esc(p.name)}</option>`).join('')}
    </select><button id="pWhereBtn" class="ghost" title="Where the book plays"></button><ul id="pWhereList" hidden></ul>`;
  bar.insertBefore(box, $('#pGet') || null);
  const pick = $('#pWhere');
  const list = $('#pWhereList');
  const fav = favourite();
  if (fav && said.players.some((p) => p.entity_id === fav)) pick.value = fav;
  $('#pWhereBtn').onclick = (e) => { e.stopPropagation(); list.hidden = !list.hidden; };
  list.onclick = (e) => {
    e.stopPropagation();
    const b = e.target.closest('button');
    if (!b) return;
    if (b.classList.contains('star')) {
      try {
        if (favourite() === b.dataset.v) localStorage.removeItem(FAVOURITE);
        else localStorage.setItem(FAVOURITE, b.dataset.v);
      } catch { /* private window: it lasts as long as the page */ }
      return drawWhere();
    }
    pick.value = b.dataset.v;
    list.hidden = true;
    useWhere(pick.value);
  };
  document.addEventListener('click', () => { list.hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') list.hidden = true; });
  useWhere(pick.value);
}
offerSpeakers();
