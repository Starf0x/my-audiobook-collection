// Is there a newer version, installing it, and the bar that follows the
// update through the restart. Out of app.js since 2.14.152, as it was written.
// Loaded right after app.js, whose helpers it uses (`work`, `newBar`, `perm`,
// `shutMenu`); app.js reaches back into it only from inside functions that run
// later — `updateMark`, `sayIfUpdated`, `say`.

// --- is there a newer version ---------------------------------------------
// The version in the line of numbers answers "is this the new one?" only for
// somebody who already knows what the new one is. This says it outright, and
// where it can be taken from here, offers to.
//
// `ask` is the button: without it the server answers from what it last heard,
// since GitHub allows sixty questions an hour and the answer changes weekly.
const HOW_TO_UPDATE = {
  image: 'This is the Docker image. Updating it is pulling a new one — on Unraid, '
    + '<em>Force update</em> in the Docker tab; with compose, <code>docker compose pull &amp;&amp; '
    + 'docker compose up -d</code>. Nothing here could do that for you.',
  folder: 'This is a checkout without the updater beside it. From a shell in the container: '
    + '<code>cd /opt/my-audiobook-collection &amp;&amp; git fetch --tags &amp;&amp; '
    + 'git checkout "$(git tag --sort=-v:refname | head -1)" &amp;&amp; npm ci --omit=dev</code>, '
    + 'then restart it.',
  lxc: 'Installing it stops the app for a moment and starts it again on the new version. '
    + 'Your database, settings and audiobooks are not touched. '
    + 'The same thing from a shell: <code>my-audiobook-collection-update</code>.',
};

// A red dot on the icon, and the way to act on it in the pulldown. Both say the
// same thing and both are drawn from the same answer: there is a newer version,
// and this install can take it. Settings is three clicks away and nobody opens
// it to find out whether there is news, so the news comes to the page instead.
// The menu entry is removed again the moment there is nothing to install — once
// the update has run, the next answer says so and takes it away.
function showUpdate(u) {
  const behind = !!(u && u.behind);
  $('#updateDot').hidden = !behind;
  $('#updateDot').title = behind ? `Update available: v${u.newest}` : '';
  $('#installUpdate').hidden = !(behind && u.canInstall);
}

// What the dot knows on a fresh page. The answer is the server's cached one —
// GitHub is asked at most once an hour however many browsers load the page —
// and a listener never sees it, since the route is the admin's.
async function updateMark() {
  if (perm.required && !perm.admin) return;
  const u = await api('/api/update').catch(() => null);
  if (u) showUpdate(u);
}

async function loadUpdate(ask) {
  $('#updateState').textContent = ask ? 'Asking GitHub…' : 'Looking…';
  const u = await api(`/api/update${ask ? '?ask=1' : ''}`).catch((e) => ({ error: e.message }));
  showUpdate(u);
  const last = u.last;
  // The update restarts the app, so the page that asked for it never hears how
  // it went — the updater leaves word behind instead, and this is where it is
  // read. Only worth saying when it failed, or when it is news.
  const said = last && last.said ? `<br><span class="warn">Last update: ${esc(last.said)}</span>` : '';

  if (u.error && !u.newest) {
    $('#updateState').innerHTML = `Running <strong>v${esc(u.running || '')}</strong>. `
      + `Could not ask GitHub: ${esc(u.error)}.${said}`;
    $('#updateNow').hidden = true;
    $('#updateHow').innerHTML = '';
    return;
  }
  if (u.behind) {
    $('#updateState').innerHTML = `Running <strong>v${esc(u.running)}</strong> — `
      + `<strong class="warn">v${esc(u.newest)} is out</strong>.${said}`;
    $('#updateNow').hidden = !u.canInstall;
  } else {
    $('#updateState').innerHTML = `Running <strong>v${esc(u.running)}</strong>, `
      + `<strong class="ok">the newest there is</strong>.${said}`;
    $('#updateNow').hidden = true;
  }
  $('#updateHow').innerHTML = HOW_TO_UPDATE[u.how] || '';
}

$('#updateCheck').onclick = () => work($('#updateCheck'), 'Asking GitHub', () => loadUpdate(true), false);

// Asking for the update, from the button in Settings or from the pulldown. The
// same thing either way, so it is written once.
const askForUpdate = (button) => work(button, 'Updating', async () => {
  if (!confirm('Install the newer version?\n\nThe app stops for a moment and comes back on it. '
    + 'Your database, settings and audiobooks are not touched.')) return null;
  const was = await version();
  const r = await post('/api/update', {}).catch((e) => ({ error: e.message }));
  if (r.error) return `It could not: ${r.error}`;
  // From here the app is being stopped and started under us, so there is no
  // answer coming: say what will happen and let the page find out by watching.
  say('<strong>Updating…</strong> the app stops for a moment. '
    + 'This page reloads when it is back on the new version.');
  waitForItBack(was, r.at);
  return 'Asked. It restarts on its own.';
}, false);

$('#updateNow').onclick = () => askForUpdate($('#updateNow'));
$('#installUpdate').onclick = () => { shutMenu(); askForUpdate(null); };

// Updating takes minutes and the page it was started from is usually shut by
// then, so what it has to say is said in two places: the line in Settings, and a
// toast, which is on the screen wherever the reader is.
function say(html, loud = false) {
  const line = $('#updateState');
  if (line) line.innerHTML = html;
  if (loud) toast(html.replace(/<[^>]+>/g, ''));
}

const version = () => fetch('/api/stats')
  .then((r) => (r.ok ? r.json() : null)).then((d) => (d && d.version) || '').catch(() => '');

// Wait for the app to come back **on a different version**, then reload so the
// page is the new version's own.
//
// "It answers" was the old signal, and it is not one: nothing has stopped yet
// when the button is pressed — the app only writes a file, and the path unit has
// to notice it, stop the service, fetch and run `npm ci` — so the app answers
// happily for the next half minute and the page reloaded itself into the old
// version straight away. Worse, when it never came back the poll ran out after
// four minutes in silence, leaving "Updating…" on the screen for ever with
// nothing to say whether it had worked. The version is the one honest signal:
// it changes exactly when the new code is running.
//
// And a bar while it waits, with the step the updater is on (2.14.96). It used
// to say "Updating…" in the line in Settings and nothing else — and pressed from
// the pulldown, Settings is shut, so there was nothing on screen at all while
// the container worked for minutes. The bar is the one every long job uses, at
// the foot of the page wherever the reader is. For two of the steps the app is
// down and cannot be asked; the bar says that, rather than calling it a failure.
const updateSteps = (p) => (p && p.of ? `Step ${Math.min(p.step, p.of)} of ${p.of}: ${p.doing}` : '');
function waitForItBack(was, askedAt = '') {
  const bar = newBar('Updating: waiting for the updater to start');
  bar.at(2);
  let tries = 0;
  let last = null;
  const stop = (ms) => { clearInterval(look); bar.done(ms); };
  const look = setInterval(async () => {
    tries += 1;
    let refused = false;
    const r = await fetch('/api/update/progress')
      .then((x) => {
        // Answered, but not to this page: the app is up and this page is no
        // longer signed in. That was taken for "still restarting" and waited on
        // for ever (2.14.120) — the app answers a 401 the moment it is back.
        refused = x.status === 401 || x.status === 403;
        return x.ok ? x.json() : null;
      }).catch(() => null);
    if (refused) {
      bar.at(100);
      bar.say('The app is back, but this page is no longer signed in. Reload it to sign in and see the version.', true);
      say('<strong class="warn">The app is back, but this page is no longer signed in.</strong> '
        + 'Reload it to sign in; the version line says whether the update took.', true);
      stop(30000);
      return;
    }
    const now = r ? r.running : '';
    if (now && was && now !== was) {
      bar.at(100);
      bar.say(`Updated to v${now}. Reloading…`);
      stop(1500);
      // The reload throws this message away with the page, so the news is left
      // where the new page will find it and said there instead.
      try { sessionStorage.setItem('updated-to', now); } catch { /* private window */ }
      say(`<strong class="ok">Updated to v${esc(now)}.</strong> Reloading…`, true);
      setTimeout(() => location.reload(), 1200);
      return;
    }
    // What the updater has said, if it is about this run and not a past one. As
    // times, not as text: the script writes local time with an offset and the
    // app writes UTC, and the two compared as strings are hours apart.
    const fresh = (q) => q && (q.step === 0 || !askedAt
      || Date.parse(q.at) >= Date.parse(askedAt) - 2000);
    if (r && fresh(r.progress)) last = r.progress;
    const p = last;
    if (p && p.done) {
      // finished without the version changing: already the newest, or it failed
      bar.at(100);
      if (p.ok) {
        bar.say(p.said ? `Nothing to install: ${p.said}.` : 'Finished.');
        say(`<strong class="ok">Nothing to install</strong> — ${esc(p.said || 'already the newest')}.`, true);
      } else {
        bar.say(`The update failed: ${p.said || 'see journalctl -u my-audiobook-collection-update'}`, true);
        say(`<strong class="warn">The update failed:</strong> ${esc(p.said || '')} — <code>journalctl -u `
          + 'my-audiobook-collection-update</code> in the container says more.', true);
      }
      stop(p.ok ? 6000 : 20000);
      return;
    }
    // The request picked up but no step written: an updater installed before
    // 2.14.96 says nothing while it works. It is working, though, and that much
    // can be said — the request file is gone the moment it starts.
    if (r && p && p.step === 0 && r.asked === false) {
      bar.at(10);
      bar.say('Updating: the updater is working on it — the bar shows its steps from the next update on');
    } else if (p && p.of) {
      bar.at(Math.max(2, Math.round((p.step / p.of) * 100)));
      bar.say(r ? `Updating: ${updateSteps(p)}`
        : `Updating: ${updateSteps(p)} — the app is restarting, so this waits for it`);
    } else if (!r) {
      bar.say('Updating: the app is restarting, so this waits for it');
    }
    if (tries > 300) { // ten minutes, then stop pretending to watch
      bar.say('It is taking longer than it should. Reload the page to look again.', true);
      stop(20000);
      say('<strong class="warn">It is taking longer than it should.</strong> The app is still on '
        + `v${esc(was)}. Reload the page to look again; <code>journalctl -u `
        + 'my-audiobook-collection-update</code> in the container says what happened.', true);
    }
  }, 2000);
}

// And on the page that comes up afterwards: the update ran, this is the version
// it ran to, and nothing else would have said so.
function sayIfUpdated() {
  let to = '';
  try { to = sessionStorage.getItem('updated-to') || ''; sessionStorage.removeItem('updated-to'); } catch { /* private window */ }
  if (to) toast(`Updated to v${to}.`);
}
