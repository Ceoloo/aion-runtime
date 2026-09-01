#!/usr/bin/env node
/**
 * Vendor the AION workload the reference host runs on.
 *
 * The reference runtime builds against the REAL @aion/core and @aion/data
 * packages (not copies), exactly as aion-data builds against the real @aion/core
 * (aion-data/scripts/setup-core.mjs; aion-docs dependency-rules #4 — canonical
 * contracts are never forked). Neither package is published to a registry, so we
 * vendor them: clone the pinned commits, build, and link via file: deps.
 *
 * aion-core is pinned to the SAME commit aion-data pins (kept in sync), so the
 * runtime, Data, and Core all agree on one contract surface.
 *
 * Idempotent. Skip with AION_SKIP_DEPS_SETUP=1 when vendor/ is pre-provisioned.
 */
import { execSync } from 'node:child_process';
import { existsSync, rmSync, cpSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE_REPO = process.env.AION_CORE_REPO ?? 'https://github.com/Ceoloo/aion-core';
const DATA_REPO = process.env.AION_DATA_REPO ?? 'https://github.com/Ceoloo/aion-data';
// aion-core commit — kept in sync with aion-data/scripts/setup-core.mjs.
const CORE_REF = process.env.AION_CORE_REF ?? '5ea731a67b4ad40575cbf0e5893f665c8d02ea8c';
const DATA_REF = process.env.AION_DATA_REF ?? 'main';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = resolve(root, 'vendor');

function run(cmd, cwd) {
  console.log(`[setup-deps] $ ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

function main() {
  if (process.env.AION_SKIP_DEPS_SETUP) {
    console.log('[setup-deps] AION_SKIP_DEPS_SETUP set — skipping.');
    return;
  }

  mkdirSync(vendor, { recursive: true });
  const coreDir = resolve(vendor, 'aion-core');
  const dataDir = resolve(vendor, 'aion-data');

  // ── aion-core ──────────────────────────────────────────────────────────
  if (!existsSync(resolve(coreDir, 'dist', 'index.js'))) {
    rmSync(coreDir, { recursive: true, force: true });
    run(`git clone --quiet ${CORE_REPO} "${coreDir}"`, vendor);
    run(`git checkout --quiet ${CORE_REF}`, coreDir);
    run('npm install --no-audit --no-fund --loglevel=error', coreDir);
    run('npm run build', coreDir);
  }

  // ── aion-data (needs core vendored into ITS vendor dir) ──────────────────
  if (!existsSync(resolve(dataDir, 'dist', 'index.js'))) {
    rmSync(dataDir, { recursive: true, force: true });
    run(`git clone --quiet ${DATA_REPO} "${dataDir}"`, vendor);
    run(`git checkout --quiet ${DATA_REF}`, dataDir);
    // Reuse the already-built core so data links the same contract build.
    mkdirSync(resolve(dataDir, 'vendor'), { recursive: true });
    cpSync(coreDir, resolve(dataDir, 'vendor', 'aion-core'), { recursive: true });
    run('AION_SKIP_CORE_SETUP=1 npm install --no-audit --no-fund --loglevel=error', dataDir);
    run('npm run build', dataDir);
  }

  console.log('[setup-deps] vendor/aion-core + vendor/aion-data ready.');
}

main();
