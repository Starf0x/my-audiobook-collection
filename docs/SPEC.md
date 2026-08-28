# My Audiobook Collection — build specification

**Version described: 1.10.72.** This document describes what the app is, how every
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
plus `https://github.com/Starf0x/my-audiobook-collection` at tag `v1.10.72` is an
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

Two pages, served without file names in the address: **`/`** is the listening
page — it browses, plays and remembers positions, and is the one to share — and
**`/admin`** is the page that changes the collection (scan, import, tag, move,
delete). `/listen.html` and `/index.html` still answer, with a redirect, so old
links keep working.

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
| `server/index.js` | 512 | Express app: every route, and nothing else |
| `server/user.js` | 85 | who the process writes as: `PUID`, `PGID`, `UMASK` |
| `server/db.js` | 112 | schema, migrations, settings, library list |
| `server/admin.js` | 47 | the one password, sessions, `requireAdmin` |
| `server/scan.js` | 456 | walking the library, reading tags, filing books |
| `server/pool.js` | 42 | the lane cap and the item pool for disk work |
| `server/google.js` | 539 | Google Books lookup, and writing tags into files |
| `server/tagpool.js` | 51 | worker-thread pool for tag writes |
| `server/tag-worker.js` | 13 | the worker: one `NodeID3.update` per message |
| `server/tagall.js` | 120 | the resumable whole-collection tag run |
| `server/import.js` | 427 | import candidates, quality comparison, filing |
| `server/trash.js` | 180 | move, delete to trash, restore, purge |
| `server/validate.js` | 116 | checking every book against the disk |
| `server/covers.js` | 118 | tidying unused cover files, zipping them |
| `server/placeholder.js` | 94 | the cover drawn for a book that has none |
| `public/index.html` | 222 | the admin page: columns, dialogs |
| `public/app.js` | 1622 | the admin page's behaviour |
| `public/listen.html` | 59 | the listening page |
| `public/listen.js` | 395 | the listening page's behaviour |
| `public/style.css` | 417 | the whole look, both pages, phone included |

Static files are served from `public/` by `express.static`, with
`{ index: false }` so the routes below decide what `/` is:
`GET /` sends `listen.html`, `GET /admin` sends `index.html`, and
`/listen.html` and `/index.html` redirect to those — the file names are gone from
the address, and old links still work. `app.use(express.json({ limit: '1mb' }))`.

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
| `PUID` / `PGID` | unset | the user and group to write as. `server/user.js`, imported before anything else, chowns `DATA_DIR` and then drops to them — without this the container writes as root and the folders it creates on a share cannot be written to by their owner |
| `UMASK` | unset | mode mask for what it creates (`000` on an Unraid share) |

With neither `PUID` nor `PGID` set, and running as root, `user.js` takes the owner
of `DATA_DIR` (or of the folder above it) and becomes that — on Unraid, appdata
belongs to nobody:users, so a container that was never told anything still writes
as the user that owns the shares. `GET /api/permissions` (admin) reports
`writingAs()` and, for the data folder, every library, the import folder and one
book folder: whether it is there, its owner and mode, and whether a file can
actually be written in it and removed again — measured, not inferred from the mode.
Settings shows it as a table.
| `PORT` | `8523` | HTTP port |
| `ADMIN_PASSWORD` | empty | set → the admin page must be unlocked; empty → private install, everyone may do anything |
| `GOOGLE_API_KEY` | empty | Google Books lookups |
| `GOOGLE_COUNTRY` | `US` | which country's Google catalogue answers. Series data belongs to a country's Play catalogue, and left to the server's own address Google can answer with a record that has none |

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
| `GET /api/scan/status` | — | `{running, done, total, current, books, error, warning, skipped}` |
| `GET /api/skipped` | admin | what the last scan walked past, and why |
| `GET /api/permissions` | admin | who the app writes as, and what each folder allows |
| `GET /api/stats` | — | `{books, files, done, todo}` |
| `GET /api/untagged` | admin | the Needs-tags list, split `fixable` / `needsLookup` |
| `GET /api/home` | — | `{continue, recent}` |
| `GET /api/genres` | — | `[{name, books, series: [{name, books}]}]` |
| `GET /api/authors?genre=` | — | `[{name, books}]` |
| `GET /api/books?genre=&author=|series=&user=` | — | cards |
| `GET /api/search?q=&user=` | — | cards, across everything |
| `POST /api/listened` | — | `done: true` marks a book listened; `done: false` deletes the progress row, place and all |
| `GET /api/books/:id?user=` | — | one book, with `tracks`, `progress`, `folderSeries`, `coverV` |
| `GET /api/cover/:id?v=` | — | the picture, or a drawn one |
| `GET /api/stream/:trackId` | — | audio, with byte-range support |
| `POST /api/progress` | — | position, per user |
| `GET /api/lookup/status` | — | retry state of a lookup |
| `GET /api/lookup`, `GET /api/lookup/:id` | admin | Google Books results |
| `GET /api/lookup/series-report?limit=` | admin | per book: what Google answered about its series, which of the three places it came from, and what it cost |
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

**The unchanged fast path.** A book whose file paths are unchanged is not re-read
in full; one parse of its first file (`firstFileTells` → `firstFileMeta`) refreshes
genre, author, series, `tagged`, `tag_series`, `series_no` **and the values the
same parse carries** — narrator, year, description and the cover art. That is where
a full read gets them from too: only the running time and the track list need every
file, so `readMeta` and the fast path share `firstFileMeta` and differ in nothing
else.

Two rules make that safe. Where the file says nothing, what the app has is kept
(`told.year || existing.year`), so a description typed into *Edit metadata* is not
blanked by a scan. Where the file says something, the file wins — the same rule a
full read follows. The **title** is never touched here, because the folder name
wins over the album tag and the folder has not changed.

Three things depend on it:

* it must still write `tag_series`/`series_no`, or a series inferred from tags
  never appears for a library that was scanned by an older version;
* `addBook(..., force)` bypasses it. A replacing import lands on the very same
  file names, and without `force` the old copy's duration, cover and description
  would be kept;
* it must adopt the **values**, not only the list of field names, or tags written
  by another program leave the app knowing that a year exists and not what it is.

Progress is a module-level object; `running` is set **before** walking the tree,
because the walk of a large share takes tens of seconds and the interface would
otherwise read the scan as finished. `scan()` catches everything: the caller does
not await it, so an unhandled rejection would take the process down.

Books whose folders are gone are dropped at the end of a scan — but only within
the scope that was scanned.

**What it walked past.** One `listing()` per folder — one `readdir` giving the
sub-folders, the ones set aside by an import, the audio, and the other file
extensions — replaces the `dirs()` + `audioFiles()` pair the walk used to make of
every folder, so the walk is cheaper *and* can say why a folder yielded no book.
Every such folder goes into `skippedLast` with a reason: `deeper` (audio below the
layout, naming the folder it is in), `unsupported` (listing the extensions),
`empty`, `loose` (audio in a genre or author folder), `aside`, `unreadable`.
`progress.skipped` counts them, `GET /api/skipped` hands the list over, and the
page shows it as **Not counted** — a row hidden when there is nothing in it. It is
the last scan's report, in memory: empty until a scan runs, and after a restart.

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

**The series, and how Google keeps it.** Three facts shape all of this:

* a volume carries `volumeInfo.seriesInfo`, and it holds **no series name** — only
  `volumeSeries[].seriesId`, `orderNumber` (the real sequence),
  `bookDisplayNumber` (for display; it can read `2.5`) and
  `shortSeriesBookTitle`, documented as *the book's* title in the context of the
  series, and so as often the book's own name as the series';
* the name lives behind `GET series/get?series_id=`, which answers
  `{ series: [{ seriesId, title, seriesType, isComplete, … }] }`;
* `seriesInfo` belongs to the volume, not to a search result, so a
  `volumes?q=` answer usually leaves it out entirely.

A fourth: Google keeps series data **per record, not per book**. One search answers
with several editions of a novel, and one of them can be in a series while the rest
are in nothing. Which is why `books(tail, key)` builds every URL with
`country=<GOOGLE_COUNTRY>` on it — the catalogue that answers decides what a
record contains.

So `seriesFor(item, key, trace)` asks in this order and stops at the first answer:
the **text** of the result (`seriesOf`, free); `GET volumes/<id>` for the
`seriesInfo`; `GET series/get` for the name, cached by `seriesId` in a
module-level `Map` for the life of the process — a shelf of one series pays for
its name once. Where the text already named a series, nothing is asked at all,
though a `seriesInfo` that came *with* the search fills in a number the words left
out. Where Google will not name a series, `shortSeriesBookTitle` is the last
resort, with its trailing volume number split off. A name equal to the book's own
title is refused.

`ask()` wraps both extra requests: an 8-second `AbortSignal.timeout`, and it
returns the **status** alongside the body, because "Google refused this" and
"Google answered, and had nothing" are different answers and the difference is the
whole diagnosis. A series that cannot be read is a tick the dialog does not offer —
never a lookup that fails.

**And it says why.** Every result carries a `why` when it offers no series, from
`whyNone(trace)`: the volume request failed or timed out; it answered 403 (with
"the key may not read it"); Google's series line is the book's own title, quoted;
Google files it in series `<id>` but would not name that series; Google keeps no
series data for this edition, *and another result in the list may be an edition
that has it*; or nothing anywhere names one. The dialog prints it as
`No series: <why>` where the tick would be, and the report prints it under the
empty cell. Without this the dialog is silent about a book it found nothing for,
and diagnosing that from outside is impossible: the answers come from a key on the
owner's server.

For the text, a chunk becomes a series only if it matches one of four shapes —
`Name, #N` / `Name, Book N` / `Name N` / `Name V` (the announcing word is optional,
the number is not), `Book N of Name`, `A Name Novel`, `The Name Series` — and only
if what is left is not a bare number and does not itself start with
`book`/`vol`/`part`/`no`, which is what keeps `(Unabridged)`, `(Penguin Classics)`,
`(1949)` and `(Book 1 of 3)` from becoming series. Numbers may be digits, words
(`one`–`ten`) or roman numerals; a number from Google is taken only when whole,
since `series_no` is an integer and a novella printed as `2.5` filed as 2 would sit
on top of book 2. Only `Series` is stripped as a describing word:
`Saga` and `Cycle` are parts of names (*The Twilight Saga*). Google's line is
**already a name**, so only a trailing volume number is split off it and none of
the other shapes are tried — they would read *A Long Saga* as a saga called
*A Long*. A series whose name equals the book's own title is not a series.
A series taken from the brackets comes **off the title**, so the album tag does not
carry it.

**Between the results, and then the ebooks.** After every result is resolved,
`search_` lends a series between them: a result with none takes the series of
another result that **is the same book** (`sameBook`, comparing titles reduced to
letters and digits, so a different book that merely matched the words lends
nothing), and carries `fromEdition` so the dialog can say where it came from.
Where the *first* result still has none, `ebookSeries(q, expect, key)` asks the
catalogue where series data actually lives: one `volumes?q=…&filter=ebooks`
search, whose results usually carry `seriesInfo` in the answer itself, with the
volume of a matching result asked only if none does. Title-matched the same way.
Failing *that*, `moreRecords(q, expect, key)` widens the same query from five
records to **forty** (`maxResults=40&projection=full`): Google holds dozens of
records per book, and one entered as *A Kiss of Shadows (Merry Gentry Book 1)*
names the series in its title where the matched record does not. Only records that
are the same book count — a sibling in the series must not lend its own volume
number, and another book by the author must not lend anything — and only the text
and any `seriesInfo` that arrived with the answer are read, so it stays one
request. Each lending sets `fromEdition` to `edition`, `ebook` or `record`,
which the page turns into a sentence. Failing everything, each reason line gains
*"Neither have its ebook editions, nor any of the other records Google keeps of it
— type the series into Edit metadata and it stays."*

**The limit, stated.** The series panel on books.google.com comes from Google's
internal Play catalogue. The Books API is a different surface: no parameter makes
an answer contain a field Google did not put in it, and for many records
`seriesInfo` is simply absent. Everything above widens the search for a record
that *does* carry it; where none does, the honest answer is the reason line and
*Edit metadata*. **Do not add a second service to fill the gap** — that was tried
and rejected: this app talks to Google Books and to nothing else.

**Seeing what Google actually answered.** The key is on the owner's container, so
the only place this question can be asked is their server. `lookup(book, search,
trace)` takes an optional object which `seriesFor` fills in for the first result:
`googleTitle`, `subtitle`, `inSearch`, `seriesId`, `orderNumber`,
`bookDisplayNumber`, `shortSeriesBookTitle`, `bookType`, `asked` (which of the two
extra requests were made), `from` (`title` | `subtitle` | `series name` |
`short title` | `the book itself` | `nothing` | `no result`) and the `series` /
`seriesNo` decided on. `probeSeries(books)` runs that over a list, one book at a
time, and `GET /api/lookup/series-report?limit=<1..40>` hands the table to
Settings, taking the books with no series first. It is a diagnostic that spends
quota, so it is a button with a count on it and never something a page does by
itself.

It is offered as a tick (`#cs<i>`, on by default) and, when accepted, is stored as
the **tag** kind of series: `tag_series` and `series_no`. It never moves the book —
that is *Edit metadata*, which is folders. Two rules follow:

* the tag write puts it in `TIT1` as `<series> <no>` (`Mistborn 2`), one of the
  places `seriesFromTags`/`splitVolume` read a series from, so the next scan
  agrees rather than dropping it. `node-id3` has no `MVNM`/`MVIN`, hence `TIT1`.
* `series_no` is one column shared by both kinds, so it is only written when the
  series being applied is the one the book is shown under (no folder series, or a
  folder series of the same name). Otherwise a number from another series would
  reorder the book inside its own folder's series.

An unticked series sends `series: ''`, and the server then keeps whatever the book
had rather than blanking it.

What a tag write puts in every MP3 of a book:

| Frame | From |
| --- | --- |
| `TALB` album, `TIT2` title | the book title — every file carries the book title, not "018 of 132" |
| `TPE1` artist, `TPE2` album artist | the author |
| `TCON` genre | the genre folder |
| `TYER` year, `COMM` description, `APIC` cover | the book's metadata — the cover being either the file this app keeps or the picture beside the audio, since the Needs-tags list counts what the files carry |
| `TCOM` composer | the narrator |
| `TRCK` track number | renumbered in playing order, zero padded to at least two digits: `01/12`, `001/120` |

Empty values are **deleted from the tag object** before writing, because an empty
frame reads back as "present".

`NodeID3.update` is synchronous and rewrites the whole file. It runs on a small
worker pool (`tagpool.js`, `min(4, availableParallelism - 1)` threads, lazily
created, `unref`'d, a dead worker is replaced and its file reported as not
written). `apply_` hands every file of the book to that pool at once and counts
as each finishes.

**One writer per book**, in the page as well as on the server. In the page,
`writingBooks` — a `Set` of book ids — guards `writeWithProgress`, which every
way in goes through: the card, the Needs tags row, the batch over that list, the
edit dialog and the lookup dialog. A second attempt on a book already being written
is answered with a toast and no second bar. The server holds the same rule for
requests that never went through the page: `writers`, a `Map` of book id to
that write's progress. Two books — two series — can be written at the same time,
since each write only ever touches its own book's files. The same book twice is
refused with *"That book is already being written. Wait for it to finish."*, and
`GET /api/apply/status?book=<id>` hands back that book's own count, because two
writers sharing one counter is what produced a bar reading `193 / 157`.

`POST /api/tagall` refuses to start while `anyWriting()`: the run would reach
the book being written and count it as failed. The reverse guard already existed —
a single write is refused while the run is going.

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

The list is kept — a large import folder is not worth walking on every page load
— but a folder that has **gone** is dropped from it as soon as the list is asked
for again (one `existsSync` per book, not a walk), because the page would
otherwise offer a book that cannot be imported: emptying the import folder left
every one of them on screen. `GET /api/import/state`, which the open panel polls,
also asks for a look at the folder, rate-limited to one walk every five seconds, so
an emptied or refilled folder is noticed while the panel is open. The page compares
the `cachedAt` of the list it is showing with the server's, rather than counting
changes: the count had already gone up before the watch took its first look, which
is precisely how an emptied folder stayed on screen.

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

The folder is **moved**, not copied — and `moveFolder` is where the sharp edges
are. It refuses to move onto a destination that holds anything (an empty one is
removed first, since a rename onto one is refused on some platforms). A rename that
fails with `EXDEV`, `ENOTEMPTY` or `EEXIST` falls back to `copyTree` (in lanes,
async, reporting through `fileProgress`): those are what two Docker mounts, or a
user share spread over several disks, answer. `EPERM` and `EBUSY` deliberately do
**not** — they mean something holds the folder or the rights are wrong, and copying
then would leave the book in two places instead of saying so. After a copy, every
file of the source must exist at the destination **with the same size** before the
source is removed; otherwise nothing is removed and it says how far it got. If the
removal itself fails, the move stands with a line saying the original is still in
the import folder: undoing a good move over that would be worse.
`explainFileError` turns `EACCES`/`EPERM`, `ENOSPC`, `EROFS` and `ENOTEMPTY` into
sentences that say what to do, naming the user the app writes as.
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

**One job at a time.** `work(button, what, fn, alone = true)` refuses a second job
with a toast, adds `body.working` (which greys every button that would start work,
to opacity 0.45 and `pointer-events: none`, including `[data-pick]` candidates),
disables the button that was pressed, and restores both in a `finally`. Every job
button goes through it: scan, import, tag writes (card, needs-tags row and edit
dialog), disk check, cover tidy, trash actions.

Tag writes pass `alone: false`. They add `body.writing` instead, which greys
everything a running write must hold back — a scan, an import, the disk check, the
whole-collection run, *Find metadata*, *Edit metadata* — while leaving the other
books' *Write into MP3s* buttons alive
(`body.writing … button[onclick^="writeTags"]:not(:disabled)`). Each write's bar is
named after its book, both while it runs and in what it says when it is done, or
two bars side by side read as the same message twice.

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
the series it read out of the title or subtitle as a tick beside its name and
volume number, and category-as-genre buttons); *Edit metadata* (title, author, series, narrator,
year, description — with the book's folder and file count at the foot, above the
buttons); *Move…*.

**On a phone** (`@media (max-width: 720px)`): the three columns become one, and
`document.body.dataset.col` — `genres` / `authors` / `books` — says which is on
screen; the stylesheet hides the other two, and a wide screen ignores the
attribute entirely. `show(col)` sets it, called where the interface already knew
it had moved: `selectGenre` → authors, `drawBooks` and `loadHome` → books, and a
click on any maintenance row → books. Each column heading carries the step
out — `#backGenres` ("‹ Genres"), `#backCol` (named after where it goes, authors
or genres, by `outOfBooks()`) — and the genre column has `#toBooks` ("Books ›")
forward. The page ships with `data-col="books"`, so it opens on the shelves before
any script runs.

The rest of the phone layout is CSS only: the header wraps to two rows with the
search across the width (explicit `order` on each control), a card becomes
`84px 1fr` with its actions a two-up grid beneath, `.fix` rows go one column,
dialogs become full-screen scrolling sheets, the player puts cover, title and
track on one line with the audio control full width below, rows and buttons are at
least 40px, and `#progress` bars stack. Two details that are not cosmetic:
**fields are set at 16px**, because a phone zooms the whole page when you focus a
smaller one, and `height: 100dvh` on the body, because `100vh` puts the player
behind the browser's own chrome. Between 721px and 1000px the three columns
stay, narrower. `@media (hover: none)` drops the hover states, or a tapped button
stays lit.

The tag badge carries both forms — `.wide` with the list, `.narrow` with the
count — and the media query picks one, since the full list is a paragraph on a
phone.

**The name of the app** in the header (`#brand`) calls `loadHome()`, so it is the
way back to the shelves from a book list, a search or a maintenance list. Both it
and the *Home* link clear the search box, since the shelves are not a search
result either.

**Unticking Listened** clears the place kept in the book: the tick means "I have
listened to this", so `POST /api/listened {done: false}` deletes the progress row
rather than setting `done = 0`. The card follows — the note goes back to *new* and
the play button to *▶ Play* — and the book leaves *Continue listening*. A place
lost this way is not recoverable, which is the price of the tick meaning what it
says.

**The version** the server is running is read from `package.json` at startup and
returned by `/api/stats`, and both pages show it at the right-hand end of the
status line. Without it there is no way to tell from the outside whether a
container has actually been updated, which is exactly the question a bug report
starts with.

**Playing** is a toggle on the button of whatever offered it — a card in the
library, or a tile on the **Continue listening** shelf, where each book carries a
`button.tplay[data-play]` under its progress line. A tile's button stops the click
from reaching the tile behind it, or one tap would play and pause in the same
breath.

The toggle itself: `playBook(id)` pauses or resumes
when `state.book.id === id` and starts the book otherwise, so the button that
started it is the one that stops it. `markPlaying()` writes the label and a `.playing` ring on every card button and
every tile button. The label is *⏸ Pause* for the book that is playing, *▶ Resume*
for the book that is loaded but paused **and** for any button marked
`data-resume="1"` — a shelf tile always, a card when the book has
`started` or `done` — and *▶ Play* only for a book with no place kept in it. That
distinction is what makes a reload keep saying *Resume*: nothing is loaded in the
player then, but the shelf still means "carry on with this". A button that has been
the playing one is marked `data-resume` too, so it stays a *Resume* when another
book takes over. It runs from the `play`, `pause` and `ended` events and at the
end of `drawBooks` and `loadHome`, so a redraw does not forget which book is
playing. The `onclick` attribute stays `playBook(...)`, because the stylesheet and
the tests find the play button by it.

**Staying put.** `backToView()` draws the view that is on screen again — the open
maintenance list if there is one, else the series, the author, or the shelves — and
both `refreshLibrary()` and the tail of `applyMeta` use it. Without it, applying
metadata to a book from *Needs tags* threw the page into the library, or onto the
shelves when a genre came with the metadata.

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
21. **A scan changes the maintenance counts**, so the page must reload them when
    one finishes — and redraw the list if it is the one on screen. Without that
    *Needs tags* keeps its old number until the page is reloaded, and it looks as
    though the scan did nothing.
22. **A container that writes as root makes folders its owner cannot use.** Honour
    `PUID`/`PGID`/`UMASK` and drop to that user before creating anything, or an
    import lands somewhere the person who owns the share is refused permission to
    write in.
23. **Never remove the source of a copy before checking that every file arrived**,
    with its size. A move that half happened and then deleted the original cannot
    be undone.
24. **Cover art beside the audio is cover art.** A book's cover is either a file
    the app keeps or a `file:` path to a picture in the book's folder; a tag write
    that only handles the first kind leaves a book asking for a cover it already
    has, for ever, while the list promises a write can fix it.
25. **The queue and the count of a resumable run must move together**, in one
    transaction: a container stopped between them drops a book off the queue that
    the count never counted.
26. **A form field on a phone must be 16px or larger**, or the browser zooms the
    whole page when it is focused and the layout jumps.
27. **Never hand a browser the whole list of listeners.** `GET /api/users`
    answers with the names *that browser* has claimed; a first-time visitor gets
    an empty list, and the dialog then shows only a field to type one in.
28. **Tooling note for whoever rebuilds this**: writing JavaScript through a
    shell mangles template literals, `${…}` and `\d`. Use a file-writing tool for
    anything containing them, and grep the result afterwards.
29. **A series a lookup found has to reach the files.** A scan trusts the
    files, so a series stored only in the database is dropped by the next one
    unless the fast path keeps what it has and the tag write puts it in `TIT1`.
    Both, in this app: the write for the books whose tags are written, the fast
    path for the ones whose are not. And one `series_no` column serves both kinds
    of series, so only the series the book is *shown* under may set it.
30. **Google's `seriesInfo` carries no series name**, and is attached to the
    volume rather than to a search result. Read the name from `series/get` by
    `seriesId` and cache it; never trust `shortSeriesBookTitle` as the name, which
    is documented as the book's title within the series and is sometimes the book's
    own. A diagnostic that spends the owner's API quota is a button they press,
    never something a page does on its own.


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
| `series-lookup` | the series read out of what Google answers: brackets, subtitles and Google's own series line in every shape, numbers as digits, words and roman numerals, and silence for `(Unabridged)`, an imprint, a year, a volume count, a series named after the book |
| `series-two-step` | how Google keeps series, and what it says when there is none: a series lent from the edition that has it to the ones that do not, the ebook catalogue and then all forty records asked when none has it, a sibling volume's number never borrowed, another book's series never borrowed, `country=` on every request; every branch of `whyNone` — no series data, 403, a self-named line, an unnamed id, a timeout — and silence where a series was found. Plus: the name behind `series/get`, cached across books; `orderNumber` over `bookDisplayNumber`; a half number as no number; the fallbacks when Google will not name one; a result whose text said it is not asked about; and a refused, broken or self-named answer costing the series and not the lookup. Plus what the report says per book |
| `series-apply` | applying it names the series without moving the book, shows it under its genre, goes into the grouping frame with its number, survives the next scan either way, and never takes a number that belongs to a folder series |
| `series-ui` | the dialog offers it ticked, sends nothing when unticked, applies it when ticked, and shows no line when there is none |
| `rescan-series` | a library scanned by an older version picks up its series on a rescan, without folders changing |
| `one-writer` | two different books at once are both written; the same book twice is refused with a reason; counts never run past their own totals |
| `two-writes` | a long write and a short one from another series side by side, each reporting its own total under its own book; the same book refused; the whole-collection run refused while they run, and starting once they are done |
| `phone-ui` | at 390×844 with touch: one column at a time, the steps through and back with their named buttons, nothing wider than the screen, a 16px field, thumb-sized rows, the short tag badge, a dialog filling the screen — and all three columns back on a wide screen with the stepping buttons hidden |
| `permissions` | the report names who the app writes as and what it was asked for, covers the data folder, every library, the import folder and a book folder, says whether each can be written in, names one that is not there rather than calling it unwritable, and leaves no probe file behind |
| `moves` | a plain move; a move onto a folder that holds something refused with nothing touched; a move into an empty folder; a copy that cannot finish leaving every file of the original where it was; and every file error a share throws put into words |
| `as-user` | the app starts with and without `PUID`/`PGID`/`UMASK`, says which user it became or why it could not, and treats nonsense in those variables as nothing at all |
| `import-empty` | the kept list drops a book whose folder has gone, empties when the folder is emptied, picks up a new one from the background pass, ignores a folder left behind with no audio, and reads from scratch on a refresh |
| `import-empty-ui` | with the panel open and the folder emptied behind its back, the list empties itself within seconds, says the folder is empty, the count follows, and a book dropped in appears — nothing pressed |
| `skipped` | every way a folder full of audiobooks can be walked past — a book one level too deep, files it cannot read, an empty folder, audio loose in a genre or author folder, a copy set aside — each named with its reason; counted plus not counted is what is on the disk; moving a too-deep book up one level raises the count |
| `skipped-ui` | the **Not counted** row: absent when empty, there with a count after a scan, the bar saying so, and the list grouped by reason with a path for each |
| `stay-put` | applying metadata from Needs tags leaves that list on screen — with a genre change too, and from the edit dialog — while from the library it still returns to the author |
| `same-book` | while a long write runs, every further request for that book is refused with the same reason — singly, three at once, with a different `pick`, and from the whole-collection run; another book writes meanwhile; metadata without a file write is still allowed; the book is free again afterwards |
| `same-book-ui` | in the page: the pressed button dead, that book's metadata buttons held back, one bar only, a second call answered in words, a request that skips the page refused by the server, the batch counting it as one it could not do, and everything free again afterwards |
| `folder-cover` | a book whose art is a `cover.jpg` beside the audio: a write puts that picture into the files, so the book leaves Needs tags and a rescan reads it back; art dropped in later is found by a scan |
| `needs-tags` | what the list counts and what a write can fix; tags written by another program are picked up by a rescan, values and all; a scan does not blank what the app knows when the files are silent, and the file wins when it is not |
| `scan-counts` | tags written outside the app, then **Scan library** pressed in the page: the count in the left column follows without a reload, and the list redraws if it is on screen |
| `clean-urls` | `/` is the listening page and `/admin` the other; the old file names redirect to them; every asset, the api and a 404 are unaffected |
| `unlisten` | ticking Listened keeps the place, unticking deletes it; the book drops off Continue listening, starts from the beginning next time, and the counts follow; unticking one that was never ticked is harmless |
| `brand-home` | the name of the app leads back to the shelves from a book list, a search and a maintenance list, on both pages and on a phone, and clears the search box |
| `tile-play` | on both pages and at phone width: every Continue listening tile has a button under its progress reading *Resume* — after a page reload as well — and the Recently added tiles none; it starts the book and becomes its Pause; pressing again Resumes; the other tile takes the pause with it; the tile behind the button does not answer the same tap; the cover still plays |
| `play-pause` | the card that is playing offers Pause, pressing it again Resume, and once more carries on; starting another book moves the pause to it; a redraw of the list remembers which book is playing |
| `two-writes-ui` | pressing one book's *Write into MP3s* greys that button and the file-moving ones, leaves the other books' write buttons alive, and gives each write its own named bar |
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
| 1.9.16 | two books, or two series, can have their tags written at the same time |
| 1.9.24 | a layout for phones, and Play becomes Pause on the card it started |
| 1.9.32 | a play button on every Continue listening tile |
| 1.9.40 | a book with a place kept in it says Resume, not Play |
| 1.9.48 | addresses without file names, the app's name leads home, unticking Listened clears the place |
| 1.9.56 | a scan takes the values from tags written elsewhere, and the counts follow it |
| 1.9.64 | cover art beside the audio is written into the files; the version is on screen |
| 1.9.72 | one write per book in the page too, whichever way it is asked for |
| 1.10.0 | a scan reports the folders it walked past, and a maintenance list stays put |
| 1.10.8 | an emptied import folder empties the list that offers its books |
| 1.10.16 | the app writes as the user that owns the share, and a move never half-happens |
| 1.10.24 | with nothing set it follows the data folder's owner, and Settings reports what every folder allows |
| 1.10.32 | a lookup finds the series too, read out of the title and subtitle Google answers with |
| 1.10.40 | and out of Google's own series line, asked for per result, for the books whose title says nothing |
| 1.10.48 | series read the way Google actually keeps them — id, order, and the name behind `series/get` — with a report in Settings on what it answered |
| 1.10.56 | and when there is no series, the dialog says why: what was asked, what Google answered, and whether another result may carry it |
| 1.10.64 | a country on every request, a series lent between editions of one book, and the ebook catalogue asked when no edition has one |
| 1.10.72 | forty records read instead of five, so a series named in the title of any record of the book is found |

Earlier in the 1.8 line: series from three sources, collapsible genres, one
progress bar per job, the resumable whole-collection tag write, the disk check and
**Broken on disk**, the import quality comparison with **Replaced** and
`Not Imported - `, the cover tidy-up, the scan-scope pulldown, the two-author
choice, and moving both secrets onto the container.
