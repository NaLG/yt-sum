#!/bin/sh
# Load (or unload) the weekly YouTube-contract check as a launchd agent.
# gui/<uid> is the normal domain, but it rejects bootstrap from an SSH session;
# user/<uid> works in both, which is why the plist allows Aqua + Background.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL=dev.nalg.yapsum-weekly
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_NUM="$(id -u)"

unload() {
  for domain in "gui/$UID_NUM" "user/$UID_NUM"; do
    launchctl bootout "$domain/$LABEL" 2>/dev/null
  done
}

if [ "${1:-}" = "--uninstall" ]; then
  unload
  rm -f "$PLIST"
  echo "removed $LABEL"
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/yap-sum"
unload
cp "$ROOT/scripts/$LABEL.plist" "$PLIST"
for domain in "gui/$UID_NUM" "user/$UID_NUM"; do
  if launchctl bootstrap "$domain" "$PLIST" 2>/dev/null; then
    echo "loaded $LABEL into $domain"
    launchctl print "$domain/$LABEL" | sed -n '1,4p'
    exit 0
  fi
done
echo "could not bootstrap $LABEL into gui/ or user/; load it from a desktop session" >&2
exit 1
