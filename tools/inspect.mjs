#!/usr/bin/env node
// Inspect a COMMAND ROOM recording zip (crrec-1): integrity, timing, audio, and a per-second activity timeline
// (ships on screen, kills, losses, player deaths, menus) inferred from the scene log.
//   node tools/inspect.mjs <recording.zip> [--json out.json]
// Needs ffprobe on PATH for the audio check (optional).
import fs from 'node:fs';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';

const [zipPath, ...rest] = process.argv.slice(2);
if (!zipPath) { console.error('usage: inspect.mjs <zip> [--json out.json]'); process.exit(1); }
const jsonOut = rest[0] === '--json' ? rest[1] : null;
const problems = [];

// ---------------------------------------------------------------- unzip (+ CRC check)
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (b) => { let c = -1; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const zb = fs.readFileSync(zipPath);
const files = {};
{
  let e = zb.length - 22;
  while (e >= 0 && zb.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('not a zip (no central directory) - truncated download?');
  const n = zb.readUInt16LE(e + 10); let p = zb.readUInt32LE(e + 16);
  for (let i = 0; i < n; i++) {
    const method = zb.readUInt16LE(p + 10), crc = zb.readUInt32LE(p + 16), csize = zb.readUInt32LE(p + 20), nl = zb.readUInt16LE(p + 28), xl = zb.readUInt16LE(p + 30), cl = zb.readUInt16LE(p + 32), lo = zb.readUInt32LE(p + 42);
    const name = zb.toString('utf8', p + 46, p + 46 + nl);
    p += 46 + nl + xl + cl;
    const start = lo + 30 + zb.readUInt16LE(lo + 26) + zb.readUInt16LE(lo + 28);
    let data;
    try { data = method === 8 ? zlib.inflateRawSync(zb.subarray(start, start + csize)) : zb.subarray(start, start + csize); }
    catch (err) { problems.push(`zip entry ${name}: cannot inflate (${err.message})`); continue; }
    if (crc32(data) !== crc) problems.push(`zip entry ${name}: CRC mismatch`);
    files[name] = data;
  }
}
const man = JSON.parse(files['manifest.json'].toString());
const defs = files[man.files.defs].toString().split('\n').filter(Boolean).map((l, i) => { try { return JSON.parse(l); } catch (e) { problems.push(`defs line ${i + 1} is not JSON`); return null; } }).filter(Boolean);
const bin = files[man.files.frames];
const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
if (dv.getUint32(0, true) !== 0x31465243) problems.push('frames.bin: bad magic');

// ---------------------------------------------------------------- objects
const geo = new Map(), mats = new Map();
for (const d of defs) { if (d.k === 'geo') geo.set(d.id, d); if (d.k === 'mat') mats.set(d.id, d); }
const rcache = new Map();
function geoR(id) {
  if (rcache.has(id)) return rcache.get(id);
  let d = geo.get(id), r = 0;
  while (d && d.copyOf !== undefined) d = geo.get(d.copyOf);
  const a = d && d.data && d.data.attrs && d.data.attrs.position;
  if (a && a.t === 'Float32Array') { const b = Buffer.from(a.b64, 'base64'); const f = new Float32Array(b.buffer, b.byteOffset, b.length >> 2); for (let i = 0; i + 2 < f.length; i += 3) r = Math.max(r, Math.hypot(f[i], f[i + 1], f[i + 2])); }
  rcache.set(id, r); return r;
}
const obj = new Map();
for (const d of defs) {
  if (d.k !== 'obj') continue;
  const m = mats.get(d.mat), c = m && m.json && m.json.color !== undefined ? m.json.color : 0xffffff;
  const R = (c >> 16) & 255, G = (c >> 8) & 255, B = c & 255;
  const ship = d.type === 'LineSegments' && (!d.layer || d.layer === 'world') && geoR(d.geo) > 0.05 && geoR(d.geo) < 0.35;
  const side = !ship ? null : R > G * 1.3 && R > B * 1.3 ? 'red' : (B > R * 1.3 && G > R * 1.3) ? 'cyan' : (R > B * 1.5 && G > B * 1.5) ? 'gold' : 'other';
  obj.set(d.id, { d, ship, side, player: (d.anc || []).includes('player-ship') || d.name === 'player-ship', ui: d.layer === 'ui', hands: d.layer === 'hands' });
}

// ---------------------------------------------------------------- frames
const fr = [];
let o = 8, parseErr = null;
const vis = new Set();
const evs = [];   // inferred events
while (o < bin.length) {
  try {
    if (dv.getUint8(o) !== 0xfa) throw new Error('bad frame marker');
    const idx = dv.getUint32(o + 1, true), t = dv.getFloat64(o + 5, true) / 1000; o += 13 + 28;
    const ctrl = [];
    for (let i = 0; i < 2; i++) { const h = dv.getUint8(o); o += 1; if (!h) { ctrl.push(null); continue; } o += 28; const pressed = dv.getUint16(o, true); o += 8; const trig = dv.getUint8(o) / 255; o += 1; ctrl.push({ pressed, trig }); }
    const shown = [], hidden = [];
    for (;;) {
      const ty = dv.getUint8(o); o += 1;
      if (ty === 0) break;
      if (ty === 1 || ty === 2) { const n = dv.getUint32(o, true); o += 4; for (let i = 0; i < n; i++) (ty === 1 ? shown : hidden).push(dv.getUint32(o + i * 4, true)); o += n * 4; }
      else if (ty === 3) { const n = dv.getUint32(o, true); o += 4 + n * 36; }
      else if (ty === 5) { const n = dv.getUint32(o, true); o += 4 + n * 20; }
      else if (ty === 4) { const enc = dv.getUint8(o + 6), is = dv.getUint8(o + 7), count = dv.getUint32(o + 12, true); o += 16 + count * is * (enc === 1 ? 1 : enc === 2 ? 2 : 4); }
      else if (ty === 6) { const k = dv.getUint32(o + 8, true); o += 12 + k * 19; }
      else if (ty === 7) o += 12;
      else throw new Error('unknown record ' + ty);
    }
    for (const id of shown) vis.add(id);
    for (const id of hidden) vis.delete(id);
    let cyan = 0, red = 0, gold = 0, ui = 0;
    for (const id of vis) { const b = obj.get(id); if (!b) continue; if (b.ship) { if (b.side === 'cyan') cyan++; else if (b.side === 'red') red++; else if (b.side === 'gold') gold++; } if (b.ui) ui++; }
    fr.push({ idx, t, cyan, red, gold, ui, shown, hidden, trig: ctrl.map((c) => (c ? c.trig : 0)), ctrlOn: ctrl.filter(Boolean).length });
  } catch (e) { parseErr = `frames.bin: ${e.message} at byte ${o} of ${bin.length} (after ${fr.length} frames)`; break; }
}
if (parseErr) problems.push(parseErr);
const T0 = fr.length ? fr[0].t : 0;
for (const f of fr) f.t -= T0;
const dur = fr.length ? fr[fr.length - 1].t : 0;

// timing
const dts = []; let idxGaps = 0, backwards = 0; const gaps = [];
for (let i = 1; i < fr.length; i++) {
  const dt = fr[i].t - fr[i - 1].t; dts.push(dt);
  if (dt < 0) backwards++;
  if (fr[i].idx !== fr[i - 1].idx + 1) idxGaps++;
  if (dt > 0.25) gaps.push([+fr[i - 1].t.toFixed(1), +dt.toFixed(2)]);
}
const sorted = [...dts].sort((a, b) => a - b), q = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;
if (backwards) problems.push(`${backwards} frames go back in time`);
if (gaps.length) problems.push(`${gaps.length} logging gaps > 0.25 s (longest ${Math.max(...gaps.map((g) => g[1]))} s at ${gaps.sort((a, b) => b[1] - a[1])[0][0]} s)`);
if (Math.abs(fr.length - man.frames) > 2) problems.push(`manifest says ${man.frames} frames, frames.bin has ${fr.length}`);

// inferred events: kills (red hidden, not re-shown in 0.5 s; mass hides = round reset), losses, player deaths
const reshown = (id, i) => { for (let j = i + 1; j < fr.length && fr[j].t < fr[i].t + 0.5; j++) if (fr[j].shown.includes(id)) return true; return false; };
for (let i = 0; i < fr.length; i++) {
  const f = fr[i];
  const sh = f.hidden.map((id) => obj.get(id)).filter((b) => b && b.ship);
  if (sh.length >= 5) { evs.push({ t: f.t, type: 'reset', n: sh.length }); continue; }
  for (const id of f.hidden) {
    const b = obj.get(id); if (!b || !b.ship || reshown(id, i)) continue;
    if (b.player) evs.push({ t: f.t, type: 'player-death' });
    else if (b.side === 'red' || b.side === 'gold') evs.push({ t: f.t, type: 'kill' });
    else if (b.side === 'cyan') evs.push({ t: f.t, type: 'wingman-lost' });
  }
}
// texture snapshots = UI changes; recorder events
const texT = defs.filter((d) => d.k === 'tex').map((d) => (d.f !== undefined && fr[d.f] ? fr[d.f].t : null)).filter((x) => x !== null);
const recEv = defs.filter((d) => d.k === 'ev').map((d) => ({ t: +(d.t / 1000).toFixed(1), type: d.type, ...(d.text ? { text: d.text } : {}), ...(d.state ? { state: d.state } : {}), ...(d.reason ? { reason: d.reason } : {}) }));

// per-second timeline + segments
const secs = [];
for (let s = 0; s < Math.ceil(dur); s++) {
  const fs_ = fr.filter((f) => f.t >= s && f.t < s + 1);
  if (!fs_.length) { secs.push({ s, cyan: 0, red: 0, ui: 0, kills: 0, n: 0 }); continue; }
  const mx = (k) => Math.max(...fs_.map((f) => f[k]));
  secs.push({ s, n: fs_.length, cyan: mx('cyan'), red: mx('red'), gold: mx('gold'), ui: mx('ui'), trig: +Math.max(...fs_.map((f) => Math.max(...f.trig))).toFixed(2),
    kills: evs.filter((e) => e.type === 'kill' && e.t >= s && e.t < s + 1).length, deaths: evs.filter((e) => (e.type === 'player-death' || e.type === 'wingman-lost') && e.t >= s && e.t < s + 1).length,
    tex: texT.filter((t) => t >= s && t < s + 1).length });
}
const state = (x) => (x.red > 0 && x.cyan > 0 ? 'fight' : x.ui > 0 ? 'menu' : x.cyan > 0 ? 'fly' : 'other');
const segs = [];
for (const x of secs) { const st = state(x); const L = segs[segs.length - 1]; if (L && L.state === st) { L.to = x.s + 1; L.kills += x.kills; L.deaths += x.deaths; L.maxRed = Math.max(L.maxRed, x.red); L.maxCyan = Math.max(L.maxCyan, x.cyan); } else segs.push({ state: st, from: x.s, to: x.s + 1, kills: x.kills, deaths: x.deaths, maxRed: x.red, maxCyan: x.cyan }); }
// merge blips (< 3 s) into the previous segment
const segs2 = [];
for (const g of segs) { const L = segs2[segs2.length - 1]; if (L && (g.to - g.from < 3 || L.state === g.state)) { L.to = g.to; L.kills += g.kills; L.deaths += g.deaths; L.maxRed = Math.max(L.maxRed, g.maxRed); L.maxCyan = Math.max(L.maxCyan, g.maxCyan); } else segs2.push({ ...g }); }
// modes: squadron if several cyan ships fight together
const mode = (g) => (g.state === 'fight' || g.state === 'fly' ? (g.maxCyan >= 3 ? 'squadron' : 'fighter') : g.state);
// best moments: 8 s windows ranked by kills*3 + enemies + deaths*2
const wins = [];
for (let s = 0; s + 8 <= secs.length; s++) { const w = secs.slice(s, s + 8); wins.push({ from: s, to: s + 8, kills: w.reduce((a, x) => a + x.kills, 0), deaths: w.reduce((a, x) => a + (x.deaths || 0), 0), red: Math.max(...w.map((x) => x.red)), cyan: Math.max(...w.map((x) => x.cyan)), score: w.reduce((a, x) => a + x.kills * 3 + Math.min(x.red, 8) * 0.25 + (x.deaths || 0) * 2, 0) }); }
const best = [];
for (const w of [...wins].sort((a, b) => b.score - a.score)) { if (w.score <= 0 || best.length >= 8) break; if (best.some((b) => Math.abs(b.from - w.from) < 8)) continue; best.push(w); }
best.sort((a, b) => a.from - b.from);

// audio
let audio = null;
if (man.audio && man.audio.file && files[man.audio.file]) {
  const tmp = `/tmp/crinspect-${process.pid}.webm`; fs.writeFileSync(tmp, files[man.audio.file]);
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels:format=duration', '-of', 'json', tmp], { encoding: 'utf8' });
  let pj = null; try { pj = JSON.parse(r.stdout); } catch (e) { /* */ }
  // a webm from MediaRecorder often has no duration header: decode to measure
  const d2 = spawnSync('ffmpeg', ['-v', 'error', '-i', tmp, '-f', 'null', '-'], { encoding: 'utf8' });
  const vol = spawnSync('ffmpeg', ['-hide_banner', '-i', tmp, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const ts = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', tmp], { encoding: 'utf8' });
  const pts = ts.stdout.split('\n').map(Number).filter((x) => !isNaN(x) && x > 0);
  fs.rmSync(tmp, { force: true });
  const st = pj && pj.streams && pj.streams[0];
  audio = { bytes: files[man.audio.file].length, codec: st && st.codec_name, sampleRate: st && +st.sample_rate, channels: st && st.channels, manifestSampleRate: man.audio.sampleRate, startMs: man.audio.startMs,
    lengthSec: pts.length ? +Math.max(...pts).toFixed(2) : null, decodeErrors: d2.stderr.trim().split('\n').filter(Boolean).length,
    meanDb: +((vol.stderr.match(/mean_volume: (-?[\d.]+)/) || [])[1]), maxDb: +((vol.stderr.match(/max_volume: (-?[\d.]+)/) || [])[1]) };
  if (audio.lengthSec !== null && Math.abs(audio.lengthSec + (man.audio.startMs || 0) / 1000 - dur) > 1.5) problems.push(`audio is ${audio.lengthSec} s (+${((man.audio.startMs || 0) / 1000).toFixed(2)} s start) vs ${dur.toFixed(1)} s of scene log: ${(audio.lengthSec + (man.audio.startMs || 0) / 1000 - dur).toFixed(1)} s off`);
  if (audio.decodeErrors) problems.push(`audio: ${audio.decodeErrors} decode error lines`);
  if (audio.maxDb !== undefined && audio.maxDb < -60) problems.push('audio is silent');
  if (audio.sampleRate && man.audio.sampleRate && audio.sampleRate !== man.audio.sampleRate) problems.push(`audio sample rate: AudioContext ${man.audio.sampleRate} Hz, file ${audio.sampleRate} Hz (normal for Opus: always 48 kHz)`);
} else problems.push('no audio track' + (man.audio && man.audio.error ? ': ' + man.audio.error : ''));
if (man.status && man.status !== 'complete') problems.push(`manifest status: ${man.status}`);

// Runs from the game's own messages: "ROUND 1" starts a run, SHIP DESTROYED / SQUADRON LOST / FLEET LOST ends it.
const runs = [];
{
  let cur = null;
  const msgs = recEv.filter((e) => e.type === 'msg');
  for (const m of msgs) {
    // The message is title+subtitle run together ("ROUND 5" + "10 hostiles inbound" = "ROUND 510 hostiles"),
    // so round numbers come only from "ROUND n CLEARED" and "Reached round n".
    const tx = m.text.toUpperCase();
    if (!cur && /^ROUND \d+ ?\d* ?HOSTILES/.test(tx)) { cur = { from: m.t, to: null, mode: null, rounds: 1, end: null, notes: [] }; continue; }
    if (!cur) continue;
    const r = tx.match(/^ROUND (\d+) CLEARED/); if (r) cur.rounds = Math.max(cur.rounds, +r[1] + 1);
    const rr = tx.match(/REACHED ROUND (\d+)/); if (rr) cur.rounds = +rr[1];
    if (/SQUADRON|FORMATION|WINGMAN/.test(tx)) cur.mode = cur.mode || 'squadron';
    if (/OUTPOST|ENDLESS|LANDED|LAUNCH/.test(tx)) cur.mode = cur.mode || 'endless';
    if (/ACE DOWN|LEADER DOWN|ESCAPED|WINGMAN DOWN|SPLIT/.test(tx)) cur.notes.push(`${m.t}s ${tx.split(/[^A-Z0-9 !]/)[0].trim()}`);
    if (/SHIP DESTROYED|SQUADRON LOST|FLEET LOST|RUN OVER|GAME OVER/.test(tx)) {
      cur.end = (tx.match(/SHIP DESTROYED|SQUADRON LOST|FLEET LOST|RUN OVER|GAME OVER/) || [''])[0] + ((tx.match(/SCORE ([\d,]+)/) || [])[1] ? ', score ' + tx.match(/SCORE ([\d,]+)/)[1] : ''); cur.to = m.t;
      if (/SHIP DESTROYED/.test(tx) && !cur.mode) cur.mode = 'fighter';
      if (/SQUADRON LOST/.test(tx)) cur.mode = 'squadron';
      runs.push(cur); cur = null;
    }
  }
  if (cur) { cur.to = +dur.toFixed(1); cur.end = cur.end || 'recording ended'; runs.push(cur); }
  for (const r of runs) { r.mode = r.mode || 'fighter'; r.kills = evs.filter((e) => e.type === 'kill' && e.t >= r.from && e.t <= r.to + 1).length; }
}
const kinds = {}; for (const d of defs) kinds[d.k] = (kinds[d.k] || 0) + 1;
const out = {
  file: zipPath, version: man.version, title: man.title, commit: man.commit, recorded: man.recorded, status: man.status, userAgent: man.userAgent, view: man.view,
  durationSec: +dur.toFixed(2), manifestDurationSec: man.durationSec, frames: fr.length, logHz: +(fr.length / Math.max(dur, 1e-6)).toFixed(1),
  dt: { median: +(q(0.5) * 1000).toFixed(1), p95: +(q(0.95) * 1000).toFixed(1), max: +(q(1) * 1000).toFixed(1) }, idxGaps, gaps: gaps.slice(0, 10),
  defs: kinds, textures: texT.length, objects: { total: obj.size, ships: [...obj.values()].filter((b) => b.ship).length, ui: [...obj.values()].filter((b) => b.ui).length, hands: [...obj.values()].filter((b) => b.hands).length },
  audio, recorderEvents: recEv,
  totals: { kills: evs.filter((e) => e.type === 'kill').length, playerDeaths: evs.filter((e) => e.type === 'player-death').length, wingmenLost: evs.filter((e) => e.type === 'wingman-lost').length, resets: evs.filter((e) => e.type === 'reset').length },
  runs, segments: segs2.map((g) => ({ ...g, mode: mode(g) })), best, events: evs.map((e) => ({ ...e, t: +e.t.toFixed(1) })), problems,
};
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ ...out, seconds: secs }, null, 1));
const mm = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
console.log(`${out.version} ${out.title}\n  ${out.durationSec} s (${mm(out.durationSec)}), ${out.frames} frames @ ${out.logHz} Hz (dt median ${out.dt.median} ms, p95 ${out.dt.p95}, max ${out.dt.max}), status ${out.status}`);
console.log(`  objects ${out.objects.total} (ships ${out.objects.ships}, ui ${out.objects.ui}, hands ${out.objects.hands}), textures ${out.textures}, defs ${JSON.stringify(kinds)}`);
console.log(`  audio ${audio ? `${audio.codec} ${audio.sampleRate} Hz x${audio.channels}, ${audio.lengthSec} s, start +${audio.startMs} ms, mean ${audio.meanDb} dB max ${audio.maxDb} dB, ${(audio.bytes / 1e6).toFixed(2)} MB` : 'none'}`);
console.log(`  totals ${JSON.stringify(out.totals)}`);
console.log('  runs: ' + (runs.length ? runs.map((r) => `${mm(r.from)}-${mm(r.to)} ${r.mode} rounds ${r.rounds} kills ${r.kills} -> ${r.end}`).join(' | ') : 'none (no ROUND messages)'));
console.log('  segments: ' + out.segments.map((g) => `${mm(g.from)}-${mm(g.to)} ${g.mode}${g.kills ? ` k${g.kills}` : ''}${g.deaths ? ` d${g.deaths}` : ''}${g.maxRed ? ` r${g.maxRed}` : ''}`).join(' | '));
console.log('  best: ' + best.map((w) => `${mm(w.from)}-${mm(w.to)} (k${w.kills} d${w.deaths} red${w.red} cyan${w.cyan})`).join(', '));
console.log('  recorder events: ' + recEv.map((e) => `${e.t}s ${e.type}${e.text ? ' "' + e.text.slice(0, 40) + '"' : ''}${e.state ? ' ' + e.state : ''}${e.reason ? ' ' + e.reason : ''}`).join('; '));
console.log('  problems: ' + (problems.length ? problems.join('; ') : 'none'));
