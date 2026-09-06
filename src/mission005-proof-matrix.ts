/**
 * Mission 005 proof matrix — Mission Economics + Rollups on live Runtime.
 *
 * PASS A — Multi-step mission + attributed revenue + deny + gated approval;
 *          GET /v1/missions/:id/economics matches known execution/approval/
 *          cost/revenue totals and ROI.
 * PASS B — GET /v1/economics holding (tenant) rollup includes mission spend;
 *          cross-tenant header DENY.
 * PASS C — Missing tenant header is DENY on economics reads.
 *
 * Invoked by scripts/mission005-proof-matrix.sh against a live Runtime + Postgres.
 */
import {
  createAgentActor,
  createHumanActor,
  capability,
} from '@aion/core';
import { RuntimeClient, RuntimeApiError } from './clients/runtime-client.js';

const BASE_URL =
  process.env.AION_RUNTIME_URL ?? `http://127.0.0.1:${process.env.PORT ?? '8095'}`;
const TENANT = 'aion-systems';

const RESEARCH = capability('revenue.lead.research');
const ENRICH = capability('revenue.lead.enrich');
const FOLLOWUP = capability('revenue.followup.execute');
const GHL_UPSERT = capability('client.ghl.contact.upsert');

/** Mock adapter costs from control-plane.ts */
const COST_RESEARCH = 5;
const COST_ENRICH = 5;
const COST_GHL = 3;
const COST_FOLLOWUP = 5;
const ATTRIBUTED_EV = 100;

interface MissionRunResponse {
  status: string;
  rootExecutionId?: string;
  steps?: Array<{
    status: string;
    executionId: string;
    runId: string;
  }>;
  mission?: { missionId: string };
  workflow?: { workflowId: string };
}

interface CommandResponse {
  status: string;
  execution?: {
    executionId?: string;
    status?: string;
    cost?: { units?: number };
    revenueAttributed?: number;
    missionId?: string;
  } | null;
  approval?: { approvalId: string };
  result?: { cost?: { units?: number } };
}

interface EconomicsBody {
  economics?: {
    missionId?: string;
    tenantId?: string;
    scope?: { tenantId?: string };
    totalExecutions?: number;
    successCount?: number;
    failureCount?: number;
    policyDenials?: number;
    approvals?: number;
    humanInterventions?: number;
    totalCostUnits?: number;
    totalDurationMs?: number;
    outcomeCount?: number;
    attributedEconomicValue?: number;
    roi?: number | null;
  };
  error?: string;
  message?: string;
}

function fail(pass: string, msg: string): never {
  console.error(`[FAIL ${pass}] ${msg}`);
  process.exit(1);
}

function ok(pass: string, msg: string): void {
  console.log(`[PASS ${pass}] ${msg}`);
}

function authorizedActor() {
  return createAgentActor({
    name: 'Mission005ProofAgent',
    purpose: 'Mission 005 economics proof authorized caller.',
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
    name: 'Mission005LimitedAgent',
    purpose: 'Mission 005 deny-path proof — lacks research permission.',
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

function approverActor() {
  return createHumanActor({
    name: 'Mission005Approver',
    permissions: [FOLLOWUP],
    maxRiskLevel: 'R3',
  });
}

async function main(): Promise<void> {
  const client = new RuntimeClient({ baseUrl: BASE_URL, tenantId: TENANT });
  const agent = authorizedActor();
  const limited = limitedActor();
  const approver = approverActor();

  await passA(client, agent, limited, approver);
  await passB(client);
  await passC(client);

  console.log('[PROOF] Mission 005 matrix A/B/C complete');
}

async function passA(
  client: RuntimeClient,
  actor: ReturnType<typeof createAgentActor>,
  limited: ReturnType<typeof createAgentActor>,
  approver: ReturnType<typeof createHumanActor>,
): Promise<void> {
  const stamp = Date.now();

  // 1) Multi-step mission — known mock costs 5+5+3 = 13
  const missionRun = (await client.runMission({
    actor,
    requestIdPrefix: `m005-a-${stamp}`,
    mission: {
      name: 'M005 Economics loop',
      owner: 'revenue',
      objective: 'Prove mission economics rollup from execution truth',
    },
    workflow: {
      name: 'economics-proof-v0',
      steps: [
        { name: 'research', capability: RESEARCH, riskLevel: 'R1' },
        { name: 'enrich', capability: ENRICH, riskLevel: 'R1' },
        { name: 'ghl-upsert', capability: GHL_UPSERT, riskLevel: 'R1' },
      ],
    },
    stepPayloads: {
      'ghl-upsert': {
        provider: 'ghl',
        contact: { email: 'econ@example.com', source: 'aion-m005' },
      },
    },
  })) as MissionRunResponse;

  if (missionRun.status !== 'completed') {
    fail('A', `expected mission completed, got ${missionRun.status}`);
  }
  const missionId = missionRun.mission?.missionId;
  if (!missionId) fail('A', 'missing missionId');

  // 2) Attributed economic value on a same-mission command
  const attr = (await client.submitCommand({
    name: 'm005.attribute-revenue',
    actor,
    capability: RESEARCH,
    missionId,
    revenueAttributed: ATTRIBUTED_EV,
    outcomeSummary: 'Attributed pipeline value for M005 proof',
    payload: { proof: 'm005', role: 'attribution' },
  })) as CommandResponse;
  if (attr.status !== 'completed' && attr.status !== 'succeeded') {
    // Orchestrator returns 'completed' for success
    if (attr.execution?.status !== 'succeeded') {
      fail('A', `attribution command failed: ${attr.status}`);
    }
  }
  if (attr.execution?.revenueAttributed !== ATTRIBUTED_EV) {
    fail(
      'A',
      `expected revenueAttributed=${ATTRIBUTED_EV}, got ${attr.execution?.revenueAttributed}`,
    );
  }

  // 3) Policy denial
  const denied = (await client.submitCommand({
    name: 'm005.deny',
    actor: limited,
    capability: RESEARCH,
    missionId,
    payload: { proof: 'm005', role: 'deny' },
  })) as CommandResponse;
  if (denied.status !== 'denied') {
    fail('A', `expected denied, got ${denied.status}`);
  }

  // 4) Human intervention — gated R2 then approve
  const gated = (await client.submitCommand({
    name: 'm005.gated',
    actor,
    capability: FOLLOWUP,
    missionId,
    riskLevel: 'R2',
    payload: { proof: 'm005', role: 'gated' },
  })) as CommandResponse;
  if (gated.status !== 'awaiting_approval' || !gated.approval?.approvalId) {
    fail('A', `expected awaiting_approval, got ${JSON.stringify(gated)}`);
  }
  const resumed = (await client.decideApproval(gated.approval.approvalId, {
    approve: true,
    decidedBy: approver.actorId,
    note: 'mission005 proof A',
    actor: approver,
  })) as CommandResponse;
  if (resumed.status !== 'completed' && resumed.execution?.status !== 'succeeded') {
    fail('A', `expected gated resume completed, got ${resumed.status}`);
  }

  const expectedCost =
    COST_RESEARCH + COST_ENRICH + COST_GHL + COST_RESEARCH + COST_FOLLOWUP;
  const expectedExecutions = 6; // 3 mission + attr + deny + gated
  const expectedSuccess = 5; // mission 3 + attr + gated (deny is not success)
  const expectedDenials = 1;
  const expectedApprovals = 1;
  const expectedRoi = ATTRIBUTED_EV / expectedCost;

  const body = (await client.getMissionEconomics(missionId, {
    tenantId: TENANT,
  })) as EconomicsBody;
  const e = body.economics;
  if (!e) fail('A', `missing economics body: ${JSON.stringify(body)}`);

  if (e.missionId !== missionId) fail('A', `missionId mismatch ${e.missionId}`);
  if (e.tenantId !== TENANT) fail('A', `tenantId mismatch ${e.tenantId}`);
  if (e.totalExecutions !== expectedExecutions) {
    fail('A', `totalExecutions expected ${expectedExecutions}, got ${e.totalExecutions}`);
  }
  if (e.successCount !== expectedSuccess) {
    fail('A', `successCount expected ${expectedSuccess}, got ${e.successCount}`);
  }
  if (e.policyDenials !== expectedDenials) {
    fail('A', `policyDenials expected ${expectedDenials}, got ${e.policyDenials}`);
  }
  if (e.approvals !== expectedApprovals) {
    fail('A', `approvals expected ${expectedApprovals}, got ${e.approvals}`);
  }
  if (e.humanInterventions !== expectedApprovals) {
    fail(
      'A',
      `humanInterventions expected ${expectedApprovals}, got ${e.humanInterventions}`,
    );
  }
  if (e.totalCostUnits !== expectedCost) {
    fail('A', `totalCostUnits expected ${expectedCost}, got ${e.totalCostUnits}`);
  }
  if (e.attributedEconomicValue !== ATTRIBUTED_EV) {
    fail(
      'A',
      `attributedEconomicValue expected ${ATTRIBUTED_EV}, got ${e.attributedEconomicValue}`,
    );
  }
  if (e.roi == null || Math.abs(e.roi - expectedRoi) > 1e-9) {
    fail('A', `roi expected ${expectedRoi}, got ${e.roi}`);
  }

  ok(
    'A',
    `mission economics match: exec=${e.totalExecutions} cost=${e.totalCostUnits} ` +
      `EV=${e.attributedEconomicValue} ROI=${e.roi} denials=${e.policyDenials} ` +
      `approvals=${e.approvals}`,
  );
}

async function passB(client: RuntimeClient): Promise<void> {
  const holding = (await client.getScopeEconomics(
    { tenantId: TENANT },
    { tenantId: TENANT },
  )) as EconomicsBody;
  const e = holding.economics;
  if (!e) fail('B', `missing holding economics: ${JSON.stringify(holding)}`);
  if (e.scope?.tenantId !== TENANT) {
    fail('B', `holding scope.tenantId expected ${TENANT}, got ${e.scope?.tenantId}`);
  }
  if ((e.totalExecutions ?? 0) < 6) {
    fail('B', `holding totalExecutions expected >= 6, got ${e.totalExecutions}`);
  }
  if ((e.totalCostUnits ?? 0) < COST_RESEARCH + COST_ENRICH + COST_GHL) {
    fail('B', `holding totalCostUnits too low: ${e.totalCostUnits}`);
  }
  if ((e.attributedEconomicValue ?? 0) < ATTRIBUTED_EV) {
    fail('B', `holding EV expected >= ${ATTRIBUTED_EV}, got ${e.attributedEconomicValue}`);
  }

  // Cross-tenant header must DENY when querying another tenant.
  try {
    await client.getScopeEconomics(
      { tenantId: 'other-tenant' },
      { tenantId: TENANT },
    );
    fail('B', 'expected cross-tenant scope rollup to DENY');
  } catch (err) {
    if (!(err instanceof RuntimeApiError) || err.status !== 403) {
      fail('B', `expected 403 cross-tenant, got ${String(err)}`);
    }
  }

  ok(
    'B',
    `holding rollup tenant=${TENANT} exec=${e.totalExecutions} cost=${e.totalCostUnits}; cross-tenant DENY`,
  );
}

async function passC(client: RuntimeClient): Promise<void> {
  // Probe without tenant header via raw fetch.
  const res = await fetch(`${BASE_URL}/v1/economics`);
  if (res.status !== 403) {
    fail('C', `expected 403 without tenant header, got ${res.status}`);
  }
  const body = (await res.json()) as EconomicsBody;
  if (body.error !== 'tenant_required') {
    fail('C', `expected tenant_required, got ${JSON.stringify(body)}`);
  }

  // Also mission economics without tenant — need a mission id; use a fake id
  // and still expect tenant_required before not_found.
  const res2 = await fetch(`${BASE_URL}/v1/missions/msn_missing/economics`);
  if (res2.status !== 403) {
    fail('C', `expected 403 on mission economics without tenant, got ${res2.status}`);
  }

  ok('C', 'economics reads require x-aion-tenant-id (fail closed)');
}

main().catch((err) => {
  console.error('[FAIL]', err);
  process.exit(1);
});
