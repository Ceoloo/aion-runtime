/**
 * AIO-17 GHL contract fixtures — payload validation, provider-error mapping,
 * disabled-capability gates, and in-process lead-workflow durability.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildExternalIdempotencyKey,
  capability,
  createExternalSideEffect,
  type ExecutionRequest,
  type ExternalSideEffect,
} from '@aion/core';
import {
  CRM_CONTACT_UPSERT_MIN_CONFIDENCE,
  GHL_API_VERSION,
  GHL_DISABLED_ACTIONS,
} from './constants.js';
import { FakeGhlBackend } from './fake-ghl-backend.js';
import { GhlAdapter } from './ghl-adapter.js';
import { validateGhlPayload } from './payload-validation.js';
import { mapGhlHttpError } from './provider-errors.js';

class MemorySideEffects {
  private readonly byKey = new Map<string, ExternalSideEffect>();

  async getByIdempotencyKey(key: string): Promise<ExternalSideEffect | undefined> {
    return this.byKey.get(key);
  }

  async saveOnce(
    effect: ExternalSideEffect,
  ): Promise<{ effect: ExternalSideEffect; inserted: boolean }> {
    const existing = this.byKey.get(effect.idempotencyKey);
    if (existing) return { effect: existing, inserted: false };
    this.byKey.set(effect.idempotencyKey, effect);
    return { effect, inserted: true };
  }
}

function request(
  capabilityName: string,
  payload: Record<string, unknown>,
  opts?: { tenantId?: string; executionId?: string },
): ExecutionRequest {
  const tenantId = opts?.tenantId ?? 'tenant-a';
  return {
    capability: capability(capabilityName),
    riskLevel: 'R1',
    command: {
      executionId: opts?.executionId ?? 'exe_aio17_fixture',
      name: capabilityName,
      payload,
      metadata: { tenantId },
      actor: { actorType: 'agent', agentId: 'agent_aio17', tenantId },
    },
  } as unknown as ExecutionRequest;
}

describe('AIO-17 GHL API version pin', () => {
  it('pins LeadConnector Version 2021-07-28', () => {
    assert.equal(GHL_API_VERSION, '2021-07-28');
  });

  it('pins contact upsert confidence floor at 0.85', () => {
    assert.equal(CRM_CONTACT_UPSERT_MIN_CONFIDENCE, 0.85);
  });
});

describe('AIO-17 payload validation fixtures', () => {
  it('accepts contact upsert with email', () => {
    assert.equal(
      validateGhlPayload('contact.update', {
        email: 'lead@example.com',
        upsert: true,
        matchConfidence: 0.9,
      }),
      null,
    );
  });

  it('rejects note.create without body', () => {
    const err = validateGhlPayload('note.create', { contactId: 'c1' });
    assert.equal(err?.code, 'PAYLOAD_INVALID');
    assert.equal(err?.field, 'body');
  });

  it('rejects task.create without title', () => {
    const err = validateGhlPayload('task.create', { contactId: 'c1' });
    assert.equal(err?.code, 'PAYLOAD_INVALID');
    assert.equal(err?.field, 'title');
  });

  it('validates conversation.read requires conversationId|contactId', () => {
    const err = validateGhlPayload('conversation.read', {});
    assert.equal(err?.code, 'PAYLOAD_INVALID');
  });

  it('validates conversation.send requires body', () => {
    const err = validateGhlPayload('conversation.send', { contactId: 'c1' });
    assert.equal(err?.code, 'PAYLOAD_INVALID');
    assert.equal(err?.field, 'body');
  });

  it('validates appointment.create requires startAt', () => {
    const err = validateGhlPayload('appointment.create', {
      contactId: 'c1',
      title: 'Demo',
    });
    assert.equal(err?.code, 'PAYLOAD_INVALID');
    assert.equal(err?.field, 'startAt');
  });
});

describe('AIO-17 provider-error mapping fixtures', () => {
  it('maps 429 to GHL_RATE_LIMIT (retryable)', () => {
    const m = mapGhlHttpError(429, 'slow down');
    assert.equal(m.errorCode, 'GHL_RATE_LIMIT');
    assert.equal(m.retryable, true);
    assert.equal(m.ambiguousWrite, false);
  });

  it('maps 504 to ambiguous timeout (not auto-retry)', () => {
    const m = mapGhlHttpError(504, 'gateway timeout');
    assert.equal(m.errorCode, 'GHL_AMBIGUOUS_TIMEOUT');
    assert.equal(m.ambiguousWrite, true);
    assert.equal(m.retryable, false);
  });

  it('maps 401 to GHL_AUTH_DENIED', () => {
    const m = mapGhlHttpError(401, 'nope');
    assert.equal(m.errorCode, 'GHL_AUTH_DENIED');
  });
});

describe('AIO-17 disabled capability fixtures', () => {
  it('lists conversation.read/send and appointment.create as disabled', () => {
    assert.ok(GHL_DISABLED_ACTIONS.has('conversation.read'));
    assert.ok(GHL_DISABLED_ACTIONS.has('conversation.send'));
    assert.ok(GHL_DISABLED_ACTIONS.has('appointment.create'));
  });

  it('returns CAPABILITY_DISABLED for conversation.read/send and appointment.create', async () => {
    const adapter = new GhlAdapter({
      sideEffects: new MemorySideEffects() as never,
      backend: new FakeGhlBackend(),
    });

    for (const [cap, payload] of [
      ['crm.conversation.read', { contactId: 'ghl_contact_seed' }],
      ['crm.conversation.send', { contactId: 'ghl_contact_seed', body: 'hi' }],
      [
        'crm.appointment.create',
        {
          contactId: 'ghl_contact_seed',
          title: 'Intro',
          startAt: '2026-09-20T15:00:00.000Z',
        },
      ],
    ] as const) {
      const result = await adapter.execute(request(cap, { ...payload }));
      assert.equal(result.status, 'failed', cap);
      assert.equal(result.error?.code, 'CAPABILITY_DISABLED', cap);
    }
  });
});

describe('AIO-17 enabled lead-workflow slice (in-process)', () => {
  it('runs contact→opportunity→stage→note→task with durability proofs', async () => {
    const sideEffects = new MemorySideEffects();
    const backend = new FakeGhlBackend();
    const adapter = new GhlAdapter({
      sideEffects: sideEffects as never,
      backend,
    });

    const contact = await adapter.execute(
      request('crm.contact.update', {
        email: 'aio17.lead@example.com',
        firstName: 'Aio',
        lastName: 'Seventeen',
        upsert: true,
        matchConfidence: 0.95,
        idempotencyKey: 'aio17-contact-1',
      }),
    );
    assert.equal(contact.status, 'succeeded');
    const contactOut = contact.output as Record<string, unknown>;
    const contactId = String(contactOut['externalResourceId'] ?? '');
    assert.ok(contactId.length > 0);
    assert.equal(contactOut['apiVersion'], GHL_API_VERSION);

    const opp = await adapter.execute(
      request('crm.opportunity.create', {
        contactId,
        name: 'AIO-17 Lead Opp',
        pipelineId: 'pipe_default',
        stage: 'new',
        idempotencyKey: 'aio17-opp-1',
      }),
    );
    assert.equal(opp.status, 'succeeded');
    const opportunityId = String(
      (opp.output as Record<string, unknown>)['externalResourceId'] ?? '',
    );
    assert.ok(opportunityId.length > 0);

    const stage = await adapter.execute(
      request('crm.opportunity.update', {
        opportunityId,
        stage: 'qualified',
        idempotencyKey: 'aio17-stage-1',
      }),
    );
    assert.equal(stage.status, 'succeeded');
    const stageBody = (stage.output as Record<string, unknown>)['body'] as Record<
      string,
      unknown
    >;
    assert.equal(String(stageBody['stage']), 'qualified');

    const note = await adapter.execute(
      request('crm.note.create', {
        contactId,
        body: 'AIO-17 fixture note',
        idempotencyKey: 'aio17-note-1',
      }),
    );
    assert.equal(note.status, 'succeeded');

    const task = await adapter.execute(
      request('crm.task.create', {
        contactId,
        title: 'AIO-17 follow-up',
        idempotencyKey: 'aio17-task-1',
      }),
    );
    assert.equal(task.status, 'succeeded');

    // Completed-operation replay
    const replay = await adapter.execute(
      request('crm.note.create', {
        contactId,
        body: 'AIO-17 fixture note',
        idempotencyKey: 'aio17-note-1',
      }),
    );
    assert.equal(replay.status, 'succeeded');
    assert.equal((replay.output as Record<string, unknown>)['idempotentReplay'], true);

    // Rate limit
    backend.injectFailure({
      ok: false,
      errorCode: 'GHL_RATE_LIMIT',
      errorMessage: '429',
      retryable: true,
    });
    const limited = await adapter.execute(
      request('crm.note.create', {
        contactId,
        body: 'rate-limited',
        idempotencyKey: 'aio17-note-rate',
      }),
    );
    assert.equal(limited.status, 'failed');
    assert.equal(limited.error?.code, 'GHL_RATE_LIMIT');
    assert.equal(limited.error?.retryable, true);

    // Ambiguous write timeout — recorded, not auto-repeated
    backend.injectFailure({
      ok: false,
      errorCode: 'GHL_AMBIGUOUS_TIMEOUT',
      errorMessage: '504',
      retryable: true,
    });
    const ambiguous = await adapter.execute(
      request('crm.task.create', {
        contactId,
        title: 'ambiguous task',
        idempotencyKey: 'aio17-task-ambiguous',
      }),
    );
    assert.equal(ambiguous.status, 'failed');
    assert.equal(ambiguous.error?.code, 'GHL_AMBIGUOUS_TIMEOUT');

    const refused = await adapter.execute(
      request('crm.task.create', {
        contactId,
        title: 'ambiguous task',
        idempotencyKey: 'aio17-task-ambiguous',
      }),
    );
    assert.equal(refused.status, 'failed');
    assert.equal(refused.error?.code, 'AMBIGUOUS_WRITE_NOT_REPLAYED');

    // Tenant mismatch
    const mismatch = await adapter.execute(
      request('crm.contact.read', { contactId, workspaceId: 'other-tenant' }, {
        tenantId: 'tenant-a',
      }),
    );
    assert.equal(mismatch.status, 'failed');
    assert.equal(mismatch.error?.code, 'TENANT_WORKSPACE_MISMATCH');

    // Concurrent duplicate execution
    const key = 'aio17-concurrent-note';
    const [a, b] = await Promise.all([
      adapter.execute(
        request('crm.note.create', {
          contactId,
          body: 'concurrent',
          idempotencyKey: key,
        }),
      ),
      adapter.execute(
        request('crm.note.create', {
          contactId,
          body: 'concurrent',
          idempotencyKey: key,
        }),
      ),
    ]);
    assert.equal(a.status, 'succeeded');
    assert.equal(b.status, 'succeeded');
    assert.equal(
      (a.output as Record<string, unknown>)['sideEffectId'],
      (b.output as Record<string, unknown>)['sideEffectId'],
    );

    const ik = buildExternalIdempotencyKey({
      executionId: 'exe_x',
      tenantId: 'tenant-a',
      serviceKey: 'crm.note.create@1',
      requestedAction: 'note.create',
      targetKey: 'note.create|contactId=c1|body=x',
    });
    assert.ok(ik.startsWith('ik_'));

    const ese = createExternalSideEffect({
      executionId: 'exe_x',
      tenantId: 'tenant-a',
      serviceKey: 'crm.note.create@1',
      idempotencyKey: ik,
      requestedAction: 'note.create',
      performedAt: new Date().toISOString(),
      status: 'succeeded',
      provider: 'ghl',
      externalResourceId: 'n1',
    });
    assert.ok(String(ese.sideEffectId).length > 0);
  });
});
