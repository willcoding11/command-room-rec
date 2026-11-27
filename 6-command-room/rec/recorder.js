// COMMAND ROOM recording build - scene + game-audio recorder (shared by every snapshot).
//
// Loaded as a module BEFORE the game's main.js. It never changes gameplay. It hooks:
//   * THREE.Scene.prototype.onBeforeRender - called once per frame by the game's single renderer.render(),
//     after matrices and the XR camera are updated. That is where the scene graph is logged.
//   * AudioNode.prototype.connect - every node the game connects to ctx.destination is also connected to a
//     MediaStreamAudioDestinationNode while recording. Only the game's own WebAudio output is recorded.
//     getUserMedia is never called (no microphone).
// Data goes to IndexedDB every ~2 s, so a crash or an ended session keeps everything up to the last flush.
// On stop a .zip (manifest.json, frames.bin, defs.jsonl, audio.webm, tex/*) is built in the browser.
//
// In VR: click BOTH thumbsticks in and hold for 1 second to start / stop. (Auto-record on ENTER VR is on
// by default; leaving VR always stops and saves.)
import * as THREE from '../vendor/three.module.js';

const CFG = Object.assign({ version: 'v?', slug: '', title: 'COMMAND ROOM', date: '', commit: '', shots: [], index: '../' }, window.__CRREC || {});
const FORMAT = 'crrec-1';
const LOG_MIN_MS = 20;            // log at most every 20 ms: 72 Hz display -> 36 Hz log, 90 Hz -> 45 Hz
const FLUSH_MS = 2000;
const TEX_MIN_MS = 500;           // a redrawn canvas texture is snapshotted at most twice a second
const HOLD_MS = 1000;
const AUTO_KEY = 'crrecAutoRecord';

// ------------------------------------------------------------------------------------------ utilities
const now = () => performance.now();
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8, crc = 0) { crc = ~crc >>> 0; for (let i = 0; i < u8.length; i++) crc = CRC_TABLE[(crc ^ u8[i]) & 0xff] ^ (crc >>> 8); return ~crc >>> 0; }
function b64(u8) { let s = ''; const CH = 0x8000; for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH)); return btoa(s); }
function fnv(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16) + ':' + str.length; }
const pad2 = (n) => String(n).padStart(2, '0');
function stamp(d = new Date()) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`; }
function fmtDur(ms) { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${pad2(s % 60)}`; }
function fmtMB(b) { return (b / 1048576).toFixed(b < 10485760 ? 1 : 0) + ' MB'; }

class BinWriter {
  constructor(size = 1 << 20) { this.buf = new ArrayBuffer(size); this.dv = new DataView(this.buf); this.u8 = new Uint8Array(this.buf); this.p = 0; }
  need(n) {
    if (this.p + n <= this.buf.byteLength) return;
    let s = this.buf.byteLength * 2; while (s < this.p + n) s *= 2;
    const nb = new ArrayBuffer(s); new Uint8Array(nb).set(this.u8.subarray(0, this.p));
    this.buf = nb; this.dv = new DataView(nb); this.u8 = new Uint8Array(nb);
  }
  u8w(v) { this.need(1); this.dv.setUint8(this.p, v); this.p += 1; }
  i8(v) { this.need(1); this.dv.setInt8(this.p, v); this.p += 1; }
  u16(v) { this.need(2); this.dv.setUint16(this.p, v, true); this.p += 2; }
  i16(v) { this.need(2); this.dv.setInt16(this.p, v, true); this.p += 2; }
  u32(v) { this.need(4); this.dv.setUint32(this.p, v, true); this.p += 4; }
  i32(v) { this.need(4); this.dv.setInt32(this.p, v, true); this.p += 4; }
  f32(v) { this.need(4); this.dv.setFloat32(this.p, v, true); this.p += 4; }
  f64(v) { this.need(8); this.dv.setFloat64(this.p, v, true); this.p += 8; }
  bytes(u8) { this.need(u8.length); this.u8.set(u8, this.p); this.p += u8.length; }
  take() { const out = this.buf.slice(0, this.p); this.p = 0; return out; }
}

// ------------------------------------------------------------------------------------------ storage (IndexedDB)
const DB = (() => {
  let dbp = null, mem = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res) => {
      let req;
      try { req = indexedDB.open('crrec-' + (CFG.slug || 'game'), 1); } catch (e) { res(null); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('recs', { keyPath: 'id' });
        const parts = db.createObjectStore('parts', { autoIncrement: true });
        parts.createIndex('rec', 'recId');
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => res(null);
    }).then((db) => { if (!db) mem = { recs: new Map(), parts: [] }; return db; });
    return dbp;
  }
  const tx = (db, store, mode, fn) => new Promise((res, rej) => { const t = db.transaction(store, mode); const r = fn(t.objectStore(store)); t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
  return {
    async putRec(rec) { const db = await open(); if (!db) { mem.recs.set(rec.id, { ...rec }); return; } await tx(db, 'recs', 'readwrite', (s) => s.put(rec)); },
    async getRecs() { const db = await open(); if (!db) return [...mem.recs.values()]; return (await tx(db, 'recs', 'readonly', (s) => s.getAll())) || []; },
    async addPart(part) { const db = await open(); if (!db) { mem.parts.push(part); return; } await tx(db, 'parts', 'readwrite', (s) => s.add(part)); },
    async getParts(recId) { const db = await open(); if (!db) return mem.parts.filter((p) => p.recId === recId); return (await tx(db, 'parts', 'readonly', (s) => s.index('rec').getAll(recId))) || []; },
    async del(recId) {
      const db = await open();
      if (!db) { mem.recs.delete(recId); mem.parts = mem.parts.filter((p) => p.recId !== recId); return; }
      await tx(db, 'recs', 'readwrite', (s) => s.delete(recId));
      await new Promise((res) => { const t = db.transaction('parts', 'readwrite'); const idx = t.objectStore('parts').index('rec'); const c = idx.openKeyCursor(IDBKeyRange.only(recId)); c.onsuccess = () => { const cur = c.result; if (cur) { t.objectStore('parts').delete(cur.primaryKey); cur.continue(); } }; t.oncomplete = res; t.onerror = res; });
    },
  };
})();

// ------------------------------------------------------------------------------------------ zip writer
async function deflate(blob) {
  if (typeof CompressionStream === 'undefined') return null;
  try { return await new Response(blob.stream().pipeThrough(new CompressionStream('deflate-raw'))).blob(); } catch (e) { return null; }
}
async function crcBlob(blob) {
  let c = 0; const STEP = 8 << 20;
  for (let o = 0; o < blob.size; o += STEP) c = crc32(new Uint8Array(await blob.slice(o, o + STEP).arrayBuffer()), c);
  return c;
}
async function makeZip(files) {   // files: [{ name, blob, compress }]
  const out = [], central = []; let offset = 0;
  const d = new Date(), dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files) {
    const name = new TextEncoder().encode(f.name);
    const crc = await crcBlob(f.blob);
    let data = f.blob, method = 0;
    if (f.compress && f.blob.size > 256) { const z = await deflate(f.blob); if (z && z.size < f.blob.size) { data = z; method = 8; } }
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, method, true);
    lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, data.size, true); lh.setUint32(22, f.blob.size, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    out.push(lh.buffer, name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, method, true);
    ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true); ch.setUint32(20, data.size, true); ch.setUint32(24, f.blob.size, true);
    ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    central.push(ch.buffer, name);
    offset += 30 + name.length + data.size;
  }
  const cdSize = central.reduce((a, b) => a + (b.byteLength || b.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...out, ...central, end.buffer], { type: 'application/zip' });
}

// ------------------------------------------------------------------------------------------ game audio tap
const audioTaps = new Map();           // AudioContext -> Set of nodes connected to its destination
let audioRec = null;                   // active audio recording state
const origConnect = AudioNode.prototype.connect;
const origDisconnect = AudioNode.prototype.disconnect;
function isRealCtx(ctx) { return !(typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext); }
AudioNode.prototype.connect = function (dest, ...rest) {
  const r = origConnect.call(this, dest, ...rest);
  try {
    if (dest && typeof AudioDestinationNode !== 'undefined' && dest instanceof AudioDestinationNode && isRealCtx(this.context)) {
      let set = audioTaps.get(this.context);
      if (!set) { set = new Set(); audioTaps.set(this.context, set); }
      set.add(this);
      if (audioRec && audioRec.active) audioAttach(this.context);
    }
  } catch (e) { /* never break the game's audio */ }
  return r;
};
function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']) { try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) { /* */ } }
  return '';
}
function audioAttach(ctx) {
  const A = audioRec;
  if (!A || !A.active) return;
  if (!A.ctx) {
    try {
      A.ctx = ctx;
      A.msd = ctx.createMediaStreamDestination();
      const mime = pickMime();
      if (mime === null) { A.error = 'no MediaRecorder'; return; }
      A.mime = mime || 'audio/webm';
      A.mr = new MediaRecorder(A.msd.stream, mime ? { mimeType: mime, audioBitsPerSecond: 128000 } : undefined);
      A.mr.ondataavailable = (e) => { if (e.data && e.data.size) { A.bytes += e.data.size; A.onChunk(e.data); } };
      A.stopped = new Promise((res) => { A.mr.onstop = res; });
      A.mr.onstart = () => { A.startMs = now() - A.t0; };
      A.startMs = now() - A.t0;
      A.mr.start(2000);
      A.sampleRate = ctx.sampleRate;
    } catch (e) { A.error = String(e); return; }
  }
  if (A.ctx !== ctx) return;
  for (const n of audioTaps.get(ctx) || []) {
    if (A.nodes.has(n)) continue;
    try { origConnect.call(n, A.msd); A.nodes.add(n); } catch (e) { /* */ }
  }
}
function audioStart(t0, onChunk) {
  audioRec = { active: true, t0, onChunk, nodes: new Set(), bytes: 0, ctx: null, startMs: null };
  for (const ctx of audioTaps.keys()) { audioAttach(ctx); break; }
}
async function audioStop() {
  const A = audioRec; audioRec = null;
  if (!A) return null;
  A.active = false;
  if (A.mr && A.mr.state !== 'inactive') { try { A.mr.requestData(); } catch (e) { /* */ } A.mr.stop(); await Promise.race([A.stopped, new Promise((r) => setTimeout(r, 3000))]); }
  for (const n of A.nodes) { try { origDisconnect.call(n, A.msd); } catch (e) { /* */ } }
  return { mime: A.mime || null, startMs: A.startMs, bytes: A.bytes, sampleRate: A.sampleRate || null, error: A.error || (A.ctx ? null : 'the game made no sound while recording') };
}

// ------------------------------------------------------------------------------------------ scene logger
const ATTR_NAMES = [];               // attribute-name table (defs: {k:'aname'})
const LAYER = { world: 0, ui: 1, hands: 2 };
const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _m = new THREE.Matrix4();
const TEX_KEYS = ['map', 'alphaMap', 'aoMap', 'lightMap', 'emissiveMap', 'specularMap', 'envMap', 'bumpMap', 'normalMap', 'displacementMap', 'roughnessMap', 'metalnessMap', 'gradientMap', 'matcap'];
let webpOK = null;
function imgType() {
  if (webpOK === null) { try { const c = document.createElement('canvas'); c.width = c.height = 2; webpOK = c.toDataURL('image/webp').startsWith('data:image/webp'); } catch (e) { webpOK = false; } }
  return webpOK ? ['image/webp', 'webp'] : ['image/png', 'png'];
}
function isRenderable(o) { return o.isMesh || o.isLine || o.isPoints || o.isSprite; }
function typeName(o) {
  if (o.isInstancedMesh) return 'InstancedMesh';
  if (o.isSprite) return 'Sprite'; if (o.isPoints) return 'Points';
  if (o.isLineLoop) return 'LineLoop'; if (o.isLineSegments) return 'LineSegments'; if (o.isLine) return 'Line';
  if (o.isMesh) return 'Mesh'; return 'Group';
}
function encodeArray(arr) {
  const t = arr.constructor.name;
  return { t, b64: b64(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)) };
}
function attrArray(a) {
  if (a.isInterleavedBufferAttribute) {
    const out = new Float32Array(a.count * a.itemSize);
    for (let i = 0; i < a.count; i++) for (let k = 0; k < a.itemSize; k++) out[i * a.itemSize + k] = a.getComponent ? a.getComponent(i, k) : [a.getX, a.getY, a.getZ, a.getW][k].call(a, i);
    return out;
  }
  return a.array;
}

const TELEPORT = 1.0;   // parent-local units moved in one logged frame that count as a jump, not motion

class Session {
  constructor() {
    this.id = 'rec-' + Date.now().toString(36);
    this.date = new Date();
    this.t0 = now();
    this.frame = 0; this.lastLog = -1e9; this.lastFlush = this.t0;
    this.bin = new BinWriter(); this.defs = [];
    this.seq = 0; this.bytes = 0; this.binBytes = 0; this.defBytes = 0; this.texBytes = 0; this.texFiles = 0;
    this.ids = 1;
    this.objs = new WeakMap(); this.geos = new WeakMap(); this.mats = new WeakMap(); this.texs = new Map();
    this.geoHash = new Map();
    this.prevVis = [];
    this.pendingTex = new Set();
    this.texCrc = new Map();
    this.sceneSig = '';
    this.view = null;
    this.stats = { maxObjs: 0, xforms: 0 };
    this.anames = new Map();
    this.flushing = Promise.resolve();
    this.bin.u32(0x31465243);           // 'CRF1'
    this.bin.u32(1);
    this.def({ k: 'meta', format: FORMAT, version: CFG.version, slug: CFG.slug, commit: CFG.commit, ua: navigator.userAgent });
  }
  def(o) { o.f = this.frame; this.defs.push(JSON.stringify(o)); }
  aname(n) { let i = this.anames.get(n); if (i === undefined) { i = this.anames.size; this.anames.set(n, i); this.def({ k: 'aname', i, n }); } return i; }

  // ---- geometry
  geo(g, o) {
    let e = this.geos.get(g);
    if (e) return e;
    e = { id: this.ids++, attrs: new Map(), dr0: g.drawRange.start, dr1: g.drawRange.count, idxVer: g.index ? g.index.version : -1, idx: g.index, checked: -1 };
    this.geos.set(g, e);
    const attrs = {};
    let dynamic = false;
    for (const name of Object.keys(g.attributes)) {
      const a = g.attributes[name];
      e.attrs.set(name, { a, v: a.version });
      if (a.usage === THREE.DynamicDrawUsage) dynamic = true;
      attrs[name] = { is: a.itemSize, n: !!a.normalized, ...encodeArray(attrArray(a)) };
    }
    const data = { attrs, index: g.index ? encodeArray(g.index.array) : null, groups: g.groups.length ? g.groups : undefined, dr: [g.drawRange.start, Number.isFinite(g.drawRange.count) ? g.drawRange.count : -1] };
    const body = JSON.stringify(data);
    const h = fnv(body);
    if (!dynamic && this.geoHash.has(h)) this.def({ k: 'geo', id: e.id, copyOf: this.geoHash.get(h) });
    else { if (!dynamic) this.geoHash.set(h, e.id); this.defs.push(`{"k":"geo","id":${e.id},"f":${this.frame},"type":${JSON.stringify(g.type)},"data":${body}}`); }
    return e;
  }
  geoUpdate(g, e, o) {
    if (e.checked === this.frame) return;
    e.checked = this.frame;
    const W = this.bin;
    const dr0 = g.drawRange.start, dr1 = g.drawRange.count;
    if (dr0 !== e.dr0 || dr1 !== e.dr1) {
      e.dr0 = dr0; e.dr1 = dr1;
      W.u8w(0x07); W.u32(e.id); W.i32(dr0); W.i32(Number.isFinite(dr1) ? dr1 : -1);
    }
    if (g.index && (g.index !== e.idx || g.index.version !== e.idxVer)) {
      e.idx = g.index; e.idxVer = g.index.version;
      this.writeAttr(e.id, '__index', g.index, g.index.count, 0);
    }
    let sparseDone = false;
    for (const name in g.attributes) {
      const a = g.attributes[name];
      const st = e.attrs.get(name);
      if (st && st.a === a && st.v === a.version) continue;
      e.attrs.set(name, { a, v: a.version });
      // A big additive point cloud (sparks): only the lit points are written.
      if (!sparseDone && o.isPoints && name in { position: 1, color: 1 } && g.attributes.color && g.attributes.position && a.count > 64 && o.material && o.material.blending === THREE.AdditiveBlending) {
        sparseDone = true;
        const pa = g.attributes.position, ca = g.attributes.color;
        e.attrs.set('position', { a: pa, v: pa.version }); e.attrs.set('color', { a: ca, v: ca.version });
        const P = pa.array, C = ca.array, n = pa.count;
        W.u8w(0x06); W.u32(e.id); W.u32(n);
        const at = W.p; W.u32(0); let k = 0;
        for (let i = 0; i < n; i++) {
          const r = C[i * 3], gg = C[i * 3 + 1], b = C[i * 3 + 2];
          if (r < 0.004 && gg < 0.004 && b < 0.004) continue;
          W.u32(i); W.f32(P[i * 3]); W.f32(P[i * 3 + 1]); W.f32(P[i * 3 + 2]);
          W.u8w(Math.min(255, Math.round(r * 255))); W.u8w(Math.min(255, Math.round(gg * 255))); W.u8w(Math.min(255, Math.round(b * 255)));
          k++;
        }
        W.dv.setUint32(at, k, true);
        continue;
      }
      if (sparseDone && (name === 'position' || name === 'color')) continue;
      let count = a.count;
      if (!g.index && Number.isFinite(dr1)) count = Math.min(count, dr0 + Math.max(0, dr1));
      this.writeAttr(e.id, name, a, count, a.count);
    }
  }
  writeAttr(gid, name, a, count, total) {
    const W = this.bin, is = a.itemSize, arr = attrArray(a);
    const color = name === 'color' && !(arr instanceof Uint8Array);
    const enc = name === '__index' ? (arr instanceof Uint32Array ? 3 : 2) : color ? 1 : (arr instanceof Float32Array ? 0 : 4);
    W.u8w(0x04); W.u32(gid); W.u16(this.aname(name)); W.u8w(enc); W.u8w(is); W.u32(total || count); W.u32(count);
    const n = count * is;
    if (enc === 0) { W.need(n * 4); for (let i = 0; i < n; i++) { W.dv.setFloat32(W.p, arr[i], true); W.p += 4; } }
    else if (enc === 1) { W.need(n); for (let i = 0; i < n; i++) W.u8[W.p++] = Math.max(0, Math.min(255, Math.round(arr[i] * 255))); }
    else if (enc === 2) { W.need(n * 2); for (let i = 0; i < n; i++) { W.dv.setUint16(W.p, arr[i], true); W.p += 2; } }
    else if (enc === 3) { W.need(n * 4); for (let i = 0; i < n; i++) { W.dv.setUint32(W.p, arr[i], true); W.p += 4; } }
    else { W.need(n * 4); for (let i = 0; i < n; i++) { W.dv.setFloat32(W.p, arr[i], true); W.p += 4; } }
  }

  // ---- materials + textures
  matSig(m) {
    let t = '';
    for (const k of TEX_KEYS) if (m[k]) t += k + m[k].uuid;
    return [m.type, m.version, m.transparent, m.blending, m.depthTest, m.depthWrite, m.side, m.vertexColors, m.size, m.sizeAttenuation, m.wireframe, m.colorWrite, m.visible, m.fog, m.alphaTest, m.toneMapped, m.rotation, t].join('|');
  }
  mat(m) {
    let e = this.mats.get(m);
    if (!e) { e = { id: this.ids++, sig: null, r: -1, g: -1, b: -1, o: -1, checked: -1 }; this.mats.set(m, e); }
    if (e.checked === this.frame) return e;
    e.checked = this.frame;
    const sig = this.matSig(m);
    if (sig !== e.sig) {
      e.sig = sig;
      const meta = { textures: new Proxy({}, { get: (t, k) => (typeof k === 'string' ? { uuid: k } : undefined) }), images: {} };
      let json;
      try { json = m.toJSON(meta); } catch (err) { json = { type: m.type, color: m.color ? m.color.getHex() : 0xffffff, opacity: m.opacity, transparent: m.transparent }; }
      delete json.metadata;
      this.def({ k: 'mat', id: e.id, json });
      e.r = e.g = e.b = e.o = NaN;
    }
    for (const k of TEX_KEYS) { const t = m[k]; if (t && t.isTexture) this.texSeen(t); }
    const c = m.color;
    const r = c ? c.r : 1, g = c ? c.g : 1, b = c ? c.b : 1, o = m.opacity;
    if (r !== e.r || g !== e.g || b !== e.b || o !== e.o) {
      e.r = r; e.g = g; e.b = b; e.o = o;
      (this.matDyn || (this.matDyn = [])).push(e.id, r, g, b, o);
    }
    return e;
  }
  texSeen(t) {
    let e = this.texs.get(t.uuid);
    if (!e) { e = { tex: t, ver: -1, last: -1e9, n: 0, busy: false }; this.texs.set(t.uuid, e); }
    e.seen = this.frame;
    if (e.tex !== t) e.tex = t;
    const ver = t.version;
    if (ver === e.ver || e.busy) return;
    const tt = now();
    if (tt - e.last < TEX_MIN_MS && e.n > 0) return;   // rate-limited; picked up again on a later frame
    e.ver = ver; e.last = tt; e.busy = true;
    const frame = this.frame;
    const p = this.snapTex(t, e, frame).finally(() => { e.busy = false; this.pendingTex.delete(p); });
    this.pendingTex.add(p);
  }
  async snapTex(t, e, frame) {
    const img = t.image;
    if (!img) return;
    const params = { w: img.width, h: img.height, flipY: t.flipY, cs: t.colorSpace, ws: t.wrapS, wt: t.wrapT, mag: t.magFilter, min: t.minFilter, mip: t.generateMipmaps, an: t.anisotropy, pm: t.premultiplyAlpha, rep: [t.repeat.x, t.repeat.y], off: [t.offset.x, t.offset.y], ctr: [t.center.x, t.center.y], rot: t.rotation, name: t.name || undefined };
    let blob = null;
    const [mime, ext] = imgType();
    try {
      let canvas = null;
      if (typeof HTMLCanvasElement !== 'undefined' && img instanceof HTMLCanvasElement) canvas = img;
      if (canvas) blob = await new Promise((res) => canvas.toBlob(res, mime, 0.92));
      else if (typeof OffscreenCanvas !== 'undefined' && img instanceof OffscreenCanvas) blob = await img.convertToBlob({ type: mime, quality: 0.92 });
      else {
        const c = document.createElement('canvas'); c.width = img.width || 1; c.height = img.height || 1;
        const cx = c.getContext('2d');
        if (img.data && img.width) { const id = cx.createImageData(img.width, img.height); if (img.data.length === id.data.length) id.data.set(img.data); cx.putImageData(id, 0, 0); }
        else cx.drawImage(img, 0, 0);
        blob = await new Promise((res) => c.toBlob(res, mime, 0.92));
      }
    } catch (err) { blob = null; }
    if (!blob || !this.active) return;
    const u8 = new Uint8Array(await blob.arrayBuffer());
    const crc = crc32(u8) + ':' + u8.length;
    let file = this.texCrc.get(crc);
    if (!file) {
      file = `tex/${t.uuid.slice(0, 8)}-${e.n}.${ext}`;
      this.texCrc.set(crc, file);
      this.texBytes += u8.length; this.texFiles++;
      await DB.addPart({ recId: this.id, kind: 'tex', seq: this.seq++, name: file, data: blob });
    }
    e.n++;
    this.defs.push(JSON.stringify({ k: 'tex', id: t.uuid, f: frame, file, p: params }));
  }

  // ---- objects
  classify(o, ctxLayer, ctrlMode, underCam) {
    if (ctrlMode) return ctrlMode;
    if (ctxLayer === 'ui') return 'ui';
    if (underCam) return 'ui';
    if (!isRenderable(o) || o.isPoints) return 'world';
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!m) return 'world';
    if (m.blending === THREE.AdditiveBlending) return 'world';
    const map = m.map;
    const canvasMap = map && map.image && ((typeof HTMLCanvasElement !== 'undefined' && map.image instanceof HTMLCanvasElement) || (typeof OffscreenCanvas !== 'undefined' && map.image instanceof OffscreenCanvas));
    if (canvasMap || m.depthTest === false) return 'ui';
    return 'world';
  }
  obj(o, layer, anc) {
    let e = this.objs.get(o);
    if (e && e.parent === o.parent && e.layer === layer) return e;
    if (e) { e.parent = o.parent; if (e.layer !== layer) { e.layer = layer; this.def({ k: 'objset', id: e.id, layer }); } return e; }
    e = { id: this.ids++, parent: o.parent, layer, m: new Float32Array(16).fill(NaN), geo: null, mat: null, ro: o.renderOrder, seen: -1 };
    this.objs.set(o, e);
    const d = { k: 'obj', id: e.id, type: typeName(o), layer, ro: o.renderOrder };
    if (o.name) d.name = o.name;
    if (anc.length) d.anc = anc.slice(-4);
    if (isRenderable(o)) {
      d.geo = this.geo(o.geometry, o).id;
      d.mat = Array.isArray(o.material) ? o.material.map((m) => this.mat(m).id) : this.mat(o.material).id;
      e.geo = o.geometry; e.matRef = o.material; e.matKey = Array.isArray(d.mat) ? d.mat.join(',') : d.mat;
      if (o.isSprite && o.center) d.center = [o.center.x, o.center.y];
      if (o.isInstancedMesh) d.count = o.count;
    }
    this.def(d);
    return e;
  }

  logFrame(renderer, scene, camera) {
    const W = this.bin, tRel = now() - this.t0;
    this.frame++;
    this.matDyn = [];
    // Frame header + head pose.
    W.u8w(0xfa); W.u32(this.frame); W.f64(tRel);
    camera.matrixWorld.decompose(_p, _q, _s);
    W.f32(_p.x); W.f32(_p.y); W.f32(_p.z); W.f32(_q.x); W.f32(_q.y); W.f32(_q.z); W.f32(_q.w);
    if (!this.view) {
      const cam = camera.isArrayCamera && camera.cameras && camera.cameras[0] ? camera.cameras[0] : camera;
      const pm = cam.projectionMatrix.elements;
      const fovY = 2 * Math.atan(1 / pm[5]) * 180 / Math.PI, aspect = pm[5] / pm[0];
      const vp = cam.viewport ? [cam.viewport.z, cam.viewport.w] : [renderer.domElement.width, renderer.domElement.height];
      this.view = { xr: !!(renderer.xr && renderer.xr.isPresenting), fovY, aspect, eyePx: vp };
      this.def({ k: 'view', ...this.view });
    }
    // Controllers (target-ray poses, in world space) + gamepad state.
    const sess = renderer.xr && renderer.xr.isPresenting ? renderer.xr.getSession() : null;
    const srcs = sess ? sess.inputSources : [];
    for (let i = 0; i < 2; i++) {
      const src = srcs[i];
      const c = sess ? renderer.xr.getController(i) : null;
      const hand = src ? (src.handedness === 'left' ? 1 : src.handedness === 'right' ? 2 : 3) : 0;
      W.u8w(hand);
      if (!hand) continue;
      c.matrixWorld.decompose(_p, _q, _s);
      W.f32(_p.x); W.f32(_p.y); W.f32(_p.z); W.f32(_q.x); W.f32(_q.y); W.f32(_q.z); W.f32(_q.w);
      const gp = src.gamepad;
      let pressed = 0, touched = 0;
      const ax = [0, 0, 0, 0];
      if (gp) {
        for (let b = 0; b < Math.min(16, gp.buttons.length); b++) { if (gp.buttons[b].pressed) pressed |= 1 << b; if (gp.buttons[b].touched) touched |= 1 << b; }
        for (let a = 0; a < Math.min(4, gp.axes.length); a++) ax[a] = gp.axes[a];
      }
      W.u16(pressed); W.u16(touched);
      for (let a = 0; a < 4; a++) W.i8(Math.max(-127, Math.min(127, Math.round(ax[a] * 127))));
      W.u8w(gp && gp.buttons[0] ? Math.round(gp.buttons[0].value * 255) : 0);
    }
    // Scene settings.
    const bg = scene.background && scene.background.isColor ? scene.background.getHex() : null;
    const fog = scene.fog ? { t: scene.fog.isFogExp2 ? 'exp2' : 'lin', c: scene.fog.color.getHex(), near: scene.fog.near, far: scene.fog.far, d: scene.fog.density } : null;
    const ssig = JSON.stringify([bg, fog]);
    if (ssig !== this.sceneSig) { this.sceneSig = ssig; this.def({ k: 'scene', bg, fog }); }

    // Traverse the visible scene graph.
    const ctrls = new Set();
    if (renderer.xr) for (let i = 0; i < 2; i++) { const c = renderer.xr.getController(i); if (c) ctrls.add(c); }
    const vis = [], xf = [];
    const frame = this.frame;
    const anc = [];
    const visit = (parent, ctxLayer, ctrlMode, underCam) => {
      const ch = parent.children;
      for (let i = 0; i < ch.length; i++) {
        const o = ch[i];
        if (!o.visible || o.userData.__crrec) continue;
        let cm = ctrlMode;
        if (ctrls.has(parent)) cm = isRenderable(o) ? 'ui' : 'hands';
        if (o.name && /^ctrl-/.test(o.name)) cm = 'hands';
        const ren = isRenderable(o);
        if (ren && o.material && (Array.isArray(o.material) ? !o.material[0] || !o.material[0].visible : !o.material.visible)) continue;
        const layer = this.classify(o, ctxLayer, cm, underCam);
        if (ren || o.name) {
          let e = this.obj(o, layer, anc);
          // A visible object that jumps (a pooled mesh handed to another star / bullet / effect, a respawn):
          // record it as a NEW object from here on, so the renderer cuts instead of sliding it across the
          // scene between the two frames. (Its parent-local position: normal motion is far below this.)
          if (e.lp && e.lastVis === frame - 1 && Math.abs(o.position.x - e.lp[0]) + Math.abs(o.position.y - e.lp[1]) + Math.abs(o.position.z - e.lp[2]) > TELEPORT) {
            this.objs.delete(o);
            e = this.obj(o, layer, anc);
            this.stats.recycled = (this.stats.recycled || 0) + 1;
          }
          if (!e.lp) e.lp = [0, 0, 0];
          e.lp[0] = o.position.x; e.lp[1] = o.position.y; e.lp[2] = o.position.z;
          e.seen = frame;
          vis.push(e);
          if (ren) {
            if (o.geometry !== e.geo) { e.geo = o.geometry; this.def({ k: 'objset', id: e.id, geo: this.geo(o.geometry, o).id }); }
            const ge = this.geos.get(o.geometry);
            if (ge) this.geoUpdate(o.geometry, ge, o);
            if (o.material !== e.matRef) {
              e.matRef = o.material;
              const mid = Array.isArray(o.material) ? o.material.map((m) => this.mat(m).id) : this.mat(o.material).id;
              this.def({ k: 'objset', id: e.id, mat: mid });
            } else if (Array.isArray(o.material)) o.material.forEach((m) => this.mat(m)); else this.mat(o.material);
            if (o.renderOrder !== e.ro) { e.ro = o.renderOrder; this.def({ k: 'objset', id: e.id, ro: o.renderOrder }); }
          }
          const me = o.matrixWorld.elements, lm = e.m;
          let changed = false;
          for (let k = 0; k < 16; k++) if (lm[k] !== Math.fround(me[k])) { changed = true; break; }
          if (changed) { lm.set(me); xf.push(o, e); }
        }
        if (o.children.length) {
          if (o.name) anc.push(o.name);
          visit(o, ren && layer === 'ui' ? 'ui' : ctxLayer, cm, underCam || o.isCamera);
          if (o.name) anc.pop();
        }
      }
    };
    visit(scene, 'world', null, false);

    // Visibility changes since the last logged frame.
    const shown = [], hidden = [];
    for (const e of this.prevVis) if (e.seen !== frame) hidden.push(e.id);
    for (const e of vis) if (e.lastVis !== frame - 1) shown.push(e.id);
    for (const e of vis) e.lastVis = frame;
    this.prevVis = vis;
    if (shown.length) { W.u8w(0x01); W.u32(shown.length); for (const id of shown) W.u32(id); }
    if (hidden.length) { W.u8w(0x02); W.u32(hidden.length); for (const id of hidden) W.u32(id); }
    if (xf.length) {
      W.u8w(0x03); W.u32(xf.length / 2);
      for (let i = 0; i < xf.length; i += 2) {
        const o = xf[i], e = xf[i + 1];
        _m.fromArray(o.matrixWorld.elements).decompose(_p, _q, _s);
        W.u32(e.id); W.f32(_p.x); W.f32(_p.y); W.f32(_p.z);
        W.i16(Math.round(_q.x * 32767)); W.i16(Math.round(_q.y * 32767)); W.i16(Math.round(_q.z * 32767)); W.i16(Math.round(_q.w * 32767));
        W.f32(_s.x); W.f32(_s.y); W.f32(_s.z);
      }
      this.stats.xforms += xf.length / 2;
    }
    if (this.matDyn.length) {
      const md = this.matDyn;
      W.u8w(0x05); W.u32(md.length / 5);
      for (let i = 0; i < md.length; i += 5) { W.u32(md[i]); W.f32(md[i + 1]); W.f32(md[i + 2]); W.f32(md[i + 3]); W.f32(md[i + 4]); }
    }
    W.u8w(0x00);
    this.stats.maxObjs = Math.max(this.stats.maxObjs, vis.length);
    this.lastVisCount = vis.length;
  }

  ev(type, data = {}) { if (this.active) this.def({ k: 'ev', t: Math.round(now() - this.t0), type, ...data }); }

  flush(final = false) {
    const bin = this.bin.take(), defs = this.defs.join('\n');
    this.defs = [];
    this.binBytes += bin.byteLength; this.defBytes += defs.length;
    const seq = this.seq; this.seq += 2;
    const meta = this.meta(final ? 'complete' : 'recording');
    this.flushing = this.flushing.then(async () => {
      if (bin.byteLength) await DB.addPart({ recId: this.id, kind: 'frames', seq, data: new Blob([bin]) });
      if (defs.length) await DB.addPart({ recId: this.id, kind: 'defs', seq: seq + 1, data: new Blob([defs + '\n']) });
      await DB.putRec(meta);
    }).catch((e) => console.warn('crrec flush', e));
    return this.flushing;
  }
  meta(status) {
    return {
      id: this.id, status, version: CFG.version, slug: CFG.slug, title: CFG.title, commit: CFG.commit, date: this.date.toISOString(), stamp: stamp(this.date),
      durationMs: Math.round(this.endMs !== undefined ? this.endMs : now() - this.t0), frames: this.frame, bytes: this.binBytes + this.defBytes + this.texBytes + (this.audioBytes || 0),
      audio: this.audioInfo || null, view: this.view, downloaded: false,
    };
  }
}

// ------------------------------------------------------------------------------------------ controller
const R = {
  renderer: null, scene: null, rec: null, holdT: 0, holdFired: false, overlay: null, flashMsg: '', flashUntil: 0,
  zips: new Map(), last: null, inXR: false,
};
let mainScene = null;

const origOBR = THREE.Scene.prototype.onBeforeRender;
THREE.Scene.prototype.onBeforeRender = function (renderer, scene, camera, rt) {
  if (origOBR) origOBR.call(this, renderer, scene, camera, rt);
  if (this.userData.__crrec) return;
  if (!mainScene) mainScene = this;
  if (this !== mainScene) return;
  try { onFrame(renderer, this, camera); } catch (e) { if (!R.errLogged) { R.errLogged = true; console.error('crrec frame', e); } }
};

function onFrame(renderer, scene, camera) {
  R.renderer = renderer; R.scene = scene;
  const xr = !!(renderer.xr && renderer.xr.isPresenting);
  if (xr !== R.inXR) { R.inXR = xr; xr ? onXRStart() : onXREnd(); }
  if (xr) gesture(renderer);
  const rec = R.rec;
  const t = now();
  if (rec && rec.active) {
    if (t - rec.lastLog >= LOG_MIN_MS) { rec.lastLog = t; rec.logFrame(renderer, scene, camera); }
    if (t - rec.lastFlush >= FLUSH_MS) { rec.lastFlush = t; rec.flush(); }
  }
  overlay(scene, camera, t);
}

function haptic(renderer, strength, ms, times = 1) {
  const s = renderer && renderer.xr && renderer.xr.getSession && renderer.xr.getSession();
  if (!s) return;
  for (const src of s.inputSources) {
    const act = src.gamepad && src.gamepad.hapticActuators && src.gamepad.hapticActuators[0];
    for (let i = 0; i < times; i++) setTimeout(() => { try { act && act.pulse && act.pulse(strength, ms); } catch (e) { /* */ } }, i * (ms + 90));
  }
}
function gesture(renderer) {
  const s = renderer.xr.getSession();
  if (!s) return;
  let n = 0;
  for (const src of s.inputSources) { const gp = src.gamepad; if (gp && gp.buttons[3] && gp.buttons[3].pressed) n++; }
  const t = now();
  if (n >= 2) {
    if (!R.holdT) R.holdT = t;
    if (!R.holdFired && t - R.holdT >= HOLD_MS) { R.holdFired = true; toggle('gesture'); }
  } else { R.holdT = 0; R.holdFired = false; }
}

// Small head-locked REC badge (only while recording / holding / for a short message). Not logged.
function overlay(scene, camera, t) {
  const rec = R.rec && R.rec.active ? R.rec : null;
  const holding = R.holdT && !R.holdFired ? Math.min(1, (t - R.holdT) / HOLD_MS) : 0;
  const flash = t < R.flashUntil ? R.flashMsg : '';
  const show = R.inXR && (rec || holding || flash);
  if (!R.overlay) {
    const c = document.createElement('canvas'); c.width = 512; c.height = 128;
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.04), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, fog: false, toneMapped: false }));
    mesh.renderOrder = 1e6; mesh.frustumCulled = false; mesh.userData.__crrec = true;
    const g = new THREE.Group(); g.userData.__crrec = true; g.add(mesh); g.matrixAutoUpdate = false;
    R.overlay = { g, mesh, c, ctx: c.getContext('2d'), tex, key: '' };
  }
  const O = R.overlay;
  if (!show) { if (O.g.parent) O.g.parent.remove(O.g); return; }
  if (O.g.parent !== scene) scene.add(O.g);
  const blink = rec ? (Math.floor((t - rec.t0) / 600) % 2) : 0;
  const key = `${rec ? fmtDur(t - rec.t0) : ''}|${Math.round(holding * 10)}|${flash}|${blink}`;
  if (key !== O.key) {
    O.key = key;
    const x = O.ctx; x.clearRect(0, 0, 512, 128);
    x.fillStyle = 'rgba(0,0,0,0.55)'; x.beginPath(); x.roundRect ? x.roundRect(4, 14, 504, 100, 30) : x.rect(4, 14, 504, 100); x.fill();
    x.font = 'bold 54px monospace'; x.textBaseline = 'middle';
    if (flash) { x.fillStyle = '#ffffff'; x.fillText(flash, 30, 64); }
    else if (holding) {
      x.fillStyle = '#ffcc66'; x.fillText(rec ? 'HOLD: STOP' : 'HOLD: REC', 30, 64);
      x.fillStyle = '#ff3344'; x.fillRect(30, 100, 450 * holding, 8);
    } else if (rec) {
      x.fillStyle = blink ? '#ff2a3a' : '#a0101a'; x.beginPath(); x.arc(62, 64, 26, 0, Math.PI * 2); x.fill();
      x.fillStyle = '#ffffff'; x.fillText('REC ' + fmtDur(t - rec.t0), 110, 66);
    }
    O.tex.needsUpdate = true;
  }
  // Lower-left of the view, 45 cm away, facing the eyes.
  O.g.matrix.copy(camera.matrixWorld).multiply(_m.makeTranslation(-0.1, -0.09, -0.45));
  O.g.matrixWorld.copy(O.g.matrix);
  O.mesh.updateMatrixWorld(true);
}
function flash(msg, ms = 2000) { R.flashMsg = msg; R.flashUntil = now() + ms; }

function start(reason = 'button') {
  if (R.rec && R.rec.active) return;
  const rec = new Session();
  rec.active = true;
  R.rec = rec;
  rec.ev('rec-start', { reason, xr: R.inXR });
  rec.audioWrites = [];
  audioStart(rec.t0, (blob) => { rec.audioBytes = (rec.audioBytes || 0) + blob.size; rec.audioWrites.push(DB.addPart({ recId: rec.id, kind: 'audio', seq: rec.seq++, data: blob })); });
  DB.putRec(rec.meta('recording'));
  flash('● RECORDING', 1500);
  haptic(R.renderer, 1.0, 250);
  ui.update();
}
async function stop(reason = 'button') {
  const rec = R.rec;
  if (!rec || !rec.active) return null;
  rec.ev('rec-stop', { reason });
  rec.endMs = now() - rec.t0;
  R.rec = null;                       // no more frames are logged
  flash('SAVED ' + fmtDur(rec.endMs), 2500);
  haptic(R.renderer, 0.8, 80, 2);
  ui.update('Saving...');
  await Promise.all([...rec.pendingTex]);
  rec.audioInfo = await audioStop();
  await Promise.all(rec.audioWrites);
  rec.audioBytes = rec.audioInfo ? rec.audioInfo.bytes : 0;
  rec.def({ k: 'end', t: Math.round(rec.endMs) });
  rec.active = false;
  await rec.flush(true);
  R.last = rec.id;
  await ui.refresh();
  let zip = null;
  try { zip = await buildZip(rec.id); } catch (e) { console.error('crrec zip', e); }
  ui.update(zip ? 'Recording ready: ' + fmtMB(zip.blob.size) : 'Saved (zip on demand)');
  if (!R.inXR && reason !== 'sessionend' && zip) download(rec.id);
  return rec.id;
}
function toggle(reason) { if (R.rec && R.rec.active) stop(reason); else start(reason); }

async function buildZip(recId) {
  if (R.zips.has(recId)) return R.zips.get(recId);
  const recs = await DB.getRecs();
  const meta = recs.find((r) => r.id === recId);
  if (!meta) throw new Error('no such recording');
  const parts = (await DB.getParts(recId)).sort((a, b) => a.seq - b.seq);
  const frames = parts.filter((p) => p.kind === 'frames').map((p) => p.data);
  const defs = parts.filter((p) => p.kind === 'defs').map((p) => p.data);
  const audio = parts.filter((p) => p.kind === 'audio').map((p) => p.data);
  const tex = parts.filter((p) => p.kind === 'tex');
  const audioExt = meta.audio && meta.audio.mime && meta.audio.mime.includes('ogg') ? 'ogg' : meta.audio && meta.audio.mime && meta.audio.mime.includes('mp4') ? 'm4a' : 'webm';
  const manifest = {
    format: FORMAT, game: 'COMMAND ROOM', version: CFG.version, slug: CFG.slug, title: CFG.title, commit: CFG.commit, builtFrom: CFG.date,
    recorded: meta.date, durationSec: meta.durationMs / 1000, frames: meta.frames, status: meta.status,
    logHz: meta.frames && meta.durationMs ? +(meta.frames / (meta.durationMs / 1000)).toFixed(1) : null,
    audio: audio.length ? { file: 'audio.' + audioExt, ...(meta.audio || {}) } : null,
    view: meta.view, textures: tex.length, userAgent: navigator.userAgent,
    files: { frames: 'frames.bin', defs: 'defs.jsonl' },
    note: 'Video is not recorded: re-render from the logged head pose with render/ (see README).',
  };
  const files = [
    { name: 'manifest.json', blob: new Blob([JSON.stringify(manifest, null, 2)]), compress: true },
    { name: 'frames.bin', blob: new Blob(frames), compress: true },
    { name: 'defs.jsonl', blob: new Blob(defs), compress: true },
  ];
  if (audio.length) files.push({ name: 'audio.' + audioExt, blob: new Blob(audio, { type: meta.audio && meta.audio.mime || 'audio/webm' }), compress: false });
  for (const t of tex) files.push({ name: t.name, blob: t.data, compress: false });
  const blob = await makeZip(files);
  const name = `commandroom-${CFG.version}-${meta.stamp}.zip`;
  const z = { blob, name, manifest };
  R.zips.set(recId, z);
  return z;
}
async function download(recId) {
  const z = await buildZip(recId);
  const url = URL.createObjectURL(z.blob);
  const a = document.createElement('a');
  a.href = url; a.download = z.name; document.body.appendChild(a); a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 60000);
  const recs = await DB.getRecs();
  const m = recs.find((r) => r.id === recId);
  if (m) { m.downloaded = true; await DB.putRec(m); }
  ui.refresh();
  return z.name;
}
async function remove(recId) { R.zips.delete(recId); await DB.del(recId); ui.refresh(); }

function onXRStart() {
  if (R.rec && R.rec.active) R.rec.ev('xr-start');
  if (ui.auto() && !(R.rec && R.rec.active)) setTimeout(() => { if (R.inXR) start('auto'); }, 300);
  else flash('THUMBSTICKS x2 HOLD 1s = REC', 4000);
}
function onXREnd() {
  if (R.rec && R.rec.active) { R.rec.ev('xr-end'); stop('sessionend'); }
}
document.addEventListener('visibilitychange', () => { if (R.rec) { R.rec.ev('visibility', { state: document.visibilityState }); if (document.visibilityState === 'hidden') R.rec.flush(); } });
window.addEventListener('pagehide', () => { if (R.rec) R.rec.flush(); });

// Game messages (DOM #message) as events.
function watchMessages() {
  const el = document.getElementById('message');
  if (!el || typeof MutationObserver === 'undefined') return;
  let last = '';
  new MutationObserver(() => {
    const txt = el.textContent.trim();
    if (txt && txt !== last && R.rec && R.rec.active) { last = txt; R.rec.ev('msg', { text: txt.slice(0, 200) }); }
  }).observe(el, { subtree: true, childList: true, characterData: true });
}

// ------------------------------------------------------------------------------------------ 2D page card
const ui = (() => {
  let root = null, els = {};
  const css = `
#crrec{position:fixed;left:10px;top:10px;z-index:2147483000;width:350px;max-height:calc(100vh - 20px);overflow:auto;box-sizing:border-box;
 background:rgba(4,10,20,.94);border:2px solid #ff4455;border-radius:10px;padding:12px 14px;font:15px/1.35 system-ui,Segoe UI,Arial,sans-serif;color:#dfefff;box-shadow:0 0 24px #000a}
#crrec.min .body{display:none}
#crrec a{color:#7fe9ff}
#crrec .top{display:flex;justify-content:space-between;align-items:center;gap:8px}
#crrec .back{font-weight:bold;text-decoration:none;font-size:16px}
#crrec .tog{background:none;border:1px solid #567;color:#cde;border-radius:6px;padding:4px 10px;font-size:14px}
#crrec h3{margin:8px 0 2px;font-size:18px;color:#fff;letter-spacing:1px}
#crrec .sub{color:#9ab;font-size:13px}
#crrec ol{margin:6px 0 8px;padding-left:22px}
#crrec li{margin:3px 0}
#crrec .btn{display:block;width:100%;margin:6px 0;padding:14px 10px;font:bold 18px system-ui,Arial,sans-serif;border-radius:8px;border:2px solid #ff4455;background:#3a0710;color:#fff;cursor:pointer}
#crrec .btn.stop{background:#ff2a3a}
#crrec .btn.dl{border-color:#3cf;background:#033a4a;font-size:20px;padding:18px 10px}
#crrec .hint{font-size:13px;color:#ffcc66;margin:4px 0}
#crrec .status{font-size:14px;color:#9fe;margin:4px 0;min-height:1em}
#crrec .list{margin-top:6px;border-top:1px solid #345;padding-top:6px}
#crrec .item{display:flex;align-items:center;gap:6px;margin:6px 0;font-size:13px}
#crrec .item span{flex:1}
#crrec .item button{padding:8px 10px;font:bold 13px system-ui,Arial;border-radius:6px;border:1px solid #3cf;background:#033a4a;color:#fff}
#crrec .item button.del{border-color:#a55;background:#2a0b0b}
#crrec label{display:flex;gap:8px;align-items:center;font-size:14px;margin:6px 0}
#crrec input[type=checkbox]{width:20px;height:20px}`;
  function build() {
    if (root || !document.body) return;
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    root = document.createElement('div'); root.id = 'crrec';
    const shots = (CFG.shots || []).map((s) => `<li>${s}</li>`).join('');
    root.innerHTML = `<div class="top"><a class="back" href="${CFG.index}">&larr; All versions</a><button class="tog">hide</button></div>
<div class="body"><h3>${CFG.version.toUpperCase()} &middot; ${CFG.title}</h3><div class="sub">Built ${CFG.date} &middot; ${CFG.commit}</div>
<div class="sub" style="margin-top:6px;color:#fff"><b>What to record (5-10 min):</b></div><ol>${shots}</ol>
<div class="hint">In VR: click BOTH thumbsticks in and hold 1 s to start / stop. A red REC badge shows in the lower left. Leaving VR stops and saves.</div>
<label><input type="checkbox" class="auto"> Start recording when I enter VR</label>
<button class="btn rec">&#9679; START RECORDING</button>
<div class="status"></div>
<button class="btn dl" style="display:none">&#11015; DOWNLOAD RECORDING</button>
<div class="list"></div></div>`;
    document.body.appendChild(root);
    els = { rec: root.querySelector('.rec'), status: root.querySelector('.status'), dl: root.querySelector('.dl'), list: root.querySelector('.list'), auto: root.querySelector('.auto'), tog: root.querySelector('.tog') };
    els.auto.checked = auto();
    els.auto.onchange = () => localStorage.setItem(AUTO_KEY, els.auto.checked ? '1' : '0');
    els.rec.onclick = () => toggle('button');
    els.dl.onclick = () => { if (R.last) download(R.last); };
    els.tog.onclick = () => { root.classList.toggle('min'); els.tog.textContent = root.classList.contains('min') ? 'show' : 'hide'; };
    update(); refresh();
    setInterval(() => { if (R.rec && R.rec.active) update(); }, 1000);
  }
  function auto() { return localStorage.getItem(AUTO_KEY) !== '0'; }
  function update(msg) {
    if (!root) return;
    const rec = R.rec && R.rec.active ? R.rec : null;
    els.rec.textContent = rec ? '■ STOP RECORDING' : '● START RECORDING';
    els.rec.classList.toggle('stop', !!rec);
    if (msg) els.status.textContent = msg;
    else if (rec) els.status.textContent = `REC ${fmtDur(now() - rec.t0)} · ${rec.frame} frames · ${fmtMB(rec.binBytes + rec.defBytes + rec.texBytes + (rec.audioBytes || 0))}`;
  }
  async function refresh() {
    if (!root) return;
    const recs = (await DB.getRecs()).sort((a, b) => (a.date < b.date ? 1 : -1));
    for (const r of recs) if (r.status === 'recording' && !(R.rec && R.rec.id === r.id)) { r.status = 'interrupted'; DB.putRec(r); }
    const pending = recs.filter((r) => !r.downloaded && !(R.rec && R.rec.active && R.rec.id === r.id));
    els.dl.style.display = R.last && pending.some((r) => r.id === R.last) ? 'block' : 'none';
    els.list.innerHTML = recs.length ? '<div class="sub">Recordings on this headset (kept until you delete them):</div>' : '';
    for (const r of recs) {
      if (R.rec && R.rec.active && R.rec.id === r.id) continue;
      const d = document.createElement('div'); d.className = 'item';
      d.innerHTML = `<span>${r.downloaded ? '&#10003;' : '<b style="color:#ff6677">UNSAVED</b>'} ${r.stamp.slice(11, 13)}:${r.stamp.slice(13)} &middot; ${fmtDur(r.durationMs)} &middot; ${fmtMB(r.bytes)}${r.status === 'interrupted' ? ' (interrupted)' : ''}</span><button class="get">Download</button><button class="del">Delete</button>`;
      d.querySelector('.get').onclick = () => { els.status.textContent = 'Building zip...'; download(r.id).then((n) => { els.status.textContent = 'Downloading ' + n; }); };
      d.querySelector('.del').onclick = () => { if (r.downloaded || confirm('Delete this recording? It has not been downloaded.')) remove(r.id); };
      els.list.appendChild(d);
    }
  }
  return { build, update, refresh, auto };
})();
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { ui.build(); watchMessages(); });
else { ui.build(); watchMessages(); }

// Console / test API.
window.__crrec = {
  start, stop, toggle, buildZip, download, remove, list: () => DB.getRecs(),
  get state() { const r = R.rec; return r ? { active: r.active, frames: r.frame, ms: now() - r.t0, bytes: r.binBytes + r.defBytes + r.texBytes + (r.audioBytes || 0) + r.bin.p, objs: r.lastVisCount, maxObjs: r.stats.maxObjs, texFiles: r.texFiles } : null; },
  get last() { return R.last; },
  get inXR() { return R.inXR; },
  _ctxs: () => [...audioTaps.keys()],
  get audioContexts() { return [...audioTaps.keys()].map((c) => `${c.state} t=${c.currentTime.toFixed(2)} sr=${c.sampleRate} nodes=${audioTaps.get(c).size}`); },
  cfg: CFG,
};
