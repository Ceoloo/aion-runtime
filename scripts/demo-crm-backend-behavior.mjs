#!/usr/bin/env node
// Demonstrates CRM-backend selection on the REAL runtime process, under a production-shaped environment.
//   DATABASE_URL -> a DISPOSABLE Postgres, migrated first WITH grants (mkdir -p dist/sql && cp sql/grants.sql dist/sql/; node dist/migrate.js); needs `npm run build`.
// All secrets are dummies; GHL_API_BASE_URL points at a local capture server, so nothing can reach GHL.
// For each scenario it starts `node dist/index.js`, records the exit/startup log/readiness, then (if it started) sends
// an authenticated governed CRM read through the gateway and reports which backend answered and how many requests the
// capture server saw. Prints only names, statuses and counts.
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentActor, capability, newRequestId } from '@aion/core';
import { RuntimeClient } from '../dist/clients/runtime-client.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) { console.error('set DATABASE_URL (disposable app-role URL)'); process.exit(2); }

let hits = 0; const seen = [];
const capture = http.createServer((req, res) => { hits += 1; seen.push(`${req.method} ${req.url.split('?')[0]}`); res.setHeader('content-type', 'application/json'); res.end('{"contacts":[],"meta":{"total":0}}'); });
await new Promise((r) => capture.listen(0, '127.0.0.1', r));
const captureUrl = `http://127.0.0.1:${capture.address().port}`;

const TENANT = 'demo-tenant', TOKEN = 'demo-service-token-0001', ACTOR_ID = 'act_service_demo_0001';
const KEYS = JSON.stringify([{ token: TOKEN, principalId: 'principal_demo', kind: 'service', actorId: ACTOR_ID, tenantIds: [TENANT], roles: ['invoke', 'register'] }]);
const BASE = { PATH: process.env.PATH, DATABASE_URL: DB_URL, DATABASE_SSL: 'false', RUN_SMOKE_ON_BOOT: 'false', GIT_SHA: 'demo', SERVICE_VERSION: '0.0.0-demo',
  AION_AUTH_MODE: 'required', AION_GATEWAY_API_KEYS: KEYS, GHL_API_VERSION: '2021-07-28' };
const LIVE_CREDS = { GHL_API_KEY: 'demo-not-a-real-key', GHL_LOCATION_ID: 'demo-location-0001', GHL_API_BASE_URL: captureUrl };
const PROD = { AION_ENVIRONMENT: 'production' };

const scenarios = [
  ['production TODAY: credentials set, GHL_BACKEND unset', { ...PROD, ...LIVE_CREDS }],
  ['production, GHL_BACKEND=live + credentials', { ...PROD, ...LIVE_CREDS, GHL_BACKEND: 'live' }],
  ['production, credentials MISSING, GHL_BACKEND unset', { ...PROD }],
  ['production, credentials MISSING, GHL_BACKEND=live', { ...PROD, GHL_BACKEND: 'live' }],
  ['production, GHL_BACKEND=fake (no acknowledgement)', { ...PROD, ...LIVE_CREDS, GHL_BACKEND: 'fake' }],
  ['production, GHL_BACKEND=fake + AION_ACK_FAKE_CRM=1', { ...PROD, GHL_BACKEND: 'fake', AION_ACK_FAKE_CRM: '1' }],
  ['production, GHL_BACKEND=sandbox (invalid)', { ...PROD, ...LIVE_CREDS, GHL_BACKEND: 'sandbox' }],
  ['production, GHL_BACKEND blank line', { ...PROD, GHL_BACKEND: '' }],
  ['staging, credentials set, unset', { AION_ENVIRONMENT: 'staging', ...LIVE_CREDS }],
  ['local dev, nothing set', { AION_ENVIRONMENT: 'local', AION_AUTH_MODE: 'open' }],
  ['local, GHL_BACKEND=fake + credentials', { AION_ENVIRONMENT: 'local', AION_AUTH_MODE: 'open', ...LIVE_CREDS, GHL_BACKEND: 'fake' }],
];

async function run(name, extra, port) {
  const env = { ...BASE, ...extra, PORT: String(port) };
  const child = spawn(process.execPath, ['dist/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
  let exited = null; child.on('exit', (c) => (exited = c));
  let ready = null;
  for (let i = 0; i < 40 && exited === null; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { const r = await fetch(`http://127.0.0.1:${port}/health/ready`); if (r.status === 200) { ready = await r.json(); break; } } catch { /* not up yet */ }
  }
  const lines = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const startup = lines.find((l) => /^crm_backend|^config_invalid/.test(l.message));
  const result = { name, started: ready !== null, exit: exited, log: startup ? `${startup.level}:${startup.message}${startup.reason ? ' — ' + startup.reason.slice(0, 70) : ''}` : '-', ready_crm: ready?.crm_backend ?? '-', backend: '-', requests: '-' };
  if (ready) {
    const before = hits;
    const client = new RuntimeClient({ baseUrl: `http://127.0.0.1:${port}`, tenantId: TENANT, apiKey: extra.AION_AUTH_MODE === 'open' ? undefined : TOKEN });
    const agent = createAgentActor({ actorId: ACTOR_ID, name: 'demo agent', purpose: 'backend behaviour demo', owner: 'demo', domain: 'revenue', role: 'copilot', tenantId: TENANT, companyId: 'co_demo', permissions: [capability('crm.contact.search')], maxRiskLevel: 'R1', autonomyLevel: 'L1' });
    try {
      const res = await client.submitCommand({ name: 'demo contact search', actor: agent, requestId: newRequestId(), serviceKey: 'crm.contact.search@1', payload: { query: 'demo' }, metadata: { tenantId: TENANT, proof: 'behaviour-demo' } });
      result.backend = res?.run?.output?.backend ?? res?.output?.backend ?? res?.status ?? '?';
    } catch (e) { result.backend = `request error: ${String(e.message).slice(0, 50)}`; }
    result.requests = hits - before;
  }
  child.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 400)); if (exited === null) child.kill('SIGKILL');
  return result;
}

const rows = []; let port = 8300;
for (const [name, extra] of scenarios) rows.push(await run(name, extra, port++));
capture.close();
const w = (s, n) => String(s).padEnd(n).slice(0, n);
console.log(`${w('scenario', 52)} ${w('started', 8)} ${w('exit', 5)} ${w('/health/ready crm_backend', 26)} ${w('gateway CRM read status', 30)} ${w('reqs to GHL(capture)', 8)}  startup log`);
for (const r of rows) console.log(`${w(r.name, 52)} ${w(r.started, 8)} ${w(r.exit ?? '-', 5)} ${w(r.ready_crm, 26)} ${w(r.backend, 30)} ${w(r.requests, 8)}  ${r.log}`);
console.log(`\ntotal requests that reached the capture server (stand-in for GHL): ${hits} ${JSON.stringify([...new Set(seen)])}`);
