// requests — books somebody has asked for and the collection has not got.
//
// A listener types an author and a title; the administrator is told, goes and
// finds it, and drops it in. When the collection next has it, the request is
// answered without anybody having to remember it was open: the book becomes
// that person's favourite and they are told the next time they open the app.
//
// The matching is what this suite is mostly about, because it is where this
// can go quietly wrong in both directions — a request that is never answered
// and nothing says so, or a request answered by the wrong book, which hands
// somebody a favourite they did not ask for and closes a request they are
// still waiting on.
//
// Run: node tests/requests.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HERE = path.join(ROOT, 'fixtures', 'requests-test');
const DATA = path.join(HERE, 'data');
const PORT = 8547;
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

// What would have gone to Discord, caught rather than sent.
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

db.prepare("INSERT INTO users (name, state, pass, salt) VALUES ('mario', 'approved', '', '')").run();
db.prepare("INSERT INTO users (name, state, pass, salt) VALUES ('luigi', 'approved', '', '')").run();

const book = (id, author, title) => db.prepare(
  "INSERT INTO books (id, path, genre, author, title, duration) VALUES (?, ?, 'Fantasy', ?, ?, 60)",
).run(id, path.join(HERE, `b${id}`), author, title);

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

const signIn = async (name, password) => (await post('/api/account/signin', { name, password })).cookies;
const mario = await signIn('mario', 'a password of mine');
const luigi = await signIn('luigi', 'another password');
const admin = await signIn('frank', 'a very good password');

// --- asking ---------------------------------------------------------------
{
  const r = await post('/api/requests', { author: 'Brandon Sanderson', title: 'Mistborn', note: 'the Kramer reading' }, mario);
  check('a listener can ask for a book, and it is theirs',
    [r.status, r.body.who, r.body.author, r.body.title, r.body.state],
    [200, 'mario', 'Brandon Sanderson', 'Mistborn', 'open']);
  // Only the ones about a book: signing in sends its own message, and three
  // people sign in above.
  const aboutBooks = () => sent.filter((s) => /would like/.test(s.content || ''));
  check('and the administrator is told, with enough to go and find it',
    [aboutBooks().length, /Mistborn/.test(aboutBooks().at(-1)?.content || ''),
      /Brandon Sanderson/.test(aboutBooks().at(-1)?.content || ''),
      /Kramer/.test(aboutBooks().at(-1)?.content || '')],
    [1, true, true, true]);

  // Asking again for the same book is the same request. They have forgotten;
  // two rows would be two things for the administrator to decide about, and a
  // second message would ring the phone for nothing.
  const twice = await post('/api/requests', { author: 'brandon  SANDERSON', title: 'the mistborn' }, mario);
  check('asking twice for the same book is one request, however it is spelled',
    [twice.body.again, twice.body.id], [true, r.body.id]);
  check('and Discord is not told a second time', aboutBooks().length, 1);

  check('both halves are needed',
    (await post('/api/requests', { author: 'Somebody', title: '' }, mario)).status, 400);
  check('and nobody signed in may ask', (await post('/api/requests', { author: 'A', title: 'B' })).status, 401);
}

// --- what arrives answers it ----------------------------------------------
{
  const { fillFrom } = await import('../server/requests.js');
  const hearted = [];
  const heart = (who, id) => hearted.push([who, id]);

  // Not this one. The author matches and the title does not, which is the
  // commonest near miss and the one that must not be taken.
  book(1, 'Brandon Sanderson', 'Warbreaker');
  check('a book by the right author is not the book that was asked for',
    fillFrom([], { heart }).length, 0);

  // Nor this one. Titles are not unique — there is more than one book called
  // *Mistborn* in the world and a great many called *Twilight* — so the author
  // has to count as well. Matching on the title alone would hand this over.
  book(4, 'Someone Else Entirely', 'Mistborn');
  check('and a book with the right title by the wrong author is not it either',
    fillFrom([], { heart }).length, 0);

  // This one. Spelled differently on both sides — "The" dropped, case, a colon
  // — which is what normalising is for.
  book(2, 'brandon sanderson', 'Mistborn');
  const answered = fillFrom([], { heart });
  check('the book that was asked for answers the request',
    [answered.length, answered[0]?.state, answered[0]?.book.id], [1, 'filled', 2]);
  check('and it becomes the favourite of whoever asked, since they said so',
    hearted, [['mario', 2]]);
  check('and the request is not answered twice by a later scan',
    fillFrom([], { heart }).length, 0);
}

// --- and the person who asked is told, once -------------------------------
{
  const mine = await get('/api/requests/mine', mario);
  check('the news is waiting for them, with the book that answered it',
    [mine.body.news.length, mine.body.news[0]?.state, mine.body.news[0]?.bookTitle],
    [1, 'filled', 'Mistborn']);
  check('and it is on their own list as answered',
    mine.body.mine.map((r) => [r.title, r.state]), [['Mistborn', 'filled']]);

  await post('/api/requests/seen', { ids: mine.body.news.map((r) => r.id) }, mario);
  check('told once is told: it is not news again on the next page',
    (await get('/api/requests/mine', mario)).body.news.length, 0);

  // Somebody else's news is not theirs to mark as read — the ids come from a
  // page, and marking another person's would quietly lose it.
  await post('/api/requests', { author: 'Ursula K. Le Guin', title: 'A Wizard of Earthsea' }, luigi);
  const open = db.prepare("SELECT id FROM requests WHERE who = 'luigi'").get();
  db.prepare("UPDATE requests SET state = 'declined', said = 'not on audio', told = 0 WHERE id = ?").run(open.id);
  await post('/api/requests/seen', { ids: [open.id] }, mario);
  check('and one listener cannot mark another’s news as told',
    (await get('/api/requests/mine', luigi)).body.news.length, 1);
  check('who is told why, in the administrator’s own words',
    (await get('/api/requests/mine', luigi)).body.news[0].said, 'not on audio');
}

// --- the administrator's side ---------------------------------------------
{
  check('the list is the administrator’s, not a listener’s',
    [(await get('/api/requests', mario)).status, (await get('/api/requests', admin)).status],
    [403, 200]);

  const asked = await post('/api/requests', { author: 'Patrick Rothfuss', title: 'The Name of the Wind' }, luigi);
  check('declining needs the administrator too',
    (await post(`/api/requests/${asked.body.id}/decline`, { said: 'no' }, luigi)).status, 403);

  const no = await post(`/api/requests/${asked.body.id}/decline`, { said: 'not as an audiobook anywhere' }, admin);
  check('a declined request says so, with the reason',
    [no.body.state, no.body.said], ['declined', 'not as an audiobook anywhere']);
  check('and it cannot be declined twice',
    (await post(`/api/requests/${asked.body.id}/decline`, { said: 'again' }, admin)).status, 400);

  // The by-hand tie, for everything the normalised match will not catch:
  // *Mistborn* asked for, *Mistborn: The Final Empire* delivered.
  book(3, 'Robin Hobb', 'Assassin’s Apprentice (Farseer, Book 1)');
  const near = await post('/api/requests', { author: 'Robin Hobb', title: 'Assassins Apprentice' }, mario);
  check('a near miss is not matched on its own',
    (await get('/api/requests', admin)).body.requests.find((r) => r.id === near.body.id).state, 'open');
  const tied = await post(`/api/requests/${near.body.id}/link`, { bookId: 3 }, admin);
  check('so the administrator ties it to the book by hand',
    [tied.body.state, tied.body.book.id], ['filled', 3]);
  check('and that one is hearted too, by the same path',
    db.prepare('SELECT COUNT(*) AS n FROM favourites WHERE user = ? AND book_id = 3').get('mario').n, 1);
  check('a request cannot be tied to a book that is not there',
    (await post('/api/requests/9999/link', { bookId: 3 }, admin)).status, 400);
}

// --- what each person has asked for, counted ------------------------------
{
  const { tallyFor } = await import('../server/requests.js');
  check('a person’s requests are counted for their row on the accounts page',
    tallyFor('mario'), { asked: 2, open: 0, filled: 2, declined: 0 });
  check('and somebody who has been turned down shows that',
    tallyFor('luigi'), { asked: 2, open: 0, filled: 0, declined: 2 });
  check('and somebody who has asked for nothing has nothing',
    tallyFor('nobody'), { asked: 0, open: 0, filled: 0, declined: 0 });
}

// --- the matching itself ---------------------------------------------------
// The rule is exact-after-normalising, which is a rule somebody can predict.
// Deliberately not a fuzzy distance: an edit distance of two makes *Dune* match
// *June*, and the cost of a wrong match is a favourite nobody asked for.
{
  const { norm } = await import('../server/requests.js');
  check('case, punctuation and spacing are not differences',
    [norm('The Dark Tower'), norm('  dark   tower  '), norm('Dark-Tower!')],
    ['dark tower', 'dark tower', 'dark tower']);
  check('and neither are accents, which a filename often loses',
    norm('Les Misérables'), norm('Les Miserables'));
  check('a leading article is dropped, wherever the two sides disagree about it',
    [norm('A Game of Thrones'), norm('Game of Thrones')], ['game of thrones', 'game of thrones']);
  check('but two different books stay two different books',
    norm('Dune') === norm('June'), false);
}

console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
