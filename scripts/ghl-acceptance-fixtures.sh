#!/usr/bin/env bash
# ============================================================================
# ghl-acceptance-fixtures.sh — deterministic acceptance fixture matrix.
# FakeGhlBackend + Runtime + Postgres. Restarts between park and resume.
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/proof-env.sh" fake
ROOT="$(pwd)"

: "${MIGRATION_DATABASE_URL:?}"
: "${DATABASE_URL:?}"
PORT="${PORT:-8104}"
export GIT_SHA="${GIT_SHA:-local}"
export SERVICE_VERSION="${SERVICE_VERSION:-0.1.0}"
export BUILD_TIME="${BUILD_TIME:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
export AION_ENVIRONMENT="${AION_ENVIRONMENT:-staging}"
export AION_AUTH_MODE="${AION_AUTH_MODE:-open}"
export DATABASE_SSL="${DATABASE_SSL:-false}"
export AION_RUNTIME_URL="http://127.0.0.1:${PORT}"
HANDOFF="${ROOT}/.proof-ghl-accept-handoff.json"
export GHL_ACCEPT_HANDOFF_PATH="$HANDOFF"
# Force fake backend — failure injection must be deterministic.
unset GHL_API_KEY AION_GHL_API_KEY GHL_LOCATION_ID AION_GHL_LOCATION_ID || true

echo "[ghl-accept-fixtures] build"
npm run build >/dev/null 2>&1
mkdir -p dist/sql
cp sql/grants.sql dist/sql/grants.sql 2>/dev/null || true

echo "[ghl-accept-fixtures] migrate"
MIGRATION_DATABASE_URL="$MIGRATION_DATABASE_URL" DATABASE_SSL="$DATABASE_SSL" node dist/migrate.js

start_runtime() {
  local log="$1"
  env -u MIGRATION_DATABASE_URL \
    -u GHL_API_KEY -u AION_GHL_API_KEY -u GHL_LOCATION_ID -u AION_GHL_LOCATION_ID \
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
    echo "[ghl-accept-fixtures] NOT READY"
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

LOG="$ROOT/.proof-ghl-accept-runtime.log"
cleanup() {
  stop_runtime "${RT_PID:-}"
  rm -f "$LOG" "$HANDOFF"
}
trap cleanup EXIT

echo "[ghl-accept-fixtures] start Runtime (fake GHL)"
RT_PID="$(start_runtime "$LOG")"
wait_ready "$LOG"
echo "[ghl-accept-fixtures] Runtime ready"

echo "[ghl-accept-fixtures] PASS A–I (pre-restart)"
GHL_ACCEPT_PHASE=pre AION_RUNTIME_URL="$AION_RUNTIME_URL" \
  GHL_ACCEPT_HANDOFF_PATH="$HANDOFF" \
  node dist/ghl-acceptance-fixtures-matrix.js

echo "[ghl-accept-fixtures] restart Runtime"
stop_runtime "$RT_PID"
RT_PID="$(start_runtime "$LOG")"
wait_ready "$LOG"

echo "[ghl-accept-fixtures] post-restart resume + replay"
GHL_ACCEPT_PHASE=post AION_RUNTIME_URL="$AION_RUNTIME_URL" \
  GHL_ACCEPT_HANDOFF_PATH="$HANDOFF" \
  node dist/ghl-acceptance-fixtures-matrix.js

echo "[ghl-accept-fixtures] PASS — acceptance fixtures green"
