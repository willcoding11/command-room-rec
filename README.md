# COMMAND ROOM - recording builds

Five snapshots of COMMAND ROOM (formerly VR Battle Room, `willcoding11/vr-battle-room`) from the first
prototype to today, each with a built-in recorder, for devlog footage on a Meta Quest 3S.

**Index:** https://willcoding11.github.io/command-room-rec/

| # | URL | Commit | Game version | Date | What is new |
|---|-----|--------|--------------|------|-------------|
| 1 | [/1-first/](https://willcoding11.github.io/command-room-rec/1-first/) | ff79fa7 | first prototype | 2026-11-21 | 360-degree wireframe battle round your head, point-to-fly, waves, wrist HUD |
| 2 | [/2-squadron/](https://willcoding11.github.io/command-room-rec/2-squadron/) | 954063d | v9 | 2026-11-22 | tabletop battle box, Mirror steering, Squadron mode, smarter enemies |
| 3 | [/3-lobby-music/](https://willcoding11.github.io/command-room-rec/3-lobby-music/) | 998082f | v18 | 2026-11-23 | lobby, tutorial, procedural music, juice (sparks, hit stop), split + formations, aces, barrel roll |
| 4 | [/4-holo-ring/](https://willcoding11.github.io/command-room-rec/4-holo-ring/) | 4527bc5 | v27 | 2026-11-24 | holo ring command deck, laser-pointer UI, Settings / STATS panels |
| 5 | [/5-endless/](https://willcoding11.github.io/command-room-rec/5-endless/) | d104307 | v32 (main HEAD when built) | 2026-11-24 | Endless mode: star outposts, landing, upgrades, asteroid fields |

Each build is `git archive <commit>` of the game, unchanged except for three hooks (see `tools/build.mjs`):
`index.html` gets the shot-list card config and `<script type="module" src="rec/recorder.js">` before `main.js`;
`main.js` gets one line naming the player's ship (`player.obj.name = 'player-ship'`) so the renderer can find it.

## Recording (on the Quest)

1. Open the index, tap a version, press ENTER VR. Recording starts automatically (untick
   "Start recording when I enter VR" on the card to start by hand).
2. In VR: **click both thumbsticks in and hold for 1 second** to start or stop. A small red REC badge with a timer
   shows lower left; the controllers buzz once on start, twice on stop. (The recorder does not change gameplay;
   in v1-v3 the same click also does that version's own stick-click action, e.g. re-centre / box reset / split, once.)
3. Leaving VR always stops and saves. Back on the page press **DOWNLOAD RECORDING**:
   `commandroom-v1-2026-11-24-1532.zip`.
4. Every recording is also kept in the browser's IndexedDB (flushed every 2 s) until you delete it, so a crash or a
   closed session loses at most the last 2 s; the card lists them (UNSAVED / downloaded) with Download / Delete.

### What is recorded (`crrec-1` zip)

- `frames.bin` - every logged frame (~36 Hz on a 72 Hz Quest): head pose, both controller poses + buttons/axes,
  visibility changes, world transforms of everything that moved (float32 position, int16 quaternion, float32
  scale), material colour/opacity changes, dynamic geometry (bullets, trails, debris, spark particles - only the lit
  points), draw ranges.
- `defs.jsonl` - each object, geometry (raw vertex data, deduplicated), material (three.js JSON) once, plus later
  changes; each object is tagged `layer` = `world`, `ui` (panels, holo ring, tutorial card, wrist HUD, popups,
  message panel, laser beam + cursor, off-screen arrow) or `hands` (controller models); game messages and rec / XR events.
- `tex/*.webp` - snapshots of every canvas texture (UI panels, HUD, ring...) whenever it is redrawn, at most 2 per
  second per texture, deduplicated by content, each keyed to its frame.
- `audio.webm` - the game's own WebAudio output (master node -> MediaStreamAudioDestinationNode -> MediaRecorder,
  Opus 128 kbps). The microphone is never used (no getUserMedia).
- `manifest.json` - version, commit, date, duration, frame count, audio offset.

**No screen video is recorded.** On Quest the frames go to the XR compositor layer, so a canvas capture shows
nothing useful and would cost frame rate. The video is re-rendered from the log instead (below), at any resolution
and from any camera. The Quest's own recorder is the backup for a straight "what I saw" capture.

Measured zip size (Firefox + IWER emulator in ForemanBox, ~31 Hz log): about **2.4-2.5 MB per minute**
(quiet title screen 2.4 MB/min - mostly HUD snapshots; lobby with backdrop battle 2.4 MB/min; Squadron fight
2.4 MB/min, of which ~1.0 MB/min is audio). Expect ~3 MB/min on a Quest (log runs at ~36 Hz), ~30 MB for 10 minutes.

## Rendering a recording

Runs in ForemanBox (Linux: node, Firefox, ffmpeg). Copy the zip into `C:\Users\willi\ForemanBox-Share\` and run
from PowerShell:

```
wsl -d ForemanBox -- bash /home/agent/share/crrec/repo/render/render.sh /home/agent/share/commandroom-v1-2026-11-24-1532.zip
```

That writes `...-head.mp4` (player's view, smoothed) and `...-chase.mp4` (behind the player's ship) next to the zip,
1920x1080 60 fps H.264 with the game audio. Options (`node render/render.mjs --help`):

```
--mode head|wide|chase   --res 1080|1440|4k|WxH   --fps 60   --from S --to S
--ui on|off  --hands on|off      (defaults: on for head/wide, off for chase)
--linewidth PX (1.6 at 1080p, scales with resolution; 0 = thin native lines)
--fov DEG  --smooth SEC  --target NAME|ID  --dist N --height N  --cam x,y,z --look x,y,z
--still SEC --out shot.png  (one frame)  --crf 16  --no-audio
```

Speed in the box (software GL): ~8 output frames/s at 1080p, so a 10-minute take at 60 fps is about 75 minutes.

## Known limits

- Video is reconstructed, not captured: what you get is the 3D scene re-rendered (wireframes are drawn as clean
  fat lines; you can keep native 1 px lines with `--linewidth 0`).
- Log rate ~36 Hz; motion between samples is interpolated (positions lerp, rotations slerp). Very fast flashes
  shorter than one log step can be missed.
- UI panels are canvas snapshots at max 2 Hz per panel, so fast HUD counters update at 2 Hz in the render.
- Billboards that face the player (explosion flash rings, sprites) keep facing where the player was, not the render camera.
- Points with screen-size (stars) are scaled by resolution; particles are recorded only while lit.
- Head-locked bits (off-screen ship arrow) follow the raw head, so they jitter a little against the smoothed head cam.
- Shaders / custom onBeforeRender effects are not replayed (none are used by these versions).

## Repo layout

- `index.html` - version picker (generated). `versions.json` - picks, notes, shot lists.
- `1-first/` ... `5-endless/` - the builds. `shared/recorder.js` - the recorder (copied into each build's `rec/`).
- `render/` - offline renderer (`render.mjs` server + ffmpeg, `page/player.js` reconstruction in Firefox).
- `tools/build.mjs` - rebuilds all snapshots: `node tools/build.mjs <path-to-vr-battle-room>`.
- `test/` - IWER (WebXR emulator) driver + server used to verify record -> zip -> render.
