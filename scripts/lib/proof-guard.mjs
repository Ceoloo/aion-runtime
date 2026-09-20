// Fail-closed safety guard for synthetic proof scripts.
// A proof must only ever run against a DISPOSABLE database: it writes realized-revenue
// outcomes and revenue_attributed values that no report can tell apart from real ones.
// Refuses (exit 3) when the target DB already holds any execution/mission/outcome outside
// the proof-only tenants, or when the environment carries live GHL credentials.
// AION_PROOF_DB_DISPOSABLE=1 skips ONLY the database-content check (for CI's shared, ephemeral service DB).
import pg from 'pg';

const PROOF_TENANTS = ['aion-proof-synthetic', 'aion-proof-foreign'];
const refuse = (why) => {
  console.error(`[proof-guard] REFUSING TO RUN: ${why}`);
  console.error('[proof-guard] Synthetic proofs must target a disposable database (e.g. a throwaway postgres container).');
  console.error('[proof-guard] If this database is genuinely ephemeral (CI service container), set AION_PROOF_DB_DISPOSABLE=1 to acknowledge it.');
  process.exit(3);
};

for (const v of ['GHL_API_KEY', 'AION_GHL_API_KEY', 'GHL_LOCATION_ID']) {
  if ((process.env[v] ?? '').trim() && process.env.AION_PROOF_ALLOW_LIVE_GHL !== '1') {
    refuse(`${v} is set — the adapter would switch from the fixture backend to LIVE GHL and write real CRM records.`);
  }
}
if ((process.env.AION_ENVIRONMENT ?? '').toLowerCase() === 'production') refuse('AION_ENVIRONMENT=production');

if (process.env.AION_PROOF_DB_DISPOSABLE === '1') {
  // Explicit operator/CI assertion (e.g. the GitHub Actions service container, which earlier proofs already populate).
  console.error('[proof-guard] AION_PROOF_DB_DISPOSABLE=1 — database-content check skipped; GHL/production checks passed');
  process.exit(0);
}
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) refuse('MIGRATION_DATABASE_URL not set');
const client = new pg.Client({
  connectionString: url,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});
try {
  await client.connect();
  const foreign = {};
  // Ownership is decided per table: executions carry tenant_id; approvals carry NULL tenant_id AND NULL execution_id (in production too), so an
  // approval is "proof-owned" only if an execution sharing its run_id is a proof-tenant execution; missions have no tenant column
  // and the proof creates none, so any mission row means non-proof data.
  const checks = {
    executions: ['SELECT count(*)::int AS n FROM public.executions WHERE tenant_id IS NULL OR tenant_id <> ALL($1)', [PROOF_TENANTS]],
    approvals: [`SELECT count(*)::int AS n FROM public.approvals a WHERE NOT EXISTS (
        SELECT 1 FROM public.executions e WHERE e.run_id = a.run_id AND e.tenant_id = ANY($1))`, [PROOF_TENANTS]],
    missions: ['SELECT count(*)::int AS n FROM public.missions', []],
  };
  for (const [table, [sql, params]] of Object.entries(checks)) {
    const exists = (await client.query('SELECT to_regclass($1) AS r', [`public.${table}`])).rows[0].r;
    if (!exists) continue; // fresh database: nothing there yet
    const n = (await client.query(sql, params)).rows[0].n;
    if (n > 0) foreign[table] = n;
  }
  if (Object.keys(foreign).length) refuse(`target database already holds non-proof data: ${JSON.stringify(foreign)}`);
  console.error('[proof-guard] ok: disposable database (no non-proof rows), no live GHL credentials');
} catch (e) {
  refuse(`could not verify the target database is disposable (${e.code ?? e.message})`);
} finally {
  await client.end().catch(() => {});
}
