// "Wide director" camera: an edited sequence that always shows the whole battle area, never close-ups.
// Shot types: wide static, slow wide orbit, slow drift / push, wide follow (trails the fight from a distance,
// still framing most of the area) and the player's head view (roll removed). Hard cuts every 2-4 s (varied),
// never the same type twice in a row, world up = screen up, pitch within +-35 deg.
// The battle area is measured from where the ships actually are in a window round each shot (robust box), so
// it follows the room when the player resizes or reshapes it. Ships stay readable through line width and
// brightness (see player.js: shipMatIds), not by moving the camera in.
import * as THREE from 'three';

const DEG = Math.PI / 180;
const MAX_PITCH = 35 * DEG;
const easeIO = (x) => { x = Math.min(1, Math.max(0, x)); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
const easeS = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
function rngFrom(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

// Which materials / objects are ships (small wireframe models in the world layer)?
export function shipInfo(defs) {
  const geo = new Map(); for (const d of defs) if (d.k === 'geo') geo.set(d.id, d);
  const rc = new Map();
  const geoR = (id) => {
    if (rc.has(id)) return rc.get(id);
    let d = geo.get(id), r = 0;
    while (d && d.copyOf !== undefined) d = geo.get(d.copyOf);
    const a = d && d.data && d.data.attrs && d.data.attrs.position;
    if (a && a.t === 'Float32Array') { const bs = atob(a.b64); const u8 = new Uint8Array(bs.length); for (let i = 0; i < bs.length; i++) u8[i] = bs.charCodeAt(i); const p = new Float32Array(u8.buffer); for (let i = 0; i + 2 < p.length; i += 3) r = Math.max(r, Math.hypot(p[i], p[i + 1], p[i + 2])); }
    rc.set(id, r); return r;
  };
  const shipIds = new Set(), matIds = new Set(), roomIds = new Set();
  for (const d of defs) {
    // The battle room frame: a 12-edge unit cube (24 vertices spanning -1..1) in the world.
    if (d.k === 'obj' && d.type === 'LineSegments' && (!d.layer || d.layer === 'world')) {
      let g = geo.get(d.geo); while (g && g.copyOf !== undefined) g = geo.get(g.copyOf);
      const a = g && g.data && g.data.attrs && g.data.attrs.position;
      if (a && a.t === 'Float32Array' && Math.abs(geoR(d.geo) - Math.sqrt(3)) < 0.05 && atob(a.b64).length === 24 * 12) roomIds.add(d.id);
    }
    if (d.k !== 'obj' || (d.layer && d.layer !== 'world') || !/^(LineSegments|Line|Points)$/.test(d.type)) continue;
    const r = geoR(d.geo);
    if (!(r > 0.05 && r < 0.35)) continue;
    if (d.type === 'LineSegments') shipIds.add(d.id);
    for (const m of [].concat(d.mat)) if (m !== undefined) matIds.add(m);
  }
  return { shipIds, matIds, roomIds };
}

// tight: 0 = whole-room framing, 0.5 = medium (default: halfway, in distance, between the room and the fight),
// 1 = frame the fight itself. Never nearer than 35 % of the whole-room distance.
export function buildWideDirector({ frames, readFrame, defs, T0, duration, log, seed = 7, aspect = 16 / 9, headAt, shipIds, roomIds = new Set(), tight = 0.5 }) {
  const rng = rngFrom(seed);
  const rr = (a, b) => a + rng() * (b - a);

  // ---------------------------------------------------------------- where the ships are (sampled ~10 Hz)
  const BIN = 0.5, nb = Math.ceil(duration / BIN) + 2;
  const bins = Array.from({ length: nb }, () => []);
  const vis = new Set(), pos = new Map();
  let lastSample = -1;
  const room = [];   // [t, visible, p, q, s] whenever the room frame changes
  let roomPose = null, roomVis = false;
  for (const f of frames) {
    const fr = readFrame(f.off, true), t = f.t - T0;
    for (const id of fr.shown) vis.add(id);
    for (const id of fr.hidden) vis.delete(id);
    for (const [id, x] of fr.xf) { if (shipIds.has(id)) pos.set(id, x.p); if (roomIds.has(id)) roomPose = x; }
    const rv = [...roomIds].some((id) => vis.has(id));
    if (roomPose && (rv !== roomVis || !room.length || room[room.length - 1][2] !== roomPose)) { room.push([t, rv, roomPose]); }
    roomVis = rv;
    if (t - lastSample < 0.1) continue;
    lastSample = t;
    const b = bins[Math.min(nb - 1, Math.max(0, Math.floor(t / BIN)))];
    for (const id of vis) { const p = pos.get(id); if (p) b.push(p); }
  }
  const headP = (t) => headAt(t).p;
  // Robust battle-area box for [t0, t1]: 4th-96th percentile per axis of the ship positions.
  function areaBox(t0, t1, pad = 1.5, q = 0.04, m = 0.18) {
    const pts = [];
    for (let i = Math.max(0, Math.floor((t0 - pad) / BIN)); i <= Math.min(nb - 1, Math.floor((t1 + pad) / BIN)); i++) for (const p of bins[i]) pts.push(p);
    if (pts.length < 6) return null;
    const lo = [], hi = [];
    for (let a = 0; a < 3; a++) { const v = pts.map((p) => p[a]).sort((x, y) => x - y); lo.push(v[Math.floor(v.length * q)]); hi.push(v[Math.min(v.length - 1, Math.floor(v.length * (1 - q)))]); }
    const box = new THREE.Box3(new THREE.Vector3(...lo), new THREE.Vector3(...hi));
    const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
    // m: never frame tighter than this (a lone ship would otherwise fill the frame)
    box.setFromCenterAndSize(c, new THREE.Vector3(Math.max(s.x, m), Math.max(s.y, m * 0.6), Math.max(s.z, m)));
    return { box, c: box.getCenter(new THREE.Vector3()), R: box.getSize(new THREE.Vector3()).length() / 2, n: pts.length };
  }
  function centroid(t) {   // action centre at t (for the follow shot)
    const i = Math.min(nb - 1, Math.max(0, Math.floor(t / BIN)));
    const pts = []; for (let k = Math.max(0, i - 1); k <= Math.min(nb - 1, i + 1); k++) pts.push(...bins[k]);
    if (!pts.length) return null;
    const c = new THREE.Vector3(); for (const p of pts) c.add(new THREE.Vector3(p[0], p[1], p[2])); return c.divideScalar(pts.length);
  }
  // The room frame's 8 world corners over [t0, t1] (null if the room is hidden then).
  function roomArea(t0, t1) {
    const corners = [];
    for (const t of [t0, (t0 + t1) / 2, t1]) {
      let e = null; for (const r of room) { if (r[0] <= t + 1e-6) e = r; else break; }
      if (!e || !e[1]) continue;
      const x = e[2], q = new THREE.Quaternion(x.q[0], x.q[1], x.q[2], x.q[3]).normalize(), P = new THREE.Vector3(...x.p);
      for (let i = 0; i < 8; i++) corners.push(new THREE.Vector3((i & 1 ? 1 : -1) * x.s[0], (i & 2 ? 1 : -1) * x.s[1], (i & 4 ? 1 : -1) * x.s[2]).applyQuaternion(q).add(P));
    }
    if (!corners.length) return null;
    const box = new THREE.Box3().setFromPoints(corners);
    return { box, corners, c: box.getCenter(new THREE.Vector3()), R: box.getSize(new THREE.Vector3()).length() / 2, room: true };
  }
  let lastArea = null;
  function area(t0, t1) {
    const a = roomArea(t0, t1) || areaBox(t0, t1) || areaBox(t0 - 6, t1 + 6);
    if (a) { lastArea = a; return a; }
    if (lastArea) return lastArea;
    // nothing flying yet: a metre-ish volume in front of the player
    const h = headAt(t0), f = new THREE.Vector3(0, 0, -1).applyQuaternion(h.q); f.y = 0; f.normalize();
    const c = h.p.clone().addScaledVector(f, 0.8).add(new THREE.Vector3(0, -0.2, 0));
    return { box: new THREE.Box3().setFromCenterAndSize(c, new THREE.Vector3(0.7, 0.4, 0.7)), c, R: 0.5, n: 0 };
  }
  const shipsAt = (t) => { const i = Math.min(nb - 1, Math.max(0, Math.floor(t / BIN))); return bins[i].length; };

  // ---------------------------------------------------------------- framing
  function seatAz(a) {   // azimuth from the area centre towards the player's seat
    const h = headP(0.5 * (a.t0 + a.t1)); return Math.atan2(h.x - a.c.x, h.z - a.c.z);
  }
  const dirFrom = (az, el) => new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
  // Closest distance at which all 8 corners of the area box sit inside the frame (with a margin), seen from
  // direction (az, el) looking at the box centre.
  const _q = new THREE.Quaternion(), _eu = new THREE.Euler(0, 0, 0, 'YXZ');
  function fitBox(A, az, el, fov, mx = 0.95, my = 0.93) {
    const corners = A.corners ? A.corners : []; const b = A.box;
    if (!A.corners) for (let i = 0; i < 8; i++) corners.push(new THREE.Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z));
    const ty = Math.tan(fov / 2 * DEG), tx = ty * aspect;
    const fits = (d) => {
      const cam = A.c.clone().addScaledVector(dirFrom(az, el), d), dd = A.c.clone().sub(cam);
      _q.setFromEuler(_eu.set(Math.atan2(dd.y, Math.hypot(dd.x, dd.z)), Math.atan2(-dd.x, -dd.z), 0, 'YXZ')).invert();
      for (const p of corners) { const v = p.clone().sub(cam).applyQuaternion(_q); if (v.z > -1e-4) return false; if (Math.abs(v.x / (-v.z * tx)) > mx || Math.abs(v.y / (-v.z * ty)) > my) return false; }
      return true;
    };
    let lo = 0.05 * A.R, hi = 8 * A.R;
    if (!fits(hi)) return hi;
    for (let k = 0; k < 30; k++) { const m = (lo + hi) / 2; if (fits(m)) hi = m; else lo = m; }
    return hi;
  }

  function propose(type, t0, t1) {
    const A = area(t0, t1); A.t0 = t0; A.t1 = t1;
    // The fight: core 76 % of the ship positions over the shot (+-0.5 s).
    const Act = tight > 0 ? (areaBox(t0, t1, 0.5, 0.12, 0.12) || A) : A;
    const shot = { type, t0, t1, c: A.c.clone().lerp(Act.c, Math.min(1, tight * 1.4)), R: A.R, room: !!A.room };
    const fitMix = (az, el, fov, mx, my) => {
      const dr = fitBox(A, az, el, fov, mx, my);
      if (!tight) return dr;
      const da = fitBox(Act, az, el, fov, mx, my);
      return Math.max(Math.pow(dr, 1 - tight) * Math.pow(da, tight), 0.35 * dr);
    };
    // Mostly from the player's side of the room (so screen-left/right matches what they saw), sometimes the flank.
    const az0 = seatAz(A) + (rng() < 0.7 ? rr(-55, 55) : (rng() < 0.5 ? -1 : 1) * rr(70, 120)) * DEG;
    switch (type) {
      // Longer lenses from further back: the box fills the frame evenly instead of the near corners ballooning.
      case 'static': shot.fov = rr(32, 40); shot.el = rr(9, 24) * DEG; shot.az = az0; shot.d = fitMix(shot.az, shot.el, shot.fov); break;
      case 'orbit': {
        shot.fov = rr(32, 38); shot.el = rr(8, 20) * DEG; shot.az = az0; shot.sweep = (rng() < 0.5 ? -1 : 1) * rr(12, 24) * DEG;
        let d = 0; for (let k = 0; k <= 4; k++) d = Math.max(d, fitMix(shot.az + shot.sweep * k / 4, shot.el, shot.fov)); shot.d = d;
        break;
      }
      case 'drift': {
        shot.fov = rr(34, 40); shot.el = rr(8, 22) * DEG; shot.az = az0;
        shot.push = rng() < 0.5 ? rr(-0.08, -0.05) : rr(0.05, 0.08);   // dolly in (-) or out (+), fraction of d
        shot.truck = (rng() < 0.5 ? -1 : 1) * rr(0.05, 0.1) * A.R;      // sideways slide (camera and aim together)
        shot.rise = rr(-0.03, 0.05) * A.R;
        // fitted at the drift's tightest point (pushed in, slid to one end) so the room is never cropped
        shot.d = fitMix(shot.az, shot.el, shot.fov, 0.86, 0.84) / (1 + Math.min(0, shot.push)) + Math.abs(shot.truck) * 1.2;
        break;
      }
      case 'follow': {
        // Trails the fight: frames the box round the ships (not the whole room) from outside it, pivot on the
        // smoothed action centre.
        shot.fov = rr(38, 46); shot.el = rr(10, 24) * DEG; shot.az = az0;
        const S = areaBox(t0, t1, 0.5) || A;
        const Sx = { box: S.box, c: S.c, R: S.R };
        // never a close-up: at least 65 % of the distance that frames the whole room
        shot.d = Math.max(fitBox(Sx, shot.az, shot.el, shot.fov, 0.85, 0.8) * (1 - 0.3 * tight), S.R * 1.3, (0.65 - 0.3 * tight) * fitBox(A, shot.az, shot.el, shot.fov));
        const cs = []; for (let k = 0; k <= 24; k++) { const tt = t0 + (t1 - t0) * k / 24; cs.push(centroid(tt) || S.c.clone()); }
        for (let i = 1; i < cs.length; i++) cs[i] = cs[i - 1].clone().lerp(cs[i], 0.3);
        shot.path = cs.map((p) => p.lerp(S.c, 0.4));
        shot.R = S.R;
        break;
      }
      case 'head': shot.fov = 82; break;
    }
    return shot;
  }
  function camAt(shot, t) {
    const u = (t - shot.t0) / Math.max(1e-6, shot.t1 - shot.t0);
    switch (shot.type) {
      case 'static': return { cam: shot.c.clone().addScaledVector(dirFrom(shot.az, shot.el), shot.d), look: shot.c };
      case 'orbit': return { cam: shot.c.clone().addScaledVector(dirFrom(shot.az + shot.sweep * easeIO(u), shot.el), shot.d), look: shot.c };
      case 'drift': {
        const e = easeS(u), dir = dirFrom(shot.az, shot.el), side = new THREE.Vector3(Math.cos(shot.az), 0, -Math.sin(shot.az));
        const cam = shot.c.clone().addScaledVector(dir, shot.d * (1 + shot.push * e)).addScaledVector(side, shot.truck * (e - 0.5)).add(new THREE.Vector3(0, shot.rise * (e - 0.5), 0));
        return { cam, look: shot.c.clone().addScaledVector(side, shot.truck * (e - 0.5)) };
      }
      case 'follow': {
        const k = Math.max(0, Math.min(shot.path.length - 1, u * (shot.path.length - 1))), i = Math.floor(k), f = k - i;
        const look = i + 1 < shot.path.length ? shot.path[i].clone().lerp(shot.path[i + 1], f) : shot.path[i].clone();
        return { cam: look.clone().addScaledVector(dirFrom(shot.az, shot.el), shot.d), look };
      }
      default: { const h = headAt(t); const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(h.q); return { cam: h.p.clone(), look: h.p.clone().add(fwd) }; }
    }
  }
  // Head view only when the player is actually looking into the battle area.
  function headLooksAtAction(t0, t1) {
    const A = area(t0, t1);
    for (let k = 0; k <= 4; k++) {
      const t = t0 + (t1 - t0) * k / 4, h = headAt(t);
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(h.q), to = A.c.clone().sub(h.p);
      if (fwd.angleTo(to) > 30 * DEG) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- the edit
  const WEIGHT = { static: 1.1, orbit: 1.2, drift: 1, follow: 1.1, head: 0.7 };
  const TYPES = Object.keys(WEIGHT);
  const shots = [];
  let t = 0, prev = null;
  const pick = (types) => { let tot = 0; for (const x of types) tot += WEIGHT[x]; let r = rng() * tot; for (const x of types) { r -= WEIGHT[x]; if (r <= 0) return x; } return types[types.length - 1]; };
  while (t < duration - 0.3) {
    let len = rr(2, 4);
    if (t + len > duration) len = duration - t;
    if (len < 1.2 && shots.length) { shots[shots.length - 1].t1 = duration; break; }
    let types = TYPES.filter((x) => x !== prev);
    if (shipsAt(t + len / 2) < 2) types = types.filter((x) => x !== 'follow');        // nothing to trail
    let type = pick(types);
    if (type === 'head') { if (!headLooksAtAction(t, t + Math.min(len, 3))) type = pick(types.filter((x) => x !== 'head')); else len = Math.min(len, 3); }
    shots.push(propose(type, t, t + len));
    prev = type; t += len;
  }
  log(`wide-director: framing ${tight === 0 ? 'room' : tight === 0.5 ? 'medium' : 'tight=' + tight}; room frame ${roomIds.size ? 'found (' + [...roomIds].join(',') + ')' : 'not found - framing the ships'}, ${room.length} room poses`);
  log('wide-director shots: ' + shots.map((s) => `${s.t0.toFixed(1)} ${s.type}${s.R ? ' R' + s.R.toFixed(2) + (s.room ? 'r' : '') : ''}`).join(' | '));

  // ---------------------------------------------------------------- per frame
  const _e = new THREE.Euler(0, 0, 0, 'YXZ');
  const st = { shot: null, yaw: 0, pitch: 0, p: new THREE.Vector3() };
  const wrap = (a) => a - Math.round(a / (2 * Math.PI)) * 2 * Math.PI;
  function shotAt(tt) { let s = shots[0]; for (const x of shots) { if (x.t0 <= tt + 1e-6) s = x; else break; } return s; }
  function update(camera, tt, dt) {
    const shot = shotAt(tt);
    if (!shot) return;
    const cut = shot !== st.shot; st.shot = shot;
    const { cam, look } = camAt(shot, tt);
    const d = look.clone().sub(cam);
    const yaw = Math.atan2(-d.x, -d.z), pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, Math.atan2(d.y, Math.hypot(d.x, d.z))));
    if (cut) { st.p.copy(cam); st.yaw = yaw; st.pitch = pitch; }
    else {
      // head view: smooth the player's look (roll is dropped); the rest is already smooth by construction
      const k = shot.type === 'head' ? 1 - Math.exp(-dt / 0.18) : 1;
      st.p.lerp(cam, shot.type === 'head' ? 1 - Math.exp(-dt / 0.1) : 1);
      st.yaw += wrap(yaw - st.yaw) * k; st.pitch += (pitch - st.pitch) * k;
    }
    camera.position.copy(st.p);
    camera.up.set(0, 1, 0);
    camera.quaternion.setFromEuler(_e.set(st.pitch, st.yaw, 0, 'YXZ'));
    camera.fov = shot.fov || 50;
    camera.near = shot.type === 'head' ? 0.02 : Math.max(0.005, (shot.d || 1) * 0.02);
    camera.far = 1000;
  }
  return { update, shots };
}
