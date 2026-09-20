import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGhlBackendFromEnv, GhlBackendSelectionError } from './live-ghl-backend.js';

const CREDS = { GHL_API_KEY: 'test-key', GHL_LOCATION_ID: 'test-location' };
const env = (o: Record<string, string>): NodeJS.ProcessEnv => ({ ...o });

test('GHL_BACKEND=fake selects the fixture backend even when credentials are present', () => {
  assert.equal(createGhlBackendFromEnv(env({ ...CREDS, GHL_BACKEND: 'fake' })).name, 'ghl-fake');
});

test('proof context: credentials never imply live — an explicit backend is required', () => {
  assert.throws(() => createGhlBackendFromEnv(env({ ...CREDS, AION_PROOF: '1' })), GhlBackendSelectionError);
  assert.throws(() => createGhlBackendFromEnv(env({ AION_PROOF: '1' })), GhlBackendSelectionError);
});

test('proof context: explicit live additionally needs AION_PROOF_LIVE=1', () => {
  assert.throws(
    () => createGhlBackendFromEnv(env({ ...CREDS, AION_PROOF: '1', GHL_BACKEND: 'live' })),
    /AION_PROOF_LIVE=1/,
  );
  assert.equal(
    createGhlBackendFromEnv(env({ ...CREDS, AION_PROOF: '1', AION_PROOF_LIVE: '1', GHL_BACKEND: 'live' })).name,
    'ghl-live',
  );
});

test('proof context with explicit fake works and never touches the live backend', () => {
  assert.equal(createGhlBackendFromEnv(env({ ...CREDS, AION_PROOF: '1', GHL_BACKEND: 'fake' })).name, 'ghl-fake');
});

test('explicit live without credentials throws instead of silently falling back to fake', () => {
  assert.throws(() => createGhlBackendFromEnv(env({ GHL_BACKEND: 'live' })), GhlBackendSelectionError);
});

test('unknown GHL_BACKEND value is rejected', () => {
  assert.throws(() => createGhlBackendFromEnv(env({ GHL_BACKEND: 'sandbox' })), /must be "fake" or "live"/);
});

test('legacy deployed behaviour is unchanged: no GHL_BACKEND, not a proof — credentials select live, none select fake', () => {
  assert.equal(createGhlBackendFromEnv(env(CREDS)).name, 'ghl-live');
  assert.equal(createGhlBackendFromEnv(env({})).name, 'ghl-fake');
});
