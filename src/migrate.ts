/**
 * Migration entrypoint — run by the migration JOB/one-off task (aion-infra §18),
 * a separate execution from the long-running runtime, NEVER by the runtime
 * itself. Each provider profile wires this entrypoint to its own one-off
 * execution primitive (see the providers directory); the code names no provider.
 *
 * It applies aion-data's authoritative migration runner (no second migration
 * system is invented here — §18) using the MIGRATION identity's credential
 * (MIGRATION_DATABASE_URL), then exits. A migration FAILURE exits non-zero so
 * the deployment pipeline halts before the runtime is deployed and the previous
 * runtime is left intact (§46, §63).
 *
 * After schema migrations, it applies the aion-infra privilege grants
 * (sql/grants.sql shipped in the image) through the same migration identity, so
 * the two-role least-privilege model is enforced (aion-data/docs/security.md).
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import { createDataLayer } from '@aion/data';

const { Pool } = pg;

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value || value.trim() === '') {
    process.stderr.write(
      `${JSON.stringify({ level: 'error', message: 'config_invalid', reason: `missing ${key}` })}\n`,
    );
    process.exit(1);
  }
  return value as string;
}

function log(level: string, message: string, fields: Record<string, unknown> = {}): void {
  const sink = level === 'error' ? process.stderr : process.stdout;
  sink.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level, service: 'aion-migrate', message, ...fields })}\n`);
}

async function main(): Promise<void> {
  const migrationUrl = requireEnv('MIGRATION_DATABASE_URL');
  const useSsl = (process.env.DATABASE_SSL ?? 'true') === 'true';

  // ── 1. Apply aion-data's canonical migrations (authoritative) ────────────
  const dl = createDataLayer({
    connectionString: migrationUrl,
    applicationName: 'aion-migrate',
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
  });

  try {
    log('info', 'applying_migrations');
    const results = await dl.migrate();
    const applied = results.filter((r) => r.status === 'applied').length;
    log('info', 'migrations_complete', { applied, total: results.length });
  } catch (err) {
    // A failed migration must STOP the pipeline (§63) — never continue.
    log('error', 'migration_failed', { error: err instanceof Error ? err.message : 'unknown' });
    await dl.close();
    process.exit(1);
    return;
  } finally {
    await dl.close();
  }

  // ── 2. Apply aion-infra privilege grants (least privilege) ───────────────
  const grantsPath = resolve(dirname(fileURLToPath(import.meta.url)), 'sql', 'grants.sql');
  let grantsSql: string;
  try {
    grantsSql = await readFile(grantsPath, 'utf8');
  } catch {
    log('warn', 'grants_sql_missing', { path: grantsPath });
    return;
  }

  const pool = new Pool({
    connectionString: migrationUrl,
    application_name: 'aion-migrate-grants',
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
  });
  try {
    log('info', 'applying_grants');
    await pool.query(grantsSql);
    log('info', 'grants_complete');
  } catch (err) {
    log('error', 'grants_failed', { error: err instanceof Error ? err.message : 'unknown' });
    await pool.end();
    process.exit(1);
    return;
  } finally {
    await pool.end();
  }
}

void main();
