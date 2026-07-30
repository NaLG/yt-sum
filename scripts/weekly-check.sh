#!/bin/sh
# Weekly YouTube-contract check for Return YouTube Summary.
# Runs the deterministic gate plus the live YouTube canaries and the mweb state
# matrix. No LLM inference: the only model calls in the tree are served by the
# local mock in test/smoke-full.mjs. Rationale: docs/TESTING.md.
#
#   scripts/weekly-check.sh              # full run (gate + canary + matrix)
#   scripts/weekly-check.sh --quick      # gate + canary, skip the matrix
#   scripts/weekly-check.sh --no-android # desktop only, no emulator
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2
. "$ROOT/scripts/android-env.sh"
export PATH="$ROOT/node_modules/.bin:$PATH"
export YAPSUM_HEADLESS="${YAPSUM_HEADLESS:-1}"

LOG_DIR="${YAPSUM_LOG_DIR:-$HOME/Library/Logs/yap-sum}"
mkdir -p "$LOG_DIR" "$ROOT/test/artifacts/reports"
STAMP="$(date +%Y-%m-%d-%H%M)"
LOG="$LOG_DIR/weekly-$STAMP.log"
SUMMARY="$LOG_DIR/latest.txt"
TG_NOTIFY="$HOME/repos/clawd-agents/reynold/scripts/tg-notify.sh"

QUICK=0
ANDROID=1
for arg in "$@"; do
  [ "$arg" = "--quick" ] && QUICK=1
  [ "$arg" = "--no-android" ] && ANDROID=0
done

contract_fail=""
infra_warn=""

say() { echo "$1" | tee -a "$LOG"; }

run_step() {
  name="$1"
  shift
  say ""
  say "=== $name ==="
  "$@" >>"$LOG" 2>&1
  code=$?
  case "$code" in
    0) say "OK      $name" ;;
    2) say "SKIPPED $name (environment inconclusive)"; infra_warn="$infra_warn $name" ;;
    *) say "FAILED  $name (exit $code)"; contract_fail="$contract_fail $name" ;;
  esac
  return 0
}

say "yap-sum weekly check  $STAMP"
say "repo $(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null)  version $(node -p "require('$ROOT/package.json').version" 2>/dev/null)"

run_step "release gate" node test/run-all.mjs
run_step "contract lint" node test/lint-contract.mjs
run_step "canary desktop" node test/canary-desktop.mjs

if [ "$ANDROID" = "1" ]; then
  run_step "canary mweb" node test/canary-mweb.mjs
  if [ "$QUICK" = "0" ]; then
    run_step "matrix mweb" node test/matrix-mweb.mjs
  fi
  sh "$ROOT/scripts/android-emulator.sh" down >>"$LOG" 2>&1
fi

say ""
if [ -n "$contract_fail" ]; then
  RESULT="FAILED:$contract_fail"
  say "RESULT: FAILED ->$contract_fail"
  say "YouTube likely changed something the extension depends on."
  say "Failing contract items name the source that depends on them; see the log above."
  EXIT=1
elif [ -n "$infra_warn" ]; then
  RESULT="INCONCLUSIVE:$infra_warn"
  say "RESULT: INCONCLUSIVE ->$infra_warn (environment, not YouTube)"
  EXIT=2
else
  RESULT="PASSED"
  say "RESULT: PASSED, every YouTube contract check still holds"
  EXIT=0
fi

{
  echo "$STAMP $RESULT"
  echo "log: $LOG"
} > "$SUMMARY"

if [ "$EXIT" = "1" ] && [ -x "$TG_NOTIFY" ]; then
  "$TG_NOTIFY" "🐤 yap-sum weekly canary FAILED ->$contract_fail
YouTube probably changed a surface the extension depends on.
log: $LOG" >/dev/null 2>&1 || true
fi

ls -t "$LOG_DIR"/weekly-*.log 2>/dev/null | tail -n +13 | xargs rm -f 2>/dev/null
exit $EXIT
