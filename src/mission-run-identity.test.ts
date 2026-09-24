/**
 * POST /v1/missions/run — identity plane + tenant scoping.
 *
 * Proves, against an injected control plane (no live Postgres):
 *  A. The request body can no longer overwrite a registered actor: durable
 *     grants win and are what the mission orchestrator runs with.
 *  B. A principal can only run missions as its bound actor.
 *  C. A human-run mission takes the caller tenant onto every step execution
 *     and binds a gated step's approval to its execution/tenant/mission.
 *  D. A tenant header outside the principal's binding is denied.
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
  newRequestId,
  newRunId,
  type Actor,
  type ApprovalRequest,
  type Run,
} from '@aion/core';
import type { ControlPlane } from './control-plane.js';
import { handleGatewayRequest } from './gateway.js';
import { Logger } from './logger.js';

const logger = new Logger(
  { service: 'aion-runtime-test', environment: 'test', gitSha: 'test', serviceVersion: '0.0.0' },
  'error',
);

const CAP = capability('crm.opportunity.update');
const MISSION = 'msn_mission_run_fixture';
const WORKFLOW = 'wfl_mission_run_fixture';

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

function buildControlPlane() {
  const actors = new Map<string, Actor>();
  const approvals = new Map<string, ApprovalRequest>();
  const executions = new Map<string, Record<string, unknown>>();
  const orchestratorActors: Actor[] = [];

  const cp = {
    dataLayer: {
      actors: {
        async get(id: string) {
          return actors.get(id);
        },
        async save(a: Actor) {
          actors.set(a.actorId, a);
        },
      },
      executions: {
        async getByRunId(runId: string) {
          return [...executions.values()].find((e) => e['runId'] === runId);
        },
        async save(e: Record<string, unknown>) {
          executions.set(String(e['executionId']), e);
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
    },
    missionOrchestrator: {
      async run(input: { actor: Actor; missionId?: string }) {
        orchestratorActors.push(input.actor);
        const now = new Date().toISOString();
        const run = {
          runId: newRunId(),
          requestId: newRequestId(),
          missionId: input.missionId,
          commandId: newCommandId(),
          actorId: input.actor.actorId,
          state: 'awaiting_approval',
          riskLevel: 'R2',
          correlationId: newCorrelationId(),
          createdAt: now,
          updatedAt: now,
        } as Run;
        const approval = {
          approvalId: newApprovalId(),
          runId: run.runId,
          requestId: run.requestId,
          command: { actor: input.actor },
          riskLevel: 'R2',
          reason: 'fixture gate',
          status: 'pending',
          requestedAt: now,
        } as unknown as ApprovalRequest;
        approvals.set(approval.approvalId, approval);
        return {
          status: 'awaiting_approval' as const,
          rootExecutionId: 'exe_root_fixture',
          stoppedAtStep: 0,
          mission: { missionId: input.missionId },
          workflow: { workflowId: WORKFLOW },
          steps: [
            {
              stepIndex: 0,
              step: { name: 'update opportunity', capability: CAP },
              status: 'awaiting_approval' as const,
              executionId: 'exe_step_fixture',
              rootExecutionId: 'exe_root_fixture',
              orchestration: { run, approval },
            },
          ],
        };
      },
    },
    auth: { mode: 'open' as const, apiKeys: [] },
  } as unknown as ControlPlane;

  return { cp, actors, approvals, executions, orchestratorActors };
}

function requireAuth(cp: ControlPlane, actorId: string, tenantIds: string[]) {
  (cp as { auth: ControlPlane['auth'] }).auth = {
    mode: 'required',
    apiKeys: [
      {
        token: 'tok_mission_run_fixture',
        principal: {
          principalId: 'principal_mission_run',
          kind: 'operator',
          actorId,
          tenantIds,
          roles: ['invoke'],
        },
      },
    ],
  };
}

const runBody = (actor: Actor) => ({ actor, missionId: MISSION, workflowId: WORKFLOW });

test('A: body cannot overwrite a registered actor; durable grants are used', async () => {
  const { cp, actors, orchestratorActors } = buildControlPlane();
  const registered = createHumanActor({ name: 'Registered Operator', permissions: [CAP] });
  actors.set(registered.actorId, registered);

  const escalated = {
    ...registered,
    permissions: [CAP, capability('production.deploy')],
  } as Actor;
  const res = await handleGatewayRequest('POST', '/v1/missions/run', mockReq(runBody(escalated)), cp, logger);
  assert.ok(res);
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.deepEqual(
    actors.get(registered.actorId)!.permissions.map(String),
    [String(CAP)],
    'stored actor is unchanged',
  );
  assert.deepEqual(
    orchestratorActors[0]!.permissions.map(String),
    [String(CAP)],
    'orchestrator ran with the durable grants, not the body',
  );
});

test('B: a principal cannot run a mission as another actor', async () => {
  const { cp, actors, orchestratorActors } = buildControlPlane();
  const bound = createHumanActor({ name: 'Bound Operator', permissions: [CAP] });
  const other = createHumanActor({ name: 'Other Operator', permissions: [CAP] });
  actors.set(bound.actorId, bound);
  actors.set(other.actorId, other);
  requireAuth(cp, bound.actorId, ['tenant_a']);

  const res = await handleGatewayRequest(
    'POST',
    '/v1/missions/run',
    mockReq(runBody(other), { authorization: 'Bearer tok_mission_run_fixture' }),
    cp,
    logger,
  );
  assert.equal(res?.status, 403, JSON.stringify(res?.body));
  assert.equal((res?.body as { error: string }).error, 'actor_forbidden');
  assert.equal(orchestratorActors.length, 0, 'nothing ran');
});

test('C: human-run mission stamps the caller tenant and binds the gated step approval', async () => {
  const { cp, actors, approvals, executions } = buildControlPlane();
  const operator = createHumanActor({ name: 'Console Operator', permissions: [CAP] });
  actors.set(operator.actorId, operator);

  const res = await handleGatewayRequest(
    'POST',
    '/v1/missions/run',
    mockReq(runBody(operator), { 'x-aion-tenant-id': 'tenant_console' }),
    cp,
    logger,
  );
  assert.equal(res?.status, 202, JSON.stringify(res?.body));
  const step = (res!.body as { steps: { executionId: string; approvalId: string }[] }).steps[0]!;
  assert.equal(executions.get(step.executionId)?.['tenantId'], 'tenant_console');
  const approval = approvals.get(step.approvalId)!;
  assert.equal(approval.executionId, step.executionId);
  assert.equal(approval.tenantId, 'tenant_console');
  assert.equal(approval.missionId, MISSION);
});

test('D: tenant header outside the principal binding is denied', async () => {
  const { cp, actors, orchestratorActors } = buildControlPlane();
  const operator = createHumanActor({ name: 'Tenant A Operator', permissions: [CAP] });
  actors.set(operator.actorId, operator);
  requireAuth(cp, operator.actorId, ['tenant_a']);

  const res = await handleGatewayRequest(
    'POST',
    '/v1/missions/run',
    mockReq(runBody(operator), {
      authorization: 'Bearer tok_mission_run_fixture',
      'x-aion-tenant-id': 'tenant_b',
    }),
    cp,
    logger,
  );
  assert.equal(res?.status, 403, JSON.stringify(res?.body));
  assert.equal((res?.body as { error: string }).error, 'tenant_forbidden');
  assert.equal(orchestratorActors.length, 0, 'nothing ran');
});
