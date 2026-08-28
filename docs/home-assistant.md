# Home Assistant

Two addresses, no custom component, nothing to install on the Home Assistant side
beyond the YAML below — which the app writes for you with your own host already
filled in:

**Settings → Home Assistant → Copy the YAML**, or fetch it directly:

```bash
curl http://<your-server>:8523/api/ha/example.yaml
```

## What the app answers with

| Address | What it is |
| --- | --- |
| `GET /api/ha` | one JSON document: the totals, the continue queue and the new books |
| `GET /api/ha/book/<id>.m3u?from=<track>` | that book as a playlist a media player can be handed |
| `GET /api/ha/continue.m3u` | whichever book is being listened to, from where it stopped |
| `GET /api/ha/example.yaml` | the configuration below, with this server's address in it |

`?user=<name>` picks whose progress is reported; with one listener in the app it
is that one. Set `HA_TOKEN` on the container to close these off — then every
request needs `?token=…` or an `Authorization: Bearer …` header. Set `BASE_URL`
when Home Assistant reaches the app on a different address than a browser does
(behind a reverse proxy, say): the URLs inside the answers are built from it.

## The JSON

```json
{
  "version": "2.0.0",
  "listeners": ["Frank", "Sam"],
  "listener": "Frank",
  "books": 1162,
  "files": 21874,
  "listened_books": 84,
  "hours": { "total": 4218.6, "listened": 512.4, "left": 3706.2 },
  "continue": [
    {
      "id": 412, "title": "A Kiss of Shadows", "author": "Laurell K. Hamilton",
      "series": "Merry Gentry", "series_no": 1,
      "track": 7, "tracks": 19, "position": 812,
      "into_hours": 2.4, "left_hours": 6.1, "percent": 28,
      "listened": false, "updated": "2026-08-28 07:14:02",
      "playlist": "http://192.168.2.200:8523/api/ha/book/412.m3u",
      "continueFrom": "http://192.168.2.200:8523/api/ha/book/412.m3u?from=6"
    }
  ],
  "new": [
    { "id": 1162, "title": "…", "author": "…", "genre": "Fantasy",
      "tracks": 24, "hours": 11.3,
      "playlist": "http://192.168.2.200:8523/api/ha/book/1162.m3u" }
  ]
}
```

`hours.listened` counts a book marked *Listened* whole, and a book in progress as
the tracks already behind the listener plus the seconds into the one they are on —
the same arithmetic for one listener as for the household.

## Continuing a book on a media player

A media player cannot be told "play book 412 from 2h24m". It can be handed a URL,
and most players take an M3U and play it through, so:

1. `media_player.play_media` with `/api/ha/continue.m3u` — the playlist starts at
   the track the listener is on, so the book carries on at worst at the beginning
   of that track;
2. `media_player.media_seek` with `position` from the JSON — the seconds into that
   track. Give the player a couple of seconds to start before seeking.

`/api/ha/continue.m3u` also answers with `X-Audiobook-Id` and `X-Audiobook-Seek`
headers, so an automation that fetches it does not have to read the JSON as well.

The app does not learn where a media player got to: positions are kept by the
listening page. Playing on a speaker and later carrying on in the browser starts
from where the browser last was.

## The YAML

What `GET /api/ha/example.yaml` hands you, with `<base>` being this server:

```yaml
rest:
  - resource: <base>/api/ha
    scan_interval: 300
    sensor:
      - name: Audiobooks
        unique_id: audiobook_books
        value_template: "{{ value_json.books }}"
        unit_of_measurement: books
        json_attributes: [hours, continue, new, listeners]
      - name: Audiobook files
        unique_id: audiobook_files
        value_template: "{{ value_json.files }}"
        unit_of_measurement: files
      - name: Audiobook hours
        unique_id: audiobook_hours
        value_template: "{{ value_json.hours.total }}"
        unit_of_measurement: h
      - name: Audiobook hours listened
        unique_id: audiobook_hours_listened
        value_template: "{{ value_json.hours.listened }}"
        unit_of_measurement: h
      - name: Audiobook next up
        unique_id: audiobook_next_up
        value_template: "{{ (value_json.continue | first).title | default('nothing') }}"
        json_attributes: [continue]

script:
  continue_audiobook:
    alias: Continue the audiobook
    fields:
      player:
        name: Media player
        selector:
          entity:
            domain: media_player
    sequence:
      - service: media_player.play_media
        target:
          entity_id: "{{ player }}"
        data:
          media_content_type: music
          media_content_id: <base>/api/ha/continue.m3u
      - delay: "00:00:03"
      - service: media_player.media_seek
        target:
          entity_id: "{{ player }}"
        data:
          seek_position: >
            {{ (state_attr('sensor.audiobook_next_up', 'continue') | first).position | int(0) }}
```

Then, on a dashboard:

```yaml
type: entities
title: Audiobooks
entities:
  - entity: sensor.audiobooks
  - entity: sensor.audiobook_hours
  - entity: sensor.audiobook_hours_listened
  - entity: sensor.audiobook_next_up
  - type: call-service
    name: Continue in the kitchen
    icon: mdi:play
    service: script.continue_audiobook
    service_data:
      player: media_player.kitchen
```
