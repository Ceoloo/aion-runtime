#!/usr/bin/env node
// Behavioural credential-ISOLATION check for live proofs. An attestation env var ("this token is test-scoped") is only
// a claim; this proves it with read-only metadata calls before any live write:
//   1. own designated location is reachable                     (GET /opportunities/pipelines?locationId=<designated>  -> 200)
//   2. a random location is DENIED as a scope error             (…locationId=<random>                                   -> 401/403)
//   3. agency-level access is DENIED                            (GET /locations/search?limit=1                          -> 401/403)
//   4. every PRODUCTION location is DENIED                      (…locationId=<production>                               -> 401/403)
// (4) needs the production location id(s) at run time — from /opt/aion/.env on this host, or AION_PROOF_PRODUCTION_LOCATION_IDS
// supplied by the operator. With neither, the check REFUSES: isolation from production cannot be shown. Anything unexpected
// (200 where denial is required, 404, 5xx, network error, timeout) refuses. The base URL is a constant: no env override.
// Prints check names and HTTP statuses only — never ids, tokens, or bodies.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const GHL_BASE_URL = 'https://services.leadconnectorhq.com';
const denied = (s) => s === 401 || s === 403;

export async function verifyCredentialScope({ fetchImpl = fetch, apiKey, locationId, version = '2021-07-28', productionLocationIds = [] }) {
  const checks = [];
  const call = async (name, path, want) => {
    let status = 'network-error';
    try {
      const r = await fetchImpl(`${GHL_BASE_URL}${path}`, { method: 'GET', headers: { authorization: `Bearer ${apiKey}`, version, accept: 'application/json', 'user-agent': 'AION-proof-scope-check/1.0' }, signal: AbortSignal.timeout(10000) });
      status = r.status;
    } catch { /* recorded as network-error */ }
    checks.push({ name, status, ok: want(status) });
  };
  if (!apiKey || !locationId) return { ok: false, checks: [{ name: 'credentials present', status: 'missing', ok: false }] };
  if (!productionLocationIds.length) return { ok: false, checks: [{ name: 'production location id available for the negative probe', status: 'none supplied', ok: false }] };
  const rnd = randomBytes(15).toString('base64url').slice(0, 20);
  await call('own designated location reachable', `/opportunities/pipelines?locationId=${encodeURIComponent(locationId)}`, (s) => s === 200);
  await call('random location denied', `/opportunities/pipelines?locationId=${rnd}`, denied);
  await call('agency-level access denied', '/locations/search?limit=1', denied);
  let i = 0;
  for (const p of productionLocationIds) await call(`production location #${++i} denied`, `/opportunities/pipelines?locationId=${encodeURIComponent(p)}`, denied);
  return { ok: checks.every((c) => c.ok), checks };
}

function productionIdsFromEnv() {
  const ids = (process.env.AION_PROOF_PRODUCTION_LOCATION_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  try {
    for (const line of readFileSync(process.env.AION_PRODUCTION_ENV_FILE || '/opt/aion/.env', 'utf8').split('\n')) {
      const i = line.indexOf('='); if (i > 0 && line.slice(0, i).trim() === 'GHL_LOCATION_ID') ids.push(line.slice(i + 1).trim());
    }
  } catch { /* no production env file on this host */ }
  return [...new Set(ids.filter(Boolean))];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const apiKey = (process.env.GHL_API_KEY ?? process.env.AION_GHL_API_KEY ?? '').trim();
  const locationId = (process.env.GHL_LOCATION_ID ?? process.env.AION_GHL_LOCATION_ID ?? '').trim();
  const res = await verifyCredentialScope({ apiKey, locationId, version: (process.env.GHL_API_VERSION ?? '2021-07-28').trim(), productionLocationIds: productionIdsFromEnv() });
  for (const c of res.checks) console.error(`[proof-scope] ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}: ${c.status}`);
  if (!res.ok) { console.error('[proof-scope] REFUSING TO RUN: credential isolation is NOT demonstrated (an attestation is not enough). No live write was attempted.'); process.exit(3); }
  console.error('[proof-scope] ok: the credential reaches only the designated location (read-only probes)');
}
