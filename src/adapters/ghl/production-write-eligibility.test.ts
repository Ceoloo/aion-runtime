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
  SYNTHETIC_TO_PRODUCTION_DENIED,
  assessLiveCustomerWrite,
  clearLiveFixtureRecords,
  rememberLiveFixtureRecord,
  sha256Hex,
} from './production-write-eligibility.js';
import type { GhlBackend, GhlBackendRequest, GhlBackendResult } from './types.js';

const INCIDENT_NOTE =
  'Synthetic qualification snapshot (test data, not a real prospect)';

class MemorySideEffects {
  readonly saved: ExternalSideEffect[] = [];
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
    this.saved.push(effect);
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
    assert.equal(decision.disposition, 'deny');
    assert.equal(decision.code, SYNTHETIC_TO_PRODUCTION_DENIED);
  });

  it('allows the same note on the fake backend', () => {
    const decision = assessLiveCustomerWrite({
      backendName: 'ghl-fake',
      action: 'note.create',
      payload: { contactId: 'annfiera-contact', body: INCIDENT_NOTE },
    });
    assert.equal(decision.eligible, true);
    assert.equal(decision.disposition, 'defer-to-policy');
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
    assert.equal(decision.disposition, 'defer-to-policy');
    assert.equal(decision.code, undefined);
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
    assert.equal(created.disposition, 'allow-fixture');
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
    assert.equal(note.disposition, 'allow-fixture');
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
    assert.equal(decision.disposition, 'deny');
    assert.equal(decision.code, SYNTHETIC_TO_PRODUCTION_DENIED);
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
    assert.equal(stage.disposition, 'defer-to-policy');
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

const KNOWN_PRODUCTION_CONTACT = 'contact_known_production';
const KNOWN_PRODUCTION_HASHES = [sha256Hex(KNOWN_PRODUCTION_CONTACT)];

function liveAdapter(backend: RecordingBackend, sideEffects = new MemorySideEffects()) {
  return {
    sideEffects,
    adapter: new GhlAdapter({
      sideEffects: sideEffects as never,
      backend,
      protectedRecordHashes: KNOWN_PRODUCTION_HASHES,
    }),
  };
}

describe('GhlAdapter live write boundary', () => {
  beforeEach(() => {
    clearLiveFixtureRecords();
  });

  it('synthetic + known production contact → DENY before the external request', async () => {
    const backend = new RecordingBackend('ghl-live');
    const { adapter, sideEffects } = liveAdapter(backend);
    const result = await adapter.execute(
      request(
        'crm.note.create',
        {
          contactId: KNOWN_PRODUCTION_CONTACT,
          body: 'Qualification note for follow-up',
          idempotencyKey: 'syn-meta-prod',
        },
        { synthetic: true },
      ),
    );
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, SYNTHETIC_TO_PRODUCTION_DENIED);
    assert.equal(backend.calls.length, 0);
    assert.equal(sideEffects.saved.length, 0);
  });

  it('synthetic body + known production contact → DENY before the external request', async () => {
    const backend = new RecordingBackend('ghl-live');
    const { adapter, sideEffects } = liveAdapter(backend);
    const result = await adapter.execute(
      request('crm.note.create', {
        contactId: KNOWN_PRODUCTION_CONTACT,
        body: INCIDENT_NOTE,
        idempotencyKey: 'syn-body-prod',
      }),
    );
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, SYNTHETIC_TO_PRODUCTION_DENIED);
    assert.equal(backend.calls.length, 0);
    assert.equal(sideEffects.saved.length, 0);
  });

  it('synthetic + process-created fixture contact → narrowly ALLOW', async () => {
    const backend = new RecordingBackend('ghl-live');
    const { adapter } = liveAdapter(backend);
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
        { synthetic: true },
      ),
    );
    assert.equal(created.status, 'succeeded');
    assert.equal(backend.calls.length, 1);
    assert.equal(backend.calls[0]?.action, 'contact.update');

    const note = await adapter.execute(
      request(
        'crm.note.create',
        {
          contactId: 'fixture_contact_created',
          body: INCIDENT_NOTE,
          idempotencyKey: 'fixture-note-1',
        },
        { synthetic: true },
      ),
    );
    assert.equal(note.status, 'succeeded');
    assert.equal(backend.calls.length, 2);
    assert.equal(backend.calls[1]?.action, 'note.create');
    assert.equal(backend.calls[1]?.payload['contactId'], 'fixture_contact_created');

    const stillDenied = await adapter.execute(
      request(
        'crm.note.create',
        {
          contactId: KNOWN_PRODUCTION_CONTACT,
          body: INCIDENT_NOTE,
          idempotencyKey: 'still-denied-on-production',
        },
        { synthetic: true },
      ),
    );
    assert.equal(stillDenied.status, 'failed');
    assert.equal(stillDenied.error?.code, SYNTHETIC_TO_PRODUCTION_DENIED);
    assert.equal(backend.calls.length, 2);
  });

  it('non-synthetic + production contact → defers to the prior policy decision', async () => {
    const decision = assessLiveCustomerWrite({
      backendName: 'ghl-live',
      action: 'note.create',
      payload: {
        contactId: KNOWN_PRODUCTION_CONTACT,
        body: 'OL-001 · Example Client · Sample Lead — qualification note',
      },
      metadata: { synthetic: false },
      protectedHashes: KNOWN_PRODUCTION_HASHES,
    });
    assert.equal(decision.disposition, 'defer-to-policy');
    assert.equal(decision.code, undefined);

    const backend = new RecordingBackend('ghl-live');
    const { adapter } = liveAdapter(backend);
    const result = await adapter.execute(
      request(
        'crm.note.create',
        {
          contactId: KNOWN_PRODUCTION_CONTACT,
          body: 'OL-001 · Example Client · Sample Lead — qualification note',
          idempotencyKey: 'prod-qualification-note',
        },
        { synthetic: false },
      ),
    );
    assert.equal(result.status, 'succeeded');
    assert.equal(result.error, undefined);
    assert.equal(backend.calls.length, 1);
    assert.equal(backend.calls[0]?.action, 'note.create');
    assert.equal(backend.calls[0]?.payload['contactId'], KNOWN_PRODUCTION_CONTACT);
  });

  it('calls the fake backend for the same synthetic note', async () => {
    const backend = new RecordingBackend('ghl-fake');
    const adapter = new GhlAdapter({
      sideEffects: new MemorySideEffects() as never,
      backend,
      protectedRecordHashes: KNOWN_PRODUCTION_HASHES,
    });
    const result = await adapter.execute(
      request('crm.note.create', {
        contactId: KNOWN_PRODUCTION_CONTACT,
        body: INCIDENT_NOTE,
        idempotencyKey: 'incident-note-fake',
      }),
    );
    assert.equal(result.status, 'succeeded');
    assert.equal(backend.calls.length, 1);
  });
});
