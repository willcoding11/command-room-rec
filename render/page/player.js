// COMMAND ROOM reconstruction renderer: rebuilds a recorded scene (crrec-1 zip, extracted by render.mjs)
// and renders it frame by frame from a chosen camera. Each frame's RGBA pixels are POSTed to /frame.
import * as THREE from 'three';
import { LineSegments2 } from '../vendor/lines/LineSegments2.js';
import { LineSegmentsGeometry } from '../vendor/lines/LineSegmentsGeometry.js';
import { LineMaterial } from '../vendor/lines/LineMaterial.js';
import { buildDirector } from './director.js';

const Q = new URLSearchParams(location.search);
const OPT = {
  rec: Q.get('rec') || '/rec/', mode: Q.get('mode') || 'director', seed: +(Q.get('seed') || 7), W: +(Q.get('w') || 1920), H: +(Q.get('h') || 1080),
  fps: +(Q.get('fps') || 60), from: +(Q.get('from') || 0), to: Q.has('to') ? +Q.get('to') : null,
  ui: Q.get('ui') !== '0', hands: Q.get('hands') !== '0', target: Q.get('target') || 'player-ship',
  lw: Q.has('lw') ? +Q.get('lw') : 1.6, fov: Q.has('fov') ? +Q.get('fov') : null, smooth: Q.has('smooth') ? +Q.get('smooth') : 0.12,
  cam: Q.get('cam') ? Q.get('cam').split(',').map(Number) : null, look: Q.get('look') ? Q.get('look').split(',').map(Number) : null,
  // Fog belongs to the player's view; cameras outside the room would see everything fogged out.
  fog: Q.has('fog') ? Q.get('fog') !== '0' : (Q.get('mode') || 'director') === 'head', dry: Q.get('dry') === '1', still: Q.has('still') ? +Q.get('still') : null,
  chaseDist: +(Q.get('dist') || 3.2), chaseHeight: +(Q.get('height') || 0.9),
};
const post = (path, body) => fetch(path, { method: 'POST', body });
const log = (m) => { console.log(m); post('/log', String(m)); };
window.onerror = (m, s, l) => post('/error', `${m} @${s}:${l}`);
window.onunhandledrejection = (e) => post('/error', String(e.reason && (e.reason.stack || e.reason)));

// ---------------------------------------------------------------- load
const manifest = await (await fetch(OPT.rec + 'manifest.json')).json();
const defsText = await (await fetch(OPT.rec + manifest.files.defs)).text();
const bin = await (await fetch(OPT.rec + manifest.files.frames)).arrayBuffer();
const defs = defsText.split('\n').filter(Boolean).map((l) => JSON.parse(l));
defs.forEach((d, i) => { d._i = i; });
defs.sort((a, b) => (a.f - b.f) || (a._i - b._i));
const dv = new DataView(bin);
if (dv.getUint32(0, true) !== 0x31465243) throw new Error('not a crrec frames.bin');
const ANAMES = [];
for (const d of defs) if (d.k === 'aname') ANAMES[d.i] = d.n;
const viewDef = defs.find((d) => d.k === 'view') || { fovY: 90, eyePx: [1832, 1920] };
log(`loaded ${manifest.version} ${manifest.durationSec}s frames=${manifest.frames} defs=${defs.length} bin=${bin.byteLength}`);

// ---------------------------------------------------------------- frame decoder
function readFrame(o, full) {
  const fr = { off: o };
  if (dv.getUint8(o) !== 0xfa) throw new Error('bad frame marker at ' + o);
  fr.idx = dv.getUint32(o + 1, true); fr.t = dv.getFloat64(o + 5, true); o += 13;
  const f7 = () => { const a = []; for (let i = 0; i < 7; i++) { a.push(dv.getFloat32(o, true)); o += 4; } return a; };
  fr.head = f7();
  fr.ctrl = [];
  for (let i = 0; i < 2; i++) {
    const hand = dv.getUint8(o); o += 1;
    if (!hand) { fr.ctrl.push(null); continue; }
    const pose = f7();
    const pressed = dv.getUint16(o, true), touched = dv.getUint16(o + 2, true); o += 4;
    const ax = [dv.getInt8(o) / 127, dv.getInt8(o + 1) / 127, dv.getInt8(o + 2) / 127, dv.getInt8(o + 3) / 127]; o += 4;
    const trig = dv.getUint8(o) / 255; o += 1;
    fr.ctrl.push({ hand, pose, pressed, touched, ax, trig });
  }
  if (full) { fr.shown = []; fr.hidden = []; fr.xf = new Map(); fr.geo = []; fr.md = []; }
  for (;;) {
    const ty = dv.getUint8(o); o += 1;
    if (ty === 0x00) break;
    if (ty === 0x01 || ty === 0x02) {
      const n = dv.getUint32(o, true); o += 4;
      if (full) { const arr = ty === 1 ? fr.shown : fr.hidden; for (let i = 0; i < n; i++) arr.push(dv.getUint32(o + i * 4, true)); }
      o += n * 4;
    } else if (ty === 0x03) {
      const n = dv.getUint32(o, true); o += 4;
      for (let i = 0; i < n; i++) {
        const id = dv.getUint32(o, true);
        if (full || id === trackId) {
          const p = [dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true), dv.getFloat32(o + 12, true)];
          const q = [dv.getInt16(o + 16, true) / 32767, dv.getInt16(o + 18, true) / 32767, dv.getInt16(o + 20, true) / 32767, dv.getInt16(o + 22, true) / 32767];
          const s = [dv.getFloat32(o + 24, true), dv.getFloat32(o + 28, true), dv.getFloat32(o + 32, true)];
          if (full) fr.xf.set(id, { p, q, s }); else fr.track = { p, q, s };
        }
        o += 36;
      }
    } else if (ty === 0x05) {
      const n = dv.getUint32(o, true); o += 4;
      if (full) for (let i = 0; i < n; i++) { const b = o + i * 20; fr.md.push([dv.getUint32(b, true), dv.getFloat32(b + 4, true), dv.getFloat32(b + 8, true), dv.getFloat32(b + 12, true), dv.getFloat32(b + 16, true)]); }
      o += n * 20;
    } else if (ty === 0x04) {
      const gid = dv.getUint32(o, true), an = dv.getUint16(o + 4, true), enc = dv.getUint8(o + 6), is = dv.getUint8(o + 7), total = dv.getUint32(o + 8, true), count = dv.getUint32(o + 12, true);
      o += 16;
      const n = count * is, sz = enc === 1 ? 1 : enc === 2 ? 2 : 4;
      if (full) fr.geo.push({ ty, gid, name: ANAMES[an], enc, is, total, count, off: o });
      o += n * sz;
    } else if (ty === 0x06) {
      const gid = dv.getUint32(o, true), n = dv.getUint32(o + 4, true), k = dv.getUint32(o + 8, true);
      if (full) fr.geo.push({ ty, gid, n, k, off: o + 12 });
      o += 12 + k * 19;
    } else if (ty === 0x07) {
      if (full) fr.geo.push({ ty, gid: dv.getUint32(o, true), start: dv.getInt32(o + 4, true), count: dv.getInt32(o + 8, true) });
      o += 12;
    } else throw new Error(`unknown record ${ty} at ${o - 1}`);
  }
  fr.end = o;
  return fr;
}

// First pass: frame index (offsets, times, head + controller poses) and the chase target's track.
const objDefs = defs.filter((d) => d.k === 'obj');
let targetDef = objDefs.find((d) => d.name === OPT.target) || objDefs.find((d) => String(d.id) === OPT.target) || objDefs.find((d) => d.name === 'player-ship');
let trackId = targetDef ? targetDef.id : -1;
const frames = [];
{
  let o = 8;
  while (o < bin.byteLength) {
    let fr;
    try { fr = readFrame(o, false); } catch (e) { log('truncated frames.bin at ' + o + ': ' + e.message); break; }
    frames.push({ off: fr.off, t: fr.t / 1000, idx: fr.idx, head: fr.head, ctrl: fr.ctrl, track: fr.track || null });
    o = fr.end;
  }
}
if (!frames.length) throw new Error('no frames');
const T0 = frames[0].t, TEND = frames[frames.length - 1].t;
const from = Math.max(0, OPT.from), to = Math.min(OPT.to === null ? TEND - T0 : OPT.to, TEND - T0);
log(`frames=${frames.length} span=${(TEND - T0).toFixed(2)}s render ${from}..${to}s mode=${OPT.mode} ${OPT.W}x${OPT.H}@${OPT.fps} target=${trackId}`);

// ---------------------------------------------------------------- tracks + smoothing
function makeTrack(get) {   // samples: { t, p:[3], q:[4] } with gaps filled by the last value
  const out = [];
  let last = null;
  for (const f of frames) { const v = get(f); if (v) last = v; if (last) out.push({ t: f.t - T0, p: last.p, q: last.q, s: last.s }); }
  return out;
}
function smoothTrack(tr, sigma) {
  if (sigma <= 0 || tr.length < 3) return tr;
  const out = [];
  let lo = 0;
  for (let i = 0; i < tr.length; i++) {
    const t = tr[i].t;
    while (tr[lo].t < t - 3 * sigma) lo++;
    let w = 0; const p = [0, 0, 0]; const q = [0, 0, 0, 0];
    const q0 = tr[i].q;
    for (let j = lo; j < tr.length && tr[j].t <= t + 3 * sigma; j++) {
      const d = (tr[j].t - t) / sigma, k = Math.exp(-0.5 * d * d);
      w += k;
      for (let a = 0; a < 3; a++) p[a] += tr[j].p[a] * k;
      const qj = tr[j].q, sg = (qj[0] * q0[0] + qj[1] * q0[1] + qj[2] * q0[2] + qj[3] * q0[3]) < 0 ? -1 : 1;
      for (let a = 0; a < 4; a++) q[a] += qj[a] * k * sg;
    }
    const ql = Math.hypot(...q) || 1;
    out.push({ t, p: p.map((x) => x / w), q: q.map((x) => x / ql), s: tr[i].s });
  }
  return out;
}
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
function sampleTrack(tr, t, outP, outQ) {
  if (!tr.length) return false;
  let lo = 0, hi = tr.length - 1;
  if (t <= tr[0].t) { outP.fromArray(tr[0].p); outQ && outQ.fromArray(tr[0].q); return true; }
  if (t >= tr[hi].t) { outP.fromArray(tr[hi].p); outQ && outQ.fromArray(tr[hi].q); return true; }
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (tr[m].t <= t) lo = m; else hi = m; }
  const a = tr[lo], b = tr[hi], k = (t - a.t) / Math.max(1e-6, b.t - a.t);
  outP.set(a.p[0] + (b.p[0] - a.p[0]) * k, a.p[1] + (b.p[1] - a.p[1]) * k, a.p[2] + (b.p[2] - a.p[2]) * k);
  if (outQ) outQ.slerpQuaternions(_qa.fromArray(a.q), _qb.fromArray(b.q), k);
  return true;
}
const headTrack = smoothTrack(makeTrack((f) => ({ p: f.head.slice(0, 3), q: f.head.slice(3, 7) })), OPT.smooth);
const shipTrack = trackId >= 0 ? makeTrack((f) => f.track) : [];

// ---------------------------------------------------------------- three setup
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.setSize(OPT.W, OPT.H, false);
renderer.domElement.style.width = '100%';
document.body.appendChild(renderer.domElement);
const gl = renderer.getContext();
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, OPT.W / OPT.H, 0.01, 1000);
const pointScale = Math.max(1, OPT.H / Math.max(1, viewDef.eyePx ? viewDef.eyePx[1] : 1080));
const lineScale = OPT.H / 1080;

// ---------------------------------------------------------------- textures, materials, geometries, objects
const PLACEHOLDER = (() => { const c = document.createElement('canvas'); c.width = c.height = 1; return c; })();
const textures = new Map();
function tex(uuid) {
  let t = textures.get(uuid);
  if (!t) { t = new THREE.Texture(PLACEHOLDER); t.uuid = uuid; t.needsUpdate = true; textures.set(uuid, t); }
  return t;
}
const images = new Map();
function loadImage(file) {
  if (!images.has(file)) images.set(file, new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = OPT.rec + file; }));
  return images.get(file);
}
async function applyTex(d) {
  const t = tex(d.id), p = d.p || {};
  const im = await loadImage(d.file);
  if (!im) return;
  t.image = im;
  if (p.flipY !== undefined) t.flipY = p.flipY;
  if (p.cs) t.colorSpace = p.cs;
  if (p.ws) t.wrapS = p.ws; if (p.wt) t.wrapT = p.wt;
  if (p.mag) t.magFilter = p.mag; if (p.min) t.minFilter = p.min;
  if (p.mip !== undefined) t.generateMipmaps = p.mip;
  t.anisotropy = 8;
  if (p.pm !== undefined) t.premultiplyAlpha = p.pm;
  if (p.rep) t.repeat.fromArray(p.rep); if (p.off) t.offset.fromArray(p.off); if (p.ctr) t.center.fromArray(p.ctr); if (p.rot !== undefined) t.rotation = p.rot;
  t.needsUpdate = true;
}
const TEX_KEYS = ['map', 'alphaMap', 'aoMap', 'lightMap', 'emissiveMap', 'specularMap', 'envMap', 'bumpMap', 'normalMap', 'displacementMap', 'roughnessMap', 'metalnessMap', 'gradientMap', 'matcap'];
const matLoader = new THREE.MaterialLoader();
const mats = new Map();     // id -> { m, fat: LineMaterial|null, users:Set(node) }
function defMat(d) {
  const texMap = {};
  for (const k of TEX_KEYS) if (d.json[k]) texMap[d.json[k]] = tex(d.json[k]);
  matLoader.setTextures(texMap);
  const m = matLoader.parse(d.json);
  if (m.isPointsMaterial) { m.userData.baseSize = m.size; if (!m.sizeAttenuation) m.size *= pointScale; }
  if (!OPT.fog) m.fog = false;
  let e = mats.get(d.id);
  if (!e) { e = { m, fat: null, users: new Set() }; mats.set(d.id, e); }
  else { const old = e.m; e.m = m; m.color && old.color && m.color.copy(old.color); m.opacity = old.opacity; }
  if (e.fat) syncFat(e);
  for (const n of e.users) assignMat(n);
}
function fatMat(e) {
  if (!e.fat) e.fat = new LineMaterial({ worldUnits: false, linewidth: OPT.lw * lineScale, alphaToCoverage: false });
  syncFat(e);
  return e.fat;
}
function syncFat(e) {
  const f = e.fat, m = e.m;
  f.color.copy(m.color || new THREE.Color(1, 1, 1)); f.opacity = m.opacity; f.transparent = m.transparent; f.blending = m.blending;
  f.depthTest = m.depthTest; f.depthWrite = m.depthWrite; f.vertexColors = m.vertexColors; f.fog = m.fog;
  f.resolution.set(OPT.W, OPT.H);
  f.needsUpdate = true;
}
const geos = new Map();     // id -> { g: BufferGeometry, ver, fat: Map(type -> {geo, ver}) }
const TYPED = { Float32Array, Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array, Uint8ClampedArray, Float64Array };
function unb64(s, T) { const bs = atob(s); const u8 = new Uint8Array(bs.length); for (let i = 0; i < bs.length; i++) u8[i] = bs.charCodeAt(i); return new (TYPED[T] || Float32Array)(u8.buffer); }
function defGeo(d) {
  let g;
  if (d.copyOf !== undefined) g = geos.get(d.copyOf).g.clone();
  else {
    g = new THREE.BufferGeometry();
    for (const [name, a] of Object.entries(d.data.attrs)) g.setAttribute(name, new THREE.BufferAttribute(unb64(a.b64, a.t), a.is, a.n));
    if (d.data.index) g.setIndex(new THREE.BufferAttribute(unb64(d.data.index.b64, d.data.index.t), 1));
    if (d.data.groups) for (const gr of d.data.groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
    g.setDrawRange(d.data.dr[0], d.data.dr[1] < 0 ? Infinity : d.data.dr[1]);
  }
  g.computeBoundingSphere();
  geos.set(d.id, { g, ver: 0, fat: new Map() });
}
function geoRecord(r) {
  const e = geos.get(r.gid);
  if (!e) return;
  const g = e.g;
  if (r.ty === 0x07) { g.setDrawRange(r.start, r.count < 0 ? Infinity : r.count); e.ver++; return; }
  if (r.ty === 0x06) {
    let pa = g.attributes.position, ca = g.attributes.color;
    if (!pa || pa.count !== r.n) { pa = new THREE.BufferAttribute(new Float32Array(r.n * 3), 3); g.setAttribute('position', pa); }
    if (!ca || ca.count !== r.n) { ca = new THREE.BufferAttribute(new Float32Array(r.n * 3), 3); g.setAttribute('color', ca); }
    const P = pa.array, C = ca.array; C.fill(0);
    let o = r.off;
    for (let i = 0; i < r.k; i++) {
      const j = dv.getUint32(o, true) * 3;
      P[j] = dv.getFloat32(o + 4, true); P[j + 1] = dv.getFloat32(o + 8, true); P[j + 2] = dv.getFloat32(o + 12, true);
      C[j] = dv.getUint8(o + 16) / 255; C[j + 1] = dv.getUint8(o + 17) / 255; C[j + 2] = dv.getUint8(o + 18) / 255;
      o += 19;
    }
    pa.needsUpdate = ca.needsUpdate = true; e.ver++;
    return;
  }
  // 0x04 attribute data
  const n = r.count * r.is;
  let arr;
  if (r.enc === 1) { arr = new Float32Array(n); for (let i = 0; i < n; i++) arr[i] = dv.getUint8(r.off + i) / 255; }
  else if (r.enc === 2) { arr = new Uint16Array(n); for (let i = 0; i < n; i++) arr[i] = dv.getUint16(r.off + i * 2, true); }
  else if (r.enc === 3) { arr = new Uint32Array(n); for (let i = 0; i < n; i++) arr[i] = dv.getUint32(r.off + i * 4, true); }
  else { arr = new Float32Array(n); for (let i = 0; i < n; i++) arr[i] = dv.getFloat32(r.off + i * 4, true); }
  if (r.name === '__index') { g.setIndex(new THREE.BufferAttribute(arr, 1)); e.ver++; return; }
  let a = g.attributes[r.name];
  if (!a || a.count !== r.total || a.itemSize !== r.is || !(a.array instanceof Float32Array)) {
    a = new THREE.BufferAttribute(new Float32Array(r.total * r.is), r.is);
    g.setAttribute(r.name, a);
  }
  a.array.set(arr.length > a.array.length ? arr.subarray(0, a.array.length) : arr);
  a.needsUpdate = true; e.ver++;
}
// Fat-line geometry for a Line / LineSegments / LineLoop source.
function fatGeo(gid, type) {
  const e = geos.get(gid);
  let f = e.fat.get(type);
  if (f && f.ver === e.ver) return f;
  if (!f) { f = { geo: new LineSegmentsGeometry(), ver: -1, n: 0 }; e.fat.set(type, f); }
  const g = e.g, P = g.attributes.position, C = g.attributes.color;
  if (!P) { f.n = 0; f.ver = e.ver; return f; }
  const idx = g.index ? g.index.array : null;
  const total = idx ? idx.length : P.count;
  const s = Math.max(0, g.drawRange.start), end = Math.min(total, Number.isFinite(g.drawRange.count) ? s + g.drawRange.count : total);
  const pairs = [];
  if (type === 'LineSegments') for (let i = s; i + 1 < end; i += 2) pairs.push(i, i + 1);
  else { for (let i = s; i + 1 < end; i++) pairs.push(i, i + 1); if (type === 'LineLoop' && end - s > 2) pairs.push(end - 1, s); }
  const pos = new Float32Array(pairs.length * 3), col = C ? new Float32Array(pairs.length * 3) : null;
  for (let k = 0; k < pairs.length; k++) {
    const v = idx ? idx[pairs[k]] : pairs[k];
    pos[k * 3] = P.getX(v); pos[k * 3 + 1] = P.getY(v); pos[k * 3 + 2] = P.getZ(v);
    if (col) { col[k * 3] = C.getX(v); col[k * 3 + 1] = C.getY(v); col[k * 3 + 2] = C.getZ(v); }
  }
  if (f.geo) f.geo.dispose();
  f.geo = new LineSegmentsGeometry();
  if (pairs.length) { f.geo.setPositions(pos); if (col) f.geo.setColors(col); }
  f.n = pairs.length / 2; f.ver = e.ver;
  return f;
}

const nodes = new Map();    // id -> node { def, obj, layer, vis, base:{p,q,s}, matIds, geoId }
const isLineType = (t) => t === 'Line' || t === 'LineSegments' || t === 'LineLoop';
function defObj(d) {
  let obj;
  const fat = OPT.lw > 0 && isLineType(d.type);
  const gEntry = d.geo !== undefined ? geos.get(d.geo) : null;
  const g = gEntry ? gEntry.g : new THREE.BufferGeometry();
  switch (d.type) {
    case 'Mesh': case 'InstancedMesh': obj = new THREE.Mesh(g); break;
    case 'Points': obj = new THREE.Points(g); break;
    case 'Sprite': obj = new THREE.Sprite(); if (d.center) obj.center.fromArray(d.center); break;
    case 'Line': case 'LineSegments': case 'LineLoop': obj = fat ? new LineSegments2(new LineSegmentsGeometry()) : new THREE[d.type](g); break;
    default: obj = new THREE.Object3D();
  }
  obj.frustumCulled = false;
  obj.renderOrder = d.ro || 0;
  obj.visible = false;
  const n = { def: d, obj, layer: d.layer || 'world', vis: false, base: null, matIds: d.mat, geoId: d.geo, fat, type: d.type };
  nodes.set(d.id, n);
  if (d.mat !== undefined) assignMat(n);
  scene.add(obj);
}
function assignMat(n) {
  const ids = Array.isArray(n.matIds) ? n.matIds : [n.matIds];
  const ms = ids.map((id) => { const e = mats.get(id); if (!e) return new THREE.MeshBasicMaterial(); e.users.add(n); return n.fat ? fatMat(e) : e.m; });
  n.obj.material = Array.isArray(n.matIds) ? ms : ms[0];
}
function objSet(d) {
  const n = nodes.get(d.id);
  if (!n) return;
  if (d.layer) n.layer = d.layer;
  if (d.ro !== undefined) n.obj.renderOrder = d.ro;
  if (d.geo !== undefined) { n.geoId = d.geo; if (!n.fat && geos.get(d.geo)) n.obj.geometry = geos.get(d.geo).g; }
  if (d.mat !== undefined) { n.matIds = d.mat; assignMat(n); }
}
let sceneFog = null;
function defScene(d) {
  scene.background = d.bg === null ? new THREE.Color(0) : new THREE.Color(d.bg);
  if (d.fog && OPT.fog) scene.fog = d.fog.t === 'exp2' ? new THREE.FogExp2(d.fog.c, d.fog.d) : new THREE.Fog(d.fog.c, d.fog.near, d.fog.far);
  else scene.fog = null;
  sceneFog = scene.fog;
}
const events = [];
async function applyDef(d) {
  switch (d.k) {
    case 'geo': defGeo(d); break;
    case 'mat': defMat(d); break;
    case 'obj': defObj(d); break;
    case 'objset': objSet(d); break;
    case 'tex': await applyTex(d); break;
    case 'scene': defScene(d); break;
    case 'ev': events.push(d); break;
    default: break;
  }
}

// ---------------------------------------------------------------- playback
let defPtr = 0, framePtr = -1, nextFrame = null;
const layerOn = (l) => (l === 'ui' ? OPT.ui : l === 'hands' ? OPT.hands : true);
async function applyFrame(k) {
  const fr = readFrame(frames[k].off, true);
  while (defPtr < defs.length && defs[defPtr].f <= fr.idx) await applyDef(defs[defPtr++]);
  for (const r of fr.geo) geoRecord(r);
  for (const id of fr.shown) { const n = nodes.get(id); if (n) n.vis = true; }
  for (const id of fr.hidden) { const n = nodes.get(id); if (n) n.vis = false; }
  for (const [id, x] of fr.xf) { const n = nodes.get(id); if (n) n.base = x; }
  for (const [id, r, g, b, o] of fr.md) { const e = mats.get(id); if (e) { if (e.m.color) e.m.color.setRGB(r, g, b); e.m.opacity = o; if (e.fat) { e.fat.color.setRGB(r, g, b); e.fat.opacity = o; } } }
}
async function advanceTo(t) {
  while (framePtr + 1 < frames.length && frames[framePtr + 1].t - T0 <= t) { framePtr++; await applyFrame(framePtr); }
  nextFrame = framePtr + 1 < frames.length ? readFrame(frames[framePtr + 1].off, true) : null;
}
const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
function poseNodes(t) {
  const tA = framePtr >= 0 ? frames[framePtr].t - T0 : 0;
  const tB = nextFrame ? nextFrame.t / 1000 - T0 : tA;
  const k = tB > tA ? Math.min(1, Math.max(0, (t - tA) / (tB - tA))) : 0;
  for (const n of nodes.values()) {
    const show = n.vis && n.base && layerOn(n.layer);
    n.obj.visible = !!show;
    if (!n.base) continue;
    const b = n.base, nx = nextFrame && nextFrame.xf.get(n.def.id);
    if (nx && k > 0) {
      n.obj.position.set(b.p[0] + (nx.p[0] - b.p[0]) * k, b.p[1] + (nx.p[1] - b.p[1]) * k, b.p[2] + (nx.p[2] - b.p[2]) * k);
      n.obj.quaternion.slerpQuaternions(_qa.fromArray(b.q).normalize(), _qb.fromArray(nx.q).normalize(), k);
      n.obj.scale.set(b.s[0] + (nx.s[0] - b.s[0]) * k, b.s[1] + (nx.s[1] - b.s[1]) * k, b.s[2] + (nx.s[2] - b.s[2]) * k);
    } else {
      n.obj.position.fromArray(b.p); n.obj.quaternion.fromArray(b.q).normalize(); n.obj.scale.fromArray(b.s);
    }
    if (show && n.fat) {
      const f = fatGeo(n.geoId, n.type);
      if (n.obj.geometry !== f.geo) n.obj.geometry = f.geo;
      if (!f.n) n.obj.visible = false;
    }
  }
}

// ---------------------------------------------------------------- cameras
const UP = new THREE.Vector3(0, 1, 0);
const camState = { p: null, look: null, fwd: null };
// Ship forward axis: ship models point +Z; confirm against the motion over the recording.
let shipAxis = new THREE.Vector3(0, 0, 1);
if (shipTrack.length > 10) {
  let pos = 0, neg = 0;
  for (let i = 5; i < shipTrack.length; i += 3) {
    const a = shipTrack[i - 5], b = shipTrack[i];
    const v = new THREE.Vector3(b.p[0] - a.p[0], b.p[1] - a.p[1], b.p[2] - a.p[2]);
    if (v.lengthSq() < 1e-10) continue;
    const z = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion().fromArray(b.q));
    if (z.dot(v) > 0) pos++; else neg++;
  }
  if (neg > pos * 1.5) shipAxis.set(0, 0, -1);
  log(`ship track samples=${shipTrack.length} forward=${shipAxis.z > 0 ? '+Z' : '-Z'} (${pos}/${neg})`);
}
const shipScale = shipTrack.length ? Math.max(...shipTrack.slice(0, 20).map((s) => Math.abs(s.s[0]))) || 1 : 1;
// The ship model is ~0.3 local units long.
const SHIP_LEN = 0.3 * shipScale;
// Wide shot: behind and above the average head position, looking at the middle of the action.
function wideShot() {
  const hp = new THREE.Vector3(), hf = new THREE.Vector3();
  for (const h of headTrack) { hp.add(new THREE.Vector3().fromArray(h.p)); hf.add(new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion().fromArray(h.q))); }
  hp.divideScalar(Math.max(1, headTrack.length)); hf.y = 0; if (hf.lengthSq() < 1e-6) hf.set(0, 0, -1); hf.normalize();
  const box = new THREE.Box3();
  for (const s of shipTrack) box.expandByPoint(new THREE.Vector3().fromArray(s.p));
  const c = box.isEmpty() ? hp.clone().addScaledVector(hf, 1) : box.getCenter(new THREE.Vector3());
  const r = box.isEmpty() ? 1 : Math.max(0.3, box.getSize(new THREE.Vector3()).length() / 2);
  const pos = hp.clone().addScaledVector(hf, -0.6 * r).add(new THREE.Vector3(0, 0.45 * r, 0));
  return { pos: OPT.cam ? new THREE.Vector3(...OPT.cam) : pos, look: OPT.look ? new THREE.Vector3(...OPT.look) : c };
}
const WIDE = OPT.mode === 'wide' ? wideShot() : null;
const DIRECTOR = OPT.mode === 'director' ? buildDirector({ frames, readFrame, defs, T0, duration: to, log, seed: OPT.seed, aspect: OPT.W / OPT.H }) : null;
const _sp = new THREE.Vector3(), _sq = new THREE.Quaternion(), _f = new THREE.Vector3(), _u = new THREE.Vector3(), _want = new THREE.Vector3(), _lk = new THREE.Vector3();
function placeCamera(t, dt) {
  if (DIRECTOR) {
    DIRECTOR.update(camera, t, dt);
  } else if (OPT.mode === 'head') {
    sampleTrack(headTrack, t, camera.position, camera.quaternion);
    camera.fov = OPT.fov || 75; camera.near = 0.02; camera.far = 1000;
  } else if (OPT.mode === 'wide') {
    camera.position.copy(WIDE.pos); camera.lookAt(WIDE.look);
    camera.fov = OPT.fov || 60; camera.near = 0.02; camera.far = 1000;
  } else {     // chase
    if (!sampleTrack(shipTrack, t, _sp, _sq)) { sampleTrack(headTrack, t, camera.position, camera.quaternion); return; }
    _f.copy(shipAxis).applyQuaternion(_sq).normalize();
    _u.set(0, 1, 0).applyQuaternion(_sq);
    const up = _u.multiplyScalar(0.35).addScaledVector(UP, 0.65).normalize();
    _want.copy(_sp).addScaledVector(_f, -OPT.chaseDist * SHIP_LEN).addScaledVector(up, OPT.chaseHeight * SHIP_LEN);
    _lk.copy(_sp).addScaledVector(_f, 1.2 * SHIP_LEN);
    if (!camState.p) { camState.p = _want.clone(); camState.look = _lk.clone(); camState.up = up.clone(); }
    const a = 1 - Math.exp(-dt / 0.22), b = 1 - Math.exp(-dt / 0.1);
    camState.p.lerp(_want, a); camState.look.lerp(_lk, b); camState.up.lerp(up, a).normalize();
    camera.position.copy(camState.p); camera.up.copy(camState.up); camera.lookAt(camState.look);
    camera.fov = OPT.fov || 65; camera.near = Math.max(0.0005, SHIP_LEN * 0.02); camera.far = 1000;
  }
  camera.aspect = OPT.W / OPT.H;
  camera.updateProjectionMatrix();
}

// ---------------------------------------------------------------- render loop
const pixels = new Uint8Array(OPT.W * OPT.H * 4);
const EVERY = Math.max(1, +(Q.get('every') || 1));
const nOut = Math.max(1, Math.floor((to - from) * OPT.fps) + 1);
log(`START ${nOut} frames`);
const tStart = performance.now();
// Pre-roll: apply the log up to `from` (so the scene state is right) and settle the chase cam.
const stills = OPT.still !== null ? [OPT.still] : null;
const startT = stills ? stills[0] : from;
await advanceTo(startT);
for (let i = 0; i <= 90 && OPT.mode === 'chase'; i++) placeCamera(Math.max(0, startT - (90 - i) / OPT.fps), 1 / OPT.fps);
for (let i = 0; i < nOut; i++) {
  const t = stills ? stills[0] : from + i / OPT.fps;
  await advanceTo(t);
  poseNodes(t);
  placeCamera(t, 1 / OPT.fps);
  if (EVERY > 1 && i % EVERY) continue;     // preview: simulate every frame, render every Nth
  renderer.render(scene, camera);
  if (!OPT.dry) {
    gl.readPixels(0, 0, OPT.W, OPT.H, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const r = await post('/frame?i=' + i, pixels);
    if (!r.ok) throw new Error('frame post failed');
  }
  if (i % 60 === 0) { const el = (performance.now() - tStart) / 1000; log(`frame ${i}/${nOut} t=${t.toFixed(2)} ${(i / Math.max(el, 0.001)).toFixed(1)} fps visible=${[...nodes.values()].filter((n) => n.obj.visible).length}`); }
  if (stills) break;
}
await post('/done', JSON.stringify({ frames: stills ? 1 : nOut, secs: (performance.now() - tStart) / 1000, events: events.length }));
