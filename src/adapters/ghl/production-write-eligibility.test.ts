/**
 * Synthetic customer evidence must not cross onto a live client CRM record.
 * The incident note is the specification: labeling it synthetic is not eligibility.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it, beforeEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  capability,
  type ExecutionRequest,
  type ExternalSideEffect,
} from '@aion/core';
import { GhlAdapter } from './ghl-adapter.js';
import {
  PROTECTED_LIVE_GHL_RECORD_SHA256,
  SYNTHETIC_EVIDENCE_PRODUCTION_BOUNDARY,
  assessLiveCustomerWrite,
  clearLiveFixtureRecords,
  rememberLiveFixtureRecord,
  sha256Hex,
} from './production-write-eligibility.js';
import type { GhlBackend, GhlBackendRequest, GhlBackendResult } from './types.js';

const INCIDENT_NOTE =
  'Synthetic qualification snapshot (test data, not a real prospect)';

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

class RecordingBackend implements GhlBackend {
  readonly name: string;
  readonly calls: GhlBackendRequest[] = [];

  constructor(name: string) {
    this.name = name;
  }

  async execute(request: GhlBackendRequest): Promise<GhlBackendResult> {
    this.calls.push(request);
    const created =
      request.action === 'contact.update'
        ? 'fixture_contact_created'
        : request.action === 'note.create'
          ? 'fixture_note_created'
          : 'fixture_other';
    return {
      ok: true,
      externalResourceId: created,
      externalRequestId: 'req_test',
      body: { id: created },
    };
  }
}

function request(
  capabilityName: string,
  payload: Record<string, unknown>,
  metadata?: Record<string, unknown>,
): ExecutionRequest {
  return {
    capability: capability(capabilityName),
    riskLevel: 'R1',
    command: {
      executionId: 'exe_boundary',
      name: capabilityName,
      payload,
      metadata: { tenantId: 'tenant-a', ...metadata },
      actor: { actorType: 'agent', agentId: 'agent_boundary', tenantId: 'tenant-a' },
    },
  } as unknown as ExecutionRequest;
}

describe('live CRM write eligibility', () => {
  beforeEach(() => {
    clearLiveFixtureRecords();
  });

  it('refuses the incident note on the live backend before any client record is touched', () => {
    const decision = assessLiveCustomerWrite({
      backendName: 'ghl-live',
      action: 'note.create',
      payload: {
        contactId: 'annfiera-contact',
        body: INCIDENT_NOTE,
      },
    });
    assert.equal(decision.eligible, false);
    assert.equal(decision.code, SYNTHETIC_EVIDENCE_PRODUCTION_BOUNDARY);
  });

  it('allows the same note on the fake backend', () => {
    const decision = assessLiveCustomerWrite({
      backendName: 'ghl-fake',
      action: 'note.create',
      payload: { contactId: 'annfiera-contact', body: INCIDENT_NOTE },
    });
    assert.equal(decision.eligible, true);
  });

  it('allows a production qualification note onto a live contact', () => {
    const decision = assessLiveCustomerWrite({
      backendName: 'ghl-live',
      action: 'note.create',
      payload: {
        contactId: 'client-contact',
        body: 'OL-001 · Example Client · Sample Lead — qualification note',
      },
      metadata: { synthetic: false, cohort: 'OL-001' },
    });
    assert.equal(decision.eligible, true);
  });

  it('allows a synthetic note only after this process created the fixture contact', () => {
    const created = assessLiveCustomerWrite({
      backendName: 'ghl-live',
      action: 'contact.update',
      payload: {
        email: 'aion.live.accept.1@example.invalid',
        firstName: 'AionLive',
      },
      metadata: { proof: 'ghl-live-acceptance' },
    });
    assert.equal(created.eligible, true);
    assert.equal(created.rememberResource, true);

    rememberLiveFixtureRecord('fixture_contact_created');

    const note = assessLiveCustomerWrite({
      backendName: 'ghl-live',
      action: 'note.create',
      payload: {
        contactId: 'fixture_contact_created',
        body: 'AION live acceptance synthetic note 1',
      },
      metadata: { proof: 'ghl-live-acceptance' },
    });
    assert.equal(note.eligible, true);
  });

  it('refuses synthetic evidence on a known production record even if it was remembered', () => {
    const rawId = 'contact_known_production';
    rememberLiveFixtureRecord(rawId);
    const decision = assessLiveCustomerWrite({
      backendName: 'ghl-live',
      action: 'note.create',
      payload: { contactId: rawId, body: 'ordinary qualification note' },
      metadata: { synthetic: true },
      protectedHashes: [sha256Hex(rawId)],
    });
    assert.equal(decision.eligible, false);
    assert.equal(decision.code, SYNTHETIC_EVIDENCE_PRODUCTION_BOUNDARY);
  });

  it('treats proof metadata as synthetic for notes, and leaves a stage-only update eligible', () => {
    const note = assessLiveCustomerWrite({
      backendName: 'ghl-live',
      action: 'note.create',
      payload: { contactId: 'client-contact', body: 'AION live-capability note' },
      metadata: { proof: 'live-capability' },
    });
    assert.equal(note.eligible, false);

    const stage = assessLiveCustomerWrite({
      backendName: 'ghl-live',
      action: 'opportunity.update',
      payload: { opportunityId: 'opp_1', stage: 'stage_qualified' },
      metadata: { proof: 'ghl-live-acceptance' },
    });
    assert.equal(stage.eligible, true);
  });

  it('keeps the embedded denylist equal to production-ids.json', () => {
    const file = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../scripts/lib/production-ids.json',
    );
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      sha256: { ghlRecordIds: string[] };
    };
    assert.deepEqual(
      [...PROTECTED_LIVE_GHL_RECORD_SHA256],
      parsed.sha256.ghlRecordIds,
    );
  });
});

describe('GhlAdapter live write boundary', () => {
  beforeEach(() => {
    clearLiveFixtureRecords();
  });

  it('does not call the live API for the incident note', async () => {
    const backend = new RecordingBackend('ghl-live');
    const adapter = new GhlAdapter({
      sideEffects: new MemorySideEffects() as never,
      backend,
    });
    const result = await adapter.execute(
      request('crm.note.create', {
        contactId: 'annfiera-contact',
        body: INCIDENT_NOTE,
        idempotencyKey: 'incident-note-1',
      }),
    );
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, SYNTHETIC_EVIDENCE_PRODUCTION_BOUNDARY);
    assert.equal(backend.calls.length, 0);
  });

  it('calls the fake backend for the same note', async () => {
    const backend = new RecordingBackend('ghl-fake');
    const adapter = new GhlAdapter({
      sideEffects: new MemorySideEffects() as never,
      backend,
    });
    const result = await adapter.execute(
      request('crm.note.create', {
        contactId: 'annfiera-contact',
        body: INCIDENT_NOTE,
        idempotencyKey: 'incident-note-fake',
      }),
    );
    assert.equal(result.status, 'succeeded');
    assert.equal(backend.calls.length, 1);
  });

  it('writes a synthetic note only to the fixture contact this process created', async () => {
    const backend = new RecordingBackend('ghl-live');
    const adapter = new GhlAdapter({
      sideEffects: new MemorySideEffects() as never,
      backend,
    });
    const created = await adapter.execute(
      request(
        'crm.contact.update',
        {
          email: 'aion.live.cap.1@example.invalid',
          firstName: 'AionLive',
          upsert: true,
          matchConfidence: 0.95,
          idempotencyKey: 'fixture-contact-1',
        },
        { proof: 'live-capability' },
      ),
    );
    assert.equal(created.status, 'succeeded');
    assert.equal(backend.calls.length, 1);

    const note = await adapter.execute(
      request(
        'crm.note.create',
        {
          contactId: 'fixture_contact_created',
          body: 'AION live acceptance synthetic note 1',
          idempotencyKey: 'fixture-note-1',
        },
        { proof: 'live-capability' },
      ),
    );
    assert.equal(note.status, 'succeeded');
    assert.equal(backend.calls.length, 2);
    assert.equal(backend.calls[1]?.action, 'note.create');
  });
});
