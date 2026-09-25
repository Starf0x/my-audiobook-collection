# My Audiobook Collection

A small, self-hosted web app for an audiobook collection that is organised on disk
as **Genre → Author → Book** or **Genre → Author → Series → Book**.

It does three things, and it does them properly:

> **It writes the metadata into your MP3s.** Not into a database only its own
> interface can read — into the files, where every other player will find it.
>
> **It turns `.m4b` and `.ogg` into MP3, a chapter to a track.** So the books
> that could not be tagged, can be.
>
> **It plays them,** and remembers where each person got to in every book.

The full manual, with screenshots of every part of it, is in the
[wiki](https://github.com/Starf0x/my-audiobook-collection/wiki).

### Writing the tags into the files

* Shows per book which tags the **files themselves** carry, in green, so metadata that is only in the database is visible as such
* A **Needs tags** list of every book whose files miss a required tag — nine of them — with writing and lookup on the spot
* Fills in what is missing from the **Google Books API**, or by hand, and writes it back into the MP3s
* Writes album, title, artist, album artist, genre, year, description, cover art, narrator and a renumbered track number
* **Merges**: frames it is not setting are left alone, and a value it does not have is left out rather than written empty
* A value written by another tagger is picked up by the next scan — what it says, not only that it is there
* The whole collection in one run, **on the server**: closing the page does not stop it, and it can be stopped and carried on
* Two books, or two series, can be written at once, each with its own bar — but never the same book twice at once

### Converting to MP3

* Converts `.m4b` and `.ogg` books to MP3 — **a chapter becomes a track**, named and numbered in order
* A **Needs converting** list of every book whose files are not MP3, and *⤳ Convert to MP3…* on any cover
* Keeps what it came from: the originals move to **Converted**, with their size and date, and you delete them when you are satisfied
* Cover art the source carried is written beside the audio, so nothing is lost
* `ffmpeg` and `ffprobe` are **part of the image** — nothing to install, upload or configure
* Every refusal says why, in words: an older container, a file the tool could not read, or what the tool itself said

### Playing it

* Streams in the browser, remembers the position **per user**, and marks a book listened when it runs out
* The player is the app's own: dark, with a yellow line measuring **time through the book**, not tracks
* **A book keeps playing when you change page** — the listening page, the admin page and the Home Assistant page hand it over between them
* The Play button of the book that is playing is its Pause button, on the card you started it from
* The cover is a play button too: click the picture to start a book, click it again to pause it
* Unticking *Listened* clears the place kept in that book, so it starts from the beginning again
* **⤓ downloads the whole book** — every file of it in one archive, not the single track that is playing
* **Home Assistant** reads the collection and carries a book on to any media player in the house
* **Music Assistant** can be pointed at it as an Audiobookshelf server: browse the books there, play them on any speaker, and the place syncs both ways

### And around all that

* Three-column interface: genres on the left, authors next to it, books with full metadata on the right
* One search box for the lot: title, author, genre, series, narrator or a few words from the description
* Each genre lists its series underneath it, from a series folder, from sibling volume names, or from the tags
* Says under a series which volume you are missing, from the numbers it already has — no requests, no key
* And asks **Wikidata** which volumes a series actually has, so a book you never owned is one you can be told about
* Opens on shelves of covers: what you were listening to, with how far you are, and what was added last
* Scans one or more library folders on the server (with a built-in folder browser)
* Draws a cover for a book that has none, so a shelf is never a row of empty rectangles
* Files new audiobooks from an **import folder** into the right genre, author and series
* Moves a book to another genre, author or series, and deletes one to a trash it keeps for 30 days
* Says which books it could not read, and which folders it walked past, rather than quietly finding fewer
* The page itself, and the covers drawn for books with no art of their own, turn their colours every day
* Works on a phone: one column at a time, thumb-sized rows, full-screen dialogs, the player across the bottom
* Runs as a single Docker container, SQLite storage, no external services

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

Supported files: `.mp3 .m4a .m4b .ogg .flac .opus` (tag writing is MP3-only, so
everything else can be **converted** — see below).

## Converting .m4b and .ogg to MP3

Those books play, but their tags cannot be written, so they never leave *Needs
tags*. **Needs converting** in the left column lists every book whose files are not
MP3, and *⤳ Convert to MP3…* on a cover does one on the spot.

A **chapter becomes a track**, which is what this app calls a chapter: an `.m4b` of
30 chapters becomes 30 MP3s named `01 - <chapter>.mp3`, in order, each carrying its
chapter name as its title, so the player lists them and you can jump between them.
A file with no chapters becomes one MP3. The cover art the source carried is
written beside the audio as `cover.jpg`, where a scan and the tag writer both read
one from.

The files it came from are not deleted: they are moved to a `.converted` folder
inside the same library folder and listed under **Converted** in the left column,
with what they were, how big they were and when. Delete them there once you are
happy — one book at a time or all of them.

### ffmpeg and ffprobe

Converting uses both, and they are **part of the image** from 2.3.0 on — nothing to
install, upload or configure, and always the build that image is for. A container
from before that says so when you try: update it to the newest build.

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

### Which volumes you are missing

Under the name of a series, on both pages, is a line saying what the collection
has of it — *Missing: book 3* in red where a number has no book on it, or *Book 1
to 5 are all here* where nothing between them is absent.

It reads the **volume numbers**, so it can only say as much as those do:

* **It never calls a series finished.** A shelf holding books 1 to 5 says exactly
  that; whether a book 6 was ever published is not something the app can know.
  Google's Books API will not answer it either — it says whether a *series* is
  complete, never which volumes are in it — so this is counted at home, and costs
  no requests and no key.
* **Books with no number are counted and said.** *Missing: book 2. 1 book(s) here
  carry no volume number, so what is missing may be among them* — the unnumbered
  one may well be the gap. Give it a number in *Edit metadata* and the line
  settles.
* **A series nobody has numbered says so** rather than pretending to a verdict, and
  a single book on its own gets no line at all.
* **It counts the whole series, not the books on screen.** Browsing by author
  shows one author's share of a shared series; the book another author wrote still
  counts as one you have.

And when you would rather ask than come across them: **Series to complete**, in
the left column under *Maintenance*, goes through every series in the collection
and shows the ones with a hole. Each gets a series heading — its name, the
sentence saying what is gone, a **⧉ copy** button and *Open in library*, which
goes to that series where the missing book would land — and under it **one card
per missing volume, one under the other**, the way the rest of the library is
drawn. There is no title to put on such a card, since nothing in your files
knows what book 3 is called, so it reads *Book 3* and says why it is there: your
own books run up to book 4, with nothing on 3. It is the same counting as the
line under a series head, so it asks Google nothing and costs no quota. Series
that carry no volume numbers at all are named there rather than left out: they
are the ones no verdict could be given about, and an empty list would otherwise
read as *nothing missing*.

### Does a volume exist that I do not have?

That is a different question, and nothing in your own files can answer it: your
numbers say a book is missing *between* the ones you have, never that a ninth
was ever written. **Series to complete**, in the left column under *Maintenance*,
asks **Wikidata** — which records the volumes of a series and their order, needs
no key and costs no quota, and is sent nothing but the series name.

It goes through every series, slowly and one at a time, because that is
somebody's free service; on a large collection it runs for a few minutes, on the
server, and you may close the page. **What it found is kept**, so restarting or
updating the container does not throw it away and ask you to spend those minutes
again — the pane tells you when it was last asked. The pane keeps the two kinds of answer
apart, because they are not equally certain: what is missing **between your own
books** is counted here and exact, and what **Wikidata knows and you do not
have** is a question asked of the world.

**It is browsed the way the library is**, in three columns like the rest of the
app. The authors column fills with whoever is short of something, with a count
each, and clicking a name narrows the pane to their series; it fills as the check
runs, so an author Wikidata has just found appears while you watch, and the name
you were reading stays chosen. A volume you do not have is drawn as **the card it
would be** —
cover, title, author, *Series · name · book 3* — because what you want is the
thing to go and find. Those cards are dashed and dimmed, and have no Play
button, so a shelf of them never reads as part of your collection. Every card
and every series heading carries a **⧉ copy** button that puts
`author - title` (or `author - series`) on the clipboard, ready to paste into a
search.

Under that, each card has **Wikipedia ↗**, which opens in a new tab: the book's
page where it has one, and Wikipedia's search for it where it has not, so it
never lands on nothing. A card that is only a number — *Book 3* — asks about the
series instead, which is the page that lists the volumes. Cards Wikidata found
also keep *On Wikidata*, so you can check the entry it picked.

Three things it will tell you rather than hide:

* **Which entry it took**, with a link. A name is not an identifier — *The Dark
  Tower* is also an album, a film and a video game — so it picks the one whose
  volumes look like the books you already have, and says which that was.
* **When it could not tell.** A series it cannot place is listed with the reason,
  never quietly counted as complete.
* **When it matched by title.** If your books in a series carry no volume
  numbers, it compares titles instead and says so.

Their numbering is not always yours: Wikidata has *The Wind Through the Keyhole*
as book 8 of The Dark Tower, where it reads fourth-and-a-half. Treat what it
finds as worth looking at, not as a verdict.

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
| `MA_TOKEN` | empty | the password Music Assistant logs in with. Empty means that whole face of the app is not there |
| Home Assistant token | empty | only for the polling addresses: set it to make `/api/ha…` ask for it. The page above needs no container setting |
| Base URL | empty | only behind a reverse proxy: the address other machines reach the app on |
| Google country | `US` | which country's Google catalogue a **fresh database** starts on. From 2.3.72 it is chosen in Settings, and the setting wins; this only decides where it begins. Series data belongs to a country's catalogue and the US one has the most of it — but if lookups keep saying Google is busy, try your own country instead |

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

**Continue listening** is only what you are in the middle of. A book you have
finished leaves it for **Listened**, a section of its own in the left column under
the genres, with the number on the row *Books you've listened to*. The section is
not in the column at all while there is nothing on it.

Pressing that row browses what you have finished the way the library is browsed:
the **authors** of those books fill the middle column, with how many each, and the
books themselves are cards on the right — all of them to begin with, and one
author's when you pick a name, in series order with the series named above each
group. They are ordinary cards, so a book can be played again, ticked, or edited
from there.

**A book that runs out ticks itself as Listened.** Reaching the end of the last
track sets the tick — the same tick as the one under the cover — so the counts,
the shelves and this section all agree without anybody ticking anything. The tick
comes off again only by unticking it or by playing the book again; a position
reported by Home Assistant or another player never takes it off.

Every book on the **Continue listening** shelf carries its own button under the
track it is on, and since those are the books you are in the middle of it reads
**▶ Resume** — a place kept is a place to carry on from, whether or not anything
is loaded in the player, so a reload does not turn it back into *Play*. Tapping
the cover does the same as pressing it.

### It keeps playing when you change page

Going to the admin page while a book is playing does not stop it, and neither
does going on to the Home Assistant page or coming back. The player follows you:
the same book, at the same second, still playing, on all three pages — which is
why the Home Assistant page has a player at the foot of it too.

A book you **paused** stays paused. It comes back loaded, at the place you left
it, waiting for ▶ — changing page is not a reason to start a book.

One thing is the browser's to decide rather than this app's: a page is only
allowed to start making a sound when a click brought you there. That covers every
way the app itself moves between its pages. If you get to a page another way — by
typing the address, or refreshing — the browser may refuse, and then the player
is there with the book loaded and a line asking you to press ▶.

### The bar is only there while you are listening

The player at the foot of the page is not furniture: it appears when a book is
loaded into it and goes away when there is nothing to listen to.

* **A book that runs out takes the bar with it.** The last track ends, the book
  ticks itself as *Listened*, and the bar goes — there is nothing left to carry
  on with, and its card now offers **▶ Play again** rather than *Resume*.
* **✕ at the end of the bar puts it away** whenever you like. Your place is
  written down first, so the book stays on *Continue listening* and picks up
  where you left it; the bar simply stops taking up the bottom of the screen. It
  stays away when you move between the pages, too.
* **Pausing does not hide it.** A book you stopped for a moment is still the book
  you are listening to, and the bar is how you carry on with it — press ▶, or ✕
  if you are really done.

A fresh page with nothing loaded has no bar at all, which is why you may never
have seen it on a page you had only just opened.

### The right button on a cover

Right-click any cover — the one on a card, one on a shelf, or the one in the
player — and a small menu opens on it. On a phone, where there is no right button,
hold the cover for half a second instead.

| Item | What it does |
| --- | --- |
| ↺ **Start again from the beginning** | throws away the place kept in the book, takes the *Listened* tick off if it was on — a book being listened to again has not been listened to — and plays from the first track |
| ☑ **Mark as listened** | the same tick as the one inside the cover, from wherever you are — including the player, where there is no card to tick. It reads *Mark as not listened* for a book that is already ticked |
| ⤓ **Download the whole book** | every file of it in one archive, the same as the ⤓ in the player |
| ✎ **Edit metadata…** | the edit dialog on that book, without going through *Needs tags* (admin page only) |
| ⌕ **Look up metadata…** | the Google Books lookup for that book (admin page only) |

A click elsewhere, Escape or scrolling closes it.

**A book you have finished says Play again.** Reaching the end of the last track,
or ticking *Listened*, turns that book's button from *Resume* into **▶ Play
again**, and pressing it starts at the first track — resuming a finished book
would have played its last seconds and stopped. It counts as finished within the
last tenth of the closing track, so stopping a few seconds before the very end
still counts. A book loaded in the player keeps *Pause* and *Resume*: that is what
its button is for while it is playing.

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
emptying it moves the book back up. The folder keeps its own name. **Book number in
the series**, under it, is what orders the shelf — the number a card shows as
*book 3* — and it goes into the tags with the series name; leave it empty when
there is none. Every field has a **⧉** button beside it that puts what is in it on
the clipboard — a title to paste into a shop, a description to paste somewhere
else — and it works over plain http, where the browser's own clipboard API is not
available. The line at the foot of that dialog is the folder the book sits in and
how many files it holds, for when two books share a title.

**A cover is the one thing you cannot type**, so under the description there is a
box for it. Right-click a picture anywhere — a shop page, a wiki, wherever the
art actually is — choose *Copy image*, and press **Ctrl+V** in that dialog: it
does not matter which field has the cursor, a clipboard with a picture on it
means the picture. You can also drop a file on the box or pick one. JPEG and PNG
only, since those are the two an MP3 tag can carry; anything else says so rather
than quietly failing later. The new art shows straight away, but nothing is
changed until you press **Save** — cancel and the book keeps the cover it had.
*Save + write into MP3s* puts the picture into the files as well, so it travels
with them.

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
| files a scan could not read | put there by a **scan**, not by this check: the file it tripped over is named, with what the reader said about it |

A book whose files the scan cannot read used to arrive quietly, with a length of
nothing and no tags — the commonest cause being an ID3 tag written onto an `.ogg`
by a tagger meant for MP3, which also stops it converting until 2.3.40. Such a
book now lands on this list by itself, and the scan says how many files there were
in the line it leaves behind.

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

### The page turns with them

The two glows behind the app move with the same day and the same 37°, so on any
given day the whole thing stands in one colour: the page you open in the morning
is not the page you left. It keeps the distance between its two glows, so it is
still this app whatever day it is, and after a year it is back where it began. A
page left open overnight — on a tablet in the kitchen — turns when the day does.

**The progress bar is lit by the same two.** Every bar that runs while the app is
working on your books — a scan, a tag write, a conversion, an import, the disk
check, a lookup — fills from the colour of the glow on the **left** of the page
into the colour of the glow on the **right**, at full strength rather than the
faint wash behind the panels. It is the same pair, so a bar never sits in
yesterday's colours against today's page, and a bar that happens to be running at
midnight turns with everything else.

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

## Music Assistant

Music Assistant can read this collection and play it: the books, their series,
their chapters, and where you got to in each — including the place syncing back,
so a book you carried on with on a speaker is where you left it here.

### Connecting it, step by step

1. **This app on 2.5.0 or newer.** Playing does not work on older builds.
2. **Put a password of your choosing in `MA_TOKEN`** on the container — on
   Unraid it is *Music Assistant token* in the template, possibly behind *Show
   more settings*. Leave it empty and none of this exists at all.
3. **Look at the name you listen under** in this app's header. That exact
   spelling is what you type next.
4. In Music Assistant: **Settings → Music Providers → Add → Audiobookshelf**,
   and fill in:

   | Field | What to put |
   | --- | --- |
   | Server URL | the address of this app, e.g. `http://192.168.1.10:8523` — the one you open in a browser, no trailing path. Not `localhost`: Music Assistant runs in its own container |
   | Username | your listener name here, exactly as in step 3 |
   | Password | the `MA_TOKEN` you set |

5. **Save.** The books appear under *Audiobooks*; a large collection takes a
   moment, since they come in pages of thirty.

You do **not** need Audiobookshelf installed — nothing of it is involved.

**The username is the part people get wrong.** It is not an account, it is which
listener the places belong to. Use the name you use in the app, or Music
Assistant keeps its position under somebody else. A name it logs in with that
this app has not seen becomes a new listener, the same as typing one into the
page — so a second name appearing in the app's list is the sign you mistyped it.

The folders Music Assistant shows inside the library — *Audiobooks*, *Series*,
*Authors*, *Narrators*, Collections, Playlists — are its own layout, not this
app's. Collections and Playlists are empty here, on purpose: this app groups by
folder and by series and has neither.

**Why it says Audiobookshelf.** Music Assistant has no supported way to load a
provider written by anyone else — its maintainers were asked and said no, and the
one community workaround patches MA while it runs, which is not a thing to put
under your house. It *does* have a provider for Audiobookshelf, which is the same
shape of thing this app is. So this app answers as one, and Music Assistant needs
no changes and no extra parts.

Three honest limits. It is an imitation of another product's API, so an update to
either side can break it — if Music Assistant stops connecting after an update,
that is the first place to look. A change you make here reaches Music
Assistant on its next sync rather than the instant you make it: the live channel
between them is open, because Music Assistant will not start without one, but
this app sends nothing down it yet. And **this app's own page does not refresh
itself**: listen in Music Assistant with the page open and the time under the
book stands still until you reload it. The position is kept — it is only the
drawing that waits.

**When it will not work**, the useful evidence is the red toast in Music
Assistant's corner and the breadcrumb above it, not the log: both solved real
problems here. A *NotFoundError* means an address this app does not answer, and
the breadcrumb says which folder you were opening. A named field — *Field
"device_info" … is missing* — is the kindest failure of all, since it says
exactly what was left out. The wiki page has a table of the ones seen so far.

**Leave `MA_TOKEN` empty and none of this exists**: every address it would use
answers "not found", so an install that does not want this grows no new surface.

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

### If the sensors disappear from Home Assistant

They are states written straight into Home Assistant, and **HA empties those when
it restarts** — so the repeat on the *Send to Home Assistant* interval is what
keeps them there. Two things follow:

* With the interval set to **only when I press Send**, nothing comes back on its
  own: after a restart of either side the sensors stay gone until you press
  **Send now**. The page says so under the setting.
* With an interval set, they come back by themselves — within fifteen seconds of
  the app starting, and then every interval, whether or not anybody has the app
  open. The app writes down the address it is reached at so a media player still
  gets URLs that work after a restart; `BASE_URL` settles it outright behind a
  reverse proxy.

If they are still missing, the Home Assistant page names the reason under the
interval: a refused token and an address with a dashboard path on the end are the
two usual ones.

## Google Books API key

Google Cloud Console → *APIs & Services* → enable **Books API** → *Credentials* →
*Create credentials* → *API key*. It goes on the container, as `GOOGLE_API_KEY`
(the Unraid template has a masked field for it), and nowhere else.

**Find metadata** on a book opens the dialog with the search it would make — the
title and author as your folders name them — and **waits**. Read it, correct it,
and press Search (or Enter). A folder name is often nearly right and rarely exactly
right, so the search you would have thrown away is the one you edit instead. A result that credits more than one author offers the
pair as a choice: both names, or either one — what you pick goes into the artist
and album artist tags, and the author folder keeps its name. A result that comes
with categories offers them as genres next to the one the book is filed under
now; since a genre is a folder, picking another one moves the book there —
creating and registering the folder if it is new — and writes that genre into the
tags.

**A lookup is one request.** The search itself, and that is all: the series is
read from what the answer already carries. Where a result names none, the line
under it says so and *Look harder for the series* asks Google about that edition,
its ebook and its other records — a handful of requests, spent only when you ask
for them. That matters twice over: a free key allows a thousand requests a day,
and some keys are refused most of the time, where asking eight times for one book
means never getting an answer at all.

**"Google Books is busy" that never passes.** Those are Google's own words for
two different things: it is busy, or it will not serve your key. The app tells them
apart by asking the same question once more without the key — if that is answered,
the refusal follows the key and the message says so. What to check then, in the
Cloud Console for the project the key belongs to: **Books API** enabled, the key not
restricted to other APIs, and its daily quota not zero. A key from a project with
no verified billing is answered this way.

**When Google says it is busy.** A lookup is not one request: the search, a probe
per result, the series name, sometimes the ebook catalogue and a wider search —
and sending those in a burst is what earns a *503 busy* in the first place. They
go out one at a time, 150 ms apart. A 503 or a 429 is waited out for as long as
Google's own `Retry-After` header says, or 1 and 3 seconds for a probe and 10, 20
and 30 for the search when it says nothing; a header asking for more than a minute
is treated as a refusal, so the dialog tells you instead of hanging. Answers are
kept for five minutes, so looking the same book up again costs one search, and
every book of a series shares one lookup of that series' name.

**Use metadata** saves nothing by itself: it opens *Edit metadata* with the result
you chose already in the fields — title, author, series, the number in that series,
narrator, year, description — so you read what Google offered, correct what is wrong
and save it yourself. The cover comes along behind them and is saved with it.
Because that dialog's **Series** field is a folder, saving a series taken from
Google files the book under it. Where a result is silent, the book keeps what it
has: no series, or a series you unticked, leaves the book filed where it is, and no
volume number — which is most of them, Google names one for very few books — leaves
the number the book already had. *Use + write into
MP3s* beside it is the short way: it applies the result and writes the tags in one
go, without the dialog.

### When the lookup cannot reach Google

The dialog says which failure it was, because each is put right somewhere else:

| What it says | Where to look |
| --- | --- |
| cannot look up www.googleapis.com (ENOTFOUND / EAI_AGAIN) — no working DNS | the container has no resolver it can reach. A container inherits one from the host, so read `/etc/resolv.conf` on the server first — see **Tailscale and DNS** below, which is the commonest cause. On a **custom network** (br0) a container needs a DNS server of its own |
| no answer within fifteen seconds | the name resolves and nothing answers: outbound HTTPS is being dropped between the container and the internet |
| refused or dropped (ECONNREFUSED, ENETUNREACH…) | something is blocking outbound HTTPS |
| the secure connection could not be made (CERT_…) | a proxy or filter is intercepting HTTPS and its certificate is not trusted in the container |
| Google rejected the key, refused it, or has no Books API enabled | the key itself: see above |

To see it from the server rather than the page:

    docker exec my-audiobook-collection node -e "fetch('https://www.googleapis.com/books/v1/volumes?q=test').then(r=>console.log('HTTP',r.status)).catch(e=>console.log(e.cause?.code||e.message))"

A code comes back for a network problem, and `HTTP 200` or `HTTP 400` when the
connection itself is fine — a 400 there means the key, not the network.

### Tailscale and DNS

If lookups used to work and stopped, and the code is `EAI_AGAIN`, this is almost
certainly it. Start in the container:

    docker exec my-audiobook-collection cat /etc/resolv.conf

    # Generated by Docker Engine.
    nameserver 100.100.100.100
    search your-tailnet.ts.net
    # Based on host file: '/etc/resolv.conf' (legacy)
    # Overrides: []

`100.100.100.100` is Tailscale's own MagicDNS. Read the last two lines: **Overrides:
[]** means nothing was set on this container, and **Based on host file** means Docker
copied this from the server. So it is the **host** that has accepted Tailscale's DNS,
and every container on the machine inherits that address — which a container cannot
reach, because MagicDNS answers only on the host's Tailscale interface. Every name
fails, while the server itself resolves perfectly.

Put it right once, on the host:

    tailscale set --accept-dns=false

It is kept in tailscaled's own preferences, so it survives a reboot. The host goes
back to the resolvers it is configured with, every container inherits a working one,
and nothing has to be set per container. The price is that the host no longer
resolves `*.ts.net` names itself; tailnet machines stay reachable on their `100.x`
addresses, and Tailscale Serve to a container is unaffected.

Two things that look like the fix and are not:

* **Tailscale Extra Parameters** (or *Use Tailscale DNS*) on the container. Those
  are for a Tailscale running *inside* the container, and `Overrides: []` above
  shows that is not what wrote this resolver.
* **Override DNS servers** in the Tailscale admin console. That decides which
  nameservers MagicDNS hands your clients — not whether a container can reach
  MagicDNS at all.

If you would rather leave the host alone, give the container its own resolver
instead: `--dns=1.1.1.1` in the container's **Extra Parameters** (the Docker field,
under Advanced View). That fixes this container and no others.

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
answer from — **Settings → Which Google Books catalogue answers**, which starts at
what `GOOGLE_COUNTRY` on the container says and `US` if it says nothing. Left to
guess from your server's address, Google can hand back a record with no series data
on it; asked for a catalogue that does not match where your server stands, it
answers often enough with *service temporarily unavailable*. If lookups keep
saying Google is busy, that setting is the first thing to try: your own country, or
*let Google decide*, which leaves the parameter off the requests altogether.

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

*Use metadata* puts it in the **Series** field of *Edit metadata*, so saving there
files the book under that series; *Use + write into MP3s* names the series in the
book and in the tags and **does not move the book**. Writing
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

### Putting one of them right from the page

Behind each folder that can be filed — one too deep, audio loose in a genre or
author folder, or a copy set aside by an import — there is a **File this book…**
button. It opens a dialog with the genre, author, series and title already filled
in from the folders it sits in and from the tags of its first file, and it says how
many audio files it found and where they would go.

Pressing **File it** moves that audio into `genre / author / series / title`, adds
the book to the library at once, and — unless you untick it — writes those same
words into the files, so the next scan reads the same thing and the book stays
where you put it. Files from more than one sub-folder are put together in order
with the sub-folder's name in front of each, so a boxed set does not lose its
discs. A book that is already in the right folder and only too deep is flattened
where it is.

It refuses, and moves nothing, when the folder has gone, has no audio in it, or
when there is already a book where you are sending it.

The list is what the **last** scan found, kept in memory, so it is empty until you
scan and after a restart.

## When a book will not leave *Needs tags*

A book counts as done when its **files** carry all of album, title, artist, album
artist, genre, year, description, cover art and track number. Open **Needs tags**
and read a row: it says what a write can add now, and what is *not known yet*.

The list browses the way the genres do. The authors of the books that need tags
are in the middle column with a count each, and picking one leaves that author's
books in the pane — with *Write into N book(s)* counting what is on screen, so a
collection can be worked through one author at a time. The list is drawn again
after every write, and comes back to the author you were on.

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
