/**
 * Mission 001 proof matrix — canonical production-style Runtime validation.
 *
 * PASS A — Authorized R1 service executes with cost > 0 and catalog contract
 * PASS B — Unauthorized service denied before execution (no side effect)
 * PASS C — R2 pauses, approval resumes SAME run once; requestId replay is
 *          idempotent; second decision cannot double-execute
 * PASS D — Runtime process restart: paused Execution Object still queryable by
 *           stable executionId; resume once (same run + same executionId, cost
 *           recorded, durable outcome exposed). No double execute.
 *
 * Invoked by scripts/mission001-proof-matrix.sh against a live Runtime + Postgres.
 */
import {
  createAgentActor,
  createHumanActor,
  capability,
} from '@aion/core';
import { RuntimeClient, RuntimeApiError } from './clients/runtime-client.js';

const BASE_URL =
  process.env.AION_RUNTIME_URL ?? `http://127.0.0.1:${process.env.PORT ?? '8090'}`;
const SERVICE_R1 = 'revenue.lead.research@1';
const SERVICE_R2 = 'revenue.followup.execute@1';

interface CommandResponse {
  status: string;
  run?: { runId: string; state?: string; requestId?: string };
  execution?: {
    executionId?: string;
    status?: string;
    cost?: { units?: number; tokens?: number };
    outcomeId?: string;
    outcomeSummary?: string;
  } | null;
  approval?: { approvalId: string; status?: string };
  decision?: { decision?: string; reason?: string };
  result?: { status?: string; cost?: { units?: number } };
  outcomeReference?: { outcomeId?: string; runId?: string; status?: string };
  service?: {
    serviceKey?: string;
    riskLevel?: string;
    approvalRequired?: boolean;
    requiredPermissions?: string[];
    capability?: string;
    version?: number;
  };
  idempotentReplay?: boolean;
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
    name: 'Mission001ProofAgent',
    purpose: 'Mission 001 proof matrix authorized caller.',
    owner: 'aion-runtime/proof',
    domain: 'revenue',
    role: 'copilot',
    tenantId: 'aion-systems',
    permissions: [
      capability('revenue.lead.research'),
      capability('revenue.followup.execute'),
    ],
    maxRiskLevel: 'R2',
    autonomyLevel: 'L2',
  });
}

function unauthorizedActor() {
  return createAgentActor({
    name: 'Mission001UnauthorizedAgent',
    purpose: 'Mission 001 proof matrix unauthorized caller.',
    owner: 'aion-runtime/proof',
    domain: 'revenue',
    role: 'observer',
    tenantId: 'aion-systems',
    permissions: [capability('revenue.context')], // deliberately missing research
    maxRiskLevel: 'R1',
    autonomyLevel: 'L1',
  });
}

function approverActor() {
  return createHumanActor({
    name: 'Mission001Approver',
    permissions: [capability('revenue.followup.execute')],
    maxRiskLevel: 'R3',
  });
}

async function main(): Promise<void> {
  const client = new RuntimeClient({ baseUrl: BASE_URL, tenantId: 'aion-systems' });
  const mode = process.env.PROOF_MODE ?? 'full'; // full | ab | c | d-prepare | d-resume

  const authorized = authorizedActor();
  const unauthorized = unauthorizedActor();
  const approver = approverActor();

  // Catalog contract check (serviceKey is not just a routing string).
  const svc = (await client.getService(SERVICE_R1)) as {
    service?: CommandResponse['service'];
  } & CommandResponse['service'];
  const serviceBody = (svc.service ?? svc) as NonNullable<CommandResponse['service']>;
  if (serviceBody.serviceKey !== SERVICE_R1) {
    fail('CATALOG', `expected serviceKey ${SERVICE_R1}, got ${serviceBody.serviceKey}`);
  }
  if (!serviceBody.capability || !serviceBody.riskLevel || serviceBody.version == null) {
    fail(
      'CATALOG',
      `catalog entry missing capability/risk/version: ${JSON.stringify(serviceBody)}`,
    );
  }
  if (
    !Array.isArray(serviceBody.requiredPermissions) ||
    serviceBody.requiredPermissions.length < 1
  ) {
    fail('CATALOG', 'catalog entry missing requiredPermissions');
  }
  ok(
    'CATALOG',
    `${SERVICE_R1} resolves capability=${serviceBody.capability} risk=${serviceBody.riskLevel}`,
  );

  if (mode === 'ab' || mode === 'full') {
    await passA(client, authorized);
    await passB(client, unauthorized);
  }

  if (mode === 'c' || mode === 'full') {
    await passC(client, authorized, approver);
  }

  if (mode === 'd-prepare') {
    await passDPrepare(client, authorized);
    return;
  }

  if (mode === 'd-resume') {
    await passDResume(client, approver);
    return;
  }

  if (mode === 'full') {
    console.log(
      '[INFO] PASS D (process restart) is exercised by scripts/mission001-proof-matrix.sh',
    );
  }

  console.log('[PROOF] Mission 001 matrix segment complete');
}

async function passA(
  client: RuntimeClient,
  actor: ReturnType<typeof createAgentActor>,
): Promise<void> {
  const res = (await client.submitCommand({
    name: 'mission001.pass-a.research',
    actor,
    serviceKey: SERVICE_R1,
    requestId: `proof-a-${Date.now()}`,
    payload: { proof: 'A' },
  })) as CommandResponse;

  if (res.status !== 'completed') fail('A', `expected completed, got ${res.status}`);
  const units = Number(res.result?.cost?.units ?? res.execution?.cost?.units ?? 0);
  if (!(units > 0)) fail('A', `expected cost.units > 0, got ${units}`);
  if (!res.execution?.executionId) fail('A', 'missing executionId');
  if (!res.service?.serviceKey) fail('A', 'response missing resolved catalog service snapshot');
  if (res.service.riskLevel !== 'R1') {
    fail('A', `expected R1 catalog risk, got ${res.service.riskLevel}`);
  }

  // Execution remains queryable as the outcome-attribution anchor.
  const fetched = (await client.getExecution(res.execution.executionId, { tenantId: 'aion-systems' })) as {
    execution?: { executionId?: string; cost?: { units?: number } };
  };
  const execution =
    fetched.execution ?? (fetched as { executionId?: string; cost?: { units?: number } });
  if (!execution.executionId) fail('A', 'execution not queryable after completion');
  ok('A', `R1 ${SERVICE_R1} completed cost=${units} execution=${execution.executionId}`);
}

async function passB(
  client: RuntimeClient,
  actor: ReturnType<typeof createAgentActor>,
): Promise<void> {
  try {
    const res = (await client.submitCommand({
      name: 'mission001.pass-b.denied',
      actor,
      serviceKey: SERVICE_R1,
      requestId: `proof-b-${Date.now()}`,
    })) as CommandResponse;
    if (res.status !== 'denied') fail('B', `expected denied status, got ${res.status}`);
    ok(
      'B',
      `unauthorized caller denied before execution (${res.decision?.reason ?? res.status})`,
    );
  } catch (err) {
    if (err instanceof RuntimeApiError && err.status === 403) {
      ok('B', `unauthorized caller denied with HTTP 403 (${err.message})`);
      return;
    }
    throw err;
  }
}

async function passC(
  client: RuntimeClient,
  actor: ReturnType<typeof createAgentActor>,
  approver: ReturnType<typeof createHumanActor>,
): Promise<void> {
  const requestId = `proof-c-${Date.now()}`;
  const paused = (await client.submitCommand({
    name: 'mission001.pass-c.followup',
    actor,
    serviceKey: SERVICE_R2,
    requestId,
    payload: { proof: 'C' },
  })) as CommandResponse;

  if (paused.status !== 'awaiting_approval') {
    fail('C', `expected awaiting_approval, got ${paused.status}`);
  }
  const runId = paused.run?.runId;
  const approvalId = paused.approval?.approvalId;
  if (!runId || !approvalId) fail('C', 'missing runId/approvalId on gated response');
  if (paused.service && paused.service.approvalRequired !== true) {
    fail('C', 'catalog snapshot should report approvalRequired=true for R2 followup');
  }

  // Idempotent replay of the same requestId must not create a second run.
  const replay = (await client.submitCommand({
    name: 'mission001.pass-c.followup',
    actor,
    serviceKey: SERVICE_R2,
    requestId,
  })) as CommandResponse;
  if (replay.run?.runId !== runId) fail('C', 'requestId replay returned a different runId');
  if (replay.idempotentReplay !== true) {
    fail('C', 'expected idempotentReplay=true on requestId retry');
  }
  ok('C', `requestId replay returned same run ${runId}`);

  const resumed = (await client.decideApproval(approvalId, {
    approve: true,
    decidedBy: approver.actorId,
    note: 'mission001 proof C',
    actor: approver,
  })) as CommandResponse;

  if (resumed.status !== 'completed') {
    fail('C', `expected completed after approval, got ${resumed.status}`);
  }
  if (resumed.run?.runId !== runId) fail('C', 'approval resumed a different runId');
  const units = Number(resumed.result?.cost?.units ?? resumed.execution?.cost?.units ?? 0);
  if (!(units > 0)) fail('C', `expected cost > 0 after approval resume, got ${units}`);
  ok('C', `R2 approved once → same run ${runId} cost=${units}`);

  // Second decision must not execute again.
  try {
    await client.decideApproval(approvalId, {
      approve: true,
      decidedBy: approver.actorId,
      note: 'duplicate',
      actor: approver,
    });
    fail('C', 'second approval decision should have failed');
  } catch (err) {
    if (err instanceof RuntimeApiError) {
      ok('C', `second decision rejected (${err.code}): no double execute`);
    } else {
      throw err;
    }
  }
}

async function passDPrepare(
  client: RuntimeClient,
  actor: ReturnType<typeof createAgentActor>,
): Promise<void> {
  const requestId = process.env.PROOF_D_REQUEST_ID ?? `proof-d-${Date.now()}`;
  const paused = (await client.submitCommand({
    name: 'mission001.pass-d.followup',
    actor,
    serviceKey: SERVICE_R2,
    requestId,
    payload: { proof: 'D' },
    outcomeSummary: 'mission001 PASS D gated follow-up',
  })) as CommandResponse;

  if (paused.status !== 'awaiting_approval') {
    fail('D-PREPARE', `expected awaiting_approval, got ${paused.status}`);
  }
  const executionId = paused.execution?.executionId;
  if (!executionId) fail('D-PREPARE', 'missing stable executionId on gated response');
  if (paused.execution?.status !== 'awaiting_approval') {
    fail(
      'D-PREPARE',
      `expected execution status awaiting_approval, got ${paused.execution?.status}`,
    );
  }

  // Emit machine-readable anchors for the shell script after restart.
  console.log(`PROOF_D_REQUEST_ID=${requestId}`);
  console.log(`PROOF_D_RUN_ID=${paused.run?.runId}`);
  console.log(`PROOF_D_APPROVAL_ID=${paused.approval?.approvalId}`);
  console.log(`PROOF_D_EXECUTION_ID=${executionId}`);
  ok(
    'D-PREPARE',
    `paused execution ${executionId} run ${paused.run?.runId} approval ${paused.approval?.approvalId}`,
  );
}

async function passDResume(
  client: RuntimeClient,
  approver: ReturnType<typeof createHumanActor>,
): Promise<void> {
  const runId = process.env.PROOF_D_RUN_ID;
  const approvalId = process.env.PROOF_D_APPROVAL_ID;
  const requestId = process.env.PROOF_D_REQUEST_ID;
  const executionId = process.env.PROOF_D_EXECUTION_ID;
  if (!runId || !approvalId) fail('D-RESUME', 'PROOF_D_RUN_ID and PROOF_D_APPROVAL_ID required');
  if (!executionId) fail('D-RESUME', 'PROOF_D_EXECUTION_ID required');

  const runBody = (await client.getRun(runId)) as {
    run?: { runId: string; state: string };
    execution?: { executionId?: string; status?: string } | null;
  };
  if (!runBody.run) fail('D-RESUME', `run ${runId} not queryable after restart`);
  if (runBody.run.state !== 'awaiting_approval') {
    fail('D-RESUME', `expected awaiting_approval after restart, got ${runBody.run.state}`);
  }
  ok('D-RESUME', `run ${runId} still awaiting_approval after Runtime restart`);

  // Stable Execution Object id must survive the process kill/restart.
  const byId = (await client.getExecution(executionId, { tenantId: 'aion-systems' })) as {
    execution?: {
      executionId?: string;
      status?: string;
      runId?: string;
      outcomeSummary?: string;
    };
  };
  if (!byId.execution?.executionId) {
    fail('D-RESUME', `execution ${executionId} not queryable by id after restart`);
  }
  if (byId.execution.executionId !== executionId) {
    fail('D-RESUME', 'executionId changed across Runtime restart');
  }
  if (byId.execution.runId !== runId) {
    fail('D-RESUME', 'execution/run binding changed across restart');
  }
  if (byId.execution.status !== 'awaiting_approval') {
    fail(
      'D-RESUME',
      `expected execution awaiting_approval after restart, got ${byId.execution.status}`,
    );
  }
  ok('D-RESUME', `execution ${executionId} still awaiting_approval after Runtime restart`);

  // Replay submit with same requestId must not duplicate.
  if (requestId) {
    const replay = (await client.submitCommand({
      name: 'mission001.pass-d.followup',
      actor: authorizedActor(),
      serviceKey: SERVICE_R2,
      requestId,
    })) as CommandResponse;
    if (replay.run?.runId !== runId) {
      fail('D-RESUME', 'post-restart requestId replay changed runId');
    }
    if (replay.execution?.executionId && replay.execution.executionId !== executionId) {
      fail('D-RESUME', 'post-restart requestId replay changed executionId');
    }
  }

  const resumed = (await client.decideApproval(approvalId, {
    approve: true,
    decidedBy: approver.actorId,
    note: 'mission001 proof D after restart',
    actor: approver,
  })) as CommandResponse;
  if (resumed.status !== 'completed' || resumed.run?.runId !== runId) {
    fail('D-RESUME', `resume failed: status=${resumed.status} run=${resumed.run?.runId}`);
  }
  if (resumed.execution?.executionId !== executionId) {
    fail(
      'D-RESUME',
      `resume changed executionId: expected ${executionId}, got ${resumed.execution?.executionId}`,
    );
  }

  const byRun = (await client.getExecutionByRun(runId, { tenantId: 'aion-systems' })) as {
    execution?: {
      executionId?: string;
      status?: string;
      cost?: { units?: number };
      outcomeId?: string;
    };
  };
  if (!byRun.execution?.executionId) {
    fail('D-RESUME', 'execution not queryable by run after resume');
  }
  if (byRun.execution.executionId !== executionId) {
    fail('D-RESUME', 'get-by-run returned a different executionId after resume');
  }
  if (byRun.execution.status !== 'succeeded') {
    fail('D-RESUME', `expected execution succeeded after resume, got ${byRun.execution.status}`);
  }
  const units = Number(byRun.execution.cost?.units ?? resumed.result?.cost?.units ?? 0);
  if (!(units > 0)) fail('D-RESUME', `expected cost > 0 after restart resume, got ${units}`);

  const outcomeId =
    byRun.execution.outcomeId ??
    resumed.execution?.outcomeId ??
    resumed.outcomeReference?.outcomeId;
  if (!outcomeId) {
    fail('D-RESUME', 'expected durable outcomeId exposed on Execution Object after resume');
  }
  if (resumed.outcomeReference && resumed.outcomeReference.outcomeId !== outcomeId) {
    fail('D-RESUME', 'outcomeReference.outcomeId does not match Execution Object');
  }

  ok(
    'D',
    `restart durable — same execution ${executionId} / run ${runId} resumed once, cost=${units}, outcome=${outcomeId}`,
  );
}

main().catch((err) => {
  console.error('[PROOF] fatal', err);
  process.exit(1);
});
