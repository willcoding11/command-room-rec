#!/bin/bash
# poll up to $1 seconds (default 540); exit early when the batch finishes or dies
T=${1:-540}; E=/home/agent/share/crrec/footage/edits
for ((i=0; i<T; i+=15)); do
  cp /tmp/crrec-batch.log $E/batch.log 2>/dev/null
  grep -q BATCHDONE /tmp/crrec-batch.log 2>/dev/null && break
  kill -0 $(cat /tmp/crrec-batch.pid 2>/dev/null) 2>/dev/null || { echo "BATCH NOT RUNNING"; break; }
  sleep 15
done
echo "--- $(date +%T)"; grep -E "===|video:|duration|\.mp4|ERROR|failed|BATCHDONE" /tmp/crrec-batch.log | tail -20
ls $E | grep -E "\.done|\.mp4"
