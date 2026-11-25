#!/usr/bin/env node
// Builds the 5 recording snapshots + the root index from versions.json.
//   node tools/build.mjs <path-to-vr-battle-room-git-repo>
// Each snapshot = `git archive <commit> index.html js vendor`, plus rec/recorder.js and three tiny hooks:
//   index.html: window.__CRREC config + <script type="module" src="rec/recorder.js"> before main.js
//   js/main.js: player.obj.name = 'player-ship'   (a name only, so the renderer can find the ship for chase cam)
// Gameplay code is otherwise untouched.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2];
if (!SRC) { console.error('usage: build.mjs <vr-battle-room repo>'); process.exit(1); }
const git = (...a) => execFileSync('git', ['-c', 'safe.directory=*', '-c', 'core.autocrlf=false', '-C', SRC, ...a], { maxBuffer: 1 << 28 });
const versions = JSON.parse(fs.readFileSync(path.join(ROOT, 'versions.json'), 'utf8'));
const head = git('rev-parse', '--short', 'main').toString().trim();
const headSubj = git('log', '-1', '--format=%s', head).toString().trim();
const headV = (headSubj.match(/^v\d+/) || ['HEAD'])[0];
const headDate = git('log', '-1', '--format=%ad', '--date=short', head).toString().trim();
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

for (const v of versions) {
  if (v.commit === '__HEAD__') { v.commit = head; v.gameVersion = headV; v.date = headDate; }
  const out = path.join(ROOT, v.slug);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const tar = git('archive', '--format=tar', v.commit, 'index.html', 'js', 'vendor');
  execFileSync('tar', ['-x', '-C', out], { input: tar });
  fs.writeFileSync(path.join(out, '.nojekyll'), '');
  // recorder
  fs.mkdirSync(path.join(out, 'rec'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'shared', 'recorder.js'), path.join(out, 'rec', 'recorder.js'));
  // index.html hook
  const cfg = { version: v.version, slug: v.slug, title: v.title, date: v.date, commit: `${v.commit} (${v.gameVersion})`, shots: v.shots, index: '../' };
  let html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  const re = /<script type="module" src="js\/main\.js[^"]*"><\/script>/;
  if (!re.test(html)) throw new Error(v.slug + ': main.js script tag not found');
  html = html.replace(re, (m) => `<!-- recording build hooks -->\n<script>window.__CRREC = ${JSON.stringify(cfg)};</script>\n<script type="module" src="rec/recorder.js?b=${Date.now().toString(36)}"></script>\n${m}`);
  html = html.replace(/<title>[^<]*<\/title>/, `<title>COMMAND ROOM ${v.version} (rec) - ${esc(v.title)}</title>`);
  fs.writeFileSync(path.join(out, 'index.html'), html);
  // main.js hook: name the player's ship
  const mp = path.join(out, 'js', 'main.js');
  let js = fs.readFileSync(mp, 'utf8');
  const re2 = /^((?:scene|world|board)\.add\(player\.obj\);)/m;
  if (!re2.test(js)) throw new Error(v.slug + ': player add not found');
  js = js.replace(re2, `$1\nplayer.obj.name = 'player-ship'; // recording build: lets the offline renderer find the ship`);
  fs.writeFileSync(mp, js);
  console.log(`${v.slug}: ${v.commit} ${v.gameVersion}`);
}
fs.writeFileSync(path.join(ROOT, 'versions.built.json'), JSON.stringify(versions, null, 2));

// ---------------------------------------------------------------- root index
const cards = versions.map((v, i) => `
<section class="v">
  <a class="go" href="${v.slug}/"><span class="n">${i + 1}</span><span class="t">${esc(v.title)}</span><span class="d">${v.date} &middot; ${esc(v.gameVersion)} &middot; ${v.commit}</span></a>
  <p class="new">${esc(v.new)}</p>
  <details><summary>What to record (5-10 min)</summary><ol>${v.shots.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></details>
</section>`).join('');
const index = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>COMMAND ROOM - recording builds</title>
<style>
body{margin:0;background:#02050c;color:#dfefff;font:17px/1.45 system-ui,Segoe UI,Arial,sans-serif}
main{max-width:980px;margin:0 auto;padding:22px 18px 60px}
h1{letter-spacing:8px;color:#9ff;margin:6px 0 2px;font-size:34px}
.lead{color:#9ab;margin:0 0 18px}
.how{border:1px solid #ff4455;border-radius:10px;padding:10px 16px;background:#14060a;margin-bottom:20px}
.how b{color:#ff8899}
.v{border:1px solid #1d4a5e;border-radius:12px;padding:12px;margin:14px 0;background:#051522}
.go{display:flex;flex-wrap:wrap;align-items:center;gap:6px 16px;text-decoration:none;color:#fff;background:#063247;border:2px solid #3cf;border-radius:10px;padding:22px 20px;min-height:64px}
.go:hover,.go:focus{background:#0a4a66}
.n{font:bold 40px monospace;color:#7fe9ff;width:44px}
.t{font-weight:bold;font-size:26px;flex:1;min-width:240px}
.d{color:#9cc;font-size:15px;width:100%;padding-left:60px}
.new{margin:10px 6px}
details{margin:0 6px}
summary{cursor:pointer;color:#ffcc66;font-weight:bold;padding:8px 0;font-size:18px}
li{margin:4px 0}
</style></head><body><main>
<h1>COMMAND ROOM</h1>
<p class="lead">Recording builds for the devlog: 5 snapshots from the first prototype to today (formerly VR Battle Room). Each one is the game exactly as it was, plus a recorder.</p>
<div class="how"><b>How to record:</b> open a version, press ENTER VR. Recording starts automatically (untick it on the card to start by hand).
In VR, click <b>both thumbsticks in and hold 1 second</b> to start / stop - a red REC badge shows lower left and the controllers buzz.
Leaving VR stops and saves. Back on the page, press <b>DOWNLOAD RECORDING</b>: you get <code>commandroom-vN-date-time.zip</code> (scene log + game audio; never the mic).
Recordings stay on the headset until you delete them. The video is re-rendered later from the log, at any resolution and from any camera.</div>
${cards}
</main></body></html>
`;
fs.writeFileSync(path.join(ROOT, 'index.html'), index);
fs.writeFileSync(path.join(ROOT, '.nojekyll'), '');
console.log('index.html written; HEAD =', head, headV);
