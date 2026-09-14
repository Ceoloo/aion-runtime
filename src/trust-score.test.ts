/**
 * Unit tests for Trust Score attach/persist helpers (ADR-006).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAgentActor,
  createExecutionObject,
  capability,
  newRunId,
  newRequestId,
  newCommandId,
  newCorrelationId,
  type Run,
  type EvaluationResult,
  newEvaluationId,
  newExecutionId,
} from '@aion/core';
import {
  attachAgentTrustScore,
  isTerminalExecutionStatus,
  persistExecutionWithTrustScore,
  readAgentTrustScore,
} from './trust-score.js';

function deniedRun(): Run {
  const now = '2026-09-14T17:00:00.000Z';
  return {
    runId: newRunId(),
    requestId: newRequestId(),
    commandId: newCommandId(),
    actorId: createAgentActor({
      name: 'tmp',
      purpose: 't',
      owner: 'p',
      permissions: [],
    }).actorId,
    state: 'denied',
    correlationId: newCorrelationId(),
    createdAt: now,
    updatedAt: now,
  };
}

test('isTerminalExecutionStatus covers succeeded/failed/denied/cancelled', () => {
  assert.equal(isTerminalExecutionStatus('succeeded'), true);
  assert.equal(isTerminalExecutionStatus('failed'), true);
  assert.equal(isTerminalExecutionStatus('denied'), true);
  assert.equal(isTerminalExecutionStatus('cancelled'), true);
  assert.equal(isTerminalExecutionStatus('awaiting_approval'), false);
  assert.equal(isTerminalExecutionStatus('executing'), false);
});

test('attachAgentTrustScore skips non-terminal executions', () => {
  const agent = createAgentActor({
    name: 'observer',
    purpose: 'read',
    owner: 'platform',
    permissions: [capability('inventory.vehicle.search')],
    tenantId: 't1',
    domain: 'dealer',
    role: 'reader',
    autonomyLevel: 'L0',
    actionTier: 'observe',
  });
  const run: Run = {
    ...deniedRun(),
    state: 'awaiting_approval',
    actorId: agent.actorId,
  };
  const exe = createExecutionObject({ run, agent, tenantId: 't1' });
  const out = attachAgentTrustScore({
    execution: exe,
    agent,
    authorizeDecision: 'REQUIRE_APPROVAL',
    gateRequired: true,
  });
  assert.equal(out.metadata['agentTrustScore'], undefined);
});

test('attachAgentTrustScore marks denied authorize as untrusted', () => {
  const agent = createAgentActor({
    name: 'observer',
    purpose: 'read',
    owner: 'platform',
    permissions: [capability('inventory.vehicle.search')],
    tenantId: 't1',
    domain: 'dealer',
    role: 'reader',
    autonomyLevel: 'L0',
    actionTier: 'observe',
    costBudget: 10,
  });
  const run = { ...deniedRun(), actorId: agent.actorId };
  const exe = createExecutionObject({
    run,
    agent,
    tenantId: 't1',
    auditTrace: [
      {
        at: run.updatedAt,
        event: 'policy.denied',
        detail: { reason: 'action tier denied' },
      },
    ],
  });
  const scored = attachAgentTrustScore({
    execution: exe,
    agent,
    authorizeDecision: 'DENY',
    policyEvents: [{ kind: 'action-tier', decision: 'DENY' }],
    computedAt: run.updatedAt,
  });
  const trust = readAgentTrustScore(scored);
  assert.ok(trust);
  assert.equal(trust.status, 'untrusted');
  assert.equal(
    trust.dimensions.find((d) => d.id === 'permissionCompliance')?.passed,
    false,
  );
  assert.ok(
    scored.auditTrace.some((e) => e.event === 'trust.computed'),
    'auditTrace records trust.computed',
  );
});

test('persistExecutionWithTrustScore loads evaluation and upgrades score', async () => {
  const agent = createAgentActor({
    name: 'worker',
    purpose: 'work',
    owner: 'platform',
    permissions: [capability('crm.appointment.schedule')],
    tenantId: 't1',
    domain: 'dealer',
    role: 'scheduler',
    autonomyLevel: 'L2',
    actionTier: 'execute',
    costBudget: 20,
    allowedTools: ['tool_calendar' as never],
  });
  const now = '2026-09-14T17:10:00.000Z';
  const run: Run = {
    runId: newRunId(),
    requestId: newRequestId(),
    commandId: newCommandId(),
    actorId: agent.actorId,
    state: 'completed',
    correlationId: newCorrelationId(),
    createdAt: now,
    updatedAt: now,
  };
  const exe = createExecutionObject({
    run,
    agent,
    tenantId: 't1',
    result: {
      status: 'succeeded',
      cost: { units: 3 },
      metadata: {},
      executor: 'test',
      startedAt: now,
      completedAt: now,
      durationMs: 10,
    },
  });
  assert.equal(exe.status, 'succeeded');

  const evaluation: EvaluationResult = {
    evaluationId: newEvaluationId(),
    executionId: exe.executionId,
    qualityScore: 0.95,
    success: true,
    latencyMs: 100,
    totalCost: 3,
    humanIntervention: false,
    policyEvents: [],
    evaluatedAt: now,
    metadata: {},
    tenantId: 't1',
  };

  let saved: typeof exe | undefined;
  const persisted = await persistExecutionWithTrustScore(
    async (e) => {
      saved = e;
    },
    async () => evaluation,
    {
      execution: exe,
      agent,
      authorizeDecision: 'ALLOW',
      gateRequired: false,
      computedAt: now,
    },
  );

  assert.ok(saved);
  const trust = readAgentTrustScore(persisted);
  assert.ok(trust);
  assert.equal(trust.status, 'trusted');
  assert.ok(trust.confidence >= 90);
});

test('attachAgentTrustScore fails humanGateCompliance when gate missing', () => {
  const agent = createAgentActor({
    name: 'worker',
    purpose: 'work',
    owner: 'platform',
    permissions: [capability('finance.payment.execute')],
    tenantId: 't1',
    domain: 'finance',
    role: 'payer',
    actionTier: 'execute',
    costBudget: 5,
  });
  const run: Run = {
    runId: newRunId(),
    requestId: newRequestId(),
    commandId: newCommandId(),
    actorId: agent.actorId,
    state: 'completed',
    correlationId: newCorrelationId(),
    createdAt: '2026-09-14T17:20:00.000Z',
    updatedAt: '2026-09-14T17:20:00.000Z',
  };
  const exe = createExecutionObject({
    run,
    agent,
    tenantId: 't1',
    result: {
      status: 'succeeded',
      cost: { units: 1 },
      metadata: {},
      executor: 'test',
      startedAt: run.createdAt,
      completedAt: run.updatedAt,
      durationMs: 5,
    },
    executionId: newExecutionId(),
  });
  const scored = attachAgentTrustScore({
    execution: exe,
    agent,
    authorizeDecision: 'ALLOW',
    gateRequired: true,
    approvalGranted: false,
    computedAt: run.updatedAt,
  });
  const trust = readAgentTrustScore(scored)!;
  assert.equal(trust.status, 'untrusted');
  assert.equal(
    trust.dimensions.find((d) => d.id === 'humanGateCompliance')?.passed,
    false,
  );
});
