import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import type { GatewayAuthConfig } from './types.js';
import type { KeycloakVerifier } from '@aion/sentinel';
import { authenticateGatewayRequest } from './keycloak-gateway.js';
import { loadGatewayAuthConfig } from './config.js';

const principal = {
  principalId: 'principal-ops',
  kind: 'operator' as const,
  actorId: 'actor-human-ops',
  tenantIds: ['tenant-a'],
  roles: ['invoke' as const, 'approve' as const],
};
const req = (authorization?: string) => ({
  headers: authorization === undefined ? {} : { authorization },
}) as IncomingMessage;
const fakeJwt = 'eyJhbGciOiJSUzI1NiJ9.eyJ0eXAiOiJCZWFyZXIifQ.signature';
const keycloak: GatewayAuthConfig = {
  mode: 'required', provider: 'keycloak', apiKeys: [],
  keycloak: {
    issuer: 'https://auth.example.test/realms/aion',
    audience: 'aion-runtime',
    allowedClients: ['aion-console'],
  },
};
const verified: KeycloakVerifier = async () => ({ verified: true, principal });

test('api-key mode stays backward compatible', async () => {
  const legacy: GatewayAuthConfig = {
    mode: 'required',
    apiKeys: [{ token: 'old-operator-credential', principal }],
  };
  const ok = await authenticateGatewayRequest(req('Bearer old-operator-credential'), legacy);
  assert.equal(ok.ok, true);
  const deny = await authenticateGatewayRequest(req('Bearer bogus-credential'), legacy);
  assert.equal(deny.ok, false);
});

test('Keycloak provider is opt-in, fail-fast and disallows API key fallback', () => {
  const env = {
    AION_AUTH_PROVIDER: 'keycloak',
    AION_AUTH_MODE: 'required',
    AION_KEYCLOAK_ISSUER: 'https://auth.example.test/realms/aion',
    AION_KEYCLOAK_AUDIENCE: 'aion-runtime',
    AION_KEYCLOAK_ALLOWED_CLIENTS: 'aion-console',
  };
  assert.equal(loadGatewayAuthConfig(env, 'staging').provider, 'keycloak');
  assert.throws(() => loadGatewayAuthConfig({ ...env, AION_AUTH_MODE: 'open' }, 'local'));
  assert.throws(() => loadGatewayAuthConfig({ ...env, AION_GATEWAY_API_KEYS: '[{"token":"fake"}]' }, 'staging'));
  assert.throws(() => loadGatewayAuthConfig({ ...env, AION_KEYCLOAK_ALLOWED_CLIENTS: '' }, 'staging'));
  assert.throws(() => loadGatewayAuthConfig({ ...env, AION_AUTH_PROVIDER: 'other' }, 'staging'));
});

test('missing, malformed and legacy keys cannot authenticate in Keycloak mode', async () => {
  for (const credential of [undefined, 'Bearer old-operator-credential', 'Basic xyz', 'Bearer abc.def']) {
    const result = await authenticateGatewayRequest(req(credential), keycloak, verified);
    assert.equal(result.ok, false);
  }
  assert.equal((await authenticateGatewayRequest(req('Bearer '+fakeJwt), keycloak)).ok, false);
});

test('verified Keycloak Principal enters the same Runtime identity contract', async () => {
  const result = await authenticateGatewayRequest(req('Bearer '+fakeJwt), keycloak, verified);
  assert.deepEqual(result, { ok: true, principal });
});

test('invalid verifier result or identity store outage denies cleanly', async () => {
  const rejected: KeycloakVerifier = async () => ({ verified: false });
  const outage: KeycloakVerifier = async () => { throw new Error('simulated failure'); };
  const badPrincipal = async () => ({ verified: true as const,
    principal: { ...principal, roles: ['register'] as never } });
  for (const verifier of [rejected, outage, badPrincipal]) {
    const result = await authenticateGatewayRequest(req('Bearer '+fakeJwt), keycloak, verifier);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'auth_invalid');
  }
});
