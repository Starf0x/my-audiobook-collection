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
