// abs-contract — does the Audiobookshelf face answer what Music Assistant parses?
//
// MA reads these answers with `aioaudiobookshelf`, whose models are mashumaro
// dataclasses: a field without a default is required, and a missing one is a hard
// parse error — which reaches the owner as "Music Assistant cannot connect", with
// nothing saying why. Python is not on this machine, so the models below are the
// required fields of that library's schemas, transcribed from its source, and
// every answer is checked against them.
//
// What this cannot prove: that MA's provider is happy with the *meanings*. That
// wants a real Music Assistant, and is the next step. What it does prove is that
// nothing it needs is absent, which is the failure that is invisible from outside.
//
// Run: node tests/abs-contract.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'fixtures', 'abs-contract-test', 'data');
const PORT = 8533;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'test-ma-token';

let failed = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
};

// A field is required when aioaudiobookshelf's dataclass gives it no default.
// Nullable-but-required fields are listed too: the key has to be there.
const MODELS = {
  LoginResponse: ['user', 'userDefaultLibraryId', 'serverSettings', 'Source'],
  User: ['id', 'username', 'type', 'mediaProgress', 'seriesHideFromContinueListening',
    'bookmarks', 'isActive', 'isLocked', 'createdAt', 'permissions'],
  UserPermissions: ['download', 'update', 'delete', 'upload', 'accessAllLibraries',
    'accessAllTags', 'accessExplicitContent'],
  ServerSettings: ['id', 'scannerFindCovers', 'scannerCoverProvider', 'scannerParseSubtitle',
    'scannerPreferMatchedMetadata', 'scannerDisableWatcher', 'storeCoverWithItem',
    'storeMetadataWithItem', 'metadataFileFormat', 'rateLimitLoginRequests',
    'rateLimitLoginWindow', 'backupSchedule', 'backupsToKeep', 'maxBackupSize',
    'loggerDailyLogsToKeep', 'loggerScannerLogsToKeep', 'homeBookshelfView', 'bookshelfView',
    'sortingIgnorePrefix', 'sortingPrefixes', 'chromecastEnabled', 'dateFormat', 'timeFormat',
    'language', 'logLevel', 'version'],
  Library: ['id', 'name', 'folders', 'displayOrder', 'icon', 'mediaType', 'provider',
    'settings', 'createdAt', 'lastUpdate'],
  Folder: ['id', 'fullPath', 'libraryId', 'addedAt'],
  ItemBase: ['id', 'ino', 'libraryId', 'folderId', 'path', 'relPath', 'isFile', 'mtimeMs',
    'ctimeMs', 'birthtimeMs', 'addedAt', 'updatedAt', 'isMissing', 'isInvalid', 'mediaType'],
  MinifiedExtra: ['numFiles', 'size', 'media'],
  ExpandedExtra: ['libraryFiles', 'size', 'media'],
  BookMinified: ['metadata', 'numTracks', 'numAudioFiles', 'numChapters', 'duration', 'size'],
  BookExpanded: ['libraryItemId', 'metadata', 'audioFiles', 'chapters', 'duration', 'size', 'tracks'],
  BookMetadataMinified: ['genres', 'explicit', 'titleIgnorePrefix', 'authorName', 'authorNameLF',
    'narratorName', 'seriesName'],
  BookMetadataExpanded: ['genres', 'explicit', 'authors', 'narrators', 'series',
    'titleIgnorePrefix', 'authorName', 'authorNameLF', 'narratorName', 'seriesName'],
  AudioTrack: ['index', 'startOffset', 'duration', 'title', 'contentUrl', 'metadata'],
  AudioFile: ['index', 'ino', 'metadata', 'addedAt', 'updatedAt', 'manuallyVerified', 'exclude',
    'format', 'duration', 'codec', 'timeBase'],
  FileMetadata: ['filename', 'ext', 'path', 'relPath', 'ctimeMs'],
  BookChapter: ['id', 'start', 'end', 'title'],
  MediaProgress: ['id', 'libraryItemId', 'duration', 'isFinished', 'hideFromContinueListening',
    'lastUpdate', 'startedAt'],
  AuthorExpanded: ['id', 'name', 'addedAt', 'updatedAt', 'numBooks'],
  Narrator: ['id', 'name', 'numBooks'],
  // the library listing answers SeriesBooksMinified, which is the short one —
  // id, name and the books. An earlier version of this file named SeriesNumBooks
  // here, which is a different dataclass the provider never reads: it checked
  // more than the client asks for and nothing that it does.
  SeriesBooksMinified: ['id', 'name', 'books'],
  SeriesWithProgress: ['id', 'name', 'addedAt', 'updatedAt', 'progress'],
  SeriesProgress: ['libraryItemIds', 'libraryItemIdsFinished', 'isFinished'],
  AuthorWithItemsAndSeries: ['id', 'name', 'addedAt', 'updatedAt', 'libraryItems', 'series'],
  AuthorSeries: ['id', 'name', 'items'],
  Pagination: ['total', 'limit', 'page', 'results'],
  // Pressing play reads this one, and it is the answer that was invented rather
  // than transcribed: it went out missing seven of these, and Music Assistant
  // said so by name — Field "device_info" of type DeviceInfo is missing.
  PlaybackSessionExpanded: ['id', 'userId', 'libraryId', 'libraryItemId', 'mediaType',
    'mediaMetadata', 'displayTitle', 'displayAuthor', 'coverPath', 'duration', 'playMethod',
    'mediaPlayer', 'deviceInfo', 'serverVersion', 'date', 'dayOfWeek', 'timeListening',
    'startTime', 'currentTime', 'startedAt', 'updatedAt', 'audioTracks'],
};

// The enums it will refuse anything else for.
const ENUMS = {
  'Library.icon': ['database', 'audiobookshelf', 'books-1', 'books-2', 'book-1', 'microphone-1',
    'microphone-3', 'radio', 'podcast', 'rss', 'headphones', 'music', 'file-picture', 'rocket',
    'power', 'star', 'heart'],
  'Library.mediaType': ['book', 'podcast'],
  'User.type': ['root', 'guest', 'user', 'admin'],
  'ServerSettings.metadataFileFormat': ['abs', 'json'],
  'ServerSettings.dateFormat': ['MM/dd/yyyy', 'dd/MM/yyyy', 'dd.MM.yyyy', 'yyyy-MM-dd',
    'MMM do, yyyy', 'MMMM do, yyyy', 'dd MMM yyyy', 'dd MMMM yyyy'],
  'ServerSettings.timeFormat': ['HH:mm', 'h:mma'],
  'ServerSettings.logLevel': [1, 2, 3],
};

// Reaching into an answer that is not there must fail its own check and let the
// rest of the run finish, so every index into a response goes through this.
const at = (xs, i = 0) => (Array.isArray(xs) ? xs[i] : undefined) || {};

const missing = (obj, model) => (MODELS[model] || []).filter((f) => !(obj && f in obj));
const parses = (label, obj, model) => check(`${label} carries every field of ${model}`, missing(obj, model), []);
const inEnum = (label, value, key) => check(`${label} is one ${key} knows`, ENUMS[key].includes(value), true);

// --- a library to answer about -----------------------------------------
fs.rmSync(path.dirname(DATA), { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
const audioDir = path.join(path.dirname(DATA), 'audio');
fs.mkdirSync(audioDir, { recursive: true });
// a real file, so a size and a stream can be read rather than imagined
const silence = path.join(audioDir, 'one.mp3');
fs.writeFileSync(silence, Buffer.alloc(4096, 0));

process.env.DATA_DIR = DATA;
const { db } = await import('../server/db.js');
db.exec('DELETE FROM books; DELETE FROM tracks; DELETE FROM progress; DELETE FROM users;');
const add = db.prepare(`INSERT INTO books (path, genre, author, series, title, narrator, year,
                                           description, series_no, duration)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
add.run('/audiobooks/Fantasy/Stephen King/The Dark Tower/Gunslinger', 'Fantasy', 'Stephen King',
  'The Dark Tower', 'Gunslinger', 'Frank Muller', '1982', 'The man in black fled.', 1, 30);
add.run('/audiobooks/Thriller/Gillian Flynn/Gone Girl', 'Thriller', 'Gillian Flynn',
  null, 'Gone Girl', '', '2012', '', 0, 20);
const first = db.prepare('SELECT id FROM books ORDER BY id').all()[0].id;
const track = db.prepare('INSERT INTO tracks (book_id, idx, path, title, duration) VALUES (?, ?, ?, ?, ?)');
track.run(first, 0, silence, 'One', 20);
track.run(first, 1, silence, 'Two', 10);

// A book this app plays but has not converted. Every file used to be announced
// to Music Assistant as mp3/audio/mpeg whatever it really was, and a player acts
// on what it is told — so the second book here is an .m4b and a .flac.
const second = db.prepare('SELECT id FROM books ORDER BY id').all()[1].id;
track.run(second, 0, silence.replace(/\.mp3$/, '.m4b'), 'Part One', 10);
track.run(second, 1, silence.replace(/\.mp3$/, '.flac'), 'Part Two', 10);

// Nobody else's port, first. A server left behind by an earlier run — or a demo
// somebody started on this one — answers out of its own database, and the suite
// then reports the app broken over somebody else's data. That has happened on
// exactly this port: the accounts demo took 8533 and this suite believed it.
const inUse = await fetch(BASE, { signal: AbortSignal.timeout(700) }).then(() => true).catch(() => false);
if (inUse) {
  console.log(`FAIL something is already answering on ${PORT}, and its answers are not this suite's`);
  process.exit(1);
}

const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')],
  { env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), MA_TOKEN: TOKEN }, stdio: 'inherit' });

const up = async () => {
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${BASE}/api/stats`); return true; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  return false;
};

let token = '';
// An answer that is not JSON — a 404 with an empty body, say — must fail the
// check that wanted it, not end the run: a suite that dies half way reports
// nothing about everything after it, and a missing address is exactly the
// failure this file exists to catch.
const get = async (p, raw = false) => {
  const r = await fetch(`${BASE}${p}`, { headers: { Authorization: `Bearer ${token}` } });
  if (raw) return r;
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { __notJson: `${r.status} ${text.slice(0, 40)}` }; }
};

try {
  if (!await up()) throw new Error(`the server never answered on ${PORT}`);

  // --- logging in ------------------------------------------------------
  const bad = await fetch(`${BASE}/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'Frank', password: 'wrong' }),
  });
  check('a wrong password is refused', bad.status, 401);

  const login = await (await fetch(`${BASE}/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-return-tokens': 'true' },
    body: JSON.stringify({ username: 'Frank', password: TOKEN }),
  })).json();
  parses('the login answer', login, 'LoginResponse');
  parses('its user', login.user, 'User');
  parses('its permissions', login.user.permissions, 'UserPermissions');
  parses('its server settings', login.serverSettings, 'ServerSettings');
  inEnum('the user type', login.user.type, 'User.type');
  inEnum('the metadata format', login.serverSettings.metadataFileFormat, 'ServerSettings.metadataFileFormat');
  inEnum('the date format', login.serverSettings.dateFormat, 'ServerSettings.dateFormat');
  inEnum('the time format', login.serverSettings.timeFormat, 'ServerSettings.timeFormat');
  inEnum('the log level', login.serverSettings.logLevel, 'ServerSettings.logLevel');
  check('the token is the one kind that needs no refreshing', !!login.user.token && !login.user.refreshToken, true);
  check('a name Music Assistant logs in with is a listener this app knows',
    db.prepare('SELECT COUNT(*) n FROM users WHERE name = ?').get('Frank').n, 1);
  token = login.user.token;

  // --- the address shape MA actually uses ------------------------------
  // aioaudiobookshelf joins its base and an endpoint that already starts with a
  // slash, so every real call arrives doubled. If this 404s, nothing works.
  const doubled = await get('//api/libraries', true);
  check('a doubled slash is read as one', doubled.status, 200);

  // --- the library -----------------------------------------------------
  const libs = await get('/api/libraries');
  parses('the library', libs.libraries[0], 'Library');
  parses('its folder', libs.libraries[0].folders[0], 'Folder');
  inEnum('its icon', libs.libraries[0].icon, 'Library.icon');
  inEnum('its media type', libs.libraries[0].mediaType, 'Library.mediaType');
  const libId = libs.libraries[0].id;

  const withFilter = await get(`/api/libraries/${libId}?include=filterdata`);
  check('asking with filterdata answers the library and the filters',
    [!!withFilter.library, !!withFilter.filterdata, typeof withFilter.issues, typeof withFilter.numUserPlaylists],
    [true, true, 'number', 'number']);

  // --- the list of books -----------------------------------------------
  const page = await get(`/api/libraries/${libId}/items?limit=10&page=0`);
  parses('a page of items', page, 'Pagination');
  check('it holds the collection', page.total, 2);
  const mini = at(page.results);
  parses('an item in it', mini, 'ItemBase');
  parses('and its minified half', mini, 'MinifiedExtra');
  parses('its book', mini.media, 'BookMinified');
  parses('its metadata', mini.media.metadata, 'BookMetadataMinified');
  inEnum('its media type', mini.mediaType, 'Library.mediaType');

  // --- one book, with its tracks ---------------------------------------
  const one = await get(`/api/items/${first}?expanded=1`);
  parses('one book', one, 'ItemBase');
  parses('and its expanded half', one, 'ExpandedExtra');
  parses('its book', one.media, 'BookExpanded');
  parses('its metadata', one.media.metadata, 'BookMetadataExpanded');
  parses('its first track', at(one.media.tracks), 'AudioTrack');
  parses('that track\'s metadata', at(one.media.tracks).metadata, 'FileMetadata');
  parses('its first audio file', at(one.media.audioFiles), 'AudioFile');
  parses('its first chapter', at(one.media.chapters), 'BookChapter');
  check('the tracks are laid end to end', one.media.tracks.map((t) => t.startOffset), [0, 20]);
  check('and the book is as long as they are', one.media.duration, 30);
  check('the series carries its number as a string', one.media.metadata.series[0].sequence, '1');
  check('a book in no series says so with an empty list',
    (await get(`/api/items/${first + 1}?expanded=1`)).media.metadata.series, []);

  // What a file is, rather than what most files are. Music Assistant hands these
  // to a player, and a .flac announced as audio/mpeg is a lie it acts on.
  const mixed = await get(`/api/items/${first + 1}?expanded=1`);
  check('a book of mp3s is announced as mp3',
    one.media.audioFiles.map((f) => [f.format, f.codec, f.mimeType]),
    [['mp3', 'mp3', 'audio/mpeg'], ['mp3', 'mp3', 'audio/mpeg']]);
  check('an .m4b and a .flac are announced as what they are',
    mixed.media.audioFiles.map((f) => [f.format, f.codec, f.mimeType]),
    [['m4b', 'aac', 'audio/mp4'], ['flac', 'flac', 'audio/flac']]);
  check('and the tracks say the same as the files they are',
    mixed.media.tracks.map((t) => t.mimeType), ['audio/mp4', 'audio/flac']);

  // --- the audio and the cover -----------------------------------------
  // MA builds this address itself: base + contentUrl + ?token=
  const url = at(one.media.tracks).contentUrl;
  check('the track address is a path from the root', url.startsWith('/api/items/'), true);
  const audio = await fetch(`${BASE}${url}?token=${encodeURIComponent(token)}`);
  check('the audio comes back with the token in the query', audio.status, 200);
  check('and it is the file', (await audio.arrayBuffer()).byteLength, 4096);
  const noToken = await fetch(`${BASE}${url}`);
  check('and not without one', noToken.status, 401);
  const cover = await fetch(`${BASE}/api/items/${first}/cover?token=${encodeURIComponent(token)}`,
    { redirect: 'follow' });
  check('the cover answers', cover.status, 200);

  // --- who is listening, and where they got to -------------------------
  const me = await get('/api/me');
  parses('me', me, 'User');
  check('with nothing listened to yet', me.mediaProgress, []);

  const wrote = await fetch(`${BASE}/api/me/progress/${first}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ currentTime: 25, isFinished: false }),
  });
  check('a position from Music Assistant is taken', wrote.status, 200);
  const kept = db.prepare('SELECT track_idx, position FROM progress WHERE user = ? AND book_id = ?')
    .get('Frank', first);
  check('and lands on the right track, at the right second in it',
    [kept.track_idx, Math.round(kept.position)], [1, 5]);

  const back = await get(`/api/me/progress/${first}`);
  parses('the progress it reads back', back, 'MediaProgress');
  check('which is where the listener is in the whole book', Math.round(back.currentTime), 25);
  check('as a share of it', Math.round(back.progress * 100), 83);

  const finished = await fetch(`${BASE}/api/me/progress/${first}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ currentTime: 30, isFinished: true }),
  });
  check('finishing it there ticks it here', finished.status, 200);
  check('the book is marked listened',
    db.prepare('SELECT done FROM progress WHERE user = ? AND book_id = ?').get('Frank', first).done, 1);
  check('and it now shows up on the user', (await get('/api/me')).mediaProgress.length, 1);
  parses('as a progress row', at((await get('/api/me')).mediaProgress), 'MediaProgress');

  // --- the groupings ---------------------------------------------------
  const series = await get(`/api/libraries/${libId}/series`);
  parses('the series list', series, 'Pagination');
  parses('a series in it', at(series.results), 'SeriesBooksMinified');
  parses('whose books are items', at(at(series.results).books), 'MinifiedExtra');
  const authors = await get(`/api/libraries/${libId}/authors`);
  parses('an author', at(authors.authors), 'AuthorExpanded');
  const narrators = await get(`/api/libraries/${libId}/narrators`);
  parses('a narrator', at(narrators.narrators), 'Narrator');

  // --- the page past the end, which is what ends their loop ------------
  // The client's pager is a `while True`: it asks page 0, 1, 2 … and only stops
  // when a page comes back with no results in it. A listing that ignores `page`
  // and answers with everything each time does not give a wrong answer — it
  // hangs Music Assistant in a loop, and the reader sees a folder that never
  // opens. This is the property that has to hold for every paged listing.
  for (const listing of ['items', 'series', 'collections', 'playlists']) {
    const one = await get(`/api/libraries/${libId}/${listing}?limit=30&page=0`);
    const past = await get(`/api/libraries/${libId}/${listing}?limit=30&page=1`);
    check(`${listing}: a page past the end is empty, so their loop ends`,
      [Array.isArray(one.results), past.results], [true, []]);
  }
  // and with no limit at all, the second page is still empty
  check('a listing asked without a limit still ends',
    (await get(`/api/libraries/${libId}/series?page=1`)).results, []);
  check('while its first page is everything',
    (await get(`/api/libraries/${libId}/series`)).results.length, 1);

  // --- browsing *into* an author, a series and a narrator --------------
  // This is where a real Music Assistant fell over: it walks from the folder
  // into the thing by the id we handed out, and a 404 there reaches the reader
  // as a wordless NotFoundError, because the client raises it bare.
  // the one who has a series: the other author here has none, and an empty
  // series list would prove nothing about the shape of a filled one
  const authorId = (at(authors.authors.filter((a) => a.name === 'Stephen King'))).id;
  const oneAuthor = await get(`/api/authors/${authorId}?include=items,series`);
  parses('one author', oneAuthor, 'AuthorWithItemsAndSeries');
  parses('its books are items', at(oneAuthor.libraryItems), 'MinifiedExtra');
  parses('its series', at(oneAuthor.series), 'AuthorSeries');
  parses('holding items too', at(at(oneAuthor.series).items), 'MinifiedExtra');
  check('an author nobody has is not there rather than empty',
    (await get(`/api/authors/au-${Buffer.from('Nobody At All').toString('base64url')}`, true)).status, 404);

  const seriesId = at(series.results).id;
  const oneSeries = await get(`/api/series/${seriesId}?include=progress`);
  parses('one series', oneSeries, 'SeriesWithProgress');
  parses('its progress', oneSeries.progress, 'SeriesProgress');
  check('its books are in reading order', oneSeries.progress.libraryItemIds, [String(first)]);
  check('and the one finished a moment ago counts as finished',
    oneSeries.progress.libraryItemIdsFinished, [String(first)]);

  // the narrator folder filters the item list rather than asking for a narrator
  const narratorId = at(narrators.narrators).id;
  const filtered = await get(`/api/libraries/${libId}/items?filter=narrators.${encodeURIComponent(narratorId)}`);
  check('a narrator gets their own books, not the whole collection',
    filtered.results.map((i) => i.media.metadata.title), ['Gunslinger']);
  check('and an unfiltered list is still everything',
    (await get(`/api/libraries/${libId}/items`)).results.length, 2);
  for (const empty of ['collections', 'playlists']) {
    parses(`the ${empty} answer`, await get(`/api/libraries/${libId}/${empty}`), 'Pagination');
  }

  // --- a session, and a batch ------------------------------------------
  const session = await (await fetch(`${BASE}/api/items/${first}/play`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({}),
  })).json();
  parses('a play session', session, 'PlaybackSessionExpanded');
  check('a play session names the book and its tracks',
    [session.libraryItemId, at(session.audioTracks, 1).startOffset], [String(first), 20]);
  check('its cover path is a string even when the book has no picture',
    typeof session.coverPath, 'string');
  check('its date is a day, and its day a name',
    [/^\d{4}-\d{2}-\d{2}$/.test(session.date), /^[A-Z][a-z]+day$/.test(session.dayOfWeek)],
    [true, true]);
  check('it opens where the listener already was, not at nought',
    Math.round(session.currentTime), 30);

  // --- the session, asked for again ------------------------------------
  // This is the one that decides whether anything plays for a listener signed
  // in with a password rather than an API key. Music Assistant serves every
  // part of the book through an address of its own, and that address looks the
  // session up here first: a 404 becomes SessionNotFoundError, which it turns
  // into a 404 of its own, and then nothing plays at all.
  const again = await get(`/api/session/${session.id}`);
  parses('the session asked for again', again, 'PlaybackSessionExpanded');
  check('and it is the same session, under the id MA is holding', again.id, session.id);
  check('carrying the tracks it will fetch', at(again.audioTracks).contentUrl,
    at(session.audioTracks).contentUrl);

  const synced = await fetch(`${BASE}/api/session/${session.id}/sync`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ currentTime: 12, timeListened: 12, duration: 30 }),
  });
  check('a position reported against the session is taken', synced.status, 200);
  check('and lands on the right track', (() => {
    const p = db.prepare('SELECT track_idx, position FROM progress WHERE user = ? AND book_id = ?')
      .get('Frank', first);
    return [p.track_idx, Math.round(p.position)];
  })(), [0, 12]);

  const closed = await fetch(`${BASE}/api/session/${session.id}/close`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ currentTime: 18, timeListened: 6, duration: 30 }),
  });
  check('closing it is accepted and keeps the last word', closed.status, 200);
  check('which is where the listener stopped',
    Math.round(db.prepare('SELECT position FROM progress WHERE user = ? AND book_id = ?')
      .get('Frank', first).position), 18);
  // A session id carries the book it is about, so one this process never opened
  // — or opened before it was restarted — still answers. That is deliberate:
  // sessions live in memory, and an update to the container forgets them while
  // Music Assistant goes on asking for the id it holds. Its route for fetching
  // one part of a book does not recover from that the way opening a session
  // does; it answers its own 404 and ffmpeg stops with "Server returned 404".
  const afterClose = await get(`/api/session/${session.id}`);
  check('a closed session still answers, because the id names the book',
    afterClose.libraryItemId, String(first));
  const neverOpened = await get(`/api/session/pl-${first}-restarted`);
  parses('a session this process never opened', neverOpened, 'PlaybackSessionExpanded');
  check('and it is about the right book', neverOpened.libraryItemId, String(first));
  check('with the tracks a part request needs', at(neverOpened.audioTracks, 1).startOffset, 20);
  check('a session id naming no book is still not there',
    (await get('/api/session/nonsense', true)).status, 404);

  // a player that kept a session to itself while offline
  const local = await fetch(`${BASE}/api/session/local`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ libraryItemId: String(first), currentTime: 24, duration: 30 }),
  });
  check('an offline session is taken too', local.status, 200);
  check('and moves the place', Math.round(db.prepare(
    'SELECT position FROM progress WHERE user = ? AND book_id = ?').get('Frank', first).position), 4);
  const batch = await (await fetch(`${BASE}/api/items/batch/get`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ libraryItemIds: [String(first)] }),
  })).json();
  parses('a batched item', at(batch.libraryItems), 'ExpandedExtra');

  // --- the socket its client opens before anything else ----------------
  // The provider's init calls socketio.AsyncClient.connect() and catches only a
  // login error, so nothing listening here is a ConnectionError out of setup and
  // the whole integration never starts. This walks the Engine.IO v4 handshake
  // the way python-socketio walks it.
  const openRaw = await (await fetch(`${BASE}/socket.io/?EIO=4&transport=polling&t=abc`)).text();
  check('the handshake answers an open packet', openRaw[0], '0');
  const opened = JSON.parse(openRaw.slice(1));
  check('naming a session, a ping interval and a payload cap',
    [typeof opened.sid, typeof opened.pingInterval, typeof opened.maxPayload],
    ['string', 'number', 'number']);
  check('and offering no upgrade we cannot honour', opened.upgrades, []);

  const joined = await fetch(`${BASE}/socket.io/?EIO=4&transport=polling&sid=${opened.sid}`, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: '40',
  });
  check('joining the namespace is accepted', (await joined.text()).trim(), 'ok');

  const ack = await (await fetch(`${BASE}/socket.io/?EIO=4&transport=polling&sid=${opened.sid}`)).text();
  check('and the next poll carries the connect acknowledgement', ack.slice(0, 2), '40');
  check('with a socket id in it', typeof JSON.parse(ack.slice(2)).sid, 'string');

  const said = await fetch(`${BASE}/socket.io/?EIO=4&transport=polling&sid=${opened.sid}`, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: `42["auth","${token}"]`,
  });
  check('the token it announces itself with is taken', (await said.text()).trim(), 'ok');

  const unknown = await fetch(`${BASE}/socket.io/?EIO=4&transport=polling&sid=no-such-session`);
  check('a session we never opened is refused, as engine.io does', unknown.status, 400);

  // --- the handshake has a ceiling -------------------------------------
  // It is the one address here that cannot ask for the token — the client
  // connects first and says who it is afterwards — so it answers anybody on the
  // network and hands out memory. One Music Assistant needs one session.
  const tried = [];
  for (let i = 0; i < 12; i++) {
    const r = await fetch(`${BASE}/socket.io/?EIO=4&transport=polling&t=cap${i}`);
    tried.push(r.status);
  }
  check('a handful of handshakes are answered', tried.slice(0, 6).every((s) => s === 200), true);
  check('and past the ceiling it refuses rather than growing', tried.includes(503), true);

  // --- the tick is only moved by something that says so ----------------
  // The client sends isFinished and the position in separate calls, so a call
  // without isFinished must leave the tick exactly as it is — and a session
  // sync, which says nothing about being finished, must not rub one out.
  const tickOf = () => db.prepare('SELECT done FROM progress WHERE user = ? AND book_id = ?')
    .get('Frank', first)?.done;
  await fetch(`${BASE}/api/me/progress/${first}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ isFinished: true }),
  });
  check('saying finished ticks it', tickOf(), 1);
  await fetch(`${BASE}/api/me/progress/${first}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ duration: 30, currentTime: 10 }),
  });
  check('a position with no word about finishing leaves the tick alone', tickOf(), 1);
  const keep = await get(`/api/session/pl-${first}-ticktest`);
  await fetch(`${BASE}/api/session/${keep.id}/sync`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ currentTime: 12, timeListened: 2, duration: 30 }),
  });
  check('and a session sync does not rub it out either', tickOf(), 1);
  await fetch(`${BASE}/api/me/progress/${first}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ isFinished: false }),
  });
  check('but saying not finished does take it off', tickOf(), 0);

  // --- and it is not there at all without the token --------------------
  const anon = await fetch(`${BASE}/api/libraries`);
  check('no token, no answer', anon.status, 401);
} finally {
  // Gone before this process is, or it is orphaned still holding the port and
  // the next run of this suite meets it instead of its own server.
  server.kill();
  await new Promise((done) => {
    if (server.exitCode !== null || server.signalCode !== null) return done();
    server.on('exit', done);
    return setTimeout(done, 2000).unref?.();
  });
}

console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
