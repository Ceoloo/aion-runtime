#!/usr/bin/env bash
# ============================================================================
# ghl-phase-ab-proof-matrix.sh — Phase A reads + Phase B governed write proof.
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

: "${MIGRATION_DATABASE_URL:?}"
: "${DATABASE_URL:?}"
PORT="${PORT:-8099}"
export GIT_SHA="${GIT_SHA:-local}"
export SERVICE_VERSION="${SERVICE_VERSION:-0.1.0}"
export BUILD_TIME="${BUILD_TIME:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
# Proof harness must use a Runtime-valid environment (not ambient IDE values).
export AION_ENVIRONMENT=local
export DATABASE_SSL="${DATABASE_SSL:-false}"
export AION_RUNTIME_URL="http://127.0.0.1:${PORT}"
# Force fake backend in CI unless explicitly opting into live credentials.
unset GHL_API_KEY AION_GHL_API_KEY GHL_LOCATION_ID AION_GHL_LOCATION_ID || true

echo "[proof-ghl-ab] build"
npm run build >/dev/null 2>&1
mkdir -p dist/sql
cp sql/grants.sql dist/sql/grants.sql 2>/dev/null || true

echo "[proof-ghl-ab] migrate"
MIGRATION_DATABASE_URL="$MIGRATION_DATABASE_URL" DATABASE_SSL="$DATABASE_SSL" node dist/migrate.js

start_runtime() {
  local log="$1"
  env -u MIGRATION_DATABASE_URL \
    DATABASE_URL="$DATABASE_URL" \
    PORT="$PORT" \
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
    echo "[proof-ghl-ab] NOT READY"
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

LOG="$ROOT/.proof-ghl-ab-runtime.log"
cleanup() {
  stop_runtime "${RT_PID:-}"
  rm -f "$LOG"
}
trap cleanup EXIT

echo "[proof-ghl-ab] start Runtime"
RT_PID="$(start_runtime "$LOG")"
wait_ready "$LOG"
echo "[proof-ghl-ab] Runtime ready"

echo "[proof-ghl-ab] Phase A/B matrix"
AION_RUNTIME_URL="$AION_RUNTIME_URL" node dist/ghl-phase-ab-proof-matrix.js

echo "[proof-ghl-ab] PASS — GHL Phase A/B green"
