/**
 * Live Twenty CRM backend (CRM-001) — REST Core API under /rest.
 *
 * Day-one actions: contact.*, opportunity.*, pipeline.read (synthetic),
 * note.create, task.create. Messaging / conversations / appointments stay
 * deferred (same as GHL Appointment OS slice).
 *
 * Production must keep CRM_PROVIDER unset/ghl until cutover gate passes.
 */
import { randomUUID } from 'node:crypto';
import {
  normalizeContact,
  normalizeOpportunity,
  normalizePipeline,
} from '../ghl/normalize.js';
import type {
  CrmBackend,
  CrmBackendRequest,
  CrmBackendResult,
  CrmMutationKind,
} from './types.js';

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

export interface TwentyConnection {
  baseUrl: string;
  apiKey: string;
}

export interface LiveTwentyBackendOptions {
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
}

export function resolveTwentyConnection(env: NodeJS.ProcessEnv = process.env): TwentyConnection | null {
  const baseUrl = env.TWENTY_API_BASE_URL?.trim().replace(/\/$/, '');
  const apiKey = env.TWENTY_API_KEY?.trim();
  if (!baseUrl || !apiKey) {
    return null;
  }
  return { baseUrl, apiKey };
}

export class LiveTwentyBackend implements CrmBackend {
  readonly name = 'twenty-live';
  private readonly fetchImpl: FetchLike;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: LiveTwentyBackendOptions | NodeJS.ProcessEnv = {}) {
    // Support legacy `new LiveTwentyBackend(env)` from create-backend.ts
    if (isProcessEnv(options)) {
      this.env = options;
      this.fetchImpl = fetch as unknown as FetchLike;
    } else {
      this.env = options.env ?? process.env;
      this.fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
    }
  }

  async execute(request: CrmBackendRequest): Promise<CrmBackendResult> {
    const connection = resolveTwentyConnection(this.env);
    if (!connection) {
      return {
        ok: false,
        errorCode: 'TWENTY_CONNECTION_MISSING',
        errorMessage: 'TWENTY_API_BASE_URL and TWENTY_API_KEY required for live Twenty CRM',
        retryable: false,
      };
    }

    try {
      return await this.dispatch(connection, request.action, request.payload);
    } catch (err) {
      return {
        ok: false,
        errorCode: 'TWENTY_LIVE_ERROR',
        errorMessage: err instanceof Error ? err.message : 'unknown',
        retryable: true,
      };
    }
  }

  private async dispatch(
    connection: TwentyConnection,
    action: CrmMutationKind,
    payload: Record<string, unknown>,
  ): Promise<CrmBackendResult> {
    switch (action) {
      case 'contact.read': {
        const id = str(payload['contactId']);
        if (!id) return fail('TWENTY_BAD_REQUEST', 'contactId required');
        const data = await this.api(connection, 'GET', `/rest/people/${encodeURIComponent(id)}`);
        if (!data.ok) return data;
        const person = extractRecord(data.body, ['person', 'people']);
        const normalized = personToContact(person, id);
        return ok(normalized.id || id, data.externalRequestId, normalized as unknown as Record<string, unknown>);
      }
      case 'contact.search': {
        const query = str(payload['query']) ?? str(payload['email']) ?? '';
        const filter = query.includes('@')
          ? `emails.primaryEmail[eq]:${query}`
          : query
            ? `name.firstName[ilike]:%${query}%`
            : undefined;
        const qs = new URLSearchParams({ limit: '20' });
        if (filter) qs.set('filter', filter);
        const data = await this.api(connection, 'GET', `/rest/people?${qs}`);
        if (!data.ok) return data;
        const items = extractList(data.body, ['people', 'person']).map((p) =>
          personToContact(p),
        );
        return ok('contact_search', data.externalRequestId, { items, count: items.length });
      }
      case 'contact.enrich':
      case 'contact.update': {
        const id = str(payload['contactId']);
        const body = personInputFromPayload(payload);
        if (id) {
          const data = await this.api(
            connection,
            'PATCH',
            `/rest/people/${encodeURIComponent(id)}`,
            body,
          );
          if (!data.ok) return data;
          const person = extractRecord(data.body, ['updatePerson', 'person', 'people']);
          const normalized = personToContact(person, id);
          return ok(normalized.id || id, data.externalRequestId, normalized as unknown as Record<string, unknown>);
        }
        const data = await this.api(connection, 'POST', '/rest/people', body);
        if (!data.ok) return data;
        const person = extractRecord(data.body, ['createPerson', 'person', 'people']);
        const normalized = personToContact(person);
        return ok(
          normalized.id || `twenty_person_${randomUUID().slice(0, 8)}`,
          data.externalRequestId,
          normalized as unknown as Record<string, unknown>,
        );
      }
      case 'opportunity.read': {
        const id = str(payload['opportunityId']);
        if (!id) return fail('TWENTY_BAD_REQUEST', 'opportunityId required');
        const data = await this.api(
          connection,
          'GET',
          `/rest/opportunities/${encodeURIComponent(id)}`,
        );
        if (!data.ok) return data;
        const opp = extractRecord(data.body, ['opportunity', 'opportunities']);
        const normalized = opportunityFromTwenty(opp, id);
        return ok(normalized.id || id, data.externalRequestId, normalized as unknown as Record<string, unknown>);
      }
      case 'opportunity.search': {
        const qs = new URLSearchParams({ limit: '20' });
        const contactId = str(payload['contactId']);
        if (contactId) qs.set('filter', `pointOfContactId[eq]:${contactId}`);
        const data = await this.api(connection, 'GET', `/rest/opportunities?${qs}`);
        if (!data.ok) return data;
        const items = extractList(data.body, ['opportunities', 'opportunity']).map((o) =>
          opportunityFromTwenty(o),
        );
        return ok('opportunity_search', data.externalRequestId, { items, count: items.length });
      }
      case 'opportunity.create': {
        const body: Record<string, unknown> = {
          name: str(payload['name']) ?? 'Untitled opportunity',
          stage: str(payload['stage']) ?? str(payload['stageId']) ?? 'NEW',
        };
        const contactId = str(payload['contactId']);
        if (contactId) body['pointOfContactId'] = contactId;
        if (typeof payload['value'] === 'number') {
          body['amount'] = {
            amountMicros: Math.round(payload['value'] * 1_000_000),
            currencyCode: str(payload['currency']) ?? 'USD',
          };
        }
        const data = await this.api(connection, 'POST', '/rest/opportunities', body);
        if (!data.ok) return data;
        const opp = extractRecord(data.body, ['createOpportunity', 'opportunity', 'opportunities']);
        const normalized = opportunityFromTwenty(opp);
        return ok(
          normalized.id || `twenty_opp_${randomUUID().slice(0, 8)}`,
          data.externalRequestId,
          normalized as unknown as Record<string, unknown>,
        );
      }
      case 'opportunity.update': {
        const id = str(payload['opportunityId']);
        if (!id) return fail('TWENTY_BAD_REQUEST', 'opportunityId required');
        const body: Record<string, unknown> = {};
        if (str(payload['name'])) body['name'] = str(payload['name']);
        const stage = str(payload['stage']) ?? str(payload['stageId']);
        if (stage) body['stage'] = stage;
        if (typeof payload['value'] === 'number') {
          body['amount'] = {
            amountMicros: Math.round(payload['value'] * 1_000_000),
            currencyCode: str(payload['currency']) ?? 'USD',
          };
        }
        const data = await this.api(
          connection,
          'PATCH',
          `/rest/opportunities/${encodeURIComponent(id)}`,
          body,
        );
        if (!data.ok) return data;
        const opp = extractRecord(data.body, ['updateOpportunity', 'opportunity', 'opportunities']);
        const normalized = opportunityFromTwenty(opp, id);
        return ok(normalized.id || id, data.externalRequestId, normalized as unknown as Record<string, unknown>);
      }
      case 'pipeline.read': {
        // Twenty stages are enum-like on opportunities; return a synthetic pipeline
        // so existing crm.pipeline.read callers keep working during migration.
        const pipeline = normalizePipeline({
          id: 'twenty_default_pipeline',
          name: 'Twenty default',
          stages: [
            { id: 'NEW', name: 'NEW', position: 0 },
            { id: 'SCREENING', name: 'SCREENING', position: 1 },
            { id: 'MEETING', name: 'MEETING', position: 2 },
            { id: 'PROPOSAL', name: 'PROPOSAL', position: 3 },
            { id: 'CUSTOMER', name: 'CUSTOMER', position: 4 },
          ],
        });
        const pipelineId = str(payload['pipelineId']);
        if (pipelineId && pipelineId !== pipeline.id) {
          return fail('TWENTY_NOT_FOUND', `pipeline not found: ${pipelineId}`);
        }
        return ok(pipeline.id, `twenty_req_${randomUUID()}`, pipeline as unknown as Record<string, unknown>);
      }
      case 'note.create': {
        const title = str(payload['title']) ?? 'AION note';
        const bodyText = str(payload['body']) ?? str(payload['note']) ?? '';
        const data = await this.api(connection, 'POST', '/rest/notes', {
          title,
          bodyV2: { markdown: bodyText },
        });
        if (!data.ok) return data;
        const note = extractRecord(data.body, ['createNote', 'note', 'notes']);
        const id = str(note['id']) ?? `twenty_note_${randomUUID().slice(0, 8)}`;
        return ok(id, data.externalRequestId, { id, title, body: bodyText, ...note });
      }
      case 'task.create': {
        const title = str(payload['title']) ?? str(payload['body']) ?? 'AION task';
        const data = await this.api(connection, 'POST', '/rest/tasks', {
          title,
          status: str(payload['status']) ?? 'TODO',
        });
        if (!data.ok) return data;
        const task = extractRecord(data.body, ['createTask', 'task', 'tasks']);
        const id = str(task['id']) ?? `twenty_task_${randomUUID().slice(0, 8)}`;
        return ok(id, data.externalRequestId, { id, title, ...task });
      }
      case 'conversation.read':
      case 'conversation.send':
      case 'appointment.read':
      case 'appointment.create':
      case 'message.draft':
      case 'message.send':
        return fail(
          'TWENTY_CAPABILITY_DEFERRED',
          `${action} is not in the CRM-001 Twenty day-one surface`,
          false,
        );
      default:
        return fail('TWENTY_UNSUPPORTED_ACTION', `unsupported action: ${action}`, false);
    }
  }

  private async api(
    connection: TwentyConnection,
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<CrmBackendResult & { body?: Record<string, unknown> }> {
    const url = `${connection.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${connection.apiKey}`,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const requestId = res.headers.get('x-request-id') ?? `twenty_req_${randomUUID()}`;
    let parsed: unknown = {};
    try {
      parsed = await res.json();
    } catch {
      parsed = { raw: await res.text().catch(() => '') };
    }
    if (!res.ok) {
      const msg =
        typeof parsed === 'object' && parsed && 'messages' in parsed
          ? JSON.stringify((parsed as { messages: unknown }).messages)
          : `HTTP ${res.status}`;
      return {
        ok: false,
        errorCode: `TWENTY_HTTP_${res.status}`,
        errorMessage: msg,
        retryable: res.status >= 500 || res.status === 429,
      };
    }
    return {
      ok: true,
      externalResourceId: 'pending',
      externalRequestId: requestId,
      body: asRecord(parsed),
    };
  }
}

function isProcessEnv(value: unknown): value is NodeJS.ProcessEnv {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !('fetchImpl' in (value as object)) &&
    !('env' in (value as object))
  );
}

function personInputFromPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: {
      firstName: str(payload['firstName']) ?? '',
      lastName: str(payload['lastName']) ?? '',
    },
  };
  const email = str(payload['email']);
  if (email) body['emails'] = { primaryEmail: email };
  const phone = str(payload['phone']);
  if (phone) {
    body['phones'] = { primaryPhoneNumber: phone };
  }
  if (payload['fields'] && typeof payload['fields'] === 'object') {
    body['fields'] = payload['fields'];
  }
  return body;
}

function personToContact(raw: Record<string, unknown>, fallbackId?: string) {
  const name = asRecord(raw['name']);
  const emails = asRecord(raw['emails']);
  const phones = asRecord(raw['phones']);
  return normalizeContact({
    id: str(raw['id']) ?? fallbackId ?? '',
    email: str(emails['primaryEmail']) ?? str(raw['email']),
    firstName: str(name['firstName']) ?? str(raw['firstName']),
    lastName: str(name['lastName']) ?? str(raw['lastName']),
    phone: str(phones['primaryPhoneNumber']) ?? str(raw['phone']),
    tags: Array.isArray(raw['tags']) ? raw['tags'] : [],
    fields: asRecord(raw['fields']),
  });
}

function opportunityFromTwenty(raw: Record<string, unknown>, fallbackId?: string) {
  const amount = asRecord(raw['amount']);
  const micros = typeof amount['amountMicros'] === 'number' ? amount['amountMicros'] : undefined;
  return normalizeOpportunity({
    id: str(raw['id']) ?? fallbackId ?? '',
    contactId: str(raw['pointOfContactId']) ?? str(raw['contactId']),
    name: str(raw['name']) ?? 'Untitled opportunity',
    stage: str(raw['stage']) ?? 'NEW',
    value: micros !== undefined ? micros / 1_000_000 : undefined,
    fields: asRecord(raw['fields']),
  });
}

function extractRecord(body: unknown, keys: string[]): Record<string, unknown> {
  const root = asRecord(body);
  const data = asRecord(root['data']);
  for (const key of keys) {
    if (data[key] && typeof data[key] === 'object') return asRecord(data[key]);
    if (root[key] && typeof root[key] === 'object') return asRecord(root[key]);
  }
  return Object.keys(data).length > 0 ? data : root;
}

function extractList(body: unknown, keys: string[]): Record<string, unknown>[] {
  const root = asRecord(body);
  const data = asRecord(root['data']);
  for (const key of keys) {
    const candidate = data[key] ?? root[key];
    if (Array.isArray(candidate)) return candidate.map((item) => asRecord(item));
  }
  // Some Twenty responses nest list under data.<plural>.edges or data itself as array
  if (Array.isArray(data['edges'])) {
    return (data['edges'] as unknown[]).map((e) => asRecord(asRecord(e)['node']));
  }
  return [];
}

function ok(
  externalResourceId: string,
  externalRequestId: string,
  body: Record<string, unknown>,
): CrmBackendResult {
  return { ok: true, externalResourceId, externalRequestId, body };
}

function fail(errorCode: string, errorMessage: string, retryable = false): CrmBackendResult {
  return { ok: false, errorCode, errorMessage, retryable };
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function twentyRequestId(): string {
  return `twenty_req_${randomUUID()}`;
}
