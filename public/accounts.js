// The accounts page: who may listen, what each of them has done, and the two
// ticks that decide what they are allowed.
//
// A page of its own rather than a list in the admin's book column, because it is
// the one view here that is read rather than browsed: a row per person with
// numbers on it wants width and stillness, and the column beside a library is
// neither. The Home Assistant page is a page for the same reason.
//
// The ticks are ticks and not buttons on purpose. *May listen* is a state
// somebody is in, not an action to take — and a checkbox says "this is how it
// stands" where a button says "press me and something happens".
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const api = async (url, opts) => {
  const r = await fetch(url, opts);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || r.statusText);
  return d;
};
const post = (url, body) => api(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
});

let toastTimer;
const toast = (text) => {
  $('#toast').textContent = text;
  $('#toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 4000);
};

$('#brand').onclick = () => { location.href = '/'; };
$('#toAdmin').onclick = () => { location.href = '/admin'; };
$('#toListen').onclick = () => { location.href = '/'; };

// How long ago, in the unit somebody actually thinks in.
const ago = (a) => {
  if (a.daysAgo === null) return 'never signed in';
  if (a.daysAgo === 0) return 'here today';
  if (a.daysAgo === 1) return 'yesterday';
  return `${a.daysAgo} days ago`;
};

const when = (iso) => (iso ? new Date(iso).toLocaleDateString() : '');

const row = (a) => `<div class="account" data-name="${esc(a.name)}">
    <div class="who">
      <div class="name">
        ${a.level.icon ? `<span class="badge-icon" title="${esc(a.level.name)}">${a.level.icon}</span>` : ''}
        <strong>${esc(a.name)}</strong>
        ${a.hasPassword ? '' : '<span class="badge untagged" title="A name from before accounts existed. Whoever signs in with it first chooses the password.">no password yet</span>'}
        ${a.state === 'denied' ? '<span class="badge untagged">cannot sign in</span>' : ''}
      </div>
      ${a.level.name ? `<div class="sub">${esc(a.level.name)}</div>` : ''}
      <div class="sub">Last here: ${esc(ago(a))}${a.signedIn ? ` · signed in on ${a.signedIn} browser(s)` : ''}</div>
      ${a.reason ? `<div class="sub said">“${esc(a.reason)}”<br>says they ${a.knowsAdmin ? 'know' : '<strong>do not know</strong>'} you${a.requestedAt ? ` · asked ${esc(when(a.requestedAt))}` : ''}</div>` : ''}
    </div>

    <div class="numbers">
      <div><strong>${a.completed}</strong><span>played to the end</span></div>
      <div><strong>${a.started}</strong><span>started</span></div>
      <div><strong>${a.finished}</strong><span>ticked</span></div>
      <div><strong>${a.hours}</strong><span>hours</span></div>
      <div><strong>${a.favourites}</strong><span>♥</span></div>
      <div><strong>${a.downloads.length}</strong><span>downloads</span></div>
    </div>

    <div class="allowed">
      <label class="pick" title="The approval. Off means they cannot sign in.">
        <input type="checkbox" data-may-listen ${a.state === 'approved' ? 'checked' : ''}> May listen
      </label>
      <label class="pick" title="${a.level.at >= 100
    ? 'They have earned this at the top level; this tick is beside that, not instead of it.'
    : 'Let them download whole books before they have earned it.'}">
        <input type="checkbox" data-may-download ${a.granted ? 'checked' : ''}> May download
        ${a.granted || !a.mayDownload ? '' : '<span class="sub">(earned)</span>'}
      </label>
      <button class="ghost danger" data-drop>Delete…</button>
    </div>

    ${a.downloads.length ? `<div class="took">
      <span class="sub">Downloaded:</span>
      ${a.downloads.map((d) => `<span class="badge">${esc(d.title || 'a book')} · ${esc(when(d.at))}</span>`).join(' ')}
    </div>` : ''}
  </div>`;

async function load() {
  let d;
  try {
    d = await api('/api/accounts');
  } catch (e) {
    // this page is the admin's; somebody else is sent where they belong
    if (/sign in|admin/i.test(e.message)) return location.replace('/');
    $('#everyone').innerHTML = `<p class="hint missing">${esc(e.message)}</p>`;
    return undefined;
  }
  const waiting = d.accounts.filter((a) => a.state === 'pending');
  const rest = d.accounts.filter((a) => a.state !== 'pending');

  $('#whoRuns').innerHTML = d.admin
    ? `You are <strong>${esc(d.admin)}</strong>, from the container. `
      + `${d.accounts.length} account(s) besides you.`
    : 'No <code>ADMIN_USER</code> is set on the container, so nothing is locked and '
      + 'anybody on your network can listen.';

  $('#waiting').hidden = !waiting.length;
  $('#waitingList').innerHTML = waiting.map(row).join('');
  $('#everyoneTitle').textContent = rest.length ? 'Everybody' : '';
  $('#everyone').innerHTML = rest.length ? rest.map(row).join('')
    : (waiting.length ? '' : '<p class="hint">Nobody has an account yet.</p>');
  wire();
  return undefined;
}

// One place that talks to the server for both ticks, so a refusal puts the tick
// back wherever it was pressed.
function wire() {
  document.querySelectorAll('.account').forEach((card) => {
    const name = card.dataset.name;
    const listen = card.querySelector('[data-may-listen]');
    const download = card.querySelector('[data-may-download]');

    listen.onchange = async () => {
      const on = listen.checked;
      try {
        await post(`/api/accounts/${encodeURIComponent(name)}/state`, { state: on ? 'approved' : 'denied' });
      } catch (e) {
        listen.checked = !on;
        return toast(e.message);
      }
      toast(on ? `${name} may listen.` : `${name} may not listen, and is signed out everywhere.`);
      return load();
    };

    download.onchange = async () => {
      const on = download.checked;
      try {
        await post(`/api/accounts/${encodeURIComponent(name)}/download`, { may: on });
      } catch (e) {
        download.checked = !on;
        return toast(e.message);
      }
      toast(on ? `${name} may download whole books.` : `${name} may not download.`);
      return load();
    };

    card.querySelector('[data-drop]').onclick = async () => {
      if (!confirm(`Delete the account “${name}”?\n\nEverything that was only about them `
        + 'goes with it: where they were in every book, what they had finished, what they had '
        + 'hearted, and every browser signed in as them. The books themselves are untouched.')) return;
      try { await post(`/api/accounts/${encodeURIComponent(name)}/remove`, {}); }
      catch (e) { return toast(e.message); }
      toast(`${name} is gone.`);
      return load();
    };
  });
}

load();
