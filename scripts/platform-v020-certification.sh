#!/usr/bin/env bash
# ============================================================================
# platform-v020-certification.sh — final post-M009 gate for execution-platform-v0.2.0
# Runs M001–M009 proofs + platform-v01 multi-domain cert against this tip.
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

: "${MIGRATION_DATABASE_URL:?}"
: "${DATABASE_URL:?}"

echo "[cert-v020] tip $(git rev-parse HEAD)"
echo "[cert-v020] begin M001–M009 + certify:platform-v01"

RESULTS=()
run_gate() {
  local name="$1"
  shift
  echo "[cert-v020] >>> $name"
  if "$@"; then
    RESULTS+=("$name=PASS")
    echo "[cert-v020] <<< $name PASS"
  else
    RESULTS+=("$name=FAIL")
    echo "[cert-v020] <<< $name FAIL"
    printf '%s\n' "${RESULTS[@]}"
    exit 1
  fi
}

run_gate M001 npm run proof:mission001
run_gate M002 npm run proof:mission002
run_gate M003 npm run proof:mission003
run_gate M004 npm run proof:mission004
run_gate M005 npm run proof:mission005
run_gate M006 npm run proof:mission006
run_gate M007 npm run proof:mission007
run_gate M008 npm run proof:mission008
run_gate M009 npm run proof:mission009
run_gate PLATFORM-V01 npm run certify:platform-v01

echo "[cert-v020] PASS — all gates green"
printf '%s\n' "${RESULTS[@]}"
