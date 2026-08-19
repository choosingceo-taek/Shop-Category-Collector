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

PLAIN="encoding-test price-test naming-test colour-test shelf-test matrix-probe dashboard-e2e"
BROWSER="goal-e2e fibreblocks-e2e rescan-e2e shortgrid-e2e assetfetch-e2e edge-e2e panelread-e2e tabs-e2e updnote-e2e menuimport-e2e databox-e2e labtools-e2e shelf-e2e siteorder-e2e rail-e2e weekbucket-e2e gymshark-e2e gymgrid-e2e nikegrid-e2e unfile-e2e varley-e2e athleta-e2e selfupd-e2e"

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
  rm -rf /tmp/pw-goal /tmp/pw-fibre /tmp/pw-rescan /tmp/pw-shortgrid /tmp/pw-assetfetch /tmp/pw-edge /tmp/pw-panelread /tmp/pw-tabs /tmp/pw-updnote-e2e /tmp/pw-menuimport /tmp/pw-databox /tmp/pw-labtools /tmp/pw-shelf /tmp/pw-siteorder /tmp/pw-rail /tmp/pw-weekbucket /tmp/pw-gymshark /tmp/pw-gymgrid /tmp/pw-nikegrid /tmp/pw-unfile /tmp/pw-varley /tmp/pw-athleta /tmp/pw-selfupd
  if out=$(timeout 900 xvfb-run -a node "$t.js" 2>&1); then
    echo "$out" | grep "passed," | tail -1
  else
    echo "$out" | grep -E "passed,|HARNESS" | tail -1
    fails="$fails $t"
  fi
done

echo
if [ -n "$fails" ]; then echo "FAILING:$fails"; exit 1; fi
echo "all green"
