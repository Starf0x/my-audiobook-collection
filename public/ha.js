// The Home Assistant page: the address, the token, what gets published, and
// playing a book on one of HA's media players. The token only ever travels one
// way — the page can set it and forget it, and is never told what it is.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const api = async (url, opts) => {
  const r = await fetch(url, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.error || `HTTP ${r.status}`), { status: r.status });
  return body;
};
const post = (url, body) => api(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
});

let toastTimer;
const toast = (text) => {
  $('#toast').textContent = text;
  $('#toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 5000);
};

// a button that is doing something says so, and cannot be pressed twice
const work = async (button, fn) => {
  const said = button.textContent;
  button.disabled = true;
  button.textContent = 'Working…';
  try {
    return await fn();
  } catch (e) {
    toast(e.message);
    return null;
  } finally {
    button.disabled = false;
    button.textContent = said;
  }
};

$('#brand').onclick = () => { location.href = '/'; };
$('#toAdmin').onclick = () => { location.href = '/admin'; };
$('#toListen').onclick = () => { location.href = '/'; };

// the last three are the player's, which this page carries like the other two:
// the name is the one the listening page remembered for this browser
const state = { players: [], config: null, user: localStorage.user || '', book: null, track: 0 };

const when = (iso) => {
  if (!iso) return 'never';
  const then = new Date(iso);
  const mins = Math.round((Date.now() - then.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  return then.toLocaleString();
};

// The saved settings, read before anything on the page can be saved over them.
// Right after an update the app is still restarting when this page reloads, and
// the read failed: the fields stayed as empty as the HTML has them, looking
// exactly like settings that were lost — so the owner typed them in again, every
// update (2.14.248). Now Save and Test wait until the read has worked, the page
// says it is still asking, and it asks again until the app answers.
let loaded = false;
const holdSaving = (on) => ['#haSave', '#haTest', '#haForget'].forEach((s) => { const b = $(s); if (b) b.disabled = on; });
async function load(tries = 0) {
  let refused = null;
  const c = await api('/api/ha/config').catch((e) => { refused = e; return null; });
  // Not a restart at all: this browser is not unlocked as the administrator — an
  // update restarts the app, and an unlock does not outlive that. Waiting would
  // say "starting" for ever (2.14.259); this says what to do instead.
  if (!c && refused && (refused.status === 401 || refused.status === 403)) {
    holdSaving(true);
    $('#tokState').innerHTML = '<strong class="warn">These settings are the administrator\'s.</strong> '
      + '<a href="/admin">Unlock as the administrator</a>, then come back to this page — '
      + 'the saved address and token are still there.';
    return;
  }
  // any other refusal is an answer, not a restart: show it rather than wait
  if (!c && refused && refused.status && ![502, 503, 504].includes(refused.status)) {
    holdSaving(true);
    $('#tokState').innerHTML = `<strong class="warn">The saved settings could not be read:</strong> ${esc(refused.message)}`;
    return;
  }
  if (!c) {
    if (!loaded) {
      holdSaving(true);
      $('#tokState').innerHTML = '<strong class="warn">Reading the saved settings — the app may still be starting…</strong>';
      if (tries < 40) setTimeout(() => load(tries + 1), 3000);
      else toast('The saved Home Assistant settings could not be read. Reload the page to try again.');
    }
    return;
  }
  loaded = true;
  holdSaving(false);
  state.config = c;
  $('#haUrl').value = c.url || '';
  $('#haEvery').value = String(c.every);
  $('#haWhere').textContent = `this app: ${c.base}`;
  $('#tokState').innerHTML = c.hasToken
    ? '<strong class="ok">A token is saved.</strong> Paste a new one to replace it.'
    : '<strong class="warn">No token yet.</strong>';
  $('#haListener').innerHTML = ['<option value="">— every listener at once —</option>']
    .concat(c.listeners.map((n) => `<option value="${esc(n)}"${n === c.listener ? ' selected' : ''}>${esc(n)}</option>`))
    .join('');
  const p = c.lastPush || {};
  // "only when I press Send" is the one setting that lets the sensors stay gone:
  // whichever side restarts, nothing puts them back until somebody is here
  const onlyByHand = !c.every
    ? ' <strong class="warn">Nothing is sent on its own, so after a restart of either side the '
      + 'sensors stay gone until you press Send.</strong>'
    : '';
  $('#pushState').innerHTML = (p.error
    ? `<strong class="warn">The last send failed:</strong> ${esc(p.error)}`
    : `Last sent: ${esc(when(p.at))}${p.entities ? ` · ${p.entities} sensors` : ''}`) + onlyByHand;
  if (c.player) {
    $('#haPlayer').innerHTML = `<option value="${esc(c.player)}">${esc(c.player)}</option>`;
    $('#haPlayer').value = c.player;
  }
  await loadQueue();
  await loadSensors();
}

// --- the sensors, ready to copy ------------------------------------------------
// Every entity this app writes into Home Assistant, by the id a dashboard card or
// an automation names it by, with its own copy button and one for the lot — one
// id to a line, which is what a card's `entities:` list takes. Asked of the same
// route as "Show what will be sent", so the list is the one that is sent: a
// sensor per listener comes and goes with the listeners.
async function loadSensors() {
  const rows = await api('/api/ha/entities').catch(() => null);
  if (!rows) {
    $('#haSensors').innerHTML = '<li class="hint">The list could not be read.</li>';
    return;
  }
  $('#haSensors').innerHTML = rows.map((r) => `<li>
      <code class="mono">${esc(r.entity)}</code>
      <span class="hint">${esc(r.attributes.friendly_name || '')}</span>
      <button class="ghost copy-one" data-copy="${esc(r.entity)}" title="Copy ${esc(r.entity)}">⧉</button>
    </li>`).join('') || '<li class="hint">Nothing to send yet.</li>';
  $('#haCopyAll').hidden = !rows.length;
  $('#haCopyAll').dataset.copy = rows.map((r) => r.entity).join('\n');
}

const copied = async (text, what) => toast((await toClipboard(text)) ? `Copied ${what}.` : 'The browser would not copy that.');
$('#haSensors').addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy]');
  if (b) copied(b.dataset.copy, b.dataset.copy);
});
$('#haCopyAll').onclick = () => copied($('#haCopyAll').dataset.copy || '',
  `${($('#haCopyAll').dataset.copy || '').split('\n').filter(Boolean).length} sensors`);

const save = (body) => post('/api/ha/config', body).then((c) => { state.config = c; return c; });

// A new address without a new token forgets the saved token — on purpose, so it
// is never sent to another machine. But the owner lost it after an update without
// ever changing the address (2.14.248): the field had been filled in by the
// browser. So it is said first, and the saved address stays unless they agree.
const addressKept = () => {
  const now = $('#haUrl').value.trim().replace(/\/+$/, '');
  const was = (state.config && state.config.url) || '';
  if (!was || now === was || $('#haTok').value.trim() || !(state.config && state.config.hasToken)) return true;
  if (confirm(`The address says ${now || '(nothing)'}, but ${was} is saved. Saving it forgets the token. Go ahead?`)) return true;
  $('#haUrl').value = was;
  return false;
};

$('#haSave').onclick = () => work($('#haSave'), async () => {
  if (!addressKept()) return;
  await save({
    url: $('#haUrl').value.trim(),
    token: $('#haTok').value.trim(),
    every: $('#haEvery').value,
    listener: $('#haListener').value,
  });
  $('#haTok').value = '';
  toast('Saved.');
  await load();
});

$('#haForget').onclick = () => work($('#haForget'), async () => {
  if (!confirm('Forget the saved token? Home Assistant will not be written to until a new one is pasted.')) return;
  await save({ token: '-' });
  toast('The token is gone from this app.');
  await load();
});

$('#haTest').onclick = () => work($('#haTest'), async () => {
  // save what is on screen first, or a token just pasted would not be tested
  if (!addressKept()) return;
  await save({ url: $('#haUrl').value.trim(), token: $('#haTok').value.trim() });
  $('#haTok').value = '';
  const r = await post('/api/ha/test');
  $('#haTestOut').innerHTML = `<p class="said ok">Talking to <strong>${esc(r.name || 'Home Assistant')}</strong>`
    + `${r.haVersion ? `, version ${esc(r.haVersion)}` : ''}. The token works.</p>`;
  await load();
  await refreshPlayers();
});

$('#haPreview').onclick = () => work($('#haPreview'), async () => {
  const rows = await api('/api/ha/entities');
  $('#haEntities').innerHTML = `<table class="cmp"><tr><th>Sensor</th><th>Value</th><th>Also carries</th></tr>`
    + rows.map((r) => `<tr><td class="mono">${esc(r.entity)}</td><td>${esc(r.state)}`
      + `${r.attributes.unit_of_measurement ? ' ' + esc(r.attributes.unit_of_measurement) : ''}</td>`
      + `<td class="hint">${esc(Object.keys(r.attributes)
        .filter((k) => !['friendly_name', 'icon', 'attribution', 'unit_of_measurement'].includes(k))
        .join(', ') || '—')}</td></tr>`).join('') + '</table>';
});

$('#haPush').onclick = () => work($('#haPush'), async () => {
  const r = await post('/api/ha/push');
  toast(`${r.entities.length} sensors written into Home Assistant.`);
  await load();
});

async function refreshPlayers() {
  const players = await api('/api/ha/players').catch((e) => { toast(e.message); return null; });
  if (!players) return;
  state.players = players;
  const chosen = $('#haPlayer').value || (state.config && state.config.player) || '';
  $('#haPlayer').innerHTML = players.length
    ? players.map((p) => `<option value="${esc(p.entity_id)}"${p.entity_id === chosen ? ' selected' : ''}>`
      + `${esc(p.name)} — ${esc(p.state)}${p.playing ? ` · ${esc(p.playing)}` : ''}</option>`).join('')
    : '<option value="">— Home Assistant knows no media players —</option>';
  await loadQueue();
}
$('#haRefreshPlayers').onclick = () => work($('#haRefreshPlayers'), refreshPlayers);

// A book playing on a speaker is not in this page's own player, so its Resume and
// Pause had no hold on it and there was no way to stop it from here (2.14.237).
// These act on the chosen player through HA; Stop also ends the app handing it
// the next track.
const control = (button, action, said) => work(button, async () => {
  const player = $('#haPlayer').value;
  if (!player) return toast('Pick a player first.');
  await post('/api/ha/control', { player, action });
  toast(said);
  await refreshPlayers();
});
$('#haPause').onclick = () => control($('#haPause'), 'pause', 'Paused.');
$('#haResume').onclick = () => control($('#haResume'), 'play', 'Carrying on.');
$('#haStop').onclick = () => control($('#haStop'), 'stop', 'Stopped.');

$('#haPlayer').onchange = () => save({ player: $('#haPlayer').value }).catch((e) => toast(e.message));

// The continue queue, with a button per book. The seconds come from the same
// answer Home Assistant is given, so what plays is what the sensor says.
async function loadQueue() {
  const listener = $('#haListener').value;
  const s = await api(`/api/ha?user=${encodeURIComponent(listener)}`).catch(() => null);
  if (!s) return;
  const going = s.listening;
  $('#haQueue').innerHTML = going.length ? `<table class="cmp">
      <tr><th>Book</th><th>Where</th><th></th></tr>
      ${going.map((b) => `<tr>
        <td>${esc(b.title)}<div class="hint">${esc(b.author)}${b.series ? ` · ${esc(b.series)}` : ''}</div></td>
        <td>track ${b.track} of ${b.tracks} · ${b.percent}%<div class="hint">${b.left_hours} h left</div></td>
        <td><button class="ghost" data-play="${b.id}" data-from="${b.track - 1}"
          data-seek="${b.position}">Play here</button></td>
      </tr>`).join('')}
    </table>` : '<p class="hint">Nothing to continue: no book has been started yet.</p>';
  $('#haQueue').querySelectorAll('button[data-play]').forEach((b) => {
    b.onclick = () => work(b, async () => {
      const r = await post('/api/ha/play', {
        player: $('#haPlayer').value,
        bookId: Number(b.dataset.play),
        from: Number(b.dataset.from),
        seek: Number(b.dataset.seek),
      });
      toast((r.seeked
        ? `Playing on ${r.player}, ${r.seek} seconds into the track.`
        : `Playing on ${r.player}${r.seek ? ' — that player would not skip, so it starts at the track' : ''}.`)
        // a player that queues has the rest of the book behind this track; one
        // that cannot is handed the next track by the app as each one ends
        + (r.queued ? ` The rest of the book, ${r.queued} tracks, is queued behind it.`
          : r.single ? ' The app gives it the next track each time one ends.' : ''));
    });
  });
}
$('#haListener').onchange = () => { save({ listener: $('#haListener').value }); loadQueue(); };
$('#haEvery').onchange = () => save({ every: $('#haEvery').value }).then(() => toast('Saved.'));

load();
