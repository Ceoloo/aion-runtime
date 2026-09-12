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
# Identity plane: harnesses default open auth (staging/production would otherwise
# require AION_GATEWAY_API_KEYS). Override with AION_AUTH_MODE=required + keys.
export AION_AUTH_MODE="${AION_AUTH_MODE:-open}"
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
: "${PROOF_D_EXECUTION_ID:?missing PROOF_D_EXECUTION_ID}"

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
  PROOF_D_EXECUTION_ID="$PROOF_D_EXECUTION_ID" \
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

# ── Machine-readable release manifest (immutable freeze evidence) ──────────
# Captures exact SHAs + schema/catalog/runtime versions + criterion results.
# Written under releases/ so the freeze commit records what was certified.
MANIFEST_DIR="${CERT_MANIFEST_DIR:-$ROOT/releases}"
mkdir -p "$MANIFEST_DIR"
MANIFEST_PATH="${CERT_MANIFEST_PATH:-$MANIFEST_DIR/execution-platform-v0.1.0.manifest.json}"
CERTIFIED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
SCHEMA_VERSION="${CERT_SCHEMA_VERSION:-0003}"
CATALOG_VERSION="${CERT_CATALOG_VERSION:-v0}"
CORE_SHA="${CERT_CORE_SHA:-unknown}"
DATA_SHA="${CERT_DATA_SHA:-unknown}"
RUNTIME_SHA="${CERT_RUNTIME_SHA:-${GIT_SHA}}"
DOCS_SHA="${CERT_DOCS_SHA:-unknown}"
SERVICE_COUNT="$(psql "$DATABASE_URL" -Atc 'SELECT count(*) FROM services;' 2>/dev/null || echo unknown)"

cat >"$MANIFEST_PATH" <<EOF
{
  "release": "execution-platform-v0.1.0",
  "title": "AION Execution Platform v0.1.0 — Multi-Domain Execution Proof",
  "result": "PASS",
  "certifiedAt": "${CERTIFIED_AT}",
  "harness": "npm run certify:platform-v01",
  "components": {
    "aion-core": {
      "gitSha": "${CORE_SHA}",
      "packageVersion": "0.1.0"
    },
    "aion-data": {
      "gitSha": "${DATA_SHA}",
      "packageVersion": "0.1.0",
      "schemaVersion": "${SCHEMA_VERSION}"
    },
    "aion-runtime": {
      "gitSha": "${RUNTIME_SHA}",
      "packageVersion": "0.1.0",
      "serviceVersion": "${SERVICE_VERSION}"
    },
    "aion-docs": {
      "gitSha": "${DOCS_SHA}"
    }
  },
  "catalogVersion": "${CATALOG_VERSION}",
  "catalogServiceCount": ${SERVICE_COUNT},
  "criteria": {
    "CERT-CATALOG": "PASS",
    "CERT-REGRESSION": "PASS",
    "CERT-CROSS": "PASS",
    "CERT-GOVERNANCE": "PASS",
    "CERT-ECONOMICS": "PASS",
    "CERT-ATTRIBUTION": "PASS",
    "CERT-ISOLATION": "PASS",
    "CERT-DURABILITY": "PASS"
  },
  "notes": [
    "Tag execution-platform-v0.1.0 is immutable. Fixes ship as v0.1.1+.",
    "v0.1.0 certifies multi-domain reuse of shared contracts/catalog/data/runtime.",
    "Tenant isolation (Mission 003) is NOT guaranteed by this release."
  ]
}
EOF

echo "[cert-v01] wrote release manifest → ${MANIFEST_PATH}"
cat "$MANIFEST_PATH"
