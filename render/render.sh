#!/bin/bash
# Render a COMMAND ROOM recording zip to MP4 (1080p60, game audio).
#   render.sh <recording.zip>                  -> <zip>-director.mp4 (edited multi-camera cut)
#   render.sh <recording.zip> --mode head ...  -> other cameras / options (see render.mjs --help)
# Needs: node 18+, firefox, ffmpeg.
HERE="$(cd "$(dirname "$0")" && pwd)"
ZIP="$1"; shift
[ -f "$ZIP" ] || { echo "usage: render.sh <recording.zip> [options]"; node "$HERE/render.mjs" --help; exit 1; }
node "$HERE/render.mjs" "$ZIP" "$@"
