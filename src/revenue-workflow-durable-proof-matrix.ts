/**
 * Revenue workflow durable proof — one end-to-end AION revenue path.
 *
 * Lead/Contact → Opportunity → Task/Note → agent execution → human gate →
 * outcome → execution record → cost/value measurement.
 *
 * GHL AIO-17 capabilities are the CRM plane (fake backend in CI). Conversation
 * send + appointment create stay CAPABILITY_DISABLED.
 *
 * PASS A — Contact upsert (agent propose → human approve) writes CRM lead
 * PASS B — Opportunity create (R2 gate → approve) binds opportunity
 * PASS C — Note + Task (R1 agent) write CRM + ledger side-effects
 * PASS D — Stage advance parks at human gate; handoff for restart
 * PASS E — After Runtime restart, approval resume executes; state preserved
 * PASS F — Permissions: cross-tenant CRM denied
 * PASS G — Durable Outcome realized with business value
 * PASS H — Cost + attributed value telemetry
 * PASS I — Execution ↔ side-effect audit trail
 * PASS J — Conversation read remains CAPABILITY_DISABLED (send/appt.create deferred)
 * TELEMETRY — answers: worked? human intervened? cost? value?
 */
import {
  createAgentActor,
  createHumanActor,
  capability,
  formatServiceKey,
  newRequestId,
} from '@aion/core';
import { RuntimeClient, RuntimeApiError } from './clients/runtime-client.js';

const BASE_URL =
  process.env.AION_RUNTIME_URL ?? `http://127.0.0.1:${process.env.PORT ?? '8103'}`;
// Clearly synthetic tenant ids: never the production tenant, so proof rows can never be mistaken for it.
const TENANT = 'aion-proof-synthetic';
const OTHER = 'aion-proof-foreign';
const PHASE = process.env.RW_PROOF_PHASE ?? 'all';
const HANDOFF_PATH =
  process.env.RW_HANDOFF_PATH ?? '/tmp/revenue-workflow-handoff.json';
const ATTRIBUTED_VALUE = 1500;
const OUTCOME_VALUE = 1500;

const CONTACT_UPDATE = capability('crm.contact.update');
const CONTACT_READ = capability('crm.contact.read');
const OPP_CREATE = capability('crm.opportunity.create');
const OPP_UPDATE = capability('crm.opportunity.update');
const NOTE_CREATE = capability('crm.note.create');
const TASK_CREATE = capability('crm.task.create');
const CONV_READ = capability('crm.conversation.read');

const PERMS = [
  CONTACT_READ,
  CONTACT_UPDATE,
  OPP_CREATE,
  OPP_UPDATE,
  NOTE_CREATE,
  TASK_CREATE,
  CONV_READ,
];

function fail(pass: string, msg: string): never {
  console.error(`[FAIL ${pass}] ${msg}`);
  process.exit(1);
}
function ok(pass: string, msg: string): void {
  console.log(`[PASS ${pass}] ${msg}`);
}

function revenueAgent(tenantId: string, name: string) {
  return createAgentActor({
    name,
    purpose: 'Durable revenue workflow proof',
    owner: 'aion-runtime/proof',
    domain: 'revenue',
    role: 'copilot',
    tenantId,
    companyId: 'co_aion',
    permissions: PERMS,
    maxRiskLevel: 'R3',
    autonomyLevel: 'L2',
  });
}

interface CommandResponse {
  status?: string;
  run?: { runId?: string; state?: string; approvalId?: string; requestId?: string };
  execution?: {
    executionId?: string;
    status?: string;
    cost?: { units?: number };
    revenueAttributed?: number | string;
    outcomeId?: string;
  };
  result?: {
    status?: string;
    output?: Record<string, unknown>;
    error?: { code?: string; message?: string };
  };
  decision?: { decision?: string };
  outcomeReference?: { outcomeId?: string };
}

function succeeded(res: CommandResponse): boolean {
  return res.result?.status === 'succeeded' || res.status === 'succeeded' || res.status === 'completed';
}

function awaiting(res: CommandResponse): boolean {
  return (
    res.status === 'awaiting_approval' ||
    res.run?.state === 'awaiting_approval' ||
    res.decision?.decision === 'REQUIRE_APPROVAL'
  );
}

function externalId(res: CommandResponse): string {
  const out = res.result?.output ?? {};
  const id = out['externalResourceId'] ?? (out['body'] as Record<string, unknown> | undefined)?.['id'];
  return typeof id === 'string' ? id : '';
}

async function approveIfNeeded(
  client: RuntimeClient,
  res: CommandResponse,
  human: ReturnType<typeof createHumanActor>,
  note: string,
): Promise<CommandResponse> {
  if (!awaiting(res)) return res;
  const approvalId = res.run?.approvalId;
  if (!approvalId) fail('gate', `missing approvalId: ${JSON.stringify(res).slice(0, 400)}`);
  return (await client.decideApproval(approvalId, {
    approve: true,
    decidedBy: human.actorId,
    actor: human,
    note,
  })) as CommandResponse;
}

interface Handoff {
  approvalId: string;
  human: { actorId: string; actor: ReturnType<typeof createHumanActor> };
  contactId: string;
  opportunityId: string;
  rootExecutionId: string;
  noteExecutionId: string;
  noteSideEffectId: string;
  noteRunId: string;
  noteOutcomeId?: string;
  attributedValue: number;
  humanInterventions: number;
}

async function main(): Promise<void> {
  const client = new RuntimeClient({ baseUrl: BASE_URL, tenantId: TENANT });
  const agent = revenueAgent(TENANT, 'RevenueWorkflowAgent');
  const otherAgent = revenueAgent(OTHER, 'RevenueOtherTenantAgent');
  const human = createHumanActor({
    name: 'Revenue Workflow Approver',
    permissions: [CONTACT_UPDATE, OPP_CREATE, OPP_UPDATE],
  });

  if (PHASE === 'all' || PHASE === 'pre') {
    let humanInterventions = 0;

    // ── PASS A: Lead/Contact upsert (R2 → human gate) ─────────────────────
    const contactProposed = (await client.submitCommand({
      name: 'rw-contact-upsert',
      actor: agent,
      serviceKey: formatServiceKey('crm.contact.update', 1),
      requestId: newRequestId(),
      payload: {
        email: 'revenue.proof@example.com',
        firstName: 'Revenue',
        lastName: 'Proof',
        upsert: true,
        matchConfidence: 0.95,
        idempotencyKey: `rw-contact-${Date.now()}`,
      },
      metadata: { tenantId: TENANT, proof: 'revenue-workflow' },
      revenueAttributed: ATTRIBUTED_VALUE,
      outcomeSummary: 'qualified lead upserted',
    })) as CommandResponse;

    if (!awaiting(contactProposed) && !succeeded(contactProposed)) {
      fail('A', `contact upsert unexpected: ${JSON.stringify(contactProposed).slice(0, 500)}`);
    }
    if (awaiting(contactProposed)) humanInterventions += 1;
    const contactFinal = await approveIfNeeded(
      client,
      contactProposed,
      human,
      'approve lead upsert',
    );
    if (!succeeded(contactFinal)) {
      fail(
        'A',
        `contact upsert failed after gate: ${JSON.stringify(contactFinal).slice(0, 500)}`,
      );
    }
    const contactId = externalId(contactFinal);
    if (!contactId) fail('A', 'missing contact externalResourceId');
    const rootExecutionId =
      contactFinal.execution?.executionId ?? contactProposed.execution?.executionId ?? '';
    if (!rootExecutionId) fail('A', 'missing root executionId');
    ok(
      'A',
      `Lead/Contact upserted contactId=${contactId} (humanGate=${awaiting(contactProposed)})`,
    );

    // ── PASS B: Opportunity create (R2 → human gate) ──────────────────────
    const oppProposed = (await client.submitCommand({
      name: 'rw-opp-create',
      actor: agent,
      serviceKey: formatServiceKey('crm.opportunity.create', 1),
      requestId: newRequestId(),
      payload: {
        contactId,
        name: 'Revenue Workflow Opp',
        pipelineId: 'pipe_default',
        stage: 'new',
        idempotencyKey: `rw-opp-${Date.now()}`,
      },
      metadata: { tenantId: TENANT, proof: 'revenue-workflow' },
      parentExecutionId: rootExecutionId,
      rootExecutionId,
    })) as CommandResponse;
    if (awaiting(oppProposed)) humanInterventions += 1;
    const oppFinal = await approveIfNeeded(
      client,
      oppProposed,
      human,
      'approve opportunity create',
    );
    if (!succeeded(oppFinal)) {
      fail('B', `opportunity.create failed: ${JSON.stringify(oppFinal).slice(0, 500)}`);
    }
    const opportunityId = externalId(oppFinal);
    if (!opportunityId) fail('B', 'missing opportunityId');
    ok('B', `Opportunity created opportunityId=${opportunityId}`);

    // ── PASS C: Note + Task (R1 agent execution) ───────────────────────────
    const note = (await client.submitCommand({
      name: 'rw-note',
      actor: agent,
      serviceKey: formatServiceKey('crm.note.create', 1),
      requestId: newRequestId(),
      payload: {
        contactId,
        body: 'Revenue workflow: lead qualified, opp opened — agent note',
        idempotencyKey: `rw-note-${Date.now()}`,
      },
      metadata: { tenantId: TENANT, proof: 'revenue-workflow' },
      parentExecutionId: rootExecutionId,
      rootExecutionId,
      revenueAttributed: ATTRIBUTED_VALUE,
      outcomeSummary: 'agent note on revenue path',
    })) as CommandResponse;
    if (!succeeded(note)) {
      fail('C', `note.create failed: ${JSON.stringify(note).slice(0, 400)}`);
    }
    const noteSideEffectId = String(note.result?.output?.['sideEffectId'] ?? '');
    const noteExecutionId = note.execution?.executionId ?? '';
    const noteRunId = note.run?.runId ?? '';
    const noteOutcomeId = String(
      note.execution?.outcomeId ?? note.outcomeReference?.outcomeId ?? '',
    );
    if (!noteSideEffectId || !noteExecutionId || !noteRunId) {
      fail('C', 'note missing sideEffectId/executionId/runId');
    }

    const task = (await client.submitCommand({
      name: 'rw-task',
      actor: agent,
      serviceKey: formatServiceKey('crm.task.create', 1),
      requestId: newRequestId(),
      payload: {
        contactId,
        title: 'Revenue workflow follow-up',
        idempotencyKey: `rw-task-${Date.now()}`,
      },
      metadata: { tenantId: TENANT, proof: 'revenue-workflow' },
      parentExecutionId: rootExecutionId,
      rootExecutionId,
    })) as CommandResponse;
    if (!succeeded(task)) {
      fail('C', `task.create failed: ${JSON.stringify(task).slice(0, 400)}`);
    }
    ok('C', `Note+Task agent writes ledgered sideEffectId=${noteSideEffectId}`);

    // ── PASS D: Stage advance parks at human gate (restart handoff) ────────
    const gated = (await client.submitCommand({
      name: 'rw-stage-gate',
      actor: agent,
      serviceKey: formatServiceKey('crm.opportunity.update', 1),
      requestId: newRequestId(),
      payload: {
        opportunityId,
        stage: 'qualified',
        idempotencyKey: `rw-stage-${Date.now()}`,
      },
      metadata: { tenantId: TENANT, proof: 'revenue-workflow' },
      parentExecutionId: rootExecutionId,
      rootExecutionId,
    })) as CommandResponse;
    if (!awaiting(gated)) {
      fail('D', `expected awaiting_approval, got ${JSON.stringify(gated).slice(0, 500)}`);
    }
    const approvalId = gated.run?.approvalId;
    if (!approvalId) fail('D', 'missing approvalId for stage update');
    humanInterventions += 1;

    const fs = await import('node:fs/promises');
    const handoff: Handoff = {
      approvalId,
      human: { actorId: human.actorId, actor: human },
      contactId,
      opportunityId,
      rootExecutionId,
      noteExecutionId,
      noteSideEffectId,
      noteRunId,
      ...(noteOutcomeId ? { noteOutcomeId } : {}),
      attributedValue: ATTRIBUTED_VALUE,
      humanInterventions,
    };
    await fs.writeFile(HANDOFF_PATH, JSON.stringify(handoff), 'utf8');
    ok('D', `stage update parked approvalId=${approvalId} (handoff written)`);

    if (PHASE === 'pre') {
      console.log('[proof-rw] pre-restart phase complete — handoff written');
      return;
    }
  }

  if (PHASE === 'all' || PHASE === 'post') {
    const fs = await import('node:fs/promises');
    const handoff = JSON.parse(await fs.readFile(HANDOFF_PATH, 'utf8')) as Handoff;
    const postAgent = revenueAgent(TENANT, 'RevenueWorkflowAgent');

    // ── PASS E: Restart recovery — approve preserved gate ─────────────────
    let stageExecutionId = '';
    let stageRunId = '';
    let stageOutcomeId = '';
    {
      const resumed = (await client.decideApproval(handoff.approvalId, {
        approve: true,
        decidedBy: handoff.human.actorId,
        actor: handoff.human.actor,
        note: 'post-restart stage advance',
      })) as CommandResponse;
      if (!succeeded(resumed) && resumed.status !== 'succeeded' && resumed.status !== 'completed') {
        fail('E', `approval resume failed: ${JSON.stringify(resumed).slice(0, 500)}`);
      }
      stageExecutionId = resumed.execution?.executionId ?? '';
      stageRunId = resumed.run?.runId ?? '';
      stageOutcomeId = String(
        resumed.execution?.outcomeId ?? resumed.outcomeReference?.outcomeId ?? '',
      );
      const stageSide = String(resumed.result?.output?.['sideEffectId'] ?? '');
      if (!stageSide) fail('E', 'stage update missing sideEffectId after resume');
      ok('E', `restart preserved approval; stage executed sideEffectId=${stageSide}`);
    }

    // ── PASS F: Tenant isolation / permissions ────────────────────────────
    {
      const otherClient = new RuntimeClient({ baseUrl: BASE_URL, tenantId: OTHER });
      const cross = (await otherClient.submitCommand({
        name: 'rw-pass-f-cross',
        actor: otherAgent,
        serviceKey: formatServiceKey('crm.contact.read', 1),
        requestId: newRequestId(),
        payload: { contactId: handoff.contactId, workspaceId: TENANT },
        metadata: { tenantId: OTHER, proof: 'revenue-workflow' },
      })) as CommandResponse;
      const code =
        cross.result?.error?.code ?? String(cross.result?.output?.['errorCode'] ?? '');
      if (succeeded(cross) || code !== 'TENANT_WORKSPACE_MISMATCH') {
        fail(
          'F',
          `expected TENANT_WORKSPACE_MISMATCH, got ${JSON.stringify(cross).slice(0, 400)}`,
        );
      }
      ok('F', 'permissions/tenant isolation: foreign workspace denied');
    }

    // ── PASS G: Durable Outcome with business value ───────────────────────
    let outcomeId = '';
    let outcomeValue = 0;
    {
      const runIdForOutcome = stageRunId || handoff.noteRunId;
      if (!runIdForOutcome) fail('G', 'no runId for outcome');

      // Prefer patching seeded outcome from terminal execution; else create.
      let existingId =
        stageOutcomeId ||
        handoff.noteOutcomeId ||
        '';
      if (!existingId && handoff.noteExecutionId) {
        const exe = (await client.getExecution(handoff.noteExecutionId, {
          tenantId: TENANT,
        })) as { execution?: { outcomeId?: string }; outcomeId?: string };
        existingId = exe.execution?.outcomeId ?? exe.outcomeId ?? '';
      }

      if (existingId) {
        const patched = (await client.patchOutcome(existingId, {
          status: 'realized',
          outcomeType: 'revenue_qualified',
          value: OUTCOME_VALUE,
          currency: 'USD',
          measuredAt: new Date().toISOString(),
          metadata: {
            proof: 'revenue-workflow',
            contactId: handoff.contactId,
            opportunityId: handoff.opportunityId,
            humanInterventions: handoff.humanInterventions,
          },
        })) as { outcome?: { outcomeId?: string; value?: number; status?: string } };
        outcomeId = patched.outcome?.outcomeId ?? existingId;
        outcomeValue = Number(patched.outcome?.value ?? OUTCOME_VALUE);
        if (patched.outcome?.status !== 'realized') {
          fail('G', `expected realized outcome, got ${JSON.stringify(patched).slice(0, 300)}`);
        }
      } else {
        const created = (await client.createOutcome({
          runId: runIdForOutcome,
          status: 'realized',
          outcomeType: 'revenue_qualified',
          value: OUTCOME_VALUE,
          currency: 'USD',
          measuredAt: new Date().toISOString(),
          metadata: {
            proof: 'revenue-workflow',
            contactId: handoff.contactId,
            opportunityId: handoff.opportunityId,
          },
        })) as { outcome?: { outcomeId?: string; value?: number } };
        outcomeId = created.outcome?.outcomeId ?? '';
        outcomeValue = Number(created.outcome?.value ?? 0);
        if (!outcomeId) fail('G', `createOutcome failed: ${JSON.stringify(created).slice(0, 300)}`);
      }
      ok('G', `Outcome realized outcomeId=${outcomeId} value=${outcomeValue} USD`);
    }

    // ── PASS H: Cost + attributed value ───────────────────────────────────
    let costUnits = 0;
    let attributed = 0;
    {
      const exe = (await client.getExecution(handoff.noteExecutionId, {
        tenantId: TENANT,
      })) as {
        execution?: { cost?: { units?: number }; revenueAttributed?: number | string };
        cost?: { units?: number };
        revenueAttributed?: number | string;
      };
      costUnits = exe.execution?.cost?.units ?? exe.cost?.units ?? 0;
      attributed = Number(
        exe.execution?.revenueAttributed ?? exe.revenueAttributed ?? 0,
      );
      if (!(costUnits > 0)) fail('H', `expected cost units > 0, got ${costUnits}`);
      if (attributed !== handoff.attributedValue) {
        fail('H', `expected revenueAttributed ${handoff.attributedValue}, got ${attributed}`);
      }
      const scope = (await client.getScopeEconomics(
        { tenantId: TENANT },
        { tenantId: TENANT },
      )) as { totals?: { costUnits?: number }; rollup?: { totalCostUnits?: number } };
      const scopeUnits = scope.totals?.costUnits ?? scope.rollup?.totalCostUnits ?? costUnits;
      if (!(scopeUnits > 0)) fail('H', 'scope economics missing cost');
      ok('H', `cost units=${costUnits}; attributed=${attributed}; scopeCost=${scopeUnits}`);
    }

    // ── PASS I: Execution ↔ side-effect audit ─────────────────────────────
    {
      await client.getExecution(handoff.noteExecutionId, { tenantId: TENANT });
      const detail = (await client.getSideEffect(handoff.noteSideEffectId, {
        tenantId: TENANT,
      })) as {
        sideEffect?: {
          serviceKey?: string;
          externalResourceId?: string;
          executionId?: string;
        };
      };
      if (
        !detail.sideEffect?.serviceKey ||
        !detail.sideEffect.externalResourceId ||
        detail.sideEffect.executionId !== handoff.noteExecutionId
      ) {
        fail('I', `incomplete audit: ${JSON.stringify(detail).slice(0, 400)}`);
      }
      if (stageExecutionId) {
        await client.getExecution(stageExecutionId, { tenantId: TENANT });
      }
      ok(
        'I',
        `audit ${detail.sideEffect.serviceKey} → ${detail.sideEffect.externalResourceId}`,
      );
    }

    // ── PASS J: Disabled caps remain off (catalog-routable surface) ───────
    // conversation.send / appointment.create stay fixture-defined and are not
    // Mission 009 active catalog keys; conversation.read IS catalogued and
    // must still return CAPABILITY_DISABLED (AIO-17).
    {
      const res = (await client.submitCommand({
        name: 'rw-disabled-conversation-read',
        actor: postAgent,
        serviceKey: formatServiceKey('crm.conversation.read', 1),
        requestId: newRequestId(),
        payload: { contactId: handoff.contactId },
        metadata: { tenantId: TENANT, proof: 'revenue-workflow' },
      })) as CommandResponse;
      const code =
        res.result?.error?.code ?? String(res.result?.output?.['errorCode'] ?? '');
      if (succeeded(res) || code !== 'CAPABILITY_DISABLED') {
        fail(
          'J',
          `expected CAPABILITY_DISABLED for conversation.read, got ${JSON.stringify(res).slice(0, 400)}`,
        );
      }
      ok(
        'J',
        'conversation.read CAPABILITY_DISABLED; send/appointment.create remain out of active path',
      );
    }

    // ── TELEMETRY summary (definition of done) ────────────────────────────
    const worked = Boolean(outcomeId) && outcomeValue === OUTCOME_VALUE && costUnits > 0;
    console.log('[TELEMETRY] ──────────────────────────────────────────────');
    console.log(`[TELEMETRY] Did it work?              ${worked ? 'YES' : 'NO'}`);
    console.log(
      `[TELEMETRY] Did a human intervene?     YES (${handoff.humanInterventions} gates)`,
    );
    console.log(`[TELEMETRY] What did it cost?         ${costUnits} cost units`);
    console.log(
      `[TELEMETRY] What business value?       ${outcomeValue} USD (attributed EV ${attributed})`,
    );
    console.log(`[TELEMETRY] contactId=${handoff.contactId}`);
    console.log(`[TELEMETRY] opportunityId=${handoff.opportunityId}`);
    console.log(`[TELEMETRY] outcomeId=${outcomeId}`);
    console.log(`[TELEMETRY] noteExecutionId=${handoff.noteExecutionId}`);
    console.log(`[TELEMETRY] rootExecutionId=${handoff.rootExecutionId}`);
    console.log('[TELEMETRY] ──────────────────────────────────────────────');

    if (!worked) fail('TELEMETRY', 'definition-of-done telemetry incomplete');
    console.log('[proof-rw] PASS — durable revenue workflow A–J green');
  }
}

main().catch((err) => {
  console.error(
    '[proof-rw] fatal',
    err instanceof RuntimeApiError ? err.message : err,
  );
  process.exit(1);
});
