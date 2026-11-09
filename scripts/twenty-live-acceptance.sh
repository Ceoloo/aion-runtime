#!/usr/bin/env bash
# ============================================================================
# twenty-live-acceptance.sh — Gate C disposable Twenty live proof (fail-closed).
#
# NEVER runs in default CI. Requires explicit operator env:
#   AION_PROOF_LIVE=1
#   CRM_PROVIDER=twenty
#   TWENTY_BACKEND=live
#   TWENTY_API_BASE_URL / TWENTY_API_KEY (staging disposable workspace)
#   AION_PROOF_CREDENTIAL_SCOPE=disposable-twenty
#   TWENTY_ACCEPTANCE_TENANT
#   MIGRATION_DATABASE_URL / DATABASE_URL (disposable)
#
# Cross-tenant isolation (Gate C):
#   Option A — same process: also set TWENTY_API_KEY_B (second staging workspace key)
#   Option B — two-process: re-run this script with a different TWENTY_API_KEY and assert denial
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/proof-env.sh" live-twenty
ROOT="$(pwd)"

: "${MIGRATION_DATABASE_URL:?}"
: "${DATABASE_URL:?}"
: "${TWENTY_API_KEY:?live-twenty fails closed — set TWENTY_API_KEY (staging); do not commit}"
: "${TWENTY_API_BASE_URL:?live-twenty fails closed — set TWENTY_API_BASE_URL (staging)}"
: "${TWENTY_ACCEPTANCE_TENANT:?}"

PORT="${PORT:-8107}"
export GIT_SHA="${GIT_SHA:-local}"
export SERVICE_VERSION="${SERVICE_VERSION:-0.1.0}"
export BUILD_TIME="${BUILD_TIME:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
export AION_ENVIRONMENT="${AION_ENVIRONMENT:-local}"
export AION_AUTH_MODE="${AION_AUTH_MODE:-open}"
export DATABASE_SSL="${DATABASE_SSL:-false}"
export AION_RUNTIME_URL="${AION_RUNTIME_URL:-http://127.0.0.1:${PORT}}"
export CRM_PROVIDER=twenty
export TWENTY_BACKEND=live
# Force fake GHL — this harness must never write to live GHL.
export GHL_BACKEND=fake
unset GHL_API_KEY AION_GHL_API_KEY GHL_LOCATION_ID AION_GHL_LOCATION_ID || true

HANDOFF="${ROOT}/.proof-twenty-live-handoff.json"
EVIDENCE="${TWENTY_LIVE_EVIDENCE_PATH:-${ROOT}/.proof-twenty-live-evidence.json}"
export TWENTY_LIVE_HANDOFF_PATH="$HANDOFF"
export TWENTY_LIVE_EVIDENCE_PATH="$EVIDENCE"

echo "[twenty-live] build"
npm run build >/dev/null 2>&1
mkdir -p dist/sql
cp sql/grants.sql dist/sql/grants.sql 2>/dev/null || true

echo "[twenty-live] migrate"
MIGRATION_DATABASE_URL="$MIGRATION_DATABASE_URL" DATABASE_SSL="$DATABASE_SSL" node dist/migrate.js

start_runtime() {
  local log="$1"
  env -u MIGRATION_DATABASE_URL \
    -u GHL_API_KEY -u AION_GHL_API_KEY -u GHL_LOCATION_ID -u AION_GHL_LOCATION_ID \
    DATABASE_URL="$DATABASE_URL" \
    PORT="$PORT" \
    CRM_PROVIDER=twenty \
    TWENTY_BACKEND=live \
    GHL_BACKEND=fake \
    TWENTY_API_BASE_URL="$TWENTY_API_BASE_URL" \
    TWENTY_API_KEY="$TWENTY_API_KEY" \
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
    echo "[twenty-live] NOT READY"
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

LOG="$ROOT/.proof-twenty-live-runtime.log"
cleanup() {
  stop_runtime "${RT_PID:-}"
  rm -f "$LOG" "$HANDOFF"
}
trap cleanup EXIT

echo "[twenty-live] start Runtime (live Twenty backend)"
RT_PID="$(start_runtime "$LOG")"
wait_ready "$LOG"
echo "[twenty-live] Runtime ready"

echo "[twenty-live] disposable happy path + protected-hash deny + optional cross-tenant"
AION_RUNTIME_URL="$AION_RUNTIME_URL" \
  TWENTY_LIVE_EVIDENCE_PATH="$EVIDENCE" \
  TWENTY_ACCEPTANCE_TENANT="$TWENTY_ACCEPTANCE_TENANT" \
  TWENTY_API_BASE_URL="$TWENTY_API_BASE_URL" \
  TWENTY_API_KEY="$TWENTY_API_KEY" \
  ${TWENTY_API_KEY_B:+TWENTY_API_KEY_B="$TWENTY_API_KEY_B"} \
  node dist/twenty-live-acceptance.js

echo "[twenty-live] PASS — disposable live evidence at ${EVIDENCE}"
