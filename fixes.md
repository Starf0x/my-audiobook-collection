# Fixes, and the mistakes behind them

Every entry here is something that was actually wrong — in the app or in the way it
was built and tested — with what it cost and what to do instead. It is written to
be read before making the same kind of change again.

`docs/SPEC.md` §9 holds the invariants: the short rules that must stay true.
This file is longer and blunter: it says what went wrong.

The lessons that are not about this app in particular — paths, shells, how the
suites are run — are at the foot, and live in my cross-project notes, which every
project shares.

---

## In the app

### A place kept in a book outlived the book (2.1.72)

A scan drops a book whose folder has gone: it deleted the rows in `books` and
`tracks` but left the one in `progress`. Two consequences, both visible: the status
line went on counting a book that was not there, and — because SQLite hands out
rowids again — the next book added could be given that place, arriving already
ticked off and halfway through a track.

**Fixed** by a trigger on `books`, the way the `broken` table always had one, plus
a one-time sweep of rows already orphaned.

**Rule:** every table keyed by `book_id` needs deleting with the book. Look for a
trigger, not for a delete in one code path — there are three paths that delete a
book (trash, validate, scan) and only two of them remembered.

### A cancelled download never let go (2.1.72)

`write` on a dead response returns `false` and no `drain` ever arrives, so a wait
on `drain` alone never ends: the request, the open file and its listeners all
stayed. Worse, every backpressured write added an `error` listener that was never
taken off — thousands over one book, which Node reports as a leak warning.

**Fixed** by waiting on `drain`, `error` and `close` together, settling once, and
removing all three.

**Rule:** a promise around a stream event must have every way out, and must take
its listeners off again. If a wait has one resolve path, ask what happens when the
other side disappears.

### An error after the headers were out ended the process (2.1.72)

The error wrapper answers a failure with `res.status(400).json(...)`. Once the
answer has started that throws — inside a `.catch`, which makes it an unhandled
rejection, and Node ends the process on those. A share that dropped mid-download
could take the app down.

**Fixed** by checking `res.headersSent` first and dropping the connection instead.

**Rule:** an error handler shared by every route has to cope with routes that
stream. Ask what it does when the response is half sent.

### The tap that ends a long press started the book (2.1.72)

On a phone, holding a cover opens its menu. Lifting the finger sends a `click` to
whatever was held: the menu closed again and the book underneath started playing.

**Fixed** by swallowing that one click in a capturing listener.

**Rule:** a long press is followed by a click. Anything opened by a hold must
absorb the click that ends it.

### An id beat the phone's dialog rule (2.1.80)

Every dialog is a full-screen sheet on a phone, said once as `dialog { … }` inside
the phone media query. Sizing Settings to match the Home Assistant page — as
`#settings` — quietly took that away from Settings alone, because an id beats an
element selector wherever it stands, media query or not.

**Fixed** by repeating the sheet rule for `#settings` inside the phone block.

**Rule:** when a general rule is written for an element and a specific rule for an
id, the id wins everywhere. Check the narrow screen after any id-level sizing.

### A book that was only too deep could not be filed (2.0.56)

Filing a walked-past folder refused when the destination equalled the source — but
for the commonest case, `…/Book/Disc A/01.mp3`, the destination *is* the source:
the fix is to flatten it there.

**Fixed** by letting that case through and refusing only when there is nothing in
sub-folders to flatten.

**Rule:** a guard against "you are sending it where it already is" has to allow
the case where staying put is the whole operation.

### The dialog said where a book would go without an author (2.0.56)

"It goes to Fantasy / … / Title" appeared with the author box empty, because the
check counted three non-empty parts rather than asking for the three that matter.

**Rule:** validate the fields you need by name, never by counting.

### A tag overrode what the folders said (2.0.64)

When filing a walked-past folder, the album tag of the first file replaced the
title taken from the folder names. A file copied in from elsewhere brings its own
album, so a book called `Book One` was offered as `The Final Empire`.

**Fixed** by letting the folders decide and the tags fill only what is empty.

**Rule:** the folder tree is what the owner sees in the list; tags are a hint.

### A finished book offered Resume, and resuming played its last seconds (2.1.16)

**Fixed** by sending `finished` with every book and reading it in three places
(tile, card, player).

**Rule:** decide a thing like "finished" once, on the server, and send it. It was
tempting to work it out in the two page scripts; they would have drifted.

Two follow-ups this cost:

* The first version used a flat minute of grace at the end of the last track,
  which calls the whole of a short track its end. It is a tenth of the track,
  capped at a minute.
* `playBook` returned early when the book asked for was already in the player, so
  a book that had *run out* was never reloaded: it replayed from the start but
  kept its Listened tick and its place at the end. The early return now stands
  aside when `audio.ended`.

### Home Assistant lost its sensors on a restart (2.1.0)

The sensors are states written over HA's REST API, and HA empties those when it
restarts, so the repeat on the timer is what keeps them there. That repeat did
nothing until a browser had visited: it needs the address the app is reached at, to
put URLs in the sensors a media player can fetch, and it waited for a real request
to learn one. An updated container plus a restarted HA left no sensors at all.

**Fixed** by writing that address down beside the other HA settings and pushing
fifteen seconds after starting.

**Rule:** background work that needs something a request happens to carry must
remember it, not wait for the next visitor.

---

### A progress bar counted the wrong thing (2.1.48)

The line under a tile filled by track index: track 1 of 1 is 100%. A book that is
one long file — which most bought audiobooks are — therefore showed a **full** bar
from its first minute, and read as listened to. Frank sent a picture of exactly
that: Agency, a fifth of the way in, a full yellow bar, and a Resume button under
it. The Listened section beside it was working; the bar was the thing that lied.

**Fixed** by sending how far into the book the place is, in seconds and as a
percentage — the tracks behind the listener plus the position, over the book's
length, which is the sum Home Assistant was already given — and drawing that. A
book of one track now says the time — `2h 05m of 10h 12m` — instead of
`Track 1 of 1`, which said nothing.

**Rule:** a bar must measure the thing it claims to measure. Counting tracks is
not measuring a book; check any progress display against a single-file item.

### And the same bar, in the player, measuring the file (2.8.16)

The entry above fixed the line under a *tile*. The bar under the **player** was
never touched, and it was the same mistake pointing the other way:
`audio.currentTime / audio.duration` is the file that happens to be playing, so
on a book of many files it filled up and started again at every track, and the
numbers beside it counted the same way. Frank sent a picture of a book two
minutes in reading *"0:40 of 3:11"*.

**Fixed** by summing the track lengths that already came with the book — those
before this track are where it starts — and, because the bar is now a place in
the *book*, by walking the tracks when it is dragged so the seek can land in
another file. It falls back to the file for a book of one file, and for any book
with a track whose length the scan never read: one missing length makes the
total a lie, and the file is then the only thing still certainly true.

**Rule:** when a bar is fixed in one place, ask where else the same quantity is
drawn. This app drew "how far along" in two places and only one of them was put
right, for seven minor versions. The tile and the player were showing different
answers about the same book the whole time.

And for the check: `book-bar.mjs` lifts the two functions out of `player.js` and
runs them, rather than keeping a copy of the arithmetic in the suite — a copy
agrees with itself for ever while the page does something else. It throws if
either is renamed, so the suite cannot quietly stop testing anything.

### A message asserted a cause it never checked (2.1.56)

The metadata lookup caught a failed `fetch` with `catch {}` — no binding, the
reason thrown away — and said "Could not reach Google Books. The server appears to
have no internet connection." Frank sent a picture of it. His server has internet;
what that container did not have was DNS. The message sent him looking in the
wrong place, and the app had the right answer in its hands and dropped it.

That one fetch also had **no timeout**, where `ask()` has eight seconds and every
Home Assistant call has ten. A network that drops packets left the dialog waiting
on the operating system.

**Fixed** by `unreachable(e)`, which reads `e.cause.code` and says which of the
four it is — no DNS (`ENOTFOUND`, `EAI_AGAIN`), nothing answering, refused, or an
intercepted certificate — each with where to put it right, and by giving the
request fifteen seconds.

**Rule:** never write a cause into a message the code has not established. A bare
`catch {}` throws the diagnosis away; catch the error and say what it was.

### The honest message still named the wrong fix (2.2.0)

`EAI_AGAIN` was right, and so was "it has no working DNS" — but the sentence after
it offered only one remedy: a container on a custom network needs a resolver of its
own. Frank's container is on bridge. What it had was **Tailscale built into it by
Unraid**, which takes the resolver over: `nameserver 100.100.100.100` in the
container's `resolv.conf`, and nothing answering there. The message was true and
still sent him to the wrong screen.

**Fixed** by naming that case first in the DNS branch, with the command that tells
the reader which case they are in (`cat /etc/resolv.conf`) and the setting that
undoes it, and by writing the same up in the README and the wiki.

**Rule:** a message that names a fix is making a second claim, and it can be wrong
where the diagnosis is right. Name every cause that produces that code, most likely
first, and give the reader a way to tell them apart.

### And then I explained it with a mechanism I had not checked (2.2.8)

The first version of all that said the sidecar "runs userspace networking, with no
TUN device, so 100.100.100.100 cannot be reached". It read well and it was
invented: I had never seen his container's settings. His screenshot of them showed
**Userspace Networking: Disabled**, and no *Use Tailscale DNS* pulldown at all —
this template does it with `--accept-dns=false` in **Tailscale Extra Parameters**.
Both went into the app's own error message, a README and a wiki page, published.

**Fixed** by saying only what is established — Tailscale takes the resolver over,
and the container then gets no answer — and naming the setting the screenshot
actually shows, with the older names beside it.

**Rule:** the same rule as the entry above, one level up: do not explain *why*
someone's machine behaves as it does from a mechanism nobody has looked at. Ask for
the screen, or say "check this" instead of "this is because". A tidy causal story is
the shape a guess takes when it is written down.

### And it was the host all along (2.2.16)

Third try at the same sentence. `resolv.conf` from the container settled it, and the
answer was in the two comment lines everybody skips:

    # Generated by Docker Engine.
    nameserver 100.100.100.100
    # Based on host file: '/etc/resolv.conf' (legacy)
    # Overrides: []

`Overrides: []` — nothing was given to this container; `Based on host file` — Docker
copied it from the server. So it was never the container's Tailscale: the **host**
accepted Tailscale's DNS, every container on the machine inherited `100.100.100.100`,
and no container can reach that. `tailscale set --accept-dns=false` on the host, once,
fixes the machine. Frank's "it worked before" was the clue that mattered — the app
had not changed; the host's resolver had. The two settings I had sent him to (the
container's Tailscale parameters, the tailnet's Override DNS servers) could not have
worked, and he changed both on my word.

**Rule:** the paths and comments in the evidence *are* the evidence. `resolv.conf`
says where its content came from; ask for the file before naming a cause, and read
all of it. And when something used to work, the first question is what changed on the
machine — not what is wrong with the code.

### One route sniffed the bytes and the other believed the header (2.8.48)

Pasting a cover has always decided what a picture is from its magic bytes, and
refused WebP and GIF by name with a sentence saying why. The thumbnail a Google
lookup offers went down a different path a few lines away: it read the answer's
Content-Type and named the file `.png` if that said `image/png` and `.jpg` for
everything else. `outbound.js` accepts any `image/*`, so a WebP arrived as a
`.jpg` — a name wrong in two directions at once, since `GET /api/cover/:id` ends
in `res.sendFile` and types the answer from the extension, and the tidy-up keeps
`.jpg` and `.png` and would have swept past it as neither.

**Fixed** by moving `pictureKind` out of `index.js` into `covers.js`, where the
rule about what a cover file may be already lived, and having both routes ask it.

**Rule:** when two paths produce the same kind of thing, they answer the same
question or they drift. The careful one here was written second, for the route
somebody was looking at; the older one a few lines away kept its guess, and
nothing pointed at the difference because each looked right on its own.

### Move… was dead on any install that had never imported (2.9.8)

The dialog asked `GET /api/import` for the list of genres. That route walks the
import folder and throws when there is none set — *"No import folder set yet"* —
or when there is one and the share it names is not mounted. Moving a book has
nothing to do with importing; it wanted a dropdown.

`moveBook` is an inline `onclick`, so the throw became an unhandled rejection in
the console and nothing else. **The button did nothing.** No message, no dialog,
no sign that anything had been tried — on every install that had never set an
import folder, and on any install whose import share was offline that minute.

**Fixed** by asking `/api/genrefolders`, which reads the libraries setting and
touches no import folder, and by catching that too: the genre the book already
has is put in the list either way, so the dialog opens and a move within a genre
works even if that call fails as well.

**Rule:** a feature must not depend on a route that answers for something else.
This one wanted *the genres*, and reached for an endpoint whose job is *the
import folder* because the list happened to be in the reply. When the endpoint
failed for its own reasons, a feature with no connection to it died.

And: an inline `onclick` that calls an `async` function swallows everything it
throws. Any handler wired that way either cannot fail or has to catch and say so
— otherwise the whole of the evidence is a line in a console nobody has open.

### The book number was dropped for every book in a part (2.9.32)

2.9.0 taught the app to read `Auteur / Serie / Onderdeel / Boek`. Two days of
work later, Frank typed a book number into *Edit metadata* on one of those books,
saved, and nothing happened — no error, no number.

`/api/books/:id` tells that dialog which series folder a book sits in, and it
worked it out as *the second folder from the top*: `rel[1]`. At
`author / series / book` that is the folder the book is in; at
`author / series / part / book` it is the series **above** the part. So the
dialog's Series field said "The Great Cycle" while the book's series was "First
Movement" — and `applyMetadata` only writes a number when that field still names
the series the book is in, a guard that exists so a number from one series cannot
reorder a book in another. The two disagreed for every book in a part, and the
number went quietly in the bin.

**Fixed** by asking for the folder the book is *in* — the last one above it,
`rel[rel.length - 2]` — which is the same answer as before for every book that is
not in a part.

**Rule:** when a layout gains a level, every line that counts folders from one
end is a line that now counts to the wrong place. `rel[1]` was right only while
there was exactly one folder between the author and the book. Count from the
thing you mean — the book — not from the top of the tree.

### A narrator that was really the author (2.2.32)

The scan read the narrator as `composer || artist`. In an audiobook the artist *is*
the author, so every file without a composer frame arrived with the author's name
as its narrator: on the card, in *Edit metadata*, and — because a tag write puts the
narrator in the composer frame — written into the files, where the next scan read it
back as fact. Frank sent a picture of *Dragon Wing*: `Narrator: Margaret Weis`.

**Fixed** by reading the composer frame and nothing else, plus a startup sweep for
the ones that can be *known* to have come from the fallback: narrator equal to the
author, and no narrator tag in the files. Where the file itself names the author as
narrator it stands, because some authors do read their own books.

**Rule:** a fallback between two tags is a claim that they mean the same thing. Ask
what the second tag holds in this kind of file before falling back to it — and
remember that a wrong value the app then writes into the files stops being a
guess and becomes data.

### The number the card showed and the dialog could not set (2.2.32)

A card says `Series · The Death Gate Cycle · book 1`. *Edit metadata* had a Series
field and no number, so `series_no` could only ever be set by a Google lookup: a
number Google had wrong could not be corrected, and a series that came from the
folders could not be ordered at all. Frank pointed at both, one arrow each.

**Fixed** with a number field, sent as `seriesNo` alongside the series so
`applyMetadata`'s guard has a series to match it against.

**Rule:** anything the interface shows about a book has to be editable somewhere.
Check every field a card displays against the dialog that is supposed to own it.

And immediately, the field took the number away again (2.2.48). Opening the dialog
from a lookup, the series *name* fell back to what the book was filed under —
`(over && over.series) || b.folderSeries || b.series` — and the number, written two
lines below it, did not: `over ? over.seriesNo : b.series_no`. Google names a volume
number for very few books, so nearly every *Use metadata* opened with an empty
number field, and Save then wrote 0 over the number the book had. Frank's picture
said it in one frame: the card reading `Arthurian Saga · book 3` beside an empty
**Book number in the series**.

**Rule:** when a value can come from two places and one of them is usually silent,
every field of that group needs the same fallback. Write them as one expression, or
check them against each other — a fallback that covers the name and not the number
is worse than none, because it looks handled.

### The tools were the owner's to supply, and that was the whole problem (2.2.72 → 2.3.0)

Converting was built with ffmpeg and ffprobe **uploaded** in Settings, to keep the
image small. Frank's first conversion failed with `spawn ENOEXEC`: the files he had
uploaded were not programs this container could run. Everything about that feature
then had to explain itself — which build, which architecture, what a `.tar.xz` is
not, whether the share is mounted `noexec` — and two bugs of its own turned up in
an afternoon (a rename that could not replace a program that had just been run, and
a version check that came back silent on a freshly written 100 MB file).

**Fixed** by putting `ffmpeg` in the image — one `apk add` in the Dockerfile, which
brings ffprobe with it and is by definition the build that image is for — and
taking the upload, its route and its Settings section back out.

**Rule:** a feature that only works if the owner supplies the right binary has
shifted the hard part onto them, and it will come back as a support question. When
a dependency can ship with the thing that needs it, ship it.

### -v quiet threw away the one line that mattered (2.3.40)

Converting one of Frank's `.ogg` books failed with **"ffprobe exited 1"**. Nothing
else — because the app ran `ffprobe -v quiet`, which silences the very line that
says what is wrong with a file. With `-v error` it read: *Invalid data found when
processing input*, and the cause turned out to be worth knowing: those files carry
a **100 kB ID3 tag in front of the Ogg stream**, written by a tagger meant for MP3.
The Ogg demuxer will not look past it, and neither will `music-metadata` — which is
why those four books had always shown a length of 0 as well.

**Fixed** by reading the tag's own length out of its header and passing
`-skip_initial_bytes` before `-i` on every ffprobe and ffmpeg call (never for an
`.mp3`, where the tag belongs), and by running ffprobe with `-v error` and putting
the file's name in front of whatever it says.

**Rule:** this is the third time in this app that a silenced or swallowed reason
cost an afternoon — `catch {}` on a lookup, `-v quiet` here, and `catch {}` in the
scan, which still has one. A flag that quietens a tool is the same mistake as a
`catch` with no binding. Quiet the *noise* (`-hide_banner`), never the diagnosis.

### The scan's own silence, and why a catch was never going to catch it (2.3.48)

`try { tags = await parseFile(file); } catch { /* unreadable file */ }`. Four `.ogg`
books sat in the library with a length of 0 and no tags for weeks, and nothing
anywhere said why — the same ID3-in-front-of-Ogg files that later failed to
convert. The fix looked like one line: bind the error and report it.

It was not, and the first test said so: **`parseFile` does not throw** on a file it
makes nothing of. It answers with an empty result. The catch had never fired; the
silence came from somewhere else entirely. A file counts as unread when the reader
reports no **container** — which is the test the disk check had been using all
along, two modules away.

**Fixed** by testing for that container, keeping whatever the reader did say, and
writing a `broken` row so the book turns up on *Broken on disk* with the file named
and the reason in words. The scan's line says how many there were — after the books
have been read, since the first version of it counted before a single one had.

**Rule:** "the reason was swallowed by a catch" is a hypothesis, not a diagnosis.
Check that the failure path is even the one being taken — a library that returns
empty instead of throwing needs a test on what came back, not a better `catch`.

And two rules for a cheap check that shares a list with an expensive one: only
clear the verdicts you wrote yourself (`WHERE reason = 'unreadable'`), and when you
have read one file of forty, you may add what that file showed and clear nothing.

### The comment named the second half of the bug and nobody read it (2.8.56)

2.3.40 taught the converter to step over an ID3 tag bolted onto an `.ogg`, and
wrote this into the code while doing it:

> …and `music-metadata` fails the same way, **which is why such a book also
> shows no length**.

That clause is a second bug, stated plainly, in the commit that fixed the first.
It stayed for two years and five minor versions. Those books kept a length of 0,
their player bar had nothing to measure, and they sat on *Broken on disk* as
"nothing in it that a reader recognises as audio" — all from the same tag the
converter had already learned to skip.

**Fixed** by giving the scan one second chance: no container and an ID3 tag in
front means read it again from past the tag. `id3Skip` moved into `id3.js`
because `convert.js` imports `scan.js` and the dependency cannot go both ways.

**Rule:** a comment that explains *another* thing that is broken is a bug report
filed where nobody will look for it. When writing one, either fix that too or put
it somewhere a person reads on purpose. And when reading code for a cause, the
sentence that says "this is also why X" is the most valuable line in the file.

The check builds the case rather than describing it — a real Ogg from ffmpeg,
then the same bytes with a tag bolted on — and run against the old code it
reproduces both halves at once: the book comes out half as long, and the file is
written down as unreadable.

### Three fixes for a fault that was never in the app (2.3.64 → 2.4.0)

"Google Books is busy", over and over. In one afternoon I changed the pacing of
the requests (a real burst, worth fixing), made the catalogue a setting (a real
improvement, worth having), and rewrote the message twice — and none of it helped,
because none of it was the cause. Six requests from his own container settled it:
**503 on every host, every country, with the key; 429 without it, and 200 from
Google's discovery service.** The refusal followed the key, not the server, and no
amount of work on this side could have moved it.

Two things went wrong in how I worked. The measurement I asked for first was never
run — I let the conversation move to building instead, and did not insist. And my
own message, *"Google Books is busy — try again in a few minutes"*, asserted a
cause the code had not established, which is the very rule three entries above
this one. It sent him hunting through his network for days.

**Fixed** by making the app establish it: on a 503 it asks the same question once
more with the key stripped out, and says which of the two it is — with what to
check in the Cloud Console when the refusal follows the key.

**Rule:** when a fault is on someone else's machine, the first move is the
measurement that names the side it is on, and nothing else happens until it is
run. "I have a good hypothesis" is not that measurement, and three good hypotheses
are not either.

### A modal dialog held a layer the password manager needed (2.7.32)

Frank got Bitwarden's *"this page may be trying to hijack your password
manager"* warning on every visit to the listening page — and, he said, it had
been happening since before there were accounts at all. Nothing in this app was
touching Bitwarden.

The browser has one **top layer**, and three things share it: a modal `<dialog>`,
anything with `[popover]`, and the inline menu an extension puts over a password
field. The last one in is the one on top. Our sign-in card was
`<dialog>.showModal()`, so it sat above Bitwarden's menu and stayed there;
Bitwarden's `autofill-inline-menu-content.service.ts` answers being covered with
`hidePopover(); showPopover();`, counts those with
`checkAndUpdateRefreshCount("topLayer")`, and at five in five seconds shows the
warning — which is the warning's actual name in their source,
`topLayerHijackWarning`. The extension was behaving correctly. So was the
browser. We were the page.

**Fixed** by making the gate an ordinary `<div id="gate" class="gate" hidden>`
with the dimmed backdrop in CSS. It needed nothing `showModal()` gives: there is
nothing behind it to reach, so there was nothing to make inert. Measured after:
`{"tag":"DIV","isDialog":false,"topLayerDialogsOpen":0}`, and signing in still
works. `accounts.mjs` now reads both pages for the gate's tag name and reads
`account.js` — with its comments stripped, or the comment explaining all this
would pass for the mistake — for a `showModal(` call. Both mutants go red.

**Rule:** `showModal()` is for something a reader must answer **and dismiss**.
Anything that stands until the app puts it away takes a shared layer hostage, and
what it displaces is somebody else's software behaving properly. And: "it did
this before your change too" is not noise — it is the sentence that rules out
everything you have been working on.

### The old dialog's width stayed behind and half-covered the screen (2.7.48)

Converting the gate from a `<dialog>` to a `<div class="gate">` in 2.7.32 left a
block of `#gate` rules in the stylesheet that had sized it as the *card* it then
was — `width: min(440px, 92vw)`. An id beats a class, so the new full-screen
backdrop was 440px wide: Frank's screenshot showed the sign-in card down in the
corner of a page that was only half dimmed.

I then made it worse before I made it better. Measuring the ask form at a small
size, I found the card taller than the window and "fixed" the centring —
`align-items: start` with auto block margins — without asking why a `position:
fixed; inset: 0` box was not filling the screen in the first place. That
addressed a real problem (centring a *scrolling* box with `place-items: center`
does put the top of an over-tall card above the scroll origin, unreachable) and
left the actual cause untouched.

**Fixed** by deleting the whole `#gate` block — every rule in it had already been
restated for `.gate-card` — and centring with `display: flex` plus `margin: auto`
on the card, which centres when there is room and gives the space up when there
is not. Measured both ways: card centre `[450,400]` in a 900×800 window, and in
a 400×380 one the card is 542 tall with its top at y=16 and the heading on
screen. `accounts.mjs` now fails if anything sizes the gate by its id.

**Rule:** when an element stops being one kind of thing, its old id rules do not
stop applying — grep the stylesheet for the id, not just the class you added.
And a box with `inset: 0` that is not the size of the screen has something
overriding it; find that before adjusting how its contents sit inside it.

### The reason nobody wrote was written by somebody after all (2.7.56 → 2.7.72)

Two account requests arrived whose reason was the sentence printed under the box
— *"No email address is asked for and none is kept."* — word for word. Nothing in
this app writes into that box, which I checked end to end on a running server.

I spent three rounds on **mechanism**: the Discord message path, then browser
autofill (I shipped `autocomplete="off"` and `writingsuggestions="false"` for
it), then a Compose-style writing assistant. The next request arrived on the
version carrying the autofill fix, with the same sentence, which should have told
me the whole class of answer was wrong. Each guess was plausible; none was
measured. It is the entry four above this one — *"Three fixes for a fault that
was never in the app"* — with the names changed.

**The answer was a person.** Frank asked them: they did not know what to write,
so they copied the line in front of them and pasted it. No extension, no
autofill, no assistant. I had built an elaborate search for a machine because the
value looked machine-made, and never proposed the cheapest measurement in the
building — *ask the person who filled in the form*. Frank had that answer
available the whole time and I never asked for it.

**What survives** is the guard that happens to fit the real cause: the server
refuses a reason that is one of the form's own strings and tells the asker it is
the page's wording and not theirs, which is exactly the nudge somebody who does
not know what to write needs. The placeholder now gives an example for the same
reason. What went back out is everything built for the invented cause — the page
emptying the box on open, and `writingsuggestions="false"`, which switched off
help a person composing prose might actually want.

**Rule:** a value that looks machine-generated is not evidence of a machine.
Before modelling software you cannot see, ask whether a person could simply have
done it — and when the input came from somebody reachable, asking them *is* the
measurement, and it is cheaper than every hypothesis you could test instead.

And: when the cause turns out to be different, take the speculative machinery
out. Code kept "because it is harmless" is a fix for a fault that never existed,
and the next person to read it will believe the fault did.

A check that goes red is not yet a check that is right, either: the mutant showed
one of these passing for the wrong reason — with the guard removed, the second
request was refused as a **name already taken**, a 400 that had nothing to do
with what was being checked. Give each case its own name and assert the message,
not the status.

### The UI suite had been unrunnable since it was committed (2.8.0)

`plays-on` starts the app itself, and it did it with `join(here, '..', '..')` —
two levels up from `tests/`, which is `…/Projects`, not this project. It had been
spawning `…/Projects/server/index.js`, which does not exist, and answering *"the
app never came up"*. The path was right where the suite used to live, one
directory deeper, and came along unchanged when `tests/` was committed in 2.6.64.
Nobody noticed because the spec calls it "run by hand", and by hand means never.
It was also building its library, database and browser profile inside `tests/`
rather than in `fixtures/`, against the rule at the foot of this file.

That was fixed in 2.8.0, and the suite then stopped at the *"who is listening?"*
dialog 2.7.0 had removed. **2.8.24 brought it up to the app as it is** — it signs
in at the gate as the administrator, carries that cookie through the scan it
drives, and clicks `#toAdmin` rather than `#adminBtn`, which on the admin page is
now the *Lock* button and would have signed it straight out again. Its readiness
probe also had to move off `/api/admin`, which is behind the account gate now and
answers 401 for ever: that reads exactly like a server that never started.

22 checks, all passing, and a mutant that empties the carried position turns
three of them red. `npm run test:ui` runs it.

Two more things it taught, both about the suite rather than the app:

* **A killed run leaves Edge holding its profile folder**, and Windows then
  refuses to delete it — so the next run dies on `EPERM`, and so does every run
  after that until somebody looks for stray processes. Reusing the folder is not
  the answer, because it carries the session and the carried book into a run
  whose very first check is that nothing is on screen. A folder that cannot be
  emptied is left alone and the run takes a clean one beside it.
* **A browser that was started and never answered must still be killed.** It was
  spawned, the debugging port never opened, the suite threw — and the process
  stayed, holding the folder for the next run to trip over.

**And then the real reason it ran nowhere.** The line above was written as "give
it a named script and remember to run it", which is a rule that depends on
somebody remembering. The actual obstacle was one hard-coded path —
`C:\Program Files (x86)\…\msedge.exe` — so the suite could not start on a build
machine whatever anybody remembered. It looks for Edge, Chrome or Chromium on
the platform it is on now, takes `PLAYS_ON_BROWSER` for one kept elsewhere, and
runs as its own job in the Checks workflow. Chromium is tried last because the
unbranded build has no MP3 decoder and this suite plays MP3s.

It then failed on the runner at the first attempt with *"the browser never opened
its debugging port"* — and that was all it could say, because the browser was
spawned with `stdio: 'ignore'`. The cause turned out to be the wait: fifteen
seconds is enough for a browser that has been started before on a desktop, and
not enough for a cold one on a build machine. Thirty seconds, and it passes —
22 checks on `ubuntu-latest`. The diagnostic that was added to find out never
got to speak, and is kept anyway: the next failure will not be this one.

**Rule:** a suite that is not run is not a suite, the same way one that is not in
the repository is not — and when it cannot run somewhere, fix *that* before
writing a rule about discipline. One absolute path kept the only coverage of
three pages off the build machine, and two major features and a refactor of both
pages went by untested while the spec called it "run by hand".

And: a timeout that was chosen on the machine it was written on is a guess about
every other machine. When something external has to start — a browser, a server,
a container — give it room, and make the failure say what the thing itself said
rather than only that the wait ran out.

**Thirty seconds was still a coin toss.** The same commit went green on `main`
and red on its tag an hour later, one job each way. The diagnostic earned itself
back at once: the browser said *"Failed to connect to the bus: Could not parse
server address"*, three times, five seconds apart. The build machine sets
`DBUS_SESSION_BUS_ADDRESS` to something Chromium cannot parse, and a headless
browser that needs no session bus spends seconds retrying it — 28 of them on the
run that passed, against a wait of 30. It is ninety seconds now, and the browser
is handed an address that fails at once instead of slowly.

**Rule:** when a wait is nearly the time the thing usually takes, it is not a
timeout, it is a coin toss — and the first flake is the measurement. Read what it
actually took on the run that *passed*, not only on the one that failed.

### The default error page handed out the server's paths (2.8.8)

A report from elsewhere said `GET /api/books` without a genre answered 500 —
"one-line fix, say the word". Reproducing it here found something worse than the
crash. `/api/books` is one of the routes not passed through `wrap`, so the
SQLite bind error fell through to **Express's own error handler, which answers
with the stack trace as an HTML page**: `file:///B:/…/My Audiobook
Collection/server/index.js:742`, the line numbers, the frames. Any *approved
listener* could read it, not only the admin — and `wrap` is on 44 of about 130
routes, so every one of the others leaked the same way.

**Fixed** with a four-argument `app.use` after every route: the reason goes to
the log, the asker gets a sentence. A refusal thrown on purpose still carries
its own words, because it has a status and was written for the reader.
`/api/books` and `/api/authors` now answer 400 saying what was missing.

**Rule:** a framework's default error page is written for the author and
delivered to the stranger. Put a handler of your own behind everything on the
day the framework goes in — not on the route that happens to throw, because the
route that happens to throw is the one you have found.

And two lessons about the checks, both from mutants that stayed green:

* The check has to reach the branch it is about. A torn request body carries its
  own 400, so it goes down the branch that passes a refusal's words through —
  the branch that *suppresses* an unexpected error was never touched, and
  replacing its message with `err.stack` passed. The unreachable branch is read
  from the source instead, and says so.
* **Restart the server before believing the measurement.** Two probes in a row
  were answered by a demo started before the edit: one said the fix had not
  worked, the other that a bug was still there after it was fixed. A running
  server is a snapshot of the code as it was when it started.

## How it is built and tested

None of these is particular to this app, so they live in my cross-project notes
and hold for every project I work on. In short, each one having cost real time
here:

* Nothing is written outside the project folder. Test libraries and data folders
  go in `fixtures/`, which `.gitignore` and `.dockerignore` both list — they were
  once being built in the root of the owner's system drive, 85 of them.
* **Quote every path.** This project's folder has a space in its name, so an
  unquoted path becomes several arguments: it cost a browser that would not start
  ("Multiple targets are not supported in headless mode") and a test runner that
  handed a suite half a path as its library.
* **No leading dot** on a folder the app must serve from: `res.sendFile` refuses
  any path with a dotfile segment, so `.fixtures` broke every playback test.
* **Never write JavaScript through a shell heredoc.** `\d`, `\s`, `\r\n`, `\\`
  and backticks are eaten. Write the file with an editor and `node --check` it.
* **And the other way round: a suite can print every check green and still leave
  with 127.** `sub-series` was the first to both scan a library — which starts
  the tag pool's worker threads — and run the server, and `process.exit()` with
  those still closing makes libuv assert on Windows
  (`!(handle->flags & UV_HANDLE_CLOSING)`). The output said "all checks passed"
  and `run-all` reported the suite failed, which reads as a lie in whichever
  direction you trust. Let the loop turn once before exiting.
* **An exit code is not a test result.** Not every suite calls `process.exit`;
  count the `ok` and `FAIL` lines it prints instead. One round of "all green" was
  reported wrongly because of this.
* **A check that cannot fail is not a check.** Run a new check against the old
  code and watch it go red before believing a fix.
* **A fixture mismatch is not an app bug.** When a suite fails on a count, a title
  or a path, rebuild the shape it was written for — `shaped-demo.mjs` holds seven.
* **Blank the browser tab between runs.** The headless browser is reused, and the
  page of the last suite goes on saving its own playback position into the next
  suite's database.
* **Normalise CRLF before patching.** `git stash` and `git checkout` convert the
  working copy here, and multi-line patches then match nothing.
* **Nonsense answers mean the port is someone else's.** 8884 on that machine is a
  Dell service, and a suite pointed there got its JSON.
* **When a rule changes, update the suites that encoded the old one deliberately.**
  Ticking is what "listened" means, and only unticking or playing a book again
  takes it off — a position reported by Home Assistant does not. An older suite
  assumed the opposite; the check now says the rule out loud.
* **A fixture book must outlast the check's own waiting.** Two tracks of three and
  two seconds ran out while a check watched the hand-over between pages, and the
  player rightly putting itself away read as the hand-over being broken. The demo
  book's tracks are a minute and ten seconds for that reason.
* **A listing this app serves must end.** Music Assistant pages the Audiobookshelf
  answers with a loop that stops only on an empty page; the series listing ignored
  page and answered with everything each time, so that folder never opened and
  nothing logged a reason.
* **The wiki is a second repository**, cloned into `fixtures\wiki`. It commits
  under its own identity, which has to be set on the clone, and the project's
  `git status` will never mention that its pages are still uncommitted.
* **Two runs cannot share a moving tag.** The publish workflow ran on `main` and
  on `v*`, and `metadata-action` counts a tag as the default branch, so a release
  fired twice and both runs pushed `:latest`. The images were the same source but
  not the same digest — v2.5.64 built `29a69492…` and `e896a8ed…` — and the tag
  went to whichever finished last, three seconds apart. It runs on tags only now.
* **And two releases pushed together race each other the same way.** Fixing the
  above left one run per release, which is not the same as one run at a time:
  `git push origin v2.7.32 v2.7.40` started both, and the **older** one finished
  sixteen seconds later and took `:latest` with it. Anybody pulling `:latest`
  would have got 2.7.32 while 2.7.40 was the release. Two guards now, because
  serialising alone still leaves the order to chance: a `concurrency` group so
  the runs queue, and `:latest` applied only by the run whose tag is the highest
  in the repository — `git tag --sort=-v:refname | head -1`, which is true
  whatever order they finish in. Sort by `-v:refname`, never alphabetically, or
  `v2.7.8` outranks `v2.7.32`.
* **`body.maintenance` hides the authors column.** It is there so the maintenance
  lists can have that space, so a maintenance view that browses *by author* must
  not set it — *Books you've listened to* already clears it for that reason.
  *Series to complete* set it, and its authors column was built, filled and never
  visible above 720px: a whole feature, invisible for two versions.
* **`innerText` answers for a hidden element.** Checking the column by reading
  `#authors ul` in the console said it was fine while the screen showed nothing.
  For "is it on screen", ask `getBoundingClientRect().width` or the computed
  `display`, or look at a screenshot.
* **A remembered question needs its answer beside it.** The Wikidata run wrote
  only its timestamp to the settings table, so a restart left the pane saying
  "last asked 16:13" with nothing under it — minutes of somebody's free service
  thrown away, and the surviving half made it look as though nothing had been
  lost. Whatever writes the date writes the rows.
* **And Favourites shipped with no authors column at all.** Same rule, third
  time: the handler did `$('#authors ul').innerHTML = ''` and never filled it,
  while clearing `body.maintenance` so the column stayed *visible* — an AUTHORS
  heading over nothing, beside a shelf of books that plainly had authors. The
  view had been written from the books outward, and the column beside it was
  never asked about. When adding a view to that page, copy the view next to it
  whole: *Listened* had the column, the counts and the click-to-narrow already.
* **A view and the column beside it are one view.** The Wikidata poll redrew the
  pane and not the authors column, so Wikidata found volumes under authors the
  column had never heard of. Draw both from one pair of answers, and keep the
  chosen row across redraws or a per-second refresh throws the reader out of it.
* **A drawn cover is cached until midnight.** `/api/cover/:id` answers with a
  drawn SVG when a book has no art, and that answer carries a day's
  `Cache-Control` — so after a cover was pasted and saved, the edit dialog went
  on showing yesterday's drawing: cover in the database, file on disk, and the
  browser still holding the placeholder. The one dialog that exists to change the
  picture asks for it afresh, `?t=<now>`.
* **A file name can be what a proxy refuses.** Behind Zoraxy (with Cloudflare in
  front) `/listen.js` came back 403 while `/app.js`, `/player.js`, `/day.js` and
  every API route passed — so the listening page loaded its shell and died on
  `$ is not defined`. Nothing in the app: the same path answered 200 straight off
  the container. Zoraxy's own source rules out its exploit blocker (that one
  reads only the query string and answers in plain text) and its access control
  (per IP, not per path), so the culprit is still unfound; the file is `shelf.js`
  now. When one asset 404s or 403s and its neighbours do not, compare the paths
  before reading a line of application code.
* **A walk that read nothing must remove nothing.** The scan drops books it did
  not see, and `walked` was `!only || …` — true for every book on an ordinary
  scan. So an unparseable `libraries` setting (which answers `[]` by design) or a
  share that is mounted but unreadable emptied the entire books table, and the
  `progress_follows_books` trigger deleted everybody's place in every book with
  it. The files survive that; the listening history does not.
* **An admin-only write that a public route reads is a public write.**
  `books.cover` is set by `POST /api/apply/:id` (admin) and served by
  `GET /api/cover/:id` (nobody). A cover of `../../etc/passwd` crossed that gap.
  When two routes share a column, the weaker one's audience is the column's.
* **A source path the page always gets right is still a path from a request.**
  Import and filing moved whatever folder the body named, anywhere on the host.
  The admin page never sends anything else — and the page is not what arrives.
* **A lock after the first await is not a lock.** Converting set its `running`
  flag after probing every file of the book, so two requests a moment apart both
  passed the route's check, both passed the module's, and both converted the same
  book into the same folder with the same temp names.
* **`false` is not a failure until somebody counts it.** `writeTag` answers false
  for a file it cannot open. Nothing counted those, so a book whose every file
  was unwritable reported `written: 0` with no error, the run called it done, and
  `books.tagged` claimed tags the files did not carry.
* **`fetch` follows a redirect unless told not to, and a credential goes with
  it.** Three of this app's outbound calls said `redirect: 'error'` and four did
  not — including the one carrying the Home Assistant token and the three to
  Google Books, which carry the owner's API key in the query string. The hosts
  are hard-coded so nothing could aim them elsewhere, which is why this sat
  unnoticed: the reasoning was about where the request goes, not about where the
  answer can send it next. `outward.mjs` reads the source now and fails on a call
  written without it. And the endpoints were measured first — none of them
  redirects — because refusing a redirect that a service really uses would have
  broken lookups to fix nothing.
* **An address in a request is a request to this network.** The cover thumbnail
  was fetched with a bare `fetch` — no timeout, redirects followed, no ceiling,
  no check that it was even a picture. This server can reach the router, the
  other containers and `169.254.169.254`; `outbound.js` is what it goes through
  now.
* **U+2028 and U+2029 are line terminators in JavaScript source.** A regex
  literal written with them in it is a literal broken across two lines, and
  `node --check` says "missing /" about the line above. Build that class with
  `new RegExp('[\r\n\u2028\u2029]+')` instead — which is also the thing the
  regex was for: those characters end a line in an M3U too.
* **A guard in a page guards one page.** Importing, moving and deleting were kept
  one-at-a-time by `work()` in the browser. Two browsers, or a reload mid-import,
  is a second request that page never knew about — and those routes move folders.
  The lock belongs on the server; the page's is a courtesy.
* **`scryptSync` on an open route is a way to stop the server.** It is slow by
  design and it blocks the only thread there is. Hash off-thread, work the stored
  side out once, and make a wrong password cost the asker a growing wait.
* **A suite that is not in the repository is not a suite.** The spec named
  seventy-four checks and a clone had none of them: they lived in one untracked
  folder on one machine. `tests/` is committed now, `npm test` runs the portable
  ones, and a workflow runs that on every push — "not shipped" is `.dockerignore`
  and has nothing to do with "not kept".
* **A refused PUID drop that carries on as root is the bug PUID exists to stop.**
  It logged one line and went on creating root-owned folders on somebody's share.
  It stops now, unless `ALLOW_ROOT=1` says otherwise.
* **A demo left running on a suite's port answers the suite's requests.** The
  accounts demo took 8533, which `abs-contract` owns, so the suite logged in
  against a server with no `MA_TOKEN` and reported the app broken. The demos live
  at 86xx now. When a check fails in a way that makes no sense, look at who else
  is listening on that port before reading the code.
* **Inside an `app.use(path, …)` mount, `req.path` is what is left after the
  mount point.** The account gate compared `/api/account/me` against `req.path`,
  which was `/account/me`, so the four routes that exist for people without an
  account were the first thing it shut. Compare `req.baseUrl + req.path`.
* **A comment in a template literal may not hold a backtick.** The SQL schema is
  built with one, and `-- pass is scrypt of the password with \`salt\`` ended the
  literal in the middle of the table definition.
* **A shell `replace()` takes the first match, which is rarely the one you mean.**
  `await loadHook()` was meant to go beside the settings dialog opening and
  landed in the Stop button of the tag run, because that held the first
  `await showTagAll();` in the file. The line that says whether a Discord webhook
  is saved was blank, and nothing failed. Match on enough context to be
  unambiguous, or use the editor.
