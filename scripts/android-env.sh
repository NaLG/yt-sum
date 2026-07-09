# Android SDK environment for yap-sum's device-free test loop.
# Source this before emulator/web-ext commands:  . scripts/android-env.sh
#
# NOTE: use the SDK's platform-tools adb, NOT homebrew's cask adb
# (/opt/homebrew/bin/adb hangs at exec on this machine — broken cask signature;
# same upstream version 37.0.0 from the SDK works).
export JAVA_HOME=/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin:$JAVA_HOME/bin:$PATH"
