// A token attestation is a claim; these tests prove the verifier demands EVIDENCE of isolation and fails closed.
//   node --test scripts/lib/proof-credential-scope.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyCredentialScope, GHL_BASE_URL } from './proof-credential-scope.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OWN = 'TESTLOC_OWN_0000001', PROD = 'PRODLOC_SYNTHETIC_01', PROD2 = 'PRODLOC_SYNTHETIC_02';
const base = { apiKey: 'test-only-key', locationId: OWN, productionLocationIds: [PROD] };

/** Mock GHL: `rules` maps a URL fragment -> status (or a function). Records every call. */
const mock = (rules, calls = []) => async (url, init) => {
  calls.push({ url, auth: init?.headers?.authorization ? 'present' : 'absent', method: init?.method });
  for (const [frag, v] of Object.entries(rules)) if (url.includes(frag)) { if (v === 'throw') throw new Error('boom'); return { status: typeof v === 'function' ? v(url) : v }; }
  return { status: 404 };
};
const HEALTHY = { [`locationId=${OWN}`]: 200, [`locationId=${PROD}`]: 403, [`locationId=${PROD2}`]: 403, '/locations/search': 403, 'locationId=': 403 };
const fails = (r) => r.checks.filter((c) => !c.ok).map((c) => c.name);

test('a location-scoped token (own 200; random, agency, production denied) is accepted', async () => {
  const r = await verifyCredentialScope({ ...base, fetchImpl: mock(HEALTHY) });
  assert.equal(r.ok, true, JSON.stringify(r.checks));
  assert.equal(r.checks.length, 4);
});
test('every probe is a read-only GET to the fixed GHL host with the bearer token', async () => {
  const calls = []; await verifyCredentialScope({ ...base, fetchImpl: mock(HEALTHY, calls) });
  assert.ok(calls.every((c) => c.method === 'GET' && c.url.startsWith(GHL_BASE_URL) && c.auth === 'present'));
});
test('REFUSES a token that can also reach the production location', async () => {
  const r = await verifyCredentialScope({ ...base, fetchImpl: mock({ ...HEALTHY, [`locationId=${PROD}`]: 200 }) });
  assert.equal(r.ok, false); assert.deepEqual(fails(r), ['production location #1 denied']);
});
test('REFUSES when ANY of several production locations is reachable', async () => {
  const r = await verifyCredentialScope({ ...base, productionLocationIds: [PROD, PROD2], fetchImpl: mock({ ...HEALTHY, [`locationId=${PROD2}`]: 200 }) });
  assert.deepEqual(fails(r), ['production location #2 denied']);
});
test('REFUSES an agency-level / multi-location token (random location or agency search not denied)', async () => {
  assert.deepEqual(fails(await verifyCredentialScope({ ...base, fetchImpl: mock({ ...HEALTHY, 'locationId=': (u) => (u.includes(OWN) || u.includes('PRODLOC') ? (u.includes(OWN) ? 200 : 403) : 200) }) })), ['random location denied']);
  assert.deepEqual(fails(await verifyCredentialScope({ ...base, fetchImpl: mock({ ...HEALTHY, '/locations/search': 200 }) })), ['agency-level access denied']);
});
test('REFUSES when the designated location itself is not reachable (wrong/expired token)', async () => {
  const r = await verifyCredentialScope({ ...base, fetchImpl: mock({ ...HEALTHY, [`locationId=${OWN}`]: 403 }) });
  assert.deepEqual(fails(r), ['own designated location reachable']);
});
test('fails closed on 404, 5xx, network errors — anything that is not an explicit scope denial', async () => {
  for (const bad of [404, 500, 502, 'throw']) {
    const r = await verifyCredentialScope({ ...base, fetchImpl: mock({ ...HEALTHY, 'locationId=': (u) => (u.includes(OWN) ? 200 : bad === 'throw' ? 0 : bad) , ...(bad === 'throw' ? {} : {}) }) });
    assert.equal(r.ok, false, `status ${bad} must not be accepted`);
  }
  const t = await verifyCredentialScope({ ...base, fetchImpl: mock({ [`locationId=${OWN}`]: 200, 'locationId=': 'throw', '/locations/search': 'throw' }) });
  assert.equal(t.ok, false);
});
test('REFUSES (without any request) when no production location id is available to probe', async () => {
  const calls = [];
  const r = await verifyCredentialScope({ ...base, productionLocationIds: [], fetchImpl: mock(HEALTHY, calls) });
  assert.equal(r.ok, false); assert.equal(calls.length, 0, 'must not touch the network');
});
test('REFUSES without credentials, without any request', async () => {
  const calls = []; const r = await verifyCredentialScope({ ...base, apiKey: '', fetchImpl: mock(HEALTHY, calls) });
  assert.equal(r.ok, false); assert.equal(calls.length, 0);
});
test('the attestation alone is not accepted: a fully attested config with a non-isolated token is still refused', async () => {
  // AION_PROOF_CREDENTIAL_SCOPE=test-location is set by the operator in every real run; here the API says otherwise.
  process.env.AION_PROOF_CREDENTIAL_SCOPE = 'test-location';
  const r = await verifyCredentialScope({ ...base, fetchImpl: mock({ ...HEALTHY, [`locationId=${PROD}`]: 200 }) });
  assert.equal(r.ok, false); delete process.env.AION_PROOF_CREDENTIAL_SCOPE;
});

// CLI: cannot be redirected, and refuses before any network call when isolation cannot be shown.
const CLI = path.join(here, 'proof-credential-scope.mjs');
const trap = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trap-')), 'trap.mjs');
fs.writeFileSync(trap, "globalThis.fetch = async (u) => { process.stderr.write('FETCH_CALLED ' + new URL(u).host + '\\n'); throw new Error('trapped'); };\n");
const cli = (e) => spawnSync(process.execPath, ['--import', trap, CLI], { env: { PATH: process.env.PATH, ...e }, encoding: 'utf8', timeout: 20000 });
test('CLI: no production id available -> refuses with ZERO fetch calls', () => {
  const r = cli({ GHL_API_KEY: 'k', GHL_LOCATION_ID: OWN, AION_PRODUCTION_ENV_FILE: '/nonexistent' });
  assert.equal(r.status, 3); assert.doesNotMatch(r.stderr, /FETCH_CALLED/); assert.match(r.stderr, /REFUSING|none supplied/);
});
test('CLI: GHL_API_BASE_URL cannot redirect the probes — only the fixed GHL host is ever contacted', () => {
  const r = cli({ GHL_API_KEY: 'k', GHL_LOCATION_ID: OWN, AION_PROOF_PRODUCTION_LOCATION_IDS: PROD, GHL_API_BASE_URL: 'http://127.0.0.1:1', AION_PRODUCTION_ENV_FILE: '/nonexistent' });
  assert.equal(r.status, 3);
  const hosts = [...r.stderr.matchAll(/FETCH_CALLED (\S+)/g)].map((m) => m[1]);
  assert.ok(hosts.length > 0 && hosts.every((h) => h === 'services.leadconnectorhq.com'), `hosts: ${hosts}`);
});
test('CLI output never contains the token or any location id', () => {
  const r = cli({ GHL_API_KEY: 'super-secret-token-value', GHL_LOCATION_ID: OWN, AION_PROOF_PRODUCTION_LOCATION_IDS: PROD, AION_PRODUCTION_ENV_FILE: '/nonexistent' });
  for (const secret of ['super-secret-token-value', OWN, PROD]) assert.ok(!(r.stdout + r.stderr).includes(secret));
});
