/**
 * Mission 003 — Tenant / domain isolation attack suite.
 *
 * Proves Runtime (via Core PolicyEngine.authorize) DENYs cross-tenant reads,
 * identity spoofing, approval replay / cross-binding, serviceKey tampering,
 * and budget abuse — while ALLOWing the same shared capability for two
 * isolated tenants.
 *
 * This harness is deliberately aggressive: it tries to break AION, not merely
 * confirm happy-path isolation.
 *
 * Run: npm run proof:mission003
 */
import {
  PolicyEngine,
  capability,
  createAgentActor,
  createHumanActor,
  AuthorizationRequest,
  Command,
  newApprovalId,
  newCommandId,
  newExecutionId,
  newRequestId,
  newRunId,
  type ApprovalRequest,
  type AgentActor,
} from '@aion/core';

let passed = 0;
let failed = 0;

function ok(name: string, detail?: string): void {
  passed += 1;
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name: string, detail: string): never {
  failed += 1;
  console.error(`FAIL  ${name} — ${detail}`);
  throw new Error(`Mission 003 attack suite failed at: ${name}`);
}

function agent(input: {
  name: string;
  tenantId: string;
  permissions: string[];
  costBudget?: number;
}): AgentActor {
  return createAgentActor({
    name: input.name,
    purpose: 'mission-003-attack-suite',
    owner: 'platform',
    permissions: input.permissions.map((p) => capability(p)),
    maxRiskLevel: 'R3',
    tenantId: input.tenantId,
    domain: 'systems',
    role: 'attacker',
    ...(input.costBudget !== undefined ? { costBudget: input.costBudget } : {}),
  });
}

function expectDecision(
  name: string,
  decision: { decision: string; reason: string },
  expected: 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL',
): void {
  if (decision.decision !== expected) {
    fail(name, `expected ${expected}, got ${decision.decision}: ${decision.reason}`);
  }
  ok(name, decision.reason);
}

function main(): void {
  const engine = new PolicyEngine({
    risk: {
      capabilityRisk: {
        'revenue.lead.research': 'R1',
        'revenue.followup.execute': 'R2',
        'production.deploy': 'R3',
        'media.trend.research': 'R1',
      },
    },
    gatedCapabilities: [capability('revenue.followup.execute')],
  });

  const tenantA = agent({
    name: 'TenantA-Agent',
    tenantId: 'tenant-a',
    permissions: ['revenue.lead.research', 'revenue.followup.execute'],
  });
  const tenantB = agent({
    name: 'TenantB-Agent',
    tenantId: 'tenant-b',
    permissions: ['revenue.lead.research'],
  });
  const media = agent({
    name: 'Media-Agent',
    tenantId: 'aion-media',
    permissions: ['media.trend.research'],
  });

  // 1. Tenant A → read Tenant B execution → DENY
  expectDecision(
    'cross-tenant-read',
    engine.authorize(
      AuthorizationRequest.parse({
        agentId: tenantA.agentId,
        tenantId: 'tenant-a',
        action: 'read_execution',
        capability: 'revenue.lead.research',
        resourceTenantId: 'tenant-b',
        targetExecutionId: newExecutionId(),
      }),
      { actor: tenantA },
    ),
    'DENY',
  );

  // 2. Tenant A → mutate Tenant B artifact → DENY
  expectDecision(
    'cross-tenant-mutate',
    engine.authorize(
      AuthorizationRequest.parse({
        agentId: tenantA.agentId,
        tenantId: 'tenant-a',
        action: 'mutate_artifact',
        capability: 'revenue.lead.research',
        resourceTenantId: 'tenant-b',
        resourceRefs: ['artifact:tenant-b/secret'],
      }),
      { actor: tenantA },
    ),
    'DENY',
  );

  // 3. Tenant A agent → unauthorized service → DENY
  expectDecision(
    'unauthorized-service',
    engine.authorize(
      AuthorizationRequest.parse({
        agentId: tenantA.agentId,
        tenantId: 'tenant-a',
        action: 'invoke',
        capability: 'production.deploy',
        riskLevel: 'R3',
      }),
      { actor: tenantA },
    ),
    'DENY',
  );

  // 4. Media agent → production.deploy → DENY
  expectDecision(
    'media-cannot-deploy',
    engine.authorize(
      AuthorizationRequest.parse({
        agentId: media.agentId,
        tenantId: 'aion-media',
        action: 'invoke',
        capability: 'production.deploy',
        riskLevel: 'R3',
      }),
      { actor: media },
    ),
    'DENY',
  );

  // 5. Spoof agentId → DENY
  expectDecision(
    'agent-id-spoof',
    engine.authorize(
      AuthorizationRequest.parse({
        agentId: 'agt_spoofed_other',
        tenantId: 'tenant-a',
        action: 'invoke',
        capability: 'revenue.lead.research',
      }),
      { actor: tenantA },
    ),
    'DENY',
  );

  // 6. R2 execute without approvalId → REQUIRE_APPROVAL
  expectDecision(
    'r2-without-approval',
    engine.authorize(
      AuthorizationRequest.parse({
        agentId: tenantA.agentId,
        tenantId: 'tenant-a',
        action: 'execute',
        capability: 'revenue.followup.execute',
        riskLevel: 'R2',
      }),
      { actor: tenantA },
    ),
    'REQUIRE_APPROVAL',
  );

  // 7. approvalId from execution A → execution B → DENY
  const exeA = newExecutionId();
  const exeB = newExecutionId();
  const approvalForA: ApprovalRequest = {
    approvalId: newApprovalId(),
    runId: newRunId(),
    requestId: newRequestId(),
    executionId: exeA,
    tenantId: 'tenant-a',
    command: Command.parse({
      commandId: newCommandId(),
      requestId: newRequestId(),
      name: 'FollowUp',
      actor: tenantA,
      capability: capability('revenue.followup.execute'),
      createdAt: new Date().toISOString(),
    }),
    riskLevel: 'R2',
    reason: 'gated',
    status: 'granted',
    requestedAt: new Date().toISOString(),
    decidedAt: new Date().toISOString(),
    decidedBy: createHumanActor({ name: 'Boss' }).actorId,
  };
  expectDecision(
    'approval-cross-execution',
    engine.authorize(
      AuthorizationRequest.parse({
        agentId: tenantA.agentId,
        tenantId: 'tenant-a',
        action: 'execute',
        capability: 'revenue.followup.execute',
        riskLevel: 'R2',
        approvalId: approvalForA.approvalId,
        approvalExecutionId: exeA,
        targetExecutionId: exeB,
      }),
      { actor: tenantA, approval: approvalForA },
    ),
    'DENY',
  );

  // 8. approval replay → DENY
  const replayed: ApprovalRequest = {
    ...approvalForA,
    executionId: exeA,
    consumedAt: new Date().toISOString(),
  };
  expectDecision(
    'approval-replay',
    engine.authorize(
      AuthorizationRequest.parse({
        agentId: tenantA.agentId,
        tenantId: 'tenant-a',
        action: 'execute',
        capability: 'revenue.followup.execute',
        riskLevel: 'R2',
        approvalId: replayed.approvalId,
        targetExecutionId: exeA,
      }),
      { actor: tenantA, approval: replayed },
    ),
    'DENY',
  );

  // 9. expired approval → DENY
  const expired: ApprovalRequest = {
    ...approvalForA,
    executionId: exeA,
    consumedAt: undefined,
    expiresAt: '2020-01-01T00:00:00.000Z',
  };
  expectDecision(
    'approval-expired',
    engine.authorize(
      AuthorizationRequest.parse({
        agentId: tenantA.agentId,
        tenantId: 'tenant-a',
        action: 'execute',
        capability: 'revenue.followup.execute',
        riskLevel: 'R2',
        approvalId: expired.approvalId,
        targetExecutionId: exeA,
      }),
      { actor: tenantA, approval: expired, now: '2026-01-01T00:00:00.000Z' },
    ),
    'DENY',
  );

  // 10. serviceKey tampering → DENY
  expectDecision(
    'service-key-tamper',
    engine.authorize(
      AuthorizationRequest.parse({
        agentId: tenantA.agentId,
        tenantId: 'tenant-a',
        action: 'invoke',
        capability: 'revenue.lead.research',
        serviceKey: 'production.deploy@1',
        riskLevel: 'R1',
      }),
      {
        actor: tenantA,
        resolvedServiceKey: 'revenue.lead.research@1',
      },
    ),
    'DENY',
  );

  // 11. cross-tenant context reference → DENY
  expectDecision(
    'cross-tenant-context',
    engine.authorize(
      AuthorizationRequest.parse({
        agentId: tenantA.agentId,
        tenantId: 'tenant-a',
        action: 'read_context',
        capability: 'revenue.lead.research',
        resourceTenantId: 'tenant-b',
        resourceRefs: ['context:tenant-b/x'],
      }),
      { actor: tenantA },
    ),
    'DENY',
  );

  // 12. budget exceeded → DENY
  const broke = agent({
    name: 'Broke',
    tenantId: 'tenant-a',
    permissions: ['revenue.lead.research'],
    costBudget: 5,
  });
  expectDecision(
    'budget-exceeded',
    engine.authorize(
      AuthorizationRequest.parse({
        agentId: broke.agentId,
        tenantId: 'tenant-a',
        action: 'invoke',
        capability: 'revenue.lead.research',
        riskLevel: 'R1',
        estimatedCost: 50,
        budgetRemaining: 5,
      }),
      { actor: broke },
    ),
    'DENY',
  );

  // 13. valid shared capability → ALLOW
  expectDecision(
    'valid-shared-capability',
    engine.authorize(
      AuthorizationRequest.parse({
        agentId: tenantA.agentId,
        tenantId: 'tenant-a',
        action: 'invoke',
        capability: 'revenue.lead.research',
        serviceKey: 'revenue.lead.research@1',
        riskLevel: 'R1',
      }),
      {
        actor: tenantA,
        resolvedServiceKey: 'revenue.lead.research@1',
      },
    ),
    'ALLOW',
  );

  // 14. same service from two tenants → ALLOW (isolated records)
  expectDecision(
    'tenant-a-shared-service',
    engine.authorize(
      AuthorizationRequest.parse({
        agentId: tenantA.agentId,
        tenantId: 'tenant-a',
        action: 'invoke',
        capability: 'revenue.lead.research',
        riskLevel: 'R1',
      }),
      { actor: tenantA },
    ),
    'ALLOW',
  );
  expectDecision(
    'tenant-b-shared-service',
    engine.authorize(
      AuthorizationRequest.parse({
        agentId: tenantB.agentId,
        tenantId: 'tenant-b',
        action: 'invoke',
        capability: 'revenue.lead.research',
        riskLevel: 'R1',
      }),
      { actor: tenantB },
    ),
    'ALLOW',
  );

  // 15. bound approval for matching execution → ALLOW
  const liveApproval: ApprovalRequest = {
    ...approvalForA,
    executionId: exeA,
    consumedAt: undefined,
    expiresAt: '2099-01-01T00:00:00.000Z',
  };
  expectDecision(
    'bound-approval-allow',
    engine.authorize(
      AuthorizationRequest.parse({
        agentId: tenantA.agentId,
        tenantId: 'tenant-a',
        action: 'execute',
        capability: 'revenue.followup.execute',
        riskLevel: 'R2',
        approvalId: liveApproval.approvalId,
        approvalExecutionId: exeA,
        targetExecutionId: exeA,
      }),
      { actor: tenantA, approval: liveApproval },
    ),
    'ALLOW',
  );

  console.log('');
  console.log(
    `Mission 003 attack suite: ${passed} passed, ${failed} failed`,
  );
  if (failed > 0) process.exit(1);
  console.log('MISSION_003_ATTACK_SUITE=PASS');
}

main();
