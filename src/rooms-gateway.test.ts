/**
 * Shared room gateway: humans and agents on one timeline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import {
  SharedRoom,
  createAgentActor,
  createAgentHandoff,
  createHumanActor,
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

function human(name = 'Ada') {
  return createHumanActor({ name });
}

function agent(tenantId = TENANT, name = 'Scout'): AgentActor {
  return createAgentActor({
    name,
    purpose: 'watch the room',
    owner: 'Ada',
    domain: 'revenue',
    role: 'scout',
    tenantId,
    permissions: [],
    revocationState: 'active',
  });
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
    },
    auth: { mode: 'open' as const, apiKeys: [] },
    rooms: new SharedRoom(),
  } as unknown as ControlPlane;
  return { cp, actors };
}

test('a human and an agent share one room timeline', async () => {
  const { cp } = buildCp();
  const ada = human();
  const scout = agent();

  const opened = await handleGatewayRequest(
    'POST',
    '/v1/rooms',
    mockReq({
      name: 'Incidents',
      purpose: 'production errors and the people who own them',
      visibility: 'private',
      founder: ada,
    }),
    cp,
    logger,
  );
  assert.ok(opened);
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  const roomId = (opened.body as { room: { roomId: string } }).room.roomId;

  const admitted = await handleGatewayRequest(
    'POST',
    `/v1/rooms/${roomId}/members`,
    mockReq({ by: ada, actor: scout }),
    cp,
    logger,
  );
  assert.ok(admitted);
  assert.equal(admitted.status, 200, JSON.stringify(admitted.body));

  const entered = await handleGatewayRequest(
    'POST',
    `/v1/rooms/${roomId}/enter`,
    mockReq({ actor: scout }),
    cp,
    logger,
  );
  assert.ok(entered);
  assert.equal(entered.status, 200, JSON.stringify(entered.body));

  const said = await handleGatewayRequest(
    'POST',
    `/v1/rooms/${roomId}/posts`,
    mockReq({
      actor: ada,
      post: { kind: 'say', statement: 'have we seen this error?', mentions: [scout.actorId] },
    }),
    cp,
    logger,
  );
  assert.ok(said);
  assert.equal(said.status, 201, JSON.stringify(said.body));

  const handed = await handleGatewayRequest(
    'POST',
    `/v1/rooms/${roomId}/posts`,
    mockReq({
      actor: scout,
      post: {
        kind: 'handoff',
        handoff: createAgentHandoff({
          kind: 'delegation',
          need: 'check the march outage',
          confidence: 0.9,
          fromAgentId: scout.agentId,
          toAgentId: scout.agentId,
        }),
      },
    }),
    cp,
    logger,
  );
  assert.ok(handed);
  assert.equal(handed.status, 201, JSON.stringify(handed.body));
  assert.equal((handed.body as { authorType: string }).authorType, 'agent');

  const view = await handleGatewayRequest(
    'GET',
    `/v1/rooms/${roomId}?actorId=${encodeURIComponent(ada.actorId)}`,
    mockReq(),
    cp,
    logger,
  );
  assert.ok(view);
  assert.equal(view.status, 200, JSON.stringify(view.body));
  const timeline = (view.body as { timeline: Array<{ kind: string; authorType: string }> }).timeline;
  assert.deepEqual(
    timeline.map((entry) => entry.kind),
    ['presence', 'presence', 'say', 'handoff'],
  );
  assert.deepEqual(
    [...new Set(timeline.map((entry) => entry.authorType))].sort(),
    ['agent', 'human'],
  );

  const attention = await handleGatewayRequest(
    'GET',
    `/v1/rooms/${roomId}/attention?actorId=${encodeURIComponent(scout.actorId)}`,
    mockReq(),
    cp,
    logger,
  );
  assert.ok(attention);
  assert.equal(attention.status, 200, JSON.stringify(attention.body));
  assert.deepEqual(
    (attention.body as { attention: Array<{ kind: string }> }).attention.map((entry) => entry.kind),
    ['say', 'handoff'],
  );
});

test('an outsider cannot read the room and a revoked agent cannot be admitted', async () => {
  const { cp, actors } = buildCp();
  const ada = human();
  const scout = agent();
  const revoked = agent(TENANT, 'Revoked');
  actors.set(scout.actorId, scout);
  actors.set(revoked.actorId, { ...revoked, revocationState: 'revoked' });

  const opened = await handleGatewayRequest(
    'POST',
    '/v1/rooms',
    mockReq({ name: 'Incidents', purpose: 'closed', founder: ada }),
    cp,
    logger,
  );
  assert.ok(opened);
  const roomId = (opened.body as { room: { roomId: string } }).room.roomId;

  const peek = await handleGatewayRequest(
    'GET',
    `/v1/rooms/${roomId}?actorId=${encodeURIComponent(scout.actorId)}`,
    mockReq(),
    cp,
    logger,
  );
  assert.ok(peek);
  assert.equal(peek.status, 403, JSON.stringify(peek.body));
  assert.equal((peek.body as { error: string }).error, 'permission_denied');

  const blocked = await handleGatewayRequest(
    'POST',
    `/v1/rooms/${roomId}/members`,
    mockReq({ by: ada, actor: revoked }),
    cp,
    logger,
  );
  assert.ok(blocked);
  assert.equal(blocked.status, 403, JSON.stringify(blocked.body));
  assert.equal((blocked.body as { error: string }).error, 'agent_revoked');
});

test('an agent from another tenant cannot join', async () => {
  const { cp } = buildCp();
  const ada = human();
  const other = agent('other-tenant', 'Other');
  const opened = await handleGatewayRequest(
    'POST',
    '/v1/rooms',
    mockReq({
      name: 'Floor',
      purpose: 'same tenant only',
      visibility: 'open',
      founder: ada,
    }),
    cp,
    logger,
  );
  assert.ok(opened);
  const roomId = (opened.body as { room: { roomId: string } }).room.roomId;
  const joined = await handleGatewayRequest(
    'POST',
    `/v1/rooms/${roomId}/join`,
    mockReq({ actor: other }),
    cp,
    logger,
  );
  assert.ok(joined);
  assert.equal(joined.status, 403, JSON.stringify(joined.body));
  assert.equal((joined.body as { error: string }).error, 'tenant_forbidden');
});
