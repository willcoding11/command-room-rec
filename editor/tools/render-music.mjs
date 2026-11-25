#!/usr/bin/env node
// Renders the game's procedural music (6-command-room/js/music.js through the game's own mix chain in audio.js)
// offline to seamless loops for the editor's music lane:
//   editor/music/lobby.ogg            lobby pad, 4 chord cycles (128 s)
//   editor/music/battle-calm.ogg     battle, intensity 0.3 (14 loops of 4 bars, 120 s)
//   editor/music/battle-intense.ogg  battle, intensity 1.0 (14 loops, 120 s)
// Ogg Opus (gapless: the decoder trims the encoder delay, unlike MP3). Each song is rendered with one warm-up cycle first (reverb / delay tails, level ramp), then exactly N loop
// periods are kept, so the file loops without a seam. Needs firefox + ffmpeg (run it in the Linux box).
//   node editor/tools/render-music.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUT = path.join(ROOT, 'editor', 'music');
fs.mkdirSync(OUT, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'crmusic-'));

const STEP = 60 / 112 / 4, BAR4 = 64 * STEP;
const SONGS = [
  { id: 'lobby', mode: 'lobby', level: 0, warm: 32, len: 128 },
  { id: 'battle-calm', mode: 'battle', level: 0.3, warm: BAR4 * 2, len: BAR4 * 14 },
  { id: 'battle-intense', mode: 'battle', level: 1, warm: BAR4 * 2, len: BAR4 * 14 },
];
const PAGE = `<!doctype html><meta charset="utf-8"><script type="module">
import { Sfx } from '/6-command-room/js/audio.js';
const SONGS = ${JSON.stringify(SONGS)};
const SR = 48000;
for (const s of SONGS) {
  const total = s.warm + s.len + 0.5;
  const ctx = new OfflineAudioContext(2, Math.ceil(total * SR), SR);
  const sfx = new Sfx(); sfx.attach(ctx);
  sfx.setVolumes(0.6, 0.8);
  sfx.music.setIntensity(s.level); sfx.music.level = s.level;
  sfx.music.setMode(s.mode, 0);
  for (let t = 0; t < total; t += 0.1) sfx.music.update(t);
  const buf = await ctx.startRendering();
  const a = Math.round(s.warm * SR), n = Math.round(s.len * SR);
  const out = new Float32Array(n * 2);
  for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) out[i * 2 + c] = d[a + i]; }
  await fetch('/pcm?id=' + s.id, { method: 'POST', body: out.buffer });
}
await fetch('/done', { method: 'POST' });
</script>`;
let done;
const finished = new Promise((r) => { done = r; });
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'POST') {
    const ch = []; req.on('data', (d) => ch.push(d));
    req.on('end', () => {
      if (u.pathname === '/pcm') { fs.writeFileSync(path.join(work, u.searchParams.get('id') + '.f32'), Buffer.concat(ch)); console.log('rendered', u.searchParams.get('id')); }
      if (u.pathname === '/done') done();
      res.end('ok');
    });
    return;
  }
  if (u.pathname === '/') { res.setHeader('content-type', 'text/html'); res.end(PAGE); return; }
  const file = path.join(ROOT, decodeURIComponent(u.pathname));
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.statusCode = 404; res.end(); return; }
  res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const prof = path.join(work, 'profile'); fs.mkdirSync(prof);
fs.writeFileSync(path.join(prof, 'user.js'), 'user_pref("browser.shell.checkDefaultBrowser", false);\nuser_pref("dom.max_script_run_time", 0);\nuser_pref("media.autoplay.default", 0);\n');
const ff = spawn('firefox', ['--headless', '-no-remote', '-profile', prof, `http://127.0.0.1:${server.address().port}/`], { stdio: 'ignore', env: { ...process.env, MOZ_HEADLESS: '1' } });
const timer = setTimeout(() => { console.error('timed out'); process.exit(1); }, 600000);
await finished;
clearTimeout(timer);
ff.kill('SIGTERM'); server.close();
for (const s of SONGS) {
  const src = path.join(work, s.id + '.f32'), dst = path.join(OUT, s.id + '.ogg');
  // level the three songs to the same loudness (the game mixes them under the effects; here they stand alone)
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', src,
    '-af', 'loudnorm=I=-18:TP=-1.5:LRA=11:linear=true', '-ar', '48000', '-c:a', 'libopus', '-b:a', '160k', dst], { stdio: 'inherit' });
  if (r.status) throw new Error('ffmpeg failed for ' + s.id);
  console.log('wrote', dst, (fs.statSync(dst).size / 1e6).toFixed(2), 'MB', s.len.toFixed(3), 's');
}
fs.writeFileSync(path.join(OUT, 'songs.json'), JSON.stringify(SONGS.map((s) => ({ id: s.id, file: s.id + '.ogg', seconds: +s.len.toFixed(4) })), null, 1));
fs.rmSync(work, { recursive: true, force: true });
setTimeout(() => process.exit(0), 500);
