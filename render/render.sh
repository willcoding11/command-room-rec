#!/bin/bash
# Render a COMMAND ROOM recording zip to MP4 (1080p60, game audio).
#   render.sh <recording.zip>                  -> <zip>-wide-director.mp4 (edited cut, whole battle area in frame)
#   render.sh <recording.zip> --mode director  -> the tighter trailer cut (close-ups, flybys)
#   render.sh <recording.zip> --mode head ...  -> other cameras / options (see render.mjs --help)
# Needs: node 18+, firefox, ffmpeg.
HERE="$(cd "$(dirname "$0")" && pwd)"
ZIP="$1"; shift
[ -f "$ZIP" ] || { echo "usage: render.sh <recording.zip> [options]"; node "$HERE/render.mjs" --help; exit 1; }
node "$HERE/render.mjs" "$ZIP" "$@"
