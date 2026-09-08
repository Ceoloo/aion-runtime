/**
 * Mission 004 proof matrix — multi-step Mission Orchestration on live Runtime.
 *
 * PASS A — research → enrich → ghl upsert under one root; listByRoot = 3;
 *          parent chain correct; GHL provider/payload preserved on result
 * PASS B — gated mid-step pauses at awaiting_approval; approve; resume
 *          remaining steps under the SAME rootExecutionId
 * PASS C — deny mid-plan stops without running later steps
 *
 * Invoked by scripts/mission004-proof-matrix.sh against a live Runtime + Postgres.
 */
import {
  createAgentActor,
  createHumanActor,
  capability,
} from '@aion/core';
import { RuntimeClient, RuntimeApiError } from './clients/runtime-client.js';

const BASE_URL =
  process.env.AION_RUNTIME_URL ?? `http://127.0.0.1:${process.env.PORT ?? '8094'}`;
const TENANT = 'aion-systems';

const RESEARCH = capability('revenue.lead.research');
const ENRICH = capability('revenue.lead.enrich');
const FOLLOWUP = capability('revenue.followup.execute');
const GHL_UPSERT = capability('client.ghl.contact.upsert');

interface MissionStepRow {
  stepIndex: number;
  stepName: string;
  capability: string;
  status: string;
  executionId: string;
  parentExecutionId: string | null;
  rootExecutionId: string;
  runId: string;
  approvalId: string | null;
  result?: {
    status?: string;
    output?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  } | null;
}

interface MissionRunResponse {
  status: string;
  rootExecutionId?: string;
  stoppedAtStep?: number | null;
  steps?: MissionStepRow[];
  mission?: { missionId: string; name?: string };
  workflow?: { workflowId: string; name?: string; steps?: unknown[] };
  error?: string;
  message?: string;
}

interface ExecutionsByRootResponse {
  rootExecutionId?: string;
  count?: number;
  executions?: Array<{
    executionId: string;
    parentExecutionId?: string;
    rootExecutionId?: string;
    status?: string;
    cost?: { provider?: string };
  }>;
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
    name: 'Mission004ProofAgent',
    purpose: 'Mission 004 orchestration proof authorized caller.',
    owner: 'aion-runtime/proof',
    domain: 'revenue',
    role: 'copilot',
    tenantId: TENANT,
    permissions: [RESEARCH, ENRICH, FOLLOWUP, GHL_UPSERT],
    maxRiskLevel: 'R3',
    autonomyLevel: 'L2',
  });
}

function limitedActor() {
  return createAgentActor({
    name: 'Mission004LimitedAgent',
    purpose: 'Mission 004 deny-path proof — lacks followup permission.',
    owner: 'aion-runtime/proof',
    domain: 'revenue',
    role: 'observer',
    tenantId: TENANT,
    permissions: [RESEARCH],
    maxRiskLevel: 'R2',
    autonomyLevel: 'L1',
  });
}

function approverActor() {
  return createHumanActor({
    name: 'Mission004Approver',
    permissions: [FOLLOWUP],
    maxRiskLevel: 'R3',
  });
}

async function main(): Promise<void> {
  const client = new RuntimeClient({ baseUrl: BASE_URL, tenantId: TENANT });
  const agent = authorizedActor();
  const limited = limitedActor();
  const approver = approverActor();

  await passA(client, agent);
  await passB(client, agent, approver);
  await passC(client, limited);

  console.log('[PROOF] Mission 004 matrix A/B/C complete');
}

async function passA(
  client: RuntimeClient,
  actor: ReturnType<typeof createAgentActor>,
): Promise<void> {
  const stamp = Date.now();
  const res = (await client.runMission({
    actor,
    requestIdPrefix: `m004-a-${stamp}`,
    mission: {
      name: 'M004 Client GHL loop',
      owner: 'revenue',
      objective: 'Research → enrich → upsert GHL contact',
    },
    workflow: {
      name: 'client-money-ghl-v0',
      description: 'Mission 004 client money path (mock GHL)',
      steps: [
        { name: 'research', capability: RESEARCH, riskLevel: 'R1' },
        { name: 'enrich', capability: ENRICH, riskLevel: 'R1' },
        {
          name: 'ghl-upsert',
          capability: GHL_UPSERT,
          riskLevel: 'R1',
          description: 'Mock GoHighLevel contact upsert',
        },
      ],
    },
    stepPayloads: {
      'ghl-upsert': {
        provider: 'ghl',
        contact: { email: 'lead@example.com', source: 'aion-m004' },
      },
    },
  })) as MissionRunResponse;

  if (res.status !== 'completed') fail('A', `expected completed, got ${res.status}`);
  if (!res.rootExecutionId) fail('A', 'missing rootExecutionId');
  if (!res.steps || res.steps.length !== 3) {
    fail('A', `expected 3 steps, got ${res.steps?.length ?? 0}`);
  }

  const [s0, s1, s2] = res.steps;
  if (!s0 || !s1 || !s2) fail('A', 'step rows missing');
  if (s0.parentExecutionId != null) fail('A', 'root step must have no parent');
  if (s0.executionId !== res.rootExecutionId) {
    fail('A', 'first step executionId must equal rootExecutionId');
  }
  if (s1.parentExecutionId !== s0.executionId) {
    fail('A', 'step1 parent must be step0 executionId');
  }
  if (s2.parentExecutionId !== s1.executionId) {
    fail('A', 'step2 parent must be step1 executionId');
  }
  for (const step of res.steps) {
    if (step.rootExecutionId !== res.rootExecutionId) {
      fail('A', `step ${step.stepIndex} root mismatch`);
    }
    if (step.status !== 'completed') {
      fail('A', `step ${step.stepName} status=${step.status}`);
    }
  }

  // GHL-shaped payload/provider preserved on result output/metadata.
  const ghlOut = s2.result?.output ?? {};
  const ghlMeta = s2.result?.metadata ?? {};
  if (ghlOut['provider'] !== 'ghl' && ghlMeta['provider'] !== 'ghl') {
    fail(
      'A',
      `ghl provider not preserved: output=${JSON.stringify(ghlOut)} meta=${JSON.stringify(ghlMeta)}`,
    );
  }
  const contact = ghlOut['contact'] as { email?: string } | undefined;
  if (contact?.email !== 'lead@example.com') {
    fail('A', `ghl contact payload not echoed: ${JSON.stringify(contact)}`);
  }

  const tree = (await client.getExecutionsByRoot(res.rootExecutionId, {
    tenantId: TENANT,
  })) as ExecutionsByRootResponse;
  if (tree.count !== 3 || (tree.executions?.length ?? 0) !== 3) {
    fail('A', `listByRoot expected 3, got count=${tree.count} len=${tree.executions?.length}`);
  }
  const byId = new Map((tree.executions ?? []).map((e) => [e.executionId, e]));
  if (!byId.get(s0.executionId) || !byId.get(s1.executionId) || !byId.get(s2.executionId)) {
    fail('A', 'listByRoot missing one or more step executions');
  }
  if (byId.get(s1.executionId)?.parentExecutionId !== s0.executionId) {
    fail('A', 'persisted parent chain broken between step0→step1');
  }
  if (byId.get(s2.executionId)?.parentExecutionId !== s1.executionId) {
    fail('A', 'persisted parent chain broken between step1→step2');
  }

  ok(
    'A',
    `3-step client-money path completed under root=${res.rootExecutionId}; listByRoot=3; ghl provider preserved`,
  );
}

async function passB(
  client: RuntimeClient,
  actor: ReturnType<typeof createAgentActor>,
  approver: ReturnType<typeof createHumanActor>,
): Promise<void> {
  const stamp = Date.now();
  const paused = (await client.runMission({
    actor,
    requestIdPrefix: `m004-b-${stamp}`,
    mission: {
      name: 'M004 Gated GHL loop',
      owner: 'revenue',
      objective: 'Research → gated followup → GHL upsert',
    },
    workflow: {
      name: 'client-money-gated-v0',
      steps: [
        { name: 'research', capability: RESEARCH, riskLevel: 'R1' },
        { name: 'followup', capability: FOLLOWUP, riskLevel: 'R2' },
        { name: 'ghl-upsert', capability: GHL_UPSERT, riskLevel: 'R1' },
      ],
    },
    stepPayloads: {
      'ghl-upsert': {
        provider: 'ghl',
        contact: { email: 'gated@example.com', source: 'aion-m004-b' },
      },
    },
  })) as MissionRunResponse;

  if (paused.status !== 'awaiting_approval') {
    fail('B', `expected awaiting_approval, got ${paused.status}`);
  }
  if (paused.stoppedAtStep !== 1) {
    fail('B', `expected stoppedAtStep=1, got ${paused.stoppedAtStep}`);
  }
  if (!paused.rootExecutionId || !paused.steps || paused.steps.length !== 2) {
    fail('B', 'paused response missing root/steps');
  }
  const gated = paused.steps[1]!;
  if (gated.status !== 'awaiting_approval' || !gated.approvalId) {
    fail('B', `gated step not awaiting approval: ${JSON.stringify(gated)}`);
  }
  const rootExecutionId = paused.rootExecutionId;
  const gatedExecutionId = gated.executionId;

  const resumedGate = (await client.decideApproval(gated.approvalId!, {
    approve: true,
    decidedBy: approver.actorId,
    note: 'mission004 proof B',
    actor: approver,
  })) as { status?: string; run?: { runId?: string } };
  if (resumedGate.status !== 'completed') {
    fail('B', `expected gated step completed after approve, got ${resumedGate.status}`);
  }

  const continued = (await client.runMission({
    actor,
    missionId: paused.mission!.missionId,
    workflowId: paused.workflow!.workflowId,
    resumeFromStep: 2,
    rootExecutionId,
    parentExecutionId: gatedExecutionId,
    requestIdPrefix: `m004-b-resume-${stamp}`,
    stepPayloads: {
      'ghl-upsert': {
        provider: 'ghl',
        contact: { email: 'gated@example.com', source: 'aion-m004-b' },
      },
    },
  })) as MissionRunResponse;

  if (continued.status !== 'completed') {
    fail('B', `expected resumed mission completed, got ${continued.status}`);
  }
  if (continued.rootExecutionId !== rootExecutionId) {
    fail(
      'B',
      `resume changed rootExecutionId: ${continued.rootExecutionId} vs ${rootExecutionId}`,
    );
  }
  if (!continued.steps || continued.steps.length !== 1) {
    fail('B', `expected 1 resumed step, got ${continued.steps?.length ?? 0}`);
  }
  const last = continued.steps[0]!;
  if (last.parentExecutionId !== gatedExecutionId) {
    fail('B', 'resumed step parent must be gated execution');
  }
  if (last.rootExecutionId !== rootExecutionId) {
    fail('B', 'resumed step root mismatch');
  }

  const tree = (await client.getExecutionsByRoot(rootExecutionId, {
    tenantId: TENANT,
  })) as ExecutionsByRootResponse;
  if ((tree.executions?.length ?? 0) < 3) {
    fail('B', `expected ≥3 executions under same root after resume, got ${tree.count}`);
  }
  const roots = new Set((tree.executions ?? []).map((e) => e.rootExecutionId ?? e.executionId));
  // All non-root members share root; root may self-reference as rootExecutionId.
  for (const exe of tree.executions ?? []) {
    const root = exe.rootExecutionId ?? exe.executionId;
    if (root !== rootExecutionId) {
      fail('B', `execution ${exe.executionId} has foreign root ${root}`);
    }
  }
  void roots;

  ok(
    'B',
    `gated mid-step approved then resumed under same root=${rootExecutionId}; tree size=${tree.count}`,
  );
}

async function passC(
  client: RuntimeClient,
  actor: ReturnType<typeof createAgentActor>,
): Promise<void> {
  const stamp = Date.now();
  let res: MissionRunResponse;
  try {
    res = (await client.runMission({
      actor,
      requestIdPrefix: `m004-c-${stamp}`,
      mission: {
        name: 'M004 Deny mid-plan',
        owner: 'revenue',
        objective: 'prove stop-on-deny',
      },
      workflow: {
        name: 'deny-mid',
        steps: [
          { name: 'research', capability: RESEARCH, riskLevel: 'R1' },
          { name: 'followup', capability: FOLLOWUP, riskLevel: 'R2' },
          { name: 'ghl-upsert', capability: GHL_UPSERT, riskLevel: 'R1' },
        ],
      },
    })) as MissionRunResponse;
  } catch (err) {
    if (err instanceof RuntimeApiError && err.status === 403 && err.body) {
      res = err.body as MissionRunResponse;
    } else {
      throw err;
    }
  }

  if (res.status !== 'denied') fail('C', `expected denied, got ${res.status}`);
  if (res.stoppedAtStep !== 1) fail('C', `expected stoppedAtStep=1, got ${res.stoppedAtStep}`);
  if (!res.steps || res.steps.length !== 2) {
    fail('C', `expected 2 steps (research+denied followup), got ${res.steps?.length ?? 0}`);
  }
  if (res.steps[0]?.status !== 'completed') fail('C', 'first step should have completed');
  if (res.steps[1]?.status !== 'denied') fail('C', 'second step should be denied');
  // Third ghl step must never have run.
  if (res.steps.some((s) => s.stepName === 'ghl-upsert')) {
    fail('C', 'ghl-upsert must not run after deny');
  }

  ok('C', 'deny mid-plan stopped at followup; later ghl step never executed');
}

main().catch((err) => {
  console.error('[PROOF] fatal', err);
  process.exit(1);
});
