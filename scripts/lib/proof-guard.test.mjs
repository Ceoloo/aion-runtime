// Tests for scripts/lib/proof-guard.mjs. Prohibited configurations must be refused (exit 3) BEFORE anything is
// built, migrated, started or sent — every refusal is asserted against a capture server that must see 0 requests.
//   node --test scripts/lib/proof-guard.test.mjs
// DB cases run only when PROOF_GUARD_TEST_PG=postgresql://user:pass@host:port/postgres (superuser) is set.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const GUARD = path.join(here, 'proof-guard.mjs');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const CLEAN = { PATH: process.env.PATH, HOME: process.env.HOME ?? '/tmp' };

let server; let hits = 0; let base;
before(async () => {
  server = http.createServer((_req, res) => { hits += 1; res.end('{}'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const run = (mode, e = {}) => spawnSync(process.execPath, [GUARD, '--mode', mode], { env: { ...CLEAN, ...e }, encoding: 'utf8', timeout: 20000 });
function refused(r, fragment) {
  assert.equal(r.status, 3, `expected refusal, got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /REFUSING TO RUN/);
  if (fragment) assert.match(r.stderr, fragment);
  assert.equal(hits, 0, 'guard must not make any network request');
}

// ---- fake mode ---------------------------------------------------------------------------------------------
test('fake: clean environment is allowed', () => { assert.equal(run('fake').status, 0); });

for (const [k, v] of [['GHL_API_KEY', 'k'], ['AION_GHL_API_KEY', 'k'], ['GHL_LOCATION_ID', 'l'], ['AION_GHL_LOCATION_ID', 'l']]) {
  test(`fake: refuses when ${k} is present (credentials never imply live)`, () => refused(run('fake', { [k]: v, AION_RUNTIME_URL: base }), /credentials never imply live/));
}
test('fake: refuses GHL_API_BASE_URL redirect', () => refused(run('fake', { GHL_API_BASE_URL: base }), /GHL_API_BASE_URL/));
test('fake: refuses GHL_BACKEND=live', () => refused(run('fake', { GHL_BACKEND: 'live' }), /GHL_BACKEND=live/));
test('fake: refuses AION_PROOF_LIVE', () => refused(run('fake', { AION_PROOF_LIVE: '1' }), /AION_PROOF_LIVE/));
test('fake: refuses AION_ENVIRONMENT=production', () => refused(run('fake', { AION_ENVIRONMENT: 'production' }), /production/));
test('fake: refuses a production runtime URL', () => refused(run('fake', { AION_RUNTIME_URL: 'https://runtime.srv1655818.hstgr.cloud' }), /production host/));
test('fake: the obsolete AION_PROOF_ALLOW_LIVE_GHL flag no longer overrides anything', () =>
  refused(run('fake', { GHL_API_KEY: 'k', AION_PROOF_ALLOW_LIVE_GHL: '1' }), /credentials never imply live/));

// ---- live modes --------------------------------------------------------------------------------------------
const LIVE = () => ({
  AION_PROOF_LIVE: '1', GHL_BACKEND: 'live', GHL_API_KEY: 'test-only-key', GHL_LOCATION_ID: 'TESTLOC_0000000000001',
  AION_PROOF_GHL_TEST_LOCATIONS: 'TESTLOC_0000000000001', AION_PROOF_CREDENTIAL_SCOPE: 'test-location',
  GHL_ACCEPTANCE_TENANT: 'aion-test-tenant', GHL_ACCEPTANCE_CONTACT_ID: 'TEST_CONTACT_1', GHL_ACCEPTANCE_OPPORTUNITY_ID: 'TEST_OPP_1',
  GHL_ACCEPTANCE_PRIOR_STAGE: 'TEST_STAGE_A', GHL_ACCEPTANCE_TARGET_STAGE: 'TEST_STAGE_B', AION_RUNTIME_URL: base,
  AION_PRODUCTION_ENV_FILE: '/nonexistent',
});
test('live-capability: a fully explicit, allowlisted test configuration is the ONLY thing allowed', () => {
  const r = run('live-capability', LIVE()); assert.equal(r.status, 0, r.stderr); assert.match(r.stderr, /EXPLICIT LIVE MODE/);
});
const without = (k) => { const e = LIVE(); delete e[k]; return e; };
for (const [k, frag] of [
  ['AION_PROOF_LIVE', /AION_PROOF_LIVE=1/], ['GHL_BACKEND', /GHL_BACKEND=live/], ['GHL_API_KEY', /GHL_API_KEY not set/],
  ['GHL_LOCATION_ID', /GHL_LOCATION_ID not set/], ['AION_PROOF_GHL_TEST_LOCATIONS', /allowlist/], ['AION_PROOF_CREDENTIAL_SCOPE', /acknowledgement missing/],
  ['GHL_ACCEPTANCE_TENANT', /GHL_ACCEPTANCE_TENANT/], ['GHL_ACCEPTANCE_CONTACT_ID', /CONTACT_ID/], ['GHL_ACCEPTANCE_OPPORTUNITY_ID', /OPPORTUNITY_ID/],
  ['GHL_ACCEPTANCE_PRIOR_STAGE', /PRIOR_STAGE/], ['GHL_ACCEPTANCE_TARGET_STAGE', /TARGET_STAGE/], ['AION_RUNTIME_URL', /AION_RUNTIME_URL must be set/],
]) test(`live-capability: refuses when ${k} is missing`, () => refused(run('live-capability', without(k)), frag));

test('live: refuses a location that is not on the allowlist', () => refused(run('live-capability', { ...LIVE(), AION_PROOF_GHL_TEST_LOCATIONS: 'OTHER_LOCATION' }), /not in AION_PROOF_GHL_TEST_LOCATIONS/));
test('live: refuses a known PRODUCTION location even if allowlisted (additive deny hash)', () =>
  refused(run('live-capability', { ...LIVE(), AION_PRODUCTION_GHL_LOCATION_SHA256: sha('TESTLOC_0000000000001') }), /PRODUCTION location/));
test('live: refuses a known PRODUCTION record id', () =>
  refused(run('live-capability', { ...LIVE(), AION_PRODUCTION_GHL_RECORD_SHA256: sha('TEST_OPP_1') }), /PRODUCTION record id/));
test('live: refuses production tenant aion-systems', () => refused(run('live-capability', { ...LIVE(), GHL_ACCEPTANCE_TENANT: 'aion-systems' }), /production tenant/));
test('live: refuses a production runtime host', () => refused(run('live-capability', { ...LIVE(), AION_RUNTIME_URL: 'https://runtime.srv1655818.hstgr.cloud' }), /production host/));
test('live: refuses the production copilot host', () => refused(run('live-capability', { ...LIVE(), AION_RUNTIME_URL: 'https://copilot.runtime.srv1655818.hstgr.cloud' }), /production host/));
test('live: refuses a non-loopback runtime that is not allowlisted', () => refused(run('live-capability', { ...LIVE(), AION_RUNTIME_URL: 'https://example.invalid' }), /loopback or listed/));
test('live: refuses GHL_API_BASE_URL', () => refused(run('live-capability', { ...LIVE(), GHL_API_BASE_URL: base }), /GHL_API_BASE_URL/));
test('live: refuses ambiguous credential aliases', () => refused(run('live-capability', { ...LIVE(), AION_GHL_API_KEY: 'different' }), /disagree/));
test('live: the obsolete AION_PROOF_ALLOW_LIVE_GHL flag is not a substitute for explicit live mode', () =>
  refused(run('live-capability', { ...without('AION_PROOF_LIVE'), AION_PROOF_ALLOW_LIVE_GHL: '1' }), /AION_PROOF_LIVE=1/));
test('live: refuses credentials identical to the production env file on this host', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pg-')), 'env'); fs.writeFileSync(f, 'GHL_API_KEY=test-only-key\nGHL_LOCATION_ID=someone-else\n');
  refused(run('live-capability', { ...LIVE(), AION_PRODUCTION_ENV_FILE: f }), /equals the production credential/);
});
test('live-acceptance uses the same requirements', () => refused(run('live-acceptance', without('AION_PROOF_CREDENTIAL_SCOPE')), /acknowledgement missing/));
test('live-aio17 is refused unconditionally, even with a fully valid live configuration', () => refused(run('live-aio17', LIVE()), /BLOCKED/));
test('unknown mode is refused', () => refused(run('sandbox'), /unknown mode/));

// ---- every proof script is guarded, and refuses before doing anything -----------------------------------------
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const shFiles = fs.readdirSync(path.join(root, 'scripts')).filter((f) => f.endsWith('.sh'));
test('structural: every proof:* npm script is routed through the guard', () => {
  for (const [name, cmd] of Object.entries(pkg.scripts).filter(([n]) => n.startsWith('proof:'))) {
    const m = /bash (scripts\/[\w.-]+\.sh)/.exec(cmd);
    const guarded = m ? fs.readFileSync(path.join(root, m[1]), 'utf8').includes('lib/proof-env.sh') : cmd.includes('proof-guard.mjs');
    assert.ok(guarded, `${name} is not guarded: ${cmd}`);
  }
});
test('structural: live proofs verify credential ISOLATION (not just an attestation)', () => {
  assert.match(pkg.scripts['proof:ghl-live-capability'], /proof-credential-scope\.mjs/);
  assert.match(fs.readFileSync(path.join(here, 'proof-env.sh'), 'utf8'), /live-\*\) node .*proof-credential-scope\.mjs/);
});
test('structural: every script that starts a runtime, or is named proof/acceptance/certification, sources the prelude', () => {
  for (const f of shFiles) {
    const s = fs.readFileSync(path.join(root, 'scripts', f), 'utf8');
    if (/node dist\/index\.js/.test(s) || /proof|acceptance|attack-suite|certification/.test(f)) {
      if (['image-boot-check.sh', 'portability-check.sh'].includes(f)) continue;
      assert.ok(s.includes('lib/proof-env.sh'), `${f} does not source lib/proof-env.sh`);
    }
  }
});
test('structural: no proof source contains a production default (tenant, runtime URL)', () => {
  for (const f of ['src/ghl-live-capability-proof.ts', 'src/ghl-live-acceptance.ts', 'src/revenue-workflow-durable-proof-matrix.ts']) {
    const s = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(!/'aion-systems'/.test(s) && !/srv1655818/.test(s), `${f} still contains a production default`);
  }
});
for (const f of shFiles.filter((x) => /proof|acceptance|attack-suite|certification/.test(x))) {
  test(`script ${f}: with GHL credentials present it refuses in the guard, before build/migrate/start, with 0 requests`, () => {
    const r = spawnSync('bash', [path.join(root, 'scripts', f)], { env: { ...CLEAN, GHL_API_KEY: 'k', GHL_LOCATION_ID: 'l', AION_RUNTIME_URL: base, GHL_API_BASE_URL: base }, encoding: 'utf8', timeout: 30000, cwd: os.tmpdir() });
    assert.equal(r.status, 3, `${f}: ${r.stdout}${r.stderr}`);
    assert.doesNotMatch(r.stdout + r.stderr, /\[[a-z0-9-]+\] (build|migrate|start)/i);
    assert.equal(hits, 0);
  });
}
test('npm proof:ghl-live-capability refuses (guard runs first) with credentials but no explicit live mode', () => {
  const r = spawnSync('npm', ['run', '--silent', 'proof:ghl-live-capability'], { cwd: root, env: { ...CLEAN, GHL_API_KEY: 'k', GHL_LOCATION_ID: 'l' }, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 3); assert.match(r.stderr, /AION_PROOF_LIVE=1/); assert.equal(hits, 0);
});

// ---- database protections (need a Postgres) --------------------------------------------------------------------
const ADMIN = process.env.PROOF_GUARD_TEST_PG;
const dbTest = ADMIN ? test : test.skip;
const dbUrl = (name) => { const u = new URL(ADMIN); u.pathname = `/${name}`; return u.toString(); };
const seeds = {
  pg_guard_fresh: [],
  pg_guard_foreign: ['CREATE TABLE public.missions(mission_id text, metadata jsonb)', `INSERT INTO public.missions VALUES ('m1','{"cohort":"x"}')`],
  pg_guard_prod_schema: ['CREATE SCHEMA ol_metrics'],
  pg_guard_prod_mission: ['CREATE TABLE public.missions(mission_id text, metadata jsonb)', `INSERT INTO public.missions VALUES ('m1','{"productionEconomic":"true"}')`],
};
before(async () => {
  if (!ADMIN) return;
  const { default: pg } = await import('pg');
  const admin = new pg.Client({ connectionString: ADMIN }); await admin.connect();
  for (const [name, stmts] of Object.entries(seeds)) {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.query(`CREATE DATABASE ${name}`);
    const c = new pg.Client({ connectionString: dbUrl(name) }); await c.connect(); for (const s of stmts) await c.query(s); await c.end();
  }
  await admin.end();
});
const dbRun = (name, e = {}) => run('fake', { MIGRATION_DATABASE_URL: dbUrl(name), DATABASE_SSL: 'false', AION_RUNTIME_URL: base, ...e });
dbTest('db: a fresh disposable database is allowed', () => assert.equal(dbRun('pg_guard_fresh').status, 0));
dbTest('db: non-proof data is refused', () => refused(dbRun('pg_guard_foreign'), /non-proof data/));
dbTest('db: the CI opt-out is ignored outside GitHub Actions', () => refused(dbRun('pg_guard_foreign', { AION_PROOF_DB_DISPOSABLE: '1' }), /non-proof data/));
dbTest('db: the CI opt-out is honored inside GitHub Actions for ordinary non-proof data', () => assert.equal(dbRun('pg_guard_foreign', { AION_PROOF_DB_DISPOSABLE: '1', GITHUB_ACTIONS: 'true' }).status, 0));
dbTest('db: the CI opt-out can NEVER bypass a production schema marker', () => refused(dbRun('pg_guard_prod_schema', { AION_PROOF_DB_DISPOSABLE: '1', GITHUB_ACTIONS: 'true' }), /PRODUCTION markers.*ol_metrics/));
dbTest('db: the CI opt-out can NEVER bypass a production-economic mission', () => refused(dbRun('pg_guard_prod_mission', { AION_PROOF_DB_DISPOSABLE: '1', GITHUB_ACTIONS: 'true' }), /PRODUCTION markers.*production-economic/));
dbTest('db: an unreachable database fails closed', () => refused(run('fake', { MIGRATION_DATABASE_URL: 'postgresql://x:y@127.0.0.1:1/z', DATABASE_SSL: 'false' }), /failing closed/));
