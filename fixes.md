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
