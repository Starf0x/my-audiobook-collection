# My Audiobook Collection

A small, self-hosted web app to browse and play an audiobook collection that is
organised on disk as **Genre → Author → Book** or **Genre → Author → Series → Book**.

* Three-column interface: genres on the left, authors next to it, books with full metadata on the right
* Scans one or more library folders on the server (with a built-in folder browser)
* Reads ID3 / audio metadata from the files (title, narrator, year, description, embedded cover art)
* Fills in missing metadata via the **Google Books API** and can optionally write it back into the MP3s
* Streams books in the browser and remembers the playback position **per user**
* Runs as a single Docker container, ~600 lines of code, SQLite storage, no external services

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

A third-level folder that contains audio files itself is treated as a **book**;
a third-level folder that only contains sub-folders is treated as a **series**.
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
   paste your Google Books API key, **Save**
5. **Scan library**

`unraid-template.xml` in this repo can also be dropped into
`/boot/config/plugins/dockerMan/templates-user/` to get the same form pre-filled.

### Or with docker compose

```bash
docker compose up -d
```

## Google Books API key

Google Cloud Console → *APIs & Services* → enable **Books API** → *Credentials* →
*Create credentials* → *API key*. Paste it in **Settings**. Then use
**Find metadata** on a book: pick a result and choose either *Use metadata*
(database only) or *Use + write into MP3s* (writes album/artist/year/genre/comment
and the cover art into every MP3 of that book).

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
public/           UI (index.html, style.css, app.js)
```
