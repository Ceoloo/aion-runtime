/**
 * QA-G2 — concurrent submit race at POST /v1/commands.
 *
 * Proves N parallel submits sharing the same requestId coalesce to one
 * orchestrator.submit / one run. Sequential requestId replay is covered by
 * Mission 001 PASS C; this closes the concurrent TOCTOU gap.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import {
  createHumanActor,
  capability,
  newRunId,
  newCommandId,
  newCorrelationId,
  newRequestId,
  type Run,
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

const CAP = capability('infra.smoke');

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildRaceControlPlane(): {
  cp: ControlPlane;
  submitCount: () => number;
  runCount: () => number;
} {
  const runsByRequestId = new Map<string, Run>();
  const runsById = new Map<string, Run>();
  const executionsByRunId = new Map<string, unknown>();
  let submits = 0;

  const runs = {
    async getByRequestId(requestId: string) {
      // Widen the former TOCTOU window so missing coalescing fails loudly.
      await delay(25);
      return runsByRequestId.get(requestId);
    },
    async save(run: Run) {
      await delay(10);
      runsById.set(run.runId, run);
      runsByRequestId.set(String(run.requestId), run);
    },
    async get(runId: string) {
      return runsById.get(runId);
    },
  };

  const cp = {
    dataLayer: {
      actors: {
        async save() {
          /* attribution only */
        },
      },
      runs,
      executions: {
        async getByRunId(runId: string) {
          return executionsByRunId.get(runId);
        },
        async save(execution: { runId: string }) {
          executionsByRunId.set(execution.runId, execution);
        },
      },
      approvals: {
        async get() {
          return undefined;
        },
      },
      services: {
        async getByKey() {
          return undefined;
        },
      },
      autonomyGrants: {
        async getActive() {
          return undefined;
        },
      },
    },
    orchestrator: {
      async submit(input: {
        requestId?: string;
        name: string;
        actor: { actorId: string };
        capability: string;
      }) {
        submits += 1;
        // Hold the leader in submit long enough that siblings hit the inflight map.
        await delay(80);
        const now = new Date().toISOString();
        const run = {
          runId: newRunId(),
          requestId: input.requestId ?? newRequestId(),
          commandId: newCommandId(),
          actorId: input.actor.actorId,
          state: 'completed',
          correlationId: newCorrelationId(),
          createdAt: now,
          updatedAt: now,
        } as Run;
        await runs.save(run);
        return {
          status: 'completed' as const,
          run,
          command: {
            commandId: run.commandId,
            executionId: undefined,
            parentExecutionId: undefined,
            rootExecutionId: undefined,
          },
          decision: {
            decision: 'ALLOW' as const,
            reason: 'test-allow',
            riskLevel: 'R0' as const,
          },
          result: {
            status: 'succeeded' as const,
            output: { ok: true },
            cost: { units: 1 },
            model: 'test',
            metadata: {},
          },
        };
      },
      async getRun(runId: string) {
        return runsById.get(runId);
      },
    },
    policyEngine: {
      authorize() {
        return { decision: 'ALLOW', reason: 'test' };
      },
    },
    missionOrchestrator: {},
    routingOverrides: new Map(),
    async checkDatabase() {},
    async close() {},
  } as unknown as ControlPlane;

  return {
    cp,
    submitCount: () => submits,
    runCount: () => runsById.size,
  };
}

test('QA-G2: concurrent same requestId → one submit, one run, losers replay', async () => {
  const { cp, submitCount, runCount } = buildRaceControlPlane();
  const actor = createHumanActor({
    name: 'QA Concurrency',
    permissions: [CAP],
  });
  const requestId = newRequestId();
  const body = {
    name: 'qa-g2.concurrent-submit',
    actor,
    capability: CAP,
    requestId,
    payload: { proof: 'QA-G2' },
  };

  const responses = await Promise.all(
    Array.from({ length: 8 }, () =>
      handleGatewayRequest('POST', '/v1/commands', mockReq(body), cp, logger),
    ),
  );

  assert.equal(submitCount(), 1, 'orchestrator.submit must run exactly once');
  assert.equal(runCount(), 1, 'exactly one run must be persisted');

  const bodies = responses.map((r) => {
    assert.ok(r, 'gateway must handle /v1/commands');
    assert.equal(r.status, 200, `unexpected status ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body as {
      status: string;
      run: { runId: string; requestId: string };
      idempotentReplay?: boolean;
    };
  });

  const runIds = new Set(bodies.map((b) => b.run.runId));
  assert.equal(runIds.size, 1, 'all responses must share the same runId');
  assert.ok(
    bodies.every((b) => b.run.requestId === requestId),
    'all responses must echo the shared requestId',
  );

  const leaders = bodies.filter((b) => b.idempotentReplay !== true);
  const replays = bodies.filter((b) => b.idempotentReplay === true);
  assert.equal(leaders.length, 1, 'exactly one leader response (non-replay)');
  assert.equal(replays.length, 7, 'remaining responses must be idempotent replays');
});

test('QA-G2: sequential same requestId still replays without a second submit', async () => {
  const { cp, submitCount, runCount } = buildRaceControlPlane();
  const actor = createHumanActor({
    name: 'QA Sequential',
    permissions: [CAP],
  });
  const requestId = newRequestId();
  const body = {
    name: 'qa-g2.sequential-submit',
    actor,
    capability: CAP,
    requestId,
  };

  const first = await handleGatewayRequest('POST', '/v1/commands', mockReq(body), cp, logger);
  const second = await handleGatewayRequest('POST', '/v1/commands', mockReq(body), cp, logger);

  assert.equal(first?.status, 200);
  assert.equal(second?.status, 200);
  assert.equal(submitCount(), 1);
  assert.equal(runCount(), 1);

  const a = first!.body as { run: { runId: string }; idempotentReplay?: boolean };
  const b = second!.body as { run: { runId: string }; idempotentReplay?: boolean };
  assert.equal(a.run.runId, b.run.runId);
  assert.notEqual(a.idempotentReplay, true);
  assert.equal(b.idempotentReplay, true);
});
