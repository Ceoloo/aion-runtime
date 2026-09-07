#!/usr/bin/env bash
# ============================================================================
# mission009-proof-matrix.sh — Mission 009 PASS A–J against live Runtime.
# Restarts Runtime between approval park and resume (PASS G).
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
export AION_ENVIRONMENT="${AION_ENVIRONMENT:-staging}"
export DATABASE_SSL="${DATABASE_SSL:-false}"
export AION_RUNTIME_URL="http://127.0.0.1:${PORT}"
HANDOFF="${ROOT}/.proof-m009-handoff.json"
export M009_HANDOFF_PATH="$HANDOFF"

echo "[proof-m009] build"
npm run build >/dev/null 2>&1
mkdir -p dist/sql
cp sql/grants.sql dist/sql/grants.sql 2>/dev/null || true

echo "[proof-m009] migrate"
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
    echo "[proof-m009] NOT READY"
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

LOG="$ROOT/.proof-m009-runtime.log"
cleanup() {
  stop_runtime "${RT_PID:-}"
  rm -f "$LOG" "$HANDOFF"
}
trap cleanup EXIT

echo "[proof-m009] start Runtime"
RT_PID="$(start_runtime "$LOG")"
wait_ready "$LOG"
echo "[proof-m009] Runtime ready"

echo "[proof-m009] PASS A–F (pre-restart)"
M009_PROOF_PHASE=pre AION_RUNTIME_URL="$AION_RUNTIME_URL" \
  M009_HANDOFF_PATH="$HANDOFF" \
  node dist/mission009-proof-matrix.js

echo "[proof-m009] restart Runtime (PASS G)"
stop_runtime "$RT_PID"
RT_PID="$(start_runtime "$LOG")"
wait_ready "$LOG"

echo "[proof-m009] PASS G–J (post-restart)"
M009_PROOF_PHASE=post AION_RUNTIME_URL="$AION_RUNTIME_URL" \
  M009_HANDOFF_PATH="$HANDOFF" \
  node dist/mission009-proof-matrix.js

echo "[proof-m009] PASS — Mission 009 matrix A–J green"
