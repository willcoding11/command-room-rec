#!/bin/bash
# start batch.sh detached inside the box; logs to /tmp/crrec-batch.log (copied to the share as it goes)
E=/home/agent/share/crrec/footage/edits; mkdir -p $E
if [ -f /tmp/crrec-batch.pid ] && kill -0 $(cat /tmp/crrec-batch.pid) 2>/dev/null; then echo "already running pid $(cat /tmp/crrec-batch.pid)"; exit 0; fi
rm -rf $E/work-*
setsid nohup bash -c 'echo $$ > /tmp/crrec-batch.pid; exec bash /home/agent/share/crrec/batch.sh' >> /tmp/crrec-batch.log 2>&1 < /dev/null &
sleep 3; echo "started pid $(cat /tmp/crrec-batch.pid)"; tail -3 /tmp/crrec-batch.log
