// A loaded crrec-1 recording: the zip, the scene log decoder, and one index pass over every frame that builds
//   - checkpoints (visibility, transforms, material colours every ~2 s) so any time can be reached quickly,
//   - a per-geometry index of the streamed geometry records,
//   - position/rotation tracks for the ships, the player ship, the room and the head (camera targets),
//   - the wide-director's ship scan, and the session summary (runs, kills, best moments).
import * as THREE from 'three';
import { openZip } from './zip.js';
import { shipInfo, shipScanner } from '../../render/page/widedirector.js';
import { summarize, runsFromMessages } from './summary.js';

const CHECK_EVERY = 2.0;   // seconds between checkpoints

export class Recording {
  static async fromBuffer(key, buf, progress = () => {}) {
    const r = new Recording();
    r.key = key;
    await r._init(buf, progress);
    return r;
  }

  async _init(buf, progress) {
    progress('Unpacking', 0);
    this.zip = await openZip(buf);
    this.manifest = JSON.parse(await this.zip.text('manifest.json'));
    if (this.manifest.format !== 'crrec-1') throw new Error('Not a COMMAND ROOM recording (manifest format ' + this.manifest.format + ')');
    const m = this.manifest;
    const defsText = await this.zip.text(m.files.defs);
    const bin = await this.zip.bytes(m.files.frames);
    this.bin = bin.byteOffset === 0 && bin.byteLength === bin.buffer.byteLength ? bin.buffer : bin.slice().buffer;
    this.dv = new DataView(this.bin);
    if (this.dv.getUint32(0, true) !== 0x31465243) throw new Error('frames.bin is damaged (bad header)');
    const defs = [];
    for (const l of defsText.split('\n')) { if (!l) continue; try { defs.push(JSON.parse(l)); } catch (e) { /* skip a torn last line */ } }
    defs.forEach((d, i) => { d._i = i; });
    defs.sort((a, b) => (a.f - b.f) || (a._i - b._i));
    this.defs = defs;
    this.defF = Int32Array.from(defs, (d) => (d.f === undefined ? 0 : d.f));
    this.ANAMES = [];
    for (const d of defs) if (d.k === 'aname') this.ANAMES[d.i] = d.n;
    this.viewDef = defs.find((d) => d.k === 'view') || { fovY: 90, eyePx: [1832, 1920] };
    this.SHIPS = shipInfo(defs);
    this.objDefs = new Map();
    for (const d of defs) if (d.k === 'obj' && !this.objDefs.has(d.id)) this.objDefs.set(d.id, d);
    // later defs of the same material / texture / objset / obj id (seeking backwards re-applies the right one)
    this.defsById = new Map();
    defs.forEach((d, i) => {
      if (d.k !== 'mat' && d.k !== 'tex' && d.k !== 'objset' && d.k !== 'obj' && d.k !== 'scene') return;
      const key = d.k === 'obj' || d.k === 'objset' ? 'o' + d.id : d.k === 'scene' ? 'scene' : d.k[0] + d.id;
      let a = this.defsById.get(key); if (!a) this.defsById.set(key, a = []); a.push(i);
    });
    this.messages = defs.filter((d) => d.k === 'ev' && d.type === 'msg').map((d) => ({ t: d.t / 1000, text: d.text }));
    await this._indexPass(progress);
  }

  // ------------------------------------------------------------------ frame decoder (same layout as render/page/player.js)
  readFrame(o, full) {
    const dv = this.dv;
    const fr = { off: o };
    if (dv.getUint8(o) !== 0xfa) throw new Error('bad frame marker at ' + o);
    fr.idx = dv.getUint32(o + 1, true); fr.t = dv.getFloat64(o + 5, true); o += 13;
    const f7 = () => { const a = new Array(7); for (let i = 0; i < 7; i++) { a[i] = dv.getFloat32(o, true); o += 4; } return a; };
    fr.head = f7();
    fr.ctrl = [];
    for (let i = 0; i < 2; i++) {
      const hand = dv.getUint8(o); o += 1;
      if (!hand) { fr.ctrl.push(null); continue; }
      const pose = f7();
      o += 4 + 4 + 1;
      fr.ctrl.push({ hand, pose });
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
        if (full) for (let i = 0; i < n; i++) {
          const b = o + i * 36;
          fr.xf.set(dv.getUint32(b, true), {
            p: [dv.getFloat32(b + 4, true), dv.getFloat32(b + 8, true), dv.getFloat32(b + 12, true)],
            q: [dv.getInt16(b + 16, true) / 32767, dv.getInt16(b + 18, true) / 32767, dv.getInt16(b + 20, true) / 32767, dv.getInt16(b + 22, true) / 32767],
            s: [dv.getFloat32(b + 24, true), dv.getFloat32(b + 28, true), dv.getFloat32(b + 32, true)],
          });
        }
        o += n * 36;
      } else if (ty === 0x05) {
        const n = dv.getUint32(o, true); o += 4;
        if (full) for (let i = 0; i < n; i++) { const b = o + i * 20; fr.md.push([dv.getUint32(b, true), dv.getFloat32(b + 4, true), dv.getFloat32(b + 8, true), dv.getFloat32(b + 12, true), dv.getFloat32(b + 16, true)]); }
        o += n * 20;
      } else if (ty === 0x04) {
        const gid = dv.getUint32(o, true), an = dv.getUint16(o + 4, true), enc = dv.getUint8(o + 6), is = dv.getUint8(o + 7), total = dv.getUint32(o + 8, true), count = dv.getUint32(o + 12, true);
        o += 16;
        const sz = enc === 1 ? 1 : enc === 2 ? 2 : 4;
        if (full) fr.geo.push({ ty, gid, name: this.ANAMES[an], enc, is, total, count, off: o });
        o += count * is * sz;
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

  static geoKey(r) { return r.ty === 0x04 ? `4:${r.gid}:${r.name}` : `${r.ty}:${r.gid}`; }

  // ------------------------------------------------------------------ the index pass
  async _indexPass(progress) {
    const n = this.bin.byteLength;
    const frames = [];
    this.frames = frames;
    const vis = new Set(), base = new Map(), md = new Map();
    const checkpoints = [];
    const geoIdx = new Map();          // key -> [{k, r, full}]
    const geoAll = [];                 // every geo record in log order: [k, key]
    // camera-target tracks: ships, named objects, the room frame
    const trackIds = new Set([...this.SHIPS.shipIds, ...this.SHIPS.roomIds]);
    for (const d of this.objDefs.values()) if (d.name) trackIds.add(d.id);
    const tracks = new Map();          // id -> { t:[], p:[], q:[], on:[[t0,t1],...] }
    for (const id of trackIds) tracks.set(id, { t: [], p: [], q: [], on: [] });
    const durGuess = Math.max(1, this.manifest.durationSec || 600) + 5;
    const scanner = shipScanner(durGuess, this.SHIPS.shipIds, this.SHIPS.roomIds);
    const stats = summarize.collector(this);
    let o = 8, lastCheck = -1e9, T0 = null, k = 0, sliceStart = performance.now();
    const psDef = [...this.objDefs.values()].find((d) => d.name === 'player-ship');
    this.shipScale = 0;
    while (o < n) {
      let fr;
      try { fr = this.readFrame(o, true); } catch (e) { console.warn('frames.bin ends early at', o, e.message); this.truncated = true; break; }
      const tAbs = fr.t / 1000;
      if (T0 === null) T0 = tAbs;
      const t = tAbs - T0;
      frames.push({ off: fr.off, t, idx: fr.idx, head: fr.head, ctrl: fr.ctrl });
      for (const id of fr.shown) { vis.add(id); const tr = tracks.get(id); if (tr && (!tr.on.length || tr.on[tr.on.length - 1][1] !== null)) tr.on.push([t, null]); }
      for (const id of fr.hidden) { vis.delete(id); const tr = tracks.get(id); if (tr && tr.on.length && tr.on[tr.on.length - 1][1] === null) tr.on[tr.on.length - 1][1] = t; }
      for (const [id, x] of fr.xf) {
        base.set(id, x);
        const tr = tracks.get(id);
        if (tr) { tr.t.push(t); tr.p.push(x.p[0], x.p[1], x.p[2]); tr.q.push(x.q[0], x.q[1], x.q[2], x.q[3]); }
        if (psDef && id === psDef.id && !this.shipScale) this.shipScale = Math.abs(x.s[0]);
      }
      for (const a of fr.md) md.set(a[0], a);
      for (const r of fr.geo) {
        const key = Recording.geoKey(r);
        let L = geoIdx.get(key); if (!L) geoIdx.set(key, L = []);
        L.push({ k, r, full: r.ty !== 0x04 || r.name === '__index' || r.count >= r.total });
        geoAll.push(k, key);
      }
      scanner.add(fr, t);
      stats.frame(fr, t, vis);
      if (t - lastCheck >= CHECK_EVERY) {
        checkpoints.push({ k, vis: new Set(vis), base: new Map(base), md: new Map(md) });
        lastCheck = t;
      }
      o = fr.end; k++;
      if ((k & 511) === 0 && performance.now() - sliceStart > 30) {
        progress('Indexing scene log', o / n);
        await new Promise((res) => setTimeout(res, 0));
        sliceStart = performance.now();
      }
    }
    if (!frames.length) throw new Error('The recording has no frames');
    this.T0 = T0;
    this.duration = frames[frames.length - 1].t;
    this.frameT = Float64Array.from(frames, (f) => f.t);
    this.checkpoints = checkpoints;
    this.geoIdx = geoIdx;
    for (const L of geoIdx.values()) L.kArr = Int32Array.from(L, (e) => e.k);
    this.tracks = new Map();
    for (const [id, tr] of tracks) {
      if (!tr.t.length) continue;
      for (const iv of tr.on) if (iv[1] === null) iv[1] = this.duration;
      this.tracks.set(id, { t: Float64Array.from(tr.t), p: Float32Array.from(tr.p), q: Float32Array.from(tr.q), on: tr.on });
    }
    this.scan = scanner.result();
    // head track (smoothed like the renderer's head view) as a track
    this.headTrack = smoothTrack(frames.map((f) => ({ t: f.t, p: f.head.slice(0, 3), q: f.head.slice(3, 7) })), 0.12);
    // ship forward axis (models point +Z; confirm against the player ship's motion)
    this.shipAxis = new THREE.Vector3(0, 0, 1);
    const ps = [...this.objDefs.values()].find((d) => d.name === 'player-ship');
    this.playerShipId = ps ? ps.id : null;
    const ptr = ps && this.tracks.get(ps.id);
    if (ptr && ptr.t.length > 10) {
      let pos = 0, neg = 0;
      const q = new THREE.Quaternion(), z = new THREE.Vector3(), v = new THREE.Vector3();
      for (let i = 5; i < ptr.t.length; i += 3) {
        v.set(ptr.p[i * 3] - ptr.p[i * 3 - 15], ptr.p[i * 3 + 1] - ptr.p[i * 3 - 14], ptr.p[i * 3 + 2] - ptr.p[i * 3 - 13]);
        if (v.lengthSq() < 1e-10) continue;
        q.set(ptr.q[i * 4], ptr.q[i * 4 + 1], ptr.q[i * 4 + 2], ptr.q[i * 4 + 3]).normalize();
        z.set(0, 0, 1).applyQuaternion(q);
        if (z.dot(v) > 0) pos++; else neg++;
      }
      if (neg > pos * 1.5) this.shipAxis.set(0, 0, -1);
    }
    // the ship model is ~0.3 local units long (render/page/player.js)
    this.shipLen = 0.3 * (this.shipScale || 0.1);
    this.summary = stats.finish();
    this.summary.runs = runsFromMessages(this.messages.map((m) => ({ t: m.t - (this.T0 || 0), text: m.text })), this.duration, this.summary.secs, this.summary.events);
    progress('Ready', 1);
  }

  frameAt(t) {   // last frame with time <= t
    const a = this.frameT;
    if (t <= a[0]) return 0;
    let lo = 0, hi = a.length - 1;
    if (t >= a[hi]) return hi;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (a[m] <= t) lo = m; else hi = m; }
    return lo;
  }

  // ------------------------------------------------------------------ targets
  // position (+ rotation) of a camera target at local time t; false if unknown
  sampleTrack(id, t, outP, outQ) {
    if (id === 'head') return sampleObjTrack(this.headTrack, t, outP, outQ);
    if (id === 'room') {
      for (const rid of this.SHIPS.roomIds) { const tr = this.tracks.get(rid); if (tr) { sampleArr(tr, t, outP, outQ); return true; } }
      // no room frame: the middle of the action
      const c = this.actionCentre(t); if (!c) return false;
      outP.copy(c); if (outQ) outQ.identity(); return true;
    }
    if (id === 'player-ship') id = this.playerShipId;
    const tr = this.tracks.get(+id);
    if (!tr) return false;
    sampleArr(tr, t, outP, outQ);
    return true;
  }
  actionCentre(t) {
    const { BIN, nb, bins } = this.scan;
    const i = Math.min(nb - 1, Math.max(0, Math.floor(t / BIN)));
    const c = new THREE.Vector3(); let n = 0;
    for (let k = Math.max(0, i - 2); k <= Math.min(nb - 1, i + 2); k++) for (const p of bins[k]) { c.x += p[0]; c.y += p[1]; c.z += p[2]; n++; }
    return n ? c.divideScalar(n) : null;
  }
  // targets worth offering for [t0, t1]: player, head, room, then ships on screen in that window
  targetsFor(t0, t1) {
    const out = [{ id: 'player-ship', label: 'Player ship' }, { id: 'head', label: 'Player head (seat)' }, { id: 'room', label: 'Room centre' }];
    const ships = [];
    for (const id of this.SHIPS.shipIds) {
      if (id === this.playerShipId) continue;
      const tr = this.tracks.get(id); if (!tr) continue;
      let on = 0; for (const [a, b] of tr.on) on += Math.max(0, Math.min(b, t1) - Math.max(a, t0));
      if (on > 0.25) ships.push({ id: String(id), label: `${shipSideName(this, id)} ship #${id}`, on });
    }
    ships.sort((a, b) => b.on - a.on);
    return out.concat(ships.slice(0, 40));
  }
  visibleAt(id, t) {
    if (id === 'head' || id === 'room') return true;
    if (id === 'player-ship') id = this.playerShipId;
    const tr = this.tracks.get(+id); if (!tr) return false;
    for (const [a, b] of tr.on) if (t >= a && t <= b) return true;
    return false;
  }

  // ------------------------------------------------------------------ assets
  imageCache = new Map();
  image(file) {
    let p = this.imageCache.get(file);
    if (p) { this.imageCache.delete(file); this.imageCache.set(file, p); return p; }
    p = (async () => {
      if (!this.zip.has(file)) return null;
      const blob = await this.zip.blob(file, file.endsWith('.png') ? 'image/png' : file.endsWith('.jpg') ? 'image/jpeg' : 'image/webp');
      const url = URL.createObjectURL(blob);
      try { const im = new Image(); im.src = url; await im.decode(); return im; } catch (e) { return null; } finally { URL.revokeObjectURL(url); }
    })();
    this.imageCache.set(file, p);
    while (this.imageCache.size > 48) this.imageCache.delete(this.imageCache.keys().next().value);
    return p;
  }
  audioInfo() {
    const a = this.manifest.audio;
    return a && a.file && this.zip.has(a.file) ? { file: a.file, startMs: a.startMs || 0 } : null;
  }
  // decoded game audio (AudioBuffer at the context's rate), or null
  audioBuffer(ctx) {
    if (!this._audio) {
      const info = this.audioInfo();
      this._audio = !info ? Promise.resolve(null) : (async () => {
        const b = await this.zip.bytes(info.file);
        try { return await ctx.decodeAudioData(b.slice().buffer); } catch (e) { console.warn('audio decode failed', e); return null; }
      })();
    }
    return this._audio;
  }
  // seconds into the audio file for a local scene time
  audioOffset(t) { const a = this.audioInfo(); return a ? t - a.startMs / 1000 : 0; }
}

// ------------------------------------------------------------------ track helpers
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
function sampleArr(tr, t, outP, outQ) {
  const T = tr.t; let lo = 0, hi = T.length - 1;
  if (t <= T[0]) hi = lo = 0;
  else if (t >= T[hi]) lo = hi;
  else { while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m; else hi = m; } }
  const k = hi > lo ? (t - T[lo]) / Math.max(1e-6, T[hi] - T[lo]) : 0;
  const P = tr.p;
  outP.set(P[lo * 3] + (P[hi * 3] - P[lo * 3]) * k, P[lo * 3 + 1] + (P[hi * 3 + 1] - P[lo * 3 + 1]) * k, P[lo * 3 + 2] + (P[hi * 3 + 2] - P[lo * 3 + 2]) * k);
  if (outQ) {
    const Q = tr.q;
    _qa.set(Q[lo * 4], Q[lo * 4 + 1], Q[lo * 4 + 2], Q[lo * 4 + 3]).normalize();
    _qb.set(Q[hi * 4], Q[hi * 4 + 1], Q[hi * 4 + 2], Q[hi * 4 + 3]).normalize();
    outQ.slerpQuaternions(_qa, _qb, k);
  }
}
function sampleObjTrack(tr, t, outP, outQ) {
  if (!tr.length) return false;
  let lo = 0, hi = tr.length - 1;
  if (t <= tr[0].t) hi = 0;
  else if (t >= tr[hi].t) lo = hi;
  else while (hi - lo > 1) { const m = (lo + hi) >> 1; if (tr[m].t <= t) lo = m; else hi = m; }
  const a = tr[lo], b = tr[hi], k = hi > lo ? (t - a.t) / Math.max(1e-6, b.t - a.t) : 0;
  outP.set(a.p[0] + (b.p[0] - a.p[0]) * k, a.p[1] + (b.p[1] - a.p[1]) * k, a.p[2] + (b.p[2] - a.p[2]) * k);
  if (outQ) outQ.slerpQuaternions(_qa.fromArray(a.q), _qb.fromArray(b.q), k);
  return true;
}
function smoothTrack(tr, sigma) {
  const out = [];
  let lo = 0;
  for (let i = 0; i < tr.length; i++) {
    const t = tr[i].t;
    while (tr[lo].t < t - 3 * sigma) lo++;
    let w = 0; const p = [0, 0, 0], q = [0, 0, 0, 0], q0 = tr[i].q;
    for (let j = lo; j < tr.length && tr[j].t <= t + 3 * sigma; j++) {
      const d = (tr[j].t - t) / sigma, kk = Math.exp(-0.5 * d * d);
      w += kk;
      for (let a = 0; a < 3; a++) p[a] += tr[j].p[a] * kk;
      const qj = tr[j].q, sg = (qj[0] * q0[0] + qj[1] * q0[1] + qj[2] * q0[2] + qj[3] * q0[3]) < 0 ? -1 : 1;
      for (let a = 0; a < 4; a++) q[a] += qj[a] * kk * sg;
    }
    const ql = Math.hypot(...q) || 1;
    out.push({ t, p: p.map((x) => x / w), q: q.map((x) => x / ql) });
  }
  return out;
}
export function shipSideName(rec, id) {
  const s = rec.summary && rec.summary.sides && rec.summary.sides.get(+id);
  return s === 'red' ? 'Enemy' : s === 'gold' ? 'Gold' : s === 'cyan' ? 'Cyan' : 'Other';
}
