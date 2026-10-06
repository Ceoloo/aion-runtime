/**
 * AIO-44 Agent Identity Registry gateway surface (in-memory Data mock).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import {
  createAgentActor,
  createRootAuthority,
  capability,
  type Actor,
  type AgentActor,
} from '@aion/core';
import type { ControlPlane } from './control-plane.js';
import { handleGatewayRequest } from './gateway.js';
import { Logger } from './logger.js';

const logger = new Logger(
  {
    service: 'aion-runtime-test',
    environment: 'test',
    gitSha: 'test',
    serviceVersion: '0.0.0',
  },
  'error',
);

const TENANT = 'aion-internal';
const NOW = '2026-10-06T12:00:00.000Z';

function mockReq(
  body?: unknown,
  headers: Record<string, string> = { 'x-aion-tenant-id': TENANT },
): IncomingMessage {
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

function completeAgent(): AgentActor {
  const authority = createRootAuthority({
    subject: { kind: 'human', ref: 'dana@aion.systems' },
    tenantId: TENANT,
    grantReason: 'registry fixture',
    capabilities: [capability('crm.read')],
    dataScopes: ['crm.contacts'],
    createdAt: NOW,
  });
  return {
    ...createAgentActor({
      name: 'RevenueCopilot',
      purpose: 'Governed CRM assist',
      owner: 'dana@aion.systems',
      domain: 'revenue',
      role: 'copilot',
      tenantId: TENANT,
      actionTier: 'assist',
      permissions: [capability('crm.read')],
      allowedData: ['crm.contacts'],
      policyVersion: 'sis-v1.0/test',
      executionEvidence: 'executions?actor_id={actor_id}',
      revocationState: 'active',
      environment: 'staging',
    }),
    delegatedAuthority: authority,
  };
}

function buildCp() {
  const actors = new Map<string, Actor>();
  const cp = {
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
      executions: {
        async listRecentForTenant() {
          return [];
        },
      },
    },
    auth: { mode: 'open' as const, apiKeys: [] },
  } as unknown as ControlPlane;
  return { cp, actors };
}

test('PUT /v1/registry/agents registers a complete SIS-AG-02 agent', async () => {
  const { cp } = buildCp();
  const agent = completeAgent();
  const res = await handleGatewayRequest(
    'PUT',
    '/v1/registry/agents',
    mockReq(agent),
    cp,
    logger,
  );
  assert.ok(res);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as {
    completeness: { ok: boolean };
    record: { permission_tier: string; human_owner: string };
  };
  assert.equal(body.completeness.ok, true);
  assert.equal(body.record.permission_tier, 'assist');
  assert.equal(body.record.human_owner, 'dana@aion.systems');
});

test('GET /v1/registry/inventory exports complete records', async () => {
  const { cp } = buildCp();
  const agent = completeAgent();
  await handleGatewayRequest('PUT', '/v1/registry/agents', mockReq(agent), cp, logger);
  const res = await handleGatewayRequest(
    'GET',
    '/v1/registry/inventory',
    mockReq(),
    cp,
    logger,
  );
  assert.ok(res);
  assert.equal(res.status, 200);
  const body = res.body as { count: number; records: unknown[]; incompleteCount: number };
  assert.equal(body.count, 1);
  assert.equal(body.incompleteCount, 0);
  assert.equal(body.records.length, 1);
});

test('POST revoke sets revocation_state and review stays ok for known agents', async () => {
  const { cp } = buildCp();
  const agent = completeAgent();
  await handleGatewayRequest('PUT', '/v1/registry/agents', mockReq(agent), cp, logger);
  const revoked = await handleGatewayRequest(
    'POST',
    `/v1/registry/agents/${agent.actorId}/revoke`,
    mockReq(),
    cp,
    logger,
  );
  assert.ok(revoked);
  assert.equal(revoked.status, 200);
  const view = revoked.body as { agent: { revocationState: string } };
  assert.equal(view.agent.revocationState, 'revoked');

  const review = await handleGatewayRequest(
    'GET',
    `/v1/registry/review?observed=${encodeURIComponent(agent.agentUri!)}`,
    mockReq(),
    cp,
    logger,
  );
  assert.ok(review);
  assert.equal(review.status, 200);
  const body = review.body as { ok: boolean; findings: unknown[] };
  assert.equal(body.ok, true);
});

test('GET /v1/registry/review hard-stops unknown observed agents', async () => {
  const { cp } = buildCp();
  const agent = completeAgent();
  await handleGatewayRequest('PUT', '/v1/registry/agents', mockReq(agent), cp, logger);
  const review = await handleGatewayRequest(
    'GET',
    '/v1/registry/review?observed=agent://aion/revenue/shadow/unknown',
    mockReq(),
    cp,
    logger,
  );
  assert.ok(review);
  assert.equal(review.status, 200);
  const body = review.body as {
    ok: boolean;
    findings: Array<{ code: string }>;
  };
  assert.equal(body.ok, false);
  assert.ok(body.findings.some((f) => f.code === 'unknown_agent'));
});
