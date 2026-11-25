// IWER test driver for the recording builds (injected before the game by test/server.mjs).
// URL params: start=gesture|auto  play=fighter|squadron|endless|v1  secs=20  busy=1 (fight with the autopilot-ish input)
import { XRDevice, metaQuest3 } from './__iwer.js';

const P = new URLSearchParams(location.search);
const START = P.get('start') || 'gesture', PLAY = P.get('play') || 'fighter', SECS = +(P.get('secs') || 20), TAG = P.get('tag') || 'run';
localStorage.setItem('battleRoomTutorialDone', '1');
localStorage.setItem('crrecAutoRecord', START === 'auto' ? '1' : '0');
const device = new XRDevice(metaQuest3);
device.installRuntime();
device.position.set(0, 1.2, 0);
const R = device.controllers.right, L = device.controllers.left;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => navigator.sendBeacon('log', 'XRTEST ' + m);
let fails = 0;
const check = (ok, what) => { if (!ok) fails++; log((ok ? 'PASS ' : 'FAIL ') + what); };
async function waitFor(fn, ms = 15000) { const t0 = performance.now(); while (performance.now() - t0 < ms) { try { if (fn()) return true; } catch (e) { /* */ } await sleep(50); } return false; }
function quatYX(yaw, pitch) { // q = qy * qx
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cx = Math.cos(pitch / 2), sx = Math.sin(pitch / 2);
  return [cy * sx, sy * cx, -sy * sx, cy * cx];
}
function aim(c, p, yaw, pitch) { c.position.set(p[0], p[1], p[2]); const q = quatYX(yaw, pitch); c.quaternion.set(q[0], q[1], q[2], q[3]); }
async function bothSticks(ms = 1300) {
  R.updateButtonValue('thumbstick', 1); L.updateButtonValue('thumbstick', 1);
  await sleep(ms);
  R.updateButtonValue('thumbstick', 0); L.updateButtonValue('thumbstick', 0);
  await sleep(300);
}
async function press(c, btn = 'trigger', ms = 150) { c.updateButtonValue(btn, 1); await sleep(ms); c.updateButtonValue(btn, 0); await sleep(120); }
async function upload(blob, name) { const r = await fetch('/upload?name=' + encodeURIComponent(name), { method: 'POST', body: blob }); return r.ok; }

(async () => {
  try {
    log(`start ${location.pathname} start=${START} play=${PLAY} secs=${SECS}`);
    check(await waitFor(() => window.__game && window.__crrec && document.getElementById('vrbutton') && !document.getElementById('vrbutton').disabled, 20000), 'game + recorder loaded, ENTER VR enabled');
    check(!!document.getElementById('crrec') && document.querySelectorAll('#crrec li').length >= 5, 'shot-list card on the page');
    aim(R, [0.2, 1.0, -0.3], 0, 0); aim(L, [-0.2, 1.0, -0.3], 0, 0);
    document.getElementById('vrbutton').click();
    check(await waitFor(() => window.__crrec.inXR, 15000), 'entered VR (IWER)');
    await sleep(800);
    if (START === 'auto') check(await waitFor(() => window.__crrec.state && window.__crrec.state.active, 5000), 'auto-record started on ENTER VR');
    else {
      check(!window.__crrec.state, 'not recording before the gesture');
      await bothSticks(1300);
      check(!!(window.__crrec.state && window.__crrec.state.active), 'both thumbsticks held 1 s -> recording');
    }
    const G = window.__game;
    // Start playing.
    if (PLAY === 'idle') { /* stay on the title / lobby */ }
    else if (PLAY === 'v1' || PLAY === 'v9') { await press(R); }
    else if (PLAY === 'endless') G.startGameAt('endless');
    else if (PLAY === 'squadron') G.startGameAt ? G.startGameAt('squadron') : G.startGame();
    else if (G.startGameAt) G.startGameAt('fighter'); else G.startGame();
    await sleep(500);
    for (const c of window.__crrec._ctxs()) { if (c.state !== 'running') { try { await Promise.race([c.resume(), sleep(2000)]); } catch (e) { log('resume failed ' + e); } } }
    log('state after start: ' + G.state + ' audio=' + JSON.stringify(window.__crrec.audioContexts));
    // ~SECS seconds of play: sweep the right controller round (steering), shoot in bursts, boost now and then,
    // move the head a little.
    const t0 = performance.now();
    let k = 0;
    while (performance.now() - t0 < SECS * 1000) {
      const t = (performance.now() - t0) / 1000;
      aim(R, [0.2, 1.0, -0.3], Math.sin(t * 0.7) * 1.2, Math.sin(t * 1.1) * 0.5);
      aim(L, [-0.2, 0.95 + 0.05 * Math.sin(t), -0.3], -0.3, -0.2);
      device.quaternion.set(...quatYX(Math.sin(t * 0.4) * 0.5, Math.sin(t * 0.3) * 0.15));
      if (PLAY !== 'idle') {
        R.updateButtonValue('trigger', PLAY === 'squadron' ? 1 : (k % 10) < 6 ? 1 : 0);
        R.updateButtonValue('squeeze', (k % 40) > 32 ? 1 : 0);
      }
      if (G.state === 'gameover' && (k % 30) === 0) { if (G.startGameAt) G.startGameAt(PLAY === 'endless' ? 'endless' : PLAY === 'squadron' ? 'squadron' : 'fighter'); else await press(R); }
      k++;
      await sleep(100);
    }
    R.updateButtonValue('trigger', 0); R.updateButtonValue('squeeze', 0);
    const st = window.__crrec.state;
    log(`recording: ${JSON.stringify(st)} state=${G.state} score=${G.score} audio=${JSON.stringify(window.__crrec.audioContexts)}`);
    check(st && st.frames > SECS * 10, `logged ${st && st.frames} frames in ~${SECS}s`);
    // Stop with the gesture, in VR.
    await bothSticks(1300);
    check(!window.__crrec.state, 'gesture again -> stopped');
    check(await waitFor(() => window.__crrec.last, 10000), 'recording saved');
    const id = window.__crrec.last;
    let z = null;
    for (let i = 0; i < 100 && !z; i++) { try { z = await window.__crrec.buildZip(id); } catch (e) { await sleep(200); } }
    check(!!z && z.blob.size > 1000, `zip built in the browser: ${z && z.name} ${z && z.blob.size} bytes`);
    log('manifest ' + JSON.stringify(z && z.manifest));
    // Leave VR, then use the page's DOWNLOAD button (real browser download) and also upload the zip for the test.
    const s = window.__game.renderer.xr.getSession();
    if (s) await s.end();
    check(await waitFor(() => !window.__crrec.inXR, 5000), 'left VR');
    await sleep(500);
    const dl = document.querySelector('#crrec .dl');
    check(dl && dl.style.display !== 'none', 'DOWNLOAD RECORDING button shown after exit');
    const unsaved = document.querySelectorAll('#crrec .item').length;
    check(unsaved >= 1, `recording listed on the page (${unsaved})`);
    if (dl) dl.click();
    await sleep(1500);
    check(await upload(z.blob, `${TAG}-${z.name}`), 'zip uploaded to the test server');
    log(`SUMMARY fails=${fails}`);
  } catch (e) { log('FAIL exception ' + (e && e.stack || e)); }
  log('DONE');
})();
