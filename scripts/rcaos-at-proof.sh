#!/usr/bin/env bash
# ============================================================================
# rcaos-at-proof.sh — Revenue Capture & Appointment OS AT-1…AT-7 (D0–D7).
# FakeGhlBackend + Runtime + Postgres. Fail-closed without live GHL creds.
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/proof-env.sh" fake
ROOT="$(pwd)"

: "${MIGRATION_DATABASE_URL:?}"
: "${DATABASE_URL:?}"
PORT="${PORT:-8105}"
export GIT_SHA="${GIT_SHA:-local}"
export SERVICE_VERSION="${SERVICE_VERSION:-0.1.0}"
export BUILD_TIME="${BUILD_TIME:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
export AION_ENVIRONMENT="${AION_ENVIRONMENT:-staging}"
export AION_AUTH_MODE="${AION_AUTH_MODE:-open}"
export DATABASE_SSL="${DATABASE_SSL:-false}"
export AION_RUNTIME_URL="http://127.0.0.1:${PORT}"
export RCAOS_EVIDENCE_PATH="${RCAOS_EVIDENCE_PATH:-${ROOT}/.proof-rcaos-at-evidence.json}"
# Force fake backend — never touch live CRM from this harness.
unset GHL_API_KEY AION_GHL_API_KEY GHL_LOCATION_ID AION_GHL_LOCATION_ID || true

echo "[rcaos-at] unit: demo-electrical-smb-v1 rules"
npm run build >/dev/null 2>&1
node --test dist/rcaos/demo-electrical-smb-v1.test.js

mkdir -p dist/sql
cp sql/grants.sql dist/sql/grants.sql 2>/dev/null || true

echo "[rcaos-at] migrate"
MIGRATION_DATABASE_URL="$MIGRATION_DATABASE_URL" DATABASE_SSL="$DATABASE_SSL" node dist/migrate.js

start_runtime() {
  local log="$1"
  env -u MIGRATION_DATABASE_URL \
    -u GHL_API_KEY -u AION_GHL_API_KEY -u GHL_LOCATION_ID -u AION_GHL_LOCATION_ID \
    DATABASE_URL="$DATABASE_URL" \
    PORT="$PORT" \
    GHL_BACKEND=fake \
    RUN_SMOKE_ON_BOOT=false \
    node dist/index.js >"$log" 2>&1 &
  echo $!
}

wait_ready() {
  local ready=0
  for _ in $(seq 1 50); do
    sleep 0.3
    if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/health/ready" || echo 000)" = 200 ]; then
      ready=1
      break
    fi
  done
  [ "$ready" = 1 ] || {
    echo "[rcaos-at] NOT READY"
    cat "$1"
    exit 1
  }
}

stop_runtime() {
  local pid="$1"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
}

LOG="$ROOT/.proof-rcaos-at-runtime.log"
cleanup() {
  stop_runtime "${RT_PID:-}"
  rm -f "$LOG"
}
trap cleanup EXIT

echo "[rcaos-at] start Runtime (fake GHL)"
RT_PID="$(start_runtime "$LOG")"
wait_ready "$LOG"
echo "[rcaos-at] Runtime ready"

echo "[rcaos-at] AT-1…AT-7 / D0–D7"
AION_RUNTIME_URL="$AION_RUNTIME_URL" \
  RCAOS_EVIDENCE_PATH="$RCAOS_EVIDENCE_PATH" \
  node dist/rcaos-at-proof-matrix.js

echo "[rcaos-at] PASS — evidence at $RCAOS_EVIDENCE_PATH"
