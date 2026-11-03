import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError } from '../../config.js';
import { harnessAdaptersFromConfig } from '../../control-plane.js';

const BASE: Record<string, string> = {
  DATABASE_URL: 'postgresql://aion_app:x@db.example.invalid:5432/aion',
  AION_AUTH_MODE: 'open',
};

test('harnessRouter disabled by default — no adapter registered', () => {
  const c = loadConfig({ ...BASE });
  assert.equal(c.harnessRouter.enabled, false);
  assert.equal(harnessAdaptersFromConfig(c).length, 0);
});

test('HARNESSROUTER_ENABLED=true without URL refuses to boot', () => {
  assert.throws(
    () =>
      loadConfig({
        ...BASE,
        HARNESSROUTER_ENABLED: 'true',
        HARNESSROUTER_API_KEY: 'k',
      }),
    (e: unknown) => e instanceof ConfigError && /HARNESSROUTER_BASE_URL/.test((e as Error).message),
  );
});

test('HARNESSROUTER_ENABLED=true without API key refuses to boot', () => {
  assert.throws(
    () =>
      loadConfig({
        ...BASE,
        HARNESSROUTER_ENABLED: 'true',
        HARNESSROUTER_BASE_URL: 'http://127.0.0.1:3000/api/harness',
      }),
    (e: unknown) => e instanceof ConfigError && /HARNESSROUTER_API_KEY/.test((e as Error).message),
  );
});

test('enabled with URL + key registers the uhp-harness adapter', () => {
  const c = loadConfig({
    ...BASE,
    HARNESSROUTER_ENABLED: 'true',
    HARNESSROUTER_BASE_URL: 'http://127.0.0.1:3000/api/harness',
    HARNESSROUTER_API_KEY: 'secret',
  });
  assert.equal(c.harnessRouter.enabled, true);
  const adapters = harnessAdaptersFromConfig(c);
  assert.equal(adapters.length, 1);
  assert.equal(adapters[0]?.name, 'uhp-harness');
});
