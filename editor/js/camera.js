// Per-clip cameras.
//   auto    the wide-director (medium framing by default), the look of the highlight clips
//   free    a camera you place with orbit / pan / zoom in the viewport
//   follow  attached to an object (player ship, any ship, the head, the room centre) at an offset you drag
//   lookat  stays where you put it and turns to keep an object in frame
//   pov     the player's own view from the head pose
// Movement: static (one key) or start -> end keys eased over the clip. Follow / look-at track their target with
// damping. The horizon is level unless you turn that off (then a roll angle applies, and pov / follow can bank).
import * as THREE from 'three';
import { buildWideDirector } from '../../render/page/widedirector.js';

const DEG = Math.PI / 180;
export const CAM_MODES = [
  { id: 'auto', label: 'Auto', tip: 'Auto-director: wide statics, slow orbits and drifts, wide follow and the head view, cut every 2-4 s (medium framing)' },
  { id: 'free', label: 'Free', tip: 'Place the camera yourself: drag to orbit, right-drag (or Shift+drag) to pan, wheel to zoom' },
  { id: 'follow', label: 'Follow', tip: 'Attach the camera to an object; drag to set the offset, wheel for distance' },
  { id: 'lookat', label: 'Look at', tip: 'The camera stays put and turns to keep the target in frame; drag to move it round the target' },
  { id: 'pov', label: 'Player view', tip: "The player's own view from the headset (smoothed)" },
];

export function defaultCam() {
  return { mode: 'auto', seed: 7, framing: 0.5, target: 'player-ship', damping: 0.35, rotate: false, level: true, move: 'static', ease: 'smooth', edit: 'a',
    a: { pos: [0, 1.6, 1.2], look: [0, 1.2, -0.5], dist: 1.2, az: 0, el: 0.35, fov: 40, roll: 0 }, b: null };
}

const easeIO = (x) => { x = Math.min(1, Math.max(0, x)); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
const lerp = (a, b, k) => a + (b - a) * k;
const lerpA = (a, b, k) => { let d = b - a; d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI; return a + d * k; };
const dirFrom = (az, el, out = new THREE.Vector3()) => out.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));

export function keyAt(cam, u) {
  const a = cam.a;
  if (cam.move !== 'keys' || !cam.b) return a;
  const b = cam.b, k = cam.ease === 'linear' ? Math.min(1, Math.max(0, u)) : easeIO(u);
  return {
    pos: a.pos.map((x, i) => lerp(x, b.pos[i], k)), look: a.look.map((x, i) => lerp(x, b.look[i], k)),
    dist: lerp(a.dist, b.dist, k), az: lerpA(a.az, b.az, k), el: lerp(a.el, b.el, k), fov: lerp(a.fov, b.fov, k), roll: lerp(a.roll || 0, b.roll || 0, k),
  };
}

// target position smoothed with a trailing exponential window (deterministic, so seeking gives the same frame)
const _s = new THREE.Vector3();
export function targetAt(rec, target, t, tau, out = new THREE.Vector3()) {
  if (!(tau > 0.01)) { if (!rec.sampleTrack(target, t, out)) return null; return out; }
  const dt = 1 / 30, N = Math.ceil(4 * tau / dt);
  out.set(0, 0, 0); let w = 0;
  for (let i = 0; i <= N; i++) {
    if (!rec.sampleTrack(target, Math.max(0, t - i * dt), _s)) return null;
    const k = Math.exp(-i * dt / tau); out.addScaledVector(_s, k); w += k;
  }
  return out.divideScalar(w);
}
function targetYaw(rec, target, t, tau) {
  // heading of the target from its rotation (ships: model forward axis), smoothed by sampling the motion
  const q = new THREE.Quaternion(), p = new THREE.Vector3(), f = new THREE.Vector3();
  let x = 0, z = 0;
  const N = tau > 0.01 ? Math.ceil(3 * tau * 30) : 0;
  for (let i = 0; i <= N; i++) {
    if (!rec.sampleTrack(target, Math.max(0, t - i / 30), p, q)) return null;
    (target === 'head' ? f.set(0, 0, -1) : f.copy(rec.shipAxis)).applyQuaternion(q);
    const k = tau > 0.01 ? Math.exp(-i / 30 / tau) : 1; x += f.x * k; z += f.z * k;
  }
  return Math.atan2(x, z);
}

// ---------------------------------------------------------------- directors (one per clip, cached)
const directors = new Map();
export function directorFor(rec, cam, tIn, tOut) {
  const key = `${rec.key}|${cam.seed}|${cam.framing}|${tIn.toFixed(3)}|${tOut.toFixed(3)}`;
  let d = directors.get(key);
  if (!d) {
    const hp = new THREE.Vector3(), hq = new THREE.Quaternion();
    d = buildWideDirector({ frames: rec.frames, readFrame: (o, f) => rec.readFrame(o, f), defs: rec.defs, T0: 0, duration: Math.max(tOut, tIn + 0.5), log: () => {},
      seed: cam.seed, aspect: 16 / 9, shipIds: rec.SHIPS.shipIds, roomIds: rec.SHIPS.roomIds, tight: cam.framing, start: tIn, scan: rec.scan,
      headAt: (t) => { rec.sampleTrack('head', t, hp, hq); return { p: hp.clone(), q: hq.clone() }; } });
    directors.set(key, d);
    if (directors.size > 64) directors.delete(directors.keys().next().value);
  }
  return d;
}

// ---------------------------------------------------------------- evaluate a clip camera at local time t
const _p = new THREE.Vector3(), _l = new THREE.Vector3(), _q = new THREE.Quaternion(), _f = new THREE.Vector3(), _u = new THREE.Vector3(), _e = new THREE.Euler();
export function applyCamera(camera, cam, rec, t, u, info = {}) {
  const dt = info.dt || 1 / 60;
  camera.up.set(0, 1, 0);
  let roll = 0, near = 0.01;
  if (cam.mode === 'auto') {
    const d = directorFor(rec, cam, info.tIn ?? 0, info.tOut ?? rec.duration);
    if (d.shots.length) d.update(camera, t, dt);
    else { rec.sampleTrack('head', t, camera.position, camera.quaternion); camera.fov = 80; }
    camera.aspect = info.aspect || 16 / 9; camera.far = 1000;
    camera.updateProjectionMatrix();
    return;
  }
  const K = keyAt(cam, u);
  camera.fov = K.fov || 40;
  if (cam.mode === 'pov') {
    rec.sampleTrack('head', t, _p, _q);
    camera.position.copy(_p);
    if (cam.level) { _f.set(0, 0, -1).applyQuaternion(_q); camera.lookAt(_l.copy(_p).add(_f)); }
    else camera.quaternion.copy(_q);
    camera.fov = K.fov || 80; near = 0.02;
  } else if (cam.mode === 'free') {
    camera.position.fromArray(K.pos); camera.lookAt(_l.fromArray(K.look));
    roll = cam.level ? 0 : K.roll;
  } else {
    const P = targetAt(rec, cam.target, t, cam.damping, _l) || rec.actionCentre(t) || _l.set(0, 1.2, -0.5);
    if (cam.mode === 'follow') {
      let az = K.az;
      if (cam.rotate) { const y = targetYaw(rec, cam.target, t, cam.damping); if (y !== null) az += y; }
      camera.position.copy(P).addScaledVector(dirFrom(az, K.el, _f), K.dist);
      if (cam.rotate && !cam.level && cam.target !== 'room') {
        // bank with the target
        rec.sampleTrack(cam.target, t, _u, _q); _u.set(0, 1, 0).applyQuaternion(_q); camera.up.copy(_u.lerp(new THREE.Vector3(0, 1, 0), 0.4).normalize());
      }
      camera.lookAt(P);
      near = Math.max(0.002, K.dist * 0.02);
    } else {
      camera.position.fromArray(K.pos); camera.lookAt(P);
    }
    roll = cam.level ? 0 : K.roll;
  }
  if (roll) camera.rotateZ(roll * DEG);
  camera.near = near; camera.far = 1000; camera.aspect = info.aspect || 16 / 9;
  camera.updateProjectionMatrix();
}

// ---------------------------------------------------------------- editing from the viewport
// A key that reproduces the given camera view in `mode` (used when switching modes or "use this view").
export function keyFromView(mode, camera, rec, cam, t) {
  const pos = camera.position.toArray(), fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const P = (mode === 'follow' || mode === 'lookat') ? targetAt(rec, cam.target, t, cam.damping) : null;
  let dist = 1, az = 0, el = 0.3, look;
  if (P) {
    const off = camera.position.clone().sub(P); dist = Math.max(0.05, off.length());
    az = Math.atan2(off.x, off.z); el = Math.asin(Math.max(-1, Math.min(1, off.y / dist)));
    if (cam.rotate && mode === 'follow') { const y = targetYaw(rec, cam.target, t, cam.damping); if (y !== null) az -= y; }
    look = P.toArray();
  } else {
    // look point: about a metre ahead, or the action centre if it is in front of us
    const c = rec.actionCentre(t);
    const d = c ? Math.max(0.3, c.clone().sub(camera.position).dot(fwd)) : 1;
    look = camera.position.clone().addScaledVector(fwd, d).toArray();
    dist = d;
  }
  return { pos, look, dist, az, el, fov: Math.round(camera.fov), roll: 0 };
}

export function orbitKey(mode, key, dx, dy, pivot) {
  const k = 0.006;
  if (mode === 'follow') { key.az -= dx * k; key.el = Math.max(-1.45, Math.min(1.45, key.el + dy * k)); return; }
  const c = mode === 'lookat' && pivot ? pivot : new THREE.Vector3().fromArray(key.look);
  const off = new THREE.Vector3().fromArray(key.pos).sub(c);
  const r = off.length() || 1;
  let az = Math.atan2(off.x, off.z), el = Math.asin(Math.max(-1, Math.min(1, off.y / r)));
  az -= dx * k; el = Math.max(-1.45, Math.min(1.45, el + dy * k));
  key.pos = c.clone().addScaledVector(dirFrom(az, el), r).toArray();
}
export function panKey(mode, key, dx, dy, camera) {
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion), up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  const d = mode === 'follow' ? key.dist : new THREE.Vector3().fromArray(key.pos).distanceTo(new THREE.Vector3().fromArray(key.look));
  const s = d * Math.tan((key.fov || 40) * DEG / 2) * 2 / 600;
  const mv = right.multiplyScalar(-dx * s).addScaledVector(up, dy * s);
  if (mode === 'follow') return;   // follow keeps the target centred
  key.pos = new THREE.Vector3().fromArray(key.pos).add(mv).toArray();
  if (mode === 'free') key.look = new THREE.Vector3().fromArray(key.look).add(mv).toArray();
}
export function dollyKey(mode, key, amount, pivot) {
  const f = Math.exp(amount * 0.0015);
  if (mode === 'follow') { key.dist = Math.max(0.03, Math.min(50, key.dist * f)); return; }
  const c = mode === 'lookat' && pivot ? pivot : new THREE.Vector3().fromArray(key.look);
  const off = new THREE.Vector3().fromArray(key.pos).sub(c);
  const r = Math.max(0.03, Math.min(50, off.length() * f));
  key.pos = c.clone().addScaledVector(off.normalize(), r).toArray();
  if (mode === 'free') key.dist = r;
}
