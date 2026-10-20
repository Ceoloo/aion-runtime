import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../../config.js';
import { createCrmBackendFromEnv, resolveCrmBackendSelection } from './create-backend.js';
import { resolveCrmProvider } from './provider-policy.js';

const BASE = {
  AION_ENVIRONMENT: 'local',
  DATABASE_URL: 'postgresql://aion_app:x@localhost:5432/aion_data',
  AION_AUTH_MODE: 'open',
};

function env(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { ...BASE, ...extra } as NodeJS.ProcessEnv;
}

const GHL_CREDS = {
  GHL_API_KEY: 'pit-test',
  GHL_LOCATION_ID: 'loc_test',
};

test('CRM_PROVIDER unset defaults to ghl (production path preserved)', () => {
  assert.equal(resolveCrmProvider(env()), 'ghl');
  assert.equal(resolveCrmProvider(env({ CRM_PROVIDER: '' })), 'ghl');
  assert.equal(resolveCrmProvider(env({ CRM_PROVIDER: 'ghl' })), 'ghl');
});

test('CRM_PROVIDER=twenty selects twenty-fake when TWENTY_BACKEND=fake', () => {
  const selected = resolveCrmBackendSelection(
    env({ CRM_PROVIDER: 'twenty', TWENTY_BACKEND: 'fake' }),
  );
  assert.equal(selected.provider, 'twenty');
  assert.equal(selected.choice.kind, 'fake');
  assert.equal(selected.backend.name, 'twenty-fake');
});

test('default createCrmBackendFromEnv with GHL creds stays ghl-live', () => {
  const backend = createCrmBackendFromEnv(env({ ...GHL_CREDS, GHL_BACKEND: 'live' }));
  assert.equal(backend.name, 'ghl-live');
});

test('default createCrmBackendFromEnv without creds stays ghl-fake', () => {
  const backend = createCrmBackendFromEnv(env({ GHL_BACKEND: 'fake' }));
  assert.equal(backend.name, 'ghl-fake');
});

test('production + CRM_PROVIDER=twenty without TWENTY_BACKEND refuses (no silent cutover)', () => {
  assert.throws(
    () =>
      resolveCrmBackendSelection(
        env({
          AION_ENVIRONMENT: 'production',
          CRM_PROVIDER: 'twenty',
          ...GHL_CREDS,
          GHL_BACKEND: 'live',
        }),
      ),
    /CRM_PROVIDER=twenty in production requires an explicit TWENTY_BACKEND/,
  );
});

test('loadConfig reports crmProvider=ghl by default', () => {
  const c = loadConfig(env({ ...GHL_CREDS, GHL_BACKEND: 'live' }));
  assert.equal(c.crmProvider, 'ghl');
  assert.equal(c.crmBackend.kind, 'live');
});

test('loadConfig reports crmProvider=twenty with fake backend', () => {
  const c = loadConfig(env({ CRM_PROVIDER: 'twenty', TWENTY_BACKEND: 'fake' }));
  assert.equal(c.crmProvider, 'twenty');
  assert.equal(c.crmBackend.kind, 'fake');
});

test('invalid CRM_PROVIDER is rejected', () => {
  assert.throws(() => resolveCrmProvider(env({ CRM_PROVIDER: 'hubspot' })), /must be "ghl" or "twenty"/);
});
