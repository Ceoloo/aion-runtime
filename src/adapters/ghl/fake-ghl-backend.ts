import { randomUUID } from 'node:crypto';
import type {
  GhlBackend,
  GhlBackendFailure,
  GhlBackendRequest,
  GhlBackendResult,
  GhlMutationKind,
} from './types.js';

interface Contact {
  id: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  tags: string[];
  fields: Record<string, unknown>;
}

interface Opportunity {
  id: string;
  contactId?: string;
  name: string;
  stage: string;
  value?: number;
  fields: Record<string, unknown>;
}

interface Workspace {
  contacts: Map<string, Contact>;
  opportunities: Map<string, Opportunity>;
  notes: Map<string, Record<string, unknown>>;
  tasks: Map<string, Record<string, unknown>>;
  drafts: Map<string, Record<string, unknown>>;
  messages: Map<string, Record<string, unknown>>;
  mutationCount: number;
}

/**
 * In-process multi-tenant GHL stand-in for CI / proof matrices.
 *
 * Behaves like an external system: tenant-scoped workspaces, mutable CRM
 * state, injectable failures. Live mode swaps in a real HTTP client later
 * without changing the adapter contract.
 */
export class FakeGhlBackend implements GhlBackend {
  readonly name = 'ghl-fake';
  private readonly workspaces = new Map<string, Workspace>();
  private nextFailure: GhlBackendFailure | undefined;

  mutationCount(tenantId: string): number {
    return this.workspace(tenantId).mutationCount;
  }

  injectFailure(failure: GhlBackendFailure): void {
    this.nextFailure = failure;
  }

  /** Proof helper — read contact from fake workspace. */
  getContact(tenantId: string, contactId: string): Contact | undefined {
    return this.workspace(tenantId).contacts.get(contactId);
  }

  async execute(request: GhlBackendRequest): Promise<GhlBackendResult> {
    const simulated = request.payload['simulateError'];
    if (simulated && typeof simulated === 'object' && !Array.isArray(simulated)) {
      const sim = simulated as Record<string, unknown>;
      return {
        ok: false,
        errorCode: typeof sim['code'] === 'string' ? sim['code'] : 'GHL_SIMULATED_ERROR',
        errorMessage:
          typeof sim['message'] === 'string' ? sim['message'] : 'simulated external failure',
        retryable: sim['retryable'] === true,
      };
    }

    if (this.nextFailure) {
      const failure = this.nextFailure;
      this.nextFailure = undefined;
      return failure;
    }

    const ws = this.workspace(request.tenantId);
    const externalRequestId = `ghl_req_${randomUUID()}`;

    try {
      const body = this.dispatch(ws, request.action, request.payload);
      ws.mutationCount += isMutating(request.action) ? 1 : 0;
      const externalResourceId =
        typeof body['id'] === 'string'
          ? body['id']
          : `ghl_${request.action.replace('.', '_')}_${randomUUID().slice(0, 8)}`;
      return {
        ok: true,
        externalResourceId,
        externalRequestId,
        body: { ...body, id: externalResourceId },
      };
    } catch (err) {
      return {
        ok: false,
        errorCode: 'GHL_FAKE_ERROR',
        errorMessage: err instanceof Error ? err.message : 'unknown',
      };
    }
  }

  private workspace(tenantId: string): Workspace {
    let ws = this.workspaces.get(tenantId);
    if (!ws) {
      ws = {
        contacts: new Map(),
        opportunities: new Map(),
        notes: new Map(),
        tasks: new Map(),
        drafts: new Map(),
        messages: new Map(),
        mutationCount: 0,
      };
      this.workspaces.set(tenantId, ws);
    }
    return ws;
  }

  private dispatch(
    ws: Workspace,
    action: GhlMutationKind,
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    switch (action) {
      case 'contact.read': {
        const id = str(payload['contactId']);
        const contact = id ? ws.contacts.get(id) : undefined;
        if (!contact) throw new Error(`contact not found: ${id ?? '(missing)'}`);
        return { ...contact };
      }
      case 'contact.enrich':
      case 'contact.update': {
        const id = str(payload['contactId']) ?? `ghl_contact_${randomUUID().slice(0, 8)}`;
        const existing = ws.contacts.get(id) ?? {
          id,
          tags: [],
          fields: {},
        };
        const next: Contact = {
          ...existing,
          email: str(payload['email']) ?? existing.email,
          firstName: str(payload['firstName']) ?? existing.firstName,
          lastName: str(payload['lastName']) ?? existing.lastName,
          tags: Array.isArray(payload['tags'])
            ? (payload['tags'] as string[])
            : existing.tags,
          fields: {
            ...existing.fields,
            ...(payload['fields'] && typeof payload['fields'] === 'object'
              ? (payload['fields'] as Record<string, unknown>)
              : {}),
            ...(action === 'contact.enrich' && payload['enrichment']
              ? { enrichment: payload['enrichment'] }
              : {}),
          },
        };
        ws.contacts.set(id, next);
        return { ...next };
      }
      case 'opportunity.read': {
        const id = str(payload['opportunityId']);
        const opp = id ? ws.opportunities.get(id) : undefined;
        if (!opp) throw new Error(`opportunity not found: ${id ?? '(missing)'}`);
        return { ...opp };
      }
      case 'opportunity.create': {
        const id = `ghl_opp_${randomUUID().slice(0, 8)}`;
        const opp: Opportunity = {
          id,
          contactId: str(payload['contactId']),
          name: str(payload['name']) ?? 'Untitled opportunity',
          stage: str(payload['stage']) ?? 'new',
          value: typeof payload['value'] === 'number' ? payload['value'] : undefined,
          fields: {},
        };
        ws.opportunities.set(id, opp);
        return { ...opp };
      }
      case 'opportunity.update': {
        const id = str(payload['opportunityId']);
        if (!id || !ws.opportunities.has(id)) {
          throw new Error(`opportunity not found: ${id ?? '(missing)'}`);
        }
        const existing = ws.opportunities.get(id)!;
        const next: Opportunity = {
          ...existing,
          name: str(payload['name']) ?? existing.name,
          stage: str(payload['stage']) ?? existing.stage,
          value:
            typeof payload['value'] === 'number' ? payload['value'] : existing.value,
          fields: {
            ...existing.fields,
            ...(payload['fields'] && typeof payload['fields'] === 'object'
              ? (payload['fields'] as Record<string, unknown>)
              : {}),
          },
        };
        ws.opportunities.set(id, next);
        return { ...next };
      }
      case 'note.create': {
        const id = `ghl_note_${randomUUID().slice(0, 8)}`;
        const note = {
          id,
          contactId: str(payload['contactId']),
          body: str(payload['body']) ?? '',
        };
        ws.notes.set(id, note);
        return note;
      }
      case 'task.create': {
        const id = `ghl_task_${randomUUID().slice(0, 8)}`;
        const task = {
          id,
          contactId: str(payload['contactId']),
          title: str(payload['title']) ?? 'Follow up',
        };
        ws.tasks.set(id, task);
        return task;
      }
      case 'message.draft': {
        const id = `ghl_draft_${randomUUID().slice(0, 8)}`;
        const draft = {
          id,
          contactId: str(payload['contactId']),
          body: str(payload['body']) ?? '',
          status: 'draft',
        };
        ws.drafts.set(id, draft);
        return draft;
      }
      case 'message.send': {
        const id = `ghl_msg_${randomUUID().slice(0, 8)}`;
        const message = {
          id,
          contactId: str(payload['contactId']),
          body: str(payload['body']) ?? '',
          status: 'sent',
        };
        ws.messages.set(id, message);
        return message;
      }
      default: {
        const _exhaustive: never = action;
        throw new Error(`unsupported action: ${_exhaustive}`);
      }
    }
  }
}

function isMutating(action: GhlMutationKind): boolean {
  return !action.endsWith('.read');
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Process-wide fake used by defaultAdapters / proofs (swap for live later). */
export const sharedFakeGhlBackend = new FakeGhlBackend();
