#!/usr/bin/env bash
# ============================================================================
# ie002-proof-matrix.sh — IE-002 provisioning/activation acceptance matrix.
# ============================================================================
# Required env: MIGRATION_DATABASE_URL, DATABASE_URL
# Optional: PORT (8102), DATABASE_SSL (false), GIT_SHA (local)
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

: "${MIGRATION_DATABASE_URL:?}"
: "${DATABASE_URL:?}"
PORT="${PORT:-8102}"
export GIT_SHA="${GIT_SHA:-local}"
export SERVICE_VERSION="${SERVICE_VERSION:-0.1.0}"
export BUILD_TIME="${BUILD_TIME:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
export AION_ENVIRONMENT=staging
# Identity plane: harnesses default open auth (staging/production would otherwise
# require AION_GATEWAY_API_KEYS). Override with AION_AUTH_MODE=required + keys.
export AION_AUTH_MODE="${AION_AUTH_MODE:-open}"
export DATABASE_SSL="${DATABASE_SSL:-false}"
export AION_RUNTIME_URL="http://127.0.0.1:${PORT}"

echo "[proof-ie002] build"
npm run build >/dev/null 2>&1
mkdir -p dist/sql
cp sql/grants.sql dist/sql/grants.sql 2>/dev/null || true

echo "[proof-ie002] migrate"
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
    echo "[proof-ie002] NOT READY"
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

LOG="$ROOT/.proof-ie002-runtime.log"

echo "[proof-ie002] start Runtime"
RT_PID="$(start_runtime "$LOG")"
cleanup() {
  stop_runtime "${RT_PID:-}"
  rm -f "$LOG"
}
trap cleanup EXIT

wait_ready "$LOG"
echo "[proof-ie002] Runtime ready"

echo "[proof-ie002] acceptance matrix"
AION_RUNTIME_URL="$AION_RUNTIME_URL" node dist/ie002-proof-matrix.js

echo "[proof-ie002] PASS — IE-002 acceptance matrix green"
