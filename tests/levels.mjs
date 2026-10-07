// levels — what somebody has finished, what it is called, and what it unlocks.
//
// The two rules worth pinning down, because both are easy to get wrong in a way
// nobody notices until somebody's tally is wrong:
//
//  * a level is made of books the app watched **run out**. Ticking one by hand
//    is a statement, not a completion, and clearing your place in a book must
//    not take a finished book off the count — the record is kept apart from the
//    listening data for exactly that reason.
//  * downloading a whole book is the top level or the admin's say-so, and the
//    page hiding the button is not what enforces it.
//
// Run: node tests/levels.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HERE = path.join(ROOT, 'fixtures', 'levels-test');
const DATA = path.join(HERE, 'data');
const PORT = 8544;
const BASE = `http://127.0.0.1:${PORT}`;

let failed = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
};

const FRAME = Buffer.from(`fffb10c4${'00'.repeat(100)}`, 'hex');
const mp3 = (seconds) => Buffer.concat(Array(Math.round(seconds * 44100 / 1152)).fill(FRAME));

fs.rmSync(HERE, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
process.env.DATA_DIR = DATA;
process.env.PORT = String(PORT);
process.env.ADMIN_USER = 'frank';
process.env.ADMIN_PASSWORD = 'a very good password';

const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).startsWith('https://discord.com/')) {
    sent.push(JSON.parse(opts.body));
    return new Response('{}', { status: 200 });
  }
  return realFetch(url, opts);
};

const { db, setSetting } = await import('../server/db.js');
const { KEY } = await import('../server/notify.js');
const { LEVELS, levelOf, mayDownload, TOP } = await import('../server/levels.js');
setSetting(KEY, 'https://discord.com/api/webhooks/1/abc');

// --- the table itself ----------------------------------------------------
check('nought to nine is no level at all',
  [0, 5, 9].map((n) => levelOf(n).name), ['', '', '']);
check('and the tens are the ones the owner named',
  [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((n) => levelOf(n).name),
  ['Rookie Level', 'Listener Level', 'Book Hunter Level', 'Story Seeker Level',
    'Book Master Level', 'Story Master Level', 'Audio Expert Level', 'Audio Master Level',
    'Grand Master Level', 'Audio Legend Ultimate Level']);
check('a number between two levels keeps the one below', levelOf(47).name, 'Story Seeker Level');
check('past the top there is nothing further', levelOf(250).name, 'Audio Legend Ultimate Level');
check('every level has an icon', LEVELS.every((l) => !!l.icon), true);
check('and each says what the next one is', levelOf(10).next.at, 20);
check('downloading is the top level, or the admin saying so',
  [mayDownload(99, false), mayDownload(TOP, false), mayDownload(0, true)], [false, true, true]);

// --- a real book, really finished ----------------------------------------
const bookDir = path.join(HERE, 'library', 'Fantasy', 'An Author', 'A Book');
fs.mkdirSync(bookDir, { recursive: true });
fs.writeFileSync(path.join(bookDir, '01.mp3'), mp3(2));
db.prepare(`INSERT INTO books (id, path, genre, author, title, duration)
            VALUES (5, ?, 'Fantasy', 'An Author', 'A Book', 2)`).run(bookDir);
db.prepare(`INSERT INTO tracks (book_id, idx, path, title, duration)
            VALUES (5, 0, ?, 'One', 2)`).run(path.join(bookDir, '01.mp3'));
db.prepare(`INSERT INTO books (id, path, genre, author, title, duration)
            VALUES (6, '/y', 'Fantasy', 'An Author', 'Another Book', 2)`).run();
// A third with a real track on it, for the one case that cannot be played into
// existence: a place kept at the end of the last track with no tick beside it.
const thirdDir = path.join(HERE, 'library', 'Fantasy', 'An Author', 'A Third Book');
fs.mkdirSync(thirdDir, { recursive: true });
fs.writeFileSync(path.join(thirdDir, '01.mp3'), mp3(2));
db.prepare(`INSERT INTO books (id, path, genre, author, title, duration)
            VALUES (7, ?, 'Fantasy', 'An Author', 'A Third Book', 2)`).run(thirdDir);
db.prepare(`INSERT INTO tracks (book_id, idx, path, title, duration)
            VALUES (7, 0, ?, 'One', 2)`).run(path.join(thirdDir, '01.mp3'));

await import('../server/index.js');
await new Promise((r) => setTimeout(r, 800));

const call = async (how, where, body, cookie) => {
  const r = await realFetch(`${BASE}${where}`, {
    method: how,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const cookies = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  const type = r.headers.get('content-type') || '';
  return { status: r.status, cookies, body: type.includes('json') ? await r.json().catch(() => ({})) : {} };
};
const post = (where, body, cookie) => call('POST', where, body, cookie);
const get = (where, cookie) => call('GET', where, null, cookie);

const admin = await post('/api/account/signin', { name: 'frank', password: 'a very good password' });
const { requestAccount, decide, finishedCount } = await import('../server/listeners.js');
await requestAccount({ name: 'Ann', password: 'a good long one', reason: 'I would like to listen to these' });
decide('Ann', 'approved');
const ann = await post('/api/account/signin', { name: 'Ann', password: 'a good long one' });

check('a new listener has finished nothing', finishedCount('Ann'), 0);
check('and is shown no level at all', (await get('/api/account/me', ann.cookies)).body.level.name, '');

// ticking a book by hand is a statement, not a completion
await post('/api/listened', { bookId: 6, done: true }, ann.cookies);
check('ticking a book by hand does not count towards a level', finishedCount('Ann'), 0);

// The two numbers the admin's page shows side by side, at the moment they are
// furthest apart. Frank read "played to the end" as the count behind his own
// "Books you've listened to" and reported them disagreeing: they are different
// questions, and the page says which is which — but only the one on the right is
// the list's count, and nothing else checks that it stays so.
{
  const { withStats } = await import('../server/listeners.js');
  const mine = () => withStats().find((u) => u.name === 'Ann');
  const listed = (await get('/api/listened?user=Ann', ann.cookies)).body;
  check('one ticked by hand is in their own Listened list', listed.length, 1);
  check('and is counted as ticked, not as played to the end',
    [mine().finished, mine().completed], [1, 0]);
}

// the player saying the last track ran out does
await post('/api/listened', { bookId: 5, done: true, played: true }, ann.cookies);
check('a book the app watched run out does', finishedCount('Ann'), 1);
{
  const { withStats } = await import('../server/listeners.js');
  const mine = () => withStats().find((u) => u.name === 'Ann');
  const listed = (await get('/api/listened?user=Ann', ann.cookies)).body;
  check('the Listened list counts the ticked ones, whichever way they were ticked',
    listed.length, mine().finished);
  check('and played-to-the-end is the smaller number, being only what was watched',
    [mine().completed, mine().finished], [1, 2]);
  // The line of numbers runs under the same page the Listened section is on, and
  // *listened* on it has to be the count of that section. It used to be
  // `COUNT(progress WHERE done = 1)` — the tick alone — while the list itself is
  // every book that counts as read, tick or a place sitting at the end of the
  // last track. So the list said four and the number under it said one, on one
  // screen, and the only way to find out which was right was to ask.
  const strip = (await get('/api/stats?user=Ann', ann.cookies)).body;
  check('and the numbers under the page count the same books as the list',
    [strip.done, strip.todo], [listed.length, strip.books - listed.length]);
}
await post('/api/listened', { bookId: 5, done: true, played: true }, ann.cookies);
check('and finishing the same book twice is one accomplishment', finishedCount('Ann'), 1);

// the record outlives the listening data — the whole reason it is kept apart
await post('/api/listened', { bookId: 5, done: false }, ann.cookies);
check('clearing the listening data does not take it away', finishedCount('Ann'), 1);
check('though that book is no longer ticked — the one ticked by hand is another',
  db.prepare("SELECT COUNT(*) AS n FROM progress WHERE user = 'Ann' AND book_id = 5").get().n, 0);

// a place that reaches the end of the last track is a completion too
await post('/api/progress', { bookId: 5, trackIdx: 0, position: 2 }, ann.cookies);
check('so is playing to the end of the last track', finishedCount('Ann'), 1);

// --- where the two counts came apart --------------------------------------
// The tick is *written*, once, under the rules as they stood at that moment;
// counting as read is *worked out* when a row is served, under the rules as they
// stand now. So they drift. A row kept before this app ticked a book that played
// out never got one; and a scan that re-reads a file's real duration can move the
// end of the last track under a place that was already kept, which makes a book
// count as read that was never ticked and never will be.
//
// That row is written here rather than played into existence, because playing to
// the end is exactly what sets the tick — the state only arises from a database
// that has been through a version or a re-scan, which is what Frank's had.
//
// The Listened section lists by what counts as read. The line of numbers under
// it used to count `progress.done = 1`, the tick alone. One screen, one
// question, two answers: the list said four and the number under it said one,
// and nothing on the page said which was right.
{
  const last = db.prepare(`SELECT idx, duration FROM tracks WHERE book_id = 7
                           ORDER BY idx DESC LIMIT 1`).get();
  db.prepare(`INSERT INTO progress (user, book_id, track_idx, position, done, updated)
              VALUES ('Ann', 7, ?, ?, 0, datetime('now'))`).run(last.idx, last.duration);

  const listed = (await get('/api/listened?user=Ann', ann.cookies)).body;
  const ticked = db.prepare("SELECT COUNT(*) AS n FROM progress WHERE user = 'Ann' AND done = 1").get().n;
  check('a book sitting at the end of its last track is listed, tick or no tick',
    [listed.some((b) => b.id === 7), ticked < listed.length], [true, true]);
  const strip = (await get('/api/stats?user=Ann', ann.cookies)).body;
  check('and the numbers under the page count what that list counts',
    [strip.done, strip.todo], [listed.length, strip.books - listed.length]);
  // The third place the same question is asked. The admin's page has said for a
  // while that this number is "what their own Books you've listened to lists" —
  // and it counted the stored tick, so the label was a promise the code did not
  // keep. There is one `readCount` behind all three now.
  const { withStats } = await import('../server/listeners.js');
  check('and so does the number on their row of the accounts page',
    withStats().find((u) => u.name === 'Ann').finished, listed.length);
  check('while played-to-the-end stays its own, smaller, number',
    withStats().find((u) => u.name === 'Ann').completed < listed.length, true);
}

// --- what a level unlocks ------------------------------------------------
check('a listener below the top may not take a whole book',
  (await get('/api/download/5', ann.cookies)).status, 403);
check('and is told how far off they are',
  /Audio Legend Ultimate Level.*book\(s\) from/s.test((await get('/api/download/5', ann.cookies)).body.error), true);
check('the page is told not to offer it',
  (await get('/api/account/me', ann.cookies)).body.mayDownload, false);
check('nothing was written down about a download that did not happen',
  db.prepare('SELECT COUNT(*) AS n FROM downloads').get().n, 0);

check('the admin can hand it over',
  (await post('/api/accounts/Ann/download', { may: true }, admin.cookies)).body.mayDownload, true);
check('and then the page is told to offer it',
  (await get('/api/account/me', ann.cookies)).body.mayDownload, true);
const took = await get('/api/download/5', ann.cookies);
check('and the book really comes', took.status, 200);
check('which is written down, with the title',
  db.prepare('SELECT user, title FROM downloads').all(), [{ user: 'Ann', title: 'A Book' }]);
check('and Discord is told who took what',
  /Ann.*downloaded.*A Book/s.test(sent[sent.length - 1].content), true);

check('the admin sees it in the statistics',
  (await get('/api/accounts', admin.cookies)).body.accounts
    .find((a) => a.name === 'Ann').downloads.map((d) => d.title), ['A Book']);

check('taking it back closes it again',
  (await post('/api/accounts/Ann/download', { may: false }, admin.cookies)).body.mayDownload, false);
check('and the download is refused once more',
  (await get('/api/download/5', ann.cookies)).status, 403);

// --- the top level earns it without asking -------------------------------
const many = db.prepare('INSERT INTO completions (user, book_id, title, at) VALUES (?, ?, ?, ?)');
for (let i = 0; i < TOP; i++) many.run('Ann', 1000 + i, `Book ${i}`, new Date().toISOString());
check('a hundred finished books is the top level', levelOf(finishedCount('Ann')).name, 'Audio Legend Ultimate Level');
check('which opens downloading on its own', (await get('/api/download/5', ann.cookies)).status, 200);
check('and the page says so', (await get('/api/account/me', ann.cookies)).body.level.icon, LEVELS[0].icon);

console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
