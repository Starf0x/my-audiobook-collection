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
* The Play button of the book that is playing is its Pause button, on the card you started it from
* Works on a phone: one column at a time, thumb-sized rows, full-screen dialogs, the player across the bottom
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
| Admin password | empty | guards everything that changes the collection; the only place it is set |
| Google Books API key | empty | for looking up missing metadata; the only place it is set |

The last three are optional, and the two variables are masked in the form. Then
**Apply**, and open the WebUI:

1. The first visit asks who is listening, and asks you to **type** a name: a
   browser is only ever offered the names it has used itself, so nobody arriving
   at the address is handed a list of everyone in the house. On your next visit
   the same browser offers the name back.
2. **Settings** → add `/audiobooks` as a library folder (*Browse…* picks it from
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

`index.html` is the page that changes the collection: scanning, importing,
tagging, moving, deleting. `listen.html` only browses, plays and keeps each
person's place, and is the one to share. It carries an **Admin** button that asks
for the password and then opens the other page.

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
keeps cover, title and track on one line with the audio controls across the
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
page, while a background pass checks the folder for changes.

If a book already sits where this one would land, nothing is overwritten. The two
copies are compared on audio quality — bit rate, sample rate, channels, format,
playing time, size — and you choose. *Replace* renames the copy that is there
`Replaced - …`, so the new one takes its path and with it the book's row, every
listener's position and every listened mark; the old copy is listed under
**Replaced** in the left column until you delete it. *Keep the one I have*
renames the incoming folder `Not Imported - …` and leaves it where it is. Both
prefixes hide a folder from the app, and neither is offered for import again.

The folder is moved, not copied, so the import folder empties as you work through
it. If the import folder sits on a different mount than the library, the files are
copied across and the source removed, with the bar showing the file count. Names
are stripped of characters a path cannot hold.

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
a pair of headphones, in colours taken from the title, so the same book always
looks the same and two books beside each other rarely look alike. It stands in
for art that has gone missing from disk as well.

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
from another, each with a bar of its own that names it. The same book twice is
refused, since that would be two writers on one file, and the whole-collection run
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
