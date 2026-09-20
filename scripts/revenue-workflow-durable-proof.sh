#!/usr/bin/env bash
# ============================================================================
# revenue-workflow-durable-proof.sh — one durable AION revenue workflow.
#
# Lead/Contact → Opportunity → Task/Note → agent → human gate → outcome →
# execution record → cost/value. Restarts Runtime between gate park and resume.
# Uses FakeGhlBackend when GHL_* keys are unset (CI / local).
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

: "${MIGRATION_DATABASE_URL:?}"
: "${DATABASE_URL:?}"
PORT="${PORT:-8103}"
export GIT_SHA="${GIT_SHA:-local}"
export SERVICE_VERSION="${SERVICE_VERSION:-0.1.0}"
export BUILD_TIME="${BUILD_TIME:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
export AION_ENVIRONMENT="${AION_ENVIRONMENT:-staging}"
export AION_AUTH_MODE="${AION_AUTH_MODE:-open}"
export DATABASE_SSL="${DATABASE_SSL:-false}"
export AION_RUNTIME_URL="http://127.0.0.1:${PORT}"
HANDOFF="${ROOT}/.proof-rw-handoff.json"
export RW_HANDOFF_PATH="$HANDOFF"

echo "[proof-rw] safety guard (disposable DB only, no live GHL)"
node scripts/lib/proof-guard.mjs

echo "[proof-rw] build"
npm run build >/dev/null 2>&1
mkdir -p dist/sql
cp sql/grants.sql dist/sql/grants.sql 2>/dev/null || true

echo "[proof-rw] migrate"
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
    echo "[proof-rw] NOT READY"
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

LOG="$ROOT/.proof-rw-runtime.log"
cleanup() {
  stop_runtime "${RT_PID:-}"
  rm -f "$LOG" "$HANDOFF"
}
trap cleanup EXIT

echo "[proof-rw] start Runtime"
RT_PID="$(start_runtime "$LOG")"
wait_ready "$LOG"
echo "[proof-rw] Runtime ready"

echo "[proof-rw] PASS A–D (pre-restart)"
RW_PROOF_PHASE=pre AION_RUNTIME_URL="$AION_RUNTIME_URL" \
  RW_HANDOFF_PATH="$HANDOFF" \
  node dist/revenue-workflow-durable-proof-matrix.js

echo "[proof-rw] restart Runtime (PASS E)"
stop_runtime "$RT_PID"
RT_PID="$(start_runtime "$LOG")"
wait_ready "$LOG"

echo "[proof-rw] PASS E–J + TELEMETRY (post-restart)"
RW_PROOF_PHASE=post AION_RUNTIME_URL="$AION_RUNTIME_URL" \
  RW_HANDOFF_PATH="$HANDOFF" \
  node dist/revenue-workflow-durable-proof-matrix.js

echo "[proof-rw] PASS — durable revenue workflow green"
