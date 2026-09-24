/**
 * Production Operator Loop v1 — approval ↔ execution linkage + failure evidence.
 *
 * Proves, against an injected control plane (no live Postgres):
 *  A. A gated submit stamps the approval with executionId / tenantId / missionId.
 *  B. A human decision backfills that link on approvals requested before binding
 *     existed, without overwriting fields that are already set.
 *  C. A granted-then-failed execution carries an `execution.failed` audit entry
 *     with the executor's error on the Execution Object itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import {
  createHumanActor,
  capability,
  newApprovalId,
  newCommandId,
  newCorrelationId,
  newOutcomeId,
  newRequestId,
  newRunId,
  type ApprovalRequest,
  type Run,
} from '@aion/core';
import type { OutcomeRecord } from '@aion/data';
import type { ControlPlane } from './control-plane.js';
import { handleGatewayRequest } from './gateway.js';
import { Logger } from './logger.js';

const logger = new Logger(
  { service: 'aion-runtime-test', environment: 'test', gitSha: 'test', serviceVersion: '0.0.0' },
  'error',
);

const CAP = capability('crm.opportunity.update');
const MISSION = 'msn_operator_loop_fixture';

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

type ResumeOutcome = 'completed' | 'failed';

function buildControlPlane(opts: { resume: ResumeOutcome; failError?: { code: string; message: string } }) {
  const approvals = new Map<string, ApprovalRequest>();
  const executionsByRunId = new Map<string, Record<string, unknown>>();
  const runsById = new Map<string, Run>();
  const approver = createHumanActor({ name: 'Operator Fixture', permissions: [CAP] });
  const worker = createHumanActor({ name: 'Worker Fixture', permissions: [CAP] });
  const actors = new Map<string, unknown>([
    [approver.actorId, approver],
    [worker.actorId, worker],
  ]);

  const newRun = (state: Run['state'], missionId?: string): Run => {
    const now = new Date().toISOString();
    return {
      runId: newRunId(),
      requestId: newRequestId(),
      ...(missionId ? { missionId: missionId as Run['missionId'] } : {}),
      commandId: newCommandId(),
      actorId: worker.actorId,
      state,
      riskLevel: 'R2',
      correlationId: newCorrelationId(),
      createdAt: now,
      updatedAt: now,
    } as Run;
  };

  const cp = {
    dataLayer: {
      actors: {
        async get(id: string) {
          return actors.get(id);
        },
        async save() {},
      },
      runs: {
        async getByRequestId() {
          return undefined;
        },
        async save(run: Run) {
          runsById.set(run.runId, run);
        },
        async get(id: string) {
          return runsById.get(id);
        },
      },
      executions: {
        async getByRunId(runId: string) {
          return executionsByRunId.get(runId);
        },
        async save(e: Record<string, unknown>) {
          executionsByRunId.set(String(e['runId']), e);
        },
      },
      approvals: {
        async get(id: string) {
          return approvals.get(id);
        },
        async save(a: ApprovalRequest) {
          approvals.set(a.approvalId, a);
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
      outcomes: {
        async create(input: { runId: string; missionId?: string; status?: OutcomeRecord['status'] }) {
          const now = new Date().toISOString();
          return {
            outcomeId: newOutcomeId(),
            runId: input.runId,
            ...(input.missionId ? { missionId: input.missionId } : {}),
            status: input.status ?? 'pending',
            metadata: {},
            createdAt: now,
            updatedAt: now,
          } as OutcomeRecord;
        },
      },
    },
    orchestrator: {
      async submit(input: { missionId?: string; executionId?: string; requestId?: string }) {
        const run = { ...newRun('awaiting_approval', input.missionId) };
        const approval: ApprovalRequest = {
          approvalId: newApprovalId(),
          runId: run.runId,
          requestId: run.requestId,
          ...(input.missionId ? { missionId: input.missionId as ApprovalRequest['missionId'] } : {}),
          command: { actor: worker } as unknown as ApprovalRequest['command'],
          riskLevel: 'R2',
          reason: 'fixture gate',
          status: 'pending',
          requestedAt: run.createdAt,
        } as ApprovalRequest;
        approvals.set(approval.approvalId, approval);
        run.approvalId = approval.approvalId;
        runsById.set(run.runId, run);
        return {
          status: 'awaiting_approval' as const,
          run,
          command: { commandId: run.commandId, executionId: input.executionId },
          decision: { decision: 'REQUIRE_APPROVAL' as const, reason: 'fixture', riskLevel: 'R2' as const },
          approval,
        };
      },
      async resume(decision: { approvalId: string; approve: boolean; decidedBy: string }) {
        const a = approvals.get(decision.approvalId)!;
        const decided = {
          ...a,
          status: decision.approve ? 'granted' : 'rejected',
          decidedBy: decision.decidedBy,
          decidedAt: new Date().toISOString(),
        } as ApprovalRequest;
        approvals.set(a.approvalId, decided);
        const prior = runsById.get(a.runId)!;
        const run = { ...prior, state: opts.resume, updatedAt: new Date().toISOString() } as Run;
        runsById.set(run.runId, run);
        const now = new Date().toISOString();
        return {
          status: opts.resume,
          run,
          command: { commandId: run.commandId },
          decision: { decision: 'ALLOW' as const, reason: 'granted', riskLevel: 'R2' as const },
          result: {
            status: opts.resume === 'completed' ? 'succeeded' : 'failed',
            executor: 'ghl',
            ...(opts.failError ? { error: opts.failError } : {}),
            startedAt: now,
            completedAt: now,
            durationMs: 1,
            cost: { units: 3 },
            metadata: {},
          },
        };
      },
    },
    policyEngine: {
      authorize() {
        return { decision: 'ALLOW', reason: 'test' };
      },
    },
    missionOrchestrator: {},
    routingOverrides: new Map(),
    auth: { mode: 'open' as const, apiKeys: [] },
    async checkDatabase() {},
    async close() {},
  } as unknown as ControlPlane;

  return { cp, approvals, executionsByRunId, runsById, approver, worker, newRun };
}

test('A: gated submit stamps approval with executionId + missionId', async () => {
  const { cp, approvals, worker } = buildControlPlane({ resume: 'completed' });
  const res = await handleGatewayRequest(
    'POST',
    '/v1/commands',
    mockReq({ name: 'crm.opportunity.update', actor: worker, capability: CAP, missionId: MISSION }),
    cp,
    logger,
  );
  assert.ok(res);
  assert.equal(res.status, 202, JSON.stringify(res.body));
  const body = res.body as { approval: ApprovalRequest; execution: { executionId: string } };
  assert.equal(body.approval.executionId, body.execution.executionId, 'response approval is bound');
  const stored = approvals.get(body.approval.approvalId)!;
  assert.equal(stored.executionId, body.execution.executionId, 'persisted approval is bound');
  assert.equal(stored.missionId, MISSION);
});

test('B: decision backfills link on a legacy unbound approval, keeps existing fields', async () => {
  const { cp, approvals, executionsByRunId, runsById, approver, newRun } = buildControlPlane({
    resume: 'completed',
  });
  const run = newRun('awaiting_approval', MISSION);
  const legacy = {
    approvalId: newApprovalId(),
    runId: run.runId,
    requestId: run.requestId,
    tenantId: 'tenant_preexisting',
    command: { actor: { actorId: run.actorId } },
    riskLevel: 'R2',
    reason: 'legacy gate',
    status: 'pending',
    requestedAt: run.createdAt,
  } as unknown as ApprovalRequest;
  approvals.set(legacy.approvalId, legacy);
  runsById.set(run.runId, { ...run, approvalId: legacy.approvalId } as Run);
  executionsByRunId.set(run.runId, {
    executionId: 'exe_legacy_fixture',
    runId: run.runId,
    tenantId: 'tenant_from_execution',
    auditTrace: [],
  });

  const res = await handleGatewayRequest(
    'POST',
    `/v1/approvals/${legacy.approvalId}/decision`,
    mockReq({ approve: true, decidedBy: approver.actorId, actor: approver }),
    cp,
    logger,
  );
  assert.ok(res);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const stored = approvals.get(legacy.approvalId)!;
  assert.equal(stored.status, 'granted');
  assert.equal(stored.executionId, 'exe_legacy_fixture');
  assert.equal(stored.missionId, MISSION);
  assert.equal(stored.tenantId, 'tenant_preexisting', 'existing tenant is never overwritten');
});

test('C: granted-then-failed execution records the error in its audit trace', async () => {
  const failError = { code: 'ghl_http_422', message: 'Unprocessable Entity' };
  const { cp, approver, worker } = buildControlPlane({ resume: 'failed', failError });
  const submitted = await handleGatewayRequest(
    'POST',
    '/v1/commands',
    mockReq({ name: 'crm.opportunity.update', actor: worker, capability: CAP, missionId: MISSION }),
    cp,
    logger,
  );
  const approvalId = (submitted!.body as { approval: ApprovalRequest }).approval.approvalId;
  const res = await handleGatewayRequest(
    'POST',
    `/v1/approvals/${approvalId}/decision`,
    mockReq({ approve: true, decidedBy: approver.actorId, actor: approver }),
    cp,
    logger,
  );
  assert.ok(res);
  const exe = (res.body as { execution: { status: string; auditTrace: { event: string; detail: Record<string, unknown> }[] } })
    .execution;
  assert.equal(exe.status, 'failed');
  const failed = exe.auditTrace.find((e) => e.event === 'execution.failed');
  assert.ok(failed, `expected execution.failed in ${JSON.stringify(exe.auditTrace)}`);
  assert.deepEqual(failed.detail['error'], failError);
  assert.ok(
    exe.auditTrace.findIndex((e) => e.event === 'approval.granted') <
      exe.auditTrace.findIndex((e) => e.event === 'execution.failed'),
    'failure follows the grant in the trail',
  );
});

test('D: human-submitted gated command takes the caller tenant onto execution + approval', async () => {
  const { cp, approvals, approver, worker } = buildControlPlane({ resume: 'completed' });
  const submitted = await handleGatewayRequest(
    'POST',
    '/v1/commands',
    mockReq(
      { name: 'crm.opportunity.update', actor: worker, capability: CAP, missionId: MISSION },
      { 'x-aion-tenant-id': 'tenant_console' },
    ),
    cp,
    logger,
  );
  assert.ok(submitted);
  assert.equal(submitted.status, 202, JSON.stringify(submitted.body));
  const body = submitted.body as {
    approval: ApprovalRequest;
    execution: { tenantId?: string; metadata?: Record<string, unknown> };
  };
  assert.equal(body.execution.tenantId, 'tenant_console');
  assert.equal(approvals.get(body.approval.approvalId)!.tenantId, 'tenant_console');

  const decided = await handleGatewayRequest(
    'POST',
    `/v1/approvals/${body.approval.approvalId}/decision`,
    mockReq({ approve: true, decidedBy: approver.actorId, actor: approver }),
    cp,
    logger,
  );
  assert.equal(decided?.status, 200, JSON.stringify(decided?.body));
  const resumed = (decided!.body as { execution: { tenantId?: string } }).execution;
  assert.equal(resumed.tenantId, 'tenant_console', 'resumed execution keeps the tenant');
});

test('E: human submit cannot claim a tenant outside the principal binding', async () => {
  const { cp, approvals, worker } = buildControlPlane({ resume: 'completed' });
  (cp as { auth: ControlPlane['auth'] }).auth = {
    mode: 'required',
    apiKeys: [
      {
        token: 'tok_fixture_worker',
        principal: {
          principalId: 'principal_worker',
          kind: 'operator',
          actorId: worker.actorId,
          tenantIds: ['tenant_a'],
          roles: ['invoke'],
        },
      },
    ],
  };

  const denied = await handleGatewayRequest(
    'POST',
    '/v1/commands',
    mockReq(
      { name: 'crm.opportunity.update', actor: worker, capability: CAP, missionId: MISSION },
      { authorization: 'Bearer tok_fixture_worker', 'x-aion-tenant-id': 'tenant_b' },
    ),
    cp,
    logger,
  );
  assert.ok(denied);
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  assert.equal((denied.body as { error: string }).error, 'tenant_forbidden');
  assert.equal(approvals.size, 0, 'nothing was submitted');

  const allowed = await handleGatewayRequest(
    'POST',
    '/v1/commands',
    mockReq(
      { name: 'crm.opportunity.update', actor: worker, capability: CAP, missionId: MISSION },
      { authorization: 'Bearer tok_fixture_worker', 'x-aion-tenant-id': 'tenant_a' },
    ),
    cp,
    logger,
  );
  assert.equal(allowed?.status, 202, JSON.stringify(allowed?.body));
  assert.equal((allowed!.body as { execution: { tenantId?: string } }).execution.tenantId, 'tenant_a');
});
