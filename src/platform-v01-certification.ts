/**
 * AION Execution Platform v0.1 — Multi-Domain Certification.
 *
 * Complements proof:mission001 / proof:mission002. Certifies the release claim:
 * one Runtime serves Revenue and Media/G-Star through the same governed
 * Execution contract without cross-domain leakage.
 *
 * CERT-CATALOG     — both domains resolve via the same catalog mechanism
 * CERT-REGRESSION  — Mission 001 Revenue path still green after Mission 002
 * CERT-CROSS       — Revenue + Media invoke the same Execution contract
 * CERT-GOVERNANCE  — R1 deny + R2 approval paths work regardless of domain
 * CERT-ECONOMICS   — both domains produce non-zero cost records
 * CERT-ATTRIBUTION — domain-appropriate outcomes; generic Execution stays clean
 * CERT-ISOLATION   — sharing Runtime does not grant cross-domain capability
 * CERT-DURABILITY  — paused R2 runs from both domains survive Runtime restart
 *
 * Modes (PROOF_MODE): full | d-prepare | d-resume
 * Invoked by scripts/platform-v01-certification.sh
 */
import {
  createAgentActor,
  createHumanActor,
  capability,
} from '@aion/core';
import { RuntimeClient, RuntimeApiError } from './clients/runtime-client.js';

const BASE_URL =
  process.env.AION_RUNTIME_URL ?? `http://127.0.0.1:${process.env.PORT ?? '8090'}`;

const SERVICE_REVENUE_R1 = 'revenue.lead.research@1';
const SERVICE_REVENUE_R2 = 'revenue.followup.execute@1';
const SERVICE_MEDIA_R1 = 'media.trend.research@1';
const SERVICE_MEDIA_R2 = 'media.post.publish@1';

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

function revenueActor() {
  return createAgentActor({
    name: 'PlatformV01RevenueAgent',
    purpose: 'v0.1 certification — Revenue domain caller.',
    owner: 'aion-runtime/cert',
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

function mediaActor() {
  return createAgentActor({
    name: 'PlatformV01MediaAgent',
    purpose: 'v0.1 certification — Media/G-Star domain caller.',
    owner: 'aion-runtime/cert',
    domain: 'media',
    role: 'producer',
    tenantId: 'aion-media',
    permissions: [
      capability('media.trend.research'),
      capability('media.post.publish'),
    ],
    maxRiskLevel: 'R2',
    autonomyLevel: 'L2',
  });
}

function revenueApprover() {
  return createHumanActor({
    name: 'PlatformV01RevenueApprover',
    permissions: [capability('revenue.followup.execute')],
    maxRiskLevel: 'R3',
  });
}

function mediaApprover() {
  return createHumanActor({
    name: 'PlatformV01MediaApprover',
    permissions: [capability('media.post.publish')],
    maxRiskLevel: 'R3',
  });
}

async function main(): Promise<void> {
  const client = new RuntimeClient({ baseUrl: BASE_URL });
  const mode = process.env.PROOF_MODE ?? 'full';

  if (mode === 'd-prepare') {
    await durabilityPrepare(client);
    return;
  }
  if (mode === 'd-resume') {
    await durabilityResume(client);
    return;
  }

  await certCatalog(client);
  await certRegressionAndCrossDomain(client);
  await certGovernanceAndEconomics(client);
  await certAttribution(client);
  await certIsolationBaseline(client);

  console.log('[CERT] AION Execution Platform v0.1 multi-domain segment complete');
  console.log(
    '[CERT] CERT-DURABILITY (dual-domain restart) is exercised by scripts/platform-v01-certification.sh',
  );
}

async function certCatalog(client: RuntimeClient): Promise<void> {
  for (const key of [
    SERVICE_REVENUE_R1,
    SERVICE_MEDIA_R1,
    SERVICE_REVENUE_R2,
    SERVICE_MEDIA_R2,
  ]) {
    const svc = (await client.getService(key)) as {
      service?: CommandResponse['service'];
    } & CommandResponse['service'];
    const body = (svc.service ?? svc) as NonNullable<CommandResponse['service']>;
    if (body.serviceKey !== key) {
      fail('CERT-CATALOG', `expected serviceKey ${key}, got ${body.serviceKey}`);
    }
    if (!body.capability || !body.riskLevel || body.version == null) {
      fail('CERT-CATALOG', `incomplete catalog contract for ${key}: ${JSON.stringify(body)}`);
    }
    if (!Array.isArray(body.requiredPermissions) || body.requiredPermissions.length < 1) {
      fail('CERT-CATALOG', `${key} missing requiredPermissions`);
    }
  }
  ok('CERT-CATALOG', 'Revenue + Media services resolve through the same catalog mechanism');
}

async function certRegressionAndCrossDomain(client: RuntimeClient): Promise<void> {
  const revenue = revenueActor();
  const media = mediaActor();

  const rev = (await client.submitCommand({
    name: 'platform-v01.cert.revenue-r1',
    actor: revenue,
    serviceKey: SERVICE_REVENUE_R1,
    requestId: `cert-rev-r1-${Date.now()}`,
    payload: { cert: 'regression', domain: 'revenue' },
  })) as CommandResponse;
  if (rev.status !== 'completed') {
    fail('CERT-REGRESSION', `Revenue R1 expected completed, got ${rev.status}`);
  }
  const revUnits = Number(rev.result?.cost?.units ?? rev.execution?.cost?.units ?? 0);
  if (!(revUnits > 0)) {
    fail('CERT-REGRESSION', `Revenue R1 expected cost.units > 0, got ${revUnits}`);
  }
  ok('CERT-REGRESSION', `Revenue R1 ${SERVICE_REVENUE_R1} remains green after Mission 002`);

  const med = (await client.submitCommand({
    name: 'platform-v01.cert.media-r1',
    actor: media,
    serviceKey: SERVICE_MEDIA_R1,
    requestId: `cert-med-r1-${Date.now()}`,
    payload: { cert: 'cross-domain', domain: 'media', venture: 'g-star' },
  })) as CommandResponse;
  if (med.status !== 'completed') {
    fail('CERT-CROSS', `Media R1 expected completed, got ${med.status}`);
  }
  const medUnits = Number(med.result?.cost?.units ?? med.execution?.cost?.units ?? 0);
  if (!(medUnits > 0)) {
    fail('CERT-CROSS', `Media R1 expected cost.units > 0, got ${medUnits}`);
  }

  for (const [label, res] of [
    ['revenue', rev],
    ['media', med],
  ] as const) {
    if (!res.execution?.executionId) fail('CERT-CROSS', `${label} missing executionId`);
    if (!res.service?.serviceKey) fail('CERT-CROSS', `${label} missing catalog snapshot`);
    if (res.service.riskLevel !== 'R1') {
      fail('CERT-CROSS', `${label} expected R1 snapshot, got ${res.service.riskLevel}`);
    }
  }
  ok('CERT-CROSS', 'Revenue + Media both completed via the same Execution contract');
}

async function certGovernanceAndEconomics(client: RuntimeClient): Promise<void> {
  const revenue = revenueActor();
  const media = mediaActor();

  const mediaOnly = createAgentActor({
    name: 'PlatformV01MediaOnlyForDeny',
    purpose: 'v0.1 certification deny-path actor (media perms only).',
    owner: 'aion-runtime/cert',
    domain: 'media',
    role: 'observer',
    tenantId: 'aion-media',
    permissions: [capability('media.trend.research')],
    maxRiskLevel: 'R1',
    autonomyLevel: 'L1',
  });
  try {
    const denied = (await client.submitCommand({
      name: 'platform-v01.cert.governance-deny',
      actor: mediaOnly,
      serviceKey: SERVICE_REVENUE_R1,
      requestId: `cert-deny-${Date.now()}`,
    })) as CommandResponse;
    if (denied.status !== 'denied') {
      fail('CERT-GOVERNANCE', `expected denied, got ${denied.status}`);
    }
    ok(
      'CERT-GOVERNANCE',
      `cross-domain deny before execute (${denied.decision?.reason ?? denied.status})`,
    );
  } catch (err) {
    if (err instanceof RuntimeApiError && err.status === 403) {
      ok('CERT-GOVERNANCE', `cross-domain deny with HTTP 403 (${err.message})`);
    } else {
      throw err;
    }
  }

  const revUnits = await approveOnce(
    client,
    revenue,
    revenueApprover(),
    SERVICE_REVENUE_R2,
    'platform-v01.cert.revenue-r2',
    { cert: 'governance', domain: 'revenue' },
    'CERT-GOVERNANCE',
  );
  const medUnits = await approveOnce(
    client,
    media,
    mediaApprover(),
    SERVICE_MEDIA_R2,
    'platform-v01.cert.media-r2',
    { cert: 'governance', domain: 'media', channel: 'g-star' },
    'CERT-GOVERNANCE',
  );

  if (!(revUnits > 0) || !(medUnits > 0)) {
    fail(
      'CERT-ECONOMICS',
      `expected non-zero cost for both domains (revenue=${revUnits}, media=${medUnits})`,
    );
  }
  ok(
    'CERT-ECONOMICS',
    `both domains produced non-zero cost records (revenue=${revUnits}, media=${medUnits})`,
  );
  ok(
    'CERT-GOVERNANCE',
    'R1 deny + R2 approval paths work for Revenue and Media on the same Runtime',
  );
}

async function approveOnce(
  client: RuntimeClient,
  actor: ReturnType<typeof createAgentActor>,
  approver: ReturnType<typeof createHumanActor>,
  serviceKey: string,
  name: string,
  payload: Record<string, unknown>,
  pass: string,
): Promise<number> {
  const requestId = `${name}-${Date.now()}`;
  const paused = (await client.submitCommand({
    name,
    actor,
    serviceKey,
    requestId,
    payload,
  })) as CommandResponse;
  if (paused.status !== 'awaiting_approval') {
    fail(pass, `${serviceKey}: expected awaiting_approval, got ${paused.status}`);
  }
  const approvalId = paused.approval?.approvalId;
  const runId = paused.run?.runId;
  if (!approvalId || !runId) fail(pass, `${serviceKey}: missing approvalId/runId`);

  const resumed = (await client.decideApproval(approvalId, {
    approve: true,
    decidedBy: approver.actorId,
    note: `platform-v01 ${serviceKey}`,
    actor: approver,
  })) as CommandResponse;
  if (resumed.status !== 'completed' || resumed.run?.runId !== runId) {
    fail(pass, `${serviceKey}: approval resume failed status=${resumed.status}`);
  }
  return Number(resumed.result?.cost?.units ?? resumed.execution?.cost?.units ?? 0);
}

async function certAttribution(client: RuntimeClient): Promise<void> {
  const revenue = revenueActor();
  const media = mediaActor();

  const rev = (await client.submitCommand({
    name: 'platform-v01.cert.attr-revenue',
    actor: revenue,
    serviceKey: SERVICE_REVENUE_R1,
    requestId: `cert-attr-rev-${Date.now()}`,
    payload: { cert: 'attribution', leadId: 'lead-systems-1' },
  })) as CommandResponse;
  const med = (await client.submitCommand({
    name: 'platform-v01.cert.attr-media',
    actor: media,
    serviceKey: SERVICE_MEDIA_R1,
    requestId: `cert-attr-med-${Date.now()}`,
    payload: { cert: 'attribution', assetId: 'gstar-clip-1' },
  })) as CommandResponse;

  if (rev.status !== 'completed' || med.status !== 'completed') {
    fail('CERT-ATTRIBUTION', 'attribution setup executions did not complete');
  }
  if (rev.service?.serviceKey !== SERVICE_REVENUE_R1) {
    fail('CERT-ATTRIBUTION', 'Revenue response contaminated catalog serviceKey');
  }
  if (med.service?.serviceKey !== SERVICE_MEDIA_R1) {
    fail('CERT-ATTRIBUTION', 'Media response contaminated catalog serviceKey');
  }

  const revExecId = rev.execution?.executionId;
  const medExecId = med.execution?.executionId;
  if (!revExecId || !medExecId) fail('CERT-ATTRIBUTION', 'missing executionIds');
  if (revExecId === medExecId) {
    fail('CERT-ATTRIBUTION', 'domains must not share the same executionId');
  }

  const revFetched = (await client.getExecution(revExecId, { tenantId: 'aion-systems' })) as {
    execution?: Record<string, unknown> & { executionId?: string };
  };
  const medFetched = (await client.getExecution(medExecId, { tenantId: 'aion-media' })) as {
    execution?: Record<string, unknown> & { executionId?: string };
  };
  const revE = revFetched.execution ?? (revFetched as { executionId?: string });
  const medE = medFetched.execution ?? (medFetched as { executionId?: string });
  if (!revE.executionId || !medE.executionId) {
    fail('CERT-ATTRIBUTION', 'executions not independently queryable');
  }

  const forbiddenOnGeneric = ['leadId', 'assetId', 'ghlContactId', 'crmDealId'];
  for (const field of forbiddenOnGeneric) {
    if (field in revE) {
      fail(
        'CERT-ATTRIBUTION',
        `Revenue Execution Object leaked domain field "${field}" onto generic contract`,
      );
    }
    if (field in medE) {
      fail(
        'CERT-ATTRIBUTION',
        `Media Execution Object leaked domain field "${field}" onto generic contract`,
      );
    }
  }

  ok(
    'CERT-ATTRIBUTION',
    'domain-appropriate catalog attribution with isolated executionIds; generic Execution uncontaminated',
  );
}

async function certIsolationBaseline(client: RuntimeClient): Promise<void> {
  const revenue = revenueActor();
  const media = mediaActor();

  try {
    const res = (await client.submitCommand({
      name: 'platform-v01.cert.isolation-media-to-revenue',
      actor: media,
      serviceKey: SERVICE_REVENUE_R1,
      requestId: `cert-iso-m2r-${Date.now()}`,
      payload: { attempt: 'media→revenue' },
    })) as CommandResponse;
    if (res.status !== 'denied') {
      fail(
        'CERT-ISOLATION',
        `Media agent must not execute Revenue service; got status=${res.status}`,
      );
    }
    ok('CERT-ISOLATION', 'Media agent denied on Revenue service at platform boundary');
  } catch (err) {
    if (err instanceof RuntimeApiError && err.status === 403) {
      ok('CERT-ISOLATION', `Media agent denied on Revenue with HTTP 403 (${err.message})`);
    } else {
      throw err;
    }
  }

  try {
    const res = (await client.submitCommand({
      name: 'platform-v01.cert.isolation-revenue-to-media',
      actor: revenue,
      serviceKey: SERVICE_MEDIA_R1,
      requestId: `cert-iso-r2m-${Date.now()}`,
      payload: { attempt: 'revenue→media' },
    })) as CommandResponse;
    if (res.status !== 'denied') {
      fail(
        'CERT-ISOLATION',
        `Revenue agent must not execute Media service; got status=${res.status}`,
      );
    }
    ok('CERT-ISOLATION', 'Revenue agent denied on Media service at platform boundary');
  } catch (err) {
    if (err instanceof RuntimeApiError && err.status === 403) {
      ok('CERT-ISOLATION', `Revenue agent denied on Media with HTTP 403 (${err.message})`);
    } else {
      throw err;
    }
  }

  ok(
    'CERT-ISOLATION',
    'Isolation baseline held — Mission 003 will deepen tenant hierarchy on this boundary',
  );
}

async function durabilityPrepare(client: RuntimeClient): Promise<void> {
  const revenue = revenueActor();
  const media = mediaActor();
  const revReq = process.env.CERT_D_REVENUE_REQUEST_ID ?? `cert-d-rev-${Date.now()}`;
  const medReq = process.env.CERT_D_MEDIA_REQUEST_ID ?? `cert-d-med-${Date.now()}`;

  const revPaused = (await client.submitCommand({
    name: 'platform-v01.cert.durability-revenue',
    actor: revenue,
    serviceKey: SERVICE_REVENUE_R2,
    requestId: revReq,
    payload: { cert: 'durability', domain: 'revenue' },
  })) as CommandResponse;
  const medPaused = (await client.submitCommand({
    name: 'platform-v01.cert.durability-media',
    actor: media,
    serviceKey: SERVICE_MEDIA_R2,
    requestId: medReq,
    payload: { cert: 'durability', domain: 'media' },
  })) as CommandResponse;

  if (revPaused.status !== 'awaiting_approval' || medPaused.status !== 'awaiting_approval') {
    fail(
      'CERT-DURABILITY-PREPARE',
      `expected both awaiting_approval (rev=${revPaused.status}, med=${medPaused.status})`,
    );
  }

  console.log(`CERT_D_REVENUE_REQUEST_ID=${revReq}`);
  console.log(`CERT_D_REVENUE_RUN_ID=${revPaused.run?.runId}`);
  console.log(`CERT_D_REVENUE_APPROVAL_ID=${revPaused.approval?.approvalId}`);
  console.log(`CERT_D_MEDIA_REQUEST_ID=${medReq}`);
  console.log(`CERT_D_MEDIA_RUN_ID=${medPaused.run?.runId}`);
  console.log(`CERT_D_MEDIA_APPROVAL_ID=${medPaused.approval?.approvalId}`);
  ok(
    'CERT-DURABILITY-PREPARE',
    `paused revenue run ${revPaused.run?.runId} + media run ${medPaused.run?.runId}`,
  );
}

async function durabilityResume(client: RuntimeClient): Promise<void> {
  const revRunId = process.env.CERT_D_REVENUE_RUN_ID;
  const revApprovalId = process.env.CERT_D_REVENUE_APPROVAL_ID;
  const medRunId = process.env.CERT_D_MEDIA_RUN_ID;
  const medApprovalId = process.env.CERT_D_MEDIA_APPROVAL_ID;
  if (!revRunId || !revApprovalId || !medRunId || !medApprovalId) {
    fail(
      'CERT-DURABILITY-RESUME',
      'CERT_D_REVENUE_* and CERT_D_MEDIA_* run/approval anchors required',
    );
  }

  for (const [label, runId] of [
    ['revenue', revRunId],
    ['media', medRunId],
  ] as const) {
    const runBody = (await client.getRun(runId)) as {
      run?: { runId: string; state: string };
    };
    if (!runBody.run) {
      fail('CERT-DURABILITY', `${label} run ${runId} not queryable after restart`);
    }
    if (runBody.run.state !== 'awaiting_approval') {
      fail(
        'CERT-DURABILITY',
        `${label} expected awaiting_approval after restart, got ${runBody.run.state}`,
      );
    }
  }
  ok('CERT-DURABILITY', 'Revenue + Media paused runs both survived Runtime restart');

  const revApprover = revenueApprover();
  const medApprover = mediaApprover();

  const revResumed = (await client.decideApproval(revApprovalId, {
    approve: true,
    decidedBy: revApprover.actorId,
    note: 'platform-v01 durability revenue',
    actor: revApprover,
  })) as CommandResponse;
  const medResumed = (await client.decideApproval(medApprovalId, {
    approve: true,
    decidedBy: medApprover.actorId,
    note: 'platform-v01 durability media',
    actor: medApprover,
  })) as CommandResponse;

  if (revResumed.status !== 'completed' || revResumed.run?.runId !== revRunId) {
    fail('CERT-DURABILITY', `revenue resume failed: ${revResumed.status}`);
  }
  if (medResumed.status !== 'completed' || medResumed.run?.runId !== medRunId) {
    fail('CERT-DURABILITY', `media resume failed: ${medResumed.status}`);
  }

  const revByRun = (await client.getExecutionByRun(revRunId, { tenantId: 'aion-systems' })) as {
    execution?: { executionId?: string; cost?: { units?: number } };
  };
  const medByRun = (await client.getExecutionByRun(medRunId, { tenantId: 'aion-media' })) as {
    execution?: { executionId?: string; cost?: { units?: number } };
  };
  const revUnits = Number(revByRun.execution?.cost?.units ?? revResumed.result?.cost?.units ?? 0);
  const medUnits = Number(medByRun.execution?.cost?.units ?? medResumed.result?.cost?.units ?? 0);
  if (!(revUnits > 0) || !(medUnits > 0)) {
    fail(
      'CERT-DURABILITY',
      `expected cost > 0 after dual resume (revenue=${revUnits}, media=${medUnits})`,
    );
  }
  ok(
    'CERT-DURABILITY',
    `dual-domain restart durable — revenue ${revRunId} + media ${medRunId} resumed once with cost`,
  );
}

main().catch((err) => {
  console.error('[CERT] fatal', err);
  process.exit(1);
});
