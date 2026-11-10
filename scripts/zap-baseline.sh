#!/usr/bin/env bash
# OWASP ZAP baseline (passive) scan against the running compose stack.
#
#   docker compose up --build -d --wait
#   npm run zap            # or: bash scripts/zap-baseline.sh
#
# Writes zap/reports/zap-report.{html,json,md}. Exits non-zero only when the scan finds
# at least one High-risk alert; Medium/Low/Informational are reported but do not fail.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ZAP_IMAGE="${ZAP_IMAGE:-zaproxy/zap-stable:2.17.0}"
TARGET="${ZAP_TARGET:-http://app:3000/}"
NETWORK="${ZAP_NETWORK:-resilience-lab}"
REPORTS="$ROOT/zap/reports"

mkdir -p "$REPORTS"
cp "$ROOT/zap/rules.tsv" "$REPORTS/rules.tsv"
# The ZAP image runs as uid 1000 ("zap"); on Linux CI the bind mount must be writable by it.
chmod a+rwx "$REPORTS"

echo "ZAP baseline: $TARGET (network $NETWORK, image $ZAP_IMAGE)"
set +e
docker run --rm \
  --network "$NETWORK" \
  -v "$REPORTS:/zap/wrk:rw" \
  "$ZAP_IMAGE" \
  zap-baseline.py \
  -t "$TARGET" \
  -c rules.tsv \
  -r zap-report.html \
  -J zap-report.json \
  -w zap-report.md \
  -I \
  -m 2
zap_exit=$?
set -e

# -I makes zap-baseline exit 0 on warnings, so 0 or 2 is "scan completed"; anything else is a scan error.
if [[ $zap_exit -ne 0 && $zap_exit -ne 2 ]]; then
  echo "ZAP exited with $zap_exit (scan error, not a finding)" >&2
  exit "$zap_exit"
fi

node "$ROOT/scripts/zap-summary.mjs" "$REPORTS/zap-report.json" "$ROOT/zap/rules.tsv"
