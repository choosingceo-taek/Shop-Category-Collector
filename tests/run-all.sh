#!/bin/sh
# Every contract in one command, so "does it still work" is one answer and not
# a dozen. Probes (bd-, wipe-, update-keeps-, panelshot, shot, repshot,
# livecheck, panelgeo) are measuring tools, not contracts — they print facts
# and are run by hand when a question comes up.
#
#   sh tests/run-all.sh
set -e
cd "$(dirname "$0")"
export NODE_PATH=/opt/node22/lib/node_modules

PLAIN="encoding-test price-test naming-test matrix-probe dashboard-e2e"
BROWSER="goal-e2e shortgrid-e2e assetfetch-e2e edge-e2e panelread-e2e tabs-e2e updnote-e2e menuimport-e2e databox-e2e selfupd-e2e"

fails=""
for t in $PLAIN; do
  printf '%-18s ' "$t"
  if out=$(node "$t.js" 2>&1); then
    echo "$out" | grep -E "passed,|clean ·" | tail -1
  else
    echo "$out" | grep -E "passed,|failing|HARNESS" | tail -1
    fails="$fails $t"
  fi
done
for t in $BROWSER; do
  printf '%-18s ' "$t"
  rm -rf /tmp/pw-goal /tmp/pw-shortgrid /tmp/pw-assetfetch /tmp/pw-edge /tmp/pw-panelread /tmp/pw-tabs /tmp/pw-updnote-e2e /tmp/pw-menuimport /tmp/pw-databox /tmp/pw-selfupd
  if out=$(timeout 300 xvfb-run -a node "$t.js" 2>&1); then
    echo "$out" | grep "passed," | tail -1
  else
    echo "$out" | grep -E "passed,|HARNESS" | tail -1
    fails="$fails $t"
  fi
done

echo
if [ -n "$fails" ]; then echo "FAILING:$fails"; exit 1; fi
echo "all green"
