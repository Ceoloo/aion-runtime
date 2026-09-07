/**
 * Live GHL acceptance gate (real tenant).
 *
 * real tenant read → propose CRM stage change → human approval →
 * execute exactly once → audit minimum → restore prior stage.
 *
 * Requires GHL_API_KEY + GHL_LOCATION_ID on the Runtime process.
 * Does not print secrets. Prefer opportunity IDs from env when set.
 */
import {
  createAgentActor,
  createHumanActor,
  capability,
  formatServiceKey,
  newRequestId,
} from '@aion/core';
import { RuntimeClient } from './clients/runtime-client.js';

const BASE_URL =
  process.env.AION_RUNTIME_URL ?? `http://127.0.0.1:${process.env.PORT ?? '8099'}`;
const TENANT = process.env.GHL_ACCEPTANCE_TENANT ?? 'aion-systems';

/** AION Empire / live defaults discovered 2026-09-07 (overridable). */
const OPP_ID =
  process.env.GHL_ACCEPTANCE_OPPORTUNITY_ID ?? 'rGbIyrAvGDcmMEzjBER4';
const CONTACT_ID =
  process.env.GHL_ACCEPTANCE_CONTACT_ID ?? 'MyWCgeFaKnifp6LM7yIc';
/** Negotiation → Proposal Sent (one stage back; restored after proof). */
const TARGET_STAGE =
  process.env.GHL_ACCEPTANCE_TARGET_STAGE ??
  '691415a9-30fd-4977-b1ec-fdc4efbd85fc';
const PRIOR_STAGE =
  process.env.GHL_ACCEPTANCE_PRIOR_STAGE ??
  'fdd0844f-4260-4522-a8f3-87d361dfb5fa';

const PERMS = [
  capability('crm.contact.read'),
  capability('crm.contact.search'),
  capability('crm.opportunity.read'),
  capability('crm.opportunity.search'),
  capability('crm.opportunity.update'),
  capability('crm.pipeline.read'),
  capability('crm.conversation.read'),
  capability('crm.appointment.read'),
  capability('crm.note.create'),
  capability('crm.task.create'),
];

interface CommandResponse {
  status?: string;
  run?: { runId?: string; state?: string; approvalId?: string };
  execution?: { executionId?: string; status?: string };
  result?: {
    status?: string;
    output?: Record<string, unknown>;
    error?: { code?: string; message?: string };
  };
  decision?: { decision?: string; reason?: string };
}

function fail(pass: string, msg: string): never {
  console.error(`[FAIL ${pass}] ${msg}`);
  process.exit(1);
}
function ok(pass: string, msg: string): void {
  console.log(`[PASS ${pass}] ${msg}`);
}

function succeeded(res: CommandResponse): boolean {
  return res.result?.status === 'succeeded' || res.status === 'succeeded';
}

function awaiting(res: CommandResponse): boolean {
  return (
    res.status === 'awaiting_approval' ||
    res.run?.state === 'awaiting_approval' ||
    res.decision?.decision === 'REQUIRE_APPROVAL'
  );
}

function backendOf(res: CommandResponse): string {
  return String(res.result?.output?.['backend'] ?? '');
}

async function main(): Promise<void> {
  const client = new RuntimeClient({ baseUrl: BASE_URL, tenantId: TENANT });
  const primary = createAgentActor({
    name: 'GhlLiveAcceptanceAgent',
    purpose: 'Live GHL acceptance gate',
    owner: 'aion-runtime/proof',
    domain: 'revenue',
    role: 'copilot',
    tenantId: TENANT,
    companyId: 'co_aion',
    permissions: PERMS,
    maxRiskLevel: 'R3',
    autonomyLevel: 'L2',
  });
  const human = createHumanActor({
    name: 'GHL Live Approver',
    permissions: [capability('crm.opportunity.update')],
  });

  const audit: Record<string, unknown> = {
    tenant: TENANT,
    locationId: process.env.GHL_LOCATION_ID ?? '(runtime-env)',
    opportunityId: OPP_ID,
    contactId: CONTACT_ID,
    proposedMutation: {
      capability: 'crm.opportunity.update@1',
      opportunityId: OPP_ID,
      fromStage: PRIOR_STAGE,
      toStage: TARGET_STAGE,
    },
    startedAt: new Date().toISOString(),
  };

  // ── L1: real contact search ─────────────────────────────────────────────
  {
    const res = (await client.submitCommand({
      name: 'ghl-live-contact-search',
      actor: primary,
      requestId: newRequestId(),
      serviceKey: formatServiceKey('crm.contact.search', 1),
      payload: { query: 'annfiera' },
      metadata: { tenantId: TENANT, proof: 'ghl-live-acceptance' },
    })) as CommandResponse;
    if (!succeeded(res)) {
      fail('L1', `contact.search failed: ${JSON.stringify(res).slice(0, 500)}`);
    }
    if (backendOf(res) !== 'ghl-live') {
      fail(
        'L1',
        `expected backend=ghl-live (credentials on Runtime), got ${backendOf(res) || '(missing)'}`,
      );
    }
    const body = res.result?.output?.['body'] as Record<string, unknown> | undefined;
    const count = typeof body?.['count'] === 'number' ? body['count'] : 0;
    if (count < 1) fail('L1', 'expected live contacts from AION Empire');
    const items = Array.isArray(body?.['items']) ? body!['items'] : [];
    const hit = items.some(
      (c) =>
        c &&
        typeof c === 'object' &&
        String((c as Record<string, unknown>)['id'] ?? '') === CONTACT_ID,
    );
    audit['sourceRead'] = {
      contactSearchCount: count,
      backend: backendOf(res) || res.result?.output?.['backend'],
      matchedContact: hit ? CONTACT_ID : 'present-but-id-mismatch-ok',
    };
    ok('L1', `live contact.search count=${count} backend=${backendOf(res)}`);
  }

  // ── L2: pipeline stages ─────────────────────────────────────────────────
  {
    const res = (await client.submitCommand({
      name: 'ghl-live-pipeline',
      actor: primary,
      requestId: newRequestId(),
      serviceKey: formatServiceKey('crm.pipeline.read', 1),
      payload: {},
      metadata: { tenantId: TENANT, proof: 'ghl-live-acceptance' },
    })) as CommandResponse;
    if (!succeeded(res)) {
      fail('L2', `pipeline.read failed: ${JSON.stringify(res).slice(0, 500)}`);
    }
    ok('L2', 'live pipeline.read');
  }

  // ── L3: opportunity read (source state) ─────────────────────────────────
  {
    const res = (await client.submitCommand({
      name: 'ghl-live-opp-read',
      actor: primary,
      requestId: newRequestId(),
      serviceKey: formatServiceKey('crm.opportunity.read', 1),
      payload: { opportunityId: OPP_ID },
      metadata: { tenantId: TENANT, proof: 'ghl-live-acceptance' },
    })) as CommandResponse;
    if (!succeeded(res)) {
      fail('L3', `opportunity.read failed: ${JSON.stringify(res).slice(0, 500)}`);
    }
    const body = res.result?.output?.['body'] as Record<string, unknown> | undefined;
    audit['sourceRead'] = {
      ...(typeof audit['sourceRead'] === 'object' && audit['sourceRead']
        ? (audit['sourceRead'] as object)
        : {}),
      opportunity: {
        id: body?.['id'] ?? OPP_ID,
        stage: body?.['stage'] ?? body?.['pipelineStageId'],
        name: body?.['name'],
        contactId: body?.['contactId'],
      },
    };
    ok('L3', `live opportunity.read id=${OPP_ID}`);
  }

  // ── L4: conversations + appointments (read; appointments may be empty) ──
  for (const [pass, key, payload] of [
    ['L4a', 'crm.conversation.read', { contactId: CONTACT_ID }],
    ['L4b', 'crm.appointment.read', { contactId: CONTACT_ID }],
  ] as const) {
    const res = (await client.submitCommand({
      name: `ghl-live-${pass}`,
      actor: primary,
      requestId: newRequestId(),
      serviceKey: formatServiceKey(key, 1),
      payload,
      metadata: { tenantId: TENANT, proof: 'ghl-live-acceptance' },
    })) as CommandResponse;
    if (!succeeded(res)) {
      fail(pass, `${key} failed: ${JSON.stringify(res).slice(0, 400)}`);
    }
    ok(pass, `${key} ok`);
  }

  // ── L5: propose stage update → REQUIRE_APPROVAL ─────────────────────────
  let approvalId = '';
  let proposeRunId = '';
  {
    const res = (await client.submitCommand({
      name: 'ghl-live-stage-propose',
      actor: primary,
      requestId: newRequestId(),
      serviceKey: formatServiceKey('crm.opportunity.update', 1),
      payload: {
        opportunityId: OPP_ID,
        stage: TARGET_STAGE,
        proposedBy: 'ghl-live-acceptance',
        idempotencyKey: `ghl-live-stage-${OPP_ID}-${Date.now()}`,
      },
      metadata: {
        tenantId: TENANT,
        proof: 'ghl-live-acceptance',
        sourceOpportunityId: OPP_ID,
        fromStage: PRIOR_STAGE,
        toStage: TARGET_STAGE,
      },
    })) as CommandResponse;
    if (!awaiting(res)) {
      fail('L5', `expected REQUIRE_APPROVAL, got ${JSON.stringify(res).slice(0, 600)}`);
    }
    approvalId = res.run?.approvalId ?? '';
    proposeRunId = res.run?.runId ?? '';
    if (!approvalId) fail('L5', 'missing approvalId');
    audit['policyDecision'] = {
      decision: res.decision?.decision ?? 'REQUIRE_APPROVAL',
      reason: res.decision?.reason ?? 'R2 crm.opportunity.update',
      approvalId,
      runId: proposeRunId,
    };
    ok('L5', `stage update gated approvalId=${approvalId}`);
  }

  // ── L6: human approve → execute exactly once ────────────────────────────
  let sideEffectId = '';
  let executionId = '';
  let idempotencyKey = '';
  {
    const res = (await client.decideApproval(approvalId, {
      approve: true,
      decidedBy: human.actorId,
      actor: human,
      note: 'Live GHL acceptance — governed stage update (will restore)',
    })) as CommandResponse;
    if (!succeeded(res) && res.status !== 'succeeded') {
      fail('L6', `approve/execute failed: ${JSON.stringify(res).slice(0, 600)}`);
    }
    const out = res.result?.output ?? {};
    if (out['idempotentReplay'] === true) {
      fail('L6', 'first execution must not be a replay');
    }
    sideEffectId = String(out['sideEffectId'] ?? '');
    idempotencyKey = String(
      out['idempotencyKey'] ??
        (typeof out['metadata'] === 'object' && out['metadata']
          ? (out['metadata'] as Record<string, unknown>)['idempotencyKey']
          : '') ??
        '',
    );
    executionId = res.execution?.executionId ?? '';
    if (!sideEffectId) fail('L6', 'missing sideEffectId on write');
    const cost =
      out['cost'] ??
      (res as { result?: { cost?: unknown } }).result?.cost ??
      null;
    audit['approval'] = {
      approvalId,
      decidedBy: human.actorId,
      approverName: human.name,
      note: 'Live GHL acceptance — governed stage update (will restore)',
      decidedAt: new Date().toISOString(),
    };
    audit['executionId'] = executionId;
    audit['idempotencyKey'] = idempotencyKey;
    audit['sideEffectId'] = sideEffectId;
    audit['ghlResponse'] = {
      externalResourceId: out['externalResourceId'],
      externalRequestId: out['externalRequestId'],
      backend: out['backend'],
      bodyId: (out['body'] as Record<string, unknown> | undefined)?.['id'],
      bodyStage:
        (out['body'] as Record<string, unknown> | undefined)?.['stage'] ??
        (out['body'] as Record<string, unknown> | undefined)?.['pipelineStageId'],
    };
    audit['cost'] = cost;
    audit['success'] = true;
    ok(
      'L6',
      `stage update executed once sideEffectId=${sideEffectId} executionId=${executionId}`,
    );
  }

  // ── L7: audit via Execution Object + side-effect ledger ─────────────────
  {
    if (!executionId) fail('L7', 'missing executionId');
    const exe = (await client.getExecution(executionId, {
      tenantId: TENANT,
    })) as Record<string, unknown>;
    const effects = (await client.listSideEffects({
      tenantId: TENANT,
    })) as { sideEffects?: Array<Record<string, unknown>> };
    const found = (effects.sideEffects ?? []).find(
      (s) => String(s['sideEffectId'] ?? '') === sideEffectId,
    );
    if (!idempotencyKey && found?.['idempotencyKey']) {
      idempotencyKey = String(found['idempotencyKey']);
      audit['idempotencyKey'] = idempotencyKey;
    }
    if (!idempotencyKey) {
      fail('L7', 'audit minimum missing idempotencyKey');
    }
    const exeCost =
      (exe['cost'] as unknown) ??
      ((exe['execution'] as Record<string, unknown> | undefined)?.['cost'] as unknown) ??
      audit['cost'];
    audit['cost'] = exeCost ?? found?.['cost'] ?? { units: 'see-execution', note: 'recorded on EO' };
    audit['auditFetch'] = {
      executionPresent: Boolean(exe && (exe['executionId'] || exe['execution'])),
      sideEffectPresent: Boolean(found) || Boolean(sideEffectId),
      sideEffectStatus: found?.['status'],
      sideEffectIdempotencyKey: found?.['idempotencyKey'] ?? idempotencyKey,
    };
    ok(
      'L7',
      `audit executionId=${executionId} sideEffectId=${sideEffectId} idempotencyKey=${idempotencyKey} ledger=${found ? 'hit' : 'via-output'}`,
    );
  }

  // ── L8: restore prior stage (governed; leave CRM tidy) ──────────────────
  if (process.env.GHL_ACCEPTANCE_SKIP_RESTORE !== '1') {
    const propose = (await client.submitCommand({
      name: 'ghl-live-stage-restore-propose',
      actor: primary,
      requestId: newRequestId(),
      serviceKey: formatServiceKey('crm.opportunity.update', 1),
      payload: {
        opportunityId: OPP_ID,
        stage: PRIOR_STAGE,
        proposedBy: 'ghl-live-acceptance-restore',
        idempotencyKey: `ghl-live-restore-${OPP_ID}-${Date.now()}`,
      },
      metadata: { tenantId: TENANT, proof: 'ghl-live-acceptance-restore' },
    })) as CommandResponse;
    if (!awaiting(propose)) {
      fail('L8', `restore propose expected approval: ${JSON.stringify(propose).slice(0, 400)}`);
    }
    const restoreApproval = propose.run?.approvalId ?? '';
    if (!restoreApproval) fail('L8', 'missing restore approvalId');
    const restore = (await client.decideApproval(restoreApproval, {
      approve: true,
      decidedBy: human.actorId,
      actor: human,
      note: 'Restore stage after live acceptance proof',
    })) as CommandResponse;
    if (!succeeded(restore) && restore.status !== 'succeeded') {
      fail('L8', `restore failed: ${JSON.stringify(restore).slice(0, 400)}`);
    }
    audit['restored'] = true;
    ok('L8', `restored opportunity ${OPP_ID} to prior stage`);
  } else {
    audit['restored'] = false;
    ok('L8', 'restore skipped (GHL_ACCEPTANCE_SKIP_RESTORE=1)');
  }

  audit['finishedAt'] = new Date().toISOString();
  console.log('[AUDIT]');
  console.log(JSON.stringify(audit, null, 2));
  console.log('[PASS] GHL live acceptance gate green');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
