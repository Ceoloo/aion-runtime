/**
 * AIO-44 — Agent Identity Registry gateway management paths.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import {
  createAgentActor,
  isAgentExecutionAllowed,
  type Actor,
} from '@aion/core';
import type { ControlPlane } from './control-plane.js';
import { handleGatewayRequest } from './gateway.js';
import { Logger } from './logger.js';

const logger = new Logger(
  { service: 'aion-runtime-test', environment: 'test', gitSha: 'test', serviceVersion: '0.0.0' },
  'error',
);

function mockReq(body?: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const chunks = raw ? [Buffer.from(raw)] : [];
  let i = 0;
  return {
    headers,
    async *[Symbol.asyncIterator]() {
      while (i < chunks.length) yield chunks[i++]!;
    },
  } as IncomingMessage;
}

function buildControlPlane(actors = new Map<string, Actor>()): ControlPlane {
  return {
    auth: { mode: 'open', apiKeys: [] },
    dataLayer: {
      actors: {
        async get(id: string) {
          return actors.get(id);
        },
        async save(actor: Actor) {
          actors.set(actor.actorId, actor);
        },
        async list() {
          return [...actors.values()];
        },
      },
    },
  } as unknown as ControlPlane;
}

test('GET /v1/actors returns registry completeness inventory', async () => {
  const actors = new Map<string, Actor>();
  const complete = createAgentActor({
    name: 'Complete',
    purpose: 'assist',
    owner: 'ops',
    tenantId: 'tenant_a',
    autonomyLevel: 'L1',
    actionTier: 'assist',
    delegatedAuthorityEvidence: 'ops root',
    policyVersion: 'sis-v1.0',
    executionEvidence: 'audit://tenant_a/complete',
    revocationState: 'active',
  });
  actors.set(complete.actorId, complete);
  const cp = buildControlPlane(actors);

  const res = await handleGatewayRequest(
    'GET',
    '/v1/actors',
    mockReq(undefined, { 'x-aion-tenant-id': 'tenant_a' }),
    cp,
    logger,
  );
  assert.equal(res?.status, 200, JSON.stringify(res?.body));
  const body = res!.body as {
    count: number;
    registry: { completeCount: number; incompleteCount: number; orphanCount: number };
  };
  assert.equal(body.count, 1);
  assert.equal(body.registry.completeCount, 1);
  assert.equal(body.registry.incompleteCount, 0);
  assert.equal(body.registry.orphanCount, 0);
});

test('POST /v1/actors registers agent and can requireComplete', async () => {
  const cp = buildControlPlane();
  const incomplete = createAgentActor({
    name: 'Partial',
    purpose: 'draft',
    owner: 'ops',
    tenantId: 'tenant_a',
    autonomyLevel: 'L0',
  });
  const denied = await handleGatewayRequest(
    'POST',
    '/v1/actors',
    mockReq(
      { actor: incomplete, requireComplete: true },
      { 'x-aion-tenant-id': 'tenant_a' },
    ),
    cp,
    logger,
  );
  assert.equal(denied?.status, 400);
  assert.equal((denied?.body as { error: string }).error, 'registry_incomplete');

  const actors = new Map<string, Actor>();
  const cp2 = buildControlPlane(actors);
  const complete = createAgentActor({
    name: 'Registered',
    purpose: 'assist CRM',
    owner: 'ops',
    tenantId: 'tenant_a',
    autonomyLevel: 'L1',
    actionTier: 'assist',
    delegatedAuthorityEvidence: 'ops',
    policyVersion: 'v1',
    executionEvidence: 'audit://registered',
    revocationState: 'active',
  });
  const ok = await handleGatewayRequest(
    'POST',
    '/v1/actors',
    mockReq(
      { actor: complete, requireComplete: true },
      { 'x-aion-tenant-id': 'tenant_a' },
    ),
    cp2,
    logger,
  );
  assert.equal(ok?.status, 201, JSON.stringify(ok?.body));
  assert.equal(
    (ok!.body as { registry: { complete: boolean } }).registry.complete,
    true,
  );
  assert.equal(actors.has(complete.actorId), true);
});

test('POST /v1/actors/:id/revoke contains an agent', async () => {
  const actors = new Map<string, Actor>();
  const agent = createAgentActor({
    name: 'Containable',
    purpose: 'test',
    owner: 'ops',
    tenantId: 'tenant_a',
    autonomyLevel: 'L1',
    actionTier: 'assist',
    delegatedAuthorityEvidence: 'ops',
    policyVersion: 'v1',
    executionEvidence: 'audit://x',
    revocationState: 'active',
  });
  actors.set(agent.actorId, agent);
  const cp = buildControlPlane(actors);
  const res = await handleGatewayRequest(
    'POST',
    `/v1/actors/${agent.actorId}/revoke`,
    mockReq(
      { state: 'revoked', reason: 'compromise suspected' },
      { 'x-aion-tenant-id': 'tenant_a' },
    ),
    cp,
    logger,
  );
  assert.equal(res?.status, 200, JSON.stringify(res?.body));
  const body = res!.body as {
    agent: { revocationState: string; metadata: Record<string, unknown> };
    executionAllowed: boolean;
  };
  assert.equal(body.agent.revocationState, 'revoked');
  assert.equal(body.executionAllowed, false);
  assert.equal(body.agent.metadata.revocationReason, 'compromise suspected');
  assert.equal(isAgentExecutionAllowed(actors.get(agent.actorId) as never), false);
});
