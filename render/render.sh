#!/bin/bash
# Render a COMMAND ROOM recording zip to MP4 (1080p, game audio).
#   render.sh <recording.zip>                 -> <zip>-head.mp4 and <zip>-chase.mp4
#   render.sh <recording.zip> --mode wide ... -> one video with those options (see render.mjs --help)
# Needs: node 18+, firefox, ffmpeg.
HERE="$(cd "$(dirname "$0")" && pwd)"
ZIP="$1"; shift
[ -f "$ZIP" ] || { echo "usage: render.sh <recording.zip> [options]"; node "$HERE/render.mjs" --help; exit 1; }
if [[ " $* " == *" --mode "* ]]; then
  node "$HERE/render.mjs" "$ZIP" "$@"
else
  node "$HERE/render.mjs" "$ZIP" --mode head "$@" && node "$HERE/render.mjs" "$ZIP" --mode chase "$@"
fi
