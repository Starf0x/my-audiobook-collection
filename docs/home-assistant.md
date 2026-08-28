# Home Assistant

**Nothing to configure in Home Assistant. No YAML, no custom component, no
restart.** The app talks to Home Assistant, not the other way round: give it the
address of your HA and one long-lived access token made in it, and it writes its
own sensors into HA and plays books on HA's media players.

Everything is on the app's own page: **Settings ▾ → Home Assistant**, or go
straight to `http://<your-server>:8523/ha`.

![The Home Assistant page](https://raw.githubusercontent.com/Starf0x/my-audiobook-collection/main/docs/ha-page.png)

## 1 · The connection

**The address** is the one you open Home Assistant at — `http://192.168.2.200:8123`
— with no dashboard path after it. The app tells you the mistake if you paste a
dashboard URL.

**The token** is made in Home Assistant, not here:

1. Home Assistant → your own profile (bottom left) → **Security**
2. **Long-lived access tokens** → **Create token**, give it a name like *Audiobooks*
3. Copy it — HA shows it once — and paste it into the token field on this page

*Save*, then **Test the connection**. It answers with which Home Assistant replied
and its version, or with what is wrong: a refused token, an address with a
dashboard path on it, an address nothing answers at.

The token is kept in the app's database (`library.db`, in the folder mounted at
`/data`). It is never shown again and never sent back to a browser — the page is
only told whether one is there. **Forget the token** removes it. A token pasted
anywhere it can be read by others should be deleted in Home Assistant and made
again.

## 2 · What it publishes

Six sensors, written straight into Home Assistant's state machine, so they appear
the moment the first send lands:

| Entity | State | Also carries |
| --- | --- | --- |
| `sensor.audiobooks` | how many books | files, listener, listeners, hours total/listened/left, books marked listened, and the **new books** |
| `sensor.audiobook_files` | how many files | |
| `sensor.audiobook_hours` | hours in the collection | |
| `sensor.audiobook_hours_listened` | hours listened | hours left |
| `sensor.audiobook_hours_left` | hours left | |
| `sensor.audiobook_next_up` | the title to carry on with | the book id, track of how many, seconds in, per cent, hours left, its playlist — and the whole **queue** |

*Whose progress to report* picks the listener; with one listener it is that one.
*Send to Home Assistant* sets how often — Home Assistant **forgets** states written
this way when it restarts, so a repeat every 15 minutes keeps them there. **Show
what will be sent** lists exactly what would go, without sending it.

Hours listened count a book marked *Listened* whole, and a book in progress as the
tracks already behind the listener plus the seconds into the one they are on.

On a dashboard, no templates needed:

```yaml
type: entities
title: Audiobooks
entities:
  - sensor.audiobooks
  - sensor.audiobook_hours
  - sensor.audiobook_hours_listened
  - sensor.audiobook_next_up
```

## 3 · Play a book on a media player

The page lists the media players Home Assistant knows, by the names you gave them.
Pick one, and press **Play here** beside a book: the app asks that player for the
book's playlist starting at the track you are on, waits three seconds, then asks it
to skip to the second you stopped at. A player that cannot seek still plays — from
the start of that track.

Two things worth knowing:

* **the player fetches the audio itself**, so it has to be able to reach this app.
  Behind a reverse proxy, set `BASE_URL` on the container to the address other
  machines use; the URLs handed to players are built from it;
* **positions do not come back from a player.** The app knows what the listening
  page told it, so a book played on a speaker and then carried on in the browser
  starts where the browser last was.

To play a book from an automation, call the app rather than the player:

```yaml
action:
  - service: rest_command.continue_audiobook
```

```yaml
rest_command:
  continue_audiobook:
    url: http://192.168.2.200:8523/api/ha/play
    method: POST
    content_type: application/json
    payload: '{"player": "media_player.kitchen"}'
```

With no `bookId`, that plays the first unfinished book of the queue from where it
stopped. That address takes an admin session **or** the container's `HA_TOKEN` — set
one and add `?token=…` to the URL above, which is what an automation should use.

## Polling instead, if you prefer

The app still answers if you would rather have HA ask. `GET /api/ha` is the whole
state as JSON, `GET /api/ha/book/<id>.m3u?from=<track>` is a book as a playlist,
and `GET /api/ha/continue.m3u` is whichever book is being listened to, from where
it stopped — with `X-Audiobook-Id` and `X-Audiobook-Seek` headers. Set `HA_TOKEN`
on the container to make those addresses ask for a token of their own (`?token=…`
or a Bearer header). The audio at `/api/stream/…` stays open either way, or no
speaker could play it.
