#!/usr/bin/env bash
# ============================================================================
# platform-v01-certification.sh — AION Execution Platform v0.1 multi-domain cert.
# ============================================================================
# Sequence:
#   migrate → boot Runtime → Mission 001 A/B/C → Mission 001 D (restart) →
#   Mission 002 A/B/C/X → CERT catalog/regression/cross/governance/economics/
#   attribution/isolation → pause Revenue R2 + Media R2 → restart → dual resume
#
# Required env: MIGRATION_DATABASE_URL, DATABASE_URL
# Optional: PORT (8093), DATABASE_SSL (false), GIT_SHA (local)
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

: "${MIGRATION_DATABASE_URL:?}"
: "${DATABASE_URL:?}"
PORT="${PORT:-8093}"
export GIT_SHA="${GIT_SHA:-local}"
export SERVICE_VERSION="${SERVICE_VERSION:-0.1.0}"
export BUILD_TIME="${BUILD_TIME:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
export AION_ENVIRONMENT="${AION_ENVIRONMENT:-staging}"
export DATABASE_SSL="${DATABASE_SSL:-false}"
export AION_RUNTIME_URL="http://127.0.0.1:${PORT}"

echo "[cert-v01] build"
npm run build >/dev/null 2>&1
mkdir -p dist/sql
cp sql/grants.sql dist/sql/grants.sql 2>/dev/null || true

echo "[cert-v01] migrate (migrator identity)"
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
    echo "[cert-v01] NOT READY"
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

LOG1="$ROOT/.cert-v01-runtime-1.log"
LOG2="$ROOT/.cert-v01-runtime-2.log"
LOG3="$ROOT/.cert-v01-runtime-3.log"
M001_ANCHORS="$ROOT/.cert-v01-m001-d.env"
CERT_ANCHORS="$ROOT/.cert-v01-dual-d.env"

echo "[cert-v01] start Runtime #1"
RT_PID="$(start_runtime "$LOG1")"
cleanup() {
  stop_runtime "${RT_PID:-}"
  rm -f "$LOG1" "$LOG2" "$LOG3" "$M001_ANCHORS" "$CERT_ANCHORS" \
    "${M001_ANCHORS}.vars" "${CERT_ANCHORS}.vars"
}
trap cleanup EXIT

wait_ready "$LOG1"
echo "[cert-v01] Runtime #1 ready"

echo "[cert-v01] Mission 001 proof matrix (PASS A/B/C)"
PROOF_MODE=full AION_RUNTIME_URL="$AION_RUNTIME_URL" node dist/mission001-proof-matrix.js

echo "[cert-v01] Mission 001 PASS D prepare"
PROOF_MODE=d-prepare AION_RUNTIME_URL="$AION_RUNTIME_URL" \
  node dist/mission001-proof-matrix.js | tee "$M001_ANCHORS"
set -a
grep -E '^PROOF_D_' "$M001_ANCHORS" >"${M001_ANCHORS}.vars"
# shellcheck disable=SC1091
source "${M001_ANCHORS}.vars"
set +a
: "${PROOF_D_RUN_ID:?missing PROOF_D_RUN_ID}"
: "${PROOF_D_APPROVAL_ID:?missing PROOF_D_APPROVAL_ID}"

echo "[cert-v01] kill Runtime #1 (Mission 001 durability restart)"
stop_runtime "$RT_PID"
RT_PID=""
sleep 0.5

echo "[cert-v01] start Runtime #2"
RT_PID="$(start_runtime "$LOG2")"
wait_ready "$LOG2"
echo "[cert-v01] Runtime #2 ready"

echo "[cert-v01] Mission 001 PASS D resume"
PROOF_MODE=d-resume \
  PROOF_D_REQUEST_ID="${PROOF_D_REQUEST_ID:-}" \
  PROOF_D_RUN_ID="$PROOF_D_RUN_ID" \
  PROOF_D_APPROVAL_ID="$PROOF_D_APPROVAL_ID" \
  AION_RUNTIME_URL="$AION_RUNTIME_URL" \
  node dist/mission001-proof-matrix.js

echo "[cert-v01] Mission 002 proof matrix (PASS A/B/C/X)"
PROOF_MODE=full AION_RUNTIME_URL="$AION_RUNTIME_URL" node dist/mission002-proof-matrix.js

echo "[cert-v01] Platform v0.1 multi-domain certification segment"
PROOF_MODE=full AION_RUNTIME_URL="$AION_RUNTIME_URL" node dist/platform-v01-certification.js

echo "[cert-v01] CERT-DURABILITY prepare (pause Revenue R2 + Media R2)"
PROOF_MODE=d-prepare AION_RUNTIME_URL="$AION_RUNTIME_URL" \
  node dist/platform-v01-certification.js | tee "$CERT_ANCHORS"
set -a
grep -E '^CERT_D_' "$CERT_ANCHORS" >"${CERT_ANCHORS}.vars"
# shellcheck disable=SC1091
source "${CERT_ANCHORS}.vars"
set +a
: "${CERT_D_REVENUE_RUN_ID:?missing CERT_D_REVENUE_RUN_ID}"
: "${CERT_D_REVENUE_APPROVAL_ID:?missing CERT_D_REVENUE_APPROVAL_ID}"
: "${CERT_D_MEDIA_RUN_ID:?missing CERT_D_MEDIA_RUN_ID}"
: "${CERT_D_MEDIA_APPROVAL_ID:?missing CERT_D_MEDIA_APPROVAL_ID}"

echo "[cert-v01] kill Runtime #2 (dual-domain durability restart)"
stop_runtime "$RT_PID"
RT_PID=""
sleep 0.5

echo "[cert-v01] start Runtime #3"
RT_PID="$(start_runtime "$LOG3")"
wait_ready "$LOG3"
echo "[cert-v01] Runtime #3 ready"

echo "[cert-v01] CERT-DURABILITY resume (Revenue + Media)"
PROOF_MODE=d-resume \
  CERT_D_REVENUE_REQUEST_ID="${CERT_D_REVENUE_REQUEST_ID:-}" \
  CERT_D_REVENUE_RUN_ID="$CERT_D_REVENUE_RUN_ID" \
  CERT_D_REVENUE_APPROVAL_ID="$CERT_D_REVENUE_APPROVAL_ID" \
  CERT_D_MEDIA_REQUEST_ID="${CERT_D_MEDIA_REQUEST_ID:-}" \
  CERT_D_MEDIA_RUN_ID="$CERT_D_MEDIA_RUN_ID" \
  CERT_D_MEDIA_APPROVAL_ID="$CERT_D_MEDIA_APPROVAL_ID" \
  AION_RUNTIME_URL="$AION_RUNTIME_URL" \
  node dist/platform-v01-certification.js

echo "[cert-v01] PASS — AION Execution Platform v0.1 multi-domain certification green"
