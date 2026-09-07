import { randomUUID } from 'node:crypto';
import type {
  GhlBackend,
  GhlBackendRequest,
  GhlBackendResult,
  GhlMutationKind,
} from './types.js';
import {
  type GhlConnection,
  resolveGhlConnection,
} from './connection.js';
import { sharedFakeGhlBackend } from './fake-ghl-backend.js';
import {
  normalizeAppointment,
  normalizeContact,
  normalizeConversation,
  normalizeOpportunity,
  normalizePipeline,
} from './normalize.js';

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface LiveGhlBackendOptions {
  fetchImpl?: FetchLike;
  /** Override connection resolver (tests). */
  resolveConnection?: typeof resolveGhlConnection;
}

/**
 * Live LeadConnector / GHL HTTP backend.
 *
 * Selected when GHL_API_KEY + GHL_LOCATION_ID are present. Reads and the small
 * Phase B write surface are implemented; message.send is supported but should
 * remain policy-gated at R3.
 */
export class LiveGhlBackend implements GhlBackend {
  readonly name = 'ghl-live';
  private readonly fetchImpl: FetchLike;
  private readonly resolveConnection: typeof resolveGhlConnection;

  constructor(options: LiveGhlBackendOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
    this.resolveConnection = options.resolveConnection ?? resolveGhlConnection;
  }

  async execute(request: GhlBackendRequest): Promise<GhlBackendResult> {
    const connection = this.resolveConnection({
      tenantId: request.tenantId,
      locationId: request.locationId ?? str(request.payload['locationId']),
    });
    if (!connection) {
      return {
        ok: false,
        errorCode: 'GHL_CONNECTION_MISSING',
        errorMessage:
          'GHL_API_KEY and GHL_LOCATION_ID required for live CRM; or location mismatch',
        retryable: false,
      };
    }

    try {
      return await this.dispatch(connection, request.action, request.payload);
    } catch (err) {
      return {
        ok: false,
        errorCode: 'GHL_LIVE_ERROR',
        errorMessage: err instanceof Error ? err.message : 'unknown',
        retryable: true,
      };
    }
  }

  private async dispatch(
    connection: GhlConnection,
    action: GhlMutationKind,
    payload: Record<string, unknown>,
  ): Promise<GhlBackendResult> {
    switch (action) {
      case 'contact.read': {
        const id = str(payload['contactId']);
        if (!id) return fail('GHL_BAD_REQUEST', 'contactId required');
        const data = await this.api(connection, 'GET', `/contacts/${encodeURIComponent(id)}`);
        if (!data.ok) return data;
        const contact = asRecord(asRecord(data.body)['contact'] ?? data.body);
        const normalized = normalizeContact(contact);
        return ok(normalized.id || id, data.externalRequestId, normalized as unknown as Record<string, unknown>);
      }
      case 'contact.search': {
        const query = str(payload['query']) ?? '';
        const qs = new URLSearchParams({
          locationId: connection.locationId,
          ...(query ? { query } : {}),
        });
        const data = await this.api(connection, 'GET', `/contacts/?${qs}`);
        if (!data.ok) return data;
        const rawItems = Array.isArray(asRecord(data.body)['contacts'])
          ? (asRecord(data.body)['contacts'] as unknown[])
          : [];
        const items = rawItems.map((c) =>
          normalizeContact(asRecord(c)),
        );
        return ok('contact_search', data.externalRequestId, {
          items,
          count: items.length,
        });
      }
      case 'contact.enrich':
      case 'contact.update': {
        const id = str(payload['contactId']);
        const body = {
          locationId: connection.locationId,
          email: str(payload['email']),
          firstName: str(payload['firstName']),
          lastName: str(payload['lastName']),
          phone: str(payload['phone']),
          tags: Array.isArray(payload['tags']) ? payload['tags'] : undefined,
          ...(payload['fields'] && typeof payload['fields'] === 'object'
            ? { customFields: payload['fields'] }
            : {}),
          ...(action === 'contact.enrich' && payload['enrichment']
            ? { enrichment: payload['enrichment'] }
            : {}),
        };
        if (id) {
          const data = await this.api(
            connection,
            'PUT',
            `/contacts/${encodeURIComponent(id)}`,
            body,
          );
          if (!data.ok) return data;
          const contact = normalizeContact(
            asRecord(asRecord(data.body)['contact'] ?? data.body),
          );
          return ok(contact.id || id, data.externalRequestId, contact as unknown as Record<string, unknown>);
        }
        const data = await this.api(connection, 'POST', '/contacts/', body);
        if (!data.ok) return data;
        const contact = normalizeContact(
          asRecord(asRecord(data.body)['contact'] ?? data.body),
        );
        return ok(contact.id || `ghl_contact_${randomUUID().slice(0, 8)}`, data.externalRequestId, contact as unknown as Record<string, unknown>);
      }
      case 'opportunity.read': {
        const id = str(payload['opportunityId']);
        if (!id) return fail('GHL_BAD_REQUEST', 'opportunityId required');
        const data = await this.api(
          connection,
          'GET',
          `/opportunities/${encodeURIComponent(id)}`,
        );
        if (!data.ok) return data;
        const opp = normalizeOpportunity(
          asRecord(asRecord(data.body)['opportunity'] ?? data.body),
        );
        return ok(opp.id || id, data.externalRequestId, opp as unknown as Record<string, unknown>);
      }
      case 'opportunity.search': {
        const qs = new URLSearchParams({ location_id: connection.locationId });
        const contactId = str(payload['contactId']);
        if (contactId) qs.set('contact_id', contactId);
        const data = await this.api(connection, 'GET', `/opportunities/search?${qs}`);
        if (!data.ok) return data;
        const rawItems = Array.isArray(asRecord(data.body)['opportunities'])
          ? (asRecord(data.body)['opportunities'] as unknown[])
          : [];
        const items = rawItems.map((o) => normalizeOpportunity(asRecord(o)));
        return ok('opportunity_search', data.externalRequestId, {
          items,
          count: items.length,
        });
      }
      case 'opportunity.create': {
        const body = {
          locationId: connection.locationId,
          contactId: str(payload['contactId']),
          name: str(payload['name']) ?? 'Untitled opportunity',
          pipelineId: str(payload['pipelineId']),
          pipelineStageId: str(payload['stage']),
          status: str(payload['status']) ?? 'open',
          monetaryValue: typeof payload['value'] === 'number' ? payload['value'] : undefined,
        };
        const data = await this.api(connection, 'POST', '/opportunities/', body);
        if (!data.ok) return data;
        const opp = normalizeOpportunity(
          asRecord(asRecord(data.body)['opportunity'] ?? data.body),
        );
        return ok(opp.id || `ghl_opp_${randomUUID().slice(0, 8)}`, data.externalRequestId, opp as unknown as Record<string, unknown>);
      }
      case 'opportunity.update': {
        const id = str(payload['opportunityId']);
        if (!id) return fail('GHL_BAD_REQUEST', 'opportunityId required');
        const body: Record<string, unknown> = {};
        if (str(payload['name'])) body['name'] = str(payload['name']);
        if (str(payload['stage'])) body['pipelineStageId'] = str(payload['stage']);
        if (str(payload['status'])) body['status'] = str(payload['status']);
        if (typeof payload['value'] === 'number') body['monetaryValue'] = payload['value'];
        const data = await this.api(
          connection,
          'PUT',
          `/opportunities/${encodeURIComponent(id)}`,
          body,
        );
        if (!data.ok) return data;
        const opp = normalizeOpportunity(
          asRecord(asRecord(data.body)['opportunity'] ?? { id, ...body }),
        );
        return ok(opp.id || id, data.externalRequestId, opp as unknown as Record<string, unknown>);
      }
      case 'pipeline.read': {
        const qs = new URLSearchParams({ locationId: connection.locationId });
        const data = await this.api(
          connection,
          'GET',
          `/opportunities/pipelines?${qs}`,
        );
        if (!data.ok) return data;
        const rawItems = Array.isArray(asRecord(data.body)['pipelines'])
          ? (asRecord(data.body)['pipelines'] as unknown[])
          : Array.isArray(data.body)
            ? (data.body as unknown[])
            : [];
        const items = rawItems.map((p) => normalizePipeline(asRecord(p)));
        const pipelineId = str(payload['pipelineId']);
        if (pipelineId) {
          const hit = items.find((p) => p.id === pipelineId);
          if (!hit) return fail('GHL_NOT_FOUND', `pipeline not found: ${pipelineId}`);
          return ok(hit.id, data.externalRequestId, hit as unknown as Record<string, unknown>);
        }
        return ok('pipeline_list', data.externalRequestId, {
          items,
          count: items.length,
        });
      }
      case 'conversation.read': {
        const qs = new URLSearchParams({ locationId: connection.locationId });
        const contactId = str(payload['contactId']);
        if (contactId) qs.set('contactId', contactId);
        const data = await this.api(
          connection,
          'GET',
          `/conversations/search?${qs}`,
        );
        if (!data.ok) return data;
        const rawItems = Array.isArray(asRecord(data.body)['conversations'])
          ? (asRecord(data.body)['conversations'] as unknown[])
          : [];
        const items = rawItems.map((c) => normalizeConversation(asRecord(c)));
        const conversationId = str(payload['conversationId']);
        if (conversationId) {
          const hit = items.find((c) => c.id === conversationId);
          if (!hit) return fail('GHL_NOT_FOUND', `conversation not found: ${conversationId}`);
          return ok(hit.id, data.externalRequestId, hit as unknown as Record<string, unknown>);
        }
        return ok('conversation_list', data.externalRequestId, {
          items,
          count: items.length,
        });
      }
      case 'appointment.read': {
        const start = str(payload['startAt']) ?? new Date().toISOString();
        const end =
          str(payload['endAt']) ??
          new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
        const qs = new URLSearchParams({
          locationId: connection.locationId,
          startTime: start,
          endTime: end,
        });
        const data = await this.api(connection, 'GET', `/calendars/events?${qs}`);
        if (!data.ok) return data;
        const rawItems = Array.isArray(asRecord(data.body)['events'])
          ? (asRecord(data.body)['events'] as unknown[])
          : Array.isArray(asRecord(data.body)['appointments'])
            ? (asRecord(data.body)['appointments'] as unknown[])
            : [];
        const items = rawItems.map((a) => normalizeAppointment(asRecord(a)));
        const appointmentId = str(payload['appointmentId']);
        if (appointmentId) {
          const hit = items.find((a) => a.id === appointmentId);
          if (!hit) return fail('GHL_NOT_FOUND', `appointment not found: ${appointmentId}`);
          return ok(hit.id, data.externalRequestId, hit as unknown as Record<string, unknown>);
        }
        const contactId = str(payload['contactId']);
        const filtered = contactId
          ? items.filter((a) => a.contactId === contactId)
          : items;
        return ok('appointment_list', data.externalRequestId, {
          items: filtered,
          count: filtered.length,
        });
      }
      case 'note.create': {
        const contactId = str(payload['contactId']);
        if (!contactId) return fail('GHL_BAD_REQUEST', 'contactId required');
        const data = await this.api(
          connection,
          'POST',
          `/contacts/${encodeURIComponent(contactId)}/notes`,
          { body: str(payload['body']) ?? '' },
        );
        if (!data.ok) return data;
        const note = asRecord(asRecord(data.body)['note'] ?? data.body);
        const id = String(note['id'] ?? `ghl_note_${randomUUID().slice(0, 8)}`);
        return ok(id, data.externalRequestId, {
          id,
          contactId,
          body: str(payload['body']) ?? '',
        });
      }
      case 'task.create': {
        const contactId = str(payload['contactId']);
        if (!contactId) return fail('GHL_BAD_REQUEST', 'contactId required');
        const data = await this.api(
          connection,
          'POST',
          `/contacts/${encodeURIComponent(contactId)}/tasks`,
          {
            title: str(payload['title']) ?? 'Follow up',
            body: str(payload['body']),
          },
        );
        if (!data.ok) return data;
        const task = asRecord(asRecord(data.body)['task'] ?? data.body);
        const id = String(task['id'] ?? `ghl_task_${randomUUID().slice(0, 8)}`);
        return ok(id, data.externalRequestId, {
          id,
          contactId,
          title: str(payload['title']) ?? 'Follow up',
        });
      }
      case 'message.draft': {
        // Draft is AION-side until send; record as local draft id against contact.
        const id = `ghl_draft_${randomUUID().slice(0, 8)}`;
        return ok(id, `ghl_req_${randomUUID()}`, {
          id,
          contactId: str(payload['contactId']),
          body: str(payload['body']) ?? '',
          status: 'draft',
        });
      }
      case 'message.send': {
        const contactId = str(payload['contactId']);
        if (!contactId) return fail('GHL_BAD_REQUEST', 'contactId required');
        const data = await this.api(connection, 'POST', '/conversations/messages', {
          type: str(payload['channel']) ?? 'SMS',
          contactId,
          message: str(payload['body']) ?? '',
        });
        if (!data.ok) return data;
        const msg = asRecord(data.body);
        const id = String(msg['messageId'] ?? msg['id'] ?? `ghl_msg_${randomUUID().slice(0, 8)}`);
        return ok(id, data.externalRequestId, {
          id,
          contactId,
          body: str(payload['body']) ?? '',
          status: 'sent',
        });
      }
      default: {
        const _exhaustive: never = action;
        return fail('GHL_UNSUPPORTED', `unsupported action: ${_exhaustive}`);
      }
    }
  }

  private async api(
    connection: GhlConnection,
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<GhlBackendResult> {
    const url = `${connection.baseUrl}${path}`;
    const resp = await this.fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${connection.apiKey}`,
        Version: connection.apiVersion,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const externalRequestId =
      resp.headers.get('x-request-id') ?? `ghl_req_${randomUUID()}`;
    if (!resp.ok) {
      // Never echo Authorization or key material.
      return {
        ok: false,
        errorCode: `GHL_HTTP_${resp.status}`,
        errorMessage: `ghl_http_error status=${resp.status}`,
        retryable: resp.status === 429 || resp.status >= 500,
      };
    }
    let parsed: unknown = {};
    try {
      parsed = await resp.json();
    } catch {
      parsed = {};
    }
    return {
      ok: true,
      externalResourceId: '',
      externalRequestId,
      body: asRecord(parsed),
    };
  }
}

function ok(
  externalResourceId: string,
  externalRequestId: string,
  body: Record<string, unknown>,
): GhlBackendResult {
  return { ok: true, externalResourceId, externalRequestId, body };
}

function fail(errorCode: string, errorMessage: string): GhlBackendResult {
  return { ok: false, errorCode, errorMessage, retryable: false };
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function createGhlBackendFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GhlBackend {
  const connection = resolveGhlConnection({ tenantId: '_probe', env });
  if (connection) {
    return new LiveGhlBackend();
  }
  return sharedFakeGhlBackend;
}
