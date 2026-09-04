# Fixes, and the mistakes behind them

Every entry here is something that was actually wrong — in the app or in the way it
was built and tested — with what it cost and what to do instead. It is written to
be read before making the same kind of change again.

`docs/SPEC.md` §9 holds the invariants: the short rules that must stay true.
This file is longer and blunter: it says what went wrong.

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

## In the way it is built and tested

### Fixtures were written to the root of C:

Every suite defaulted its library and data folder to `C:\<name>-demo`, and the
batch runners added `C:\qa-*`. About 85 directories, 1.75 GB, in the owner's
system drive.

**Fixed** by moving all of them into the project's own `fixtures/` folder, listed
in `.gitignore` and `.dockerignore`, and repointing all 41 scripts.

**Rule:** everything a task creates goes inside the project folder. Two traps met
on the way:

* **No leading dot on that folder.** It was `.fixtures` first, and Express's
  `res.sendFile` refuses any path with a dotfile segment, so the app could not
  serve its own audio or covers from there — every playback suite failed at once.
* **The project path has spaces**, so a browser started with `--user-data-dir=…`
  needs the value quoted, or Chromium reads the rest as a second window and exits
  with "Multiple targets are not supported in headless mode".

### A shell heredoc eats what JavaScript needs

Writing a script through `cat > file <<'EOF'` mangles `\d`, `\s`, `\r\n`, `\\` and
backticks. It has cost an hour at a time, repeatedly: a `\d` that became `d`, a
`'\\data'` that became a relative `data`, a `replaceAll('\r\n', …)` that became a
real newline.

**Rule:** anything containing an escape, a backtick or a template literal is
written with the Write or Edit tool, never through a shell heredoc. Run
`node --check` on it afterwards.

### An exit code is not a test result

The batch runner reported "ok" for suites that print failing checks and still exit
0 — not every suite ends with `process.exit(failed ? 1 : 0)`. A whole round of
"all green" was wrong because of it.

**Rule:** judge a suite by its own output (`^ok` and `^FAIL` lines), not by its
exit code.

### The browser keeps the page of the last run

The headless browser is reused between runs, and its tab still holds the page of
the previous suite. When the next suite starts a server on the same port, that old
page goes on saving its own playback position into the fresh database — which
overwrote fixtures and produced failures that looked like app bugs.

**Rule:** navigate the tab to `about:blank` before setting up state, and again
between rounds inside a suite.

### git hands files back with CRLF

`git stash`/`checkout` converts the working copy to CRLF here, after which every
multi-line search-and-replace against `\n` fails to match.

**Rule:** a patch script reads the file, normalises `\r\n` to `\n`, patches, and
writes back in whatever the file had.

### A port can already belong to something else

Port 8884 on this machine is Dell SupportAssist. A suite pointed there got JSON
answers that were not the app's at all, and the failures made no sense.

**Rule:** when a suite's answers are nonsense rather than wrong, check what is
listening on its port before reading the code.

### A fixture mismatch is not an app bug

Five suites failed after their demo library had been rebuilt in another shape:
they were written against a library with tagged files, a second series, an empty
library, or a path of `\audiobooks`. Reading the app for the cause wasted the time.

**Rule:** when a suite fails on data rather than behaviour — a count, a title, a
path — rebuild the fixture it was written for first. `shaped-demo.mjs` holds the
seven shapes.

### A check that cannot fail is not a check

`check('and the server was told', d.continue.length >= 0 && true, true)` passed
whatever happened.

**Rule:** every check must be able to fail. Write the assertion, then break the
code on purpose and watch it go red — several fixes in this file were only proven
that way.

### An unquoted path with a space in it writes somewhere else entirely

The batch runner built its arguments as one string:

```bash
args="http://localhost:$port"
args="$args $root/audiobooks"
node "$s.mjs" $args          # unquoted: three arguments, not two
```

The project folder is `My Audiobook Collection`, so the suite received
`B:/_ClaudeCode/Projects/My` as its library path, built its fixture there, and
found nothing to scan. Two suites failed for a reason that had nothing to do with
them, and an empty `B:\_ClaudeCode\Projects\My` was left behind — outside the
project, the very thing that had just been put right.

**Fixed** by building the arguments as an array and passing `"${args[@]}"` in all
four runners.

**Rule:** every path handed to anything is quoted, and built as an array when
there is more than one. This is the same trap as the browser's `--user-data-dir`
above: on this machine the project path always has a space in it, so an unquoted
path is never right.

### A book on the Listened list stays there when something outside moves its place

Ticking is what "listened" means, and it is only taken off by unticking or by
playing the book again — not by a position reported from Home Assistant or another
player. An older suite assumed a raw `POST /api/progress` in the middle of a book
would take it off the list.

**Rule:** when a rule changes, the suites that encoded the old one have to be read
and updated deliberately, not "fixed" until they pass. Say in the check what the
new rule is.
