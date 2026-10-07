// accounts — the door, the hearts, and what Discord is told.
//
// The listening page used to answer anybody who could reach it. It is an
// account now: asked for with a reason, approved by the admin, signed in with a
// password, remembered for seven days. This suite drives a real server, because
// the thing being checked is who gets an answer and who does not.
//
// Run: node tests/accounts.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HERE = path.join(ROOT, 'fixtures', 'accounts-test');
const DATA = path.join(HERE, 'data');
const PORT = 8541;
const BASE = `http://127.0.0.1:${PORT}`;

let failed = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
};

fs.rmSync(HERE, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
process.env.DATA_DIR = DATA;
process.env.PORT = String(PORT);
process.env.ADMIN_USER = 'frank';
process.env.ADMIN_PASSWORD = 'a very good password';

// What would have gone to Discord. The address has to be a real Discord one —
// the app refuses anything else — so the fetch is what is stood in for.
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).startsWith('https://discord.com/')) {
    sent.push(JSON.parse(opts.body));
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return realFetch(url, opts);
};

const { db, setSetting } = await import('../server/db.js');
const { KEY } = await import('../server/notify.js');
setSetting(KEY, 'https://discord.com/api/webhooks/1/abc');
db.prepare(`INSERT INTO books (id, path, genre, author, title, duration)
            VALUES (3, '/x', 'Fantasy', 'An Author', 'A Book', 60)`).run();
await import('../server/index.js');
await new Promise((r) => setTimeout(r, 800));

const call = async (how, where, body, cookie) => {
  const r = await realFetch(`${BASE}${where}`, {
    method: how,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const cookies = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  return { status: r.status, body: await r.json().catch(() => ({})), cookies };
};
const get = (where, cookie) => call('GET', where, null, cookie);
const post = (where, body, cookie) => call('POST', where, body, cookie);

// --- the door ------------------------------------------------------------
check('the library is shut to somebody with no account', (await get('/api/genres')).status, 401);
check('so are the shelves', (await get('/api/home')).status, 401);
check('and a book', (await get('/api/books/3')).status, 401);
check('but the page can ask who it is talking to', (await get('/api/account/me')).status, 200);

const asked = await post('/api/account/request', {
  name: 'Bert', password: 'a good long one', knowsAdmin: true,
  reason: 'I live in this house and would like to listen along',
});
check('an account can be asked for', asked.body, { asked: true, name: 'Bert' });
check('Discord is told, with the reason and whether they know the admin',
  [/would like an account/.test(sent[0].content), /live in this house/.test(sent[0].content),
    /they do know/i.test(sent[0].content)], [true, true, true]);
check('and nothing in it can ring a phone', sent[0].allowed_mentions, { parse: [] });
// The reason is what the admin decides on, so the message is checked whole: the
// words as they were written, on their own line, between the name and the line
// about knowing the admin. Testing that the reason appears *somewhere* would
// pass for a message that had lost the line it belongs on.
check('the message reads as the admin will see it', sent[0].content,
  '📩 **Bert** would like an account.'
  + '\n> I live in this house and would like to listen along'
  + '\n_They say they do know the administrator._');

check('asking twice under one name is refused',
  (await post('/api/account/request', { name: 'bert', password: 'another long one', reason: 'because I say so, that is why' })).status, 400);
check('a password that is too short is refused',
  (await post('/api/account/request', { name: 'Ann', password: 'short', reason: 'I would like to listen to the books' })).status, 400);
check('and a reason that says nothing is refused',
  (await post('/api/account/request', { name: 'Ann', password: 'a good long one', reason: 'hi' })).status, 400);

// Two requests arrived whose reason was the sentence printed under the box. It
// is not a reason whatever wrote it there, and the person asking is told so.
check('the page’s own wording is not a reason',
  (await post('/api/account/request', {
    name: 'Ann', password: 'a good long one',
    reason: 'No email address is asked for and none is kept.',
  })).body.error,
  'That is this page’s own wording, not yours. '
  + 'Clear the box and say in your own words why you would like access.');
// A name of its own, and the message asserted rather than the status: with the
// guard taken out, a second try under 'Ann' is refused as a name already taken
// — which is a 400 for quite another reason, and this check passed on it.
check('nor is it, punctuated and cased any other way',
  (await post('/api/account/request', {
    name: 'Ada', password: 'a good long one',
    reason: '  no EMAIL address is asked for, and none is kept  ',
  })).body.error,
  'That is this page’s own wording, not yours. '
  + 'Clear the box and say in your own words why you would like access.');
check('and a sentence that merely mentions email is still a reason',
  (await post('/api/account/request', {
    name: 'Nell', password: 'a good long one',
    reason: 'No email from me, I just live here and would like to listen.',
  })).status, 200);
// and out again, because the check below this reads the waiting list whole and
// an extra name in it would be this check's leavings rather than the app's doing
db.prepare("DELETE FROM users WHERE name = 'Nell'").run();

check('an account nobody has approved cannot sign in',
  (await post('/api/account/signin', { name: 'Bert', password: 'a good long one' })).body.error,
  'That account is waiting for the administrator to approve it.');

// --- the admin -----------------------------------------------------------
const wrongOne = await post('/api/account/signin', { name: 'frank', password: 'not it' });
check('the admin name with the wrong password is refused', wrongOne.status, 400);
const admin = await post('/api/account/signin', { name: 'frank', password: 'a very good password' });
check('and with the right one is let in', admin.body, { name: 'frank', admin: true });
check('the admin sign-in is not announced', sent.filter((s) => /frank/.test(s.content)).length, 0);

const seen = await get('/api/accounts', admin.cookies);
check('the admin sees who has asked',
  seen.body.accounts.map((a) => [a.name, a.state]), [['Bert', 'pending']]);
check('with the words they wrote', /live in this house/.test(seen.body.accounts[0].reason), true);
check('a listener cannot see that list',
  (await get('/api/accounts')).status, 401);

check('approving says so', (await post('/api/accounts/Bert/state', { state: 'approved' }, admin.cookies)).body.state, 'approved');

// --- the listener --------------------------------------------------------
const bert = await post('/api/account/signin', { name: 'Bert', password: 'a good long one' });
check('an approved account signs in', bert.body.name, 'Bert');
check('and is given a session cookie for a week',
  /^listener=[a-f0-9]{64}$/.test(bert.cookies), true);
check('which Discord is told about', /Bert.*signed in/s.test(sent[sent.length - 1].content), true);
check('the library opens for them', (await get('/api/genres', bert.cookies)).status, 200);
check('but the admin list does not', (await get('/api/accounts', bert.cookies)).status, 403);

// --- a place in a book belongs to whoever kept it --------------------------
// Writing was closed when accounts arrived — `whoWrites` takes the session and
// never a name in the body — and reading was left open. Every shelf, the
// Listened section, the line of numbers, the cards and one book's own progress
// took `?user=`, the page naming itself, and the server answered for it.
//
// Frank found it from the other end: signed in as the administrator, he had
// another listener's book in *Continue listening*. His browser still carried a
// name in `localStorage` from the picker that came before accounts, the page
// sent that, and the server believed it. The same route would have answered
// anybody who typed a name into the address.
{
  // something of Bert's to go looking for
  await post('/api/progress', { bookId: 3, trackIdx: 0, position: 1 }, bert.cookies);
  const asBert = (await get('/api/home', bert.cookies)).body;
  check('Bert has a book on the go', asBert.continue.map((b) => b.id), [3]);

  // and now the admin asks for it by name
  const asked = (await get('/api/home?user=Bert', admin.cookies)).body;
  check('naming somebody else in the address does not fetch their shelf',
    asked.continue.map((b) => b.id), []);
  check('nor their finished books',
    (await get('/api/listened?user=Bert', admin.cookies)).body.length, 0);
  check('nor the count under the page',
    (await get('/api/stats?user=Bert', admin.cookies)).body.done, 0);
  check('nor the place kept in one book',
    (await get('/api/books/3?user=Bert', admin.cookies)).body.progress, null);
  // and a listener cannot reach across either, which is the direction that matters
  check('and a listener asking after the administrator gets their own answer',
    (await get('/api/home?user=frank', bert.cookies)).body.continue.map((b) => b.id), [3]);

  // Home Assistant's route asked the same question the same way, and `forHA`
  // lets a request through when no HA_TOKEN is set — which is most installs. So
  // a signed-in listener could ask it for somebody else's places, and
  // `continue.m3u` would hand over the book and the second they stopped at.
  //
  // A second listener is needed to check it at all: with exactly one in the app
  // `haState` answers for them whatever is asked, so a single-listener fixture
  // would pass this without the fix.
  // The second listener and her place are put back afterwards: everything below
  // counts rows, and a fixture one check leaves behind is a later check failing
  // for a reason that has nothing to do with it. (Which is what happened.)
  db.prepare("INSERT OR IGNORE INTO users (name, state) VALUES ('Donna', 'approved')").run();
  db.prepare(`INSERT INTO progress (user, book_id, track_idx, position, done, updated)
              VALUES ('Donna', 3, 0, 30, 0, datetime('now'))
              ON CONFLICT(user, book_id) DO UPDATE SET position = excluded.position`).run();
  const ha = (await get('/api/ha?user=Donna', bert.cookies)).body;
  check('the Home Assistant answer is about whoever asked, not whoever was named',
    ha.continue.map((b) => Math.round(b.position)), [1]);
  // `continue.m3u` hands over the same book from the same `haState`, so it is
  // the one fix and this is where it is checked; the playlist itself needs a
  // book with files, which `plays-on` has and this fixture does not.
  db.prepare("DELETE FROM progress WHERE user = 'Donna'").run();
  db.prepare("DELETE FROM users WHERE name = 'Donna'").run();
}

// --- the page the admin reads them on ------------------------------------
const pageOf = async (where, cookie) => {
  const r = await realFetch(`${BASE}${where}`, { headers: cookie ? { Cookie: cookie } : {} });
  return { status: r.status, type: (r.headers.get('content-type') || '').split(';')[0], body: await r.text() };
};
const accountsPage = await pageOf('/accounts');
check('the accounts page is served', [accountsPage.status, accountsPage.type], [200, 'text/html']);
check('and it is the accounts page', /id="everyone"/.test(accountsPage.body), true);
check('with a tick per account rather than a button',
  /data-may-listen|accounts\.js/.test(accountsPage.body), true);

// --- the way through to the admin page -----------------------------------
// Shown to the administrator and to nobody else. It ships hidden and `whoAmI()`
// reveals it, so the two things to hold are that the markup carries `hidden`
// and that the answer it is revealed on tells a listener apart from the admin.
// The lock itself is elsewhere — the admin page asks the server and sends back
// anybody who is merely a listener, and every admin route refuses them — and
// these checks are about what is offered, not about what is allowed.
const listenPage = (await pageOf('/')).body;
check('the Admin button ships hidden',
  /<button id="toAdmin"[^>]*\bhidden\b/.test(listenPage), true);
check('and it is not the admin page’s Lock button wearing the same id',
  /id="adminBtn"/.test(listenPage), false);
check('a listener is told they are not the admin',
  (await get('/api/account/me', bert.cookies)).body.admin, false);
check('and the admin is told they are',
  (await get('/api/account/me', admin.cookies)).body.admin, true);
check('a listener asking the admin page’s own route is refused',
  (await get('/api/accounts', bert.cookies)).status, 403);

// --- the page the server hands out is the page the suites read -------------
// Whether browse.js loads before the page's own script, and whether the two
// declare a name in common, is `pages` now: it loads the real scripts into a
// real scope, so a second `const $` is the SyntaxError it would be in a browser
// rather than a regex over the source that guesses at declarations.
//
// `pages` reads those files off the disk, though, and this suite is the one with
// a server running. So what is checked here is the seam between them: the page
// at this URL is the file `pages` drives. Without it the whole of `pages` could
// be reasoning about something nobody is served.
const scripts = (html) => [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
for (const [where, file] of [['/', 'listen.html'], ['/admin', 'index.html']]) {
  // eslint-disable-next-line no-await-in-loop -- two pages, read one after the other
  const served = scripts((await pageOf(where)).body);
  const onDisk = scripts(fs.readFileSync(path.join(ROOT, 'public', file), 'utf8'));
  check(`${where} serves ${file}, scripts and order alike`, served, onDisk);
  check(`and ${file} is one of the pages that drives`, served.includes('browse.js'), true);
}

// --- the box the reason is typed into ------------------------------------
// Two people, stuck for what to write, copied the sentence under this box and
// sent that as their reason. The placeholder gives them an example instead, and
// must not be the bare "A sentence is enough." that left them with nothing to
// go on. Both pages, because they are two files that have drifted before.
for (const where of ['/', '/admin']) {
  // eslint-disable-next-line no-await-in-loop -- two pages, read one after the other
  const page = (await pageOf(where)).body;
  const box = (page.match(/<textarea[^>]*\bid="gaWhy"[\s\S]{0,300}?>/) || [''])[0];
  const hint = (box.match(/placeholder="([^"]*)"/) || ['', ''])[1];
  check(`the reason box on ${where} shows somebody how to answer`,
    [/autocomplete="off"/.test(box), /for instance/i.test(hint)], [true, true]);
}

// --- the card that asks for the password ---------------------------------
// It must not be a <dialog>, and must never be opened with showModal(). A modal
// dialog takes the browser's top layer and holds it, and a password manager's
// own menu lives in that same layer: Bitwarden re-shows its menu each time it is
// covered, counts five in five seconds, and then warns the reader that the page
// is hijacking it. The card is an ordinary element with `hidden` on it for that
// reason, and this check is what keeps it one.
for (const where of ['/', '/admin']) {
  // eslint-disable-next-line no-await-in-loop -- two pages, read one after the other
  const page = (await pageOf(where)).body;
  const gate = (page.match(/<(\w+)[^>]*\bid="gate"/) || [])[1];
  check(`the sign-in card on ${where} is not a dialog`, gate, 'div');
}
// The comment above it in account.js says all this, so the file is read with its
// comments taken off — otherwise the explanation would pass for the mistake.
const code = fs.readFileSync(path.join(ROOT, 'public', 'account.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('and nothing opens it as a modal one', /showModal\s*\(/.test(code), false);
// The backdrop is sized by `.gate` and the card by `.gate-card`. A rule on
// `#gate` beats both, and one left over from when the gate was a <dialog> —
// `width: min(440px, 92vw)` — shrank the full-screen backdrop to the card's old
// width, leaving the card in the corner of a half-covered screen.
const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
check('and nothing sizes the gate by its id', /#gate\b\s*[{,]/.test(css), false);

// Taking the tick off is the approval going away: they cannot sign in, and the
// browsers signed in as them stop being signed in.
const deniedThem = await post('/api/accounts/Bert/state', { state: 'denied' }, admin.cookies);
check('taking the tick off refuses the account', deniedThem.body.state, 'denied');
check('and signs out every browser that was them',
  db.prepare("SELECT COUNT(*) AS n FROM listener_sessions WHERE name = 'Bert'").get().n, 0);
check('whose session is no longer a way in', (await get('/api/genres', bert.cookies)).status, 401);
check('and who cannot sign in again while it is off',
  (await post('/api/account/signin', { name: 'Bert', password: 'a good long one' })).status, 400);
await post('/api/accounts/Bert/state', { state: 'approved' }, admin.cookies);
const backIn = await post('/api/account/signin', { name: 'Bert', password: 'a good long one' });
check('ticking it again lets them straight back in', backIn.status, 200);
check('with everything they had', (await get('/api/favourites', backIn.cookies)).status, 200);
bert.cookies = backIn.cookies;

// --- what a failure tells a stranger -------------------------------------
// `wrap` catches the routes it is put on, which is not all of them. A throw in
// one of the others reached Express's own handler, which answers with the stack
// trace as HTML — absolute server paths and line numbers, to whoever asked.
// `GET /api/books` with no genre threw a SQLite bind error, and an ordinary
// listener could read the path of this file out of the reply.
const noGenre = await pageOf('/api/books', bert.cookies);
check('a question this route cannot take is refused, not a crash',
  [noGenre.status, noGenre.type], [400, 'application/json']);
check('and it says what was missing',
  JSON.parse(noGenre.body).error, 'Say which genre, and which author or series in it.');
check('with both, it answers',
  (await get('/api/books?genre=G&author=A', bert.cookies)).status, 200);
check('the same question to /api/authors is refused the same way',
  (await get('/api/authors', bert.cookies)).status, 400);
check('though a genre that is merely empty is a fair question',
  (await get('/api/authors?genre=', bert.cookies)).status, 200);

// The handler itself, reached by a road that cannot be paved over: a body that
// is not JSON throws inside Express's own parser, before any route of ours runs.
// Nothing this app does can stop that happening, so it is the honest test of
// what a stranger is told when something throws — JSON, and not one word about
// where this app lives on the disk.
const torn = await realFetch(`${BASE}/api/favourites/3`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: bert.cookies },
  body: '{"on": tru',
});
const tornSaid = await torn.text();
check('a torn request body is answered in JSON, not a stack trace',
  [torn.status, (torn.headers.get('content-type') || '').split(';')[0]],
  [400, 'application/json']);
check('and nothing in it says where this app lives',
  /file:\/\/|\.js:\d+|\bat \w+ \(|<html/i.test(tornSaid), false);

// A torn body carries its own 400, so it goes down the branch that passes a
// refusal's own words through. The other branch — an error with no status,
// which is a bug in this app rather than a bad question — cannot be reached on
// demand, because reaching it means finding a bug. So it is read instead: that
// branch must answer with the fixed sentence and never with anything the error
// itself carries, which is what would put a stack in front of a stranger.
const handler = (fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8')
  .match(/app\.use\(\(err, req, res, next\)[\s\S]*?\n\}\);/) || [''])[0];
check('the handler for an unexpected error exists and is the four-argument kind',
  handler.length > 0, true);
// the else-branch of that ternary, read on its own: a fixed string in quotes,
// and if somebody puts `err.stack` there instead this stops matching
check('and tells a stranger nothing the error itself carried',
  (handler.match(/deliberate \? err\.message\s*:\s*'([^']+)'/) || [])[1],
  'Something went wrong in the app. The server log says what.');

// --- the hearts ----------------------------------------------------------
check('nothing is hearted to begin with', (await get('/api/favourites', bert.cookies)).body.length, 0);
check('a heart goes on', (await post('/api/favourites/3', { on: true }, bert.cookies)).body, { favourite: true, count: 1 });
check('and the book is in the list',
  (await get('/api/favourites', bert.cookies)).body.map((b) => b.title), ['A Book']);
// Favourites draws an authors column beside the books, the way Listened does —
// a view and the column beside it are one view. It had none: the handler
// cleared `#authors ul` and never filled it, so the heading stood over nothing
// beside a shelf of books that plainly had authors. Two things hold it: the
// answer carries the author the column is built from, and the page wires the
// column's rows to the function that narrows to one author's hearted books.
check('a favourite carries the author its column is built from',
  (await get('/api/favourites', bert.cookies)).body.every((b) => 'author' in b), true);
const acct = fs.readFileSync(path.join(ROOT, 'public', 'account.js'), 'utf8');
// The wiring is asserted as a call from a row's onclick, not as the name
// appearing somewhere: `favouritesOf` matches its own definition, so the looser
// version of this check stayed green with every row's click handler emptied.
check('and the favourites view fills that column and wires it',
  [/#authors ul.*innerHTML\s*=\s*authors\.map/s.test(acct),
    /onclick\s*=\s*\(\)\s*=>\s*favouritesOf\(/.test(acct)],
  [true, true]);
check('pressing it again takes it off',
  (await post('/api/favourites/3', { on: false }, bert.cookies)).body, { favourite: false, count: 0 });
check('a heart on a book that is not there is refused',
  (await post('/api/favourites/999', { on: true }, bert.cookies)).status, 404);
check('and somebody with no account cannot heart anything',
  (await post('/api/favourites/3', { on: true })).status, 401);

// --- what is playing -----------------------------------------------------
await post('/api/playing', { bookId: 3, playing: true }, bert.cookies);
check('starting a book is announced, with the book and the person',
  [/Bert/.test(sent[sent.length - 1].content), /A Book/.test(sent[sent.length - 1].content)], [true, true]);
const before = sent.length;
await post('/api/playing', { bookId: 3, playing: true }, bert.cookies);
check('and saying it twice is not two starts', sent.length, before);
await post('/api/playing', { bookId: 3, playing: false, how: 'finished' }, bert.cookies);
check('stopping is announced too', /Bert.*finished.*A Book/s.test(sent[sent.length - 1].content), true);

// --- a place in a book belongs to whoever kept it -------------------------
await post('/api/progress', { user: 'Someone Else', bookId: 3, trackIdx: 0, position: 30 }, bert.cookies);
check('a name in the body cannot write into another account',
  db.prepare('SELECT user FROM progress').all().map((p) => p.user), ['Bert']);

// --- seven quiet days ----------------------------------------------------
const token = bert.cookies.replace('listener=', '');
db.prepare("UPDATE listener_sessions SET seen = ? WHERE token = ?")
  .run(new Date(Date.now() - 8 * 86400000).toISOString(), token);
check('a session nobody used for a week is over', (await get('/api/genres', bert.cookies)).status, 401);

const again = await post('/api/account/signin', { name: 'Bert', password: 'a good long one' });
check('signing in again works', again.status, 200);
db.prepare("UPDATE listener_sessions SET seen = ? WHERE token = ?")
  .run(new Date(Date.now() - 6 * 86400000).toISOString(), again.cookies.replace('listener=', ''));
check('six quiet days is not seven', (await get('/api/genres', again.cookies)).status, 200);

// --- taking an account away ----------------------------------------------
await post('/api/favourites/3', { on: true }, again.cookies);
db.prepare("INSERT INTO completions (user, book_id, title, at) VALUES ('Bert', 3, 'A Book', datetime('now'))").run();
db.prepare("INSERT INTO downloads (user, book_id, title, at) VALUES ('Bert', 3, 'A Book', datetime('now'))").run();
check('the account has something of its own in every one of them',
  ['favourites', 'progress', 'completions', 'downloads', 'listener_sessions']
    .map((t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n),
  [1, 1, 1, 1, 1]);
check('deleting it says whose it was',
  (await post('/api/accounts/Bert/remove', {}, admin.cookies)).body, { removed: 'Bert' });
// every table that is only about a person, named one by one: a new one added
// later and forgotten here would leave somebody's traces behind after they had
// been deleted, and nothing would say so
check('and everything that was only about them goes with it',
  ['favourites', 'progress', 'listener_sessions', 'completions', 'downloads']
    .map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]),
  [['favourites', 0], ['progress', 0], ['listener_sessions', 0],
    ['completions', 0], ['downloads', 0]]);
check('the books are untouched', db.prepare('SELECT COUNT(*) AS n FROM books').get().n, 1);
check('and the session it had is no longer a way in',
  (await get('/api/genres', again.cookies)).status, 401);

// --- guessing ------------------------------------------------------------
db.prepare(`INSERT INTO users (name, state, pass, salt) VALUES ('Ann', 'approved', 'x', 'y')`).run();
let refused = 0;
for (let i = 0; i < 7; i++) {
  // eslint-disable-next-line no-await-in-loop -- the count is the point
  const r = await post('/api/account/signin', { name: 'Ann', password: `guess ${i}` });
  if (r.status === 429) refused++;
}
check('guessing starts costing after a handful of tries', refused > 0, true);

// --- the administrator's own name, on the page of accounts ----------------
// Frank turned *May download* off on his own row and went on downloading, and
// read "no password yet" beside a name he types a password for every week. Both
// were the same thing: the administrator listens under their own name, so that
// name can also be a row here — left by the picker that came before accounts —
// and the page showed it as an ordinary listener. It is not one. They sign in
// with the container's name and password, `whoIsAsking` lets them through every
// check as the admin, and nothing on this row governs any of that.
{
  const { withStats: stats } = await import('../server/listeners.js');
  // the name the suite signs the admin in with, as a listener row: exactly the
  // leftover this is about
  db.prepare("INSERT OR IGNORE INTO users (name, state) VALUES ('frank', 'approved')").run();
  await get('/api/stats', admin.cookies); // a visit, which is what marks them present
  const mine = () => stats().find((u) => u.name === 'frank');
  check('the administrator’s row says it is the administrator', mine().isAdmin, true);
  check('and it is the only row that does', stats().filter((u) => u.isAdmin).map((u) => u.name), ['frank']);
  check('their row stops claiming they have never been here', !!mine().lastSeen, true);
  check('and the page is told not to show them a password badge they have no use for',
    [mine().isAdmin, mine().hasPassword], [true, false]);
  // the reason the ticks on that row are not drawn: they decide nothing
  check('the administrator may download whatever that row says',
    (await get('/api/download/1', admin.cookies)).status !== 403, true);
  await post('/api/accounts/frank/download', { may: false }, admin.cookies);
  check('and still may, with it turned off',
    (await get('/api/download/1', admin.cookies)).status !== 403, true);
}

console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
