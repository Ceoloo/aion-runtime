#!/usr/bin/env bash
# ============================================================================
# rcaos-at-twenty-proof.sh — RCAOS AT-1…AT-7 against CRM_PROVIDER=twenty
# (fake Twenty stand-in). Production GHL path is not used.
#
# Gate step: "fake Twenty RCAOS proofs" (CRM-001 cutover sequence).
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/proof-env.sh" fake
ROOT="$(pwd)"

: "${MIGRATION_DATABASE_URL:?}"
: "${DATABASE_URL:?}"
PORT="${PORT:-8106}"
export GIT_SHA="${GIT_SHA:-local}"
export SERVICE_VERSION="${SERVICE_VERSION:-0.1.0}"
export BUILD_TIME="${BUILD_TIME:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
export AION_ENVIRONMENT="${AION_ENVIRONMENT:-local}"
export AION_AUTH_MODE="${AION_AUTH_MODE:-open}"
export DATABASE_SSL="${DATABASE_SSL:-false}"
export AION_RUNTIME_URL="http://127.0.0.1:${PORT}"
export RCAOS_EVIDENCE_PATH="${RCAOS_EVIDENCE_PATH:-${ROOT}/.proof-rcaos-at-twenty-evidence.json}"

# Force fake Twenty — never touch live GHL or live Twenty from this harness.
unset GHL_API_KEY AION_GHL_API_KEY GHL_LOCATION_ID AION_GHL_LOCATION_ID || true
unset TWENTY_API_KEY TWENTY_API_BASE_URL || true
export CRM_PROVIDER=twenty
export TWENTY_BACKEND=fake
export GHL_BACKEND=fake

echo "[rcaos-at-twenty] unit: demo-electrical-smb-v1 rules"
npm run build >/dev/null 2>&1
node --test dist/rcaos/demo-electrical-smb-v1.test.js

mkdir -p dist/sql
cp sql/grants.sql dist/sql/grants.sql 2>/dev/null || true

echo "[rcaos-at-twenty] migrate"
MIGRATION_DATABASE_URL="$MIGRATION_DATABASE_URL" DATABASE_SSL="$DATABASE_SSL" node dist/migrate.js

start_runtime() {
  local log="$1"
  env -u MIGRATION_DATABASE_URL \
    -u GHL_API_KEY -u AION_GHL_API_KEY -u GHL_LOCATION_ID -u AION_GHL_LOCATION_ID \
    -u TWENTY_API_KEY -u TWENTY_API_BASE_URL \
    DATABASE_URL="$DATABASE_URL" \
    PORT="$PORT" \
    CRM_PROVIDER=twenty \
    TWENTY_BACKEND=fake \
    GHL_BACKEND=fake \
    RUN_SMOKE_ON_BOOT=false \
    node dist/index.js >"$log" 2>&1 &
  echo $!
}

wait_ready() {
  local ready=0
  local body=""
  for _ in $(seq 1 50); do
    sleep 0.3
    body="$(curl -s "http://127.0.0.1:${PORT}/health/ready" || true)"
    if echo "$body" | grep -q '"crm_provider":"twenty"' && echo "$body" | grep -q '"crm_backend":"fake"'; then
      ready=1
      break
    fi
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/health/ready" || echo 000)"
    if [ "$code" = "200" ] && echo "$body" | grep -q crm_provider; then
      echo "[rcaos-at-twenty] ready but unexpected CRM selection: $body"
      exit 1
    fi
  done
  [ "$ready" = 1 ] || {
    echo "[rcaos-at-twenty] NOT READY (want crm_provider=twenty crm_backend=fake)"
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

LOG="$ROOT/.proof-rcaos-at-twenty-runtime.log"
cleanup() {
  stop_runtime "${RT_PID:-}"
  rm -f "$LOG"
}
trap cleanup EXIT

echo "[rcaos-at-twenty] start Runtime (CRM_PROVIDER=twenty TWENTY_BACKEND=fake)"
RT_PID="$(start_runtime "$LOG")"
wait_ready "$LOG"
echo "[rcaos-at-twenty] Runtime ready (twenty-fake)"

echo "[rcaos-at-twenty] AT-1…AT-7 / D0–D7"
AION_RUNTIME_URL="$AION_RUNTIME_URL" \
  RCAOS_EVIDENCE_PATH="$RCAOS_EVIDENCE_PATH" \
  node dist/rcaos-at-proof-matrix.js

echo "[rcaos-at-twenty] PASS — evidence at $RCAOS_EVIDENCE_PATH"
