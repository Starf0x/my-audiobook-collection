// The Home Assistant page: the address, the token, what gets published, and
// playing a book on one of HA's media players. The token only ever travels one
// way — the page can set it and forget it, and is never told what it is.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const api = async (url, opts) => {
  const r = await fetch(url, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
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

const state = { players: [], config: null };

const when = (iso) => {
  if (!iso) return 'never';
  const then = new Date(iso);
  const mins = Math.round((Date.now() - then.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  return then.toLocaleString();
};

async function load() {
  const c = await api('/api/ha/config').catch((e) => { toast(e.message); return null; });
  if (!c) return;
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
}

const save = (body) => post('/api/ha/config', body).then((c) => { state.config = c; return c; });

$('#haSave').onclick = () => work($('#haSave'), async () => {
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

$('#haPlayer').onchange = () => save({ player: $('#haPlayer').value }).catch((e) => toast(e.message));

// The continue queue, with a button per book. The seconds come from the same
// answer Home Assistant is given, so what plays is what the sensor says.
async function loadQueue() {
  const listener = $('#haListener').value;
  const s = await api(`/api/ha?user=${encodeURIComponent(listener)}`).catch(() => null);
  if (!s) return;
  const going = s.continue.filter((b) => !b.listened);
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
      toast(r.seeked
        ? `Playing on ${r.player}, ${r.seek} seconds into the track.`
        : `Playing on ${r.player}${r.seek ? ' — that player would not skip, so it starts at the track' : ''}.`);
    });
  });
}
$('#haListener').onchange = () => { save({ listener: $('#haListener').value }); loadQueue(); };
$('#haEvery').onchange = () => save({ every: $('#haEvery').value }).then(() => toast('Saved.'));

load();
