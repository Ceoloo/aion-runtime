/**
 * AIO-47 Continuous Assurance gateway surface (in-memory Data mock).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import {
  createAgentActor,
  createRootAuthority,
  capability,
  type Actor,
  type AgentActor,
  type ExecutionObject,
} from '@aion/core';
import type { ControlPlane } from './control-plane.js';
import { handleGatewayRequest } from './gateway.js';
import { Logger } from './logger.js';
import { clearAssuranceEvidenceStore } from './assurance.js';

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
const NOW = '2026-10-07T12:00:00.000Z';

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

function completeAgent(overrides: Partial<AgentActor> = {}): AgentActor {
  const authority = createRootAuthority({
    subject: { kind: 'human', ref: 'dana@aion.systems' },
    tenantId: TENANT,
    grantReason: 'assurance fixture',
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
    ...overrides,
  };
}

function buildCp(executions: ExecutionObject[] = []) {
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
          return executions;
        },
      },
    },
    auth: { mode: 'open' as const, apiKeys: [] },
    async checkDatabase() {
      /* healthy */
    },
  } as unknown as ControlPlane;
  return { cp, actors };
}

beforeEach(() => {
  clearAssuranceEvidenceStore();
});

test('GET /v1/assurance/catalog returns SIS-CA-01 catalog with prototype ids', async () => {
  const { cp } = buildCp();
  const res = await handleGatewayRequest(
    'GET',
    '/v1/assurance/catalog',
    mockReq(),
    cp,
    logger,
  );
  assert.ok(res);
  assert.equal(res.status, 200);
  const body = res.body as {
    standard: string;
    prototypeCheckIds: string[];
    count: number;
  };
  assert.equal(body.standard, 'SIS-CA-01');
  assert.ok(body.prototypeCheckIds.includes('CA-AG-01'));
  assert.ok(body.prototypeCheckIds.includes('CA-RV-02'));
  assert.ok(body.count >= 20);
});

test('POST /v1/assurance/run passes prototype checks for a clean tenant', async () => {
  const { cp } = buildCp();
  const agent = completeAgent();
  await handleGatewayRequest('PUT', '/v1/registry/agents', mockReq(agent), cp, logger);

  const res = await handleGatewayRequest(
    'POST',
    '/v1/assurance/run',
    mockReq({
      checkIds: ['CA-AG-01', 'CA-AG-02', 'CA-AG-03', 'CA-AG-04', 'CA-RT-01', 'CA-RV-02'],
      observedAgentIds: [agent.agentUri],
      now: NOW,
    }),
    cp,
    logger,
  );
  assert.ok(res);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as {
    failCount: number;
    passCount: number;
    evidence: Array<{ checkId: string; status: string; evidenceId: string }>;
  };
  assert.equal(body.failCount, 0);
  assert.equal(body.passCount, 6);
  assert.equal(body.evidence.length, 6);
  assert.ok(body.evidence.every((e) => e.evidenceId.startsWith('cae_')));
});

test('POST /v1/assurance/run fails CA-AG-02 for unknown observed agents', async () => {
  const { cp } = buildCp();
  const agent = completeAgent();
  await handleGatewayRequest('PUT', '/v1/registry/agents', mockReq(agent), cp, logger);

  const res = await handleGatewayRequest(
    'POST',
    '/v1/assurance/run',
    mockReq({
      checkIds: ['CA-AG-02'],
      observedAgentIds: ['agent://aion/revenue/shadow/unknown'],
      now: NOW,
    }),
    cp,
    logger,
  );
  assert.ok(res);
  assert.equal(res.status, 200);
  const body = res.body as {
    failCount: number;
    evidence: Array<{ checkId: string; status: string; severity: string }>;
  };
  assert.equal(body.failCount, 1);
  assert.equal(body.evidence[0]!.checkId, 'CA-AG-02');
  assert.equal(body.evidence[0]!.status, 'fail');
  assert.equal(body.evidence[0]!.severity, 'critical');
});

test('GET /v1/assurance/evidence lists stored results after a run', async () => {
  const { cp } = buildCp();
  await handleGatewayRequest(
    'POST',
    '/v1/assurance/run',
    mockReq({ checkIds: ['CA-RT-01'], now: NOW }),
    cp,
    logger,
  );
  const res = await handleGatewayRequest(
    'GET',
    '/v1/assurance/evidence?checkId=CA-RT-01',
    mockReq(),
    cp,
    logger,
  );
  assert.ok(res);
  assert.equal(res.status, 200);
  const body = res.body as { count: number; evidence: Array<{ checkId: string }> };
  assert.equal(body.count, 1);
  assert.equal(body.evidence[0]!.checkId, 'CA-RT-01');
});
