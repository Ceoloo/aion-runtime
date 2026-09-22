#!/usr/bin/env node
// Fail-closed safety guard for every proof / acceptance script.
//
//   node scripts/lib/proof-guard.mjs --mode fake|live-capability|live-acceptance|live-aio17
//
// Exit 0 = allowed, exit 3 = refused. It runs FIRST — before any build, migration, runtime start or network call —
// and itself makes no network request (only, when a DB URL is given, read-only SELECTs against that database).
//
// Principles
//  * Proofs default to the FAKE GHL backend. Credentials being present NEVER selects live mode.
//  * Live mode needs ALL of: AION_PROOF_LIVE=1, GHL_BACKEND=live, an allowlisted TEST location, a test-scope
//    attestation, an explicit non-production tenant / record ids / target runtime — and none may match a known
//    production identifier (stored only as SHA-256 in production-ids.json).
//  * Production-target protections (env, ids, DB production markers) cannot be skipped by any flag.
//  * The only opt-out (AION_PROOF_DB_DISPOSABLE=1) skips just the "DB already has non-proof rows" check, and is
//    honored only inside GitHub Actions (GITHUB_ACTIONS=true); it never skips production markers.
//  * live-aio17 is refused unconditionally: live AIO-17 execution is blocked pending explicit authorization.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROD = JSON.parse(readFileSync(path.join(here, 'production-ids.json'), 'utf8'));
const PROOF_TENANTS = ['aion-proof-synthetic', 'aion-proof-foreign'];
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const env = process.env;
const val = (k) => (env[k] ?? '').trim();

const mode = process.argv.includes('--mode') ? process.argv[process.argv.indexOf('--mode') + 1] : 'fake';
const problems = [];
const bad = (why) => problems.push(why);
const finish = () => {
  if (problems.length) {
    console.error(`[proof-guard] REFUSING TO RUN (mode=${mode}):`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error('[proof-guard] Nothing was built, migrated, started or sent.');
    process.exit(3);
  }
};

if (!['fake', 'live-capability', 'live-acceptance', 'live-aio17'].includes(mode)) {
  bad(`unknown mode "${mode}"`);
  finish();
}
if (mode === 'live-aio17') {
  bad('live AIO-17 execution is BLOCKED: no authorized test tenant exists and the live backend cannot delete what it creates');
  finish();
}

// ---- always-on production-target protections (no flag can skip these) ---------------------------------------
if (val('AION_ENVIRONMENT').toLowerCase() === 'production') bad('AION_ENVIRONMENT=production');
if (val('AION_PROOF_ALLOW_LIVE_GHL')) console.error('[proof-guard] note: AION_PROOF_ALLOW_LIVE_GHL is obsolete and has no effect');

const runtimeUrl = val('AION_RUNTIME_URL');
let runtimeHost = '';
if (runtimeUrl) {
  try { runtimeHost = new URL(runtimeUrl).hostname; } catch { bad('AION_RUNTIME_URL is not a valid URL'); }
  if (PROD.runtimeHosts.includes(runtimeHost)) bad(`AION_RUNTIME_URL targets a production host (${runtimeHost})`);
}

const CRED_VARS = ['GHL_API_KEY', 'AION_GHL_API_KEY', 'GHL_LOCATION_ID', 'AION_GHL_LOCATION_ID'];
const prodTenants = [...PROD.tenants, ...val('AION_PRODUCTION_TENANTS').split(',').map((s) => s.trim()).filter(Boolean)];

if (mode === 'fake') {
  for (const v of CRED_VARS) if (val(v)) bad(`${v} is set — fake-backend proofs must run with no GHL credentials (credentials never imply live)`);
  if (val('GHL_API_BASE_URL')) bad('GHL_API_BASE_URL is set — fake-backend proofs must not redirect the GHL endpoint');
  if (val('GHL_BACKEND') && val('GHL_BACKEND').toLowerCase() !== 'fake') bad(`GHL_BACKEND=${val('GHL_BACKEND')} — fake-backend proofs may only run with GHL_BACKEND unset or "fake"`);
  if (val('AION_PROOF_LIVE')) bad('AION_PROOF_LIVE is set in a fake-backend proof');
} else {
  // ---- explicit live mode: every condition is mandatory ------------------------------------------------------
  if (val('AION_PROOF_LIVE') !== '1') bad('live mode requires AION_PROOF_LIVE=1');
  if (val('GHL_BACKEND').toLowerCase() !== 'live') bad('live mode requires GHL_BACKEND=live (selection is never inferred from credentials)');
  for (const [a, b] of [['GHL_API_KEY', 'AION_GHL_API_KEY'], ['GHL_LOCATION_ID', 'AION_GHL_LOCATION_ID']]) {
    if (val(b) && val(a) && val(a) !== val(b)) bad(`${a} and ${b} disagree — ambiguous credentials`);
  }
  const loc = val('GHL_LOCATION_ID') || val('AION_GHL_LOCATION_ID');
  const key = val('GHL_API_KEY') || val('AION_GHL_API_KEY');
  if (!key) bad('GHL_API_KEY not set');
  if (!loc) bad('GHL_LOCATION_ID not set');
  if (val('GHL_API_BASE_URL')) bad('GHL_API_BASE_URL must be unset in live mode');

  const allow = val('AION_PROOF_GHL_TEST_LOCATIONS').split(',').map((s) => s.trim()).filter(Boolean);
  if (!allow.length) bad('AION_PROOF_GHL_TEST_LOCATIONS (allowlist of TEST location ids) is empty');
  if (loc && allow.length && !allow.includes(loc)) bad('the target location is not in AION_PROOF_GHL_TEST_LOCATIONS');
  // AION_PRODUCTION_*_SHA256 can only ADD denied hashes to the repo list; nothing can remove one.
  const extra = (k) => val(k).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const prodLoc = new Set([...PROD.sha256.ghlLocationIds, ...extra('AION_PRODUCTION_GHL_LOCATION_SHA256')]);
  if (loc && prodLoc.has(sha(loc))) bad('the target location is a known PRODUCTION location');
  if (allow.some((a) => prodLoc.has(sha(a)))) bad('AION_PROOF_GHL_TEST_LOCATIONS contains a known PRODUCTION location');
  // The attestation is a NECESSARY acknowledgement, never proof of isolation: proof-credential-scope.mjs then verifies
  // isolation behaviourally with read-only probes (own location reachable; random/agency/production locations denied).
  if (val('AION_PROOF_CREDENTIAL_SCOPE') !== 'test-location') bad('AION_PROOF_CREDENTIAL_SCOPE=test-location acknowledgement missing (necessary, not sufficient: isolation is then verified against the live API)');

  // On a host that has the production env file, the provided credentials must differ from production's.
  try {
    const prodEnv = readFileSync(val('AION_PRODUCTION_ENV_FILE') || '/opt/aion/.env', 'utf8');
    for (const line of prodEnv.split('\n')) {
      const i = line.indexOf('=');
      if (i < 1) continue;
      const k = line.slice(0, i).trim(); const v = line.slice(i + 1).trim();
      if (k === 'GHL_API_KEY' && key && v && sha(v) === sha(key)) bad('GHL_API_KEY equals the production credential on this host');
      if (k === 'GHL_LOCATION_ID' && loc && v && v === loc) bad('GHL_LOCATION_ID equals the production location on this host');
    }
  } catch { /* no production env file here — nothing to compare */ }

  const tenant = val('GHL_ACCEPTANCE_TENANT');
  if (!tenant) bad('GHL_ACCEPTANCE_TENANT must be set explicitly (no default)');
  else if (prodTenants.includes(tenant)) bad(`tenant "${tenant}" is a production tenant`);

  const prodRec = new Set([...PROD.sha256.ghlRecordIds, ...extra('AION_PRODUCTION_GHL_RECORD_SHA256')]);
  for (const k of ['GHL_ACCEPTANCE_CONTACT_ID', 'GHL_ACCEPTANCE_OPPORTUNITY_ID', 'GHL_ACCEPTANCE_PRIOR_STAGE', 'GHL_ACCEPTANCE_TARGET_STAGE']) {
    if (!val(k)) bad(`${k} must be set explicitly (no default)`);
    else if (prodRec.has(sha(val(k)))) bad(`${k} is a known PRODUCTION record id`);
  }
  if (mode === 'live-capability') {
    if (!runtimeUrl) bad('AION_RUNTIME_URL must be set explicitly (no default)');
    else {
      const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(runtimeHost);
      const okHosts = val('AION_PROOF_RUNTIME_ALLOWLIST').split(',').map((s) => s.trim()).filter(Boolean);
      if (!loopback && !okHosts.includes(runtimeHost)) bad('AION_RUNTIME_URL must be loopback or listed in AION_PROOF_RUNTIME_ALLOWLIST');
    }
  }
}

// ---- database protections (any DB URL provided) -----------------------------------------------------------------
const urls = [...new Set([val('MIGRATION_DATABASE_URL'), val('DATABASE_URL')].filter(Boolean))];
if (urls.length) {
  const { default: pg } = await import('pg');
  const ciAttested = val('AION_PROOF_DB_DISPOSABLE') === '1' && env.GITHUB_ACTIONS === 'true';
  if (val('AION_PROOF_DB_DISPOSABLE') === '1' && !ciAttested) {
    console.error('[proof-guard] note: AION_PROOF_DB_DISPOSABLE=1 ignored — honored only inside GitHub Actions');
  }
  for (const url of urls) {
    const client = new pg.Client({ connectionString: url, ssl: val('DATABASE_SSL') === 'false' ? false : { rejectUnauthorized: false } });
    try {
      await client.connect();
      const has = async (t) => (await client.query('SELECT to_regclass($1) AS r', [`public.${t}`])).rows[0].r !== null;
      // (1) production markers — never skippable
      const marks = [];
      if ((await client.query("SELECT 1 FROM pg_namespace WHERE nspname = 'ol_metrics'")).rowCount) marks.push('schema ol_metrics');
      if (await has('missions')) {
        const m = (await client.query(`SELECT count(*)::int AS n FROM public.missions WHERE metadata->>'productionEconomic' = 'true' OR metadata->>'launchMode' = 'ol001_production'`)).rows[0].n;
        if (m > 0) marks.push(`${m} production-economic mission(s)`);
      }
      if (marks.length) bad(`a target database carries PRODUCTION markers (${marks.join(', ')}) — this flag cannot be bypassed`);
      // (2) non-proof content — skippable only by the CI attestation
      if (!ciAttested) {
        const foreign = {};
        const checks = {
          executions: ['SELECT count(*)::int AS n FROM public.executions WHERE tenant_id IS NULL OR tenant_id <> ALL($1)', [PROOF_TENANTS]],
          approvals: [`SELECT count(*)::int AS n FROM public.approvals a WHERE NOT EXISTS (SELECT 1 FROM public.executions e WHERE e.run_id = a.run_id AND e.tenant_id = ANY($1))`, [PROOF_TENANTS]],
          missions: ['SELECT count(*)::int AS n FROM public.missions', []],
        };
        for (const [t, [sql, params]] of Object.entries(checks)) {
          if (!(await has(t))) continue;
          const n = (await client.query(sql, params)).rows[0].n;
          if (n > 0) foreign[t] = n;
        }
        if (Object.keys(foreign).length) bad(`a target database already holds non-proof data ${JSON.stringify(foreign)} — use a disposable database`);
      }
    } catch (e) {
      bad(`could not verify a target database is disposable (${e.code ?? e.message}) — failing closed`);
    } finally {
      await client.end().catch(() => {});
    }
  }
}

finish();
if (mode === 'fake') console.error('[proof-guard] ok: fake backend, no GHL credentials, no production markers');
else console.error('[proof-guard] ok: EXPLICIT LIVE MODE against an allowlisted test location — live writes are enabled');
