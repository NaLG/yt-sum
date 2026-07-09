#!/bin/sh
# Device-free Android test loop: boot a headless emulator with Firefox set up
# for yap-sum extraction tests (remote debugging on, desktop-site UA, YouTube
# app disabled so links stay in Firefox).
#
# One-time host deps:
#   brew install openjdk && brew install --cask android-commandlinetools
#   (do NOT use the android-platform-tools cask adb — it hangs at exec on this
#    machine; android-env.sh puts the SDK's own adb first on PATH)
#
# Usage:
#   scripts/android-emulator.sh up      # boot + provision (idempotent)
#   scripts/android-emulator.sh down    # shut the emulator down
# Then:
#   npm run test:android                # validates extraction (desktop-site UA)
set -e
. "$(dirname "$0")/android-env.sh"

AVD=yapsum
SYSIMG="system-images;android-35;google_apis;arm64-v8a"
FENIX_VERSION=152.0.5
FENIX_URL="https://ftp.mozilla.org/pub/fenix/releases/${FENIX_VERSION}/android/fenix-${FENIX_VERSION}-android-arm64-v8a/fenix-${FENIX_VERSION}.multi.android-arm64-v8a.apk"
FENIX_APK="${TMPDIR:-/tmp}/fenix-${FENIX_VERSION}-arm64.apk"
DESKTOP_UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:152.0) Gecko/20100101 Firefox/152.0"

if [ "$1" = "down" ]; then
  adb emu kill 2>/dev/null || true
  echo "emulator stopped"
  exit 0
fi

# --- SDK pieces (skip when present) ---
[ -x "$ANDROID_HOME/emulator/emulator" ] || sdkmanager "emulator"
[ -x "$ANDROID_HOME/platform-tools/adb" ] || sdkmanager "platform-tools"
[ -d "$ANDROID_HOME/system-images/android-35" ] || (yes | sdkmanager --licenses >/dev/null; sdkmanager "$SYSIMG")

# --- AVD ---
avdmanager list avd | grep -q "Name: $AVD" ||
  echo no | avdmanager create avd -n "$AVD" -k "$SYSIMG" -d pixel_7

# --- boot ---
adb start-server >/dev/null
if ! adb devices | grep -q "^emulator-.*device$"; then
  echo "booting $AVD (headless)..."
  nohup emulator -avd "$AVD" -no-window -no-audio -no-boot-anim -no-snapshot \
    -gpu swiftshader_indirect >/tmp/yapsum-emulator.log 2>&1 &
  adb wait-for-device
  i=0
  until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
    i=$((i + 1)); [ $i -gt 60 ] && { echo "boot timeout"; exit 1; }
    sleep 5
  done
fi
echo "emulator up: $(adb shell getprop ro.build.version.release | tr -d '\r')"

# --- Firefox (release Fenix works: web-ext temp-installs via RDP) ---
if ! adb shell pm list packages | grep -q org.mozilla.firefox; then
  [ -f "$FENIX_APK" ] || curl -sL -o "$FENIX_APK" "$FENIX_URL"
  adb install -r "$FENIX_APK"
  # first run creates prefs + the Gecko profile
  adb shell am start -n org.mozilla.firefox/.App >/dev/null
  sleep 12
  adb shell am force-stop org.mozilla.firefox
fi

# --- provision (needs adb root — google_apis images allow it) ---
adb root >/dev/null 2>&1; sleep 2; adb wait-for-device
PREFS=/data/data/org.mozilla.firefox/shared_prefs/fenix_preferences.xml
# Remote debugging: exposes the RDP unix socket web-ext waits for.
adb shell "grep -q pref_key_remote_debugging $PREFS ||
  sed -i 's|</map>|    <boolean name=\"pref_key_remote_debugging\" value=\"true\" />\n</map>|' $PREFS"
# Never bounce youtube links out to apps.
adb shell "grep -q pref_key_open_links_in_apps $PREFS ||
  sed -i 's|</map>|    <string name=\"pref_key_open_links_in_apps\">never</string>\n</map>|' $PREFS"
# Belt and braces: the google_apis image ships the YouTube app.
adb shell pm disable-user --user 0 com.google.android.youtube >/dev/null 2>&1 || true
# Desktop-site UA: m.youtube.com exposes NO transcript surface (no panel UI,
# PoToken-gated timedtext — see test/probe-mobile.mjs). The desktop site in
# Fenix works fully; this pref is the automated "Request desktop site".
GECKO_PROF=$(adb shell "ls -d /data/data/org.mozilla.firefox/files/mozilla/*.default" | tr -d '\r')
adb shell "grep -q general.useragent.override $GECKO_PROF/user.js 2>/dev/null ||
  echo 'user_pref(\"general.useragent.override\", \"$DESKTOP_UA\");' >> $GECKO_PROF/user.js"

echo "provisioned: remote debugging on, desktop UA set, youtube app disabled"
echo "next: npm run test:android"
