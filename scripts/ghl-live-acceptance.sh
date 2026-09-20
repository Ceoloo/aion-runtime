#!/usr/bin/env bash
# ============================================================================
# ghl-live-acceptance.sh — live-location synthetic acceptance gate.
#
# Fails closed without credentials + fixture config.
# Restarts Runtime between stage park and resume.
# Writes a separate evidence record (GHL_LIVE_EVIDENCE_PATH).
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/proof-env.sh" live-acceptance
ROOT="$(pwd)"

: "${MIGRATION_DATABASE_URL:?}"
: "${DATABASE_URL:?}"
: "${GHL_API_KEY:?live mode fails closed — set GHL_API_KEY (PIT); do not commit}"
: "${GHL_LOCATION_ID:?live mode fails closed — set GHL_LOCATION_ID}"
: "${GHL_ACCEPTANCE_PIPELINE_ID:?live mode fails closed — set GHL_ACCEPTANCE_PIPELINE_ID}"
: "${GHL_ACCEPTANCE_STAGE_NEW:?live mode fails closed — set GHL_ACCEPTANCE_STAGE_NEW}"
: "${GHL_ACCEPTANCE_STAGE_QUALIFIED:?live mode fails closed — set GHL_ACCEPTANCE_STAGE_QUALIFIED}"

PORT="${PORT:-8105}"
export GIT_SHA="${GIT_SHA:-local}"
export SERVICE_VERSION="${SERVICE_VERSION:-0.1.0}"
export BUILD_TIME="${BUILD_TIME:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
export AION_ENVIRONMENT="${AION_ENVIRONMENT:-staging}"
export AION_AUTH_MODE="${AION_AUTH_MODE:-open}"
export DATABASE_SSL="${DATABASE_SSL:-false}"
export AION_RUNTIME_URL="http://127.0.0.1:${PORT}"
export GHL_API_VERSION="${GHL_API_VERSION:-2021-07-28}"
HANDOFF="${ROOT}/.proof-ghl-live-handoff.json"
EVIDENCE="${GHL_LIVE_EVIDENCE_PATH:-${ROOT}/.proof-ghl-live-evidence.json}"
export GHL_LIVE_HANDOFF_PATH="$HANDOFF"
export GHL_LIVE_EVIDENCE_PATH="$EVIDENCE"

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
  rm -f "$LOG" "$HANDOFF"
}
trap cleanup EXIT

echo "[ghl-live] start Runtime (live GHL backend)"
RT_PID="$(start_runtime "$LOG")"
wait_ready "$LOG"
echo "[ghl-live] Runtime ready"

echo "[ghl-live] synthetic happy path (pre-restart)"
GHL_LIVE_PHASE=pre AION_RUNTIME_URL="$AION_RUNTIME_URL" \
  GHL_LIVE_HANDOFF_PATH="$HANDOFF" \
  GHL_LIVE_EVIDENCE_PATH="$EVIDENCE" \
  GHL_LOCATION_ID="$GHL_LOCATION_ID" \
  GHL_ACCEPTANCE_PIPELINE_ID="$GHL_ACCEPTANCE_PIPELINE_ID" \
  GHL_ACCEPTANCE_STAGE_NEW="$GHL_ACCEPTANCE_STAGE_NEW" \
  GHL_ACCEPTANCE_STAGE_QUALIFIED="$GHL_ACCEPTANCE_STAGE_QUALIFIED" \
  node dist/ghl-live-acceptance.js

echo "[ghl-live] restart Runtime (stage approval must survive)"
stop_runtime "$RT_PID"
RT_PID="$(start_runtime "$LOG")"
wait_ready "$LOG"

echo "[ghl-live] resume + replay + evidence"
GHL_LIVE_PHASE=post AION_RUNTIME_URL="$AION_RUNTIME_URL" \
  GHL_LIVE_HANDOFF_PATH="$HANDOFF" \
  GHL_LIVE_EVIDENCE_PATH="$EVIDENCE" \
  GHL_LOCATION_ID="$GHL_LOCATION_ID" \
  GHL_ACCEPTANCE_PIPELINE_ID="$GHL_ACCEPTANCE_PIPELINE_ID" \
  GHL_ACCEPTANCE_STAGE_NEW="$GHL_ACCEPTANCE_STAGE_NEW" \
  GHL_ACCEPTANCE_STAGE_QUALIFIED="$GHL_ACCEPTANCE_STAGE_QUALIFIED" \
  node dist/ghl-live-acceptance.js

echo "[ghl-live] PASS — live acceptance evidence at ${EVIDENCE}"
