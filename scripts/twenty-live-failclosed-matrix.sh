#!/usr/bin/env bash
# ============================================================================
# twenty-live-failclosed-matrix.sh — fail-closed Gate C matrix (no secrets in CI).
#
# Default invocation (no live env) must exit 3 in the proof-guard before build.
# Full disposable live proof: scripts/twenty-live-acceptance.sh with operator env.
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[twenty-matrix] CASE 1: refuse without AION_PROOF_LIVE (expect exit 3)"
if bash scripts/twenty-live-acceptance.sh; then
  echo "[twenty-matrix] FAIL: harness ran without live attestation"
  exit 1
else
  status=$?
  if [ "$status" != 3 ]; then
    echo "[twenty-matrix] FAIL: expected guard exit 3, got ${status}"
    exit 1
  fi
  echo "[twenty-matrix] PASS: refused without live env (exit 3)"
fi

echo "[twenty-matrix] CASE 2: refuse with partial Twenty env but no AION_PROOF_LIVE"
if env \
  CRM_PROVIDER=twenty \
  TWENTY_BACKEND=live \
  TWENTY_API_BASE_URL=http://127.0.0.1:3999 \
  TWENTY_API_KEY=staging-only-not-for-ci \
  TWENTY_ACCEPTANCE_TENANT=aion-proof-synthetic \
  AION_PROOF_CREDENTIAL_SCOPE=disposable-twenty \
  AION_RUNTIME_URL=http://127.0.0.1:8107 \
  bash scripts/twenty-live-acceptance.sh; then
  echo "[twenty-matrix] FAIL: harness ran without AION_PROOF_LIVE=1"
  exit 1
else
  status=$?
  if [ "$status" != 3 ]; then
    echo "[twenty-matrix] FAIL: expected guard exit 3, got ${status}"
    exit 1
  fi
  echo "[twenty-matrix] PASS: refused without AION_PROOF_LIVE=1 (exit 3)"
fi

echo "[twenty-matrix] ALL FAIL-CLOSED CASES PASS — live disposable proof remains operator-gated"
echo "[twenty-matrix] Cross-tenant: two-process OR TWENTY_API_KEY_B (docs/twenty-live-acceptance.md)"
