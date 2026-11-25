#!/bin/bash
# usage: test/run-xr.sh <repoDir> <slug> "<query>" <tag> <outDir>
# Runs one build in Firefox + IWER on Xvfb :7, waits for the driver's DONE, then shuts everything down.
REPO=$1; SLUG=$2; Q=$3; TAG=$4; OUT=$5
mkdir -p "$OUT"; DL=/tmp/crrec-dl-$TAG; rm -rf $DL; mkdir -p $DL
PORT=8177
node "$REPO/test/server.mjs" "$REPO" $PORT "$REPO/test/driver.js" /tmp/iwerpkg/package/build/iwer.module.js "$OUT/$TAG" > "$OUT/$TAG-server.out" 2>&1 & SRV=$!
Xvfb :7 -screen 0 1600x900x24 >/tmp/crrec-xvfb.out 2>&1 & XV=$!
# A virtual sound card (null sink) so WebAudio runs; we stop it again at the end if we started it.
# (A private server in its own runtime dir - never WSLg's, which would play on the Windows speakers.)
export XDG_RUNTIME_DIR=/tmp/crrec-xdg; mkdir -p $XDG_RUNTIME_DIR; chmod 700 $XDG_RUNTIME_DIR; unset PULSE_SERVER
PA_STARTED=0
if ! pulseaudio --check 2>/dev/null; then pulseaudio -n --daemonize=yes --exit-idle-time=-1 --use-pid-file=yes -L module-native-protocol-unix -L "module-null-sink sink_name=crnull" --log-target=file:/tmp/crrec-pa.log && PA_STARTED=1; sleep 1; fi
export PULSE_SERVER=unix:/tmp/crrec-xdg/pulse/native
sleep 1
PROF=/tmp/crrec-prof-$TAG; rm -rf $PROF; mkdir -p $PROF
cat > $PROF/user.js <<EOP
user_pref("webgl.force-enabled", true);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.aboutwelcome.enabled", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
user_pref("trailhead.firstrun.didSeeAboutWelcome", true);
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("browser.preonboarding.enabled", false);
user_pref("termsofuse.bypassNotification", true);
user_pref("termsofuse.acceptedVersion", 999);
user_pref("termsofuse.acceptedDate", "1700000000000");
user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("browser.startup.page", 0);
user_pref("media.autoplay.default", 0);
user_pref("media.autoplay.blocking_policy", 0);
user_pref("media.autoplay.block-webaudio", false);
user_pref("browser.download.folderList", 2);
user_pref("browser.download.dir", "$DL");
user_pref("browser.download.useDownloadDir", true);
user_pref("browser.download.always_ask_before_handling_new_types", false);
user_pref("browser.download.alwaysOpenPanel", false);
user_pref("browser.helperApps.neverAsk.saveToDisk", "application/zip");
EOP
env -u WAYLAND_DISPLAY MOZ_ENABLE_WAYLAND=0 GDK_BACKEND=x11 DISPLAY=:7 firefox -no-remote -profile $PROF --width 1600 --height 900 "http://127.0.0.1:$PORT/$SLUG/xrtest.html?test&$Q&tag=$TAG" >/tmp/crrec-ff-$TAG.out 2>&1 & FF=$!
LOG="$OUT/$TAG/log.txt"
for i in $(seq 1 600); do
  sleep 0.5
  grep -q "XRTEST DONE" "$LOG" 2>/dev/null && break
  [ $i = 40 ] && DISPLAY=:7 import -window root "$OUT/$TAG-screen-early.png" 2>/dev/null
done
DISPLAY=:7 import -window root "$OUT/$TAG-screen-end.png" 2>/dev/null
sleep 1
echo "--- XRTEST lines"; grep -E "XRTEST|ERROR|REJECT|CONSOLE.ERROR" "$LOG"
echo "--- downloads"; ls -la $DL
cp $DL/*.zip "$OUT/$TAG/" 2>/dev/null
kill $FF 2>/dev/null; sleep 2; pkill -9 -f "profile $PROF" 2>/dev/null
kill $SRV $XV 2>/dev/null; wait 2>/dev/null
[ $PA_STARTED = 1 ] && pulseaudio -k 2>/dev/null
echo stopped
