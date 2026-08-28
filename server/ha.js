// Home Assistant, without a custom component.
//
// Everything HA needs fits in two answers: one JSON document it can poll with a
// `rest` sensor, and one playlist it can hand to a media player. Nothing here
// pushes: HA asks, which is the only way that works through a container with no
// broker and no cloud account.
//
// The playlist is the part that makes "continue this book on the kitchen speaker"
// possible at all. A media player cannot be told "play book 12 from 3h14m", but it
// can be given a URL, and most of them take an M3U and play it through. So the
// playlist starts at the track the listener is on and runs to the end of the book;
// the seconds into that track come back in the JSON, for HA to pass to
// `media_player.media_seek` once playback has started.
import { db } from './db.js';

// Where this app is reachable from, which is not always where the request came
// from: HA may talk to a hostname the browser never uses, and a media player has
// to be able to fetch the audio itself. BASE_URL settles it when set.
export function baseUrl(req) {
  const set = (process.env.BASE_URL || '').trim().replace(/\/+$/, '');
  if (set) return set;
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return `${proto}://${host}`;
}

// One token, read from the container. Without it these answers are as open as the
// listening page already is on the same network; with it, HA has to say it.
export const haToken = () => (process.env.HA_TOKEN || '').trim();

export function tokenOk(req) {
  const want = haToken();
  if (!want) return true;
  const said = req.query.token
    || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return said === want;
}

const hours = (seconds) => Math.round((seconds / 3600) * 10) / 10;

// How much of the collection has been listened to. A book marked listened counts
// whole; a book in progress counts the tracks already behind the listener plus the
// seconds into the one they are on. Per listener, or everybody at once.
const listenedSeconds = (user) => {
  const sql = `SELECT COALESCE(SUM(CASE WHEN p.done = 1 THEN b.duration ELSE
      COALESCE((SELECT SUM(t.duration) FROM tracks t
                WHERE t.book_id = b.id AND t.idx < p.track_idx), 0) + p.position END), 0) AS s
    FROM progress p JOIN books b ON b.id = p.book_id`;
  return user
    ? db.prepare(`${sql} WHERE p.user = ?`).get(user).s
    : db.prepare(sql).get().s;
};

const BOOK = `SELECT b.id, b.title, b.author, b.genre, b.duration,
  NULLIF(COALESCE(NULLIF(b.series, ''), NULLIF(b.tag_series, '')), '') AS series, b.series_no,
  (SELECT COUNT(*) FROM tracks t WHERE t.book_id = b.id) AS tracks`;

export function haState(req, version = '') {
  const base = baseUrl(req);
  const users = db.prepare('SELECT name FROM users ORDER BY name').all().map((u) => u.name);
  // one listener asked for, or the only one there is, or nobody
  const user = (req.query.user || '').trim() || (users.length === 1 ? users[0] : '');
  const totals = db.prepare(`SELECT
      (SELECT COUNT(*) FROM books) AS books,
      (SELECT COUNT(*) FROM tracks) AS files,
      (SELECT COALESCE(SUM(duration), 0) FROM books) AS seconds`).get();
  const done = db.prepare('SELECT COUNT(*) AS n FROM progress WHERE done = 1 AND user = ?')
    .get(user).n;
  const listened = listenedSeconds(user);

  const link = (b, trackIdx) => ({
    // the whole book from the beginning
    playlist: `${base}/api/ha/book/${b.id}.m3u`,
    // and from where this listener stopped, which is what "continue" means
    ...(trackIdx === undefined ? {} : {
      continueFrom: `${base}/api/ha/book/${b.id}.m3u?from=${trackIdx}`,
    }),
  });

  const keptGoing = db.prepare(`${BOOK}, p.track_idx, p.position, p.done, p.updated
      FROM progress p JOIN books b ON b.id = p.book_id
      WHERE p.user = ? AND (p.position > 0 OR p.done = 1)
      ORDER BY p.updated DESC LIMIT 12`).all(user);
  const behind = db.prepare(`SELECT COALESCE(SUM(t.duration), 0) AS s FROM tracks t
      WHERE t.book_id = ? AND t.idx < ?`);

  return {
    version,
    listeners: users,
    listener: user,
    books: totals.books,
    files: totals.files,
    listened_books: done,
    hours: {
      total: hours(totals.seconds),
      listened: hours(listened),
      left: hours(Math.max(0, totals.seconds - listened)),
    },
    // what to carry on with, newest first: the same list the shelves show
    continue: keptGoing.map((b) => {
      const into = behind.get(b.id, b.track_idx).s + b.position;
      return {
        id: b.id,
        title: b.title,
        author: b.author,
        series: b.series || '',
        series_no: b.series_no || 0,
        track: b.track_idx + 1,
        tracks: b.tracks,
        position: Math.round(b.position),
        into_hours: hours(into),
        left_hours: hours(Math.max(0, b.duration - into)),
        percent: b.duration ? Math.round((into / b.duration) * 100) : 0,
        listened: !!b.done,
        updated: b.updated,
        ...link(b, b.track_idx),
      };
    }),
    // and what has just arrived
    new: db.prepare(`${BOOK} FROM books b ORDER BY b.id DESC LIMIT 12`).all().map((b) => ({
      id: b.id,
      title: b.title,
      author: b.author,
      genre: b.genre,
      series: b.series || '',
      series_no: b.series_no || 0,
      tracks: b.tracks,
      hours: hours(b.duration),
      ...link(b),
    })),
  };
}

// The configuration to paste into Home Assistant, with this server's own address
// already in it — the one thing a copied example always gets wrong. The token is
// never printed: whoever set it on the container types it here themselves.
export function haYaml(req) {
  const base = baseUrl(req);
  const q = haToken() ? '?token=YOUR_HA_TOKEN' : '';
  return `# My Audiobook Collection — paste into configuration.yaml (or a package) and restart.
${haToken() ? '# This container has HA_TOKEN set, so replace YOUR_HA_TOKEN below with it.\n' : ''}rest:
  - resource: ${base}/api/ha${q}
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
      # the playlist starts at the track the listener is on …
      - service: media_player.play_media
        target:
          entity_id: "{{ player }}"
        data:
          media_content_type: music
          media_content_id: ${base}/api/ha/continue.m3u${q}
      # … and this puts it at the second they stopped on
      - delay: "00:00:03"
      - service: media_player.media_seek
        target:
          entity_id: "{{ player }}"
        data:
          seek_position: >
            {{ (state_attr('sensor.audiobook_next_up', 'continue') | first).position | int(0) }}
`;
}

// The book as a playlist a media player can be handed. #EXTM3U with a title per
// track, absolute URLs, and `from` cutting off what has already been heard.
export function bookPlaylist(req, id, from = 0) {
  const book = db.prepare('SELECT id, title, author FROM books WHERE id = ?').get(id);
  if (!book) return null;
  const tracks = db.prepare('SELECT id, idx, title, duration FROM tracks WHERE book_id = ? ORDER BY idx')
    .all(id).filter((t) => t.idx >= from);
  if (!tracks.length) return null;
  const base = baseUrl(req);

  return [
    '#EXTM3U',
    `#PLAYLIST:${book.title}${book.author ? ` — ${book.author}` : ''}`,
    ...tracks.flatMap((t) => [
      `#EXTINF:${Math.round(t.duration || 0)},${book.title} — ${t.title}`,
      `${base}/api/stream/${t.id}`,
    ]),
  ].join('\n') + '\n';
}
