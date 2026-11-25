// COMMAND ROOM editor: cut your own edits from the Quest recordings.
// Sessions (left) -> Source viewer (mark In / Out, add) -> Timeline (clips back to back + a music lane) ->
// per-clip camera / display / audio in the inspector (right) -> Export (WebCodecs, frame by frame).
import * as THREE from 'three';
import { Recording } from './recording.js';
import { SceneState } from './scene.js';
import { CAM_MODES, defaultCam, applyCamera, keyAt, keyFromView, orbitKey, panKey, dollyKey, targetAt } from './camera.js';
import { AudioEngine, SONGS, hasGameMusic } from './audio.js';
import { Timeline, camTag } from './timeline.js';
import { exportVideo, exportCapabilities } from './export.js';
import { fmtTime, runLine, runsFromMessages } from './summary.js';

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt !== undefined) e.textContent = txt; return e; };
const uid = () => Math.random().toString(36).slice(2, 9);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const FPS = 60, FRAME = 1 / FPS;
const tc = (s) => { s = Math.max(0, s); const m = Math.floor(s / 60), x = Math.floor(s % 60), f = Math.floor((s * FPS + 1e-6) % FPS); return `${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}.${String(f).padStart(2, '0')}`; };
const COLORS = ['#3fd0ff', '#7be495', '#ffb547', '#c08bff', '#ff7a8a', '#5be3c9', '#f5e663', '#7aa2ff'];
const LS_KEY = 'crEditor.project.v1';

// ====================================================================== state
const app = {
  server: false, sessions: [], recs: new Map(), loading: new Map(), loadInfo: new Map(),
  project: null, sel: null, T: 0, view: 'program',
  src: { key: null, t: 0, in: null, out: null, cam: 'auto' },
  playing: null, thumbs: new Map(), history: { stack: [], idx: -1 }, exporting: false,
  audio: new AudioEngine(),
};
window.CRE = app;   // handy in the console (and for the automated test)

function newProject() {
  return { v: 1, name: 'Untitled edit', clips: [], music: [], settings: { res: '1080', fps: 60, format: 'mp4', quality: 'high' } };
}

// ---------------------------------------------------------------------- layout (clips back to back)
let layoutCache = null;
app.layout = () => {
  if (layoutCache) return layoutCache;
  let t = 0;
  const clips = app.project.clips.map((c) => { const o = { ...c, start: t, dur: Math.max(0.05, c.out - c.in) }; t += o.dur; return o; });
  const music = app.project.music.map((m) => ({ ...m }));
  const musicEnd = music.reduce((a, m) => Math.max(a, m.start + m.len), 0);
  layoutCache = { clips, music, duration: t, musicEnd };
  return layoutCache;
};
app.clipAt = (T) => { const L = app.layout(); if (!L.clips.length) return null; for (const c of L.clips) if (T < c.start + c.dur - 1e-9) return c; return L.clips[L.clips.length - 1]; };
app.colorOf = (key) => { const i = app.sessions.findIndex((s) => s.key === key); return COLORS[(i < 0 ? hash(key) : i) % COLORS.length]; };
app.recLabel = (key) => { const s = app.sessions.find((x) => x.key === key); return s && s.manifest ? s.manifest.version : String(key).replace(/\.zip$/i, ''); };
app.songOf = (id) => SONGS.find((s) => s.id === id);
function hash(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }

// ---------------------------------------------------------------------- history + autosave
app.changed = (structural = true) => {
  layoutCache = null;
  app.timeline && app.timeline.render();
  if (structural) renderInspector();
  markDirty();
};
app.commit = (label = 'Edit') => {
  layoutCache = null;
  const H = app.history;
  const snap = JSON.stringify(app.project);
  if (H.stack[H.idx] === snap) { app.changed(); return; }
  H.stack.length = H.idx + 1; H.stack.push(snap); H.idx++;
  if (H.stack.length > 200) { H.stack.shift(); H.idx--; }
  autosave();
  app.changed();
  updateUndoButtons();
  queueThumbs();
};
function resetHistory() { app.history = { stack: [JSON.stringify(app.project)], idx: 0 }; updateUndoButtons(); }
function undo() { const H = app.history; if (H.idx <= 0) return; H.idx--; restore(H.stack[H.idx]); toast('Undo'); }
function redo() { const H = app.history; if (H.idx >= H.stack.length - 1) return; H.idx++; restore(H.stack[H.idx]); toast('Redo'); }
function restore(json) {
  app.project = JSON.parse(json);
  if (app.sel && !findSel(app.sel)) app.sel = null;
  layoutCache = null; autosave(); syncProjectUI(); app.changed(); updateUndoButtons(); queueThumbs();
}
function updateUndoButtons() { $('#btnUndo').disabled = app.history.idx <= 0; $('#btnRedo').disabled = app.history.idx >= app.history.stack.length - 1; }
let saveTimer = null;
function autosave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { localStorage.setItem(LS_KEY, JSON.stringify(app.project)); $('#saveState').textContent = 'Autosaved ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (e) { /* storage full */ } }, 300);
}
function findSel(s) { return s.kind === 'clip' ? app.project.clips.find((c) => c.id === s.id) : app.project.music.find((m) => m.id === s.id); }

// ====================================================================== renderer + viewer
const canvas = $('#view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.01, 1000);
let RW = 960, RH = 540;
function fitViewport() {
  const box = $('#viewport'), cs = getComputedStyle(box);
  const aw = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight), ah = box.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  let w = aw, hh = w * 9 / 16;
  if (hh > ah) { hh = ah; w = hh * 16 / 9; }
  const stage = $('#stage');
  stage.style.width = w + 'px'; stage.style.height = hh + 'px';
  if (app.exporting) return;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  RW = Math.max(160, Math.min(1920, Math.round(w * dpr))); RH = Math.round(RW * 9 / 16);
  renderer.setSize(RW, RH, false);
  markDirty();
}
new ResizeObserver(fitViewport).observe($('#viewport'));

const pool = new Map();   // key -> { state, used }
function stateFor(key, rec, opts) {
  let e = pool.get(key);
  if (e && e.state.rec !== rec) { e.state.dispose(); pool.delete(key); e = null; }
  if (!e) { e = { state: new SceneState(rec, opts) }; pool.set(key, e); }
  e.used = performance.now();
  e.state.setOptions(opts);
  if (pool.size > 7) {
    const old = [...pool.entries()].filter(([k]) => k !== key).sort((a, b) => a[1].used - b[1].used)[0];
    if (old) { old[1].state.dispose(); pool.delete(old[0]); }
  }
  return e.state;
}
const clipOpts = (c) => ({ ui: !!c.ui, hands: !!c.hands, bold: c.bold !== false });
const SOURCE_CAM = { auto: { ...defaultCam(), mode: 'auto' }, pov: { ...defaultCam(), mode: 'pov', a: { ...defaultCam().a, fov: 80 } } };

// what the viewer shows right now
function currentShot() {
  if (app.view === 'source') {
    const rec = app.recs.get(app.src.key);
    if (!rec) return { missing: app.src.key, label: app.src.key ? 'Loading ' + app.recLabel(app.src.key) + '…' : null };
    const t = clamp(app.src.t, 0, rec.duration);
    const cam = SOURCE_CAM[app.src.cam];
    return { rec, t, cam, u: 0, tIn: 0, tOut: rec.duration, state: stateFor('src:' + rec.key, rec, { ui: app.src.cam === 'pov', hands: app.src.cam === 'pov', bold: true }), label: `${rec.manifest.version} · ${rec.manifest.title}`, mode: app.src.cam };
  }
  const L = app.layout(), c = app.clipAt(app.T);
  if (!c) return { empty: true };
  const rec = app.recs.get(c.rec);
  if (!rec) { ensureRec(c.rec); return { missing: c.rec, clip: c, label: 'Loading ' + app.recLabel(c.rec) + '…' }; }
  const T = clamp(app.T, c.start, c.start + c.dur - 1e-6);
  const u = (T - c.start) / c.dur, t = c.in + (T - c.start);
  const idx = L.clips.indexOf(c);
  return { rec, t, cam: c.cam, u, tIn: c.in, tOut: c.out, clip: c, state: stateFor('clip:' + c.id, rec, clipOpts(c)), label: `Clip ${idx + 1}/${L.clips.length} · ${rec.manifest.version} ${fmtTime(c.in, true)}`, mode: c.cam.mode };
}

let drawing = false, dirty = true, lastShot = null;
function markDirty() { dirty = true; }
async function draw() {
  const s = currentShot();
  lastShot = s;
  updateOverlay(s);
  if (!s.rec) {
    renderer.setClearColor(0x02070c); renderer.clear();
    return;
  }
  await s.state.seek(s.t);
  s.state.setSize(RW, RH);
  s.state.pose(s.t);
  applyCamera(camera, s.cam, s.rec, s.t, s.u, { tIn: s.tIn, tOut: s.tOut, aspect: 16 / 9, dt: FRAME });
  renderer.render(s.state.scene, camera);
}
function tick() {
  requestAnimationFrame(tick);
  if (app.exporting) return;
  if (app.playing) advancePlayback();
  if (!dirty || drawing) return;
  dirty = false; drawing = true;
  draw().catch((e) => { console.error(e); toast('Viewer error: ' + e.message, true); }).finally(() => { drawing = false; if (!app.playing) runThumbQueue(); });
}

// ---------------------------------------------------------------------- overlay
function updateOverlay(s) {
  const ov = $('#overlay');
  $('#ovLabel').textContent = s.label || '';
  $('#ovMode').textContent = s.mode ? camTag(s.mode) : '';
  $('#ovMode').style.display = s.mode ? '' : 'none';
  $('#ovTime').textContent = app.view === 'source' ? tc(app.src.t) : tc(app.T);
  const msg = $('#ovCenter');
  if (s.empty) { msg.innerHTML = '<b>Start an edit</b><br>Pick a session on the left, mark In and Out in the Source viewer, then <i>Add to timeline</i>.'; msg.style.display = ''; }
  else if (app.view === 'source' && !app.src.key) { msg.innerHTML = '<b>Source viewer</b><br>Pick a session on the left to preview it.'; msg.style.display = ''; }
  else if (s.missing) { const li = app.loadInfo.get(s.missing); msg.innerHTML = `<b>${s.label || 'Loading…'}</b><br>${li ? li.stage + ' ' + Math.round(li.p * 100) + '%' : ''}`; msg.style.display = ''; }
  else msg.style.display = 'none';
  // camera hint
  const hint = $('#ovHint');
  const c = s.clip;
  if (app.view === 'program' && c && s.rec) {
    const m = c.cam.mode;
    hint.textContent = m === 'free' ? 'Drag: orbit · Right-drag / Shift+drag: pan · Wheel: zoom' + editingTxt(c)
      : m === 'follow' ? 'Drag: set the offset · Wheel: distance · Click a ship to follow it' + editingTxt(c)
        : m === 'lookat' ? 'Drag: move round the target · Wheel: closer / further · Click a ship to look at it' + editingTxt(c)
          : m === 'pov' ? "The player's view" : 'Auto-director. Switch to Free, Follow or Look at to place the camera yourself.';
  } else hint.textContent = app.view === 'source' ? 'Source: I = mark in · O = mark out · Enter = add to timeline' : '';
  ov.classList.toggle('source', app.view === 'source');
  updateTimecode();
}
app.markDirty = () => markDirty();
app.srcSeek = (t) => { const rec = app.recs.get(app.src.key); if (!rec) return; app.src.t = clamp(t, 0, rec.duration); updateSourceBar(); markDirty(); };
app.idle = () => !drawing && !dirty && !thumbBusy;
const editingTxt = (c) => (c.cam.move === 'keys' ? ` · editing ${c.cam.edit === 'b' ? 'END' : 'START'} key` : '');

// ====================================================================== sessions
async function loadSessions() {
  try {
    const r = await fetch('/api/sessions', { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    const j = await r.json();
    app.server = true;
    const dropped = app.sessions.filter((s) => s.file);
    app.sessions = j.sessions.map((s) => ({ key: s.name, name: s.name, size: s.size, manifest: s.manifest, messages: s.messages || [], inspect: s.inspect, url: '/raw/' + encodeURIComponent(s.name) })).concat(dropped.filter((d) => !j.sessions.some((s) => s.name === d.key)));
    $('#serverState').textContent = '';
  } catch (e) {
    app.server = false;
    $('#serverState').textContent = 'No local server: drop recording zips here. (Open the editor with "Open Editor.bat" to list footage\\raw.)';
  }
  renderSessions();
}
function sessionInfo(s) {
  const rec = app.recs.get(s.key);
  const m = rec ? rec.manifest : s.manifest;
  const dur = rec ? rec.duration : m && m.durationSec;
  let runs = null, best = null, kills = null;
  if (rec) { runs = rec.summary.runs; best = rec.summary.best; kills = rec.summary.totals.kills; }
  else if (s.inspect) { runs = s.inspect.runs; best = s.inspect.best; kills = s.inspect.totals && s.inspect.totals.kills; }
  else if (s.messages && s.messages.length) runs = runsFromMessages(s.messages, dur || 0);
  return { m, dur, runs, best, kills };
}
function renderSessions() {
  const box = $('#sessions'); box.innerHTML = '';
  if (!app.sessions.length) box.append(el('div', 'muted small', app.server ? 'No recordings in footage\\raw yet. Drop a zip here.' : ''));
  for (const s of app.sessions) {
    const { m, dur, runs, best, kills } = sessionInfo(s);
    const card = el('div', 'session' + (app.src.key === s.key ? ' active' : '') + (app.recs.has(s.key) ? ' loaded' : ''));
    card.style.setProperty('--c', app.colorOf(s.key));
    const top = el('div', 'sess-top');
    top.append(el('span', 'sess-ver', m ? m.version : s.key), el('span', 'sess-title', m ? m.title : s.name), el('span', 'sess-dur', dur ? fmtTime(dur) : ''));
    card.append(top);
    const det = el('div', 'sess-runs');
    if (runs && runs.length) for (const r of runs.slice(0, 4)) det.append(el('div', 'run ' + (r.mode || ''), runLine(r)));
    else det.append(el('div', 'run', m ? 'No runs (lobby / tutorial)' : ''));
    if (runs && runs.length > 4) det.append(el('div', 'run more', `+${runs.length - 4} more runs`));
    card.append(det);
    const foot = el('div', 'sess-foot');
    foot.append(el('span', null, [kills !== null && kills !== undefined ? `${kills} kills` : '', best ? `${best.length} best moments` : '', s.size ? (s.size / 1e6).toFixed(0) + ' MB' : ''].filter(Boolean).join(' · ')));
    const li = app.loadInfo.get(s.key);
    if (li && li.p < 1) { const bar = el('div', 'bar'); const f = el('i'); f.style.width = Math.round(li.p * 100) + '%'; bar.append(f); foot.append(bar); }
    card.append(foot);
    card.dataset.tip = 'Open in the Source viewer';
    card.onclick = () => openSource(s.key);
    box.append(card);
  }
}
function ensureRec(key) {
  if (app.recs.has(key)) return Promise.resolve(app.recs.get(key));
  if (app.loading.has(key)) return app.loading.get(key);
  const s = app.sessions.find((x) => x.key === key);
  const p = (async () => {
    if (!s) throw new Error(`Recording ${key} is not in footage\\raw. Drop the zip onto the editor.`);
    const prog = (stage, f) => { app.loadInfo.set(key, { stage, p: f }); throttledSessions(); markDirty(); };
    prog('Downloading', 0);
    let buf;
    if (s.file) buf = await s.file.arrayBuffer();
    else {
      const r = await fetch(s.url);
      if (!r.ok) throw new Error('Could not read ' + key);
      const total = +r.headers.get('content-length') || s.size || 0;
      const rd = r.body.getReader(); const parts = []; let got = 0;
      for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); got += value.length; if (total) prog('Downloading', 0.5 * got / total); }
      const u8 = new Uint8Array(got); let o = 0; for (const p2 of parts) { u8.set(p2, o); o += p2.length; }
      buf = u8.buffer;
    }
    const rec = await Recording.fromBuffer(key, buf, (stage, f) => prog(stage, 0.5 + 0.5 * f));
    app.recs.set(key, rec);
    app.loadInfo.delete(key);
    renderSessions(); renderInspector(); app.timeline.render(); markDirty(); queueThumbs();
    if (app.view === 'source' && app.src.key === key) renderSourceBar();
    return rec;
  })();
  app.loading.set(key, p);
  p.catch((e) => { app.loading.delete(key); app.loadInfo.delete(key); toast(e.message, true); renderSessions(); });
  return p;
}
let sessTimer = null;
function throttledSessions() { if (sessTimer) return; sessTimer = setTimeout(() => { sessTimer = null; renderSessions(); }, 200); }

async function openSource(key, t = null) {
  stop();
  app.src.key = key; app.src.in = null; app.src.out = null;
  setView('source');
  renderSessions();
  const rec = await ensureRec(key).catch(() => null);
  if (!rec) return;
  if (app.src.key !== key) return;
  if (t !== null) app.src.t = t;
  else { const s = rec.summary.runs[0]; app.src.t = s ? Math.max(0, s.from) : Math.min(5, rec.duration); }
  renderSourceBar(); markDirty();
}
app.openClipInSource = (id) => {
  const c = app.project.clips.find((x) => x.id === id); if (!c) return;
  openSource(c.rec, c.in).then(() => { app.src.in = c.in; app.src.out = c.out; renderSourceBar(); });
};

// ---------------------------------------------------------------------- source bar
function renderSourceBar() {
  const bar = $('#srcbar');
  const rec = app.recs.get(app.src.key);
  const track = $('#srcTrack'); track.innerHTML = '';
  if (!rec) { $('#srcInfo').textContent = ''; return; }
  const D = rec.duration, pct = (t) => (100 * t / D) + '%';
  for (const r of rec.summary.runs) {
    const d = el('div', 'src-run ' + (r.mode || '')); d.style.left = pct(r.from); d.style.width = pct(Math.max(0.5, r.to - r.from));
    d.dataset.tip = runLine(r) + (r.end ? ' · ' + r.end : '');
    track.append(d);
    for (const n of r.notes || []) { const x = el('div', 'src-note'); x.style.left = pct(n.t); x.dataset.tip = `${fmtTime(n.t)} ${n.text}`; track.append(x); }
  }
  for (const b of rec.summary.best) { const d = el('div', 'src-best'); d.style.left = pct(b.from); d.style.width = pct(b.to - b.from); d.dataset.tip = `Best moment ${fmtTime(b.from)}–${fmtTime(b.to)} (${b.kills} kills). Click to jump.`; d.onpointerdown = (e) => { e.stopPropagation(); app.src.t = b.from; app.src.in = b.from; app.src.out = b.to; renderSourceBar(); markDirty(); }; track.append(d); }
  for (const m of rec.messages) { const t = m.t - rec.T0; const d = el('div', 'src-msg'); d.style.left = pct(t); d.dataset.tip = `${fmtTime(t)}  “${m.text}”`; track.append(d); }
  const io = el('div', 'src-io'); io.id = 'srcIO'; track.append(io);
  const ph = el('div', 'src-ph'); ph.id = 'srcPH'; track.append(ph);
  updateSourceBar();
}
function updateSourceBar() {
  const rec = app.recs.get(app.src.key);
  if (!rec) return;
  const D = rec.duration, ph = $('#srcPH'), io = $('#srcIO');
  if (ph) ph.style.left = (100 * app.src.t / D) + '%';
  if (io) {
    const a = app.src.in ?? null, b = app.src.out ?? null;
    if (a !== null || b !== null) { const x0 = a ?? 0, x1 = b ?? D; io.style.display = ''; io.style.left = (100 * x0 / D) + '%'; io.style.width = (100 * Math.max(0, x1 - x0) / D) + '%'; }
    else io.style.display = 'none';
  }
  $('#srcIn').textContent = app.src.in !== null ? tc(app.src.in) : '--:--.--';
  $('#srcOut').textContent = app.src.out !== null ? tc(app.src.out) : '--:--.--';
  const a = app.src.in ?? app.src.t, b = app.src.out ?? Math.min(D, a + 6);
  $('#srcDur').textContent = b > a ? (b - a).toFixed(2) + ' s' : '';
  $('#srcInfo').textContent = `${tc(app.src.t)} / ${tc(D)}`;
}
function srcSeekFromEvent(e) {
  const rec = app.recs.get(app.src.key); if (!rec) return;
  const r = $('#srcTrack').getBoundingClientRect();
  app.src.t = clamp((e.clientX - r.left) / r.width, 0, 1) * rec.duration;
  updateSourceBar(); markDirty();
}
function markIn() { if (!app.recs.get(app.src.key)) return; app.src.in = app.src.t; if (app.src.out !== null && app.src.out <= app.src.in) app.src.out = null; updateSourceBar(); }
function markOut() { if (!app.recs.get(app.src.key)) return; app.src.out = app.src.t; if (app.src.in !== null && app.src.in >= app.src.out) app.src.in = null; updateSourceBar(); }
function addFromSource() {
  const rec = app.recs.get(app.src.key);
  if (!rec) { toast('Open a session first'); return; }
  let a = app.src.in ?? app.src.t, b = app.src.out ?? Math.min(rec.duration, a + 6);
  if (b - a < 0.25) { toast('The clip is too short: mark an Out point after the In point'); return; }
  const clip = { id: uid(), rec: rec.key, recDur: rec.duration, in: +a.toFixed(3), out: +b.toFixed(3), cam: defaultCam(), ui: false, hands: false, bold: true, vol: 1, mute: false };
  app.project.clips.push(clip);
  app.sel = { kind: 'clip', id: clip.id };
  layoutCache = null;
  const L = app.layout(); const c = L.clips.find((x) => x.id === clip.id);
  app.T = c.start;
  app.commit('Add clip');
  app.src.in = null; app.src.out = null; updateSourceBar();
  toast(`Added ${rec.manifest.version} ${fmtTime(a, true)}–${fmtTime(b, true)} to the timeline`);
  app.timeline.ensureVisible(c.start + c.dur);
}

// ====================================================================== playback
function setView(v) {
  if (app.view !== v) stop();
  app.view = v;
  document.body.dataset.view = v;
  for (const b of document.querySelectorAll('#viewerTabs [data-view]')) b.classList.toggle('on', b.dataset.view === v);
  if (v === 'source') renderSourceBar();
  markDirty();
}
async function play(rate = 1) {
  if (app.exporting) return;
  const prog = app.view === 'program';
  if (prog) {
    const L = app.layout(); if (!L.clips.length) return;
    if (rate > 0 && app.T >= L.duration - FRAME) app.T = 0;
  } else {
    const rec = app.recs.get(app.src.key); if (!rec) return;
    if (rate > 0 && app.src.t >= rec.duration - FRAME) app.src.t = 0;
  }
  app.audio.stop();
  const start = prog ? app.T : app.src.t;
  app.playing = { rate, start, wall: performance.now(), audio: false };
  $('#btnPlay').classList.add('playing');
  if (rate === 1) {
    try {
      const pl = app.playing;
      // make sure the scenes are ready before the sound starts (a cut to a far-away moment takes a moment)
      if (prog) await prepareAround(app.T);
      if (app.playing !== pl) return;
      const live = prog ? await app.audio.play(app.layout(), app.recs, app.T)
        : await app.audio.play({ clips: [{ id: 'src', rec: app.src.key, in: app.src.t, out: app.recs.get(app.src.key).duration, start: 0, dur: app.recs.get(app.src.key).duration - app.src.t, vol: 1 }], music: [], duration: app.recs.get(app.src.key).duration - app.src.t }, app.recs, 0);
      if (app.playing !== pl) { app.audio.stop(); return; }
      if (live) { pl.audio = true; pl.srcBase = prog ? 0 : start; }
    } catch (e) { console.warn('audio', e); }
  }
}
function stop() {
  if (!app.playing) return;
  app.playing = null; app.audio.stop();
  $('#btnPlay').classList.remove('playing');
  markDirty();
}
function togglePlay() { if (app.playing) stop(); else play(1); }
function advancePlayback() {
  const p = app.playing;
  let now;
  if (p.audio) now = p.srcBase + app.audio.now();
  else now = p.start + (performance.now() - p.wall) / 1000 * p.rate;
  if (app.view === 'program') {
    const L = app.layout();
    if (now >= L.duration) { app.T = Math.max(0, L.duration - FRAME); stop(); }
    else if (now <= 0 && p.rate < 0) { app.T = 0; stop(); }
    else app.T = Math.max(0, now);
    // warm up the next clip's scene before the cut
    const c = app.clipAt(app.T);
    if (c && c.start + c.dur - app.T < 1.2) { const i = L.clips.indexOf(c); if (L.clips[i + 1]) prepareClip(L.clips[i + 1]); }
    app.timeline.updatePlayhead(app.T); app.timeline.ensureVisible(app.T);
  } else {
    const rec = app.recs.get(app.src.key);
    if (!rec) { stop(); return; }
    if (now >= rec.duration) { app.src.t = rec.duration; stop(); } else if (now <= 0) { app.src.t = 0; stop(); } else app.src.t = now;
    updateSourceBar();
  }
  updateTimecode();
  markDirty();
}
const prepared = new WeakSet();
function prepareClip(c) {
  const rec = app.recs.get(c.rec); if (!rec) { ensureRec(c.rec); return null; }
  const st = stateFor('clip:' + c.id, rec, clipOpts(c));
  if (Math.abs((st.t ?? -1) - c.in) < 0.05 || prepared.has(c)) return null;
  prepared.add(c);
  return st.seek(c.in);
}
async function prepareAround(T) {
  const L = app.layout(), c = app.clipAt(T); if (!c) return;
  const rec = await ensureRec(c.rec).catch(() => null); if (!rec) return;
  const st = stateFor('clip:' + c.id, rec, clipOpts(c));
  await st.seek(c.in + (T - c.start));
}
app.seek = (T, view) => {
  if (view && view !== app.view) setView(view);
  const L = app.layout();
  app.T = clamp(T, 0, Math.max(0, L.duration - 1e-6));
  if (app.playing) { const r = app.playing.rate; stop(); play(r); }
  app.timeline.updatePlayhead(app.T);
  updateTimecode(); markDirty();
};
function step(n) {
  stop();
  if (app.view === 'source') { const rec = app.recs.get(app.src.key); if (!rec) return; app.src.t = clamp(Math.round(app.src.t * FPS + n) / FPS, 0, rec.duration); updateSourceBar(); markDirty(); }
  else app.seek(Math.round(app.T * FPS + n) / FPS);
  updateTimecode();
}
function jumpCut(dir) {
  const L = app.layout(); if (!L.clips.length) return;
  const pts = [...L.clips.map((c) => c.start), L.duration];
  const t = dir > 0 ? pts.find((p) => p > app.T + 1e-3) : [...pts].reverse().find((p) => p < app.T - 1e-3);
  app.seek(t ?? (dir > 0 ? L.duration : 0), 'program');
}
function updateTimecode() {
  if (app.view === 'source') { const rec = app.recs.get(app.src.key); $('#tcNow').textContent = tc(app.src.t); $('#tcEnd').textContent = rec ? tc(rec.duration) : '00:00.00'; }
  else { $('#tcNow').textContent = tc(app.T); $('#tcEnd').textContent = tc(app.layout().duration); }
  $('#rate').textContent = app.playing && app.playing.rate !== 1 ? (app.playing.rate > 0 ? '' : '◀ ') + Math.abs(app.playing.rate) + '×' : '';
}
// J / K / L shuttle
function shuttle(dir) {
  const r = app.playing ? app.playing.rate : 0;
  let nr;
  if (dir > 0) nr = r > 0 ? Math.min(8, r * 2) : 1;
  else nr = r < 0 ? Math.max(-8, r * 2) : -1;
  stop(); play(nr);
}

// ====================================================================== editing operations
app.select = (s) => { app.sel = s; app.timeline.updateSelection(); renderInspector(); markDirty(); };
// show a clip in the Program viewer (camera edits need to see it): playhead into the clip if it is elsewhere
function focusClip(c) {
  const lc = app.layout().clips.find((x) => x.id === c.id); if (!lc) return;
  if (app.view !== 'program') setView('program');
  if (app.T < lc.start || app.T >= lc.start + lc.dur) app.seek(lc.start + Math.min(0.5, lc.dur / 2));
}
app.reorderClip = (id, to) => {
  const a = app.project.clips, i = a.findIndex((c) => c.id === id); if (i < 0) return;
  const [c] = a.splice(i, 1); a.splice(clamp(to, 0, a.length), 0, c);
  layoutCache = null;
  const L = app.layout(); const lc = L.clips.find((x) => x.id === id); app.T = lc.start;
  app.commit('Reorder');
};
app.trimClip = (id, a, b, commit = true) => {
  const c = app.project.clips.find((x) => x.id === id); if (!c) return;
  const rec = app.recs.get(c.rec), D = rec ? rec.duration : (c.recDur || 1e9);
  a = clamp(a, 0, D); b = clamp(b, 0, D);
  if (b - a < 0.25) { if (a !== c.in) a = b - 0.25; else b = a + 0.25; }
  c.in = +a.toFixed(3); c.out = +b.toFixed(3);
  if (commit) app.commit('Trim clip'); else app.changed(false);
  markDirty();
};
function splitAtPlayhead() {
  if (app.view !== 'program') setView('program');
  const L = app.layout(), lc = app.clipAt(app.T); if (!lc) return;
  const local = lc.in + (app.T - lc.start);
  if (local - lc.in < 0.1 || lc.out - local < 0.1) { toast('Move the playhead inside a clip to split it'); return; }
  const c = app.project.clips.find((x) => x.id === lc.id), i = app.project.clips.indexOf(c);
  const b = JSON.parse(JSON.stringify(c)); b.id = uid();
  if (c.cam.move === 'keys' && c.cam.b) {
    const u = (app.T - lc.start) / lc.dur, mid = keyAt(c.cam, u);
    c.cam.b = JSON.parse(JSON.stringify(mid)); b.cam.a = JSON.parse(JSON.stringify(mid));
    if (c.cam.ease !== 'linear') { c.cam.ease = 'linear'; b.cam.ease = 'linear'; }
  }
  c.out = +local.toFixed(3); b.in = +local.toFixed(3);
  app.project.clips.splice(i + 1, 0, b);
  app.sel = { kind: 'clip', id: b.id };
  app.commit('Split');
  toast('Split');
}
function deleteSelection() {
  const s = app.sel; if (!s) return;
  if (s.kind === 'clip') app.project.clips = app.project.clips.filter((c) => c.id !== s.id);
  else app.project.music = app.project.music.filter((m) => m.id !== s.id);
  app.sel = null; layoutCache = null;
  app.T = Math.min(app.T, Math.max(0, app.layout().duration - FRAME));
  app.commit('Delete');
}
function addMusic(songId, start = null) {
  const L = app.layout();
  const s = start ?? (app.project.music.length ? L.musicEnd : 0);
  const len = Math.max(10, (L.duration || 30) - s);
  const m = { id: uid(), song: songId, start: +s.toFixed(3), len: +len.toFixed(3), offset: 0, vol: 0.7, fadeIn: 1, fadeOut: 2 };
  app.project.music.push(m);
  app.sel = { kind: 'music', id: m.id };
  app.commit('Add music');
  toast(`Added ${app.songOf(songId).name} to the music lane`);
}

// ====================================================================== viewport camera editing
let vdrag = null;
function editKey(c) { return c.cam.move === 'keys' && c.cam.b && c.cam.edit === 'b' ? c.cam.b : c.cam.a; }
function editableClip() {
  if (app.view !== 'program') return null;
  const lc = app.clipAt(app.T); if (!lc) return null;
  const c = app.project.clips.find((x) => x.id === lc.id);
  return c && app.recs.get(c.rec) ? c : null;
}
function snapToKey(c) {
  // while editing the start / end key, show that moment
  if (c.cam.move !== 'keys' || !c.cam.b) return;
  if (app.view !== 'program') setView('program');
  const lc = app.layout().clips.find((x) => x.id === c.id);
  app.seek(c.cam.edit === 'b' ? lc.start + lc.dur - FRAME : lc.start);
}
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  const c = editableClip();
  if (!c) return;
  if (app.sel?.id !== c.id) app.select({ kind: 'clip', id: c.id });
  const m = c.cam.mode;
  if (m === 'auto' || m === 'pov') { toast('This clip uses the ' + camTag(m).toLowerCase() + ' camera. Pick Free, Follow or Look at in the inspector to move it.'); return; }
  stop();
  snapToKey(c);
  canvas.setPointerCapture(e.pointerId);
  vdrag = { c, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, pan: e.button === 2 || e.shiftKey, moved: false };
});
canvas.addEventListener('pointermove', (e) => {
  if (!vdrag) { hoverPick(e); return; }
  const dx = e.clientX - vdrag.x, dy = e.clientY - vdrag.y;
  vdrag.x = e.clientX; vdrag.y = e.clientY;
  if (Math.abs(e.clientX - vdrag.x0) + Math.abs(e.clientY - vdrag.y0) > 3) vdrag.moved = true;
  if (!vdrag.moved) return;
  const c = vdrag.c, key = editKey(c), m = c.cam.mode;
  const scale = 960 / canvas.clientWidth;
  if (vdrag.pan) panKey(m, key, dx * scale, dy * scale, camera);
  else orbitKey(m, key, dx, dy, pivotFor(c));
  markDirty();
});
canvas.addEventListener('pointerup', (e) => {
  if (!vdrag) return;
  const d = vdrag; vdrag = null;
  if (d.moved) { app.commit('Move camera'); return; }
  // a click: pick a ship as the target
  if (d.c.cam.mode === 'follow' || d.c.cam.mode === 'lookat') {
    const hit = pickAt(e);
    if (hit) { setTarget(d.c, String(hit.id)); toast(`Camera target: ${hit.label}`); }
  }
});
canvas.addEventListener('wheel', (e) => {
  const c = editableClip(); if (!c) return;
  if (c.cam.mode === 'auto' || c.cam.mode === 'pov') return;
  e.preventDefault();
  snapToKey(c);
  const key = editKey(c);
  if (e.altKey) key.fov = clamp(Math.round(key.fov + Math.sign(e.deltaY) * 2), 10, 110);
  else dollyKey(c.cam.mode, key, e.deltaY, pivotFor(c));
  markDirty();
  clearTimeout(wheelTimer); wheelTimer = setTimeout(() => app.commit('Zoom camera'), 400);
}, { passive: false });
let wheelTimer = null;
function pivotFor(c) {
  const s = lastShot; if (!s || !s.rec) return null;
  return targetAt(s.rec, c.cam.target, s.t, c.cam.damping);
}
function setTarget(c, id) {
  const v = viewFor(c);
  c.cam.target = id;
  // keep the shot sensible: re-derive the key from the current view relative to the new target
  if (v) { const k = keyFromView(c.cam.mode, v.camera, v.rec, c.cam, v.t); Object.assign(editKey(c), c.cam.mode === 'follow' ? { dist: followDist(v.rec, id), az: k.az, el: k.el } : { pos: k.pos }); }
  app.commit('Camera target');
}
const _v = new THREE.Vector3();
function pickAt(e) {
  const s = lastShot; if (!s || !s.state) return null;
  const r = canvas.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  let best = null, bd = 26;
  for (const p of s.state.pickables()) {
    _v.setFromMatrixPosition(p.obj.matrixWorld).project(camera);
    if (_v.z > 1) continue;
    const sx = (_v.x + 1) / 2 * r.width, sy = (1 - _v.y) / 2 * r.height, d = Math.hypot(sx - x, sy - y);
    if (d < bd) { bd = d; best = { id: p.id, sx, sy, label: `${p.id === s.rec.playerShipId ? 'Player ship' : 'Ship #' + p.id}` }; }
  }
  return best;
}
function hoverPick(e) {
  const ring = $('#pickRing'), c = editableClip();
  if (!c || (c.cam.mode !== 'follow' && c.cam.mode !== 'lookat')) { ring.style.display = 'none'; canvas.style.cursor = c && c.cam.mode !== 'auto' && c.cam.mode !== 'pov' ? 'grab' : ''; return; }
  const hit = pickAt(e);
  if (hit) { ring.style.display = ''; ring.style.left = hit.sx + 'px'; ring.style.top = hit.sy + 'px'; ring.dataset.label = 'Click: ' + (c.cam.mode === 'follow' ? 'follow ' : 'look at ') + hit.label; canvas.style.cursor = 'pointer'; }
  else { ring.style.display = 'none'; canvas.style.cursor = 'grab'; }
}

// ====================================================================== inspector
const ui = {
  section(title, tip) { const s = el('section', 'insp-sec'); const h = el('h4', null, title); if (tip) h.dataset.tip = tip; s.append(h); return s; },
  row(label, ctrl, tip) { const r = el('div', 'row'); const l = el('label', null, label); if (tip) r.dataset.tip = tip; r.append(l, ctrl); return r; },
  slider({ min, max, step, value, fmt = (v) => v, onInput, onChange }) {
    const w = el('div', 'slider'); const i = el('input'); i.type = 'range'; i.min = min; i.max = max; i.step = step; i.value = value;
    const o = el('output', null, fmt(+value));
    i.oninput = () => { o.textContent = fmt(+i.value); onInput && onInput(+i.value); };
    i.onchange = () => onChange && onChange(+i.value);
    w.append(i, o); return w;
  },
  toggle(on, onChange, label = '') { const l = el('label', 'switch'); const i = el('input'); i.type = 'checkbox'; i.checked = !!on; i.onchange = () => onChange(i.checked); l.append(i, el('span', 'knob'), el('span', 'sw-l', label)); return l; },
  seg(opts, value, onChange) {
    const d = el('div', 'seg');
    for (const o of opts) { const b = el('button', o.id === value ? 'on' : '', o.label); if (o.tip) b.dataset.tip = o.tip; b.onclick = () => onChange(o.id); d.append(b); }
    return d;
  },
  select(opts, value, onChange) { const s = el('select'); for (const o of opts) { const op = el('option', null, o.label); op.value = o.id; if (o.id === value) op.selected = true; s.append(op); } s.onchange = () => onChange(s.value); return s; },
  btn(label, onClick, tip, cls = '') { const b = el('button', cls, label); b.onclick = onClick; if (tip) b.dataset.tip = tip; return b; },
  time(value, onChange) {
    const i = el('input', 'time'); i.value = tc(value); i.spellcheck = false;
    i.onchange = () => { const v = parseTc(i.value); if (v === null) { i.value = tc(value); return; } onChange(v); };
    i.onkeydown = (e) => { if (e.key === 'Enter') i.blur(); e.stopPropagation(); };
    return i;
  },
};
function parseTc(s) {
  const m = String(s).trim().match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/) || String(s).trim().match(/^(\d+):(\d+)\.(\d+)$/);
  if (!m) return null;
  if (m.length === 4 && m[3] !== undefined && String(s).split(':').length === 2 && /\.\d{2}$/.test(s)) { const [mm, rest] = s.split(':'); const [ss, ff] = rest.split('.'); return +mm * 60 + +ss + +ff / FPS; }
  return (m[1] ? +m[1] * 60 : 0) + +m[2];
}
function renderInspector() {
  const box = $('#inspector'); if (!box) return;
  box.innerHTML = '';
  const s = app.sel && findSel(app.sel);
  if (!s) return renderProjectInspector(box);
  if (app.sel.kind === 'music') return renderMusicInspector(box, s);
  renderClipInspector(box, s);
}
function renderProjectInspector(box) {
  const L = app.layout();
  const sec = ui.section('Project');
  sec.append(ui.row('Length', el('span', 'val', `${tc(L.duration)} · ${L.clips.length} clip${L.clips.length === 1 ? '' : 's'}`)));
  sec.append(ui.row('Music', el('span', 'val', L.music.length ? L.music.map((m) => app.songOf(m.song).name).join(', ') : 'none')));
  box.append(sec);
  const help = ui.section('Getting started');
  help.append(el('p', 'muted', '1. Click a session on the left. 2. In the Source viewer, scrub (or click a highlighted best moment), press I and O to mark the clip. 3. Enter adds it to the timeline. 4. Click a clip to set its camera, UI and sound here. 5. Add a song from Music. 6. Export.'));
  box.append(help);
  const keys = ui.section('Keyboard');
  const tbl = el('div', 'keys');
  for (const [k, d] of [['Space', 'Play / pause'], ['J K L', 'Reverse / stop / forward (again = faster)'], ['← →', 'One frame (Shift: 1 s)'], ['↑ ↓', 'Previous / next cut'], ['I  O', 'Mark in / out (Source)'], ['Enter', 'Add to timeline'], ['S', 'Split clip at playhead'], ['Del', 'Delete selected'], ['Ctrl+Z', 'Undo (Ctrl+Y redo)'], ['Ctrl+S', 'Save project'], ['Ctrl+E', 'Export'], ['Tab', 'Source / Program'], ['+ −', 'Zoom timeline']]) { tbl.append(el('kbd', null, k), el('span', null, d)); }
  keys.append(tbl); box.append(keys);
}
function renderMusicInspector(box, m) {
  const song = app.songOf(m.song);
  const sec = ui.section('Music · ' + song.name, song.desc);
  const set = (k, commit) => (v) => { m[k] = v; if (commit) app.commit('Music'); else app.changed(false); };
  sec.append(ui.row('Song', ui.select(SONGS.map((x) => ({ id: x.id, label: x.name })), m.song, (v) => { m.song = v; app.commit('Change song'); })));
  sec.append(ui.row('Volume', ui.slider({ min: 0, max: 1.5, step: 0.01, value: m.vol, fmt: (v) => Math.round(v * 100) + '%', onInput: set('vol'), onChange: set('vol', true) })));
  sec.append(ui.row('Fade in', ui.slider({ min: 0, max: 10, step: 0.1, value: m.fadeIn, fmt: (v) => v.toFixed(1) + ' s', onInput: set('fadeIn'), onChange: set('fadeIn', true) })));
  sec.append(ui.row('Fade out', ui.slider({ min: 0, max: 10, step: 0.1, value: m.fadeOut, fmt: (v) => v.toFixed(1) + ' s', onInput: set('fadeOut'), onChange: set('fadeOut', true) })));
  sec.append(ui.row('Starts at', ui.time(m.start, (v) => { m.start = Math.max(0, v); app.commit('Music'); }), 'Position on the timeline'));
  sec.append(ui.row('Length', ui.time(m.len, (v) => { m.len = Math.max(0.5, v); app.commit('Music'); }), 'Loops if longer than the song'));
  sec.append(ui.row('Song offset', ui.time(m.offset || 0, (v) => { m.offset = Math.max(0, v); app.commit('Music'); }), 'Start this far into the song'));
  const r = el('div', 'btns');
  r.append(ui.btn('Fit to edit', () => { m.start = 0; m.len = Math.max(1, app.layout().duration); app.commit('Fit music'); }, 'Make the song span the whole edit'),
    ui.btn('Delete', deleteSelection, 'Delete (Del)', 'danger'));
  sec.append(r);
  box.append(sec);
}
function renderClipInspector(box, c) {
  const rec = app.recs.get(c.rec);
  const L = app.layout(), lc = L.clips.find((x) => x.id === c.id), idx = L.clips.indexOf(lc);
  // ---- clip
  const s1 = ui.section(`Clip ${idx + 1} · ${app.recLabel(c.rec)}`, rec ? rec.manifest.title : '');
  s1.append(ui.row('In', ui.time(c.in, (v) => app.trimClip(c.id, v, c.out)), 'Start time in the recording'));
  s1.append(ui.row('Out', ui.time(c.out, (v) => app.trimClip(c.id, c.in, v)), 'End time in the recording'));
  s1.append(ui.row('Length', el('span', 'val', (c.out - c.in).toFixed(2) + ' s')));
  const b1 = el('div', 'btns');
  b1.append(ui.btn('Open in Source', () => app.openClipInSource(c.id), 'See this part of the session (double-click the clip)'), ui.btn('Split (S)', splitAtPlayhead, 'Split at the playhead'), ui.btn('Delete', deleteSelection, 'Delete (Del)', 'danger'));
  s1.append(b1);
  if (!rec) s1.append(el('p', 'warn', app.loading.has(c.rec) ? 'Loading the recording…' : `Recording ${c.rec} is not loaded.`));
  box.append(s1);
  // ---- camera
  const cam = c.cam;
  const s2 = ui.section('Camera');
  s2.addEventListener('pointerdown', () => focusClip(c), true);
  s2.append(ui.seg(CAM_MODES, cam.mode, (m) => switchMode(c, m)));
  const mdesc = CAM_MODES.find((x) => x.id === cam.mode);
  s2.append(el('p', 'muted small', mdesc.tip));
  const live = (fn) => (v) => { fn(v); markDirty(); };
  if (cam.mode === 'auto') {
    s2.append(ui.row('Framing', ui.slider({ min: 0, max: 1, step: 0.05, value: cam.framing, fmt: (v) => (v <= 0.02 ? 'Room' : v >= 0.98 ? 'Fight' : v === 0.5 ? 'Medium' : Math.round(v * 100) + '%'), onInput: live((v) => { cam.framing = v; }), onChange: () => app.commit('Framing') }), 'Room = the whole battle box, Fight = just the ships, Medium = halfway (the highlight look)'));
    const b = el('div', 'btns');
    b.append(ui.btn('New shot order', () => { cam.seed = (cam.seed * 7 + 13) % 997; app.commit('Shuffle shots'); }, 'Same rules, different cuts and angles'), ui.btn('Use this view as Free camera', () => convertToFree(c), 'Copy the current auto shot into a Free camera you can adjust'));
    s2.append(b);
  }
  if (cam.mode === 'follow' || cam.mode === 'lookat') {
    const targets = rec ? rec.targetsFor(c.in, c.out) : [{ id: cam.target, label: cam.target }];
    if (!targets.some((t) => t.id === cam.target)) targets.push({ id: cam.target, label: 'Ship #' + cam.target });
    const sel = ui.select(targets, cam.target, (v) => setTarget(c, v));
    s2.append(ui.row('Target', sel, 'What the camera ' + (cam.mode === 'follow' ? 'is attached to' : 'looks at') + '. You can also click a ship in the viewer.'));
    s2.append(ui.row('Damping', ui.slider({ min: 0, max: 1.5, step: 0.05, value: cam.damping, fmt: (v) => (v < 0.01 ? 'rigid' : v.toFixed(2) + ' s'), onInput: live((v) => { cam.damping = v; }), onChange: () => app.commit('Damping') }), 'How softly the camera tracks the target (0 = locked on)'));
    if (cam.mode === 'follow') s2.append(ui.row('Turn with target', ui.toggle(cam.rotate, (on) => { focusClip(c); const v = viewFor(c); cam.rotate = on; if (on) { for (const k of [cam.a, cam.b].filter(Boolean)) { k.az = Math.PI; k.el = 0.22; } } else if (v) { const k = keyFromView('follow', v.camera, v.rec, cam, v.t); editKey(c).az = k.az; } app.commit('Turn with target'); }), 'Stay behind the target as it turns (chase cam) instead of a fixed compass direction'));
  }
  if (cam.mode !== 'auto') {
    if (cam.mode !== 'pov') {
      s2.append(ui.row('Movement', ui.seg([{ id: 'static', label: 'Static', tip: 'One camera for the whole clip' }, { id: 'keys', label: 'Start → End', tip: 'Set a start and an end camera; it eases between them' }], cam.move, (v) => {
        cam.move = v;
        if (v === 'keys' && !cam.b) cam.b = JSON.parse(JSON.stringify(cam.a));
        cam.edit = v === 'keys' ? 'b' : 'a';
        app.commit('Movement'); snapToKey(c);
      })));
      if (cam.move === 'keys') {
        s2.append(ui.row('Editing', ui.seg([{ id: 'a', label: '◆ Start', tip: 'Adjust the start camera (jumps to the clip start)' }, { id: 'b', label: 'End ◆', tip: 'Adjust the end camera (jumps to the clip end)' }], cam.edit, (v) => { cam.edit = v; renderInspector(); snapToKey(c); markDirty(); })));
        s2.append(ui.row('Ease', ui.select([{ id: 'smooth', label: 'Smooth (ease in / out)' }, { id: 'linear', label: 'Linear' }], cam.ease, (v) => { cam.ease = v; app.commit('Ease'); })));
        const b = el('div', 'btns');
        b.append(ui.btn('Start = End', () => { cam.b = JSON.parse(JSON.stringify(cam.a)); app.commit('Copy key'); }, 'Copy the start camera to the end'), ui.btn('Swap', () => { const t = cam.a; cam.a = cam.b; cam.b = t; app.commit('Swap keys'); }, 'Swap start and end'));
        s2.append(b);
      }
    }
    const k = editKey(c);
    s2.append(ui.row('Field of view', ui.slider({ min: 10, max: 110, step: 1, value: k.fov, fmt: (v) => v + '°', onInput: live((v) => { editKey(c).fov = v; }), onChange: () => app.commit('Field of view') }), 'Lens: small = telephoto (flatter, closer), large = wide angle. Alt+wheel in the viewer.'));
    s2.append(ui.row('Level horizon', ui.toggle(cam.level, (v) => { cam.level = v; app.commit('Level horizon'); }), 'Keep the horizon level (on by default)'));
    if (!cam.level && cam.mode !== 'pov') s2.append(ui.row('Roll', ui.slider({ min: -45, max: 45, step: 1, value: k.roll || 0, fmt: (v) => v + '°', onInput: live((v) => { editKey(c).roll = v; }), onChange: () => app.commit('Roll') }), 'Dutch angle'));
    if (cam.mode !== 'pov') {
      const b = el('div', 'btns');
      b.append(ui.btn('Re-aim from view', () => { focusClip(c); const v = viewFor(c); if (!v) return; Object.assign(editKey(c), keyFromView(cam.mode, v.camera, v.rec, cam, v.t)); app.commit('Re-aim camera'); }, 'Rebuild this key from what the viewer shows now'));
      s2.append(b);
    }
  }
  box.append(s2);
  // ---- display
  const s3 = ui.section('Display');
  s3.append(ui.row('UI panels', ui.toggle(c.ui, (v) => { c.ui = v; app.commit(v ? 'UI on' : 'UI off'); }), 'Menus, the score ring, popups, the wrist HUD and the laser cursor'));
  s3.append(ui.row('Hands', ui.toggle(c.hands, (v) => { c.hands = v; app.commit(v ? 'Hands on' : 'Hands off'); }), 'The player’s controllers'));
  s3.append(ui.row('Bold ships', ui.toggle(c.bold !== false, (v) => { c.bold = v; app.commit('Bold ships'); }), 'Draw ships with thicker, brighter lines so they read in wide shots (the highlight look)'));
  box.append(s3);
  // ---- audio
  const s4 = ui.section('Sound');
  s4.append(ui.row('Game audio', ui.slider({ min: 0, max: 1.5, step: 0.01, value: c.vol, fmt: (v) => (v === 0 ? 'muted' : Math.round(v * 100) + '%'), onInput: (v) => { c.vol = v; app.changed(false); }, onChange: () => app.commit('Clip volume') }), 'The recording’s own sound for this clip'));
  if (rec && hasGameMusic(rec.manifest.version)) s4.append(el('p', 'note', 'This recording’s sound has the in-game music mixed into the effects (the recorder captured the game’s final mix). Lower Game audio here if it clashes with your music track.'));
  else if (rec) s4.append(el('p', 'muted small', 'This build had no music: its sound is effects only.'));
  const b4 = el('div', 'btns');
  b4.append(ui.btn('All clips: this volume', () => { for (const x of app.project.clips) x.vol = c.vol; app.commit('Volume for all clips'); }, 'Use this game-audio level on every clip'));
  s4.append(b4);
  box.append(s4);
}
// a follow distance that frames a ship: about eight ship lengths (the room for the head / room targets)
function followDist(rec, target) { return target === 'room' ? 1.4 : target === 'head' ? 0.8 : Math.max(0.08, 8 * rec.shipLen); }
// the clip's camera as it is now, at the playhead (or near the clip start if the playhead is elsewhere)
function viewFor(c) {
  const rec = app.recs.get(c.rec); if (!rec) return null;
  const lc = app.layout().clips.find((x) => x.id === c.id); if (!lc) return null;
  const T = app.T >= lc.start && app.T < lc.start + lc.dur ? app.T : lc.start + Math.min(0.5, lc.dur / 2);
  const t = c.in + (T - lc.start);
  const cam = new THREE.PerspectiveCamera(40, 16 / 9, 0.01, 1000);
  applyCamera(cam, c.cam, rec, t, (T - lc.start) / lc.dur, { tIn: c.in, tOut: c.out, aspect: 16 / 9 });
  return { rec, t, camera: cam };
}
function switchMode(c, m) {
  if (c.cam.mode === m) return;
  focusClip(c);
  const v = viewFor(c);
  const prev = c.cam.mode;
  if (m === 'pov') { c.cam.mode = m; c.cam.a.fov = 80; c.cam.move = 'static'; if (!c.ui) toast('Tip: turn UI panels on to see the menus the player saw'); }
  else if (m !== 'auto' && v) {
    // carry the current view over so the shot does not jump
    c.cam.mode = m;
    if ((m === 'follow' || m === 'lookat') && c.cam.target === 'player-ship' && !v.rec.visibleAt('player-ship', v.t)) c.cam.target = 'room';
    const k = keyFromView(m, v.camera, v.rec, c.cam, v.t);
    if (m === 'follow' && prev !== 'follow') k.dist = followDist(v.rec, c.cam.target);
    c.cam.a = { ...c.cam.a, ...k };
    if (c.cam.b) c.cam.b = JSON.parse(JSON.stringify(c.cam.a));
  } else c.cam.mode = m;
  app.commit('Camera: ' + camTag(m).toLowerCase());
}
function convertToFree(c) {
  focusClip(c);
  const v = viewFor(c); if (!v) return;
  const k = keyFromView('free', v.camera, v.rec, c.cam, v.t);
  c.cam.mode = 'free'; c.cam.move = 'static'; c.cam.a = { ...c.cam.a, ...k };
  app.commit('Free camera from auto shot');
}

// ====================================================================== thumbnails
let thumbBusy = false;
const thumbSig = (c) => JSON.stringify([c.rec, c.in, c.cam, c.ui, c.hands, c.bold]);
function queueThumbs() { setTimeout(runThumbQueue, 50); }
async function runThumbQueue() {
  if (thumbBusy || app.playing || app.exporting || drawing || vdrag) return;
  const c = app.project.clips.find((x) => app.recs.has(x.rec) && (!app.thumbs.has(x.id) || app.thumbs.get(x.id).sig !== thumbSig(x)));
  if (!c) return;
  thumbBusy = true; drawing = true;
  try {
    const rec = app.recs.get(c.rec), sig = thumbSig(c);
    const lc = app.layout().clips.find((x) => x.id === c.id);
    const st = stateFor('thumb:' + rec.key, rec, clipOpts(c));
    const t = c.in + Math.min(0.5, (c.out - c.in) / 2);
    await st.seek(t);
    const tw = 256, th = 144;
    renderer.setSize(tw, th, false); st.setSize(tw, th); st.pose(t);
    applyCamera(camera, c.cam, rec, t, lc ? (t - c.in) / lc.dur : 0, { tIn: c.in, tOut: c.out, aspect: 16 / 9 });
    renderer.render(st.scene, camera);
    const cv = document.createElement('canvas'); cv.width = tw; cv.height = th;
    cv.getContext('2d').drawImage(renderer.domElement, 0, 0, tw, th);
    const url = cv.toDataURL('image/jpeg', 0.8);
    app.thumbs.set(c.id, { url, sig });
  } catch (e) { console.warn('thumb', e); app.thumbs.set(c.id, { url: '', sig: thumbSig(c) }); }
  finally { renderer.setSize(RW, RH, false); drawing = false; thumbBusy = false; markDirty(); app.timeline.render(); setTimeout(runThumbQueue, 30); }
}

// ====================================================================== project save / open
async function saveProject() {
  const name = (app.project.name || 'edit').replace(/[^\w\- .()]+/g, '_').trim() || 'edit';
  const body = JSON.stringify(app.project, null, 1);
  if (app.server) {
    const r = await fetch('/api/project?name=' + encodeURIComponent(name), { method: 'POST', body });
    if (r.ok) { const j = await r.json(); toast('Saved: ' + j.path); $('#saveState').textContent = 'Saved ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); return; }
  }
  download(new Blob([body], { type: 'application/json' }), name + '.crproj.json');
}
async function openDialog() {
  const m = modal('Open project');
  const list = el('div', 'proj-list');
  if (app.server) {
    try {
      const j = await (await fetch('/api/projects', { cache: 'no-store' })).json();
      if (!j.projects.length) list.append(el('p', 'muted', 'No saved projects in footage\\projects yet.'));
      for (const p of j.projects) {
        const b = ui.btn(`${p.name}  ·  ${new Date(p.mtime * 1000).toLocaleString()}`, async () => { const pj = await (await fetch('/api/project?name=' + encodeURIComponent(p.name))).json(); loadProject(pj); m.close(); }, 'Open', 'wide');
        list.append(b);
      }
    } catch (e) { list.append(el('p', 'warn', 'Could not list projects')); }
  }
  m.body.append(list);
  const f = el('input'); f.type = 'file'; f.accept = '.json,application/json'; f.style.display = 'none';
  f.onchange = async () => { try { loadProject(JSON.parse(await f.files[0].text())); m.close(); } catch (e) { toast('Not a project file', true); } };
  m.body.append(f);
  const b = el('div', 'btns');
  b.append(ui.btn('Open a file…', () => f.click(), 'A .crproj.json you saved or downloaded'), ui.btn('Cancel', () => m.close()));
  m.body.append(b);
}
function loadProject(p) {
  if (!p || !Array.isArray(p.clips)) { toast('Not a project file', true); return; }
  stop();
  const base = newProject();
  app.project = { ...base, ...p, settings: { ...base.settings, ...(p.settings || {}) } };
  for (const c of app.project.clips) { c.cam = { ...defaultCam(), ...c.cam, a: { ...defaultCam().a, ...(c.cam && c.cam.a) } }; if (c.vol === undefined) c.vol = 1; }
  app.sel = null; app.T = 0; layoutCache = null;
  resetHistory(); autosave(); syncProjectUI(); app.changed(); app.timeline.fit(); setView('program');
  for (const k of new Set(app.project.clips.map((c) => c.rec))) ensureRec(k).catch(() => {});
  queueThumbs();
}
function syncProjectUI() { $('#projName').value = app.project.name || 'Untitled edit'; }
function download(blob, name) { const a = el('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000); }

// ====================================================================== export
async function exportDialog() {
  stop();
  const L = app.layout();
  if (!L.clips.length) { toast('Add some clips first'); return; }
  const missing = [...new Set(L.clips.map((c) => c.rec))].filter((k) => !app.recs.has(k));
  const m = modal('Export video');
  const st = app.project.settings;
  const caps = await exportCapabilities();
  const f = el('div', 'form');
  const name = el('input'); name.value = (app.project.name || 'edit').replace(/[^\w\- .()]+/g, '_');
  f.append(ui.row('File name', name));
  const resSel = ui.seg([{ id: '1080', label: '1080p' }, { id: '720', label: '720p' }], st.res, (v) => { st.res = v; refresh(); });
  const fpsSel = ui.seg([{ id: 60, label: '60 fps' }, { id: 30, label: '30 fps' }], st.fps, (v) => { st.fps = v; refresh(); });
  const fmtSel = ui.seg([{ id: 'mp4', label: 'MP4', tip: 'H.264 video: plays everywhere' }, { id: 'webm', label: 'WebM', tip: 'VP9 + Opus' }], st.format, (v) => { st.format = v; refresh(); });
  const qSel = ui.seg([{ id: 'high', label: 'High' }, { id: 'standard', label: 'Standard' }, { id: 'small', label: 'Small' }], st.quality, (v) => { st.quality = v; refresh(); });
  const holder = el('div');
  f.append(holder);
  const info = el('p', 'muted small');
  function refresh() {
    holder.innerHTML = '';
    holder.append(ui.row('Resolution', ui.seg([{ id: '1080', label: '1080p' }, { id: '720', label: '720p' }], st.res, (v) => { st.res = v; refresh(); })),
      ui.row('Frame rate', ui.seg([{ id: 60, label: '60 fps' }, { id: 30, label: '30 fps' }], st.fps, (v) => { st.fps = v; refresh(); })),
      ui.row('Format', ui.seg([{ id: 'mp4', label: 'MP4', tip: 'H.264 video: plays everywhere' }, { id: 'webm', label: 'WebM', tip: 'VP9 + Opus' }], st.format, (v) => { st.format = v; refresh(); })),
      ui.row('Quality', ui.seg([{ id: 'high', label: 'High' }, { id: 'standard', label: 'Standard' }, { id: 'small', label: 'Small' }], st.quality, (v) => { st.quality = v; refresh(); })));
    const mb = mbps(st);
    const v = st.format === 'mp4' ? (caps.avc ? 'H.264' : 'no H.264 encoder') : (caps.vp ? (caps.vp.startsWith('vp8') ? 'VP8' : 'VP9') : 'no VP9 encoder');
    const a = st.format === 'mp4' ? (caps.aac ? 'AAC' : caps.opus ? 'Opus (this browser has no AAC encoder)' : 'no audio encoder') : (caps.opus ? 'Opus' : 'no audio encoder');
    info.textContent = `${L.clips.length} clips · ${tc(L.duration)} · ${v} ${mb} Mbit/s + ${a} · about ${Math.round(L.duration * mb / 8 + L.duration * 0.02)} MB` + (app.server ? ' · saved to footage\\edits' : '');
  }
  void resSel; void fpsSel; void fmtSel; void qSel;
  refresh();
  f.append(info);
  if (!caps.webcodecs) f.append(el('p', 'warn', 'This browser cannot encode video (no WebCodecs). Open the editor in Chrome or Edge.'));
  if (missing.length) f.append(el('p', 'warn', 'Still loading: ' + missing.join(', ')));
  m.body.append(f);
  const prog = el('div', 'export-prog'); prog.style.display = 'none';
  const bar = el('div', 'bar big'); const fill = el('i'); bar.append(fill);
  const ptxt = el('div', 'muted small');
  prog.append(bar, ptxt);
  m.body.append(prog);
  const result = el('div', 'export-result');
  m.body.append(result);
  const btns = el('div', 'btns');
  const go = ui.btn('Export', null, 'Render every frame and encode (Ctrl+E)', 'primary');
  const cancel = ui.btn('Close', () => { if (ctl) ctl.abort(); else m.close(); });
  btns.append(go, cancel);
  m.body.append(btns);
  let ctl = null;
  go.onclick = async () => {
    if (!caps.webcodecs) return;
    for (const k of missing) await ensureRec(k);
    app.project.name = name.value || app.project.name; autosave();
    go.disabled = true; f.style.opacity = 0.5; f.style.pointerEvents = 'none';
    prog.style.display = ''; result.innerHTML = '';
    cancel.textContent = 'Cancel';
    ctl = new AbortController();
    try {
      const out = await runExport({ ...st, name: name.value }, (p, i) => {
        fill.style.width = (p * 100).toFixed(1) + '%';
        ptxt.textContent = i.stage ? i.stage : `Frame ${i.frame} / ${i.frames} · ${i.fps.toFixed(1)} fps · about ${fmtTime(i.eta)} left`;
      }, ctl.signal);
      fill.style.width = '100%';
      ptxt.textContent = `Done in ${fmtTime(out.secs)} · ${(out.blob.size / 1e6).toFixed(1)} MB · ${out.vcodec} + ${out.acodec || 'no audio'}`;
      const url = URL.createObjectURL(out.blob);
      const v = el('video'); v.src = url; v.controls = true; v.className = 'export-video';
      const dl = el('a', 'button primary', 'Download'); dl.href = url; dl.download = out.fileName;
      result.append(v);
      if (out.savedPath) result.append(el('p', 'ok', 'Saved to ' + out.savedPath));
      result.append(dl);
    } catch (e) {
      if (e.name === 'AbortError') ptxt.textContent = 'Cancelled.';
      else { console.error(e); ptxt.textContent = 'Export failed: ' + e.message; toast('Export failed: ' + e.message, true); }
    } finally {
      ctl = null; go.disabled = false; f.style.opacity = ''; f.style.pointerEvents = ''; cancel.textContent = 'Close';
    }
  };
}
const mbps = (st) => { const base = st.res === '720' ? { high: 9, standard: 6, small: 3.5 } : { high: 16, standard: 10, small: 6 }; return Math.round(base[st.quality] * (st.fps === 30 ? 0.65 : 1) * 10) / 10; };
async function runExport(st, onProgress, signal) {
  const L = app.layout();
  const W = st.res === '720' ? 1280 : 1920, H = st.res === '720' ? 720 : 1080, fps = +st.fps;
  for (const k of new Set(L.clips.map((c) => c.rec))) await ensureRec(k);
  onProgress(0, { stage: 'Mixing audio…' });
  const audio = await app.audio.render(L, app.recs).catch((e) => { console.warn('audio mix failed', e); return null; });
  app.exporting = true;
  document.body.classList.add('exporting');
  renderer.setSize(W, H, false);
  try {
    const out = await exportVideo({
      W, H, fps, format: st.format, mbps: mbps(st), duration: L.duration, audio, signal,
      onProgress,
      renderFrame: async (i, T) => {
        const c = app.clipAt(T);
        const rec = app.recs.get(c.rec);
        const t = c.in + (T - c.start);
        const state = stateFor('clip:' + c.id, rec, clipOpts(c));
        await state.seek(t);
        state.setSize(W, H);
        state.pose(t);
        applyCamera(camera, c.cam, rec, t, (T - c.start) / c.dur, { tIn: c.in, tOut: c.out, aspect: W / H, dt: 1 / fps });
        renderer.render(state.scene, camera);
        if (i % 15 === 0) { app.T = T; app.timeline.updatePlayhead(T); $('#tcNow').textContent = tc(T); }
        return renderer.domElement;
      },
    });
    out.fileName = `${st.name || 'edit'}.${out.ext}`;
    if (app.server) {
      onProgress(1, { stage: 'Saving to footage\\edits…' });
      const r = await fetch('/api/export?name=' + encodeURIComponent(out.fileName), { method: 'POST', body: out.blob });
      if (r.ok) { const j = await r.json(); out.savedPath = j.path; out.fileName = j.name; }
    }
    return out;
  } finally {
    app.exporting = false;
    document.body.classList.remove('exporting');
    fitViewport();
    markDirty();
  }
}
app.runExport = runExport;

// ====================================================================== little UI helpers
function modal(title) {
  const back = el('div', 'modal-back'), box = el('div', 'modal');
  const h = el('div', 'modal-h'); h.append(el('h3', null, title));
  const x = el('button', 'x', '×'); h.append(x);
  const body = el('div', 'modal-b');
  box.append(h, body); back.append(box); document.body.append(back);
  const close = () => back.remove();
  x.onclick = close;
  back.addEventListener('pointerdown', (e) => { if (e.target === back && !app.exporting) close(); });
  return { body, close };
}
let toastTimer = null;
function toast(msg, bad = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = ''; }, bad ? 6000 : 2600);
}
app.toast = toast;
// tooltips: any element with data-tip
{
  const tip = $('#tip'); let tt = null, cur = null;
  document.addEventListener('pointerover', (e) => {
    const t = e.target.closest('[data-tip]');
    if (t === cur) return;
    cur = t; clearTimeout(tt); tip.classList.remove('show');
    if (!t) return;
    tt = setTimeout(() => {
      tip.textContent = t.dataset.tip;
      const r = t.getBoundingClientRect();
      tip.classList.add('show');
      const w = tip.offsetWidth, hh = tip.offsetHeight;
      let x = clamp(r.left + r.width / 2 - w / 2, 6, innerWidth - w - 6), y = r.bottom + 8;
      if (y + hh > innerHeight - 6) y = r.top - hh - 8;
      tip.style.left = x + 'px'; tip.style.top = y + 'px';
    }, 450);
  });
  document.addEventListener('pointerdown', () => { clearTimeout(tt); tip.classList.remove('show'); });
}

// ====================================================================== music panel
function renderSongs() {
  const box = $('#songs'); box.innerHTML = '';
  for (const s of SONGS) {
    const row = el('div', 'song'); row.style.setProperty('--c', s.color);
    row.draggable = true;
    row.ondragstart = (e) => { e.dataTransfer.setData('text/x-cr-song', s.id); e.dataTransfer.effectAllowed = 'copy'; };
    const play = ui.btn('▶', async () => {
      if (app.audio.aud && app.audio.aud.id === s.id) { app.audio.stopAudition(); play.textContent = '▶'; return; }
      for (const b of document.querySelectorAll('.song .aud')) b.textContent = '▶';
      play.textContent = '■'; await app.audio.audition(s.id);
    }, 'Listen', 'aud');
    const txt = el('div', 'song-t'); txt.append(el('b', null, s.name), el('span', null, s.desc));
    const add = ui.btn('+', () => addMusic(s.id), 'Add to the music lane (or drag it onto the timeline)', 'add');
    row.append(play, txt, add);
    box.append(row);
  }
}

// ====================================================================== drag and drop zips / songs
document.addEventListener('dragover', (e) => {
  if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('text/x-cr-song')) { e.preventDefault(); document.body.classList.toggle('dropping', e.dataTransfer.types.includes('Files')); }
});
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
document.addEventListener('drop', async (e) => {
  document.body.classList.remove('dropping');
  const song = e.dataTransfer.getData('text/x-cr-song');
  if (song) { e.preventDefault(); const lane = e.target.closest('#timeline'); addMusic(song, lane ? app.timeline.snapT(app.timeline.tAt(e.clientX)) : null); return; }
  const files = [...e.dataTransfer.files].filter((f) => /\.zip$/i.test(f.name));
  if (!files.length) return;
  e.preventDefault();
  for (const f of files) await addZip(f);
});
async function addZip(f) {
  if (app.server) {
    toast(`Copying ${f.name} to footage\\raw…`);
    const r = await fetch('/api/upload?name=' + encodeURIComponent(f.name), { method: 'POST', body: f });
    if (r.ok) { const j = await r.json(); await loadSessions(); toast(`Added ${j.name} to footage\\raw`); openSource(j.name); return; }
    toast('Could not copy the zip; opening it from memory instead', true);
  }
  const key = f.name;
  if (!app.sessions.some((s) => s.key === key)) app.sessions.push({ key, name: f.name, size: f.size, file: f });
  renderSessions();
  openSource(key);
}

// ====================================================================== keyboard
document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' && e.target.type !== 'range' && e.target.type !== 'checkbox' || tag === 'textarea' || tag === 'select') { if (e.key === 'Escape') e.target.blur(); return; }
  if (document.querySelector('.modal-back') && e.key !== 'Escape') { if (!(e.ctrlKey && e.key.toLowerCase() === 'e')) return; }
  const k = e.key, ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && k.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (ctrl && k.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (ctrl && k.toLowerCase() === 's') { e.preventDefault(); saveProject(); return; }
  if (ctrl && k.toLowerCase() === 'e') { e.preventDefault(); if (!document.querySelector('.modal-back')) exportDialog(); return; }
  if (ctrl) return;
  switch (k) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'k': case 'K': stop(); break;
    case 'l': case 'L': shuttle(1); break;
    case 'j': case 'J': shuttle(-1); break;
    case 'ArrowLeft': e.preventDefault(); step(e.shiftKey ? -FPS : -1); break;
    case 'ArrowRight': e.preventDefault(); step(e.shiftKey ? FPS : 1); break;
    case 'ArrowUp': e.preventDefault(); jumpCut(-1); break;
    case 'ArrowDown': e.preventDefault(); jumpCut(1); break;
    case 'Home': app.view === 'source' ? (app.src.t = 0, updateSourceBar(), markDirty()) : app.seek(0); break;
    case 'End': app.view === 'source' ? (app.src.t = app.recs.get(app.src.key)?.duration || 0, updateSourceBar(), markDirty()) : app.seek(app.layout().duration); break;
    case 'i': case 'I': if (app.view === 'source') markIn(); break;
    case 'o': case 'O': if (app.view === 'source') markOut(); break;
    case 'Enter': if (app.view === 'source') { e.preventDefault(); addFromSource(); } break;
    case 's': case 'S': splitAtPlayhead(); break;
    case 'Delete': case 'Backspace': e.preventDefault(); deleteSelection(); break;
    case 'Tab': e.preventDefault(); setView(app.view === 'source' ? 'program' : 'source'); updateTimecode(); break;
    case '+': case '=': app.timeline.setZoom(app.timeline.pps * 1.4); break;
    case '-': case '_': app.timeline.setZoom(app.timeline.pps / 1.4); break;
    case 'Escape': app.select(null); break;
    default: return;
  }
  updateTimecode();
});

// ====================================================================== wiring
function wire() {
  $('#btnNew').onclick = () => { if (app.project.clips.length && !confirm('Start a new edit? (The current one is autosaved until you change the new one.)')) return; loadProject(newProject()); };
  $('#btnOpen').onclick = openDialog;
  $('#btnSave').onclick = saveProject;
  $('#btnUndo').onclick = undo; $('#btnRedo').onclick = redo;
  $('#btnExport').onclick = exportDialog;
  $('#btnHelp').onclick = () => { app.select(null); };
  $('#projName').onchange = () => { app.project.name = $('#projName').value.trim() || 'Untitled edit'; app.commit('Rename'); };
  $('#projName').onkeydown = (e) => { if (e.key === 'Enter') e.target.blur(); };
  for (const b of document.querySelectorAll('#viewerTabs [data-view]')) b.onclick = () => { setView(b.dataset.view); updateTimecode(); };
  $('#btnPlay').onclick = togglePlay;
  $('#btnBack').onclick = () => step(-1); $('#btnFwd').onclick = () => step(1);
  $('#btnStart').onclick = () => (app.view === 'source' ? (app.src.t = app.src.in ?? 0, updateSourceBar(), markDirty()) : jumpCut(-1));
  $('#btnEnd').onclick = () => (app.view === 'source' ? (app.src.t = app.src.out ?? app.src.t, updateSourceBar(), markDirty()) : jumpCut(1));
  $('#btnRev').onclick = () => shuttle(-1); $('#btnFF').onclick = () => shuttle(1);
  $('#btnIn').onclick = markIn; $('#btnOut').onclick = markOut; $('#btnAdd').onclick = addFromSource;
  for (const b of document.querySelectorAll('#srcCam [data-cam]')) b.onclick = () => { app.src.cam = b.dataset.cam; for (const x of document.querySelectorAll('#srcCam [data-cam]')) x.classList.toggle('on', x === b); markDirty(); };
  const track = $('#srcTrack');
  track.addEventListener('pointerdown', (e) => { stop(); track.setPointerCapture(e.pointerId); srcSeekFromEvent(e); const mv = (ev) => srcSeekFromEvent(ev); const up = () => { track.removeEventListener('pointermove', mv); track.removeEventListener('pointerup', up); }; track.addEventListener('pointermove', mv); track.addEventListener('pointerup', up); });
  $('#btnSplit').onclick = splitAtPlayhead; $('#btnDel').onclick = deleteSelection;
  $('#btnFit').onclick = () => app.timeline.fit();
  $('#btnZoomIn').onclick = () => app.timeline.setZoom(app.timeline.pps * 1.4);
  $('#btnZoomOut').onclick = () => app.timeline.setZoom(app.timeline.pps / 1.4);
  $('#btnSnap').onclick = () => { app.timeline.snap = !app.timeline.snap; $('#btnSnap').classList.toggle('on', app.timeline.snap); };
  const mm = $('#musicMenu');
  for (const s of SONGS) { const b = ui.btn('♪ ' + s.name, () => { addMusic(s.id, app.T); mm.classList.remove('open'); }, s.desc); mm.append(b); }
  $('#btnMusic').onclick = (e) => { e.stopPropagation(); mm.classList.toggle('open'); };
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#musicMenu, #btnMusic')) mm.classList.remove('open'); });
  app.onZoom = () => {};
}

async function start() {
  wire();
  renderSongs();
  app.timeline = new Timeline($('#tlBody'), app);
  let restored = null;
  try { restored = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) { /* */ }
  app.project = newProject();
  resetHistory();
  await loadSessions();
  if (restored && restored.clips && (restored.clips.length || restored.music.length)) { loadProject(restored); toast('Restored your last edit'); }
  else { syncProjectUI(); app.changed(); setView('program'); }
  setView(app.project.clips.length ? 'program' : 'source');
  updateTimecode();
  fitViewport();
  requestAnimationFrame(tick);
  document.body.classList.add('ready');
}
start().catch((e) => { console.error(e); toast('Editor failed to start: ' + e.message, true); });
