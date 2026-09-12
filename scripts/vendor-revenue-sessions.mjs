#!/usr/bin/env node
/**
 * Bridge: land revenue_sessions onto the EO-lineage aion-data vendor pin.
 *
 * aion-data main shipped revenue_sessions as migration 0009 (#19), while the
 * Runtime EO pin already used 0009/0010 for ImplementationCase. Until Data
 * merges that API onto the EO tip as 0011+, Runtime overlays the canonical
 * repository + migration here so the Execution Gateway can expose
 * /v1/revenue-sessions without forking product contracts.
 *
 * Source of truth for the repository code remains aion-data.
 * Idempotent. No-op when the vendor tree already exposes revenueSessions.
 */
import { execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const DATA_REPO = process.env.AION_DATA_REPO ?? 'https://github.com/Ceoloo/aion-data';
/** Merged aion-data#19 — revenue_sessions persistence on main. */
const DEFAULT_REVENUE_REF = 'b8a71ce';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(root, 'vendor', 'aion-data');

function run(cmd, cwd) {
  console.log(`[vendor-revenue-sessions] $ ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

function resolveRevenueRef() {
  if (process.env.AION_REVENUE_SESSIONS_REF) {
    return process.env.AION_REVENUE_SESSIONS_REF;
  }
  const sibling = '/agent/repos/aion-data';
  if (existsSync(resolve(sibling, '.git'))) {
    try {
      return execSync(`git rev-parse ${DEFAULT_REVENUE_REF}`, {
        cwd: sibling,
        encoding: 'utf8',
      }).trim();
    } catch {
      return execSync('git rev-parse origin/main', {
        cwd: sibling,
        encoding: 'utf8',
      }).trim();
    }
  }
  return DEFAULT_REVENUE_REF;
}

function main() {
  if (!existsSync(dataDir)) {
    throw new Error(`vendor/aion-data missing at ${dataDir}`);
  }

  const dataLayerPath = resolve(dataDir, 'src/data-layer.ts');
  const dataLayerSrc = readFileSync(dataLayerPath, 'utf8');
  if (dataLayerSrc.includes('revenueSessions')) {
    console.log('[vendor-revenue-sessions] already wired — skipping.');
    return;
  }

  const revenueRef = resolveRevenueRef();
  const scratch = resolve(tmpdir(), `aion-data-revenue-${process.pid}`);
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  try {
    run(`git clone --quiet ${DATA_REPO} "${scratch}"`, tmpdir());
    run(`git checkout --quiet ${revenueRef}`, scratch);

    const repoSrc = readFileSync(
      resolve(scratch, 'src/repositories/postgres-revenue-session-repository.ts'),
      'utf8',
    );
    const migrationSrc = readFileSync(
      resolve(scratch, 'migrations/0009_revenue_sessions.sql'),
      'utf8',
    );

    writeFileSync(
      resolve(dataDir, 'src/repositories/postgres-revenue-session-repository.ts'),
      repoSrc,
    );
    writeFileSync(
      resolve(dataDir, 'migrations/0011_revenue_sessions.sql'),
      `-- Overlay: revenue_sessions as 0011 on EO pin (main shipped as 0009 / aion-data#19).\n` +
        migrationSrc,
    );

    let next = dataLayerSrc;
    if (!next.includes('postgres-revenue-session-repository')) {
      next = next.replace(
        "import { PostgresImplementationCaseRepository } from './repositories/postgres-implementation-case-repository.js';\n",
        "import { PostgresImplementationCaseRepository } from './repositories/postgres-implementation-case-repository.js';\n" +
          "import { PostgresRevenueSessionRepository } from './repositories/postgres-revenue-session-repository.js';\n",
      );
    }
    next = next.replace(
      "  /** IE-001 — ImplementationCase delivery records. */\n  implementationCases: PostgresImplementationCaseRepository;\n}",
      "  /** IE-001 — ImplementationCase delivery records. */\n  implementationCases: PostgresImplementationCaseRepository;\n" +
        "  /** Revenue Copilot — opaque versioned session checkpoints. */\n" +
        "  revenueSessions: PostgresRevenueSessionRepository;\n}",
    );
    next = next.replace(
      "    implementationCases: new PostgresImplementationCaseRepository(db),\n  };",
      "    implementationCases: new PostgresImplementationCaseRepository(db),\n" +
        "    revenueSessions: new PostgresRevenueSessionRepository(db),\n  };",
    );
    writeFileSync(dataLayerPath, next);

    const indexPath = resolve(dataDir, 'src/index.ts');
    let indexSrc = readFileSync(indexPath, 'utf8');
    if (!indexSrc.includes('PostgresRevenueSessionRepository')) {
      indexSrc = indexSrc.replace(
        "export { PostgresServiceRepository } from './repositories/postgres-service-repository.js';\n",
        "export { PostgresServiceRepository } from './repositories/postgres-service-repository.js';\n" +
          "export { PostgresRevenueSessionRepository, type RevenueSessionRow } from './repositories/postgres-revenue-session-repository.js';\n",
      );
      writeFileSync(indexPath, indexSrc);
    }

    console.log(
      `[vendor-revenue-sessions] overlaid revenue_sessions from ${revenueRef} as migration 0011.`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main();
