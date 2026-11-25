#!/bin/bash
# all four highlights, medium wide-director framing; resumable (skips clips with a .done marker)
H=/home/agent/share/crrec/highlight.sh; E=/home/agent/share/crrec/footage/edits
run() { local v=$1 n=$2; shift 2; if [ -f $E/$n.done ]; then echo "=== $n already done"; return; fi
  echo "=== $n"; bash $H $v $n "$@" && [ -s $E/$n.mp4 ] && touch $E/$n.done; }
run v4 v4-highlight-fighter 35-42 58-64 85-91 96-105 109-117 120-126 129-136 141-152
run v3 v3-highlight-lobby-music 234-242 244-250 341-348 360-366 438-446 483-492
run v1 v1-highlight-first 17-22 56-64 82-90 151-159 177-185
run v2 v2-highlight-squadron 80-88 101-108 208-217 280-286 294-304 328-334
echo BATCHDONE
