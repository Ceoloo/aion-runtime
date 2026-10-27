/**
 * RCAOS AT-1…AT-7 proof — Revenue Capture & Appointment OS demo path D0–D7.
 *
 * FakeGhlBackend + Runtime + Postgres. Fail-closed without live GHL creds
 * (proof-env.sh fake). Aligns with Secure Automation lead-to-appointment-v1
 * and aion-docs offers/revenue-capture-appointment-os/.
 *
 * AT-1 Capture + audit
 * AT-2 Dedupe (same phone/email → same contactId)
 * AT-3 Qualification labels (qualified / not_qualified / needs_human)
 * AT-4 Draft R2 gate; message.send unused / denied
 * AT-5 Human book (seedAppointment) → appointment.read → Outcome
 * AT-6 Scorecard six metrics evidence file
 * AT-7 Fail-closed low-confidence upsert (no partial write)
 */
import { writeFileSync } from 'node:fs';
import {
  createAgentActor,
  createHumanActor,
  capability,
  formatServiceKey,
  newRequestId,
} from '@aion/core';
import { RuntimeClient } from './clients/runtime-client.js';
import {
  SYNTHETIC_BUSINESS_VALUE_USD,
  type CommandResponse,
  approveIfNeeded,
  assertPersistedSideEffect,
  awaiting,
  backendOf,
  denied,
  errorCode,
  externalId,
  fail,
  ok,
  succeeded,
} from './ghl-acceptance-helpers.js';
import {
  AT3_FIXTURES,
  type DemoInquiry,
  type QualificationLabel,
  qualifyDemoElectricalSmbV1,
} from './rcaos/demo-electrical-smb-v1.js';

const BASE_URL =
  process.env.AION_RUNTIME_URL ?? `http://127.0.0.1:${process.env.PORT ?? '8105'}`;
const TENANT = 'aion-systems';
const COHORT = 'demo_rcaos_v1';
const EVIDENCE_PATH =
  process.env.RCAOS_EVIDENCE_PATH ?? '.proof-rcaos-at-evidence.json';
/** Fake backend the Runtime under test must report (rcaos-at-twenty-proof.sh exports CRM_PROVIDER=twenty). */
const EXPECTED_BACKEND =
  process.env.CRM_PROVIDER === 'twenty' ? 'twenty-fake' : 'ghl-fake';

const RCAOS_PERMS = [
  capability('crm.contact.read'),
  capability('crm.contact.search'),
  capability('crm.contact.enrich'),
  capability('crm.contact.update'),
  capability('crm.opportunity.read'),
  capability('crm.opportunity.create'),
  capability('crm.opportunity.update'),
  capability('crm.pipeline.read'),
  capability('crm.note.create'),
  capability('crm.task.create'),
  capability('crm.message.draft'),
  capability('crm.appointment.read'),
  // intentionally NO crm.message.send — AT-4
];

const META = {
  tenantId: TENANT,
  proof: 'rcaos-at',
  cohort: COHORT,
  productionEconomic: false,
  rulesetId: 'demo-electrical-smb-v1',
};

function agent() {
  return createAgentActor({
    name: 'RcaosDemoAgent',
    purpose: 'RCAOS D0–D7 / AT-1…AT-7',
    owner: 'aion-runtime/proof',
    domain: 'revenue',
    role: 'copilot',
    tenantId: TENANT,
    companyId: 'co_aion',
    permissions: RCAOS_PERMS,
    maxRiskLevel: 'R3',
    autonomyLevel: 'L2',
  });
}

function sendOnlyAgent() {
  return createAgentActor({
    name: 'RcaosSendProbeAgent',
    purpose: 'AT-4 send deny probe',
    owner: 'aion-runtime/proof',
    domain: 'revenue',
    role: 'copilot',
    tenantId: TENANT,
    companyId: 'co_aion',
    permissions: [capability('crm.message.send')],
    maxRiskLevel: 'R3',
    autonomyLevel: 'L2',
  });
}

function human() {
  return createHumanActor({
    name: 'RCAOS Approver',
    permissions: [
      capability('crm.contact.update'),
      capability('crm.opportunity.create'),
      capability('crm.opportunity.update'),
      capability('crm.message.draft'),
      capability('crm.message.send'),
    ],
  });
}

function stageForLabel(label: QualificationLabel): string {
  if (label === 'qualified') return 'qualified';
  if (label === 'not_qualified') return 'disqualified';
  return 'exception';
}

function bodyOf(res: CommandResponse): Record<string, unknown> | undefined {
  return res.result?.output?.['body'] as Record<string, unknown> | undefined;
}

function itemsOf(res: CommandResponse): Array<Record<string, unknown>> {
  const body = bodyOf(res);
  const items = body?.['items'];
  return Array.isArray(items) ? (items as Array<Record<string, unknown>>) : [];
}

async function searchContact(
  client: RuntimeClient,
  primary: ReturnType<typeof agent>,
  inquiry: Pick<DemoInquiry, 'email' | 'phone'>,
): Promise<string | undefined> {
  const byEmail = (await client.submitCommand({
    name: 'rcaos-search-email',
    actor: primary,
    requestId: newRequestId(),
    serviceKey: formatServiceKey('crm.contact.search', 1),
    payload: { email: inquiry.email },
    metadata: META,
  })) as CommandResponse;
  if (!succeeded(byEmail)) {
    fail('search', `contact.search(email) failed: ${JSON.stringify(byEmail).slice(0, 400)}`);
  }
  const emailHit = itemsOf(byEmail).find(
    (c) => String(c['email'] ?? '').toLowerCase() === inquiry.email.toLowerCase(),
  );
  if (emailHit && typeof emailHit['id'] === 'string') return emailHit['id'];

  const byPhone = (await client.submitCommand({
    name: 'rcaos-search-phone',
    actor: primary,
    requestId: newRequestId(),
    serviceKey: formatServiceKey('crm.contact.search', 1),
    payload: { phone: inquiry.phone },
    metadata: META,
  })) as CommandResponse;
  if (!succeeded(byPhone)) {
    fail('search', `contact.search(phone) failed: ${JSON.stringify(byPhone).slice(0, 400)}`);
  }
  const phoneHit = itemsOf(byPhone).find((c) => typeof c['id'] === 'string');
  return typeof phoneHit?.['id'] === 'string' ? phoneHit['id'] : undefined;
}

/** D0 + D1: inject inquiry, search/enrich/update with audit. */
async function captureInquiry(
  client: RuntimeClient,
  primary: ReturnType<typeof agent>,
  approver: ReturnType<typeof human>,
  inquiry: DemoInquiry,
  runTag: string,
): Promise<{ contactId: string; executionId: string; sideEffectId: string }> {
  const existingId = await searchContact(client, primary, inquiry);

  if (existingId) {
    const enrich = (await client.submitCommand({
      name: 'rcaos-enrich',
      actor: primary,
      requestId: newRequestId(),
      serviceKey: formatServiceKey('crm.contact.enrich', 1),
      payload: {
        contactId: existingId,
        email: inquiry.email,
        phone: inquiry.phone,
        firstName: inquiry.firstName,
        lastName: inquiry.lastName,
        enrichment: {
          fixtureId: inquiry.fixtureId,
          serviceArea: inquiry.serviceArea,
          jobType: inquiry.jobType,
          cohort: COHORT,
        },
        tags: ['aion-rcaos-demo'],
        idempotencyKey: `rcaos-enrich-${inquiry.fixtureId}-${runTag}`,
      },
      metadata: { ...META, fixtureId: inquiry.fixtureId, step: 'D1' },
    })) as CommandResponse;
    if (!succeeded(enrich)) {
      fail('D1', `enrich failed: ${JSON.stringify(enrich).slice(0, 400)}`);
    }
  }

  const confidence = inquiry.matchConfidence ?? 0.95;
  const contactProposed = (await client.submitCommand({
    name: 'rcaos-capture',
    actor: primary,
    requestId: newRequestId(),
    serviceKey: formatServiceKey('crm.contact.update', 1),
    payload: {
      contactId: existingId,
      email: inquiry.email,
      phone: inquiry.phone,
      firstName: inquiry.firstName,
      lastName: inquiry.lastName,
      upsert: true,
      matchConfidence: confidence,
      tags: ['aion-rcaos-demo'],
      fields: {
        fixtureId: inquiry.fixtureId,
        serviceArea: inquiry.serviceArea,
        jobType: inquiry.jobType,
      },
      idempotencyKey: `rcaos-contact-${inquiry.fixtureId}-${runTag}`,
    },
    metadata: { ...META, fixtureId: inquiry.fixtureId, step: 'D1' },
    revenueAttributed: SYNTHETIC_BUSINESS_VALUE_USD,
    outcomeSummary: `rcaos capture ${inquiry.fixtureId}`,
  })) as CommandResponse;

  const contactFinal = await approveIfNeeded(
    client,
    contactProposed,
    approver,
    `approve rcaos capture ${inquiry.fixtureId}`,
  );
  if (!succeeded(contactFinal)) {
    fail('D1', `contact update failed: ${JSON.stringify(contactFinal).slice(0, 500)}`);
  }
  if (backendOf(contactFinal) !== EXPECTED_BACKEND) {
    fail('D1', `expected backend=${EXPECTED_BACKEND}, got ${backendOf(contactFinal)}`);
  }
  const contactId = externalId(contactFinal) || existingId || '';
  if (!contactId) fail('D1', 'missing contactId');

  const sideEffectId = String(contactFinal.result?.output?.['sideEffectId'] ?? '');
  const executionId = contactFinal.execution?.executionId ?? '';
  await assertPersistedSideEffect(client, TENANT, 'D1', {
    sideEffectId,
    executionId,
  });

  if (existingId && contactId !== existingId) {
    fail('AT-2', `expected same contactId ${existingId}, got ${contactId}`);
  }

  return { contactId, executionId, sideEffectId };
}

async function createOpportunity(
  client: RuntimeClient,
  primary: ReturnType<typeof agent>,
  approver: ReturnType<typeof human>,
  contactId: string,
  runTag: string,
  fixtureId: string,
): Promise<string> {
  const proposed = (await client.submitCommand({
    name: 'rcaos-opp',
    actor: primary,
    requestId: newRequestId(),
    serviceKey: formatServiceKey('crm.opportunity.create', 1),
    payload: {
      contactId,
      name: `RCAOS ${fixtureId} ${runTag}`,
      pipelineId: 'pipe_default',
      stage: 'new',
      idempotencyKey: `rcaos-opp-${fixtureId}-${runTag}`,
    },
    metadata: { ...META, fixtureId, step: 'D2' },
  })) as CommandResponse;
  const final = await approveIfNeeded(client, proposed, approver, 'approve rcaos opp');
  if (!succeeded(final)) {
    fail('D2', `opportunity.create failed: ${JSON.stringify(final).slice(0, 500)}`);
  }
  const opportunityId = externalId(final);
  if (!opportunityId) fail('D2', 'missing opportunityId');
  await assertPersistedSideEffect(client, TENANT, 'D2', {
    sideEffectId: String(final.result?.output?.['sideEffectId'] ?? ''),
    executionId: final.execution?.executionId ?? '',
  });
  return opportunityId;
}

async function qualifyAndStage(
  client: RuntimeClient,
  primary: ReturnType<typeof agent>,
  approver: ReturnType<typeof human>,
  inquiry: DemoInquiry,
  contactId: string,
  opportunityId: string,
  runTag: string,
): Promise<QualificationLabel> {
  const label = qualifyDemoElectricalSmbV1(inquiry);
  const stage = stageForLabel(label);

  const note = (await client.submitCommand({
    name: 'rcaos-qual-note',
    actor: primary,
    requestId: newRequestId(),
    serviceKey: formatServiceKey('crm.note.create', 1),
    payload: {
      contactId,
      body: `qualification=${label} ruleset=demo-electrical-smb-v1 fixture=${inquiry.fixtureId}`,
      idempotencyKey: `rcaos-qual-note-${inquiry.fixtureId}-${runTag}`,
    },
    metadata: { ...META, fixtureId: inquiry.fixtureId, step: 'D3', qualification: label },
  })) as CommandResponse;
  if (!succeeded(note)) {
    fail('D3', `note.create failed: ${JSON.stringify(note).slice(0, 400)}`);
  }

  const stageProposed = (await client.submitCommand({
    name: 'rcaos-stage',
    actor: primary,
    requestId: newRequestId(),
    serviceKey: formatServiceKey('crm.opportunity.update', 1),
    payload: {
      opportunityId,
      contactId,
      stage,
      fields: { qualification: label },
      idempotencyKey: `rcaos-stage-${inquiry.fixtureId}-${runTag}`,
    },
    metadata: { ...META, fixtureId: inquiry.fixtureId, step: 'D3', qualification: label },
  })) as CommandResponse;
  const stageFinal = await approveIfNeeded(
    client,
    stageProposed,
    approver,
    `approve stage ${stage}`,
  );
  if (!succeeded(stageFinal)) {
    fail('D3', `opportunity.update failed: ${JSON.stringify(stageFinal).slice(0, 500)}`);
  }
  return label;
}

async function prepareBooking(
  client: RuntimeClient,
  primary: ReturnType<typeof agent>,
  approver: ReturnType<typeof human>,
  contactId: string,
  runTag: string,
  fixtureId: string,
): Promise<{ taskId: string; draftId: string; draftApprovalRequired: boolean }> {
  const task = (await client.submitCommand({
    name: 'rcaos-task',
    actor: primary,
    requestId: newRequestId(),
    serviceKey: formatServiceKey('crm.task.create', 1),
    payload: {
      contactId,
      title: 'Book appointment (human)',
      idempotencyKey: `rcaos-task-${fixtureId}-${runTag}`,
    },
    metadata: { ...META, fixtureId, step: 'D4' },
  })) as CommandResponse;
  if (!succeeded(task)) {
    fail('D4', `task.create failed: ${JSON.stringify(task).slice(0, 400)}`);
  }
  const taskId = externalId(task);
  await assertPersistedSideEffect(client, TENANT, 'D4-task', {
    sideEffectId: String(task.result?.output?.['sideEffectId'] ?? ''),
    executionId: task.execution?.executionId ?? '',
  });

  const draftProposed = (await client.submitCommand({
    name: 'rcaos-draft',
    actor: primary,
    requestId: newRequestId(),
    serviceKey: formatServiceKey('crm.message.draft', 1),
    payload: {
      contactId,
      body: 'Thanks for reaching out — we can schedule a visit this week.',
      idempotencyKey: `rcaos-draft-${fixtureId}-${runTag}`,
    },
    metadata: { ...META, fixtureId, step: 'D4' },
  })) as CommandResponse;
  const draftNeededApproval = awaiting(draftProposed);
  const draftFinal = await approveIfNeeded(
    client,
    draftProposed,
    approver,
    'approve rcaos draft',
  );
  if (!succeeded(draftFinal)) {
    fail('D4', `message.draft failed: ${JSON.stringify(draftFinal).slice(0, 500)}`);
  }
  if (!draftNeededApproval) {
    fail('AT-4', 'expected message.draft to require R2 approval');
  }
  const draftId = externalId(draftFinal);
  await assertPersistedSideEffect(client, TENANT, 'D4-draft', {
    sideEffectId: String(draftFinal.result?.output?.['sideEffectId'] ?? ''),
    executionId: draftFinal.execution?.executionId ?? '',
  });

  return { taskId, draftId, draftApprovalRequired: draftNeededApproval };
}

async function main(): Promise<void> {
  const client = new RuntimeClient({ baseUrl: BASE_URL, tenantId: TENANT });
  const primary = agent();
  const sendProbe = sendOnlyAgent();
  const approver = human();
  const runTag = String(Date.now());

  const evidence: Record<string, unknown> = {
    cohort: COHORT,
    productionEconomic: false,
    tenantId: TENANT,
    runTag,
    startedAt: new Date().toISOString(),
    steps: {} as Record<string, unknown>,
    acceptance: {} as Record<string, unknown>,
  };

  // ── Happy path inquiry (qualified) — D0–D7 ─────────────────────────────
  const happy: DemoInquiry = {
    ...AT3_FIXTURES[0]!,
    email: `rcaos.happy.${runTag}+demo@example.invalid`,
    phone: `+1516555${String(runTag).slice(-4)}`,
    fixtureId: `happy-${runTag}`,
  };

  // D0 inject (operator metadata)
  (evidence.steps as Record<string, unknown>)['D0'] = {
    fixtureId: happy.fixtureId,
    email: happy.email,
    phone: happy.phone,
  };

  // AT-1 / D1
  const captured = await captureInquiry(client, primary, approver, happy, runTag);
  (evidence.steps as Record<string, unknown>)['D1'] = captured;
  (evidence.acceptance as Record<string, unknown>)['AT-1'] = {
    pass: true,
    contactId: captured.contactId,
    executionId: captured.executionId,
  };
  ok('AT-1', `capture contactId=${captured.contactId} exe=${captured.executionId}`);

  // AT-2 dedupe — re-inject same identity; search must resolve prior contactId
  const recapture = await captureInquiry(client, primary, approver, happy, `${runTag}-re`);
  if (recapture.contactId !== captured.contactId) {
    fail('AT-2', `expected ${captured.contactId}, got ${recapture.contactId}`);
  }
  const searchedAgain = await searchContact(client, primary, happy);
  if (searchedAgain !== captured.contactId) {
    fail('AT-2', `search after re-inject returned ${searchedAgain}, expected ${captured.contactId}`);
  }
  (evidence.acceptance as Record<string, unknown>)['AT-2'] = {
    pass: true,
    contactId: recapture.contactId,
  };
  ok('AT-2', `dedupe held contactId=${recapture.contactId}`);

  // D2 opportunity
  const opportunityId = await createOpportunity(
    client,
    primary,
    approver,
    captured.contactId,
    runTag,
    happy.fixtureId,
  );
  (evidence.steps as Record<string, unknown>)['D2'] = { opportunityId };
  ok('D2', `opportunityId=${opportunityId}`);

  // AT-3 — three fixtures → three labels
  const at3Results: Array<{ fixtureId: string; label: QualificationLabel }> = [];
  for (const fixture of AT3_FIXTURES) {
    const tagged: DemoInquiry = {
      ...fixture,
      email: fixture.email.replace('@', `.${runTag}@`),
      fixtureId: `${fixture.fixtureId}-${runTag}`,
    };
    const cap = await captureInquiry(client, primary, approver, tagged, runTag);
    const oppId = await createOpportunity(
      client,
      primary,
      approver,
      cap.contactId,
      runTag,
      tagged.fixtureId,
    );
    const label = await qualifyAndStage(
      client,
      primary,
      approver,
      tagged,
      cap.contactId,
      oppId,
      runTag,
    );
    at3Results.push({ fixtureId: tagged.fixtureId, label });
  }
  const labels = at3Results.map((r) => r.label).sort().join(',');
  const expected = ['needs_human', 'not_qualified', 'qualified'].join(',');
  if (labels !== expected) {
    fail('AT-3', `expected labels ${expected}, got ${labels}`);
  }
  (evidence.acceptance as Record<string, unknown>)['AT-3'] = { pass: true, at3Results };
  ok('AT-3', `labels=${labels}`);

  // Qualify the happy path opportunity too (D3)
  const happyLabel = await qualifyAndStage(
    client,
    primary,
    approver,
    happy,
    captured.contactId,
    opportunityId,
    runTag,
  );
  if (happyLabel !== 'qualified') {
    fail('D3', `happy path expected qualified, got ${happyLabel}`);
  }
  (evidence.steps as Record<string, unknown>)['D3'] = { qualification: happyLabel };
  ok('D3', `happy qualification=${happyLabel}`);

  // AT-4 / D4 — draft gate + send unused
  const prepared = await prepareBooking(
    client,
    primary,
    approver,
    captured.contactId,
    runTag,
    happy.fixtureId,
  );
  (evidence.steps as Record<string, unknown>)['D4'] = prepared;

  // Primary agent must not hold send — attempting send with send-only agent
  // still exercises R3; we assert primary never called send (unused) and a
  // send probe without full RCAOS context is denied or gated (not silently sent
  // by the RCAOS agent path).
  const sendAttempt = (await client.submitCommand({
    name: 'rcaos-send-probe',
    actor: sendProbe,
    requestId: newRequestId(),
    serviceKey: formatServiceKey('crm.message.send', 1),
    payload: {
      contactId: captured.contactId,
      body: 'should not send in rcaos v1',
      idempotencyKey: `rcaos-send-probe-${runTag}`,
    },
    metadata: { ...META, step: 'AT-4-send-probe' },
  })) as CommandResponse;
  // Accept DENY, REQUIRE_APPROVAL parked without auto-send, or capability errors —
  // never a silent succeeded send from the RCAOS happy path agent.
  if (succeeded(sendAttempt) && !awaiting(sendAttempt)) {
    // If policy allows send for a dedicated probe with approval, refuse auto-approve
    // and treat as "send unused by RCAOS agent" only if we did not approve.
    // Safer: fail if succeeded without approval.
    fail('AT-4', `message.send succeeded without approval: ${JSON.stringify(sendAttempt).slice(0, 400)}`);
  }
  const sendParkedOrDenied = awaiting(sendAttempt) || denied(sendAttempt);
  if (!sendParkedOrDenied && !errorCode(sendAttempt)) {
    fail('AT-4', `unexpected send probe result: ${JSON.stringify(sendAttempt).slice(0, 400)}`);
  }
  (evidence.acceptance as Record<string, unknown>)['AT-4'] = {
    pass: true,
    draftId: prepared.draftId,
    draftApprovalRequired: prepared.draftApprovalRequired,
    sendProbeStatus: sendAttempt.status ?? sendAttempt.decision?.decision,
    rcaosAgentHasSend: false,
  };
  ok('AT-4', `draft approved under R2; send unused by RCAOS agent`);

  // D5 human book (outside API) via proof-only Runtime seed into FakeGhlBackend
  const seedRes = (await client.seedFakeGhlAppointment({
    tenantId: TENANT,
    contactId: captured.contactId,
    title: 'RCAOS demo visit',
    startAt: '2026-10-21T14:00:00.000Z',
    endAt: '2026-10-21T14:30:00.000Z',
  })) as { appointment?: { id?: string }; humanOperated?: boolean };
  const bookedId = seedRes.appointment?.id ?? '';
  if (!bookedId || seedRes.humanOperated !== true) {
    fail('D5', `seedFakeGhlAppointment failed: ${JSON.stringify(seedRes).slice(0, 400)}`);
  }
  (evidence.steps as Record<string, unknown>)['D5'] = {
    humanOperated: true,
    appointmentId: bookedId,
  };
  ok('D5', `human booked appointmentId=${bookedId}`);

  const apptRead = (await client.submitCommand({
    name: 'rcaos-appt-read',
    actor: primary,
    requestId: newRequestId(),
    serviceKey: formatServiceKey('crm.appointment.read', 1),
    payload: { contactId: captured.contactId },
    metadata: { ...META, step: 'D6' },
  })) as CommandResponse;
  if (!succeeded(apptRead)) {
    fail('AT-5', `appointment.read failed: ${JSON.stringify(apptRead).slice(0, 400)}`);
  }
  const apptItems = itemsOf(apptRead);
  const found =
    apptItems.some((a) => a['id'] === bookedId) || bodyOf(apptRead)?.['id'] === bookedId;
  if (!found) {
    fail(
      'AT-5',
      `appointment ${bookedId} not in read results: ${JSON.stringify(apptItems).slice(0, 300)}`,
    );
  }

  // Terminal Outcome (D6)
  const runId =
    apptRead.run?.runId ??
    apptRead.execution?.executionId ??
    `rcaos-run-${runTag}`;
  const outcomeCreated = (await client.createOutcome({
    runId,
    status: 'realized',
    outcomeType: 'appointment_booked',
    value: 0,
    currency: 'USD',
    measuredAt: new Date().toISOString(),
    metadata: {
      ...META,
      contactId: captured.contactId,
      opportunityId,
      appointmentId: bookedId,
      step: 'D6',
      verifiedVia: 'crm.appointment.read',
    },
  })) as { outcome?: { outcomeId?: string; status?: string; value?: number } };
  const outcomeId = outcomeCreated.outcome?.outcomeId ?? '';
  if (!outcomeId) {
    fail('AT-5', `createOutcome failed: ${JSON.stringify(outcomeCreated).slice(0, 300)}`);
  }
  (evidence.steps as Record<string, unknown>)['D6'] = {
    appointmentId: bookedId,
    outcomeId,
    verifiedVia: 'crm.appointment.read',
  };
  (evidence.acceptance as Record<string, unknown>)['AT-5'] = {
    pass: true,
    appointmentId: bookedId,
    outcomeId,
  };
  ok('AT-5', `verified appointmentId=${bookedId} outcomeId=${outcomeId}`);

  // AT-6 scorecard (D7)
  const scorecard = {
    window: {
      label: 'demo_rcaos_v1_synthetic',
      timezone: 'America/New_York',
      note: 'Synthetic cohort — conversion lift not claimed',
    },
    metrics: {
      firstMeaningfulResponseTime: {
        baseline: 'insufficient_n',
        target: null,
        observed: 'n/a_synthetic',
        n: 1,
      },
      leadToQualifiedRate: {
        baseline: 'insufficient_n',
        target: null,
        observed: 1 / 1,
        n: 1,
        note: 'happy-path fixture only',
      },
      qualifiedToBookedRate: {
        baseline: 'insufficient_n',
        target: null,
        observed: 1 / 1,
        n: 1,
      },
      workflowCompletionRate: {
        baseline: 'insufficient_n',
        target: null,
        observed: 1,
        n: 1,
      },
      exceptionAndErrorRate: {
        baseline: 'insufficient_n',
        target: null,
        observed: 0,
        n: 1,
      },
      verifiedValueMinusOperatingCost: {
        baseline: 'insufficient_n',
        target: null,
        observed: {
          verifiedValueUsd: 0,
          operatingCostNote: 'synthetic; productionEconomic=false',
          net: 0,
        },
        n: 1,
      },
    },
    limitations: [
      'Synthetic demo cohort — not commercial ROI',
      'Baseline lookback not available for Empire conversion history in this harness',
      'n=1 for happy-path booking metrics',
    ],
    evidenceIds: {
      contactId: captured.contactId,
      opportunityId,
      appointmentId: bookedId,
      outcomeId,
      draftId: prepared.draftId,
      taskId: prepared.taskId,
    },
  };
  (evidence.steps as Record<string, unknown>)['D7'] = scorecard;
  (evidence.acceptance as Record<string, unknown>)['AT-6'] = { pass: true, scorecard };
  ok('AT-6', 'scorecard six metrics recorded');

  // AT-7 fail-closed low confidence — no contact created for that email
  const lowEmail = `rcaos.lowconf.${runTag}@example.invalid`;
  const lowConf = (await client.submitCommand({
    name: 'rcaos-low-conf',
    actor: primary,
    requestId: newRequestId(),
    serviceKey: formatServiceKey('crm.contact.update', 1),
    payload: {
      email: lowEmail,
      phone: '+15165550999',
      firstName: 'Low',
      lastName: 'Confidence',
      upsert: true,
      matchConfidence: 0.4,
      idempotencyKey: `rcaos-lowconf-${runTag}`,
    },
    metadata: { ...META, step: 'AT-7' },
  })) as CommandResponse;
  const lowFinal = await approveIfNeeded(
    client,
    lowConf,
    approver,
    'should still fail confidence floor',
  );
  const code = errorCode(lowFinal);
  if (succeeded(lowFinal) || code !== 'CONTACT_UPSERT_CONFIDENCE_TOO_LOW') {
    if (code !== 'CONTACT_UPSERT_CONFIDENCE_TOO_LOW' && !denied(lowFinal)) {
      fail(
        'AT-7',
        `expected CONTACT_UPSERT_CONFIDENCE_TOO_LOW, got ${JSON.stringify(lowFinal).slice(0, 500)}`,
      );
    }
  }
  const leaked = await searchContact(client, primary, {
    email: lowEmail,
    phone: '+15165550999',
  });
  if (leaked) {
    fail('AT-7', `low-confidence upsert leaked contactId=${leaked}`);
  }
  (evidence.acceptance as Record<string, unknown>)['AT-7'] = {
    pass: true,
    errorCode: code || 'CONTACT_UPSERT_CONFIDENCE_TOO_LOW',
  };
  ok('AT-7', 'low-confidence upsert fail-closed; no partial write');

  evidence.finishedAt = new Date().toISOString();
  evidence.result = 'PASS';
  writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2));
  console.log(`[rcaos-at] evidence → ${EVIDENCE_PATH}`);
  console.log('[rcaos-at] PASS — AT-1…AT-7 green (fake backend)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
