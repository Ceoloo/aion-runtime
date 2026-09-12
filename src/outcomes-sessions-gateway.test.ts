/**
 * Focused gateway proof: durable outcomes + revenue sessions via injected
 * control-plane data layer (no live Postgres). Exercises create / get / list /
 * patch for outcomes and create / checkpoint / finalize / reload / list for
 * revenue sessions — including stale-revision 409.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { newOutcomeId, newRunId, type ExecutionObject } from '@aion/core';
import { NotFoundError, type OutcomeRecord } from '@aion/data';
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

function mockReq(body?: unknown): IncomingMessage {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const chunks = raw ? [Buffer.from(raw)] : [];
  let i = 0;
  return {
    headers: {},
    async *[Symbol.asyncIterator]() {
      while (i < chunks.length) yield chunks[i++]!;
    },
  } as IncomingMessage;
}

function buildMockControlPlane(): {
  cp: ControlPlane;
  executions: Map<string, ExecutionObject>;
} {
  const outcomes = new Map<string, OutcomeRecord>();
  const sessions = new Map<
    string,
    { sessionId: string; checkpoint: unknown; finalRecord: unknown; revision: number }
  >();
  const executions = new Map<string, ExecutionObject>();

  const cp = {
    dataLayer: {
      outcomes: {
        async create(input: {
          runId: string;
          missionId?: string;
          status?: OutcomeRecord['status'];
          outcomeType?: string;
          externalReference?: string;
          value?: number;
          currency?: string;
          measuredAt?: string;
          metadata?: Record<string, unknown>;
        }): Promise<OutcomeRecord> {
          const now = new Date().toISOString();
          const outcome: OutcomeRecord = {
            outcomeId: newOutcomeId(),
            runId: input.runId as OutcomeRecord['runId'],
            ...(input.missionId
              ? { missionId: input.missionId as OutcomeRecord['missionId'] }
              : {}),
            status: input.status ?? 'pending',
            ...(input.outcomeType ? { outcomeType: input.outcomeType } : {}),
            ...(input.externalReference
              ? { externalReference: input.externalReference }
              : {}),
            ...(input.value !== undefined ? { value: input.value } : {}),
            ...(input.currency ? { currency: input.currency } : {}),
            ...(input.measuredAt ? { measuredAt: input.measuredAt } : {}),
            metadata: input.metadata ?? {},
            createdAt: now,
            updatedAt: now,
          };
          outcomes.set(outcome.outcomeId, outcome);
          return outcome;
        },
        async get(id: string): Promise<OutcomeRecord | undefined> {
          return outcomes.get(id);
        },
        async listByRun(runId: string): Promise<OutcomeRecord[]> {
          return [...outcomes.values()].filter((o) => o.runId === runId);
        },
        async listByMission(missionId: string): Promise<OutcomeRecord[]> {
          return [...outcomes.values()].filter((o) => o.missionId === missionId);
        },
        async update(
          id: string,
          patch: Partial<OutcomeRecord>,
        ): Promise<OutcomeRecord> {
          const existing = outcomes.get(id);
          if (!existing) {
            throw new NotFoundError(`outcome "${id}" not found`, { outcomeId: id });
          }
          const updated: OutcomeRecord = {
            ...existing,
            ...patch,
            updatedAt: new Date().toISOString(),
          };
          outcomes.set(id, updated);
          return updated;
        },
      },
      revenueSessions: {
        async get(sessionId: string) {
          return sessions.get(sessionId);
        },
        async create(sessionId: string, checkpoint: unknown) {
          if (sessions.has(sessionId)) {
            throw new Error('duplicate key value violates unique constraint');
          }
          sessions.set(sessionId, {
            sessionId,
            checkpoint,
            finalRecord: null,
            revision: 0,
          });
        },
        async save(row: {
          sessionId: string;
          checkpoint: unknown;
          finalRecord: unknown;
          revision: number;
        }) {
          const existing = sessions.get(row.sessionId);
          if (
            !existing ||
            existing.revision !== row.revision ||
            existing.finalRecord !== null
          ) {
            throw new Error('stale or finalized revenue session');
          }
          sessions.set(row.sessionId, {
            sessionId: row.sessionId,
            checkpoint: row.checkpoint,
            finalRecord: row.finalRecord,
            revision: existing.revision + 1,
          });
        },
        async listActive(): Promise<string[]> {
          return [...sessions.values()]
            .filter((s) => s.checkpoint !== null && s.finalRecord === null)
            .map((s) => s.sessionId);
        },
        async listFinalized(): Promise<unknown[]> {
          return [...sessions.values()]
            .filter((s) => s.finalRecord !== null)
            .map((s) => s.finalRecord);
        },
      },
      executions: {
        async getByRunId(runId: string) {
          return [...executions.values()].find((e) => e.runId === runId);
        },
        async save(exe: ExecutionObject) {
          executions.set(exe.executionId, exe);
        },
      },
    },
    // Open mode: these proofs cover outcomes/sessions, not authn.
    auth: { mode: 'open' as const, apiKeys: [] },
  } as unknown as ControlPlane;

  return { cp, executions };
}

test('outcomes: create, get, list, patch + optional execution link', async () => {
  const { cp, executions } = buildMockControlPlane();
  const runId = newRunId();
  executions.set('exe_link_test', {
    executionId: 'exe_link_test',
    actorId: 'act_test',
    runId,
    requestId: 'req_test',
    commandId: 'cmd_test',
    correlationId: 'cor_test',
    status: 'succeeded',
    autonomyLevel: 'L1',
    cost: { units: 1 },
    auditTrace: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {},
  } as unknown as ExecutionObject);

  const created = await handleGatewayRequest(
    'POST',
    '/v1/outcomes',
    mockReq({
      runId,
      status: 'pending',
      outcomeType: 'revenue',
      value: 5000,
      currency: 'USD',
    }),
    cp,
    logger,
  );
  assert.equal(created?.status, 201);
  const outcome = (created?.body as { outcome: OutcomeRecord }).outcome;
  assert.ok(outcome.outcomeId.startsWith('out_'));
  assert.equal(outcome.runId, runId);
  assert.equal(outcome.value, 5000);

  const linked = executions.get('exe_link_test');
  assert.equal(linked?.outcomeId, outcome.outcomeId);

  const got = await handleGatewayRequest(
    'GET',
    `/v1/outcomes/${outcome.outcomeId}`,
    mockReq(),
    cp,
    logger,
  );
  assert.equal(got?.status, 200);

  const listed = await handleGatewayRequest(
    'GET',
    `/v1/outcomes?runId=${encodeURIComponent(runId)}`,
    mockReq(),
    cp,
    logger,
  );
  assert.equal(listed?.status, 200);
  assert.equal((listed?.body as { count: number }).count, 1);

  const patched = await handleGatewayRequest(
    'PATCH',
    `/v1/outcomes/${outcome.outcomeId}`,
    mockReq({ status: 'realized', measuredAt: '2026-09-12T00:00:00.000Z' }),
    cp,
    logger,
  );
  assert.equal(patched?.status, 200);
  assert.equal(
    (patched?.body as { outcome: OutcomeRecord }).outcome.status,
    'realized',
  );
});

test('outcomes: reject product-forked status values (e.g. cancelled)', async () => {
  const { cp } = buildMockControlPlane();
  const rejected = await handleGatewayRequest(
    'POST',
    '/v1/outcomes',
    mockReq({
      runId: newRunId(),
      status: 'cancelled',
      outcomeType: 'revenue.call',
    }),
    cp,
    logger,
  );
  assert.equal(rejected?.status, 400);
  assert.equal(
    (rejected?.body as { error: string }).error,
    'invalid_status',
  );
});

test('revenue sessions: create, checkpoint, finalize, reload, stale 409', async () => {
  const { cp } = buildMockControlPlane();
  const sessionId = 'rev_sess_proof_001';

  const created = await handleGatewayRequest(
    'POST',
    '/v1/revenue-sessions',
    mockReq({
      sessionId,
      checkpoint: { version: 1, stage: 'intake', leadId: 'L-1' },
    }),
    cp,
    logger,
  );
  assert.equal(created?.status, 201);
  assert.equal(
    (created?.body as { session: { revision: number } }).session.revision,
    0,
  );

  const checkpointed = await handleGatewayRequest(
    'PUT',
    `/v1/revenue-sessions/${sessionId}`,
    mockReq({
      revision: 0,
      checkpoint: { version: 1, stage: 'qualified', leadId: 'L-1' },
    }),
    cp,
    logger,
  );
  assert.equal(checkpointed?.status, 200);
  assert.equal(
    (checkpointed?.body as { session: { revision: number } }).session.revision,
    1,
  );

  const stale = await handleGatewayRequest(
    'PUT',
    `/v1/revenue-sessions/${sessionId}`,
    mockReq({
      revision: 0,
      checkpoint: { version: 1, stage: 'stale-writer' },
    }),
    cp,
    logger,
  );
  assert.equal(stale?.status, 409);

  const finalized = await handleGatewayRequest(
    'PUT',
    `/v1/revenue-sessions/${sessionId}`,
    mockReq({
      revision: 1,
      finalRecord: { closed: true, amount: 1200 },
    }),
    cp,
    logger,
  );
  assert.equal(finalized?.status, 200);
  const finalizedSession = (
    finalized?.body as {
      session: { finalRecord: unknown; checkpoint: unknown };
    }
  ).session;
  assert.deepEqual(finalizedSession.finalRecord, { closed: true, amount: 1200 });
  assert.equal(finalizedSession.checkpoint, null);

  const reloaded = await handleGatewayRequest(
    'GET',
    `/v1/revenue-sessions/${sessionId}`,
    mockReq(),
    cp,
    logger,
  );
  assert.equal(reloaded?.status, 200);
  assert.ok(
    (reloaded?.body as { session: { finalRecord: unknown } }).session.finalRecord,
  );

  const afterFinal = await handleGatewayRequest(
    'PUT',
    `/v1/revenue-sessions/${sessionId}`,
    mockReq({ revision: 2, checkpoint: { nope: true } }),
    cp,
    logger,
  );
  assert.equal(afterFinal?.status, 409);

  const active = await handleGatewayRequest(
    'GET',
    '/v1/revenue-sessions?status=active',
    mockReq(),
    cp,
    logger,
  );
  assert.equal(active?.status, 200);
  assert.ok(
    !((active?.body as { sessionIds: string[] }).sessionIds).includes(sessionId),
  );

  const finalizedList = await handleGatewayRequest(
    'GET',
    '/v1/revenue-sessions?status=finalized',
    mockReq(),
    cp,
    logger,
  );
  assert.equal(finalizedList?.status, 200);
  assert.equal((finalizedList?.body as { count: number }).count, 1);
});
