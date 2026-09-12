/**
 * Identity-plane unit tests — authn principal binding + tenant subset checks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import {
  authenticateRequest,
  assertPrincipalTenantAccess,
} from './authenticate.js';
import { resolveAuthMode } from './config.js';
import type { GatewayAuthConfig, Principal } from './types.js';

function reqWithAuth(header?: string): IncomingMessage {
  return {
    headers: header ? { authorization: header } : {},
  } as IncomingMessage;
}

const operator: Principal = {
  principalId: 'principal_ops_1',
  kind: 'operator',
  actorId: 'act_human_ops_1',
  tenantIds: ['tenant_a', 'tenant_b'],
  roles: ['invoke', 'approve', 'register'],
};

const config: GatewayAuthConfig = {
  mode: 'required',
  apiKeys: [{ token: 'test-token-operator-1', principal: operator }],
};

test('authenticateRequest denies missing bearer when mode=required', () => {
  const result = authenticateRequest(reqWithAuth(), config);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 401);
    assert.equal(result.code, 'auth_required');
  }
});

test('authenticateRequest accepts valid bearer and returns principal', () => {
  const result = authenticateRequest(
    reqWithAuth('Bearer test-token-operator-1'),
    config,
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.principal?.principalId, 'principal_ops_1');
    assert.deepEqual(result.principal?.tenantIds, ['tenant_a', 'tenant_b']);
  }
});

test('authenticateRequest rejects forged bearer', () => {
  const result = authenticateRequest(
    reqWithAuth('Bearer forged-token-xxxxxxxxx'),
    config,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'auth_invalid');
  }
});

test('assertPrincipalTenantAccess denies header outside principal tenants', () => {
  const denied = assertPrincipalTenantAccess(operator, 'tenant_evil', {
    requireTenant: true,
  });
  assert.ok(denied);
  assert.equal(denied?.code, 'tenant_forbidden');
});

test('assertPrincipalTenantAccess allows header within principal tenants', () => {
  const denied = assertPrincipalTenantAccess(operator, 'tenant_a', {
    requireTenant: true,
  });
  assert.equal(denied, null);
});

test('resolveAuthMode defaults to required off-local', () => {
  assert.equal(resolveAuthMode('local', undefined), 'open');
  assert.equal(resolveAuthMode('staging', undefined), 'required');
  assert.equal(resolveAuthMode('production', undefined), 'required');
  assert.equal(resolveAuthMode('production', 'open'), 'open');
});
