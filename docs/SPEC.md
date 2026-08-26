# My Audiobook Collection — build specification

**Version described: 1.9.8.** This document describes what the app is, how every
part of it behaves, and the decisions and traps behind those behaviours. It is
written to be handed back to an assistant later as the sole brief for rebuilding
the app.

## 0. How to use this, and what it can promise

Hand this file over and say: *"rebuild the app in this document."* What comes out
will match this app in structure, behaviour, API surface, database schema,
interface and deployment. What will **not** match byte for byte is the code
itself — wording of comments, order of small helpers, exact CSS values. Nothing
in the spec depends on those.

If you want a literal reproduction, keep the repository as well: this document
plus `https://github.com/Starf0x/my-audiobook-collection` at tag `v1.9.8` is an
exact answer. This document alone is a faithful one, and it is the part that
carries the *reasoning* the code cannot show — every rule in §9 is there because
something went wrong without it.

The verification suites in §11 are how you tell the rebuild is right. Rebuild,
then make them pass; they encode the behaviour that matters.

## 1. The product

A small, self-hosted web app that turns folders of audiobooks into a collection
you can browse, play and keep tidy. One Docker container, one SQLite file, no
account system, no cloud service beyond an optional Google Books lookup.

It reads a library that is already organised on disk:

```
/audiobooks
├── Fantasy                          <- genre
│   ├── Brandon Sanderson            <- author
│   │   └── Mistborn                 <- series folder (optional level)
│   │       ├── The Final Empire     <- book: the folder holding audio files
│   │       └── The Well of Ascension
│   └── Patrick Rothfuss
│       └── The Name of the Wind     <- book directly under the author
└── Thriller
    └── Stephen King
        └── The Shining
```

Two pages. `index.html` can change the collection (scan, import, tag, move,
delete). `listen.html` only browses, plays and remembers positions, and is the
one to share.

**Non-goals**, deliberately: it does not download audiobooks, has no catalogue of
its own, does not transcode, has no user accounts (a "user" is a name in a list,
for keeping positions apart), and never moves or renames anything unasked. It
writes tags into **MP3 only**; other formats are read, listed and played.

## 2. Working agreement

These are the standing rules the code was written under. They shape it more than
any feature does.

* **Keep the code short and plain. Make the smallest change that solves the task
  completely. Do not add abstractions, fallbacks, safety nets, refactors or
  features unless they are strictly necessary.** This is why there is no service
  layer, no ORM, no state-management library, no build step and no framework.
* **The interface is English.** Code comments are English, and they explain *why*,
  never *what* — a comment that restates the line is deleted.
* **Version numbers**: the third digit rises in steps of eight up to 75, then the
  second digit increments and the third resets. `1.8.40 → 1.8.48 → … → 1.8.72 →
  1.9.0`. Every shipped change gets a bump, a commit, a tag `vX.Y.Z`, and a push.
* **The real collection is read-only during development.** Test against generated
  fixtures. Never import, move, delete or write tags against the owner's share.
* **Secrets are never typed by the assistant.** API keys, tokens and passwords are
  entered by the owner, in their own tools. A token pasted into a chat is
  compromised and must be revoked.
* **Screenshots must not show a real username or local path.** Take them against
  a demo library mounted so paths read `/audiobooks`.

## 3. Stack and file inventory

Node 26, Express 5, ESM (`"type": "module"`), `node:sqlite` (`DatabaseSync` —
synchronous, single connection), no build step, no client framework.

```json
"dependencies": {
  "express": "^5.1.0",
  "music-metadata": "^11.2.1",
  "node-id3": "^0.2.9"
}
```

`music-metadata` reads tags (async). `node-id3` writes them (synchronous, and it
*merges* into a file rather than replacing its tags). Everything else is Node
built-ins: `node:sqlite`, `node:crypto`, `node:worker_threads`, `node:fs`.

| File | Lines | What it is |
| --- | --- | --- |
| `server/index.js` | 391 | Express app: every route, and nothing else |
| `server/db.js` | 107 | schema, migrations, settings, library list |
| `server/admin.js` | 47 | the one password, sessions, `requireAdmin` |
| `server/scan.js` | 330 | walking the library, reading tags, filing books |
| `server/pool.js` | 42 | the lane cap and the item pool for disk work |
| `server/google.js` | 170 | Google Books lookup, and writing tags into files |
| `server/tagpool.js` | 51 | worker-thread pool for tag writes |
| `server/tag-worker.js` | 13 | the worker: one `NodeID3.update` per message |
| `server/tagall.js` | 115 | the resumable whole-collection tag run |
| `server/import.js` | 334 | import candidates, quality comparison, filing |
| `server/trash.js` | 173 | move, delete to trash, restore, purge |
| `server/validate.js` | 116 | checking every book against the disk |
| `server/covers.js` | 118 | tidying unused cover files, zipping them |
| `server/placeholder.js` | 94 | the cover drawn for a book that has none |
| `public/index.html` | 196 | the admin page: columns, dialogs |
| `public/app.js` | 1352 | the admin page's behaviour |
| `public/listen.html` | 58 | the listening page |
| `public/listen.js` | 321 | the listening page's behaviour |
| `public/style.css` | 266 | the whole look, both pages |

Static files are served from `public/` by `express.static`. `app.use(express.json({ limit: '1mb' }))`.

## 4. Data model

`DATA_DIR` (default `/data`) holds `library.db` and a `covers/` folder, both
created at import time of `db.js`. `PRAGMA journal_mode = WAL`.

```sql
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE books (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE,                      -- the book folder on disk; the identity
  genre TEXT, author TEXT, series TEXT, title TEXT,
  narrator TEXT, year TEXT, description TEXT, cover TEXT,
  duration REAL DEFAULT 0,
  tagged TEXT DEFAULT '',                -- which tags the FILES carry, comma list
  tag_series TEXT DEFAULT '',            -- series the files claim (never moves files)
  series_no INTEGER DEFAULT 0
);

CREATE TABLE tracks (
  id INTEGER PRIMARY KEY,
  book_id INTEGER, idx INTEGER, path TEXT, title TEXT, duration REAL
);
CREATE INDEX tracks_book ON tracks (book_id);

CREATE TABLE progress (
  user TEXT, book_id INTEGER, track_idx INTEGER, position REAL, updated TEXT,
  done INTEGER DEFAULT 0,
  PRIMARY KEY (user, book_id)
);

CREATE TABLE users (name TEXT PRIMARY KEY);

-- the whole-collection tag write, and what is left of it
CREATE TABLE tagrun (
  id INTEGER PRIMARY KEY,
  total INTEGER, done INTEGER, written INTEGER, failed INTEGER,
  state TEXT, current TEXT, started_at TEXT, finished_at TEXT
);
CREATE TABLE tagqueue (book_id INTEGER PRIMARY KEY);

CREATE TABLE broken (
  book_id INTEGER PRIMARY KEY, reason TEXT, detail TEXT, checked_at TEXT
);

CREATE TABLE replaced (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE, was_path TEXT,
  genre TEXT, author TEXT, series TEXT, title TEXT,
  files INTEGER, bytes INTEGER, quality TEXT, replaced_at TEXT
);

CREATE TABLE trash (
  id INTEGER PRIMARY KEY,
  was_path TEXT, trash_path TEXT,
  genre TEXT, author TEXT, series TEXT, title TEXT,
  files INTEGER, deleted_at TEXT
);

-- SQLite hands out row ids again: without this a new book inherits a deleted
-- book's "broken" verdict.
CREATE TRIGGER broken_follows_books AFTER DELETE ON books
BEGIN DELETE FROM broken WHERE book_id = OLD.id; END;
```

Everything is `CREATE TABLE IF NOT EXISTS`. Four columns added after the first
release are also applied as guarded `ALTER TABLE` in `try/catch`, so an old
database catches up: `progress.done`, `books.tagged`, `books.tag_series`,
`books.series_no`.

Two one-off repairs run at startup: descriptions that are iTunes normalisation
hex (`/^[0-9a-f]{6,8}( +[0-9a-f]{6,8})+$/i`) are emptied, and the old
`adminHash`/`adminSalt` settings rows are deleted (the password comes from the
container now).

**Settings rows in use**: `libraries` (JSON array of `{path, asGenre}`) and
`importPath` (string). A library entry stored as a plain string is read as
`{path, asGenre: false}`. `getLibraries()` never throws — bad JSON yields `[]`
rather than failing every request.

The `series` a book is *filed* under (a folder) and the `tag_series` its files
*claim* are kept apart, and the interface merges them with one SQL fragment
reused by every list:

```js
const SERIES = "NULLIF(COALESCE(NULLIF(b.series, ''), NULLIF(b.tag_series, '')), '')";
```

## 5. Configuration and deployment

### Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATA_DIR` | `/data` | database and covers |
| `PORT` | `8523` | HTTP port |
| `ADMIN_PASSWORD` | empty | set → the admin page must be unlocked; empty → private install, everyone may do anything |
| `GOOGLE_API_KEY` | empty | Google Books lookups |

Both secrets live **only** on the container. There is deliberately no field for
either in Settings: one place cannot drift out of step with another, and both
survive an emptied appdata folder.

### Dockerfile

`node:26-alpine`, `npm ci --omit=dev`, copy `server` and `public` only, `ENV
DATA_DIR=/data PORT=8523`, `VOLUME /data`, `EXPOSE 8523`, `CMD ["node",
"server/index.js"]`. Unraid labels on the image so the WebUI link, icon and Force
update work even for a container not made from the template:
`net.unraid.docker.managed=dockerman`,
`net.unraid.docker.webui=http://[IP]:[PORT:8523]/`, `net.unraid.docker.icon=` a
publicly reachable PNG URL, plus the three `org.opencontainers.image.*` labels.
The icon URL must stay reachable — Unraid retries a failing icon on every page
refresh and it blinks.

`.dockerignore`: `node_modules`, `.git`, `data`, `*.md`, `docs`.

### Unraid template

`my-My-Audiobook-Collection.xml`, `<Container version="2">`, `<Name>My-Audiobook-Collection</Name>`.
Config entries: WebUI Port `8523`, Appdata → `/data`, Audiobooks → `/audiobooks`
(rw, because tags are written), Import folder → `/import` (optional),
`ADMIN_PASSWORD` and `GOOGLE_API_KEY` as `Type="Variable"` with `Mask="true"`.

**Warn about this in the docs, prominently**: Unraid stores a container's saved
configuration in `/boot/config/plugins/dockerMan/templates-user/my-<container
name>.xml` — the *same* place a shipped template is copied to. Telling someone to
`wget` the repo template over that file wipes their paths, password and API key.
The template is copied there once, before the container exists; after that it is
their config. `<Name>` inside the file must match the container name or the
Docker tab stops treating it as managed. Force update lives in the Docker tab's
*Advanced View* only.

### Publishing

`.github/workflows/docker.yml`, on push to `main` and on `v*` tags:
checkout → `docker/setup-buildx-action@v3` → `docker/login-action@v3` →
`docker/metadata-action@v5` (tags: `type=ref,event=tag` and
`type=raw,value=latest,enable={{is_default_branch}}`) →
`docker/build-push-action@v6` for `linux/amd64,linux/arm64` →
`peter-evans/dockerhub-description@v4` (main only).

Secrets: `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`.

**There is one README.** The Docker Hub page is generated from `README.md` by that
last step, so "update both READMEs" is one edit. Images in it must use absolute
`raw.githubusercontent.com` URLs — Docker Hub does not resolve repo-relative
paths.

The manual lives in the GitHub **wiki** (a separate git repository,
`<repo>.wiki.git`, default branch `master`): `Home`, `Installing on Unraid`,
`Setting up your library`, `How your folders are read`, `Browsing and listening`,
`Metadata and tags`, `Importing audiobooks`, `Moving and deleting`, `Sharing with
others`, `Settings reference`, `Troubleshooting`, plus `_Sidebar.md` and an
`images/` folder. It documents use, never the development process.

## 6. HTTP API

`wrap(fn)` turns a thrown error into `400 {error: message}`. `requireAdmin`
answers `403 {error: 'Only the admin can change things here. Unlock first.'}`.
Everything is JSON except `/api/cover/:id` and `/api/stream/:trackId`.

| Method, path | Guard | Purpose |
| --- | --- | --- |
| `GET /api/admin` | — | `{required, admin}` |
| `POST /api/admin/unlock` | — | password → sets `admin` cookie (HttpOnly, SameSite=Lax, 30d) |
| `POST /api/admin/lock` | — | drops the session and the cookie |
| `GET /api/users` | — | names |
| `POST /api/users` | — | add a name |
| `GET/POST /api/settings` | admin | `{libraries, importPath}` |
| `GET /api/browse?path=` | admin | folder picker: `{path, parent, entries}` |
| `GET /api/genrefolders` | admin | `{folders, suggestedParent}` |
| `POST /api/genres` | admin | make a genre folder, register it if needed |
| `GET /api/files/status` | — | file-operation progress |
| `GET /api/import/state` | admin | cache state of the candidate list |
| `GET /api/import?refresh=` | admin | `{path, genres, candidates, cachedAt, fromCache}` |
| `GET /api/import/compare` | admin | `{exists, dest, incoming, existing}` |
| `POST /api/import/skip` | admin | rename the source `Not Imported - …` |
| `POST /api/import` | admin | file the book; `{replace}` to displace what is there |
| `GET /api/tagall/status` | — | the run |
| `POST /api/tagall` | admin | start or resume |
| `POST /api/tagall/stop` | admin | pause, keeping the queue |
| `GET /api/validate/status` | — | disk-check progress |
| `POST /api/validate` | admin | start the disk check |
| `GET /api/broken` | admin | list, each with `onDisk` |
| `POST /api/broken/:id/recheck` | admin | re-read one book |
| `POST /api/broken/:id/delete` | admin | trash it, or forget it when the files are gone |
| `POST /api/covers/tidy` | admin | move unused covers to `covers/duplicates` |
| `POST /api/covers/duplicates/delete` | admin | delete the loose ones |
| `POST /api/covers/duplicates/zip` | admin | zip them, remove the loose ones |
| `GET /api/replaced` | admin | copies an import displaced |
| `POST /api/replaced/all`, `POST /api/replaced/:id` | admin | delete them |
| `POST /api/move/:id` | admin | move a book to genre/author/series/title |
| `GET /api/trash` | admin | what is in the trash, with days left |
| `POST /api/trash/:id` | admin | delete a book to the trash |
| `POST /api/trash/:id/restore`, `/purge`, `POST /api/trash/empty` | admin | the rest of the trash |
| `POST /api/scan` | admin | `{path}`: one library folder, or all when empty |
| `GET /api/scan/status` | — | `{running, done, total, current, books, error, warning}` |
| `GET /api/stats` | — | `{books, files, done, todo}` |
| `GET /api/untagged` | admin | the Needs-tags list, split `fixable` / `needsLookup` |
| `GET /api/home` | — | `{continue, recent}` |
| `GET /api/genres` | — | `[{name, books, series: [{name, books}]}]` |
| `GET /api/authors?genre=` | — | `[{name, books}]` |
| `GET /api/books?genre=&author=|series=&user=` | — | cards |
| `GET /api/search?q=&user=` | — | cards, across everything |
| `POST /api/listened` | — | mark a book listened |
| `GET /api/books/:id?user=` | — | one book, with `tracks`, `progress`, `folderSeries`, `coverV` |
| `GET /api/cover/:id?v=` | — | the picture, or a drawn one |
| `GET /api/stream/:trackId` | — | audio, with byte-range support |
| `POST /api/progress` | — | position, per user |
| `GET /api/lookup/status` | — | retry state of a lookup |
| `GET /api/lookup`, `GET /api/lookup/:id` | admin | Google Books results |
| `GET /api/apply/status` | — | tag-write progress |
| `POST /api/apply/:id` | admin | apply a chosen result, optionally writing tags |

Cover URLs carry a marker so a browser may cache for a week:

```js
const coverV = (b) => crypto.createHash('md5')
  .update(b.cover || `title:${b.title || ''}`).digest('hex').slice(0, 12);
```

Falling back to the **title** when there is no picture is what makes a renamed
book ask for a new drawn cover instead of showing the old name for a week.

## 7. Server behaviour

### 7.1 Scanning (`scan.js`)

Constants:

```js
const AUDIO = /\.(mp3|m4a|m4b|ogg|flac|opus)$/i;
const COVER = /^(cover|folder|front)\.(jpg|jpeg|png)$/i;
export const DISC = /^(disc|disk|cd|part|tape)[\s._-]*\d+$/i;
export const NOT_IMPORTED = 'Not Imported - ';
export const REPLACED = 'Replaced - ';
```

`dirs()` skips folders starting with `.` (the trash) and folders set aside by an
import (either prefix). `audioFiles()` sorts with `localeCompare(…, {numeric:
true})` so `2` sorts before `10`.

How a third-level folder is read:

| It contains | Read as |
| --- | --- |
| audio files | a **book** |
| several sub-folders | a **series**, each sub-folder a book |
| sub-folders all matching `DISC` (two or more) | **one book**, discs concatenated in order |
| exactly one sub-folder | **one book** — a series of one has nothing to group |

A library entry is either a folder of genre folders (`asGenre: false`) or a single
genre folder (`asGenre: true`). `looksTooDeep()` samples three children and three
grandchildren, and if audio sits two levels down the scan reports a **warning**:
the entry is a genre folder and every author would otherwise be filed as a genre.

**Series, from three places** — all shown identically, and only the first moves
files:

1. a **series folder**: `genre/author/series/book`
2. **sibling folder names** (`seriesFromSiblings`): folders under one author
   differing only by a volume number. Two or more make a series. A bare folder
   named exactly like the prefix becomes book 1. `DISC` names never count.
3. the **files** (`seriesFromTags`): the movement name `MVNM`, the grouping frame
   `TIT1`, or a `TXXX` frame described `series`/`album series` — whichever is set
   and differs from album and title. `movementIndex` gives the number.

Volume splitting, applied to folder names *and* tag-derived names (a tag often
names the volume, so `The Dark Tower V` must become book 5 of *The Dark Tower*
rather than a series of its own):

```js
const VOLUME = /^(.*?)[\s,._-]*(?:(?:book|vol|volume|part|deel|boek)[\s.]*)?(\d{1,3}|[ivxlcdm]{1,7})$/i;
// roman numerals i–xx map to 1–20
// the prefix must be at least 3 characters and the number non-zero, else no split
```

Per book, `readMeta` reads every file with `parseFile` — **without** `{duration:
true}`, which would scan every frame of every MP3 (about four seconds each); the
header duration is enough for a badge. It collects title, narrator (`composer`,
else `artist`), year, description, per-track titles and durations, and the
embedded cover. `descriptionOf` drops iTunes normalisation hex. `taggedFields`
records which of album, title, artist, album artist, narrator, genre, year,
description, cover, track no the **files** carry.

Cover art is written to `DATA_DIR/covers/<md5 of the bytes>.jpg`, so identical art
is one file and new art gets a new name. A local `cover.jpg`/`folder.png`/`front.*`
beside the book is used as `file:<absolute path>` when the tags carry none.

**The unchanged fast path.** A book whose file paths are unchanged is not re-read;
`touchBook` refreshes genre, author, series, `tagged`, `tag_series` and
`series_no` from one parse of the first file (`firstFileTells`). Two things depend
on it:

* it must still write `tag_series`/`series_no`, or a series inferred from tags
  never appears for a library that was scanned by an older version;
* `addBook(..., force)` bypasses it. A replacing import lands on the very same
  file names, and without `force` the old copy's duration, cover and description
  would be kept.

Progress is a module-level object; `running` is set **before** walking the tree,
because the walk of a large share takes tens of seconds and the interface would
otherwise read the scan as finished. `scan()` catches everything: the caller does
not await it, so an unhandled rejection would take the process down.

Books whose folders are gone are dropped at the end of a scan — but only within
the scope that was scanned.

### 7.2 Doing the waiting in parallel (`pool.js`)

Nearly all of a scan is waiting for the disk. `LANES = clamp(availableParallelism
- 1, 2, 8)` bounds how many reads are in flight **globally**, whatever asks for
them; `lane(fn)` takes a lane, `pool(items, fn, lanes)` keeps that many items
moving. Only the reads themselves take a lane, so a pool of books whose files
each take a lane cannot deadlock.

Used by: the scan's book loop and its tag reads, the disk check (books and files),
`qualityOf`, the import candidate build, and `copyTree` — which also switched from
blocking `fs.copyFileSync` to `fs.promises.copyFile`.

All SQLite work stays on the main thread (`DatabaseSync` is one synchronous
connection), and track ordering stays with the caller.

### 7.3 Lookup and tag writing (`google.js`, `tagpool.js`, `tag-worker.js`)

Query: `intitle:<title> inauthor:<author>` unless the user typed their own, five
results, `https://www.googleapis.com/books/v1/volumes`. A 503 is retried after 10,
20 and 30 seconds, with `lookupProgress` exposing the attempt and the wait so the
dialog can show it. Every other status gets a plain-English explanation naming the
likely cause (bad key, Books API not enabled, quota).

Applying a result updates title, narrator, year, description and cover in the
database. **Author and genre are navigation keys derived from folders**, so they
are never changed by a lookup — only written into the tags. Picking one of two
credited authors changes the artist tags, not the folder.

What a tag write puts in every MP3 of a book:

| Frame | From |
| --- | --- |
| `TALB` album, `TIT2` title | the book title — every file carries the book title, not "018 of 132" |
| `TPE1` artist, `TPE2` album artist | the author |
| `TCON` genre | the genre folder |
| `TYER` year, `COMM` description, `APIC` cover | the book's metadata |
| `TCOM` composer | the narrator |
| `TRCK` track number | renumbered in playing order, zero padded to at least two digits: `01/12`, `001/120` |

Empty values are **deleted from the tag object** before writing, because an empty
frame reads back as "present".

`NodeID3.update` is synchronous and rewrites the whole file. It runs on a small
worker pool (`tagpool.js`, `min(4, availableParallelism - 1)` threads, lazily
created, `unref`'d, a dead worker is replaced and its file reported as not
written). `apply_` hands every file of the book to that pool at once and counts
as each finishes.

**One writer at a time**, whoever asks: a module-level `writing` flag makes a
second write fail with *"A tag write is already running. Wait for it to finish,
or stop it in Settings."* Each write reports into its **own** progress sink
(`newTagProgress()`), because two writers sharing one counter is what produced a
bar reading `193 / 157`.

### 7.4 The whole-collection run (`tagall.js`)

State in two tables: `tagrun` holds one row (`total, done, written, failed, state,
current, started_at, finished_at`), `tagqueue` holds what is left. That is what
makes it resumable: closing the page does not stop it, and `Stop` leaves the queue
alone so the button becomes *Carry on writing tags*.

States: `idle → running → paused | done`. `startTagAll` resumes when a queue is
left and the run is not `done`, else clears and refills the queue from every book.
The loop writes one book at a time (each book's files in parallel on the worker
pool), drops it from the queue, and yields with `setImmediate` between books. One
unreadable book counts as `failed` and does not stop the run.

`settleTagAll()` runs at startup: a run left `running` by a container restart
becomes `paused`, with its place kept. Writing to files is not something to begin
again on its own.

### 7.5 Import (`import.js`)

`importPath` is scanned for book folders however deep they sit: a folder holding
audio is a book, and so is one whose sub-folders are all discs. Each candidate
gets a guessed genre (a leading folder that names a known genre), author, series
and title from the folders around it and from one tag read. The list is cached
with a signature of the folders, handed back at once next time, and refreshed by a
background pass.

`clean()` strips characters a path cannot hold. `destinationFor()` builds
`<genre>/<author>/[series]/<title>`.

**Quality comparison.** `qualityOf(dir)` measures files, bytes, duration, sample
rate, channels, codec, lossless, and computes bit rate as `bytes * 8 / duration /
1000` — measured, not read from a header, so a mislabelled file cannot flatter
itself. `compareWithExisting` returns both sides when something already sits at
the destination, and the page asks the user which to keep, bit rate first.

Two outcomes, and both leave a folder that names itself:

* **Replace**: the copy that is there is renamed `Replaced - <name>` (with ` (2)`
  and so on if that exists), a `replaced` row records it, and the incoming folder
  takes the destination path — so the book keeps its row, and with it every
  listener's position and every listened mark. The old copy is listed under
  **Replaced** until deleted.
* **Keep the one I have**: the incoming folder is renamed `Not Imported - <name>`
  and left where it is.

Both prefixes hide a folder from the scanner and neither is offered again.

**Rollback.** If the move fails after the old copy was stepped aside, it is
renamed back and the `replaced` row deleted — otherwise the library points at a
folder that is not there.

The folder is **moved**, not copied. Across mounts, `copyTree` copies (in lanes,
async) and then removes the source, reporting file counts through `fileProgress`.
`pruneEmptyParents` drops the folders the source left empty. The book is filed
into the library immediately with `addOne` (with `force` when it replaced
something), and the row is handed back so the page can open the genre and author
it landed under.

### 7.6 Moving, deleting, restoring (`trash.js`)

`KEEP_DAYS = 30`. A delete moves the book folder into a `.trash` folder **inside
the same library folder** — same filesystem, and hidden from the scanner by the
leading dot — and records it. The trash list offers *Put back*, *Delete now* and
*Empty trash*, and anything older than 30 days is dropped at startup and once a
day after.

A move shifts the folder and keeps the row, so listened state and position travel
with it. `dropEmptyParents` removes an author or series folder the last book just
left, so no empty author is listed; the genre folder itself always stays. A
restore recreates whatever folders it needs.

### 7.7 Checking against the disk (`validate.js`)

A scan trusts the folders it walks; this does not. It stats and parses **every
file of every book** (in lanes), and is never automatic — the page warns that it
takes minutes on a large collection.

| `reason` | What it means |
| --- | --- |
| `gone` | the folder is not there any more |
| `unreadable` | the folder cannot be read |
| `empty` | no audio files left in it |
| `damaged` | *n* of *m* files cannot be read (zero bytes, or a header that will not parse) |
| `changed` | the files the library listed are gone, others are there — a scan will pick those up |

Verdicts live in `broken`, so the list survives a restart, and the trigger in §4
keeps a deleted book's verdict from being inherited. Each entry offers *Check
again*, and either *Delete…* (to the trash, files still there) or *Forget it*
(row, tracks, positions and verdict deleted; there are no files to move).

### 7.8 Cover files no longer needed (`covers.js`)

Covers are named after the image, so new artwork leaves the old file behind.
**Tidy up unused covers** moves every file in `covers/` no book refers to into
`covers/duplicates`, overwriting a same-named file there. Past `ZIP_AT = 1000`
files it says so and asks: decline the delete and they are zipped (a
hand-written, dependency-free store-only ZIP with a CRC-32 table, reading one
file at a time) and the loose files removed.

### 7.9 A cover for books that have none (`placeholder.js`)

`GET /api/cover/:id` answers with a drawn SVG when the book has no art **or when
the art it names is no longer on disk** (a deleted cover file used to render as a
broken image). Only a book that does not exist is still a 404. This is what
removed the last `onerror` fallbacks from the pages.

The drawing, on a 400×600 canvas (2:3, the shape of real art):

* hue = first two bytes of the md5 of the title, mod 360; a second hue at +42°
* background: diagonal gradient `hsl(h, 34%, 19%)` → `hsl(h2, 42%, 8%)`, with two
  soft radial glows (top-left in the first hue, bottom-right in the second) —
  the same treatment as the app's own background
* a spine: 22px of black at 0.28, and a 1.4px white line at 0.12 beside it
* headphones, centred at (200, 250): an arc `M126 250 A 78 78 0 0 1 282 250`
  stroked 15px round, and two 32×78 rounded earcups, all white at 0.15
* `AUDIOBOOK` at (42, 62), 14px, letter-spacing 4.5, white at 0.42
* a 46×4 accent rule in `hsl(h2, 90%, 68%)` above the title
* the title bottom-anchored, bold, at 40px (max 4 lines), else 33px (5), else
  27px (6) with an ellipsis; wrapped greedily on an estimate of `0.53em` per
  character within 318px
* the author above the bottom edge at 20px, uppercase, letter-spacing 1.6, white
  at 0.66; omitted when unknown
* a hairline inner border, white at 0.09

Sent as `image/svg+xml` with `Cache-Control: public, max-age=604800`. Nothing is
written to disk. A book with a drawn cover still counts as needing tags.

### 7.10 Search

One box, one query. Every word must appear somewhere in the same book, matched
against a haystack of seven columns:

```js
const HAYSTACK = ['b.title', 'b.author', 'b.genre', 'b.series', 'b.tag_series',
                  'b.narrator', 'b.description'].map((c) => `COALESCE(${c}, '')`).join(" || ' ' || ");
// WHERE <haystack> LIKE ? AND <haystack> LIKE ? ...   (one per word)
// ORDER BY CASE WHEN b.title LIKE ? THEN 0 WHEN b.author LIKE ? THEN 1 ELSE 2 END,
//          b.author, b.series_no, b.title
// LIMIT 200
```

At most 6 words; fewer than two characters in total returns nothing. `COALESCE`
on every column matters — concatenating a NULL in SQLite yields NULL and the book
would never match. Results carry the same fields as an ordinary book list, so
both pages render them with the code they already have.

### 7.11 The one password (`admin.js`)

`ADMIN_PASSWORD` on the container. A salt is made at startup and the password is
never stored: `scryptSync(password, bootSalt, 32)` on both sides, compared with
`timingSafeEqual`. An unlocked browser holds a random 24-byte token in an
`HttpOnly` cookie; sessions live in memory and are forgotten on restart. With no
password set, `adminRequired()` is false and everything is allowed — a private
install.

**The server refuses, the interface merely hides.** Every route that changes
anything carries `requireAdmin`; hiding buttons is not what protects it.

### 7.12 Who is listening, and which names a browser is offered

A listener has no password: the app is shared inside a house, and the one admin
password guards what *changes* the collection. What keeps one person out of
another person's place in a book is that **a browser is only ever offered the
names it has said itself**.

The names a browser has claimed live in a cookie it gets back from the server —
`whoami`, a base64url JSON array, `HttpOnly`, `SameSite=Lax`, 400 days:

* `GET /api/users` returns the claimed names that still exist in `users`, sorted.
  No cookie means an empty list, whatever the collection holds. A cookie the
  server did not write is ignored rather than trusted.
* `POST /api/users` inserts the name if it is new, adds it to the cookie, and
  returns `{ok: true}`. An empty name claims nothing.

The dialog needs no special case: it renders a pick list only when it was given
names, so a stranger sees the field alone. Both pages claim
`localStorage.user` on load, so a browser that was here before an update keeps
its name and its dropdown instead of being asked again.

Two consequences, both intended. A browser two people share is offered both names
once both have typed theirs — what a family tablet needs. And someone who knows an
existing name exactly can still type it and take that place up; on a new phone
that is the point, and without a password per listener the two cannot be told
apart. The guarantee is about not *offering* names, not about proving identity.

## 8. The interface

No framework, no build. `$` is `querySelector`, `api()` throws the server's
`error` message, `toast()` shows it. `esc()` escapes `& < > "` — folder names and
Google descriptions land in markup.

Layout, both pages: a header (title, **search box**, user select, and on the admin
page the scan-scope select, *Scan library* and *Settings*), then three columns —
**Genres** (with a **Maintenance** section on the admin page), **Authors**,
**Books** — a per-job progress area, and a footer player.

Theme (CSS custom properties): `--bg #0e1014`, `--panel #16191f`, `--panel2
#1c2027`, `--line #262b34`, `--text #e6e8ec`, `--dim #a2a9b8`, `--accent
#7c5cff`, `--accent2 #22d3ee`; the body carries two large radial glows in the
accent colours over `--bg`, fixed. `body { cursor: default; user-select: none }`
because this is an application, not a document — inputs, descriptions and status
text opt back in.

Covers are 2:3 everywhere: 96×144 on cards, 104×156 on tiles, 60×90 on lookup
candidates, 36×54 in the footer.

**One job at a time.** `work(button, what, fn)` refuses a second job with a toast,
adds `body.working` (which greys every button that would start work, to opacity
0.45 and `pointer-events: none`, including `[data-pick]` candidates), disables the
button that was pressed, and restores both in a `finally`. Every job button goes
through it: scan, import, tag writes (card, needs-tags row and edit dialog),
disk check, cover tidy, trash actions.

**One bar per job.** `newBar(label)` adds a `.job` bar to `#progress` so two
concurrent jobs sit side by side and never share a counter; each polls its own
status endpoint and removes itself a few seconds after finishing.

**Genres fold.** Each genre with series shows a twist arrow (`▸`/`▾`). The arrow
alone folds; clicking the **name** selects the genre and leaves the list as it
was. Open genres are remembered in `localStorage.openGenres` and restored on
load. Series rows are `li[data-genre][data-series]`, selected with `CSS.escape`.

**Books** are cards: cover, listened checkbox, title with a listened/part/new
note, author, `Series · <name> · book <n>`, badges (year, narrator, running time,
and either the tags the files carry or *Not in MP3*), the description, and the
actions — *Play*, *Find metadata*, *Write into MP3s*, *Edit metadata*, *Move…*,
*Delete…*. The listening page shows the same card with *Play* only.

**Landing view** (`#home`): shelves of tiles — *Continue listening* with a
progress bar, and *Recently added*.

**Search**: typing is debounced 200 ms, Enter searches at once, Escape clears.
Results head the column with `Search · <query> · <n> books`; nothing found says
`Nothing matches "<query>".` Emptying the box restores what was on screen (series,
author or the shelves). Drawing any other book list clears the box, so it never
says something the screen does not.

**Dialogs** (native `<dialog>`): Settings (libraries with *Is a Genre*, a folder
browser, genres, import path, the disk check, cover tidy, and the whole-collection
tag run with its state line); *Who is listening*; *Import* (source, genre, author,
series, title, and a line showing exactly where it will land); the **conflict**
dialog comparing two copies row by row with the better value marked; *Find
metadata* (five results, a search box, the author choice when two are credited,
and category-as-genre buttons); *Edit metadata* (title, author, series, narrator,
year, description — with the book's folder and file count at the foot, above the
buttons); *Move…*.

**Maintenance lists** (admin page, `body.maintenance`): *Needs tags* (what a write
can fix now versus what needs a lookup), *Broken on disk*, *Import* (ten per
page), *Replaced*, *Trash* — each with its count in the left column.

The listening page mirrors browsing, series, folding, search and the player, and
carries an **Admin** button that unlocks and opens the other page. A visitor who
types the admin address is sent to the listening page.

## 9. Invariants and traps

Every rule here exists because its absence caused a real bug. A rebuild that
skips them will reproduce the bugs.

1. **`x += await y` loses updates.** The reference is read *before* the await, so
   with several books in flight the additions overwrite each other. Read into a
   local first. (A scan of seven books reported one.)
2. **Two writers must not share a progress object** — that is the `193 / 157`
   bar. Per-write sinks, plus a module-level single-writer guard that explains
   itself when it refuses.
3. **The scan's unchanged fast path must still refresh the tag-derived series**,
   or series never appear for a library scanned by an older version.
4. **A replacing import must scan with `force`**, or "same file names" is read as
   "unchanged" and the old copy's duration, cover and description survive.
5. **A volume number in a *tag* must be split off too**, or `The Dark Tower V`
   becomes its own series beside `The Dark Tower`.
6. **Concurrent cover writes**: two books can carry the same art. Write only when
   the file is absent, and shrug if it appears meanwhile — on Windows the second
   open can fail and would otherwise kill the whole scan.
7. **A slow job must grey what would start another one**, candidates included, or
   a second click reopens the conflict dialog while the first import is running.
8. **A stepped-aside copy must be put back when the import fails**, or the
   library points at a folder that is not there.
9. **`progress.running` before the walk**, not after — the walk itself is slow.
10. **`scan()` swallows its own errors**: nobody awaits it.
11. **Delete the `broken` row when a book goes** (the trigger): SQLite reuses ids.
12. **`COALESCE` every column in the search haystack**, or a NULL erases the row.
13. **The cover URL marker must change when the title does** for books with no
    art, or a rename shows the old drawn cover for a week.
14. **No `{duration: true}` when parsing**: it reads every frame, about four
    seconds per file.
15. **Empty tag values are deleted, not written** — an empty frame reads as
    present, and the Needs-tags list would clear itself falsely.
16. **`node-id3` merges**: writing a subset does not remove other frames.
17. **Never tell anyone to copy the repo template over
    `templates-user/my-<name>.xml`** — that is where Unraid keeps their settings.
18. **All SQLite work on the main thread.** `DatabaseSync` is one synchronous
    connection; workers are for `NodeID3.update` only.
19. **Only reads take a lane.** A pool of books whose files also pool must not
    hold a lane while waiting for its children.
20. **Sort file names numerically** (`localeCompare(…, {numeric: true})`), or
    track 10 plays before track 2.
21. **Never hand a browser the whole list of listeners.** `GET /api/users`
    answers with the names *that browser* has claimed; a first-time visitor gets
    an empty list, and the dialog then shows only a field to type one in.
22. **Tooling note for whoever rebuilds this**: writing JavaScript through a
    shell mangles template literals, `${…}` and `\d`. Use a file-writing tool for
    anything containing them, and grep the result afterwards.

## 10. Measured performance

Numbers from the machine this was built on (20 CPUs; the share is SMB on a NAS).
Both benchmark scripts read disjoint halves of the same tree so a warm cache
cannot flatter the parallel run.

| What | Before | After |
| --- | --- | --- |
| one tag read per book, cold, on the share | 1159.9 ms/book | 376.0 ms/book (3.1×) |
| the same on a local SSD | 2.0 ms/book | 0.4 ms/book (4.6×) |
| one tag write, 5 MB file | 18.5 ms | 6.4 ms (2.9×) |
| worst event-loop stall while writing | 29 ms | 12 ms |
| 480 files of 5 MB, whole-collection write, end to end | ~8.9 s | 3.0 s |
| scan of a 60-book library, local SSD, end to end | 1.2 s | 0.8 s |

The lesson worth keeping: the read side is **latency**, so overlap it (lanes); the
write side is **synchronous CPU work in a native module**, so move it off the main
thread (workers). Do not use threads for the reads or lanes for the writes.

## 11. Verification

Test scripts are standalone `.mjs` files run with plain `node`, each building its
own fixture library of real (silent) MPEG frames, starting the server on its own
port with its own `DATA_DIR`, asserting with a one-line `check(label, got, want)`,
and printing `all checks passed`. UI suites drive headless Edge over CDP
(`--headless=new --remote-debugging-port=9222`) and evaluate expressions in the
page. They live outside the image and are not shipped.

Server suites:

| Suite | What it pins down |
| --- | --- |
| `admin-test` | every changing route refused while locked, listening routes still answering, right/wrong password, the cookie, lock again, no route to set a password, a stored hash cleared at startup |
| `scan-scope` | scanning one library leaves the others alone; a full scan forgets a library no longer listed; an unknown folder is refused |
| `sibling-series` | volume grouping: bare first volume, one volume alone, disc folders, short prefixes, titles that merely end in roman letters, two series kept apart |
| `rescan-series` | a library scanned by an older version picks up its series on a rescan, without folders changing |
| `one-writer` | two tag writes at once: one runs, the other is refused with a reason; counts never run past their own totals |
| `tagall-test` | the resumable run: paused across a restart, resumed to completion, every file written once, a fresh run starting over, a `running` row settled to `paused` at startup |
| `validate-test` | each broken reason found, a recheck clearing a repair, delete-to-trash versus forget, progress ending complete |
| `covers-test` | unused covers moved aside, a cover back in use kept, the 1000-file threshold, zipping, deleting |
| `replace-rollback` | a failing replacing import puts the old copy back, leaves no `Replaced` row, and the same import then works |
| `who-names` | a first browser is offered nobody, then only its own name; two browsers never see each other's; a shared browser is offered both; an empty name claims nothing; a forged cookie is ignored; a deleted name drops off |
| `who-ui` | the dialog a stranger sees: asked, offered nobody though names exist, a field labelled *Your name*, an empty dropdown; after typing, remembered and not asked again |
| `cover-fallback` | art present → the file; none → SVG with title and author; art deleted → SVG; unknown book → 404; deterministic; a rename asks for a new picture |

UI suites: `search-ui` (the box on both pages: each match kind, multi-word,
nothing found, clearing, letting go on a genre click), `greyed-button` (the
clicked button and everything else greyed at click time, restored after),
`collapse` (arrow folds, name selects, remembered across a reload),
`series-bars` (series nested under genres, reading order, two jobs two bars),
`edit-path` (the dialog names the folder and the file count), `broken-ui`,
`three-checks`, `repro-conflict`, `ui-covers`.

Two habits worth copying. **Fixture exhaustion and timing are test bugs, not app
bugs**: a suite that writes tags consumes its own Needs-tags rows, and a job that
now finishes in 300 ms cannot be observed 500 ms later — sample state in the same
turn as the click. **Order by a real column**: with books inserted in
finishing order, a fixture query that orders by a column full of zeroes falls back
to insert order and looks broken when the app is right.

## 12. Rebuilding, in order

1. `package.json` (ESM, the three dependencies, `start`), `Dockerfile`,
   `.dockerignore`, `docker-compose.yml`, the Unraid template.
2. `db.js` — schema, migrations, settings, `getLibraries`.
3. `admin.js`, then `index.js` with the routes of §6 as stubs; get the static
   pages served and `/api/admin` answering.
4. `pool.js`, then `scan.js` — this is the heart of it, and §7.1 and §9 are what
   make it right. Make `scan-scope`, `sibling-series` and `rescan-series` pass.
5. `placeholder.js` and the cover route; make `cover-fallback` pass.
6. The read-only interface: three columns, genres with series and folding, cards,
   the player, the landing shelves, the listening page, search.
7. `google.js` + `tagpool.js` + `tag-worker.js`, then `tagall.js`; make
   `one-writer` and `tagall-test` pass.
8. `import.js` with the comparison, the two prefixes and the rollback; make
   `replace-rollback` pass.
9. `trash.js`, `validate.js`, `covers.js` and their maintenance lists; make
   `validate-test` and `covers-test` pass.
10. `work()`, the per-job bars and the greying; make `greyed-button` pass.
11. README (which is also the Docker Hub page), the wiki, the workflow. Bump,
    commit, tag, push, and check both builds.

## 13. Where this version stands

| Version | What it added |
| --- | --- |
| 1.8.40 | greying the button that started a job, wherever it was pressed |
| 1.8.48 | lanes for disk reads, worker threads for tag writes; the folder shown in the edit dialog |
| 1.8.56 | a cover drawn for books with no art |
| 1.8.64 | the folder and file count moved to the foot of the edit dialog |
| 1.8.72 | the search box on both pages |
| 1.9.0 | README brought up to date, with a screenshot of the drawn covers |
| 1.9.8 | a browser is only offered the names it has used itself |

Earlier in the 1.8 line: series from three sources, collapsible genres, one
progress bar per job, the resumable whole-collection tag write, the disk check and
**Broken on disk**, the import quality comparison with **Replaced** and
`Not Imported - `, the cover tidy-up, the scan-scope pulldown, the two-author
choice, and moving both secrets onto the container.
