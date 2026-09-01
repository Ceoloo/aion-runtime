#!/usr/bin/env bash
# ============================================================================
# local-acceptance.sh — deployment sequence against a real PostgreSQL.
# ============================================================================
# migrate (migrator) → boot runtime (app role) → readiness → smoke.
# The runtime step NEVER receives MIGRATION_DATABASE_URL.
#
# Required env: MIGRATION_DATABASE_URL, DATABASE_URL.
# Optional: PORT (8090), GIT_SHA (local), AION_ENVIRONMENT (staging), DATABASE_SSL.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

: "${MIGRATION_DATABASE_URL:?}"; : "${DATABASE_URL:?}"
PORT="${PORT:-8090}"
export GIT_SHA="${GIT_SHA:-local}" SERVICE_VERSION="${SERVICE_VERSION:-0.1.0}"
export BUILD_TIME="${BUILD_TIME:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
export AION_ENVIRONMENT="${AION_ENVIRONMENT:-staging}" DATABASE_SSL="${DATABASE_SSL:-false}"

echo "[acceptance] build"
npm run build >/dev/null 2>&1
mkdir -p dist/sql && cp sql/grants.sql dist/sql/grants.sql

echo "[acceptance] 1/4 migrate (migrator identity, fail-closed)"
MIGRATION_DATABASE_URL="$MIGRATION_DATABASE_URL" DATABASE_SSL="$DATABASE_SSL" node dist/migrate.js

echo "[acceptance] 2/4 start runtime (app identity — NO migration URL)"
env -u MIGRATION_DATABASE_URL DATABASE_URL="$DATABASE_URL" PORT="$PORT" RUN_SMOKE_ON_BOOT=true \
  node dist/index.js >"$ROOT/.acceptance-runtime.log" 2>&1 &
RT_PID=$!
cleanup() { kill -TERM "$RT_PID" 2>/dev/null || true; wait "$RT_PID" 2>/dev/null || true; }
trap cleanup EXIT

echo "[acceptance] 3/4 readiness"
ready=0
for _ in $(seq 1 40); do
  sleep 0.3
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/health/ready" || echo 000)" = 200 ] && { ready=1; break; }
done
[ "$ready" = 1 ] || { echo "NOT READY"; cat "$ROOT/.acceptance-runtime.log"; exit 1; }
echo "[acceptance]     ready (HTTP 200)"

echo "[acceptance] 4/4 smoke (release SHA + health)"
body="$(curl -s "http://127.0.0.1:${PORT}/")"
echo "$body" | grep -q "\"git_sha\":\"${GIT_SHA}\"" || { echo "SHA mismatch: $body"; exit 1; }
curl -sf "http://127.0.0.1:${PORT}/health/ready" >/dev/null || { echo "not ready at smoke"; exit 1; }
grep -o 'boot_smoke_passed' "$ROOT/.acceptance-runtime.log" | head -1 || { echo "boot smoke missing"; exit 1; }
rm -f "$ROOT/.acceptance-runtime.log"
echo "[acceptance] PASS — migrate → deploy → readiness → smoke"
