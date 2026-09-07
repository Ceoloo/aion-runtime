#!/usr/bin/env bash
# ============================================================================
# mission007-proof-matrix.sh — Mission 007 PASS A–E against live Runtime.
# ============================================================================
# Sequence:
#   migrate → boot Runtime → PASS A (identical rankings) →
#   PASS B (insufficient samples cannot win) →
#   PASS C (fail/policy penalties) →
#   PASS D (tenant / header DENY) →
#   PASS E (manual override + deterministic fallback)
#
# Required env: MIGRATION_DATABASE_URL, DATABASE_URL
# Optional: PORT (8097), DATABASE_SSL (false), GIT_SHA (local)
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

: "${MIGRATION_DATABASE_URL:?}"
: "${DATABASE_URL:?}"
PORT="${PORT:-8097}"
export GIT_SHA="${GIT_SHA:-local}"
export SERVICE_VERSION="${SERVICE_VERSION:-0.1.0}"
export BUILD_TIME="${BUILD_TIME:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
export AION_ENVIRONMENT="${AION_ENVIRONMENT:-staging}"
export DATABASE_SSL="${DATABASE_SSL:-false}"
export AION_RUNTIME_URL="http://127.0.0.1:${PORT}"

echo "[proof-m007] build"
npm run build >/dev/null 2>&1
mkdir -p dist/sql
cp sql/grants.sql dist/sql/grants.sql 2>/dev/null || true

echo "[proof-m007] migrate"
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
    echo "[proof-m007] NOT READY"
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

LOG="$ROOT/.proof-m007-runtime.log"

echo "[proof-m007] start Runtime"
RT_PID="$(start_runtime "$LOG")"
cleanup() {
  stop_runtime "${RT_PID:-}"
  rm -f "$LOG"
}
trap cleanup EXIT

wait_ready "$LOG"
echo "[proof-m007] Runtime ready"

echo "[proof-m007] PASS A–E"
AION_RUNTIME_URL="$AION_RUNTIME_URL" node dist/mission007-proof-matrix.js

echo "[proof-m007] PASS — Mission 007 matrix A–E green"
