#!/usr/bin/env node
// COMMAND ROOM offline renderer: recording zip -> MP4 (H.264 + AAC game audio).
//
//   node render/render.mjs <recording.zip> [options]
//     --mode head|wide|chase   camera (default head). head = the player's view, smoothed.
//     --out file.mp4           (default: next to the zip, <zip>-<mode>.mp4)
//     --res 1080|1440|4k|WxH   (default 1080 = 1920x1080)
//     --fps 60                 output frame rate (log is ~36-45 Hz, transforms are interpolated)
//     --from S --to S          seconds into the recording (default: everything)
//     --ui on|off              panels, ring, tutorial card, wrist HUD, popups, laser cursor (default: on, off for chase)
//     --hands on|off           controller models (default: on, off for chase)
//     --linewidth PX           wireframe line width in px at 1080p (default 1.6; 0 = native 1 px GL lines)
//     --fov DEG                vertical field of view (head 75, wide 60, chase 65)
//     --smooth SEC             head-pose smoothing sigma (default 0.12; 0 = raw)
//     --target NAME|ID         chase target (default player-ship)
//     --dist N --height N      chase distance / height in ship lengths (default 3.2 / 0.9)
//     --cam x,y,z --look x,y,z fixed camera for --mode wide
//     --crf 16                 x264 quality (lower = better)
//     --still SEC              render one PNG at that time instead of a video (--out shot.png)
//     --no-audio               skip the audio track
//     --display :N             use an existing X display instead of headless Firefox
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
if (!argv.length || argv[0] === '--help') { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 24).join('\n')); process.exit(0); }
const zipPath = path.resolve(argv[0]);
const opt = { mode: 'head', res: '1080', fps: '60', crf: '16' };
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--no-audio') { opt.noAudio = true; continue; }
  if (!a.startsWith('--')) throw new Error('bad arg ' + a);
  opt[a.slice(2)] = argv[++i];
}
const RES = { 720: [1280, 720], 1080: [1920, 1080], 1440: [2560, 1440], '4k': [3840, 2160], '2160': [3840, 2160] };
const [W, H] = RES[opt.res] || opt.res.split('x').map(Number);
const chase = opt.mode === 'chase';
const ui = opt.ui ? opt.ui === 'on' : !chase, hands = opt.hands ? opt.hands === 'on' : !chase;
const still = opt.still !== undefined;
const out = path.resolve(opt.out || zipPath.replace(/\.zip$/i, '') + `-${opt.mode}${still ? '.png' : '.mp4'}`);

// ---------------------------------------------------------------- unzip (no external tools)
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'crrender-'));
const recDir = path.join(work, 'rec');
function unzip(file, dest) {
  const b = fs.readFileSync(file);
  let e = b.length - 22;
  while (e >= 0 && b.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('not a zip');
  const n = b.readUInt16LE(e + 10); let p = b.readUInt32LE(e + 16);
  for (let i = 0; i < n; i++) {
    const method = b.readUInt16LE(p + 10), csize = b.readUInt32LE(p + 20), nl = b.readUInt16LE(p + 28), xl = b.readUInt16LE(p + 30), cl = b.readUInt16LE(p + 32), lo = b.readUInt32LE(p + 42);
    const name = b.toString('utf8', p + 46, p + 46 + nl);
    p += 46 + nl + xl + cl;
    const start = lo + 30 + b.readUInt16LE(lo + 26) + b.readUInt16LE(lo + 28);
    const raw = b.subarray(start, start + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    const fp = path.join(dest, name);
    if (!fp.startsWith(dest)) throw new Error('bad path in zip');
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, data);
  }
}
unzip(zipPath, recDir);
const manifest = JSON.parse(fs.readFileSync(path.join(recDir, 'manifest.json'), 'utf8'));
console.log(`recording ${manifest.version} "${manifest.title}" ${manifest.durationSec.toFixed(1)} s, ${manifest.frames} frames, audio=${manifest.audio ? manifest.audio.file : 'none'}`);

// ---------------------------------------------------------------- ffmpeg
const from = +(opt.from || 0);
const tmpVideo = path.join(work, 'video.mp4');
let ff = null, ffDone = null;
if (!still) {
  const vf = ['vflip'];
  ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', opt.fps, '-i', '-',
    '-vf', vf.join(','), '-c:v', 'libx264', '-preset', 'medium', '-crf', opt.crf, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', tmpVideo], { stdio: ['pipe', 'inherit', 'inherit'] });
  ffDone = new Promise((res) => ff.on('close', res));
}

// ---------------------------------------------------------------- server
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.jsonl': 'text/plain', '.bin': 'application/octet-stream' };
let finish, fail;
const finished = new Promise((res, rej) => { finish = res; fail = rej; });
let frames = 0;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'POST') {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (u.pathname === '/frame') {
        frames++;
        if (still) {
          spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-i', '-', '-vf', 'vflip', '-frames:v', '1', out], { input: body });
          res.end('ok');
        } else if (!ff.stdin.write(body)) ff.stdin.once('drain', () => res.end('ok'));
        else res.end('ok');
        return;
      }
      if (u.pathname === '/log') console.log('  [page]', body.toString());
      else if (u.pathname === '/error') { console.error('  [page ERROR]', body.toString()); fail(new Error(body.toString())); }
      else if (u.pathname === '/done') finish(JSON.parse(body.toString()));
      res.end('ok');
    });
    return;
  }
  let p = decodeURIComponent(u.pathname);
  let file;
  if (p.startsWith('/rec/')) file = path.join(recDir, p.slice(5));
  else file = path.join(HERE, p);
  if (!file.startsWith(HERE) && !file.startsWith(recDir)) { res.statusCode = 403; res.end(); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; res.end(); return; }
  res.setHeader('content-type', TYPES[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const q = new URLSearchParams({ mode: opt.mode, w: W, h: H, fps: opt.fps, from, ui: ui ? 1 : 0, hands: hands ? 1 : 0 });
for (const k of ['to', 'target', 'fov', 'smooth', 'cam', 'look', 'dist', 'height', 'still', 'fog']) if (opt[k] !== undefined) q.set(k, opt[k]);
if (opt.linewidth !== undefined) q.set('lw', opt.linewidth);
const url = `http://127.0.0.1:${port}/page/index.html?${q}`;

// ---------------------------------------------------------------- browser (Firefox, headless by default)
const prof = path.join(work, 'profile');
fs.mkdirSync(prof);
fs.writeFileSync(path.join(prof, 'user.js'), [
  'user_pref("webgl.force-enabled", true);', 'user_pref("webgl.max-size", 16384);', 'user_pref("browser.shell.checkDefaultBrowser", false);',
  'user_pref("browser.aboutwelcome.enabled", false);', 'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
  'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);', 'user_pref("browser.sessionstore.resume_from_crash", false);',
  'user_pref("termsofuse.bypassNotification", true);', 'user_pref("browser.startup.homepage_override.mstone", "ignore");',
  'user_pref("dom.max_script_run_time", 0);', 'user_pref("toolkit.startup.max_resumed_crashes", -1);',
].join('\n'));
const env = { ...process.env, MOZ_ENABLE_WAYLAND: '0' };
delete env.WAYLAND_DISPLAY;
const args = ['-no-remote', '-profile', prof, '--width', String(Math.min(W, 1920)), '--height', String(Math.min(H, 1080)), url];
if (opt.display) env.DISPLAY = opt.display; else { env.MOZ_HEADLESS = '1'; args.unshift('--headless'); }
console.log(`rendering ${opt.mode} ${W}x${H}@${opt.fps} ui=${ui ? 'on' : 'off'} hands=${hands ? 'on' : 'off'} -> ${out}`);
const ffx = spawn('firefox', args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
let ffxErr = '';
ffx.stderr.on('data', (d) => { ffxErr += d; if (ffxErr.length > 20000) ffxErr = ffxErr.slice(-10000); });
const t0 = Date.now();
let result;
try { result = await finished; } catch (e) { console.error('render failed:', e.message); }
ffx.kill('SIGTERM');
setTimeout(() => { try { ffx.kill('SIGKILL'); } catch (e) { /* */ } }, 3000);
server.close();
if (!result) { if (ff) ff.stdin.end(); console.error(ffxErr.slice(-2000)); process.exit(1); }
if (still) { console.log('wrote', out); fs.rmSync(work, { recursive: true, force: true }); process.exit(0); }
ff.stdin.end();
await ffDone;
console.log(`video: ${frames} frames in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

// ---------------------------------------------------------------- mux game audio
const audio = manifest.audio && manifest.audio.file && fs.existsSync(path.join(recDir, manifest.audio.file)) ? path.join(recDir, manifest.audio.file) : null;
if (audio && !opt.noAudio) {
  const delay = (manifest.audio.startMs || 0) / 1000 - from;   // audio sample 0 = startMs after the recording began
  const aIn = delay >= 0 ? ['-i', audio] : ['-ss', String(-delay), '-i', audio];
  const af = delay > 0 ? [`adelay=${Math.round(delay * 1000)}:all=1`, 'apad'] : ['apad'];
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', tmpVideo, ...aIn, '-map', '0:v', '-map', '1:a', '-af', af.join(','), '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', out], { stdio: 'inherit' });
  if (r.status !== 0) { console.error('audio mux failed; writing video only'); fs.copyFileSync(tmpVideo, out); }
} else fs.copyFileSync(tmpVideo, out);
fs.rmSync(work, { recursive: true, force: true });
console.log('wrote', out);
