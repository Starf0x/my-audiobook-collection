# My Audiobook Collection

A small, self-hosted web app to browse and play an audiobook collection that is
organised on disk as **Genre → Author → Book** or **Genre → Author → Series → Book**.

The full manual, with screenshots of every part of it, is in the
[wiki](https://github.com/Starf0x/my-audiobook-collection/wiki).

* Three-column interface: genres on the left, authors next to it, books with full metadata on the right
* One search box for the lot: title, author, genre, series, narrator or a few words from the description
* Each genre lists its series underneath it, from a series folder, from sibling volume names, or from the tags
* Opens on shelves of covers: what you were listening to, with how far you are, and what was added last
* Scans one or more library folders on the server (with a built-in folder browser)
* Reads ID3 / audio metadata from the files (title, narrator, year, description, embedded cover art)
* Draws a cover for a book that has none, so a shelf is never a row of empty rectangles
* Shows per book which tags the **files themselves** carry, so database-only metadata is visible as such
* Fills in missing metadata via the **Google Books API**, or by hand, and writes it back into the MP3s
* A *Needs tags* list of every book whose files miss a required tag, with writing and lookup on the spot
* Files new audiobooks from an **import folder** into the right genre, author and series
* Moves a book to another genre, author or series, and deletes one to a trash it keeps for 30 days
* Streams books in the browser, remembers the playback position **per user**, and marks books listened
* Unticking *Listened* clears the place kept in that book, so it starts from the beginning again
* The Play button of the book that is playing is its Pause button, on the card you started it from
* The player is the app's own: dark, with a yellow line showing how far into the track you are
* The cover is a play button too: click the picture to start a book, click it again to pause it
* Covers drawn for books with no art of their own rotate their two colours every day
* Works on a phone: one column at a time, thumb-sized rows, full-screen dialogs, the player across the bottom
* **Home Assistant** reads the collection and carries a book on to any media player in the house
* Runs as a single Docker container, SQLite storage, no external services
* One job at a time: whichever button started the job greys out until it is done, wherever it was pressed
* Except tag writes: two books, or two series, can be written at once, each with its own bar

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

Settings has a **Genres** section to make one: it creates the folder, and adds it
as a library folder when your libraries are single genre folders, so the new genre
is offered for an import straight away.

If a library folder holds things you do not want scanned, add the genre folders
themselves and tick *Is a Genre* behind each, instead of adding their parent.
A scan warns when a folder looks like a genre but is not marked as one, since its
authors would otherwise be filed as genres.

Supported files: `.mp3 .m4a .m4b .ogg .flac .opus` (tag writing is MP3-only).

## Series

A series shows up under its genre in the left column, with the number of books in
it, and opens as one list in reading order. Genres fold their series away: the
arrow beside a genre opens and closes it, while the name selects the genre and
leaves the list as it was, and the column comes back the way you left it. Every
book card names its series next to the cover, and so does every tile on the
shelves.

A series comes from any of three places:

* a **series folder** — `Fantasy / Brandon Sanderson / Mistborn / The Final Empire`
* **sibling folder names**, when two or more folders under one author differ
  only by a volume number — `The Dark Tower I`, `The Dark Tower II`, … make the
  series *The Dark Tower*, numbered in that order. One such folder on its own is
  just a title that ends in a numeral, and disc folders are never volumes.
* the **files themselves**, for a book filed straight under its author: the
  movement name (`MVNM`), the grouping frame (`TIT1`) or a `SERIES` text frame,
  which is where audiobook taggers put it, with the movement index deciding the
  order. A tag that names the volume rather than the series — `The Dark Tower V`
  — is read as book 5 of *The Dark Tower*, so it joins the other volumes instead
  of standing alone

A series only appears after a scan, since that is when the folders and files are
read. Books that were already in the library pick it up from a rescan without
their folders having to change.

All three are shown the same way, on the cards and as a heading in the author
view. A series that was not a folder never moves a file: the folders stay as they
are, and *Move…* and the **Series** field still work on the folder alone.

## Run it on Unraid

The template does the whole form for you. Copy
`my-My-Audiobook-Collection.xml` to
`/boot/config/plugins/dockerMan/templates-user/` on the server, then Docker →
**Add Container** → pick **My-Audiobook-Collection** under *User templates*, and
check the paths it filled in:

| Setting | Default | What it is |
| --- | --- | --- |
| WebUI Port | `8523` | change it if the port is taken; the WebUI link follows |
| Appdata | `/mnt/user/appdata/my-audiobook-collection` → `/data` | database and cover images |
| Audiobooks | `/mnt/user/Audiobooks` → `/audiobooks` | the collection, read/write so tags can be written |
| Import folder | empty → `/import` | where new audiobooks arrive; leave empty if you do not import |
| User ID / Group ID | `99` / `100` | **who the app writes as.** Leave these: without them it runs as root, and every folder it creates on your share belongs to root, so you are refused permission to write in it yourself |
| File mode mask | `000` | the mode of what it creates. `000` is what an Unraid share normally is; `022` makes it read-only to others |
| Admin password | empty | guards everything that changes the collection; the only place it is set |
| Google Books API key | empty | for looking up missing metadata; the only place it is set |
| Home Assistant token | empty | only for the polling addresses: set it to make `/api/ha…` ask for it. The page above needs no container setting |
| Base URL | empty | only behind a reverse proxy: the address other machines reach the app on |
| Google country | `US` | which country's Google catalogue to answer from. Series data belongs to a country's catalogue and the US one has the most of it, so leave this unless you have reason not to |

The last three are optional, and the two variables are masked in the form. Then
**Apply**, and open the WebUI:

1. The first visit asks who is listening, and asks you to **type** a name. That
   first page, at the bare address, is the listening one; the page that changes
   things is at `/admin`, or one press of **Admin**: a
   browser is only ever offered the names it has used itself, so nobody arriving
   at the address is handed a list of everyone in the house. On your next visit
   the same browser offers the name back.
2. **Settings ▾ → Library and maintenance** → add `/audiobooks` as a library folder (*Browse…* picks it from
   the container's own view of the disk) → **Save**.
   If `/audiobooks` also holds folders you do not want scanned, add the genre
   folders one by one instead and tick *Is a Genre* behind each.
3. **Scan library**. The bar at the bottom shows how far it is, and the button
   stays grey until the scan is done. With more than one library folder, the
   pulldown beside it picks which one to scan, or all of them — each option says
   what the button will do: *Scan all libraries*, *Scan /audiobooks/Fantasy*.

Set an admin password before you share the address with anyone: until one is
set, whoever opens the app may change the collection.

### Updating

Because the container comes from a user template, an update is one click. Unraid
names a user template after the container it belongs to, `my-<container name>.xml`,
and the `<Name>` inside the file has to match that name too — that pairing is what
makes the Docker tab treat it as managed. Rename both if you call your container
something else.

**Force update** is in the Docker tab's *Advanced View*: switch the toggle at the
top right and the container row gains a version column, the context menu a *Force
update* entry. Neither is shown in Basic View.

### The two variables

`ADMIN_PASSWORD` and `GOOGLE_API_KEY` live here and nowhere else. Neither has a
field in Settings, so there is no second copy to drift out of step and both
survive an emptied appdata folder. Leave the password empty for an install that
nobody has to unlock; fill it in and every browser has to unlock before it can
change anything.

### Or with docker compose

```bash
docker compose up -d
```

## Searching

The box at the top of both pages looks for what you type in everything a book is
filed or described by: its title, its author, its genre, its series, its narrator
and its description. Every word has to appear somewhere in the same book, so
`sanderson mist` finds Mistborn without you having to know which field holds
what, and `kramer` finds everything one narrator read.

Results replace the book column and are headed with what was searched for and how
many books matched. Books whose title matches come first, then the ones matched by
author. Emptying the box — or pressing Escape — puts back whatever was on screen
before; picking a genre or an author lets go of the search.

## Two pages, and who may change things

There are no file names in the addresses. **`http://your-server:8523/`** is the
listening page — it browses, plays and keeps each person's place, and is the one
to share. **`/admin`** is the page that changes the collection: scanning,
importing, tagging, moving, deleting. The listening page carries an **Admin**
button that asks for the password and then opens the other one, and the name of
the app in the header leads back to the shelves from wherever you are.

The old addresses, `/listen.html` and `/index.html`, still answer with a redirect,
so an old bookmark or a link you handed out keeps working.

The password is `ADMIN_PASSWORD` on the container, and changing it means changing
it there and restarting. Until one is set the app behaves as a private install:
whoever opens it may do anything. Once set, every
request that changes something is refused unless the browser has unlocked, so
hiding the buttons is not what protects it — the server does. A visitor who types
the admin address is sent to the listening page.

## On a phone

![The app on a phone, mid-book](https://raw.githubusercontent.com/Starf0x/my-audiobook-collection/main/docs/phone.png)

Below 720 pixels the three columns become one, and the app steps through them:
genres, then the authors and series of that genre, then the books. Each heading
carries the way back — *‹ Genres*, *‹ Authors* — and the genre column has a
*Books ›* step forward, so nothing is more than one tap away. It opens on the
shelves, as it does on a desktop.

Everything else follows the screen: the header wraps to two rows with the search
across the width, a book card puts its cover and text side by side and its buttons
in a grid under them, dialogs become full-screen sheets that scroll, the player
keeps cover, title and track on one line with the transport across the
bottom, and every row and button is at least 40 pixels tall. Fields are set at
16px so a phone does not zoom the page when you tap one. A tablet, and a phone on
its side, still get all three columns — narrower.

The long list of tags a file carries is a paragraph on a phone, so a card there
says *In MP3: 10 tags* instead; the full list is still what the desktop shows.

## Names, and why one browser is not offered another's

A listener has no password of their own — the app is meant to be shared inside a
house, and the single admin password guards everything that *changes* the
collection. What keeps one person out of another person's place in a book is that
**a browser is only ever offered the names it has said itself**. The names a
browser has used are kept in a cookie of its own; the server hands back nothing
else. So a stranger who opens the listening page sees an empty dialog and a field,
not a list of the household.

Two things follow. A browser two people share is offered both names once both have
typed theirs, which is what a family tablet needs. And someone who knows an
existing name exactly can still type it and pick that place up — on a new phone
that is the *point*, and without a password per listener there is no way to tell
the two apart. If that matters more than convenience, give each listener their own
name that others do not know.

## Playing, and stopping

![The Continue listening shelf, one book playing](https://raw.githubusercontent.com/Starf0x/my-audiobook-collection/main/docs/shelf.png)

Unticking **Listened** on a book clears the place kept in it: the tick means "I
have listened to this", so taking it off means the opposite, and the book leaves
*Continue listening* and starts from the beginning next time. Nothing else about
the book changes. Note that a place is not recoverable this way — if you only
wanted to correct a mis-click on a book you were half way through, that place is
gone.

Every book on the **Continue listening** shelf carries its own button under the
track it is on, and since those are the books you are in the middle of it reads
**▶ Resume** — a place kept is a place to carry on from, whether or not anything
is loaded in the player, so a reload does not turn it back into *Play*. Tapping
the cover does the same as pressing it.

On a card the button says what pressing it will do: **▶ Play** for a book you have
not started, **▶ Resume** for one with a place kept in it. Either way it opens the
player at the bottom of the page, and that same button then reads **⏸ Pause**,
with a ring around it, because it is the one that stops the book it started;
pressing it again reads **▶ Resume** and carries on. Every other card and tile still says *Play*, and
pressing one of those moves the pause to that book. Which book is playing survives a redraw of
the list, so browsing away and back does not lose it.

## Who the app writes as

Set **PUID** and **PGID** on the container to the user that owns the share — on
Unraid that is `99` and `100` (nobody:users) — and **UMASK** to `000`. The app
drops to that user before it creates or opens anything, so the folders it makes
are yours to write in.

With nothing set at all it takes the hint from the data folder: running as root, it
becomes whoever owns `/data` (or the folder above it), which on Unraid is
nobody:users. So a fresh install needs no setting; an existing container that was
made before these fields existed does not gain them from an update, and either
needs them added by hand or is covered by that default.

**Settings ▾ → Library and maintenance → Check folder permissions** says who the app is writing as and what
each folder lets it do — it writes a file and removes it again rather than reading
the mode and guessing. That is the first thing to look at when something cannot be
written.

Without them it runs as root: the import lands, and then you cannot copy anything
into the folder it made, or move it, from your own machine. If that has already
happened, hand the folders back on the server once:

```bash
chown -R 99:100 /mnt/user/Audiobooks && chmod -R u+rwX,g+rwX /mnt/user/Audiobooks
```

A file error from the disk is reported in words rather than as a code: a refusal
says which user the app is writing as and what to set, a full disk says it is full,
and a read-only mount says so.

## Importing new audiobooks

Set an **Import folder** in Settings, drop new audiobooks in it, then open
**Import** in the left column. Every book folder in there is listed, however deep
it sits: a folder holding audio is a book, and so is one whose sub-folders are all
discs. The author and series are guessed from the folders around it and from the
tags. Pick one, choose the genre, and correct the author, optional
series and title; the line underneath shows exactly where it will land. *Move*
files the folder into `<genre>/<author>/[series]/<title>` and files it straight
into the library, so it turns up at once without a rescan of everything else —
the page then opens the genre and author it landed under, with the book in it.
The list is kept after the first read and handed back at once next time, ten per
page, so a large import folder is not walked on every page load. A book that has
gone is dropped from it the moment the list is asked for again, and while the
Import panel is open the folder is looked at every few seconds: empty it and the
list empties itself, drop a book in and it appears, without pressing anything.

If a book already sits where this one would land, nothing is overwritten. The two
copies are compared on audio quality — bit rate, sample rate, channels, format,
playing time, size — and you choose. *Replace* renames the copy that is there
`Replaced - …`, so the new one takes its path and with it the book's row, every
listener's position and every listened mark; the old copy is listed under
**Replaced** in the left column until you delete it. *Keep the one I have*
renames the incoming folder `Not Imported - …` and leaves it where it is. Both
prefixes hide a folder from the app, and neither is offered for import again.

The folder is moved, not copied, so the import folder empties as you work through
it. Where a rename cannot cross — two Docker mounts, or a user share spread over
several disks — the files are copied instead, with the bar showing the file count,
and **the original is only removed once every file has arrived at the same size**.
A copy that stops half way leaves the source untouched and says how far it got.
Nothing is ever moved onto a folder that already holds something. Names are
stripped of characters a path cannot hold.

## Moving and deleting

The **Series** field in *Edit metadata* moves the book too, since a series is a
folder: filling it in files the book under `genre / author / series / book`, and
emptying it moves the book back up. The folder keeps its own name. The line at the
foot of that dialog is the folder the book sits in and how many files it holds,
for when two books share a title.

*Move…* on a book card shifts its folder to where a new genre, author, series and
title say it belongs. The book keeps its row, so the listened state and playback
position travel with it. Taking the last book out of an author or series folder
drops that folder with it, so no empty author is left listed; the genre folder
itself always stays. A restore from the trash puts back whatever folders it needs.

*Delete…* moves the folder into a `.trash` folder inside the same library folder,
which keeps it on the same filesystem and out of the scanner's way, and records
the deletion. **Trash** in the left column lists what is in there, how long it has
left, and offers *Put back*, *Delete now* per book and *Empty trash*. Anything
older than 30 days is dropped by itself, checked at startup and once a day after.

## Checking the books against the disk

A scan trusts the folders it walks. **Check every book against the disk** in
Settings does not: it opens every file of every book, which is what finds a
truncated download, a zero-byte file or a share that answers but will not read.
It asks first, because on a large collection this takes minutes rather than
seconds, and it reports through the bar at the bottom.

What it finds is listed under **Broken on disk** in the left column, with the
reason and how many files are involved:

| Reason | What it means |
| --- | --- |
| the folder is gone | nothing at that path any more |
| no audio files left | the folder is there and empty of audio |
| files that cannot be read | truncated, zero-byte or unreadable files |
| files have changed | the files the library listed are gone, others are there — a scan will pick those up |

Each entry offers **Check again**, which re-reads that one book and drops it off
the list when it is well, and a delete: *Delete…* moves the book to the trash
when its files are still there, and *Forget it* removes the library entry when
they are not.

## How fast it works through a collection

Almost all of the waiting is the disk, not the work. Reading the tags of one
book on a network share costs about a second, nearly all of it spent waiting for
an answer, so the app keeps several reads in flight at once — up to eight,
whatever asks for them, which is what a share will answer without complaint.
On a real share that made a scan three times faster; a check against the disk,
an import folder being read and the comparison of two copies of a book gain the
same way.

Writing tags is the other half, and it is the opposite: node-id3 rewrites the
whole MP3 and does it synchronously, which used to hold up the whole server for
the length of every file. Those writes now happen on worker threads, a few at a
time. Measured on a local library of 5 MB files: 18.5 ms per file before and
6.4 ms per file now, and the longest the interface was left waiting fell from
29 ms to 12 ms. So **Write tags into all MP3s** finishes in a third of the time
and the pages stay answerable while it runs.

## Books with no cover

![Covers drawn for four books that have no art of their own](https://raw.githubusercontent.com/Starf0x/my-audiobook-collection/main/docs/no-cover.png)

*Dune*, *The Name of the Wind*, *The Shining* and *SPQR* have no art of their own
here; the other three do.

Not every book comes with art, and a shelf of empty rectangles is hard to read.
A book with no cover of its own gets one drawn for it: the title, the author and
a pair of headphones, in colours taken from the title, so two books beside each
other rarely look alike. It stands in for art that has gone missing from disk as
well.

**The two colours turn over every night.** The pair — one hue and its partner 42°
along — is spun 37° a day, so the shelf you open in the morning is not the one you
left, while a book keeps the same cover all day and the whole set takes a year to
come back round. Real cover art never changes, and a browser is told it may keep a
drawn cover only until midnight.

![The same four drawn covers today, tomorrow and the day after](https://raw.githubusercontent.com/Starf0x/my-audiobook-collection/main/docs/cover-days.png)

Nothing is written to disk for this — it is drawn when the page asks for the
cover. A book with a drawn cover still counts as one that **needs tags**, so
finding it real art and writing that into the files remains the fix.

## Cover files it no longer needs

Covers are stored under the name of the image itself, so a book that gets new
artwork leaves its old file in `/data/covers`. **Tidy up unused covers** in
Settings moves every cover file no book refers to into `covers/duplicates`,
overwriting a file of the same name already there. Once that folder holds more
than a thousand files it says so and asks whether to delete them; decline and
they are zipped into one archive beside them and the loose files removed.

## Home Assistant

**Nothing to configure in Home Assistant** — no YAML, no custom component, no
restart. The app talks to HA rather than waiting to be polled: give it the address
of your Home Assistant and one **long-lived access token** made in it, and it
writes its own sensors into HA and plays books on HA's media players.

It has a page of its own: **Settings ▾ → Home Assistant**, or
`http://<your-server>:8523/ha`.

![The Home Assistant page](https://raw.githubusercontent.com/Starf0x/my-audiobook-collection/main/docs/ha-page.png)

1. **The connection** — the address you open HA at, and a token from HA (your
   profile → *Security* → *Long-lived access tokens* → *Create token*). *Test the
   connection* answers with which Home Assistant replied and its version, or with
   what is wrong. The token is kept in the app's database, never shown again and
   never sent back to a browser; *Forget the token* removes it.
2. **What it publishes** — six sensors: `sensor.audiobooks` (with the files, the
   hours total/listened/left, the books marked listened and the new books as
   attributes), `sensor.audiobook_files`, `sensor.audiobook_hours`,
   `sensor.audiobook_hours_listened`, `sensor.audiobook_hours_left` and
   `sensor.audiobook_next_up` (the title to carry on with, with its track, the
   seconds in, the percentage, and the whole queue). Pick whose progress to report
   and how often to send — Home Assistant forgets states written straight into it
   when it restarts, so a repeat keeps them there. *Show what will be sent* lists
   it without sending.
3. **Play a book on a media player** — the players HA knows, by their own names.
   Press *Play here* beside a book and the app hands that player the playlist from
   the track you are on, then asks it to skip to the second you stopped at. A
   player that cannot seek still plays, from the start of that track.

Hours listened count a book marked *Listened* whole, and a book in progress as the
tracks behind the listener plus the seconds into the one they are on.

Two things worth knowing: the **player fetches the audio itself**, so behind a
reverse proxy set `BASE_URL` on the container to the address other machines use;
and **positions do not come back from a player**, so a book played on a speaker
and then carried on in the browser starts where the browser last was.

If you would rather have HA poll, it still can: `GET /api/ha` is the whole state,
`GET /api/ha/continue.m3u` is the book being listened to from where it stopped, and
`HA_TOKEN` on the container makes those ask for a token. The whole of it, with
dashboard and automation examples, is in
[docs/home-assistant.md](docs/home-assistant.md).

## Google Books API key

Google Cloud Console → *APIs & Services* → enable **Books API** → *Credentials* →
*Create credentials* → *API key*. It goes on the container, as `GOOGLE_API_KEY`
(the Unraid template has a masked field for it), and nowhere else.

**Find metadata** on a book and pick a result, or type your own search when the
folder name finds nothing. A result that credits more than one author offers the
pair as a choice: both names, or either one — what you pick goes into the artist
and album artist tags, and the author folder keeps its name. A result that comes
with categories offers them as genres next to the one the book is filed under
now; since a genre is a folder, picking another one moves the book there —
creating and registering the folder if it is new — and writes that genre into the
tags. A 503 from Google is retried after 10, 20 and 30 seconds, with the wait
shown in the dialog.

### How the series is found

Google keeps series in an awkward place, so this is worth knowing. A search answer
names the series in the **title's brackets** (*The Final Empire (Mistborn, #1)*,
*(The Dark Tower V)*, *(Book 3 of The Expanse)*, *(A Mistborn Novel)*) or in the
**subtitle** (*Mistborn Book One*) — and for plenty of books, in neither. *A Kiss
of Shadows* has a clean title, no subtitle, and is book 1 of *Merry Gentry* all
the same.

That series lives in `volumeInfo.seriesInfo`, and two things about it matter. It is
attached to the **volume**, not to a search result, so it is usually missing from
the answer a search gives. And it holds **no series name** — only an id, the
sequence number (`orderNumber`; `bookDisplayNumber` is for printing and can read
*2.5*), and a "short title" that is as often the book's own name as the series'.
The name itself is a third endpoint, `series/get`.

Worse, Google keeps that data **per record, not per book**. A search for one novel
answers with several editions, and one of them can be in a series while the others
are in nothing at all. Every request also says which **country's** catalogue to
answer from (`GOOGLE_COUNTRY`, `US` by default): left to guess from your server's
address, Google can hand back a record with no series data on it.

So the app asks in this order and stops at the first answer:

| Step | Costs | What it gets |
| --- | --- | --- |
| the words of the result | nothing | *Mistborn* from a title or subtitle |
| `volumes/<id>` | one request | the series id and the sequence number |
| `series/get` | one request, then cached | the name Google keeps for that series |
| another result of the same book | nothing | the series one edition has and the others do not |
| the ebook catalogue | one request, only when nothing else had one | the series of the ebook edition |
| every other record of the book | one request, only when that found none | a series named in the title of a record the first five missed |

The last three are what make it work in practice. A series found on any edition in
the list is offered on all of them — matched by title, so a different book that
happened to match the words lends nothing — and it says where it came from. When no
edition in the list has one, the ebook catalogue is asked once. Failing that, the
lookup widens from five records to forty: Google holds dozens of records per book,
and the one somebody entered as *A Kiss of Shadows (Merry Gentry Book 1)* names the
series in its title even when the record Google matched does not. Only records of
that same book count, so a sibling in the series cannot lend its own volume number
and another book by the author cannot lend anything.

**What it cannot do.** The series panel on books.google.com comes from Google's
internal Play catalogue, not from the Books API, and there is no parameter that
makes an API answer contain a field Google did not put in it. For a book where
every record, its ebooks and all forty records are silent, the reason line says so
and the answer is *Edit metadata* — type the series once and it stays, in the book
and in the tags.

A book whose title says its series is never asked about again; a book like *A Kiss
of Shadows* costs two extra requests, and the second of them once per series, not
once per book — a shelf of *Merry Gentry* pays for the name a single time. Neither
request can take the lookup down: an eight-second limit each, and anything that
fails costs the series and nothing else.

There has to be a series *somewhere* for one to be offered: *(Unabridged)* and
*(Penguin Classics)* are not series, neither is a number on its own, and a series
named after the book itself is the book. What it finds is shown as a tick beside
the name and the volume number, on by default and refusable, and the brackets come
off the title so the album tag does not carry them.

When a result offers no series, the dialog **says why** — *Google keeps no series
data for this edition*, *Google answered 403*, *Google's series line is the book's
own title*, *Google files it in series `<id>` but would not name it*. Google keeps
series data per **edition**, so one result in a list can have it where another does
not: when a book you know is in a series gets nothing, the reason line is the thing
to read, and the other results are worth a look.

![Two editions of one book: one with no series data, one with the series](https://raw.githubusercontent.com/Starf0x/my-audiobook-collection/main/docs/series-why.png)

**Settings → What Google says about series** asks about a stretch of books that
have no series yet and reports, per book, what Google answered, which of the three
places the series came from, the raw `seriesInfo` fields, the reason where there is
none, and how many requests it took.

![The series report in Settings](https://raw.githubusercontent.com/Starf0x/my-audiobook-collection/main/docs/series-report.png)

![A lookup result offering the series it read out of the title](https://raw.githubusercontent.com/Starf0x/my-audiobook-collection/main/docs/series-lookup.png)

Applying it names the series in the book and **does not move the book** — a
series folder is a folder, and moving between folders is *Edit metadata*. Writing
the tags puts the series in the grouping frame with its number on the end
(`Mistborn 2`), which is one of the places a scan reads a series from, so the
next scan agrees instead of dropping it. A series filled in without writing the
files survives a scan too. Where the folders already say which series a book is
in, the folders keep winning, and the volume number then stays theirs.

## When a scan finds fewer books than you have

A scan now keeps a list of every folder it walked past, and why. When there is
something in it, **Not counted** appears in the left column with the number, the
bar says so when the scan finishes, and the list names each folder, the reason and
its full path. Nothing in that list was deleted or changed — it is only a report.

| Reason | What it means |
| --- | --- |
| a folder deeper than the layout reads | the audio sits below `genre / author / series / book` — a boxed set inside a series folder, say. Move those books up one level |
| files this app does not read | it lists what it found: `.aax`, `.wma` and their kind are not read. Supported: `.mp3 .m4a .m4b .ogg .flac .opus` |
| nothing to read in it | an empty folder, or one with no audio anywhere below it |
| audio outside a book folder | loose files in a genre or author folder: a book has to be in a folder of its own |
| set aside by an import | a `Not Imported - ` or `Replaced - ` copy, which is deliberate |
| the folder could not be read | a permission or share problem, with the error |

The list is what the **last** scan found, kept in memory, so it is empty until you
scan and after a restart.

## When a book will not leave *Needs tags*

A book counts as done when its **files** carry all of album, title, artist, album
artist, genre, year, description, cover art and track number. Open **Needs tags**
and read a row: it says what a write can add now, and what is *not known yet*.

Writing tags cannot invent what the app does not have. A book with no year, no
description or no cover art anywhere keeps asking for those until a lookup or
*Edit metadata* fills them in — that is the *not known yet* half of the row, and no
number of scans or writes will change it.

Cover art beside the audio counts: a `cover.jpg`, `folder.jpg` or `front.png` in
the book's folder is written into the files like any other, so a collection with
folder art does not need embedded art first.

The version the container is running is at the right-hand end of the status line
along the bottom, so "did the update land?" has an answer on screen.

## Tags written by another program

A scan reads every book's first file again, so tags you wrote with another tagger
are picked up by **Scan library** — not only *that* they are there, which is what
the *Needs tags* list counts, but their values: the narrator, year, description and
cover art come into the app as well. The counts in the left column follow the scan
without a reload.

Where the file says nothing, what the app knows is left alone, so a description
typed into *Edit metadata* survives a scan. Where the file does say something, the
file wins — it is the collection, and a tag write puts the app's values into it
anyway.

## What a tag write puts in the MP3s

*Write into MP3s* on a book, *Save + write into MP3s* in the edit dialog and
*Write tags into all MP3s* in Settings all write the same thing into every MP3 of
the book:

| Frame | From |
| --- | --- |
| `TALB` album and `TIT2` title | the book title |
| `TPE1` artist and `TPE2` album artist | the author |
| `TCON` genre | the genre folder |
| `TYER` year, `COMM` description, `APIC` cover | the book's metadata |
| `TCOM` composer | the narrator |
| `TRCK` track number | renumbered in playing order, zero padded: `01/12`, `001/120` |

Values the app does not have are left out rather than written empty, so a book
with no description keeps no empty comment frame. The badge on each card lists
what the files actually carry.

Two books can be written at the same time — a book from one series and a book
from another, each with a bar of its own that names it. **The same book twice is
never started**, whichever way it is asked for: the button that started it is dead
while it runs, that book's *Find metadata* and *Edit metadata* are held back, a
second attempt from another tab or an older dialog is answered with a sentence
rather than an error, and the server refuses a request that skips the page
altogether — two writers on one file is worse than a wait. The whole-collection run
waits for any single write to finish before it starts, because it would reach that
book itself. While a write is going, the buttons that would move those files or
read them mid-write — a scan, an import, the disk check, *Find metadata*, *Edit
metadata* — stay greyed.

*Write tags into all MP3s* does the whole collection, which is an hour of work on
a big share, so it runs **on the server**: closing the page does not stop it, and
reopening it picks the bar back up. **Stop** leaves it exactly where it is — what
is left to do is a queue in the database — and the button then reads *Carry on
writing tags*. A container that restarts mid-run leaves the run paused rather
than starting it again on its own, with its place kept.
