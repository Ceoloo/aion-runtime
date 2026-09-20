import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGhlBackendFromEnv, GhlBackendSelectionError } from './live-ghl-backend.js';
import { resolveGhlBackendChoice } from './backend-policy.js';
import { loadConfig, ConfigError } from '../../config.js';

const CREDS = { GHL_API_KEY: 'test-key', GHL_LOCATION_ID: 'test-location' };
const PROD = { AION_ENVIRONMENT: 'production' };
const env = (...o: Record<string, string>[]): NodeJS.ProcessEnv => Object.assign({}, ...o);

// ── production: today's deployed shape, and every way it could silently become fake ───────────────────────────
test('production today (credentials present, GHL_BACKEND unset): still live, flagged as inferred', () => {
  const c = resolveGhlBackendChoice(env(PROD, CREDS));
  assert.deepEqual([c.kind, c.source], ['live', 'inferred_credentials']);
  assert.match(c.warning ?? '', /set GHL_BACKEND=live/);
  assert.equal(createGhlBackendFromEnv(env(PROD, CREDS)).name, 'ghl-live');
});
test('production, explicit live with credentials: live, no warning', () => {
  const c = resolveGhlBackendChoice(env(PROD, CREDS, { GHL_BACKEND: 'live' }));
  assert.deepEqual([c.kind, c.source, c.warning], ['live', 'explicit', undefined]);
});
test('production, explicit live WITHOUT credentials: refuses (never degrades to fake)', () => {
  assert.throws(() => resolveGhlBackendChoice(env(PROD, { GHL_BACKEND: 'live' })), /not set/);
});
test('production, unset and NO credentials: refuses — no silent fallback to the fake backend', () => {
  assert.throws(() => resolveGhlBackendChoice(env(PROD)), /refusing to fall back to the fake backend/);
  assert.throws(() => createGhlBackendFromEnv(env(PROD)), GhlBackendSelectionError);
});
test('production, empty GHL_BACKEND is treated as unset (a blank env line cannot select fake)', () => {
  assert.throws(() => resolveGhlBackendChoice(env(PROD, { GHL_BACKEND: '' })), /refusing/);
  assert.throws(() => resolveGhlBackendChoice(env(PROD, { GHL_BACKEND: '  ' })), /refusing/);
});
test('production, GHL_BACKEND=fake is refused unless separately acknowledged', () => {
  assert.throws(() => resolveGhlBackendChoice(env(PROD, { GHL_BACKEND: 'fake' })), /refused when AION_ENVIRONMENT=production/);
  assert.throws(() => resolveGhlBackendChoice(env(PROD, CREDS, { GHL_BACKEND: 'fake' })), /refused/);
  assert.throws(() => resolveGhlBackendChoice(env(PROD, { GHL_BACKEND: 'fake', AION_ACK_FAKE_CRM: 'true' })), /refused/);
});
test('production, acknowledged fake (image certification) is explicit, flagged, and never silent', () => {
  const c = resolveGhlBackendChoice(env(PROD, { GHL_BACKEND: 'fake', AION_ACK_FAKE_CRM: '1' }));
  assert.deepEqual([c.kind, c.source, c.productionFakeAcknowledged], ['fake', 'explicit', true]);
  assert.match(c.warning ?? '', /FAKE CRM backend acknowledged in production/);
});
test('invalid GHL_BACKEND values are rejected in every environment', () => {
  const envs: Record<string, string>[] = [{}, PROD, { AION_ENVIRONMENT: 'staging' }];
  for (const e of envs)
    assert.throws(() => resolveGhlBackendChoice(env(e, CREDS, { GHL_BACKEND: 'sandbox' })), /must be "fake" or "live"/);
});
test('values are trimmed and case-insensitive', () => {
  assert.equal(resolveGhlBackendChoice(env(PROD, CREDS, { GHL_BACKEND: ' LIVE ' })).kind, 'live');
});

// ── non-production keeps its legacy behaviour ─────────────────────────────────────────────────────────────────
test('non-production unchanged: credentials => live, none => fake, explicit values honoured', () => {
  const nonProd: Record<string, string>[] = [{}, { AION_ENVIRONMENT: 'staging' }, { AION_ENVIRONMENT: 'local' }];
  for (const e of nonProd) {
    assert.equal(createGhlBackendFromEnv(env(e, CREDS)).name, 'ghl-live');
    assert.equal(createGhlBackendFromEnv(env(e)).name, 'ghl-fake');
    assert.equal(createGhlBackendFromEnv(env(e, CREDS, { GHL_BACKEND: 'fake' })).name, 'ghl-fake');
    assert.throws(() => createGhlBackendFromEnv(env(e, { GHL_BACKEND: 'live' })), GhlBackendSelectionError);
  }
});

// ── proof context (set by every proof script) ─────────────────────────────────────────────────────────────────
test('proof context: credentials never imply live — an explicit backend is required', () => {
  assert.throws(() => createGhlBackendFromEnv(env(CREDS, { AION_PROOF: '1' })), GhlBackendSelectionError);
  assert.throws(() => createGhlBackendFromEnv(env({ AION_PROOF: '1' })), GhlBackendSelectionError);
});
test('proof context: explicit live additionally needs AION_PROOF_LIVE=1', () => {
  assert.throws(() => createGhlBackendFromEnv(env(CREDS, { AION_PROOF: '1', GHL_BACKEND: 'live' })), /AION_PROOF_LIVE=1/);
  assert.equal(createGhlBackendFromEnv(env(CREDS, { AION_PROOF: '1', AION_PROOF_LIVE: '1', GHL_BACKEND: 'live' })).name, 'ghl-live');
});
test('proof context with explicit fake works and never touches the live backend', () => {
  assert.equal(createGhlBackendFromEnv(env(CREDS, { AION_PROOF: '1', GHL_BACKEND: 'fake' })).name, 'ghl-fake');
});

// ── startup: loadConfig fails fast with the clean config_invalid path ─────────────────────────────────────────
const BASE = { DATABASE_URL: 'postgresql://u:p@localhost:5432/d', AION_AUTH_MODE: 'open', DATABASE_SSL: 'false' };
test('loadConfig: production + credentials starts and reports crmBackend=live', () => {
  const c = loadConfig(env(BASE, PROD, CREDS));
  assert.deepEqual([c.crmBackend.kind, c.crmBackend.source], ['live', 'inferred_credentials']);
});
test('loadConfig: production without credentials or selection refuses to start with a ConfigError', () => {
  assert.throws(() => loadConfig(env(BASE, PROD)), (e: unknown) => e instanceof ConfigError && /fake backend/.test((e as Error).message));
});
test('loadConfig: production + unacknowledged fake refuses to start', () => {
  assert.throws(() => loadConfig(env(BASE, PROD, { GHL_BACKEND: 'fake' })), ConfigError);
});
test('loadConfig: acknowledged fake in production is reported (never silent)', () => {
  const c = loadConfig(env(BASE, PROD, { GHL_BACKEND: 'fake', AION_ACK_FAKE_CRM: '1' }));
  assert.equal(c.crmBackend.productionFakeAcknowledged, true);
});
test('loadConfig: local development with nothing set still starts on the fake backend', () => {
  assert.equal(loadConfig(env(BASE)).crmBackend.kind, 'fake');
});
