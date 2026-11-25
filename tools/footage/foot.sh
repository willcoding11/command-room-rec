#!/bin/bash
# foot.sh <v> sheet            -> inspect + contact sheet of the whole recording (1 frame / 10 s, wide-director)
# foot.sh <v> prev FROM TO TAG -> 2 fps wide-director preview of FROM..TO s + 0.5 s contact sheet
F=/home/agent/share/crrec/footage; R=/home/agent/share/crrec/repo
V=$1; Z=$F/$V.zip; mkdir -p $F/sheets $F/prev
FONT=$(fc-match -f '%{file}' monospace)
if [ "$2" = sheet ]; then
  node $R/tools/inspect.mjs $Z --json $F/$V.inspect.json
  node $R/render/render.mjs $Z --every 600 --no-audio --out $F/sheets/$V-10s.mp4 2>&1 | grep -E "wide-director shots|video|ERROR|failed" | cut -c1-400
  ffmpeg -hide_banner -loglevel error -y -i $F/sheets/$V-10s.mp4 -vf "scale=480:270,drawtext=fontfile=$FONT:text='%{pts\:hms}':x=8:y=8:fontsize=22:fontcolor=yellow:box=1:boxcolor=black@0.6,tile=6x10" -frames:v 1 $F/sheets/$V-contact-10s.png
  ls -l $F/sheets/$V-contact-10s.png
elif [ "$2" = prev ]; then
  node $R/render/render.mjs $Z --from $3 --to $4 --every 30 --no-audio --out $F/prev/$5.mp4 ${@:6} 2>&1 | grep -E "wide-director shots|video|ERROR|failed" | cut -c1-600
  ffmpeg -hide_banner -loglevel error -y -i $F/prev/$5.mp4 -vf "setpts=PTS+$3/TB,scale=400:225,drawtext=fontfile=$FONT:text='%{pts\:hms}':x=8:y=8:fontsize=24:fontcolor=yellow:box=1:boxcolor=black@0.6,tile=6x$(( ($4-$3)*2/6 + 1 ))" -frames:v 1 $F/prev/$5-sheet.png
  ls -l $F/prev/$5-sheet.png
fi
