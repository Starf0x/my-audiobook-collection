// The player, and it belongs to all three pages.
//
// The app is three documents — / , /admin and /ha — and moving between them
// throws the <audio> element away with the rest of the page. So the book being
// listened to is written down on the way out and picked up on the way in, and
// the player itself lives here rather than twice over in the page scripts.
//
// This file is loaded after the page's own script and leans on what that
// declares: $, api, post, toast, and a `state` object with user, book and
// track. The markup it drives is <footer id="player">, the same on every page.
const audio = $('#audio');

window.playBook = async function (id, carried) {
  // The same book again: the button that started it is the one that stops it —
  // unless it has run out, where pressing it means playing it again, and that has
  // to go through the loading below: it starts at the top and takes the tick off.
  // A book carried in from the previous page is not a press at all, so it never
  // takes this way out.
  if (!carried && state.book && state.book.id === id && !audio.ended) {
    if (audio.paused) audio.play().catch(() => {}); else audio.pause();
    return;
  }
  if (!state.user) return toast('Pick a name first.');
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
  $('#player').hidden = false;
  $('#pCover').src = `/api/cover/${id}?v=${book.coverV || 0}`;
  // every file of this book in one archive, which is what a download of an
  // audiobook means; the name comes from the server, so it is the book's
  $('#pGet').href = `/api/download/${id}`;
  $('#pTitle').textContent = book.title;
  $('#trackSelect').innerHTML = book.tracks.map((t, i) => `<option value="${i}">${i + 1}. ${esc(t.title)}</option>`).join('');
  // a saved track index can outlive the files it pointed at
  const said = carried ? carried.track : (book.progress ? book.progress.track_idx : 0);
  const at = Math.max(0, Math.min(said, book.tracks.length - 1));
  // whether a carried book plays again is for the page it arrived on to decide,
  // once it knows whether it was playing when it left the last one
  playTrack(at, carried ? carried.position : (book.progress ? book.progress.position : 0), !carried);
};

function playTrack(idx, position = 0, andPlay = true) {
  const t = state.book.tracks[idx];
  if (!t) return;
  state.track = idx;
  $('#trackSelect').value = idx;
  $('#pTrack').textContent = `${idx + 1}/${state.book.tracks.length} · ${t.title}`;
  audio.src = `/api/stream/${t.id}`;
  audio.onloadedmetadata = () => { if (position) audio.currentTime = position; };
  if (andPlay) audio.play().catch(() => {});
}

// Whatever offers to play the book that is playing says what pressing it will do
// now — the card in the library, and the tile on the shelf — and everything else
// still says Play. The Home Assistant page has neither, and these find nothing.
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
      ? (audio.paused ? '▶ Resume' : '⏸ Pause')
      : (again ? '▶ Play again' : kept ? '▶ Resume' : '▶ Play');
    button.classList.toggle('playing', mine && !audio.paused);
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
    cover.dataset.glyph = mine && !audio.paused ? '⏸' : '▶';
    cover.classList.toggle('playing', !!mine && !audio.paused);
  });
}

$('#pCover').onclick = () => {
  if (!state.book) return;
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
};

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

let dragging = false;
const drawTime = () => {
  const total = audio.duration;
  $('#pAt').textContent = clock(audio.currentTime);
  $('#pOf').textContent = isFinite(total) ? clock(total) : '—';
  if (dragging) return;
  const at = isFinite(total) && total > 0 ? audio.currentTime / total : 0;
  $('#seek').value = String(Math.round(at * 1000));
  paint($('#seek'), at);
};
audio.addEventListener('timeupdate', drawTime);
audio.addEventListener('durationchange', drawTime);
audio.addEventListener('loadedmetadata', drawTime);
audio.addEventListener('emptied', drawTime);

const seekTo = () => {
  const at = Number($('#seek').value) / 1000;
  paint($('#seek'), at);
  if (isFinite(audio.duration)) audio.currentTime = at * audio.duration;
};
$('#seek').oninput = () => { dragging = true; paint($('#seek'), Number($('#seek').value) / 1000); };
$('#seek').onchange = () => { dragging = false; seekTo(); };

$('#pPlay').onclick = () => {
  if (!state.book) return;
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
};
const drawPlay = () => {
  $('#pPlay').textContent = audio.paused ? '▶' : '⏸';
  $('#pPlay').classList.toggle('playing', !audio.paused);
};
audio.addEventListener('play', drawPlay);
audio.addEventListener('pause', drawPlay);
audio.addEventListener('ended', drawPlay);

// volume, kept per browser: the one thing the native controls did that a page
// cannot get back by itself
const VOL = 'volume';
audio.volume = Math.min(1, Math.max(0, Number(localStorage[VOL] ?? 1)));
$('#vol').value = String(Math.round(audio.volume * 100));
paint($('#vol'), audio.volume);
const drawVol = () => {
  $('#pVolBtn').textContent = audio.muted || !audio.volume ? '🔇' : '🔊';
  paint($('#vol'), audio.muted ? 0 : audio.volume);
};
$('#vol').oninput = () => {
  audio.muted = false;
  audio.volume = Number($('#vol').value) / 100;
  localStorage[VOL] = String(audio.volume);
  drawVol();
};
$('#pVolBtn').onclick = () => { audio.muted = !audio.muted; drawVol(); };
drawVol();
drawPlay();
drawTime();

audio.addEventListener('play', markPlaying);
audio.addEventListener('pause', markPlaying);
audio.addEventListener('ended', markPlaying);

$('#trackSelect').onchange = (e) => playTrack(Number(e.target.value));
// The last track running out is the end of the book: it has been listened to, and
// the tick has to say so — the counts, the shelves and the Listened section all
// read the tick. Any other track just leads into the next one.
audio.onended = () => {
  if (state.book && state.track >= state.book.tracks.length - 1) return finishedListening();
  return playTrack(state.track + 1);
};

async function finishedListening() {
  const id = state.book.id;
  saveProgress();
  if (!state.user) return;
  try { await post('/api/listened', { user: state.user, bookId: id, done: true }); } catch { return; }
  // the card of that book, if it happens to be on screen, without a redraw
  const tick = document.querySelector(`.card .listened input[onchange*="setListened(${id},"]`);
  if (tick) {
    tick.checked = true;
    const note = tick.closest('.card').querySelector('.note');
    if (note) { note.className = 'note done'; note.title = 'Listened'; }
  }
  // the pages with lists of their own redraw them; the Home Assistant page has
  // neither, and is not asked for what it does not have
  if (typeof loadStats === 'function') loadStats();
  if (typeof loadListened === 'function') loadListened();
  markPlaying();
}

// an event object is the first argument of a handler, and would read as "leaving"
audio.onpause = () => saveProgress();
setInterval(() => { if (!audio.paused) saveProgress(); }, 10000);

function saveProgress(leaving) {
  if (!state.book || !state.user || !audio.currentTime) return;
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
const CARRY = 'carrying';

// pagehide rather than beforeunload: it is the one a phone browser can be
// relied on to send when the page goes away.
window.addEventListener('pagehide', () => {
  saveProgress(true);
  if (!state.book) return;
  sessionStorage[CARRY] = JSON.stringify({
    id: state.book.id,
    track: state.track,
    position: audio.currentTime,
    playing: !audio.paused && !audio.ended,
  });
});

async function pickUp() {
  const said = sessionStorage[CARRY];
  if (!said) return;
  let carried;
  try { carried = JSON.parse(said); } catch { return; }
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

pickUp();
