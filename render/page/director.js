// "Director" camera: an edited sequence of shots planned from the whole log (lookahead), hard cuts every 2-4 s.
// Rules: world up = screen up (zero roll), pitch within +-35 deg, smooth eased motion inside a shot, never the same
// shot type twice in a row. Subjects are chosen by action: upcoming kills first, then the player's ship / the
// nearest enemy / the busiest cluster. Every candidate camera is scored over the shot (subject in frame, not hidden
// behind an obstacle, camera not inside anything) and the best one is used.
import * as THREE from 'three';

const DEG = Math.PI / 180;
const MAX_PITCH = 35 * DEG;
const easeIO = (x) => { x = Math.min(1, Math.max(0, x)); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
function rngFrom(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

export function buildDirector({ frames, readFrame, defs, T0, duration, log, seed = 7, aspect = 16 / 9, trackName = 'player-ship' }) {
  const rng = rngFrom(seed);
  const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);
  const rr = (a, b) => a + rng() * (b - a);
  const sign = () => (rng() < 0.5 ? -1 : 1);

  // ---------------------------------------------------------------- objects from the log
  const geoDefs = new Map(), matDefs = new Map();
  for (const d of defs) { if (d.k === 'geo') geoDefs.set(d.id, d); if (d.k === 'mat') matDefs.set(d.id, d); }
  const radiusCache = new Map();
  function geoRadius(id) {
    if (radiusCache.has(id)) return radiusCache.get(id);
    let d = geoDefs.get(id), r = 0;
    while (d && d.copyOf !== undefined) d = geoDefs.get(d.copyOf);
    if (d && d.data && d.data.attrs.position && d.data.attrs.position.t === 'Float32Array') {
      const bs = atob(d.data.attrs.position.b64); const u8 = new Uint8Array(bs.length); for (let i = 0; i < bs.length; i++) u8[i] = bs.charCodeAt(i);
      const p = new Float32Array(u8.buffer);
      for (let i = 0; i < p.length; i += 3) r = Math.max(r, Math.hypot(p[i], p[i + 1], p[i + 2]));
    }
    radiusCache.set(id, r);
    return r;
  }
  const objs = new Map();   // world line objects: ship candidates (small) and possible occluders (big)
  for (const d of defs) {
    if (d.k !== 'obj' || !/Line/.test(d.type) || (d.layer && d.layer !== 'world')) continue;
    const r0 = geoRadius(d.geo);
    if (!(r0 > 0.05)) continue;
    const md = matDefs.get(d.mat);
    const c = md && md.json && md.json.color !== undefined ? md.json.color : 0xffffff;
    objs.set(d.id, { def: d, id: d.id, r0, color: c, samples: [], vis: [], small: d.type === 'LineSegments' && r0 < 0.6, player: (d.anc || []).includes(trackName) });
  }
  const spawns = [];
  const seen = new Set();
  for (const f of frames) {
    const fr = readFrame(f.off, true);
    const t = f.t - T0;
    for (const id of fr.shown) { const c = objs.get(id); if (c) c.vis.push([t, 1]); }
    for (const id of fr.hidden) { const c = objs.get(id); if (c) c.vis.push([t, 0]); }
    for (const [id, x] of fr.xf) {
      const c = objs.get(id);
      if (c) c.samples.push([t, x.p[0], x.p[1], x.p[2], x.q[0], x.q[1], x.q[2], x.q[3], Math.abs(x.s[0])]);
      if (!seen.has(id)) { seen.add(id); if (!c || !c.small) spawns.push({ t, p: V(x.p) }); }
    }
  }
  // Transforms are logged on change only: carry a still object's last pose to the end of the log.
  const tLogEnd = frames.length ? frames[frames.length - 1].t - T0 : duration;
  for (const c of objs.values()) {
    const last = c.samples[c.samples.length - 1], lastVis = c.vis[c.vis.length - 1];
    if (last && last[0] < tLogEnd - 0.05 && !(lastVis && lastVis[1] === 0)) c.samples.push([tLogEnd, ...last.slice(1)]);
  }
  let ships = [];
  const bigs = [], pulsers = [];
  for (const c of objs.values()) {
    if (!c.samples.length) continue;
    let path = 0, smin = Infinity, smax = 0;
    for (let i = 1; i < c.samples.length; i++) { const a = c.samples[i - 1], b = c.samples[i]; path += Math.hypot(b[1] - a[1], b[2] - a[2], b[3] - a[3]); }
    for (const s of c.samples) { smin = Math.min(smin, s[8]); smax = Math.max(smax, s[8]); }
    if (smax <= 0) continue;
    c.r = c.r0 * smax; c.rMin = c.r0 * smin;
    const ratio = smax / Math.max(smin, 1e-9);
    if (ratio > 1.3 && c.player && c.small) {   // the player's ship may scale (launch / landing): use its typical size
      const ss = c.samples.map((s) => s[8]).sort((a, b) => a - b); c.r = c.r0 * ss[Math.floor(ss.length / 2)];
    } else if (ratio > 1.3) { if (ratio < 2 && c.r0 >= 0.35) pulsers.push(c); continue; }   // shock spheres; pulsing stars
    const col = new THREE.Color(c.color);
    // Ships are small models that move; drifting rocks (model radius >= ~0.5) are scenery.
    // The player's ship always counts, even when it barely moves (Endless scrolls the galaxy past it).
    const isPlayerHull = c.player && c.def.type === 'LineSegments' && c.r0 < 0.35 && !ships.some((s) => s.player);
    if (c.small && c.r0 < 0.35 && (isPlayerHull || (c.samples.length >= 15 && path > 4 * c.r))) {
      c.enemy = col.r > col.g * 1.3 && col.r > col.b * 1.3;
      ships.push(c);
    } else bigs.push(c);
  }
  let rMed = ships.length ? ships.map((s) => s.r).sort((a, b) => a - b)[Math.floor(ships.length / 2)] : 0.1;
  for (const s of ships.filter((x) => x.r > 2.5 * rMed)) bigs.push(s);
  ships = ships.filter((x) => x.r <= 2.5 * rMed);
  rMed = ships.length ? ships.map((s) => s.r).sort((a, b) => a - b)[Math.floor(ships.length / 2)] : 0.1;
  const box = new THREE.Box3();
  for (const s of ships) for (let i = 0; i < s.samples.length; i += 4) box.expandByPoint(V(s.samples[i].slice(1, 4)));
  if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(0, 1, -1), new THREE.Vector3(1, 1, 1));
  // Few or static ships (an Endless cruise): the action space is at least ~50 ship radii across.
  { const c = box.getCenter(new THREE.Vector3()), sz = box.getSize(new THREE.Vector3()), m = 50 * rMed;
    box.setFromCenterAndSize(c, new THREE.Vector3(Math.max(sz.x, m), Math.max(sz.y, m * 0.6), Math.max(sz.z, m))); }
  const arenaC = box.getCenter(new THREE.Vector3()), arenaR = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 6 * rMed);
  // Occluders: big, solid-looking things inside the arena (Squadron / Endless stars, asteroids). Not the room frame.
  // Scenery = persistent wireframe bodies; not effects (one-shot kill rings), not things carried by the player ship.
  const scenery = (b) => b.def.type === 'LineSegments' && !b.player && !(b.samples.length <= 2 && b.samples[0][0] > 0.5);
  const occ = bigs.concat(pulsers.filter((b) => b.rMin > rMed * 2)).filter((b) => scenery(b) && b.r0 < 1 && b.r < arenaR * 0.6 && b.r > rMed * 2);
  const clut = bigs.concat(pulsers.filter((b) => b.rMin > rMed * 1.5)).filter((b) => scenery(b) && b.r < arenaR * 0.95 && b.r > rMed * 1.5);
  if (/dbg=3/.test(location.search)) for (const c of objs.values()) if (c.small && c.samples.length) { let path = 0; for (let i = 1; i < c.samples.length; i++) { const a = c.samples[i - 1], b = c.samples[i]; path += Math.hypot(b[1] - a[1], b[2] - a[2], b[3] - a[3]); } log(`small ${c.id} ${c.def.type} ${c.def.name || ''} r0=${c.r0.toFixed(2)} s=${c.samples[0][8].toFixed(4)} n=${c.samples.length} path=${path.toFixed(3)} vis=${c.vis.length} col=${c.color.toString(16)} anc=${(c.def.anc || []).join('/')} ship=${ships.includes(c)}`); }
  if (/dbg/.test(location.search)) for (const o of new Set([...occ, ...clut])) log(`occ/clut ${o.id} ${o.def.type} r0=${o.r0.toFixed(2)} r=${o.r.toFixed(3)} rMin=${(o.rMin || 0).toFixed(3)} pulser=${pulsers.includes(o)} n=${o.samples.length} t0=${o.samples[0][0].toFixed(1)} vis=${o.vis.length} p=${o.samples[0].slice(1, 4).map((x) => x.toFixed(2))}`);
  if (/dbg=2/.test(location.search)) for (const d of defs) if (d.k === 'obj' && (!d.layer || d.layer === 'world')) { const r = geoRadius(d.geo); if (r > 0.1) log(`big ${d.id} ${d.type} ${d.name || ''} r0=${r.toFixed(2)} anc=${(d.anc || []).join('/')} inObjs=${objs.has(d.id)} clut=${clut.some((c) => c.id === d.id)}`); }
  const arenaBig = box.clone().expandByScalar(box.getSize(new THREE.Vector3()).length() * 0.06);

  // ---------------------------------------------------------------- track helpers
  function alive(s, t) {
    if (t < s.samples[0][0] - 0.05) return false;
    let on = true;
    for (const [tv, v] of s.vis) { if (tv > t) break; on = !!v; }
    return on;
  }
  const lastTime = (s) => s.samples[s.samples.length - 1][0];
  function pos(s, t, out = new THREE.Vector3()) {
    const S = s.samples;
    if (t <= S[0][0]) return out.set(S[0][1], S[0][2], S[0][3]);
    if (t >= S[S.length - 1][0]) { const z = S[S.length - 1]; return out.set(z[1], z[2], z[3]); }
    let lo = 0, hi = S.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m][0] <= t) lo = m; else hi = m; }
    const a = S[lo], b = S[hi], k = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
    return out.set(a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, a[3] + (b[3] - a[3]) * k);
  }
  const vel = (s, t) => pos(s, t + 0.15).sub(pos(s, t - 0.15)).divideScalar(0.3);
  function heading(s, t) { const v = vel(s, t); v.y = 0; if (v.lengthSq() < 1e-10) v.set(0, 0, 1); return v.normalize(); }
  const side = (h) => new THREE.Vector3(-h.z, 0, h.x);
  const aliveAt = (t) => ships.filter((s) => alive(s, t));
  const occAt = (t) => occ.filter((o) => alive(o, t));
  const player = ships.find((s) => s.player) || null;
  function nearestEnemy(s, t) {
    let best = null, bd = Infinity; const p = pos(s, t);
    for (const o of ships) { if (o === s || o.enemy === s.enemy || !alive(o, t)) continue; const d = pos(o, t).distanceTo(p); if (d < bd) { bd = d; best = o; } }
    return best;
  }
  function clusterCentre(s, t, R) {
    const p = pos(s, t), c = new THREE.Vector3(); let n = 0;
    for (const o of ships) { if (!alive(o, t)) continue; const q = pos(o, t); if (q.distanceTo(p) < R) { c.add(q); n++; } }
    return n ? c.divideScalar(n) : p;
  }

  // ---------------------------------------------------------------- kills (lookahead)
  const kills = [];
  for (const s of ships) for (const [t, v] of s.vis) {
    if (v !== 0) continue;
    const p = pos(s, t - 0.02);
    const boom = spawns.some((e) => e.t >= t - 0.1 && e.t <= t + 0.25 && e.p.distanceTo(p) < 8 * s.r);
    const back = s.vis.some(([tv, vv]) => vv === 1 && tv > t && tv < t + 0.5);
    if (boom && !back) kills.push({ t, s, p });
  }
  kills.sort((a, b) => a.t - b.t);
  const killList = kills.filter((k) => kills.filter((o) => Math.abs(o.t - k.t) < 0.05).length < 4);
  log(`director: ${ships.length} ships (r~${rMed.toFixed(4)}), ${occ.length} occluders, ${killList.length} kills, player=${player ? player.id : 'none'}, arena r=${arenaR.toFixed(2)}`);

  // ---------------------------------------------------------------- camera geometry
  function aimAngles(from, to) {
    const d = to.clone().sub(from);
    return [Math.atan2(-d.x, -d.z), Math.max(-MAX_PITCH, Math.min(MAX_PITCH, Math.atan2(d.y, Math.hypot(d.x, d.z))))];
  }
  const _e = new THREE.Euler(0, 0, 0, 'YXZ'), _qi = new THREE.Quaternion();
  // Where a point lands on screen (x, y in -1..1) for a camera at `cam` with yaw/pitch/fov; null if behind.
  function project(cam, yaw, pitch, fov, p) {
    _qi.setFromEuler(_e.set(pitch, yaw, 0, 'YXZ')).invert();
    const v = p.clone().sub(cam).applyQuaternion(_qi);
    if (v.z > -1e-6) return null;
    const ty = Math.tan(fov / 2 * DEG);
    return { x: v.x / (-v.z * ty * aspect), y: v.y / (-v.z * ty), d: -v.z };
  }
  function occluded(cam, p, t) {
    const seg = p.clone().sub(cam), L = seg.length(); seg.divideScalar(L || 1);
    for (const o of occAt(t)) {
      const c = pos(o, t), R = o.r * 0.85;
      if (c.distanceTo(cam) < o.r * 1.15) return true;                  // camera inside it
      const k = Math.max(0, Math.min(L, c.clone().sub(cam).dot(seg)));
      if (cam.clone().addScaledVector(seg, k).distanceTo(c) < R && k < L - R * 0.3) return true;
    }
    return false;
  }
  // Undamped camera for a shot at time t: { cam, look }.
  function target(shot, t) {
    const s = shot.subject, ts = s ? Math.min(t, lastTime(s)) : t, u = (t - shot.t0) / (shot.t1 - shot.t0);
    switch (shot.type) {
      case 'wide': case 'static': return { cam: shot.cam, look: shot.look };
      case 'flyby': return { cam: shot.cam, look: pos(s, ts) };
      case 'follow': {
        const h = heading(s, ts), P = pos(s, ts);
        return { cam: P.clone().addScaledVector(h, -shot.back * s.r).addScaledVector(side(h), shot.sideSign * shot.sideOff * s.r).add(new THREE.Vector3(0, shot.up * s.r, 0)), look: P.clone().addScaledVector(vel(s, ts), 0.3) };
      }
      case 'close': {
        const h = heading(s, ts), P = pos(s, ts);
        const yaw0 = Math.atan2(h.x, h.z) + shot.yaw + easeIO(u) * shot.drift;
        const dir = new THREE.Vector3(Math.sin(yaw0) * Math.cos(shot.el), Math.sin(shot.el), Math.cos(yaw0) * Math.cos(shot.el));
        return { cam: P.clone().addScaledVector(dir, shot.dist), look: P };
      }
      default: {   // orbit / push-in round the fight
        const C = shot.centre ? shot.centre(t) : clusterCentre(s, ts, 14 * s.r);
        const a = shot.az0 + shot.sweep * easeIO(u);
        const R = shot.push ? shot.R * (1.3 - 0.5 * easeIO(u)) : shot.R;
        return { cam: C.clone().add(new THREE.Vector3(Math.sin(a) * Math.cos(shot.el), Math.sin(shot.el), Math.cos(a) * Math.cos(shot.el)).multiplyScalar(R)), look: C };
      }
    }
  }
  // Score a shot: share of the shot the subject is well inside the frame and not hidden, the kill moment counted
  // three times; penalties for cameras inside obstacles or grazing other ships; bonus for a good size on screen.
  function score(shot) {
    const s = shot.subject;
    if (shot.type === 'wide') {
      // An establishing shot is judged on the whole group: how many of its ships are visible, minus clutter.
      const g = shot.group || [];
      if (!g.length) return 0.6;
      let vis = 0, n = 0, bad = 0;
      const [yaw, pitch] = aimAngles(shot.cam, shot.look), half = shot.fov / 2 * DEG;
      _qi.setFromEuler(_e.set(pitch, yaw, 0, 'YXZ'));
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(_qi);
      for (let k = 0; k <= 4; k++) {
        const t = shot.t0 + (shot.t1 - shot.t0) * k / 4;
        for (const o of g) {
          if (!alive(o, t)) continue;
          const p = pos(o, t), sp = project(shot.cam, yaw, pitch, shot.fov, p);
          n++;
          if (sp && Math.abs(sp.x) < 0.9 && Math.abs(sp.y) < 0.85 && !occluded(shot.cam, p, t)) vis++;
        }
        for (const o of clut) {
          if (!alive(o, t)) continue;
          const c = pos(o, t), d = c.distanceTo(shot.cam);
          if (d <= o.r) { bad += 1; continue; }
          const a = Math.asin(o.r / d);
          if (fwd.angleTo(c.clone().sub(shot.cam)) - a < half * 0.85 && a / half > 0.25) bad += (a / half - 0.25) * 2;
        }
      }
      return (n ? vis / n : 0.6) * 0.8 - bad * 0.1;
    }
    if (!s) return 0.6;
    let good = 0, tot = 0, size = 0, bad = 0;
    const tEnd = Math.min(shot.t1, lastTime(s) + 0.8);
    for (let k = 0; k <= 12; k++) {
      const t = shot.t0 + (tEnd - shot.t0) * k / 12;
      const w = shot.killT && Math.abs(t - shot.killT) < 0.35 ? 3 : 1;
      const { cam, look } = target(shot, t);
      const [yaw, pitch] = aimAngles(cam, look);
      const p = pos(s, Math.min(t, lastTime(s)));
      const sp = project(cam, yaw, pitch, shot.fov, p);
      tot += w;
      const inside = sp && Math.abs(sp.x) < 0.82 && Math.abs(sp.y) < 0.8;
      const buried = occAt(t).some((o) => pos(o, t).distanceTo(p) < o.r * 0.95);   // sitting inside a star
      if (inside && !buried && !occluded(cam, p, t)) { good += w; size += (2 * s.r / sp.d) / (2 * Math.tan(shot.fov / 2 * DEG)); }
      for (const o of ships) if (o !== s && alive(o, t) && pos(o, t).distanceTo(cam) < 1.3 * o.r) bad++;
      for (const o of occAt(t)) if (pos(o, t).distanceTo(cam) < o.r * 1.15) bad += 2;
      // Outside the battle room the frame's edges fill the foreground: only the wide shot may go there.
      if (shot.type !== 'wide' && !arenaBig.containsPoint(cam)) bad += 0.5;
      // A big wireframe hulk (star, asteroid, structure) parked in front of the lens swamps the frame.
      for (const o of clut) {
        if (!alive(o, t)) continue;
        const c = pos(o, t), d = c.distanceTo(cam);
        if (d <= o.r) continue;
        // Angular test: the sphere's disc (radius a) intrudes into the frustum if its centre is less than
        // (frame half-diagonal + a) off the view axis.
        _qi.setFromEuler(_e.set(pitch, yaw, 0, 'YXZ'));
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(_qi);
        const th = fwd.angleTo(c.clone().sub(cam)), a = Math.asin(Math.min(1, o.r / d));
        const half = shot.fov / 2 * DEG, diag = Math.atan(Math.tan(half) * Math.hypot(1, aspect));
        if (th - a > Math.min(diag, half * 0.85)) continue;
        const share = a / half;
        if (share > 0.45) bad += Math.min(1, (share - 0.45) * 2);
      }
    }
    const vis = good / tot, avgSize = good ? size / good : 0;
    const sizeScore = shot.type === 'wide' ? 0 : Math.min(1, avgSize / 0.2);
    // A subject that barely moves makes a dead shot.
    const speed = pos(s, shot.t0).distanceTo(pos(s, Math.min(shot.t1, lastTime(s)))) / Math.max(0.5, shot.t1 - shot.t0) / s.r;
    const motion = shot.kill || s.player ? 1 : Math.min(1, 0.4 + speed / 6);
    return vis * (0.75 + 0.25 * sizeScore) * motion - bad * 0.08;
  }

  // ---------------------------------------------------------------- shot proposals
  function propose(type, s, t0, t1, kill) {
    const L = t1 - t0, shot = { type, subject: s, t0, t1, kill: !!kill, killT: kill ? kill.t : null };
    const r = s ? s.r : rMed;
    if (type === 'wide' || !s) {
      shot.type = 'wide';
      // Establish the fight, not the room: the ships round the subject (or the densest group), core 75 %.
      let pts = [];
      for (let k = 0; k <= 6; k++) for (const o of aliveAt(t0 + L * k / 6)) pts.push(pos(o, t0 + L * k / 6));
      const anchor = s ? pos(s, Math.min(t0 + L / 2, lastTime(s))) : (pts.length ? pts.reduce((a, b) => a.clone().add(b), new THREE.Vector3()).divideScalar(pts.length) : arenaC.clone());
      const near = pts.filter((p) => p.distanceTo(anchor) < 30 * rMed);
      if (near.length >= 4) pts = near;
      shot.group = aliveAt(t0 + L / 2).filter((o) => near.length < 4 || pos(o, t0 + L / 2).distanceTo(anchor) < 30 * rMed);
      const c = pts.length ? pts.reduce((a, b) => a.add(b), new THREE.Vector3()).divideScalar(pts.length) : arenaC.clone();
      const ds = pts.map((p) => p.distanceTo(c)).sort((a, b) => a - b);
      const spread = ds.length ? ds[Math.floor(ds.length * 0.75)] : arenaR;
      const az = rng() * Math.PI * 2, el = rr(14, 28) * DEG;
      shot.fov = 50;
      const dist = Math.max(spread * 1.1, 9 * rMed) / Math.tan(shot.fov / 2 * DEG);
      shot.cam = c.clone().add(new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(dist));
      shot.look = c;
      return shot;
    }
    if (type === 'static' || type === 'flyby') {
      const tMid = Math.min(kill ? kill.t : t0 + L * rr(0.4, 0.6), lastTime(s));
      const P = pos(s, tMid), h = heading(s, tMid);
      const off = type === 'flyby' ? rr(2.5, 4) : rr(4.5, 7);
      shot.cam = P.clone().addScaledVector(side(h), sign() * off * r).addScaledVector(h, rr(0.5, 2.5) * r).add(new THREE.Vector3(0, rr(-0.8, 1.8) * r, 0));
      if (type === 'static') {
        // Locked off: aim where the subject is round the middle of the shot; the lens fits ~1.2 s of its path.
        const pts = []; for (let k = -3; k <= 3; k++) pts.push(pos(s, Math.min(Math.max(t0, tMid + k * 0.2), lastTime(s))));
        shot.look = pts.reduce((a, b) => a.add(b), new THREE.Vector3()).divideScalar(pts.length);
        const fwd = shot.look.clone().sub(shot.cam).normalize();
        let maxA = 0; for (const p of pts) maxA = Math.max(maxA, fwd.angleTo(p.clone().sub(shot.cam).normalize()));
        shot.fov = Math.min(62, Math.max(40, (maxA / DEG) * 2.3));
      } else shot.fov = rr(48, 58);
      return shot;
    }
    if (type === 'follow') {
      Object.assign(shot, { sideSign: sign(), back: rr(3.5, 5.5), sideOff: rr(0.8, 2.2), up: rr(0.6, 1.6), fov: rr(50, 58) });
      return shot;
    }
    if (type === 'close') {
      shot.fov = rr(30, 36);
      shot.dist = (3 * r) / Math.tan(shot.fov / 2 * DEG);     // ship (2r) ~ 1/3 of the frame height
      shot.yaw = sign() * rr(25, 70) * DEG; shot.el = rr(4, 18) * DEG; shot.drift = Math.sign(shot.yaw) * rr(8, 18) * DEG;
      return shot;
    }
    // orbit / push-in
    shot.type = 'orbit';
    shot.fov = 48;
    const C0 = clusterCentre(s, t0, 14 * r);
    shot.R = Math.max(7 * r, C0.distanceTo(pos(s, t0)) * 2 + 6 * r);
    shot.az0 = rng() * Math.PI * 2;
    shot.sweep = sign() * rr(20, 40) * DEG;
    shot.push = rng() < 0.4;
    shot.el = rr(10, 24) * DEG;
    // A smoothed centre, so the orbit pivot glides instead of jittering with the fight.
    const cs = []; for (let k = 0; k <= 20; k++) { const tt = t0 + (t1 - t0) * k / 20; cs.push([tt, clusterCentre(s, Math.min(tt, lastTime(s)), 14 * r)]); }
    for (let i = 1; i < cs.length; i++) cs[i][1] = cs[i - 1][1].clone().lerp(cs[i][1], 0.35);
    shot.centre = (t) => { const k = Math.max(0, Math.min(cs.length - 1, ((t - t0) / (t1 - t0)) * 20)); const i = Math.floor(k), f = k - i; return i + 1 < cs.length ? cs[i][1].clone().lerp(cs[i + 1][1], f) : cs[i][1].clone(); };
    return shot;
  }
  function best(type, s, t0, t1, kill, n = 10) {
    let top = null;
    for (let i = 0; i < n; i++) { const sh = propose(type, s, t0, t1, kill); sh.score = score(sh); if (!top || sh.score > top.score) top = sh; }
    return top;
  }

  // ---------------------------------------------------------------- the edit
  const TYPES = ['wide', 'static', 'follow', 'close', 'orbit', 'flyby'];
  const WEIGHT = { wide: 0.5, static: 1, follow: 1.1, close: 1.2, orbit: 1, flyby: 1 };
  const MIN_OK = { wide: 0.4, static: 0.6, follow: 0.7, close: 0.75, orbit: 0.65, flyby: 0.65 };
  const shots = [];
  let t = 0, prev = null, prevSubject = null, sinceWide = 0;
  const pick = (types) => { let tot = 0; for (const x of types) tot += WEIGHT[x]; let r = rng() * tot; for (const x of types) { r -= WEIGHT[x]; if (r <= 0) return x; } return types[types.length - 1]; };
  while (t < duration - 0.3) {
    let len = rr(2, 4);
    let subject = null, kill = null;
    const upcoming = killList.find((k) => k.t > t + 0.8 && k.t < t + 3.6 && alive(k.s, t + 0.05) && k.s !== prevSubject);
    if (upcoming && rng() < 0.85) { kill = upcoming; subject = kill.s; len = Math.min(4, Math.max(2, (kill.t - t) / rr(0.55, 0.7))); }
    else {
      const live = aliveAt(t + 0.05).filter((s) => lastTime(s) > t + 1.5);
      if (live.length) {
        const r = rng();
        if (player && alive(player, t + 0.05) && r < 0.4) subject = player;
        else if (player && alive(player, t + 0.05) && r < 0.7) subject = nearestEnemy(player, t) || player;
        else subject = live[Math.floor(rng() * live.length)];
        if (subject === prevSubject && live.length > 1) subject = live.filter((x) => x !== prevSubject)[Math.floor(rng() * (live.length - 1))];
      }
    }
    if (t + len > duration) len = duration - t;
    if (len < 1.2 && shots.length) { shots[shots.length - 1].t1 = duration; break; }
    // Try the preferred type, then the others; take the first that is good enough (or the best overall).
    let order;
    if (!subject) order = prev === 'wide' ? ['orbit'] : ['wide'];
    else {
      const first = sinceWide > 6 && prev !== 'wide' && !kill ? 'wide' : pick(TYPES.filter((x) => x !== prev && (kill ? x !== 'wide' : true)));
      order = [first, ...TYPES.filter((x) => x !== first && x !== prev && x !== 'wide').sort(() => rng() - 0.5), ...(prev !== 'wide' && first !== 'wide' && !kill ? ['wide'] : [])];
    }
    // An establishing shot only needs a beat; a long wide of distant specks kills the pace.
    if (order[0] === 'wide' && !kill) len = Math.min(len, rr(2, 2.6));
    const choose = (subject, kill, order) => {
      let chosen = null, top = null;
      const subjects = [subject];
      if (!kill && subject) { const live = aliveAt(t + 0.05).filter((s) => s !== subject && lastTime(s) > t + 1.5); for (let i = 0; i < 3 && live.length; i++) subjects.push(live.splice(Math.floor(rng() * live.length), 1)[0]); }
      for (const sub of subjects) {
        for (const ty of order) {
          const sh = best(ty, sub, t, t + len, kill);
          if (!top || sh.score > top.score) top = sh;
          if (sh.score >= MIN_OK[sh.type]) { chosen = sh; break; }
        }
        if (chosen) break;
      }
      return chosen || top;
    };
    let chosen = choose(subject, kill, order);
    if (kill && chosen.score < 0.3) {
      // No camera sees this kill (it happens inside a star etc.): cover the fight instead.
      kill = null; len = Math.min(rr(2, 3.5), duration - t);
      const live = aliveAt(t + 0.05).filter((s) => s !== prevSubject && lastTime(s) > t + 1.5);
      const sub = player && alive(player, t + 0.05) && player !== prevSubject ? player : live[Math.floor(rng() * live.length)] || subject;
      const alt = choose(sub, null, order.concat(prev !== 'wide' && !order.includes('wide') ? ['wide'] : []));
      if (alt.score > chosen.score) chosen = alt;
    }
    len = chosen.t1 - chosen.t0;
    if (chosen.type === 'wide' && !chosen.kill && len > 2.6) { len = rr(2, 2.6); chosen.t1 = t + len; }
    subject = chosen.subject;
    shots.push(chosen);
    sinceWide = chosen.type === 'wide' ? 0 : sinceWide + 1;
    prev = chosen.type; prevSubject = subject;
    t += len;
  }
  log('director shots: ' + shots.map((s) => `${s.t0.toFixed(1)} ${s.type}${s.kill ? '*' : ''}${s.subject ? '#' + s.subject.id : ''} ${s.score.toFixed(2)}`).join(' | '));

  // ---------------------------------------------------------------- per-frame camera (damped inside a shot, hard cuts)
  const st = { shot: null, p: new THREE.Vector3(), look: new THREE.Vector3(), yaw: 0, pitch: 0 };
  const wrap = (a) => a - Math.round(a / (2 * Math.PI)) * 2 * Math.PI;
  const DAMP = { wide: [0, 0], static: [0, 0], flyby: [0, 0.12], follow: [0.3, 0.12], close: [0.25, 0.05], orbit: [0, 0] };
  function shotAt(t) { let s = shots[0]; for (const x of shots) { if (x.t0 <= t + 1e-6) s = x; else break; } return s; }
  function update(camera, t, dt) {
    const shot = shotAt(t);
    if (!shot) return;
    const cut = shot !== st.shot;
    st.shot = shot;
    const { cam, look } = target(shot, t);
    const [dp, dl] = DAMP[shot.type];
    if (cut) { st.p.copy(cam); st.look.copy(look); }
    else {
      st.p.lerp(cam, dp ? 1 - Math.exp(-dt / dp) : 1);
      st.look.lerp(look, dl ? 1 - Math.exp(-dt / dl) : 1);
    }
    const [yaw, pitch] = aimAngles(st.p, st.look);
    if (cut || !dl) { st.yaw = yaw; st.pitch = pitch; }
    else { const k = 1 - Math.exp(-dt / 0.06); st.yaw += wrap(yaw - st.yaw) * k; st.pitch += (pitch - st.pitch) * k; }
    camera.position.copy(st.p);
    camera.up.set(0, 1, 0);
    camera.quaternion.setFromEuler(_e.set(st.pitch, st.yaw, 0, 'YXZ'));
    camera.fov = shot.fov || 50;
    camera.near = Math.max(0.0005, rMed * 0.05); camera.far = 2000;
  }
  return { update, shots };
}
