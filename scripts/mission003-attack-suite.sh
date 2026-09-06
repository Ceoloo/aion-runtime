#!/usr/bin/env bash
# Mission 003 tenant/domain isolation attack suite.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -d node_modules/@aion/core ]]; then
  AION_SKIP_DEPS_SETUP="${AION_SKIP_DEPS_SETUP:-1}" npm install --no-audit --no-fund
fi

npm run build
node --enable-source-maps dist/mission003-attack-suite.js
