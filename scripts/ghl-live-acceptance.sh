#!/usr/bin/env bash
# ============================================================================
# ghl-live-acceptance.sh — real-tenant GHL acceptance gate.
#
# Requires GHL_API_KEY + GHL_LOCATION_ID (never commit these).
# Starts a local Runtime with live backend, runs the gate, tears down.
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

: "${MIGRATION_DATABASE_URL:?}"
: "${DATABASE_URL:?}"
: "${GHL_API_KEY:?set GHL_API_KEY (PIT) — do not commit}"
: "${GHL_LOCATION_ID:?set GHL_LOCATION_ID}"

PORT="${PORT:-8099}"
export GIT_SHA="${GIT_SHA:-local}"
export SERVICE_VERSION="${SERVICE_VERSION:-0.1.0}"
export BUILD_TIME="${BUILD_TIME:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
export AION_ENVIRONMENT=local
export DATABASE_SSL="${DATABASE_SSL:-false}"
export AION_RUNTIME_URL="http://127.0.0.1:${PORT}"
export GHL_API_VERSION="${GHL_API_VERSION:-2021-07-28}"

echo "[ghl-live] build"
npm run build >/dev/null 2>&1
mkdir -p dist/sql
cp sql/grants.sql dist/sql/grants.sql 2>/dev/null || true

echo "[ghl-live] migrate"
MIGRATION_DATABASE_URL="$MIGRATION_DATABASE_URL" DATABASE_SSL="$DATABASE_SSL" node dist/migrate.js

start_runtime() {
  local log="$1"
  env -u MIGRATION_DATABASE_URL \
    DATABASE_URL="$DATABASE_URL" \
    PORT="$PORT" \
    RUN_SMOKE_ON_BOOT=false \
    GHL_API_KEY="$GHL_API_KEY" \
    GHL_LOCATION_ID="$GHL_LOCATION_ID" \
    GHL_API_VERSION="$GHL_API_VERSION" \
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
    echo "[ghl-live] NOT READY"
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

LOG="$ROOT/.proof-ghl-live-runtime.log"
cleanup() {
  stop_runtime "${RT_PID:-}"
  rm -f "$LOG"
}
trap cleanup EXIT

echo "[ghl-live] start Runtime (live GHL backend)"
RT_PID="$(start_runtime "$LOG")"
wait_ready "$LOG"
echo "[ghl-live] Runtime ready"

echo "[ghl-live] acceptance matrix"
AION_RUNTIME_URL="$AION_RUNTIME_URL" \
  GHL_LOCATION_ID="$GHL_LOCATION_ID" \
  node dist/ghl-live-acceptance.js

echo "[ghl-live] PASS — live acceptance gate green"
