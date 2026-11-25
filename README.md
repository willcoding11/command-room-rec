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

That writes `...-wide-director.mp4` next to the zip: 1920x1080 60 fps H.264 with the game audio.

**Wide director (default, `--mode wide-director`).** Keeps the battle area in view, never a close-up. The
battle room's own wireframe box is found in the log and framed by its 8 real corners, so a resized or reshaped room
stays in frame. If there's no room (v1's open arena) or it's hidden, it frames a robust box round the ships. Hard cuts
land every 2-4 s, never the same type twice. World up is screen up (zero roll, pitch within +-35 deg). Shot types:

- wide static
- slow wide orbit (12-24 deg)
- slow drift / push (fitted at its tightest point, so the box is never cropped)
- wide follow: trails the fight cluster from outside it, never nearer than 65 % of the full-room distance
- the player's head view, smoothed with roll removed, used only when they are looking into the room

**Framing (`--frame`).** The default, `medium`, puts the camera halfway, in distance, between fitting the whole room
and fitting the fight (the core of the ship positions during the shot), with the aim moved toward the fight. It's
never nearer than 35 % of the room distance. `--frame room` frames the whole box; `--frame fight` or a number 0..1
goes tighter or looser. The lenses are long (32-40 deg) from further back, so the box fills the frame evenly. Ships are drawn with thicker
lines (`--lwship 2.6` px) and a little brighter (`--boost 1.2`), so they read at full-room framing. ui/hands default off.

**Director (`--mode director`).** The tighter trailer cut. The whole log is read first, so the edit can look ahead. A hard cut lands every 2-4 s
(varied), and the camera moves smoothly with easing inside each shot. World up is always screen up: zero roll, and
pitch stays within +-35 deg. Shot types, never the same type twice in a row:

- wide establishing (locked)
- locked-off static next to the action
- damped follow
- close-up (ship about 1/3 of the frame)
- slow orbit / push-in round a fight
- flyby (still camera, ship passes close)

Subjects are picked by action. An upcoming kill gets a shot that starts just before it, with the explosion landing
55-70 % into the shot; otherwise the player's ship, its nearest enemy or another live ship. Each shot is chosen from
about 10 candidate cameras, scored on:

- the subject in frame and not hidden behind a star
- no star or rock filling the foreground
- the camera not outside the battle room

`--seed N` gives a different edit; ui/hands default off.

Options (`node render/render.mjs --help`):

```
--mode wide-director|director|head|wide|chase   --res 1080|1440|4k|WxH   --fps 60   --from S --to S   --seed N
--ui on|off  --hands on|off      (defaults: on for head/wide, off for the directors and chase)
--frame medium|room|fight|0..1   (wide-director framing, default medium)
--lwship PX --boost K            (ship line width / brightness; wide-director 2.6 / 1.2)
--every N  (preview: render every Nth frame)
--linewidth PX (1.6 at 1080p, scales with resolution; 0 = thin native lines)
--fov DEG  --smooth SEC  --target NAME|ID  --dist N --height N  --cam x,y,z --look x,y,z
--still SEC --out shot.png  (one frame)  --crf 16  --no-audio
```

Speed in the box (software GL): ~8 output frames/s at 1080p, so a 10-minute take at 60 fps is about 75 minutes.

## Inspecting a recording

`node tools/inspect.mjs <recording.zip> [--json out.json]` (needs ffprobe for the audio part). It checks:

- the zip (CRC per entry) and that frames.bin parses to the end
- the frame timing (rate, median / p95 / max frame gap, logging gaps)
- the audio: codec, rate, length vs the scene log, level, decode errors

It also reads the activity out of the log:

- kills, wingmen lost and player deaths (ships hidden for good)
- the runs, from the game's own messages (mode, rounds reached, how each run ended)
- the best 8-second windows

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
