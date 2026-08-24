# My Audiobook Collection

A small, self-hosted web app to browse and play an audiobook collection that is
organised on disk as **Genre → Author → Book** or **Genre → Author → Series → Book**.

* Three-column interface: genres on the left, authors next to it, books with full metadata on the right
* Opens on shelves of covers: what you were listening to, with how far you are, and what was added last
* Scans one or more library folders on the server (with a built-in folder browser)
* Reads ID3 / audio metadata from the files (title, narrator, year, description, embedded cover art)
* Shows per book which tags the **files themselves** carry, so database-only metadata is visible as such
* Fills in missing metadata via the **Google Books API**, or by hand, and writes it back into the MP3s
* A *Needs tags* list of every book whose files miss a required tag, with writing and lookup on the spot
* Files new audiobooks from an **import folder** into the right genre, author and series
* Moves a book to another genre, author or series, and deletes one to a trash it keeps for 30 days
* Streams books in the browser, remembers the playback position **per user**, and marks books listened
* Runs as a single Docker container, ~700 lines of code, SQLite storage, no external services

## Folder layout it expects

```
/audiobooks
├── Fantasy
│   ├── Brandon Sanderson
│   │   └── Mistborn                  <- series folder
│   │       ├── The Final Empire
│   │       │   ├── 01-chapter.mp3
│   │       │   └── 02-chapter.mp3
│   │       └── The Well of Ascension
│   └── Patrick Rothfuss
│       └── The Name of the Wind      <- book directly under the author
└── Thriller
    └── Stephen King
        └── The Shining
```

How a third-level folder is read:

| It contains | Read as |
| --- | --- |
| audio files | a **book** |
| several sub-folders | a **series**, each sub-folder a book |
| sub-folders that are all `Disc 01`, `CD 2`, `Part 3`… | **one book**, its discs played in order as one track list |
| exactly one sub-folder | **one book**; a series of one has nothing to group |

If a library folder holds things you do not want scanned, add the genre folders
themselves and tick *Is a Genre* behind each, instead of adding their parent.
A scan warns when a folder looks like a genre but is not marked as one, since its
authors would otherwise be filed as genres.

Supported files: `.mp3 .m4a .m4b .ogg .flac .opus` (tag writing is MP3-only).

## Run it on Unraid

1. Docker → **Add Container** → fill in:
   * Repository: `starf0x/my-audiobook-collection:latest`
   * Port: `8080` → `8080`
   * Path: `/data` → `/mnt/user/appdata/my-audiobook-collection` (database + covers)
   * Path: `/audiobooks` → `/mnt/user/Audiobooks` (read/write if you want to write tags)
2. Open `http://TOWER-IP:8080`
3. **+ User** → add yourself (playback positions are stored per user)
4. **Settings** → add `/audiobooks` as a library folder (use *Browse…* to pick it),
   paste your Google Books API key, **Save**. If `/audiobooks` also holds folders you do not
   want scanned, add the genre folders one by one instead and tick *Is a Genre* behind each.
5. **Scan library**

`unraid-template.xml` in this repo can also be dropped into
`/boot/config/plugins/dockerMan/templates-user/` to get the same form pre-filled.

### Or with docker compose

```bash
docker compose up -d
```

## Importing new audiobooks

Set an **Import folder** in Settings, drop new audiobooks in it, then open
**Import** in the left column. Every book folder in there is listed, however deep
it sits: a folder holding audio is a book, and so is one whose sub-folders are all
discs. The author and series are guessed from the folders around it and from the
tags. Pick one, choose the genre, and correct the author, optional
series and title; the line underneath shows exactly where it will land. *Move*
files the folder into `<genre>/<author>/[series]/<title>` and rescans, so the book
appears in the library straight away.

The folder is moved, not copied, so the import folder empties as you work through
it. If the import folder sits on a different mount than the library, the files are
copied across and the source removed, with the bar showing the file count. Names
are stripped of characters a path cannot hold.

## Moving and deleting

The **Series** field in *Edit metadata* moves the book too, since a series is a
folder: filling it in files the book under `genre / author / series / book`, and
emptying it moves the book back up. The folder keeps its own name.

*Move…* on a book card shifts its folder to where a new genre, author, series and
title say it belongs. The book keeps its row, so the listened state and playback
position travel with it.

*Delete…* moves the folder into a `.trash` folder inside the same library folder,
which keeps it on the same filesystem and out of the scanner's way, and records
the deletion. **Trash** in the left column lists what is in there, how long it has
left, and offers *Put back*, *Delete now* per book and *Empty trash*. Anything
older than 30 days is dropped by itself, checked at startup and once a day after.

## Google Books API key

Google Cloud Console → *APIs & Services* → enable **Books API** → *Credentials* →
*Create credentials* → *API key*. Paste it in **Settings**. Then use
**Find metadata** on a book and pick a result, or type your own search when the
folder name finds nothing. A 503 from Google is retried after 10, 20 and 30
seconds, with the wait shown in the dialog.

## What a tag write puts in the MP3s

*Write into MP3s* on a book, *Save + write into MP3s* in the edit dialog and
*Write tags into all MP3s* in Settings all write the same thing into every MP3 of
the book:

| Frame | From |
| --- | --- |
| `TALB` album | the book title |
| `TPE1` artist and `TPE2` album artist | the author |
| `TCON` genre | the genre folder |
| `TYER` year, `COMM` description, `APIC` cover | the book's metadata |
| `TCOM` composer | the narrator |
| `TRCK` track number | renumbered in playing order, zero padded: `01/12`, `001/120` |

Values the app does not have are left out rather than written empty, so a book
with no description keeps no empty comment frame. The badge on each card lists
what the files actually carry.

## Development

```bash
npm install
DATA_DIR=./data PORT=8080 npm start
```

## Publishing

Pushes to `main` build and push a multi-arch image to Docker Hub through
`.github/workflows/docker.yml`. Add these GitHub repository secrets:

| Secret | Value |
| --- | --- |
| `DOCKERHUB_USERNAME` | your Docker Hub username |
| `DOCKERHUB_TOKEN` | a Docker Hub access token |

## Layout

```
server/index.js   HTTP API (express)
server/db.js      SQLite schema + settings
server/scan.js    library scanner + tag reader
server/google.js  Google Books lookup + ID3 writer
server/import.js  import folder: candidates and moving a book into place
server/trash.js   move a book, delete to trash, put back, empty
public/           UI (index.html, style.css, app.js)
```
