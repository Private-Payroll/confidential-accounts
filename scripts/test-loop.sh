#!/usr/bin/env bash
# Runs the suite until it fails, keeping every run's OUTPUT.
#
# The failure this exists for has now been seen twice and lost twice, both times
# for the same reason: the run was piped straight into `grep`, so when it failed
# there was nothing left to read but the summary line. A failure nobody can name
# is the one that comes back on payday.
#
#   ./scripts/test-loop.sh 20
#
# Stops on the first red run and prints the failing test names. Every run is
# kept in logs/flakehunt/ regardless, so a run that passes oddly is still there.
set -uo pipefail
cd "$(dirname "$0")/.."
N="${1:-20}"
mkdir -p logs/flakehunt
strip() { perl -pe 's/\e\[[0-9;]*m//g'; }

for i in $(seq 1 "$N"); do
  LOG="logs/flakehunt/run-$(date +%s)-$i.log"
  ./node_modules/.bin/vitest run > "$LOG" 2>&1
  LINE="$(strip < "$LOG" | grep -E '^ +Tests +[0-9]' | tail -1)"
  echo "[$i/$N]$LINE"
  if echo "$LINE" | grep -q failed; then
    echo
    echo "CAUGHT — $LOG"
    strip < "$LOG" | grep -E '^ +× |FAIL |AssertionError|Expected:|Received:' | head -40
    exit 1
  fi
done
echo
echo "$N consecutive clean runs."
