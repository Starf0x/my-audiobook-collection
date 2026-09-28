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

// the player saying the last track ran out does
await post('/api/listened', { bookId: 5, done: true, played: true }, ann.cookies);
check('a book the app watched run out does', finishedCount('Ann'), 1);
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
