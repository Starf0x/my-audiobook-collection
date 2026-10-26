// A speaker played at another speed (2.14.325). Home Assistant has no way to tell
// a media player how fast to play, so the app sends the track through ffmpeg's
// atempo itself: /api/stream/:id?speed=…&at=… is the file sped up, from `at`
// seconds in. Ten seconds of tone at 2× is five seconds; from 4 s in, three.
//
// Run: node tests/speaker-speed.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HERE = path.join(ROOT, 'fixtures', 'speaker-speed-test');
const DATA = path.join(HERE, 'data');
const PORT = 8552;
const BASE = `http://127.0.0.1:${PORT}`;

let failed = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
};

fs.rmSync(HERE, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
process.env.DATA_DIR = DATA;
process.env.PORT = String(PORT);
process.env.ADMIN_PASSWORD = 'a long enough password'; // an app with no administrator answers nothing

const tone = path.join(HERE, 'tone.mp3');
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
  '-c:a', 'libmp3lame', '-b:a', '64k', tone]);

const { db } = await import('../server/db.js');
const { playerUrl } = await import('../server/ha.js');
await import('../server/index.js');
await new Promise((r) => setTimeout(r, 300));
db.prepare("INSERT INTO books (id, path, genre, author, title) VALUES (1, ?, 'Fantasy', 'A', 'B')").run(HERE);
db.prepare('INSERT INTO tracks (id, book_id, idx, path, title, duration) VALUES (1, 1, 0, ?, ?, 10)').run(tone, 'One');

// how long what the stream sends plays for, by ffprobe
const seconds = async (params) => {
  const r = await fetch(playerUrl(BASE, '/api/stream/1', params));
  const out = path.join(HERE, `got-${Object.values(params).join('-') || 'plain'}.mp3`);
  fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
  const d = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]);
  return [r.status, r.headers.get('content-type'), Math.round(Number(String(d).trim()))];
};

check('at 1× the file itself is sent', (await seconds({}))[2], 10);
check('at 2× the track plays in half the time, as MP3', await seconds({ speed: 2 }), [200, 'audio/mpeg', 5]);
check('and from 4 s in, the six seconds left in three', (await seconds({ speed: 2, at: 4 }))[2], 3);
check('a speed out of range is played at 1×', (await seconds({ speed: 9 }))[2], 10);

console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
