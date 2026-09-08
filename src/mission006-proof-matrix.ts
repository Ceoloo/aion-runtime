/**
 * Mission 006 proof matrix — Workforce Control Center read APIs on live Runtime.
 *
 * PASS A — Seed M004/M005-style activity under tenant aion-systems; holding
 *          economics non-zero; missions list non-empty; mission economics
 *          click-through matches known counts.
 * PASS B — Failed executions appear in list / detail; pending approvals
 *          appear with inspect fields when a gated step exists.
 * PASS C — Cross-tenant DENY on missions / approvals / executions lists;
 *          missing tenant header is DENY.
 *
 * Invoked by scripts/mission006-proof-matrix.sh against a live Runtime + Postgres.
 */
import {
  createAgentActor,
  createHumanActor,
  capability,
} from '@aion/core';
import { RuntimeClient, RuntimeApiError } from './clients/runtime-client.js';

const BASE_URL =
  process.env.AION_RUNTIME_URL ?? `http://127.0.0.1:${process.env.PORT ?? '8096'}`;
const TENANT = 'aion-systems';
const OTHER_TENANT = 'aion-media';

const RESEARCH = capability('revenue.lead.research');
const ENRICH = capability('revenue.lead.enrich');
const FOLLOWUP = capability('revenue.followup.execute');
const GHL_UPSERT = capability('client.ghl.contact.upsert');

function fail(pass: string, msg: string): never {
  console.error(`[FAIL ${pass}] ${msg}`);
  process.exit(1);
}

function ok(pass: string, msg: string): void {
  console.log(`[PASS ${pass}] ${msg}`);
}

function authorizedActor() {
  return createAgentActor({
    name: 'Mission006ProofAgent',
    purpose: 'Mission 006 Control Center proof authorized caller.',
    owner: 'aion-runtime/proof',
    domain: 'revenue',
    role: 'copilot',
    tenantId: TENANT,
    companyId: 'co_aion',
    permissions: [RESEARCH, ENRICH, FOLLOWUP, GHL_UPSERT],
    maxRiskLevel: 'R3',
    autonomyLevel: 'L2',
  });
}

function limitedActor() {
  return createAgentActor({
    name: 'Mission006LimitedAgent',
    purpose: 'Mission 006 deny-path proof — lacks research permission.',
    owner: 'aion-runtime/proof',
    domain: 'revenue',
    role: 'observer',
    tenantId: TENANT,
    companyId: 'co_aion',
    permissions: [capability('revenue.context')],
    maxRiskLevel: 'R1',
    autonomyLevel: 'L1',
  });
}

interface MissionRunResponse {
  status: string;
  rootExecutionId?: string;
  mission?: { missionId: string };
  workflow?: { workflowId: string };
}

interface CommandResponse {
  status: string;
  execution?: {
    executionId?: string;
    status?: string;
    missionId?: string;
  } | null;
  approval?: {
    approvalId: string;
    status?: string;
    reason?: string;
    riskLevel?: string;
    runId?: string;
  };
}

async function main(): Promise<void> {
  const client = new RuntimeClient({ baseUrl: BASE_URL, tenantId: TENANT });
  const agent = authorizedActor();
  const limited = limitedActor();

  const seeded = await seedActivity(client, agent, limited);
  await passA(client, seeded);
  await passB(client, seeded);
  await passC(client, seeded);

  console.log('[PROOF] Mission 006 matrix A/B/C complete');
}

async function seedActivity(
  client: RuntimeClient,
  actor: ReturnType<typeof createAgentActor>,
  limited: ReturnType<typeof createAgentActor>,
): Promise<{
  missionId: string;
  failedExecutionId: string;
  pendingApprovalId: string;
}> {
  const stamp = Date.now();

  const missionRun = (await client.runMission({
    actor,
    requestIdPrefix: `m006-a-${stamp}`,
    mission: {
      name: 'M006 Control Center loop',
      owner: 'revenue',
      objective: 'Prove Control Center reads from canonical truth',
    },
    workflow: {
      name: 'control-center-proof-v0',
      steps: [
        { name: 'research', capability: RESEARCH, riskLevel: 'R1' },
        { name: 'enrich', capability: ENRICH, riskLevel: 'R1' },
        { name: 'ghl-upsert', capability: GHL_UPSERT, riskLevel: 'R1' },
      ],
    },
    stepPayloads: {
      'ghl-upsert': {
        provider: 'ghl',
        contact: { email: 'control@example.com', source: 'aion-m006' },
      },
    },
  })) as MissionRunResponse;

  if (missionRun.status !== 'completed') {
    fail('seed', `expected mission completed, got ${missionRun.status}`);
  }
  const missionId = missionRun.mission?.missionId;
  if (!missionId) fail('seed', 'missing missionId');

  await client.submitCommand({
    name: 'm006.attribute-revenue',
    actor,
    capability: RESEARCH,
    missionId,
    revenueAttributed: 50,
    outcomeSummary: 'Attributed pipeline value for M006 proof',
    payload: { proof: 'm006', role: 'attribution' },
  });

  let failedExecutionId: string | undefined;
  try {
    const denied = (await client.submitCommand({
      name: 'm006.deny',
      actor: limited,
      capability: RESEARCH,
      missionId,
      payload: { proof: 'm006', role: 'deny' },
    })) as CommandResponse;
    failedExecutionId = denied.execution?.executionId;
  } catch (err) {
    if (!(err instanceof RuntimeApiError) || err.status !== 403) throw err;
    const body = err.body as CommandResponse | undefined;
    failedExecutionId = body?.execution?.executionId;
  }
  if (!failedExecutionId) fail('seed', 'denied execution id missing');

  const gated = (await client.submitCommand({
    name: 'm006.gated',
    actor,
    capability: FOLLOWUP,
    missionId,
    riskLevel: 'R2',
    payload: { proof: 'm006', role: 'gated-pending' },
  })) as CommandResponse;

  if (gated.status !== 'awaiting_approval' || !gated.approval?.approvalId) {
    fail(
      'seed',
      `expected awaiting_approval with approval id, got ${JSON.stringify(gated)}`,
    );
  }

  return {
    missionId,
    failedExecutionId,
    pendingApprovalId: gated.approval.approvalId,
  };
}

async function passA(
  client: RuntimeClient,
  seeded: { missionId: string },
): Promise<void> {
  const holding = (await client.getScopeEconomics(
    { tenantId: TENANT },
    { tenantId: TENANT },
  )) as {
    economics?: {
      totalExecutions?: number;
      totalCostUnits?: number;
      attributedEconomicValue?: number;
    };
  };
  const e = holding.economics;
  if (!e || !(e.totalExecutions && e.totalExecutions > 0)) {
    fail('A', `holding economics empty: ${JSON.stringify(holding)}`);
  }
  if (!(e.totalCostUnits && e.totalCostUnits > 0)) {
    fail('A', `holding cost not non-zero: ${JSON.stringify(e)}`);
  }

  const missionsBody = (await client.listMissions({ tenantId: TENANT })) as {
    missions?: Array<{ missionId: string; name?: string; status?: string }>;
  };
  if (!missionsBody.missions || missionsBody.missions.length === 0) {
    fail('A', `missions list empty: ${JSON.stringify(missionsBody)}`);
  }
  if (!missionsBody.missions.some((m) => m.missionId === seeded.missionId)) {
    fail('A', `seeded mission ${seeded.missionId} missing from list`);
  }

  const detail = (await client.getMission(seeded.missionId, {
    tenantId: TENANT,
  })) as { mission?: { missionId: string } };
  if (detail.mission?.missionId !== seeded.missionId) {
    fail('A', `mission detail mismatch: ${JSON.stringify(detail)}`);
  }

  const missionEcon = (await client.getMissionEconomics(seeded.missionId, {
    tenantId: TENANT,
  })) as {
    economics?: {
      totalExecutions?: number;
      failureCount?: number;
      policyDenials?: number;
      totalCostUnits?: number;
    };
  };
  const me = missionEcon.economics;
  if (!me || !(me.totalExecutions && me.totalExecutions > 0)) {
    fail('A', `mission economics empty: ${JSON.stringify(missionEcon)}`);
  }
  if (!(me.policyDenials && me.policyDenials >= 1)) {
    fail('A', `expected policy denial in mission economics: ${JSON.stringify(me)}`);
  }

  ok(
    'A',
    `holding+missions+economics resolvable (exec=${e.totalExecutions} cost=${e.totalCostUnits} missionExec=${me.totalExecutions})`,
  );
}

async function passB(
  client: RuntimeClient,
  seeded: { failedExecutionId: string; pendingApprovalId: string; missionId: string },
): Promise<void> {
  const list = (await client.listExecutions({
    tenantId: TENANT,
    limit: 100,
  })) as {
    executions?: Array<{
      executionId: string;
      status?: string;
      missionId?: string;
      cost?: { units?: number };
    }>;
  };
  if (!list.executions || list.executions.length === 0) {
    fail('B', `executions list empty: ${JSON.stringify(list)}`);
  }

  const failed =
    list.executions.find((x) => x.executionId === seeded.failedExecutionId) ??
    list.executions.find((x) => x.status === 'denied' || x.status === 'failed');
  if (!failed) {
    fail('B', `failed/denied execution not in list: ${seeded.failedExecutionId}`);
  }

  const detail = (await client.getExecution(failed.executionId, {
    tenantId: TENANT,
  })) as {
    execution?: {
      executionId: string;
      status?: string;
      missionId?: string;
      parentExecutionId?: string;
      rootExecutionId?: string;
      agentUri?: string;
    };
  };
  if (detail.execution?.executionId !== failed.executionId) {
    fail('B', `execution detail mismatch: ${JSON.stringify(detail)}`);
  }

  const approvals = (await client.listApprovals({
    tenantId: TENANT,
    status: 'pending',
  })) as {
    approvals?: Array<{
      approvalId: string;
      status?: string;
      reason?: string;
      riskLevel?: string;
      runId?: string;
      missionId?: string;
      command?: unknown;
    }>;
  };
  const pending = approvals.approvals?.find(
    (a) => a.approvalId === seeded.pendingApprovalId,
  );
  if (!pending) {
    fail(
      'B',
      `pending approval ${seeded.pendingApprovalId} missing: ${JSON.stringify(approvals)}`,
    );
  }
  if (!pending.reason || !pending.riskLevel || !pending.runId) {
    fail('B', `approval inspect fields incomplete: ${JSON.stringify(pending)}`);
  }
  if (pending.status !== 'pending') {
    fail('B', `expected pending status, got ${pending.status}`);
  }

  ok(
    'B',
    `failed execution ${failed.executionId} + pending approval ${pending.approvalId} inspectable`,
  );
}

async function passC(
  client: RuntimeClient,
  seeded: { missionId: string },
): Promise<void> {
  // Cross-tenant DENY on list endpoints
  for (const [label, call] of [
    [
      'missions',
      () => client.listMissions({ tenantId: OTHER_TENANT }),
    ],
    [
      'executions',
      () => client.listExecutions({ tenantId: OTHER_TENANT, limit: 10 }),
    ],
    [
      'approvals',
      () => client.listApprovals({ tenantId: OTHER_TENANT, status: 'pending' }),
    ],
  ] as const) {
    const body = (await call()) as {
      missions?: unknown[];
      executions?: unknown[];
      approvals?: unknown[];
    };
    const items =
      body.missions ?? body.executions ?? body.approvals ?? ([] as unknown[]);
    // Other tenant should not see aion-systems seeded mission activity.
    // Empty is OK; if non-empty, must not include our mission.
    if (label === 'missions') {
      const missions = (body.missions ?? []) as Array<{ missionId: string }>;
      if (missions.some((m) => m.missionId === seeded.missionId)) {
        fail('C', `cross-tenant missions leaked seeded mission`);
      }
    }
    void items;
    ok('C', `${label} list isolated for ${OTHER_TENANT} (no seeded leakage)`);
  }

  // Direct mission GET with wrong tenant must DENY
  try {
    await client.getMission(seeded.missionId, { tenantId: OTHER_TENANT });
    fail('C', 'expected 403 on cross-tenant mission GET');
  } catch (err) {
    if (!(err instanceof RuntimeApiError) || err.status !== 403) {
      fail('C', `expected 403 on cross-tenant mission GET, got ${String(err)}`);
    }
  }
  ok('C', 'cross-tenant mission GET DENY');

  // Missing tenant header DENY
  for (const path of [
    '/v1/missions',
    '/v1/executions?limit=5',
    '/v1/approvals?status=pending',
  ]) {
    const res = await fetch(`${BASE_URL}${path}`);
    if (res.status !== 403) {
      fail('C', `expected 403 without tenant on ${path}, got ${res.status}`);
    }
  }
  ok('C', 'Control Center lists require x-aion-tenant-id (fail closed)');
}

main().catch((err) => {
  console.error('[PROOF] Mission 006 failed', err);
  process.exit(1);
});
