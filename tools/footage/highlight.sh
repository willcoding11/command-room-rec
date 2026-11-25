#!/bin/bash
# highlight.sh <v> <name> <from-to> [<from-to> ...]
#   renders each segment of footage/<v>.zip in wide-director (1080p60, game audio) and joins them
#   -> footage/edits/<name>.mp4 (+ <name>-sheet.png, 1 frame / s)
F=/home/agent/share/crrec/footage; R=/home/agent/share/crrec/repo
V=$1; N=$2; shift 2
W=$F/edits/work-$N; rm -rf $W; mkdir -p $W $F/edits
i=0; IN=(); FC=""
for seg in "$@"; do
  a=${seg%-*}; b=${seg#*-}
  node $R/render/render.mjs $F/$V.zip --from $a --to $b --out $W/s$i.mp4 2>&1 | grep -E "video:|ERROR|failed"
  d=$(awk "BEGIN{print $b-$a}")
  IN+=(-i $W/s$i.mp4)
  FC="$FC[$i:v]setpts=PTS-STARTPTS[v$i];[$i:a]asetpts=PTS-STARTPTS,afade=t=in:d=0.03,afade=t=out:st=$(awk "BEGIN{print $d-0.05}"):d=0.05[a$i];"
  i=$((i+1))
done
CAT=""; for k in $(seq 0 $((i-1))); do CAT="$CAT[v$k][a$k]"; done
ffmpeg -hide_banner -loglevel error -y "${IN[@]}" -filter_complex "${FC}${CAT}concat=n=$i:v=1:a=1[v][a]" -map "[v]" -map "[a]" \
  -c:v libx264 -preset medium -crf 17 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart $F/edits/$N.mp4
ffprobe -v error -show_entries stream=codec_name,width,height,avg_frame_rate:format=duration -of compact $F/edits/$N.mp4
FONT=$(fc-match -f '%{file}' monospace)
ffmpeg -hide_banner -loglevel error -y -i $F/edits/$N.mp4 -vf "fps=1,scale=320:180,drawtext=fontfile=$FONT:text='%{pts\:hms}':x=6:y=6:fontsize=18:fontcolor=yellow:box=1:boxcolor=black@0.6,tile=8x8" -frames:v 1 $F/edits/$N-sheet.png
rm -rf $W
ls -l $F/edits/$N.mp4
