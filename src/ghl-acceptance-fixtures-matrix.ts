/**
 * GHL acceptance fixtures matrix (deterministic, FakeGhlBackend).
 *
 * Covers the acceptance-script fixture table with failure injection.
 * Live location happy path / readback lives in ghl-live-acceptance.ts.
 *
 * PASS A — Synthetic happy path: contact → opp → note → task + stage
 * PASS B — Invalid input / low confidence fail before provider write
 * PASS C — Tenant/location mismatch before provider access
 * PASS D — Permission deny (zero writes); pending R2 stays parked
 * PASS E — Completed replay (same key, no second write) + post-restart
 * PASS F — Concurrent duplicate: one ledger row + one provider object
 * PASS G — Rate limit / auth failure: normalized errors, no false success
 * PASS H — Ambiguous write: refuse automatic replay
 * PASS I — Deferred caps: conversation read/send + appointment.create
 */
import {
  createAgentActor,
  createHumanActor,
  capability,
  formatServiceKey,
  newRequestId,
} from '@aion/core';
import { RuntimeClient, RuntimeApiError } from './clients/runtime-client.js';
import {
  SYNTHETIC_BUSINESS_VALUE_USD,
  type CommandResponse,
  approveIfNeeded,
  assertPersistedSideEffect,
  awaiting,
  backendOf,
  countSideEffectsByIdempotencyKey,
  denied,
  errorCode,
  externalId,
  fail,
  ok,
  succeeded,
} from './ghl-acceptance-helpers.js';

const BASE_URL =
  process.env.AION_RUNTIME_URL ?? `http://127.0.0.1:${process.env.PORT ?? '8104'}`;
const TENANT = 'aion-systems';
const OTHER = 'aion-media';
const PHASE = process.env.GHL_ACCEPT_PHASE ?? 'all';
const HANDOFF_PATH =
  process.env.GHL_ACCEPT_HANDOFF_PATH ?? '/tmp/ghl-acceptance-fixtures-handoff.json';

const PERMS = [
  capability('crm.contact.read'),
  capability('crm.contact.update'),
  capability('crm.opportunity.create'),
  capability('crm.opportunity.update'),
  capability('crm.opportunity.read'),
  capability('crm.note.create'),
  capability('crm.task.create'),
  capability('crm.conversation.read'),
];

function agent(tenantId: string, name: string, perms = PERMS) {
  return createAgentActor({
    name,
    purpose: 'GHL acceptance fixtures',
    owner: 'aion-runtime/proof',
    domain: 'revenue',
    role: 'copilot',
    tenantId,
    companyId: 'co_aion',
    permissions: perms,
    maxRiskLevel: 'R3',
    autonomyLevel: 'L2',
  });
}

interface Handoff {
  approvalId: string;
  human: { actorId: string; actor: ReturnType<typeof createHumanActor> };
  contactId: string;
  opportunityId: string;
  noteSideEffectId: string;
  noteExecutionId: string;
  noteIdempotencyKey: string;
  noteExternalResourceId: string;
  replayKey: string;
  replaySideEffectId: string;
  replayExternalResourceId: string;
  stageKey: string;
  attributedValue: number;
  happyPathR2Gates: number;
}

async function main(): Promise<void> {
  const client = new RuntimeClient({ baseUrl: BASE_URL, tenantId: TENANT });
  const primary = agent(TENANT, 'GhlAcceptFixturesAgent');
  const other = agent(OTHER, 'GhlAcceptOtherTenant');
  const deniedAgent = agent(TENANT, 'GhlAcceptDeniedAgent', [
    capability('crm.contact.read'),
  ]);
  const human = createHumanActor({
    name: 'GHL Accept Approver',
    permissions: [
      capability('crm.contact.update'),
      capability('crm.opportunity.create'),
      capability('crm.opportunity.update'),
    ],
  });

  if (PHASE === 'all' || PHASE === 'pre') {
    let happyPathR2Gates = 0;
    const runTag = Date.now();

    // ── PASS A: Synthetic happy path ──────────────────────────────────────
    let contactId = '';
    let opportunityId = '';
    let noteSideEffectId = '';
    let noteExecutionId = '';
    let noteIdempotencyKey = '';
    let noteExternalResourceId = '';
    {
      const contactProposed = (await client.submitCommand({
        name: 'ghl-af-contact',
        actor: primary,
        requestId: newRequestId(),
        serviceKey: formatServiceKey('crm.contact.update', 1),
        payload: {
          email: `accept.fixtures.${runTag}@example.invalid`,
          firstName: 'Accept',
          lastName: 'Fixtures',
          upsert: true,
          matchConfidence: 0.95,
          idempotencyKey: `af-contact-${runTag}`,
        },
        metadata: { tenantId: TENANT, proof: 'ghl-acceptance-fixtures' },
        revenueAttributed: SYNTHETIC_BUSINESS_VALUE_USD,
        outcomeSummary: 'synthetic acceptance contact',
      })) as CommandResponse;
      if (awaiting(contactProposed)) happyPathR2Gates += 1;
      const contactFinal = await approveIfNeeded(
        client,
        contactProposed,
        human,
        'approve synthetic contact',
      );
      if (!succeeded(contactFinal)) {
        fail('A', `contact upsert failed: ${JSON.stringify(contactFinal).slice(0, 500)}`);
      }
      if (backendOf(contactFinal) !== 'ghl-fake') {
        fail('A', `expected backend=ghl-fake, got ${backendOf(contactFinal)}`);
      }
      contactId = externalId(contactFinal);
      if (!contactId) fail('A', 'missing contactId');
      await assertPersistedSideEffect(client, TENANT, 'A-contact', {
        sideEffectId: String(contactFinal.result?.output?.['sideEffectId'] ?? ''),
        executionId: contactFinal.execution?.executionId ?? '',
      });

      const oppProposed = (await client.submitCommand({
        name: 'ghl-af-opp',
        actor: primary,
        requestId: newRequestId(),
        serviceKey: formatServiceKey('crm.opportunity.create', 1),
        payload: {
          contactId,
          name: `Accept Fixtures Opp ${runTag}`,
          pipelineId: 'pipe_default',
          stage: 'new',
          idempotencyKey: `af-opp-${runTag}`,
        },
        metadata: { tenantId: TENANT, proof: 'ghl-acceptance-fixtures' },
      })) as CommandResponse;
      if (awaiting(oppProposed)) happyPathR2Gates += 1;
      const oppFinal = await approveIfNeeded(
        client,
        oppProposed,
        human,
        'approve synthetic opportunity',
      );
      if (!succeeded(oppFinal)) {
        fail('A', `opportunity.create failed: ${JSON.stringify(oppFinal).slice(0, 500)}`);
      }
      opportunityId = externalId(oppFinal);
      if (!opportunityId) fail('A', 'missing opportunityId');
      await assertPersistedSideEffect(client, TENANT, 'A-opp', {
        sideEffectId: String(oppFinal.result?.output?.['sideEffectId'] ?? ''),
        executionId: oppFinal.execution?.executionId ?? '',
      });

      noteIdempotencyKey = `af-note-${runTag}`;
      const note = (await client.submitCommand({
        name: 'ghl-af-note',
        actor: primary,
        requestId: newRequestId(),
        serviceKey: formatServiceKey('crm.note.create', 1),
        payload: {
          contactId,
          body: 'acceptance fixtures synthetic note',
          idempotencyKey: noteIdempotencyKey,
        },
        metadata: { tenantId: TENANT, proof: 'ghl-acceptance-fixtures' },
        revenueAttributed: SYNTHETIC_BUSINESS_VALUE_USD,
      })) as CommandResponse;
      if (!succeeded(note)) {
        fail('A', `note.create failed: ${JSON.stringify(note).slice(0, 400)}`);
      }
      noteSideEffectId = String(note.result?.output?.['sideEffectId'] ?? '');
      noteExecutionId = note.execution?.executionId ?? '';
      noteExternalResourceId = externalId(note);
      const noteLedger = await assertPersistedSideEffect(client, TENANT, 'A-note', {
        sideEffectId: noteSideEffectId,
        executionId: noteExecutionId,
      });
      noteIdempotencyKey = noteLedger.idempotencyKey;

      const task = (await client.submitCommand({
        name: 'ghl-af-task',
        actor: primary,
        requestId: newRequestId(),
        serviceKey: formatServiceKey('crm.task.create', 1),
        payload: {
          contactId,
          title: 'acceptance fixtures follow-up',
          idempotencyKey: `af-task-${runTag}`,
        },
        metadata: { tenantId: TENANT, proof: 'ghl-acceptance-fixtures' },
      })) as CommandResponse;
      if (!succeeded(task)) {
        fail('A', `task.create failed: ${JSON.stringify(task).slice(0, 400)}`);
      }
      await assertPersistedSideEffect(client, TENANT, 'A-task', {
        sideEffectId: String(task.result?.output?.['sideEffectId'] ?? ''),
        executionId: task.execution?.executionId ?? '',
      });

      ok(
        'A',
        `synthetic contact=${contactId} opp=${opportunityId} note=${noteExternalResourceId} (backend=ghl-fake)`,
      );
    }

    // ── PASS B: Invalid input / confidence ────────────────────────────────
    {
      const missingBody = (await client.submitCommand({
        name: 'ghl-af-invalid-note',
        actor: primary,
        requestId: newRequestId(),
        serviceKey: formatServiceKey('crm.note.create', 1),
        payload: { contactId, idempotencyKey: `af-invalid-note-${runTag}` },
        metadata: { tenantId: TENANT, proof: 'ghl-acceptance-fixtures' },
      })) as CommandResponse;
      if (succeeded(missingBody) || errorCode(missingBody) !== 'PAYLOAD_INVALID') {
        fail(
          'B',
          `expected PAYLOAD_INVALID for note without body, got ${JSON.stringify(missingBody).slice(0, 400)}`,
        );
      }

      const lowConfProposed = (await client.submitCommand({
        name: 'ghl-af-low-conf',
        actor: primary,
        requestId: newRequestId(),
        serviceKey: formatServiceKey('crm.contact.update', 1),
        payload: {
          email: `low.confidence.${runTag}@example.invalid`,
          upsert: true,
          matchConfidence: 0.4,
          idempotencyKey: `af-low-conf-${runTag}`,
        },
        metadata: { tenantId: TENANT, proof: 'ghl-acceptance-fixtures' },
      })) as CommandResponse;
      let lowConf = lowConfProposed;
      if (awaiting(lowConfProposed)) {
        // Negative-path approval — not counted toward happy-path R2 gates.
        lowConf = await approveIfNeeded(
          client,
          lowConfProposed,
          human,
          'expect confidence deny',
        );
      }
      if (
        succeeded(lowConf) ||
        errorCode(lowConf) !== 'CONTACT_UPSERT_CONFIDENCE_TOO_LOW'
      ) {
        fail(
          'B',
          `expected CONTACT_UPSERT_CONFIDENCE_TOO_LOW, got ${JSON.stringify(lowConf).slice(0, 400)}`,
        );
      }
      ok('B', 'invalid input + low confidence fail before provider write');
    }

    // ── PASS C: Tenant mismatch ───────────────────────────────────────────
    {
      const cross = (await client.submitCommand({
        name: 'ghl-af-tenant',
        actor: other,
        requestId: newRequestId(),
        serviceKey: formatServiceKey('crm.contact.read', 1),
        payload: { contactId, workspaceId: TENANT },
        metadata: { tenantId: OTHER, proof: 'ghl-acceptance-fixtures' },
      })) as CommandResponse;
      if (succeeded(cross) || errorCode(cross) !== 'TENANT_WORKSPACE_MISMATCH') {
        fail(
          'C',
          `expected TENANT_WORKSPACE_MISMATCH, got ${JSON.stringify(cross).slice(0, 400)}`,
        );
      }
      ok('C', 'cross-tenant workspace denied before provider access');
    }

    // ── PASS D: Permission deny + parked R2 ───────────────────────────────
    {
      const beforeEffects = (await client.listSideEffects({ tenantId: TENANT })) as {
        sideEffects?: unknown[];
      };
      const beforeCount = beforeEffects.sideEffects?.length ?? 0;

      try {
        const deniedRes = (await client.submitCommand({
          name: 'ghl-af-denied',
          actor: deniedAgent,
          requestId: newRequestId(),
          serviceKey: formatServiceKey('crm.note.create', 1),
          payload: {
            contactId,
            body: 'should be denied',
            idempotencyKey: `af-denied-${runTag}`,
          },
          metadata: { tenantId: TENANT, proof: 'ghl-acceptance-fixtures' },
        })) as CommandResponse;
        if (!denied(deniedRes) && succeeded(deniedRes)) {
          fail('D', `expected denied for under-permissioned agent`);
        }
      } catch (err) {
        if (!(err instanceof RuntimeApiError) || err.status !== 403) {
          throw err;
        }
      }

      const afterEffects = (await client.listSideEffects({ tenantId: TENANT })) as {
        sideEffects?: unknown[];
      };
      const afterCount = afterEffects.sideEffects?.length ?? 0;
      if (afterCount !== beforeCount) {
        fail('D', `denied command must produce zero writes (ledger ${beforeCount}→${afterCount})`);
      }

      const parked = (await client.submitCommand({
        name: 'ghl-af-park',
        actor: primary,
        requestId: newRequestId(),
        serviceKey: formatServiceKey('crm.opportunity.update', 1),
        payload: {
          opportunityId,
          stage: 'parked-pending',
          idempotencyKey: `af-park-${runTag}`,
        },
        metadata: { tenantId: TENANT, proof: 'ghl-acceptance-fixtures' },
      })) as CommandResponse;
      if (!awaiting(parked) || !parked.run?.approvalId) {
        fail('D', `expected parked R2 approval, got ${JSON.stringify(parked).slice(0, 400)}`);
      }
      // Leave parked — do not approve (separate from stage handoff below)
      ok('D', `permission deny zero writes; R2 parked approvalId=${parked.run.approvalId}`);
    }

    // ── PASS E (pre): Completed replay seed + stage park for restart ──────
    const replayKey = `af-replay-note-${runTag}`;
    let replaySideEffectId = '';
    let replayExternalResourceId = '';
    {
      const first = (await client.submitCommand({
        name: 'ghl-af-replay-1',
        actor: primary,
        requestId: newRequestId(),
        serviceKey: formatServiceKey('crm.note.create', 1),
        payload: {
          contactId,
          body: 'replay seed note',
          idempotencyKey: replayKey,
        },
        metadata: { tenantId: TENANT, proof: 'ghl-acceptance-fixtures' },
      })) as CommandResponse;
      if (!succeeded(first)) {
        fail('E', `replay seed failed: ${JSON.stringify(first).slice(0, 400)}`);
      }
      replaySideEffectId = String(first.result?.output?.['sideEffectId'] ?? '');
      replayExternalResourceId = externalId(first);
      await assertPersistedSideEffect(client, TENANT, 'E-seed', {
        sideEffectId: replaySideEffectId,
        executionId: first.execution?.executionId ?? '',
      });

      const sameProcessReplay = (await client.submitCommand({
        name: 'ghl-af-replay-2',
        actor: primary,
        requestId: newRequestId(),
        serviceKey: formatServiceKey('crm.note.create', 1),
        payload: {
          contactId,
          body: 'replay seed note',
          idempotencyKey: replayKey,
        },
        metadata: { tenantId: TENANT, proof: 'ghl-acceptance-fixtures' },
      })) as CommandResponse;
      if (!succeeded(sameProcessReplay)) {
        fail('E', `same-process replay failed: ${JSON.stringify(sameProcessReplay).slice(0, 400)}`);
      }
      if (sameProcessReplay.result?.output?.['idempotentReplay'] !== true) {
        fail('E', 'same-process replay must set idempotentReplay=true');
      }
      if (externalId(sameProcessReplay) !== replayExternalResourceId) {
        fail('E', 'replay must return original externalResourceId');
      }
      const ledgerCount = await countSideEffectsByIdempotencyKey(
        client,
        TENANT,
        replayKey,
      );
      if (ledgerCount !== 1) {
        fail('E', `expected 1 ledger row for replay key, got ${ledgerCount}`);
      }
      ok('E', `same-process replay ok; handoff for post-restart replay`);
    }

    const stageKey = `af-stage-${runTag}`;
    {
      const gated = (await client.submitCommand({
        name: 'ghl-af-stage',
        actor: primary,
        requestId: newRequestId(),
        serviceKey: formatServiceKey('crm.opportunity.update', 1),
        payload: {
          opportunityId,
          stage: 'qualified',
          idempotencyKey: stageKey,
        },
        metadata: { tenantId: TENANT, proof: 'ghl-acceptance-fixtures' },
      })) as CommandResponse;
      if (!awaiting(gated) || !gated.run?.approvalId) {
        fail('E', `expected stage gate, got ${JSON.stringify(gated).slice(0, 400)}`);
      }
      happyPathR2Gates += 1;
      if (happyPathR2Gates !== 3) {
        fail('E', `expected 3 happy-path R2 gates, got ${happyPathR2Gates}`);
      }

      const fs = await import('node:fs/promises');
      const handoff: Handoff = {
        approvalId: gated.run.approvalId,
        human: { actorId: human.actorId, actor: human },
        contactId,
        opportunityId,
        noteSideEffectId,
        noteExecutionId,
        noteIdempotencyKey,
        noteExternalResourceId,
        replayKey,
        replaySideEffectId,
        replayExternalResourceId,
        stageKey,
        attributedValue: SYNTHETIC_BUSINESS_VALUE_USD,
        happyPathR2Gates,
      };
      await fs.writeFile(HANDOFF_PATH, JSON.stringify(handoff), 'utf8');
      ok('E-park', `stage update parked for restart approvalId=${gated.run.approvalId}`);
    }

    // ── PASS F: Concurrent duplicate ──────────────────────────────────────
    {
      const concKey = `af-concurrent-${runTag}`;
      const [a, b] = await Promise.all([
        client.submitCommand({
          name: 'ghl-af-conc-a',
          actor: primary,
          requestId: newRequestId(),
          serviceKey: formatServiceKey('crm.note.create', 1),
          payload: {
            contactId,
            body: 'concurrent acceptance note',
            idempotencyKey: concKey,
          },
          metadata: { tenantId: TENANT, proof: 'ghl-acceptance-fixtures' },
        }) as Promise<CommandResponse>,
        client.submitCommand({
          name: 'ghl-af-conc-b',
          actor: primary,
          requestId: newRequestId(),
          serviceKey: formatServiceKey('crm.note.create', 1),
          payload: {
            contactId,
            body: 'concurrent acceptance note',
            idempotencyKey: concKey,
          },
          metadata: { tenantId: TENANT, proof: 'ghl-acceptance-fixtures' },
        }) as Promise<CommandResponse>,
      ]);
      if (!succeeded(a) || !succeeded(b)) {
        fail('F', `concurrent submits failed: ${JSON.stringify({ a, b }).slice(0, 500)}`);
      }
      const idA = String(a.result?.output?.['sideEffectId'] ?? '');
      const idB = String(b.result?.output?.['sideEffectId'] ?? '');
      if (!idA || idA !== idB) {
        fail('F', `expected one sideEffectId, got ${idA} / ${idB}`);
      }
      if (externalId(a) !== externalId(b) || !externalId(a)) {
        fail('F', 'concurrent must converge on one externalResourceId (object count=1)');
      }
      const ledgerCount = await countSideEffectsByIdempotencyKey(client, TENANT, concKey);
      if (ledgerCount !== 1) {
        fail('F', `expected 1 ledger row, got ${ledgerCount}`);
      }
      const bodyMut =
        (a.result?.output?.['body'] as Record<string, unknown> | undefined)?.[
          'providerMutationCount'
        ] ??
        (b.result?.output?.['body'] as Record<string, unknown> | undefined)?.[
          'providerMutationCount'
        ];
      // Fake backend stamps providerMutationCount; both successful paths share one write.
      if (typeof bodyMut === 'number' && bodyMut < 1) {
        fail('F', `providerMutationCount must be ≥1, got ${bodyMut}`);
      }
      await assertPersistedSideEffect(client, TENANT, 'F', {
        sideEffectId: idA,
        executionId:
          a.execution?.executionId ?? b.execution?.executionId ?? '',
      });
      ok(
        'F',
        `concurrent → 1 ledger row, 1 object id=${externalId(a)} (providerMutationCount=${String(bodyMut ?? 'n/a')})`,
      );
    }

    // ── PASS G: Rate limit / auth failure ─────────────────────────────────
    {
      const rate = (await client.submitCommand({
        name: 'ghl-af-rate',
        actor: primary,
        requestId: newRequestId(),
        serviceKey: formatServiceKey('crm.note.create', 1),
        payload: {
          contactId,
          body: 'rate limited',
          idempotencyKey: `af-rate-${runTag}`,
          simulateError: {
            code: 'GHL_RATE_LIMIT',
            message: '429 rate limited',
            retryable: true,
          },
        },
        metadata: { tenantId: TENANT, proof: 'ghl-acceptance-fixtures' },
      })) as CommandResponse;
      if (succeeded(rate) || errorCode(rate) !== 'GHL_RATE_LIMIT') {
        fail('G', `expected GHL_RATE_LIMIT, got ${JSON.stringify(rate).slice(0, 400)}`);
      }
      if (rate.execution?.status === 'succeeded') {
        fail('G', 'rate limit must not mark execution succeeded');
      }

      const auth = (await client.submitCommand({
        name: 'ghl-af-auth',
        actor: primary,
        requestId: newRequestId(),
        serviceKey: formatServiceKey('crm.note.create', 1),
        payload: {
          contactId,
          body: 'auth denied',
          idempotencyKey: `af-auth-${runTag}`,
          simulateError: {
            code: 'GHL_AUTH_DENIED',
            message: '401 unauthorized',
            retryable: false,
          },
        },
        metadata: { tenantId: TENANT, proof: 'ghl-acceptance-fixtures' },
      })) as CommandResponse;
      if (succeeded(auth) || errorCode(auth) !== 'GHL_AUTH_DENIED') {
        fail('G', `expected GHL_AUTH_DENIED, got ${JSON.stringify(auth).slice(0, 400)}`);
      }
      ok('G', 'rate limit + auth denied: normalized errors, no false success');
    }

    // ── PASS H: Ambiguous write refuse replay ─────────────────────────────
    {
      const ambKey = `af-ambiguous-${runTag}`;
      const first = (await client.submitCommand({
        name: 'ghl-af-amb-1',
        actor: primary,
        requestId: newRequestId(),
        serviceKey: formatServiceKey('crm.task.create', 1),
        payload: {
          contactId,
          title: 'ambiguous task',
          idempotencyKey: ambKey,
          simulateError: {
            code: 'GHL_AMBIGUOUS_TIMEOUT',
            message: '504 ambiguous',
            retryable: true,
          },
        },
        metadata: { tenantId: TENANT, proof: 'ghl-acceptance-fixtures' },
      })) as CommandResponse;
      if (succeeded(first) || errorCode(first) !== 'GHL_AMBIGUOUS_TIMEOUT') {
        fail(
          'H',
          `expected GHL_AMBIGUOUS_TIMEOUT, got ${JSON.stringify(first).slice(0, 400)}`,
        );
      }

      const replay = (await client.submitCommand({
        name: 'ghl-af-amb-2',
        actor: primary,
        requestId: newRequestId(),
        serviceKey: formatServiceKey('crm.task.create', 1),
        payload: {
          contactId,
          title: 'ambiguous task',
          idempotencyKey: ambKey,
        },
        metadata: { tenantId: TENANT, proof: 'ghl-acceptance-fixtures' },
      })) as CommandResponse;
      if (succeeded(replay) || errorCode(replay) !== 'AMBIGUOUS_WRITE_NOT_REPLAYED') {
        fail(
          'H',
          `expected AMBIGUOUS_WRITE_NOT_REPLAYED, got ${JSON.stringify(replay).slice(0, 400)}`,
        );
      }
      ok('H', 'ambiguous write recorded; automatic replay refused');
    }

    // ── PASS I: Deferred capabilities ─────────────────────────────────────
    {
      for (const [label, key, payload] of [
        [
          'conversation.read',
          formatServiceKey('crm.conversation.read', 1),
          { contactId },
        ],
      ] as const) {
        const res = (await client.submitCommand({
          name: `ghl-af-disabled-${label}`,
          actor: primary,
          requestId: newRequestId(),
          serviceKey: key,
          payload,
          metadata: { tenantId: TENANT, proof: 'ghl-acceptance-fixtures' },
        })) as CommandResponse;
        if (succeeded(res) || errorCode(res) !== 'CAPABILITY_DISABLED') {
          fail(
            'I',
            `expected CAPABILITY_DISABLED for ${label}, got ${JSON.stringify(res).slice(0, 400)}`,
          );
        }
      }
      ok(
        'I',
        'conversation.read CAPABILITY_DISABLED (send/appointment.create deferred; fixture-tested)',
      );
    }

    if (PHASE === 'pre') {
      console.log('[ghl-accept-fixtures] pre-restart complete — handoff written');
      return;
    }
  }

  if (PHASE === 'all' || PHASE === 'post') {
    const fs = await import('node:fs/promises');
    const handoff = JSON.parse(await fs.readFile(HANDOFF_PATH, 'utf8')) as Handoff;
    const postAgent = agent(TENANT, 'GhlAcceptFixturesAgent');

    // Resume stage after restart
    {
      const resumed = (await client.decideApproval(handoff.approvalId, {
        approve: true,
        decidedBy: handoff.human.actorId,
        actor: handoff.human.actor,
        note: 'post-restart stage advance',
      })) as CommandResponse;
      if (!succeeded(resumed)) {
        fail('E-resume', `stage resume failed: ${JSON.stringify(resumed).slice(0, 500)}`);
      }
      if (resumed.result?.output?.['idempotentReplay'] === true) {
        fail('E-resume', 'first post-restart stage execute must not be a replay');
      }
      await assertPersistedSideEffect(client, TENANT, 'E-resume', {
        sideEffectId: String(resumed.result?.output?.['sideEffectId'] ?? ''),
        executionId: resumed.execution?.executionId ?? '',
      });
      ok('E-resume', 'restart preserved pending stage approval; applied once');
    }

    // Post-restart completed-operation replay
    {
      const replay = (await client.submitCommand({
        name: 'ghl-af-replay-post',
        actor: postAgent,
        requestId: newRequestId(),
        serviceKey: formatServiceKey('crm.note.create', 1),
        payload: {
          contactId: handoff.contactId,
          body: 'replay seed note',
          idempotencyKey: handoff.replayKey,
        },
        metadata: { tenantId: TENANT, proof: 'ghl-acceptance-fixtures' },
      })) as CommandResponse;
      if (!succeeded(replay)) {
        fail('E-post', `post-restart replay failed: ${JSON.stringify(replay).slice(0, 400)}`);
      }
      if (replay.result?.output?.['idempotentReplay'] !== true) {
        fail('E-post', 'post-restart replay must be idempotentReplay');
      }
      if (String(replay.result?.output?.['sideEffectId']) !== handoff.replaySideEffectId) {
        fail('E-post', 'post-restart replay must return original sideEffectId');
      }
      if (externalId(replay) !== handoff.replayExternalResourceId) {
        fail('E-post', 'post-restart replay must not create a new CRM object');
      }
      const units = replay.execution?.cost?.units ?? 0;
      if (units !== 0) {
        fail('E-post', `replay must not double-count cost (units=${units})`);
      }
      const attributed = Number(replay.execution?.revenueAttributed ?? 0);
      if (attributed !== 0) {
        fail('E-post', `replay must not double-count attributed EV (got ${attributed})`);
      }
      const ledgerCount = await countSideEffectsByIdempotencyKey(
        client,
        TENANT,
        handoff.replayKey,
      );
      if (ledgerCount !== 1) {
        fail('E-post', `expected 1 ledger row after restart replay, got ${ledgerCount}`);
      }
      ok('E-post', 'post-restart replay: same object, zero incremental cost/EV');
    }

    // Telemetry baseline (synthetic — distinguishable from realized)
    const noteExe = (await client.getExecution(handoff.noteExecutionId, {
      tenantId: TENANT,
    })) as {
      execution?: { cost?: { units?: number }; revenueAttributed?: number | string };
      cost?: { units?: number };
      revenueAttributed?: number | string;
    };
    const costUnits = noteExe.execution?.cost?.units ?? noteExe.cost?.units ?? 0;
    const attributed = Number(
      noteExe.execution?.revenueAttributed ?? noteExe.revenueAttributed ?? 0,
    );

    console.log('[TELEMETRY] ──────────────────────────────────────────────');
    console.log('[TELEMETRY] mode=fixtures backend=ghl-fake valueKind=synthetic');
    console.log(`[TELEMETRY] Did it work?              YES`);
    console.log(
      `[TELEMETRY] Did a human intervene?     YES (${handoff.happyPathR2Gates} R2 gates)`,
    );
    console.log(`[TELEMETRY] What did it cost?         ${costUnits} cost units`);
    console.log(
      `[TELEMETRY] Attributed EV (synthetic)  ${attributed} USD (not double-counted as realized)`,
    );
    console.log(
      `[TELEMETRY] Synthetic business value   ${SYNTHETIC_BUSINESS_VALUE_USD} USD (explicit; not realized revenue)`,
    );
    console.log(`[TELEMETRY] contactId=${handoff.contactId}`);
    console.log(`[TELEMETRY] opportunityId=${handoff.opportunityId}`);
    console.log('[TELEMETRY] ──────────────────────────────────────────────');

    console.log('[ghl-accept-fixtures] PASS — acceptance fixtures A–I green');
  }
}

main().catch((err) => {
  console.error(
    '[ghl-accept-fixtures] fatal',
    err instanceof RuntimeApiError ? err.message : err,
  );
  process.exit(1);
});
