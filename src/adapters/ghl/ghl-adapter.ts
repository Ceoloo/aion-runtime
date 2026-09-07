import {
  buildExternalIdempotencyKey,
  capability,
  createExternalSideEffect,
  CRM_CONTACT_UPSERT_MIN_CONFIDENCE,
  formatServiceKey,
  hashExternalResult,
  type Capability,
  type ExecutionAdapter,
  type ExecutionRequest,
  type ExecutionResult,
  type ExternalSideEffect,
} from '@aion/core';
import type { PostgresExternalSideEffectRepository } from '@aion/data';
import type { GhlBackend, GhlMutationKind } from './types.js';
import { isGhlReadAction } from './types.js';
import { sharedFakeGhlBackend } from './fake-ghl-backend.js';

const CRM_ACTIONS: Record<string, GhlMutationKind> = {
  'crm.contact.read': 'contact.read',
  'crm.contact.search': 'contact.search',
  'crm.contact.enrich': 'contact.enrich',
  'crm.contact.update': 'contact.update',
  'crm.opportunity.read': 'opportunity.read',
  'crm.opportunity.search': 'opportunity.search',
  'crm.opportunity.create': 'opportunity.create',
  'crm.opportunity.update': 'opportunity.update',
  'crm.pipeline.read': 'pipeline.read',
  'crm.conversation.read': 'conversation.read',
  'crm.appointment.read': 'appointment.read',
  'crm.note.create': 'note.create',
  'crm.task.create': 'task.create',
  'crm.message.draft': 'message.draft',
  'crm.message.send': 'message.send',
  // M004 continuity — map mock capability onto contact.update semantics.
  'client.ghl.contact.upsert': 'contact.update',
};

export const MISSION_009_CAPABILITIES: Capability[] = [
  capability('crm.contact.read'),
  capability('crm.contact.search'),
  capability('crm.contact.enrich'),
  capability('crm.contact.update'),
  capability('crm.opportunity.read'),
  capability('crm.opportunity.search'),
  capability('crm.opportunity.create'),
  capability('crm.opportunity.update'),
  capability('crm.pipeline.read'),
  capability('crm.conversation.read'),
  capability('crm.appointment.read'),
  capability('crm.note.create'),
  capability('crm.task.create'),
  capability('crm.message.draft'),
  capability('crm.message.send'),
];

export interface GhlAdapterDeps {
  sideEffects: PostgresExternalSideEffectRepository;
  backend?: GhlBackend;
}

/**
 * Governed GHL / CRM adapter.
 *
 * Records every successful mutation in the external side-effect ledger so
 * retries are idempotent. Never called until Runtime policy has ALLOWed.
 */
export class GhlAdapter implements ExecutionAdapter {
  readonly name = 'ghl-adapter';
  private readonly sideEffects: PostgresExternalSideEffectRepository;
  private readonly backend: GhlBackend;

  constructor(deps: GhlAdapterDeps) {
    this.sideEffects = deps.sideEffects;
    this.backend = deps.backend ?? sharedFakeGhlBackend;
  }

  canHandle(request: ExecutionRequest): boolean {
    return Object.prototype.hasOwnProperty.call(CRM_ACTIONS, request.capability);
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const startedAt = new Date().toISOString();
    const action = CRM_ACTIONS[request.capability];
    if (!action) {
      return fail(this.name, startedAt, 'UNSUPPORTED_CAPABILITY', request.capability);
    }

    const tenantId = resolveTenantId(request);
    if (!tenantId) {
      return fail(
        this.name,
        startedAt,
        'TENANT_REQUIRED',
        'crm adapters require tenantId on command.metadata or actor',
      );
    }

    const serviceKey =
      (typeof request.command.metadata?.['serviceKey'] === 'string'
        ? request.command.metadata['serviceKey']
        : undefined) ??
      formatServiceKey(
        request.capability === 'client.ghl.contact.upsert'
          ? 'crm.contact.update'
          : request.capability,
        1,
      );

    const executionId =
      request.command.executionId ??
      (typeof request.command.metadata?.['executionId'] === 'string'
        ? request.command.metadata['executionId']
        : undefined);
    if (!executionId) {
      return fail(
        this.name,
        startedAt,
        'EXECUTION_ID_REQUIRED',
        'crm adapters require command.executionId for side-effect attribution',
      );
    }
    const payload = {
      ...(request.command.payload ?? {}),
    };
    // M004 upsert shape: { provider, contact: { email, ... } }
    if (
      request.capability === 'client.ghl.contact.upsert' &&
      payload['contact'] &&
      typeof payload['contact'] === 'object' &&
      !Array.isArray(payload['contact'])
    ) {
      const contact = payload['contact'] as Record<string, unknown>;
      if (!payload['email'] && typeof contact['email'] === 'string') {
        payload['email'] = contact['email'];
      }
      if (!payload['contactId'] && typeof contact['email'] === 'string') {
        payload['contactId'] = `ghl_contact_${String(contact['email']).replace(/[^a-z0-9]/gi, '_')}`;
      }
      if (!payload['fields']) {
        payload['fields'] = contact;
      }
      // Legacy upsert path treats known email mapping as high-confidence.
      if (payload['matchConfidence'] === undefined) {
        payload['matchConfidence'] = 1;
      }
    }

    // High-confidence gate for contact create / upsert via update.
    if (action === 'contact.update') {
      const confidenceGate = assertContactUpsertConfidence(payload);
      if (confidenceGate) {
        return fail(this.name, startedAt, confidenceGate.code, confidenceGate.message);
      }
    }

    // Never trust caller-supplied cross-tenant workspace override without match.
    const workspaceId =
      typeof payload['workspaceId'] === 'string' ? payload['workspaceId'] : tenantId;
    if (workspaceId !== tenantId && !workspaceId.startsWith(`${tenantId}:`)) {
      return fail(
        this.name,
        startedAt,
        'TENANT_WORKSPACE_MISMATCH',
        `workspace ${workspaceId} is not in tenant ${tenantId}`,
      );
    }

    const targetKey = targetFingerprint(action, payload);
    const idempotencyKey =
      (typeof payload['idempotencyKey'] === 'string' && payload['idempotencyKey'].length > 0
        ? payload['idempotencyKey']
        : undefined) ??
      buildExternalIdempotencyKey({
        executionId,
        tenantId,
        serviceKey,
        requestedAction: action,
        targetKey,
      });

    const existing = await this.sideEffects.getByIdempotencyKey(idempotencyKey);
    if (existing && (existing.status === 'succeeded' || existing.status === 'replayed')) {
      const completedAt = new Date().toISOString();
      return {
        status: 'succeeded',
        output: {
          provider: 'ghl',
          backend: this.backend.name,
          idempotentReplay: true,
          sideEffectId: existing.sideEffectId,
          externalResourceId: existing.externalResourceId,
          externalRequestId: existing.externalRequestId,
          action,
          body: existing.metadata?.['body'] ?? {},
        },
        executor: this.name,
        startedAt,
        completedAt,
        durationMs: 1,
        cost: { units: 0, tokens: 0 },
        metadata: {
          adapter: this.name,
          provider: 'ghl',
          idempotentReplay: true,
          sideEffectId: existing.sideEffectId,
        },
      };
    }

    const backendResult = await this.backend.execute({
      tenantId,
      workspaceId,
      action,
      payload,
      idempotencyKey,
    });

    const completedAt = new Date().toISOString();

    if (!backendResult.ok) {
      return {
        status: 'failed',
        output: {
          provider: 'ghl',
          backend: this.backend.name,
          action,
          errorCode: backendResult.errorCode,
          errorMessage: backendResult.errorMessage,
          retryable: backendResult.retryable ?? false,
        },
        executor: this.name,
        startedAt,
        completedAt,
        durationMs: Math.max(
          1,
          Date.parse(completedAt) - Date.parse(startedAt) || 1,
        ),
        cost: { units: 1, tokens: 10 },
        error: {
          code: backendResult.errorCode,
          message: backendResult.errorMessage,
          retryable: backendResult.retryable ?? false,
        },
        metadata: {
          adapter: this.name,
          provider: 'ghl',
          externalFailure: true,
        },
      };
    }

    const resultHash = hashExternalResult(backendResult.body);
    const approvalId =
      typeof request.command.metadata?.['approvalId'] === 'string'
        ? request.command.metadata['approvalId']
        : undefined;

    const effect = createExternalSideEffect({
      executionId,
      tenantId,
      serviceKey,
      idempotencyKey,
      requestedAction: action,
      performedAt: completedAt,
      status: 'succeeded',
      provider: 'ghl',
      externalResourceId: backendResult.externalResourceId,
      externalRequestId: backendResult.externalRequestId,
      resultHash,
      ...(approvalId ? { approvalId } : {}),
      metadata: {
        body: backendResult.body,
        capability: request.capability,
        backend: this.backend.name,
      },
    });

    const saved = await this.sideEffects.saveOnce(effect);
    const recorded: ExternalSideEffect = saved.effect;

    const legacyContact =
      request.capability === 'client.ghl.contact.upsert' &&
      request.command.payload?.['contact'] &&
      typeof request.command.payload['contact'] === 'object'
        ? (request.command.payload['contact'] as Record<string, unknown>)
        : undefined;

    const costUnits =
      request.capability === 'client.ghl.contact.upsert'
        ? 3
        : isGhlReadAction(action)
          ? 1
          : 4;
    const costTokens =
      request.capability === 'client.ghl.contact.upsert'
        ? 40
        : isGhlReadAction(action)
          ? 20
          : 60;

    return {
      status: 'succeeded',
      output: {
        provider: 'ghl',
        backend: this.backend.name,
        idempotentReplay: !saved.inserted,
        sideEffectId: recorded.sideEffectId,
        externalResourceId: recorded.externalResourceId,
        externalRequestId: recorded.externalRequestId,
        action,
        body: backendResult.body,
        resultHash,
        ...(legacyContact ? { contact: legacyContact } : {}),
      },
      executor: this.name,
      startedAt,
      completedAt,
      durationMs: Math.max(1, Date.parse(completedAt) - Date.parse(startedAt) || 1),
      cost: { units: costUnits, tokens: costTokens },
      metadata: {
        adapter: this.name,
        provider: 'ghl',
        sideEffectId: recorded.sideEffectId,
        externalResourceId: recorded.externalResourceId,
      },
    };
  }
}

function assertContactUpsertConfidence(
  payload: Record<string, unknown>,
): { code: string; message: string } | null {
  const hasContactId =
    typeof payload['contactId'] === 'string' && payload['contactId'].length > 0;
  const upsertIntent =
    payload['upsert'] === true ||
    payload['createIfMissing'] === true ||
    !hasContactId;
  if (!upsertIntent && hasContactId) {
    return null;
  }
  const confidence =
    typeof payload['matchConfidence'] === 'number'
      ? payload['matchConfidence']
      : typeof payload['confidence'] === 'number'
        ? payload['confidence']
        : undefined;
  if (confidence === undefined || confidence < CRM_CONTACT_UPSERT_MIN_CONFIDENCE) {
    return {
      code: 'CONTACT_UPSERT_CONFIDENCE_TOO_LOW',
      message: `contact upsert requires matchConfidence ≥ ${CRM_CONTACT_UPSERT_MIN_CONFIDENCE}`,
    };
  }
  return null;
}

function resolveTenantId(request: ExecutionRequest): string | undefined {
  const meta = request.command.metadata ?? {};
  if (typeof meta['tenantId'] === 'string' && meta['tenantId'].length > 0) {
    return meta['tenantId'];
  }
  const actor = request.command.actor;
  if (
    actor &&
    typeof actor === 'object' &&
    'tenantId' in actor &&
    typeof (actor as { tenantId?: unknown }).tenantId === 'string'
  ) {
    return (actor as { tenantId: string }).tenantId;
  }
  if (typeof request.command.payload?.['tenantId'] === 'string') {
    return request.command.payload['tenantId'] as string;
  }
  return undefined;
}

function targetFingerprint(
  action: GhlMutationKind,
  payload: Record<string, unknown>,
): string {
  const keys = [
    'contactId',
    'opportunityId',
    'pipelineId',
    'conversationId',
    'appointmentId',
    'email',
    'name',
    'body',
    'title',
    'stage',
    'query',
  ];
  const parts = keys
    .map((k) => (typeof payload[k] === 'string' ? `${k}=${payload[k]}` : ''))
    .filter(Boolean);
  return `${action}|${parts.join('|')}`;
}

function fail(
  executor: string,
  startedAt: string,
  code: string,
  message: string,
): ExecutionResult {
  const completedAt = new Date().toISOString();
  return {
    status: 'failed',
    output: { errorCode: code, errorMessage: message },
    executor,
    startedAt,
    completedAt,
    durationMs: 1,
    cost: { units: 0 },
    error: { code, message, retryable: false },
    metadata: { adapter: executor, provider: 'ghl' },
  };
}
