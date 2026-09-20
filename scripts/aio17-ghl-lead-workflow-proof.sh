#!/usr/bin/env bash
# ============================================================================
# aio17-ghl-lead-workflow-proof.sh — AIO-17 first adapter slice evidence.
#
# Runs contract fixtures (payload validation, disabled capabilities, lead
# workflow durability) against the built adapter + fake backend. This is the
# isolated integration proof for the slice; live GHL remains optional via
# proof:ghl-live-acceptance / proof:ghl-live-capability.
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[aio17] build"
npm run build >/dev/null

echo "[aio17] contract fixtures + in-process lead workflow"
node --test dist/adapters/ghl/aio17-contract.fixtures.test.js

echo "[aio17] PASS — AIO-17 lead-workflow adapter fixtures green"
echo "[aio17] note: conversation.read/send + appointment.create remain CAPABILITY_DISABLED"
echo "[aio17] note: OL-001 broader resume still needs remaining caps + model provider"
