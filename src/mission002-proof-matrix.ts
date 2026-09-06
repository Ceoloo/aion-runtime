/**
 * Mission 002 proof matrix — cross-domain reuse of the frozen Execution Platform.
 *
 * PASS A — Authorized Media R1 executes with cost > 0 on the same Runtime
 * PASS B — Unauthorized Media call denied before execution
 * PASS C — Media R2 publish pauses; approval resumes SAME run once
 * PASS X — Revenue service still works on the same Runtime (no Revenue redesign)
 *
 * Invoked by scripts/mission002-proof-matrix.sh against live Runtime + Postgres.
 */
import {
  createAgentActor,
  createHumanActor,
  capability,
} from '@aion/core';
import { RuntimeClient, RuntimeApiError } from './clients/runtime-client.js';

const BASE_URL =
  process.env.AION_RUNTIME_URL ?? `http://127.0.0.1:${process.env.PORT ?? '8090'}`;
const SERVICE_MEDIA_R1 = 'media.trend.research@1';
const SERVICE_MEDIA_R2 = 'media.post.publish@1';
const SERVICE_REVENUE_R1 = 'revenue.lead.research@1';

interface CommandResponse {
  status: string;
  run?: { runId: string; state?: string; requestId?: string };
  execution?: {
    executionId?: string;
    status?: string;
    cost?: { units?: number; tokens?: number };
  } | null;
  approval?: { approvalId: string; status?: string };
  decision?: { decision?: string; reason?: string };
  result?: { status?: string; cost?: { units?: number } };
  service?: {
    serviceKey?: string;
    riskLevel?: string;
    approvalRequired?: boolean;
    requiredPermissions?: string[];
    capability?: string;
    version?: number;
  };
  idempotentReplay?: boolean;
}

function fail(pass: string, msg: string): never {
  console.error(`[FAIL ${pass}] ${msg}`);
  process.exit(1);
}

function ok(pass: string, msg: string): void {
  console.log(`[PASS ${pass}] ${msg}`);
}

function mediaActor() {
  return createAgentActor({
    name: 'Mission002MediaAgent',
    purpose: 'Mission 002 Media/G-Star authorized caller.',
    owner: 'aion-runtime/proof',
    domain: 'media',
    role: 'producer',
    tenantId: 'aion-media',
    permissions: [
      capability('media.trend.research'),
      capability('media.post.publish'),
      capability('media.performance.ingest'),
    ],
    maxRiskLevel: 'R2',
    autonomyLevel: 'L2',
  });
}

function unauthorizedMediaActor() {
  return createAgentActor({
    name: 'Mission002UnauthorizedMediaAgent',
    purpose: 'Mission 002 unauthorized media caller.',
    owner: 'aion-runtime/proof',
    domain: 'media',
    role: 'observer',
    tenantId: 'aion-media',
    permissions: [capability('media.performance.ingest')],
    maxRiskLevel: 'R1',
    autonomyLevel: 'L1',
  });
}

function revenueActor() {
  return createAgentActor({
    name: 'Mission002RevenueRegressionAgent',
    purpose: 'Prove Revenue still runs on the same Runtime after Media registration.',
    owner: 'aion-runtime/proof',
    domain: 'revenue',
    role: 'copilot',
    tenantId: 'aion-systems',
    permissions: [capability('revenue.lead.research')],
    maxRiskLevel: 'R1',
    autonomyLevel: 'L1',
  });
}

function approverActor() {
  return createHumanActor({
    name: 'Mission002MediaApprover',
    permissions: [capability('media.post.publish')],
    maxRiskLevel: 'R3',
  });
}

async function main(): Promise<void> {
  const client = new RuntimeClient({ baseUrl: BASE_URL });
  const mode = process.env.PROOF_MODE ?? 'full';

  const media = mediaActor();
  const unauthorized = unauthorizedMediaActor();
  const revenue = revenueActor();
  const approver = approverActor();

  const svc = (await client.getService(SERVICE_MEDIA_R1)) as {
    service?: CommandResponse['service'];
  } & CommandResponse['service'];
  const body = (svc.service ?? svc) as NonNullable<CommandResponse['service']>;
  if (body.serviceKey !== SERVICE_MEDIA_R1) {
    fail('CATALOG', `expected ${SERVICE_MEDIA_R1}, got ${body.serviceKey}`);
  }
  if (!body.capability || !body.riskLevel || body.version == null) {
    fail('CATALOG', `Media catalog contract incomplete: ${JSON.stringify(body)}`);
  }
  if (!Array.isArray(body.requiredPermissions) || body.requiredPermissions.length < 1) {
    fail('CATALOG', 'Media service missing requiredPermissions');
  }
  ok(
    'CATALOG',
    `${SERVICE_MEDIA_R1} resolves capability=${body.capability} risk=${body.riskLevel}`,
  );

  if (mode === 'full' || mode === 'ab') {
    await passA(client, media);
    await passB(client, unauthorized);
  }
  if (mode === 'full' || mode === 'c') {
    await passC(client, media, approver);
  }
  if (mode === 'full' || mode === 'x') {
    await passX(client, revenue);
  }

  console.log('[PROOF] Mission 002 cross-domain matrix segment complete');
}

async function passA(
  client: RuntimeClient,
  actor: ReturnType<typeof createAgentActor>,
): Promise<void> {
  const res = (await client.submitCommand({
    name: 'mission002.pass-a.research',
    actor,
    serviceKey: SERVICE_MEDIA_R1,
    requestId: `m002-a-${Date.now()}`,
    payload: { proof: 'A', venture: 'g-star' },
  })) as CommandResponse;

  if (res.status !== 'completed') fail('A', `expected completed, got ${res.status}`);
  const units = Number(res.result?.cost?.units ?? res.execution?.cost?.units ?? 0);
  if (!(units > 0)) fail('A', `expected cost.units > 0, got ${units}`);
  if (!res.execution?.executionId) fail('A', 'missing executionId');
  if (!res.service?.serviceKey) fail('A', 'missing catalog snapshot');
  if (res.service.riskLevel !== 'R1') fail('A', `expected R1, got ${res.service.riskLevel}`);
  ok('A', `Media R1 ${SERVICE_MEDIA_R1} completed cost=${units} execution=${res.execution.executionId}`);
}

async function passB(
  client: RuntimeClient,
  actor: ReturnType<typeof createAgentActor>,
): Promise<void> {
  try {
    const res = (await client.submitCommand({
      name: 'mission002.pass-b.denied',
      actor,
      serviceKey: SERVICE_MEDIA_R1,
      requestId: `m002-b-${Date.now()}`,
    })) as CommandResponse;
    if (res.status !== 'denied') fail('B', `expected denied, got ${res.status}`);
    ok('B', `unauthorized Media caller denied (${res.decision?.reason ?? res.status})`);
  } catch (err) {
    if (err instanceof RuntimeApiError && err.status === 403) {
      ok('B', `unauthorized Media caller denied with HTTP 403 (${err.message})`);
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
  const requestId = `m002-c-${Date.now()}`;
  const paused = (await client.submitCommand({
    name: 'mission002.pass-c.publish',
    actor,
    serviceKey: SERVICE_MEDIA_R2,
    requestId,
    payload: { proof: 'C', channel: 'g-star' },
  })) as CommandResponse;

  if (paused.status !== 'awaiting_approval') {
    fail('C', `expected awaiting_approval, got ${paused.status}`);
  }
  const runId = paused.run?.runId;
  const approvalId = paused.approval?.approvalId;
  if (!runId || !approvalId) fail('C', 'missing runId/approvalId');
  if (paused.service && paused.service.approvalRequired !== true) {
    fail('C', 'catalog snapshot should report approvalRequired=true for publish');
  }

  const replay = (await client.submitCommand({
    name: 'mission002.pass-c.publish',
    actor,
    serviceKey: SERVICE_MEDIA_R2,
    requestId,
  })) as CommandResponse;
  if (replay.run?.runId !== runId) fail('C', 'requestId replay changed runId');
  if (replay.idempotentReplay !== true) fail('C', 'expected idempotentReplay=true');

  const resumed = (await client.decideApproval(approvalId, {
    approve: true,
    decidedBy: approver.actorId,
    note: 'mission002 proof C',
    actor: approver,
  })) as CommandResponse;
  if (resumed.status !== 'completed') fail('C', `expected completed, got ${resumed.status}`);
  if (resumed.run?.runId !== runId) fail('C', 'approval resumed different run');
  const units = Number(resumed.result?.cost?.units ?? resumed.execution?.cost?.units ?? 0);
  if (!(units > 0)) fail('C', `expected cost > 0 after publish approval, got ${units}`);
  ok('C', `Media R2 publish approved once → same run ${runId} cost=${units}`);

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
      ok('C', `second decision rejected (${err.code}): no double publish`);
    } else {
      throw err;
    }
  }
}

async function passX(
  client: RuntimeClient,
  actor: ReturnType<typeof createAgentActor>,
): Promise<void> {
  const res = (await client.submitCommand({
    name: 'mission002.pass-x.revenue-regression',
    actor,
    serviceKey: SERVICE_REVENUE_R1,
    requestId: `m002-x-${Date.now()}`,
    payload: { proof: 'X' },
  })) as CommandResponse;
  if (res.status !== 'completed') fail('X', `Revenue regression failed: ${res.status}`);
  const units = Number(res.result?.cost?.units ?? res.execution?.cost?.units ?? 0);
  if (!(units > 0)) fail('X', `Revenue cost expected > 0, got ${units}`);
  ok(
    'X',
    `same Runtime still serves Revenue ${SERVICE_REVENUE_R1} cost=${units} (no Revenue redesign)`,
  );
}

main().catch((err) => {
  console.error('[PROOF] fatal', err);
  process.exit(1);
});
