// Serves the two pages of the probe and a silent WAV to play, nothing else.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// 60 seconds of 8-bit mono silence: an audio track the autoplay policy applies
// to, without a sound coming out of the machine this runs on.
function silence(seconds = 60, rate = 8000) {
  const data = Buffer.alloc(seconds * rate, 128);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate, 28);
  head.writeUInt16LE(1, 32);
  head.writeUInt16LE(8, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

const wav = silence();

createServer((req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/tone.wav') {
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': wav.length });
    return res.end(wav);
  }
  const file = path === '/' ? 'a.html' : path.slice(1);
  if (file !== 'a.html' && file !== 'b.html') {
    res.writeHead(404);
    return res.end('no');
  }
  const body = readFileSync(join(here, file));
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}).listen(8899, '127.0.0.1', () => console.log('probe server on 8899'));
