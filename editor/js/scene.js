// The reconstructed scene of one recording at any time t, seekable both ways (ported from render/page/player.js,
// which can only play forwards). Small steps forward apply the log frame by frame; jumps restore the nearest
// checkpoint from the recording's index pass, replay the few frames after it, bring every streamed geometry to
// its state at t from the geometry index, and re-apply the right material / texture / object definitions.
import * as THREE from 'three';
import { LineSegments2 } from '../../render/vendor/lines/LineSegments2.js';
import { LineSegmentsGeometry } from '../../render/vendor/lines/LineSegmentsGeometry.js';
import { LineMaterial } from '../../render/vendor/lines/LineMaterial.js';
import { Recording } from './recording.js';

const TEX_KEYS = ['map', 'alphaMap', 'aoMap', 'lightMap', 'emissiveMap', 'specularMap', 'envMap', 'bumpMap', 'normalMap', 'displacementMap', 'roughnessMap', 'metalnessMap', 'gradientMap', 'matcap'];
const TYPED = { Float32Array, Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array, Uint8ClampedArray, Float64Array };
const PLACEHOLDER = (() => { const c = document.createElement('canvas'); c.width = c.height = 1; return c; })();
const isLineType = (t) => t === 'Line' || t === 'LineSegments' || t === 'LineLoop';
function unb64(s, T) { const bs = atob(s); const u8 = new Uint8Array(bs.length); for (let i = 0; i < bs.length; i++) u8[i] = bs.charCodeAt(i); return new (TYPED[T] || Float32Array)(u8.buffer); }
function upper(arr, v) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= v) lo = m + 1; else hi = m; } return lo; }
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();

export class SceneState {
  constructor(rec, opt = {}) {
    this.rec = rec;
    this.opt = { ui: true, hands: true, lw: 1.6, bold: true, ...opt };
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0);
    this.textures = new Map(); this.mats = new Map(); this.geos = new Map(); this.nodes = new Map();
    this.matLoader = new THREE.MaterialLoader();
    this.defIdx = 0; this.k = -1; this.geoPtr = new Map(); this.nextFrame = null;
    this.W = 1920; this.H = 1080;
    this.busy = null;
  }
  // lines scale with the output height (1.6 px at 1080p), but never thinner than ~1 px (thumbnails, small viewers)
  get lineScale() { return Math.max(0.62, this.H / 1080); }
  get pointScale() { const v = this.rec.viewDef; return Math.max(1, this.H / Math.max(1, v.eyePx ? v.eyePx[1] : 1080)); }
  lwFor(e) { return (e.ship && this.opt.bold ? 2.6 : this.opt.lw) * this.lineScale; }
  boostOf(e) { return e.ship && this.opt.bold ? 1.2 : 1; }

  setSize(W, H) {
    if (W === this.W && H === this.H) return;
    this.W = W; this.H = H;
    for (const e of this.mats.values()) {
      if (e.fat) { e.fat.resolution.set(W, H); e.fat.linewidth = this.lwFor(e); }
      if (e.m.isPointsMaterial && !e.m.sizeAttenuation) e.m.size = e.m.userData.baseSize * this.pointScale;
    }
  }
  setOptions(o) {
    const boldChanged = o.bold !== undefined && o.bold !== this.opt.bold;
    Object.assign(this.opt, o);
    if (boldChanged) for (const e of this.mats.values()) if (e.fat) this.syncFat(e);
  }

  // ---------------------------------------------------------------- definitions
  tex(uuid) {
    let t = this.textures.get(uuid);
    if (!t) { t = new THREE.Texture(PLACEHOLDER); t.uuid = uuid; t.needsUpdate = true; this.textures.set(uuid, t); }
    return t;
  }
  async applyTex(d) {
    const t = this.tex(d.id), p = d.p || {};
    const im = await this.rec.image(d.file);
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
  defMat(d) {
    const texMap = {};
    for (const k of TEX_KEYS) if (d.json[k]) texMap[d.json[k]] = this.tex(d.json[k]);
    this.matLoader.setTextures(texMap);
    const m = this.matLoader.parse(d.json);
    if (m.isPointsMaterial) { m.userData.baseSize = m.size; if (!m.sizeAttenuation) m.size *= this.pointScale; }
    m.fog = false;
    let e = this.mats.get(d.id);
    if (!e) {
      e = { id: d.id, ship: this.rec.SHIPS.matIds.has(d.id), m, fat: null, users: new Set(), defColor: m.color ? m.color.clone() : null, defOpacity: m.opacity };
      this.mats.set(d.id, e);
    } else { const old = e.m; e.m = m; if (m.color && old.color) m.color.copy(old.color); m.opacity = old.opacity; old.dispose(); }
    if (e.fat) this.syncFat(e);
    for (const n of e.users) this.assignMat(n);
  }
  fatMat(e) {
    if (!e.fat) e.fat = new LineMaterial({ worldUnits: false, linewidth: this.lwFor(e), alphaToCoverage: false });
    this.syncFat(e);
    return e.fat;
  }
  syncFat(e) {
    const f = e.fat, m = e.m;
    f.color.copy(m.color || new THREE.Color(1, 1, 1)).multiplyScalar(this.boostOf(e)); f.opacity = m.opacity; f.transparent = m.transparent; f.blending = m.blending;
    f.depthTest = m.depthTest; f.depthWrite = m.depthWrite; f.vertexColors = m.vertexColors; f.fog = false;
    f.linewidth = this.lwFor(e);
    f.resolution.set(this.W, this.H);
    f.needsUpdate = true;
  }
  setMatColor(e, r, g, b, o) {
    if (e.m.color) e.m.color.setRGB(r, g, b); e.m.opacity = o;
    if (e.fat) { e.fat.color.setRGB(r, g, b).multiplyScalar(this.boostOf(e)); e.fat.opacity = o; }
  }
  defGeo(d) {
    if (this.geos.has(d.id)) return;
    let g;
    if (d.copyOf !== undefined) { const src = this.geos.get(d.copyOf); g = src ? src.g.clone() : new THREE.BufferGeometry(); }
    else {
      g = new THREE.BufferGeometry();
      for (const [name, a] of Object.entries(d.data.attrs)) g.setAttribute(name, new THREE.BufferAttribute(unb64(a.b64, a.t), a.is, a.n));
      if (d.data.index) g.setIndex(new THREE.BufferAttribute(unb64(d.data.index.b64, d.data.index.t), 1));
      if (d.data.groups) for (const gr of d.data.groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
      g.setDrawRange(d.data.dr[0], d.data.dr[1] < 0 ? Infinity : d.data.dr[1]);
    }
    g.computeBoundingSphere();
    this.geos.set(d.id, { g, ver: 0, fat: new Map() });
  }
  geoRecord(r) {
    const e = this.geos.get(r.gid);
    if (!e) return;
    const g = e.g, dv = this.rec.dv;
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
  fatGeo(gid, type) {
    const e = this.geos.get(gid);
    if (!e) return { geo: null, n: 0 };
    let f = e.fat.get(type);
    if (f && f.ver === e.ver) return f;
    if (!f) { f = { geo: null, ver: -1, n: 0 }; e.fat.set(type, f); }
    const g = e.g, P = g.attributes.position, C = g.attributes.color;
    f.ver = e.ver;
    if (!P) { f.n = 0; return f; }
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
    f.n = pairs.length / 2;
    return f;
  }
  defObj(d) {
    if (this.nodes.has(d.id)) { this.objSet(d); return; }
    let obj;
    const fat = this.opt.lw > 0 && isLineType(d.type);
    const gEntry = d.geo !== undefined ? this.geos.get(d.geo) : null;
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
    obj.userData.id = d.id;
    const n = { def: d, obj, layer: d.layer || 'world', vis: false, base: null, matIds: d.mat, geoId: d.geo, fat, type: d.type };
    this.nodes.set(d.id, n);
    if (d.mat !== undefined) this.assignMat(n);
    this.scene.add(obj);
  }
  assignMat(n) {
    const ids = Array.isArray(n.matIds) ? n.matIds : [n.matIds];
    const ms = ids.map((id) => { const e = this.mats.get(id); if (!e) return new THREE.MeshBasicMaterial({ visible: false }); e.users.add(n); return n.fat ? this.fatMat(e) : e.m; });
    n.obj.material = Array.isArray(n.matIds) ? ms : ms[0];
  }
  objSet(d) {
    const n = this.nodes.get(d.id);
    if (!n) return;
    if (d.layer) n.layer = d.layer;
    if (d.ro !== undefined) n.obj.renderOrder = d.ro;
    if (d.geo !== undefined) { n.geoId = d.geo; if (!n.fat && this.geos.get(d.geo)) n.obj.geometry = this.geos.get(d.geo).g; }
    if (d.mat !== undefined) { n.matIds = d.mat; this.assignMat(n); }
  }
  defScene(d) { this.scene.background = d.bg === null ? new THREE.Color(0) : new THREE.Color(d.bg); this.scene.fog = null; }
  applyDef(d) {
    switch (d.k) {
      case 'geo': this.defGeo(d); break;
      case 'mat': this.defMat(d); break;
      case 'obj': this.defObj(d); break;
      case 'objset': this.objSet(d); break;
      case 'tex': return this.applyTex(d);
      case 'scene': this.defScene(d); break;
      default: break;
    }
    return null;
  }
  static defKey(d) { return d.k === 'obj' || d.k === 'objset' ? 'o' + d.id : d.k === 'scene' ? 'scene' : d.k[0] + d.id; }

  // bring the applied definitions to defs[0 .. target)
  async defsTo(target) {
    const defs = this.rec.defs;
    if (target === this.defIdx) return;
    const pend = [];
    if (target > this.defIdx) {
      if (target - this.defIdx <= 64) {
        for (let i = this.defIdx; i < target; i++) { const p = this.applyDef(defs[i]); if (p) await p; }
      } else {
        // a long stretch: only the newest version of each material / texture matters
        const last = new Map();
        for (let i = this.defIdx; i < target; i++) { const d = defs[i]; if (d.k === 'mat' || d.k === 'tex') last.set(d.k[0] + d.id, i); }
        for (let i = this.defIdx; i < target; i++) {
          const d = defs[i];
          if (d.k === 'mat' || d.k === 'tex') {
            const key = d.k[0] + d.id, li = last.get(key);
            if (li === -1) continue;
            const exists = d.k === 'mat' ? this.mats.has(d.id) : this.textures.has(d.id) && this.textures.get(d.id).image !== PLACEHOLDER;
            if (i !== li && exists) continue;
            const p = this.applyDef(defs[li]); if (p) pend.push(p);
            last.set(key, -1);
            continue;
          }
          const p = this.applyDef(d); if (p) pend.push(p);
        }
      }
    } else {
      // going back: re-apply, for everything redefined after `target`, its definition as of `target`
      const keys = new Set();
      for (let i = target; i < this.defIdx; i++) { const d = defs[i]; if (d.k === 'mat' || d.k === 'tex' || d.k === 'objset' || d.k === 'obj' || d.k === 'scene') keys.add(SceneState.defKey(d)); }
      for (const key of keys) {
        const list = this.rec.defsById.get(key); if (!list) continue;
        const j = upper(list, target - 1) - 1;
        if (j < 0) continue;
        if (key[0] === 'o') { for (let x = 0; x <= j; x++) this.applyDef(defs[list[x]]); }
        else { const p = this.applyDef(defs[list[j]]); if (p) pend.push(p); }
      }
    }
    this.defIdx = target;
    if (pend.length) await Promise.all(pend);
  }

  // ---------------------------------------------------------------- frames
  applyFrameRecords(fr, withGeo) {
    if (withGeo) for (const r of fr.geo) {
      this.geoRecord(r);
      const key = Recording.geoKey(r);
      this.geoPtr.set(key, (this.geoPtr.has(key) ? this.geoPtr.get(key) : -1) + 1);
    }
    for (const id of fr.shown) { const n = this.nodes.get(id); if (n) n.vis = true; }
    for (const id of fr.hidden) { const n = this.nodes.get(id); if (n) n.vis = false; }
    for (const [id, x] of fr.xf) { const n = this.nodes.get(id); if (n) n.base = x; }
    for (const [id, r, g, b, o] of fr.md) { const e = this.mats.get(id); if (e) this.setMatColor(e, r, g, b, o); }
  }
  async stepTo(kT) {
    const rec = this.rec;
    for (let j = this.k + 1; j <= kT; j++) {
      const fr = rec.readFrame(rec.frames[j].off, true);
      await this.defsTo(upper(rec.defF, fr.idx));
      this.applyFrameRecords(fr, true);
      this.k = j;
    }
  }
  async jumpTo(kT) {
    const rec = this.rec;
    await this.defsTo(upper(rec.defF, rec.frames[kT].idx));
    // nearest checkpoint at or before kT
    const C = rec.checkpoints;
    let lo = 0, hi = C.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (C[m].k <= kT) lo = m; else hi = m - 1; }
    const c = C[lo];
    for (const n of this.nodes.values()) { n.vis = false; n.base = null; }
    for (const id of c.vis) { const n = this.nodes.get(id); if (n) n.vis = true; }
    for (const [id, x] of c.base) { const n = this.nodes.get(id); if (n) n.base = x; }
    for (const e of this.mats.values()) {
      const a = c.md.get(e.id);
      if (a) this.setMatColor(e, a[1], a[2], a[3], a[4]);
      else if (e.defColor) this.setMatColor(e, e.defColor.r, e.defColor.g, e.defColor.b, e.defOpacity);
    }
    for (let j = c.k + 1; j <= kT; j++) this.applyFrameRecords(rec.readFrame(rec.frames[j].off, true), false);
    // streamed geometry as of frame kT
    for (const [key, L] of rec.geoIdx) {
      const want = upper(L.kArr, kT) - 1;
      const cur = this.geoPtr.has(key) ? this.geoPtr.get(key) : -1;
      if (want === cur) continue;
      if (want < 0) { this.geoPtr.set(key, -1); continue; }
      let from = want;
      if (key[0] === '4' && !L[want].full) {
        if (cur >= 0 && cur < want) { let clean = true; for (let i = cur + 1; i <= want; i++) if (L[i].full) { clean = false; break; } from = clean ? cur + 1 : want; }
        if (from === want || cur < 0 || cur > want) { from = want; while (from > 0 && !L[from].full) from--; }
      }
      for (let i = from; i <= want; i++) this.geoRecord(L[i].r);
      this.geoPtr.set(key, want);
    }
    this.k = kT;
  }
  // make the scene state correct for local time t (seconds from the first frame)
  async seek(t) {
    // serialise: a seek waits for the previous one
    const prev = this.busy;
    let done; this.busy = new Promise((r) => { done = r; });
    if (prev) await prev;
    try {
      const rec = this.rec, kT = rec.frameAt(t);
      if (kT !== this.k) {
        if (kT > this.k && kT - this.k <= 40) await this.stepTo(kT);
        else await this.jumpTo(kT);
        this.nextFrame = kT + 1 < rec.frames.length ? rec.readFrame(rec.frames[kT + 1].off, true) : null;
      } else if (!this.nextFrame && kT + 1 < rec.frames.length) this.nextFrame = rec.readFrame(rec.frames[kT + 1].off, true);
      this.t = t;
    } finally { done(); if (this.busy) { /* keep chain */ } }
  }

  // ---------------------------------------------------------------- pose objects at t (interpolating to the next frame)
  pose(t) {
    const rec = this.rec;
    const tA = this.k >= 0 ? rec.frames[this.k].t : 0;
    const tB = this.nextFrame ? this.nextFrame.t / 1000 - rec.T0 : tA;
    const k = tB > tA ? Math.min(1, Math.max(0, (t - tA) / (tB - tA))) : 0;
    const ui = this.opt.ui, hands = this.opt.hands;
    for (const n of this.nodes.values()) {
      const layerOn = n.layer === 'ui' ? ui : n.layer === 'hands' ? hands : true;
      const show = n.vis && n.base && layerOn;
      n.obj.visible = !!show;
      if (!show) continue;
      const b = n.base, nx = this.nextFrame && this.nextFrame.xf.get(n.def.id);
      if (nx && k > 0) {
        n.obj.position.set(b.p[0] + (nx.p[0] - b.p[0]) * k, b.p[1] + (nx.p[1] - b.p[1]) * k, b.p[2] + (nx.p[2] - b.p[2]) * k);
        n.obj.quaternion.slerpQuaternions(_qa.fromArray(b.q).normalize(), _qb.fromArray(nx.q).normalize(), k);
        n.obj.scale.set(b.s[0] + (nx.s[0] - b.s[0]) * k, b.s[1] + (nx.s[1] - b.s[1]) * k, b.s[2] + (nx.s[2] - b.s[2]) * k);
      } else {
        n.obj.position.fromArray(b.p); n.obj.quaternion.fromArray(b.q).normalize(); n.obj.scale.fromArray(b.s);
      }
      if (n.fat) {
        const f = this.fatGeo(n.geoId, n.type);
        if (f.geo && n.obj.geometry !== f.geo) n.obj.geometry = f.geo;
        if (!f.n) n.obj.visible = false;
      }
    }
  }

  // objects that can be clicked as camera targets: visible world ships, projected to the screen
  pickables() {
    const out = [];
    for (const n of this.nodes.values()) {
      if (!n.obj.visible || n.layer !== 'world') continue;
      if (!this.rec.SHIPS.shipIds.has(n.def.id)) continue;
      out.push({ id: n.def.id, obj: n.obj });
    }
    return out;
  }

  dispose() {
    for (const e of this.geos.values()) { e.g.dispose(); for (const f of e.fat.values()) if (f.geo) f.geo.dispose(); }
    for (const e of this.mats.values()) { e.m.dispose(); if (e.fat) e.fat.dispose(); }
    for (const t of this.textures.values()) t.dispose();
    this.scene.clear();
    this.nodes.clear(); this.mats.clear(); this.geos.clear(); this.textures.clear();
  }
}
