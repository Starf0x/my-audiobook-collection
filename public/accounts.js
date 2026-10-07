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

// How long ago, in the unit somebody actually thinks in — and then the date
// itself, because "12 days ago" is the right thing to read at a glance and the
// wrong thing to write down. The date was never on this page at all: the row
// knew it, said `daysAgo`, and threw the rest away.
//
// Today and yesterday get the time instead of the date. On those two the date is
// the thing already said, and the hour is what is actually being asked.
const ago = (a) => {
  if (a.daysAgo === null) return 'never signed in';
  const at = a.lastSeen ? new Date(a.lastSeen) : null;
  const near = at ? at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const far = at ? at.toLocaleDateString() : '';
  if (a.daysAgo === 0) return `here today${near ? ` at ${near}` : ''}`;
  if (a.daysAgo === 1) return `yesterday${near ? ` at ${near}` : ''}`;
  return `${a.daysAgo} days ago${far ? ` · ${far}` : ''}`;
};

const when = (iso) => (iso ? new Date(iso).toLocaleDateString() : '');

// The faces that keep a place in a book. Named here because a book on somebody's
// row that they do not recognise is almost always one of these: a player signs in
// as one listener and writes every position against that name, whoever is in the
// room. Rows kept before 2.10.72 carry nothing and are left unlabelled.
const VIA = { 'music-assistant': 'Music Assistant', 'home-assistant': 'Home Assistant' };

const row = (a) => `<div class="account" data-name="${esc(a.name)}">
    <div class="who">
      <div class="name">
        ${a.level.icon ? `<span class="badge-icon" title="${esc(a.level.name)}">${a.level.icon}</span>` : ''}
        <strong>${esc(a.name)}</strong>
        ${a.isAdmin ? `<span class="badge" title="This is the administrator's own name. They sign in with the name
          and password the container was given, not with an account on this page, and every check here lets them
          through — so the ticks below do not govern them.">administrator</span>`
    : a.hasPassword ? ''
      : `<span class="badge untagged" title="A name from before accounts existed. Whoever signs in with it first
        chooses the password.">no password yet</span>`}
        ${a.state === 'denied' ? '<span class="badge untagged">cannot sign in</span>' : ''}
      </div>
      <!-- The level, always: below ten books the listener's own page shows
           nothing, because a level everybody starts at is no accomplishment —
           but this page is where somebody is looked up, and "nothing there"
           would read as a gap rather than as an answer. -->
      <div class="sub level">${a.level.name
    ? `<strong>${esc(a.level.name)}</strong>` : 'No level yet'}${a.level.next
    ? ` · ${a.level.next.at - a.completed} book(s) to ${esc(a.level.next.name)}` : ' · the top'}</div>
      <div class="sub">Last here: ${esc(ago(a))}${a.signedIn ? ` · signed in on ${a.signedIn} browser(s)` : ''}</div>
      ${a.nowPlaying ? `<div class="sub playing">▶ Listening now: <strong>${esc(a.nowPlaying.title)}</strong>${a.nowPlaying.author ? ` · ${esc(a.nowPlaying.author)}` : ''}</div>` : ''}
      ${a.listening.length ? `<div class="sub">In the middle of:
        ${a.listening.map((b) => `<span class="badge"${b.via && b.via !== 'page'
    ? ` title="A player kept this place, not this page — ${esc(VIA[b.via] || b.via)} signs in as one listener and `
      + 'writes every position against that name, whoever is actually listening."'
    : ''}>${esc(b.title)}${b.author ? ` · ${esc(b.author)}` : ''} — ${b.percent}%${
    b.via && b.via !== 'page' ? ` · ↷ ${esc(VIA[b.via] || b.via)}` : ''}</span>`).join(' ')}</div>` : ''}
      ${a.reason ? `<div class="sub said">“${esc(a.reason)}”<br>says they ${a.knowsAdmin ? 'know' : '<strong>do not know</strong>'} you${a.requestedAt ? ` · asked ${esc(when(a.requestedAt))}` : ''}</div>` : ''}
    </div>

    <!-- Two of these count finished books and they are not the same count, which
         reads as a fault unless each says what it is. *Played to the end* is what
         the app watched happen and is what a level is built on; *ticked* is that
         plus every book somebody marked by hand. The listener's own "Books you've
         listened to" shows the ticked ones, so that list and the first number
         here differ by however many were ticked rather than heard. -->
    <div class="numbers">
      <div title="Books this app watched run out. A level is counted from these, so ticking a book by hand cannot earn one.">
        <strong>${a.completed}</strong><span>played to the end</span></div>
      <div title="Books with a place kept in them: begun, whether or not they were finished."><strong>${a.started}</strong><span>started</span></div>
      <div title="Books marked as listened — by hand, or by playing them out. This is what their own “Books you’ve listened to” lists.">
        <strong>${a.finished}</strong><span>ticked</span></div>
      <div title="Time listened, from where each place sits in its book."><strong>${a.hours}</strong><span>hours</span></div>
      <div title="Books they have hearted."><strong>${a.favourites}</strong><span>♥</span></div>
      <div title="Whole books they have downloaded."><strong>${a.downloads.length}</strong><span>downloads</span></div>
    </div>

    ${a.isAdmin ? `<div class="allowed">
      <label class="pick" title="This one does reach the administrator: downloading a whole book is allowed by a row
        on this page, so this row allows it for them. Turning it off here refuses them too.">
        <input type="checkbox" data-may-download ${a.granted ? 'checked' : ''}> May download
      </label>
      <span class="sub">Signing in is the container’s password, not this page, so there is no
        <em>May listen</em> to give or take here — and deleting the name would not close that door either.</span>
    </div>` : `<div class="allowed">
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
    </div>`}

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
