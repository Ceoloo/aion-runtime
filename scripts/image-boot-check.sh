#!/usr/bin/env bash
# ============================================================================
# image-boot-check.sh — certify that a built Runtime IMAGE actually boots.
# ============================================================================
# The v0.2.0 image built and published green in CI but could not start
# (`Cannot find package '@aion/core'` — node_modules shipped without vendor/).
# CI "build succeeded" is NOT "artifact is deployable". This script closes that
# gap: it runs the real deployment sequence against a throwaway Postgres and
# asserts the externally observable boot signals.
#
#   1. bring up a disposable postgres:16 + the two least-privilege roles
#   2. run the image's migration entrypoint  (node dist/migrate.js)
#   3. start the long-running host from the SAME image
#   4. assert GET /health/live = 200, GET /health/ready = 200,
#      and GET / reports the expected git_sha
#   5. tear everything down (always)
#
# Self-contained: it creates its own docker network + postgres, so it behaves
# identically in CI and on a workstation/VPS. Nothing is published to a host
# port; the runtime is reached over a private docker network only.
#
# Usage:  scripts/image-boot-check.sh <image-ref> [expected_git_sha]
set -euo pipefail

IMAGE="${1:?usage: image-boot-check.sh <image-ref> [expected_git_sha]}"
EXPECTED_SHA="${2:-${GITHUB_SHA:-}}"

NET="aion-bootcheck-$$"
PG="aion-bootcheck-pg-$$"
RT="aion-bootcheck-rt-$$"
APP_PW="app_$$_pw"
MIG_PW="mig_$$_pw"

cleanup() {
  docker rm -f "$RT" "$PG" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() { echo "BOOT-CHECK FAIL: $*" >&2; exit 1; }

echo "[boot-check] image under test: ${IMAGE}"
docker network create "$NET" >/dev/null

echo "[boot-check] 1/4 disposable postgres:16"
docker run -d --name "$PG" --network "$NET" \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=aion_data \
  postgres:16-alpine >/dev/null
# `pg_isready` answers TRUE against the entrypoint's transient init-time server
# too — before POSTGRES_DB is created and before the real restart. Gate on an
# actual SELECT against the target DB so we never race that window.
pg_ok=""
for _ in $(seq 1 60); do
  if docker exec "$PG" psql -U postgres -d aion_data -tAc 'SELECT 1' >/dev/null 2>&1; then
    pg_ok=1; break
  fi
  sleep 1
done
[ -n "$pg_ok" ] || { docker logs "$PG" 2>&1 | tail -30 >&2; fail "postgres never became ready"; }

# Two-role least-privilege model (same as providers/vps/system/init-roles.sh).
docker exec -i "$PG" psql -v ON_ERROR_STOP=1 -U postgres -d aion_data >/dev/null <<SQL
CREATE ROLE aion_migrator LOGIN PASSWORD '${MIG_PW}';
CREATE ROLE aion_app LOGIN PASSWORD '${APP_PW}';
GRANT ALL ON SCHEMA public TO aion_migrator;
ALTER DATABASE aion_data OWNER TO aion_migrator;
SQL

MIGRATION_URL="postgresql://aion_migrator:${MIG_PW}@${PG}:5432/aion_data"
APP_URL="postgresql://aion_app:${APP_PW}@${PG}:5432/aion_data"

echo "[boot-check] 2/4 migration entrypoint (node dist/migrate.js)"
docker run --rm --network "$NET" \
  -e MIGRATION_DATABASE_URL="$MIGRATION_URL" \
  -e AION_ENVIRONMENT=production -e DATABASE_SSL=false \
  "$IMAGE" node dist/migrate.js || fail "migration entrypoint exited non-zero"

echo "[boot-check] 3/4 start the long-running host"
docker run -d --name "$RT" --network "$NET" \
  -e DATABASE_URL="$APP_URL" \
  -e AION_ENVIRONMENT=production -e DATABASE_SSL=false \
  -e AION_AUTH_MODE=open \
  -e PORT=8080 -e GIT_SHA="${EXPECTED_SHA:-unknown}" \
  "$IMAGE" >/dev/null

probe() { docker run --rm --network "$NET" curlimages/curl:8.10.1 -sf --max-time 5 "$@"; }

echo "[boot-check] 4/5 assert boot signals"
ready=""
for _ in $(seq 1 30); do
  if probe "http://${RT}:8080/health/live" >/dev/null 2>&1; then ready=1; break; fi
  if ! docker ps --format '{{.Names}}' | grep -qx "$RT"; then
    echo "---- runtime container exited early; logs: ----" >&2
    docker logs "$RT" 2>&1 | tail -40 >&2
    fail "runtime container is not running"
  fi
  sleep 2
done
[ -n "$ready" ] || { docker logs "$RT" 2>&1 | tail -40 >&2; fail "/health/live never returned 200"; }

probe "http://${RT}:8080/health/live"  >/dev/null || fail "/health/live not 200"
probe "http://${RT}:8080/health/ready" >/dev/null || { docker logs "$RT" 2>&1 | tail -40 >&2; fail "/health/ready not 200 (DB check)"; }

root_body="$(probe "http://${RT}:8080/")" || fail "GET / not 200"
echo "[boot-check]   GET / -> ${root_body}"
if [ -n "${EXPECTED_SHA}" ]; then
  echo "${root_body}" | grep -q "\"git_sha\":\"${EXPECTED_SHA}\"" \
    || fail "GET / git_sha != expected ${EXPECTED_SHA}"
fi

echo "[boot-check] 5/5 packaging hygiene — no development residue in the image"
docker run --rm --entrypoint sh "$IMAGE" -c '
  set -e
  # No source-control metadata anywhere.
  test ! -d /app/vendor/aion-core/.git
  test ! -d /app/vendor/aion-data/.git
  test ! -d /app/vendor/aion-data/vendor/aion-core/.git
  [ -z "$(find /app -name .git -print -quit)" ] || { echo "found .git under /app" >&2; exit 1; }
  # No TypeScript sources left in the vendored packages (dist/** is what runs).
  test ! -d /app/vendor/aion-core/src
  test ! -d /app/vendor/aion-data/src
  # No known dev-only tooling carried by ANY node_modules under /app.
  hit="$(find /app -type d -path "*/node_modules/*" \( \
      -name typescript -o -name vitest -o -name @vitest -o -name vite \
   -o -name eslint -o -name @eslint -o -name @typescript-eslint \
   -o -name tsx -o -name ts-node -o -name esbuild -o -name @esbuild \
   -o -name rollup -o -name @rollup -o -name @types -o -name chai \) -print)"
  if [ -n "$hit" ]; then echo "dev tooling present:" >&2; echo "$hit" >&2; exit 1; fi
  # aion-data migrations MUST still be present (its package "files" list).
  find /app/vendor/aion-data/migrations -name "*.sql" | grep -q .
  echo "  hygiene OK: no .git, no src/, no TypeScript/Vitest/ESLint; migrations present"
' || fail "development residue found in the final image"

echo "[boot-check] PASS — ${IMAGE} boots, migrates, serves /health/ready, and carries no dev residue"
