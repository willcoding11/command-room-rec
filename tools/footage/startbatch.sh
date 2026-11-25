#!/bin/bash
# start batch.sh detached inside the box (survives the Windows-side wsl client going away)
L=/home/agent/share/crrec/footage/edits/batch.log
mkdir -p /home/agent/share/crrec/footage/edits
rm -rf /home/agent/share/crrec/footage/edits/work-*
setsid nohup bash /home/agent/share/crrec/batch.sh > $L 2>&1 < /dev/null &
echo "started pid $!"
