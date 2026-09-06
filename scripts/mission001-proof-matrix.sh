#!/usr/bin/env bash
# ============================================================================
# mission001-proof-matrix.sh — Mission 001 PASS A/B/C/D against live Runtime.
# ============================================================================
# Sequence:
#   migrate → boot Runtime → PASS A/B/C → pause R2 run → kill Runtime →
#   reboot Runtime → PASS D resume (same run, no double execute)
#
# Required env: MIGRATION_DATABASE_URL, DATABASE_URL
# Optional: PORT (8090), DATABASE_SSL (false), GIT_SHA (local)
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

: "${MIGRATION_DATABASE_URL:?}"
: "${DATABASE_URL:?}"
PORT="${PORT:-8090}"
export GIT_SHA="${GIT_SHA:-local}"
export SERVICE_VERSION="${SERVICE_VERSION:-0.1.0}"
export BUILD_TIME="${BUILD_TIME:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
export AION_ENVIRONMENT="${AION_ENVIRONMENT:-staging}"
export DATABASE_SSL="${DATABASE_SSL:-false}"
export AION_RUNTIME_URL="http://127.0.0.1:${PORT}"

echo "[proof] build"
npm run build >/dev/null 2>&1
mkdir -p dist/sql
cp sql/grants.sql dist/sql/grants.sql 2>/dev/null || cp sql/grants.sql dist/sql/grants.sql

echo "[proof] migrate (migrator identity)"
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
    echo "[proof] NOT READY"
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

LOG1="$ROOT/.proof-runtime-1.log"
LOG2="$ROOT/.proof-runtime-2.log"
ANCHORS="$ROOT/.proof-d-anchors.env"

echo "[proof] start Runtime #1"
RT_PID="$(start_runtime "$LOG1")"
cleanup() {
  stop_runtime "${RT_PID:-}"
  rm -f "$LOG1" "$LOG2" "$ANCHORS"
}
trap cleanup EXIT

wait_ready "$LOG1"
echo "[proof] Runtime #1 ready"

echo "[proof] PASS A/B/C"
PROOF_MODE=full AION_RUNTIME_URL="$AION_RUNTIME_URL" node dist/mission001-proof-matrix.js

echo "[proof] PASS D prepare (pause R2 before restart)"
PROOF_MODE=d-prepare AION_RUNTIME_URL="$AION_RUNTIME_URL" \
  node dist/mission001-proof-matrix.js | tee "$ANCHORS"
# shellcheck disable=SC1090
set -a
# Extract only PROOF_D_* assignments
grep -E '^PROOF_D_' "$ANCHORS" >"${ANCHORS}.vars"
# shellcheck disable=SC1091
source "${ANCHORS}.vars"
set +a
: "${PROOF_D_RUN_ID:?missing PROOF_D_RUN_ID}"
: "${PROOF_D_APPROVAL_ID:?missing PROOF_D_APPROVAL_ID}"

echo "[proof] kill Runtime #1 (simulate process restart)"
stop_runtime "$RT_PID"
RT_PID=""
sleep 0.5

echo "[proof] start Runtime #2"
RT_PID="$(start_runtime "$LOG2")"
wait_ready "$LOG2"
echo "[proof] Runtime #2 ready"

echo "[proof] PASS D resume"
PROOF_MODE=d-resume \
  PROOF_D_REQUEST_ID="${PROOF_D_REQUEST_ID:-}" \
  PROOF_D_RUN_ID="$PROOF_D_RUN_ID" \
  PROOF_D_APPROVAL_ID="$PROOF_D_APPROVAL_ID" \
  AION_RUNTIME_URL="$AION_RUNTIME_URL" \
  node dist/mission001-proof-matrix.js

echo "[proof] PASS — Mission 001 matrix A/B/C/D green"
