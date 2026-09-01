#!/usr/bin/env bash
# ============================================================================
# portability-check.sh — provider-neutrality of the runtime host (ADR-002).
# ============================================================================
# The runtime must be deployable to any provider unchanged: no cloud SDK,
# env-based config/secrets, stdout logs, neutral health, DATABASE_URL-driven DB.
set -uo pipefail
cd "$(dirname "$0")/.."
PASS=0; FAIL=0
ok()  { printf '  \033[32mPASS\033[0m  %-30s %s\n' "$1" "$2"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %-30s %s\n' "$1" "$2"; FAIL=$((FAIL+1)); }
absent() { ! grep -RInE "$1" $2 >/dev/null 2>&1; }
present() { grep -RqsE "$1" $2; }

echo "== aion-runtime portability verification =="
SDK='@google-cloud/|googleapis|@aws-sdk/|aws-sdk|@azure/|hostinger'

absent "$SDK" src && absent "\"($SDK)\"" package.json \
  && ok RUNTIME_NO_CLOUD_SDK "src + package.json import no cloud SDK" \
  || bad RUNTIME_NO_CLOUD_SDK "cloud SDK reference in the runtime"

cd_clean=1
for d in vendor/aion-core/src vendor/aion-data/src; do
  [ -d "$d" ] && grep -RInE "$SDK" "$d" >/dev/null 2>&1 && cd_clean=0
done
[ $cd_clean -eq 1 ] && ok CORE_DATA_NO_PROVIDER_PKG "vendored core/data import no provider pkg" \
                    || bad CORE_DATA_NO_PROVIDER_PKG "provider pkg in core/data"

present 'process\.env' src/config.ts && absent 'SecretManager|secretsmanager|getSecretValue' src \
  && ok PROVIDER_NEUTRAL_SECRET_INJECTION "secrets via env; no secret SDK" \
  || bad PROVIDER_NEUTRAL_SECRET_INJECTION "app fetches secrets via SDK"

present 'process\.(stdout|stderr)' src/logger.ts && absent '@google-cloud/logging|winston-cloudwatch' src \
  && ok PROVIDER_NEUTRAL_LOGGING "structured stdout/stderr; no logging SDK" \
  || bad PROVIDER_NEUTRAL_LOGGING "provider logging SDK in app"

present '/health/live' src/server.ts && present '/health/ready' src/server.ts \
  && ok PROVIDER_NEUTRAL_HEALTH "/health/live + /health/ready present" \
  || bad PROVIDER_NEUTRAL_HEALTH "health endpoints missing"

absent '/cloudsql/|rds\.amazonaws\.com|localhost:5432' src && present 'DATABASE_URL' src/config.ts \
  && ok GENERIC_POSTGRES_COMPATIBILITY "DATABASE_URL-driven; no hardcoded DB host" \
  || bad GENERIC_POSTGRES_COMPATIBILITY "hardcoded DB location in app"

present 'dl.migrate\(\)' src/migrate.ts && [ -f sql/grants.sql ] \
  && ok SAME_AION_DATA_MIGRATIONS "runs aion-data migrate runner + grants" \
  || bad SAME_AION_DATA_MIGRATIONS "migration entrypoint incomplete"

present 'missing required configuration' src/config.ts && present 'must not equal MIGRATION_DATABASE_URL' src/config.ts \
  && ok RUNTIME_CONFIG_VALIDATION "fail-fast config + app/migrator guard" \
  || bad RUNTIME_CONFIG_VALIDATION "config validation missing"

DF=$(find . -name Dockerfile -not -path '*/vendor/*' -not -path '*/node_modules/*' | wc -l | tr -d ' ')
[ "$DF" = "1" ] && ok SINGLE_IMAGE "exactly one Dockerfile" || bad SINGLE_IMAGE "expected one Dockerfile, found $DF"

echo "== $PASS passed, $FAIL failed =="
[ $FAIL -eq 0 ]
