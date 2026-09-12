import { randomUUID } from 'node:crypto';
import type {
  GhlBackend,
  GhlBackendFailure,
  GhlBackendRequest,
  GhlBackendResult,
  GhlMutationKind,
} from './types.js';
import { isGhlReadAction } from './types.js';
import {
  normalizeAppointment,
  normalizeContact,
  normalizeConversation,
  normalizeOpportunity,
  normalizePipeline,
  type CrmAppointment,
  type CrmContact,
  type CrmConversation,
  type CrmOpportunity,
  type CrmPipeline,
} from './normalize.js';

interface Workspace {
  contacts: Map<string, CrmContact>;
  opportunities: Map<string, CrmOpportunity>;
  pipelines: Map<string, CrmPipeline>;
  conversations: Map<string, CrmConversation>;
  appointments: Map<string, CrmAppointment>;
  notes: Map<string, Record<string, unknown>>;
  tasks: Map<string, Record<string, unknown>>;
  drafts: Map<string, Record<string, unknown>>;
  messages: Map<string, Record<string, unknown>>;
  mutationCount: number;
  seeded: boolean;
}

/**
 * In-process multi-tenant GHL stand-in for CI / proof matrices.
 *
 * Seeds Phase A read fixtures per tenant on first access. Live mode swaps in
 * LiveGhlBackend without changing the adapter contract.
 */
export class FakeGhlBackend implements GhlBackend {
  readonly name = 'ghl-fake';
  private readonly workspaces = new Map<string, Workspace>();
  private nextFailure: GhlBackendFailure | undefined;
  private readonly idempotencyCache = new Map<string, GhlBackendResult>();

  mutationCount(tenantId: string): number {
    return this.workspace(tenantId).mutationCount;
  }

  injectFailure(failure: GhlBackendFailure): void {
    this.nextFailure = failure;
  }

  getContact(tenantId: string, contactId: string): CrmContact | undefined {
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

    const cached = this.idempotencyCache.get(request.idempotencyKey);
    if (cached) {
      return cached;
    }

    const ws = this.workspace(request.tenantId);
    const externalRequestId = `ghl_req_${randomUUID()}`;

    try {
      const body = this.dispatch(ws, request.action, request.payload);
      ws.mutationCount += isGhlReadAction(request.action) ? 0 : 1;
      const externalResourceId =
        typeof body['id'] === 'string'
          ? body['id']
          : Array.isArray(body['items'])
            ? `ghl_list_${request.action.replace('.', '_')}`
            : `ghl_${request.action.replace('.', '_')}_${randomUUID().slice(0, 8)}`;
      const result: GhlBackendResult = {
        ok: true,
        externalResourceId,
        externalRequestId,
        body: { ...body, id: body['id'] ?? externalResourceId },
      };
      this.idempotencyCache.set(request.idempotencyKey, result);
      return result;
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
        pipelines: new Map(),
        conversations: new Map(),
        appointments: new Map(),
        notes: new Map(),
        tasks: new Map(),
        drafts: new Map(),
        messages: new Map(),
        mutationCount: 0,
        seeded: false,
      };
      this.workspaces.set(tenantId, ws);
    }
    if (!ws.seeded) {
      seedWorkspace(ws, tenantId);
      ws.seeded = true;
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
        return { ...normalizeContact(contact as unknown as Record<string, unknown>) };
      }
      case 'contact.search': {
        const query = (str(payload['query']) ?? '').toLowerCase();
        const items = [...ws.contacts.values()].filter((c) => {
          if (!query) return true;
          return (
            c.email?.toLowerCase().includes(query) ||
            c.firstName?.toLowerCase().includes(query) ||
            c.lastName?.toLowerCase().includes(query) ||
            c.id.toLowerCase().includes(query)
          );
        });
        return { items: items.map((c) => ({ ...c })), count: items.length };
      }
      case 'contact.enrich':
      case 'contact.update': {
        const id = str(payload['contactId']) ?? `ghl_contact_${randomUUID().slice(0, 8)}`;
        const existing = ws.contacts.get(id) ?? {
          id,
          tags: [],
          fields: {},
        };
        const next: CrmContact = {
          ...existing,
          email: str(payload['email']) ?? existing.email,
          firstName: str(payload['firstName']) ?? existing.firstName,
          lastName: str(payload['lastName']) ?? existing.lastName,
          phone: str(payload['phone']) ?? existing.phone,
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
      case 'opportunity.search': {
        const contactId = str(payload['contactId']);
        const stage = str(payload['stage']);
        const items = [...ws.opportunities.values()].filter((o) => {
          if (contactId && o.contactId !== contactId) return false;
          if (stage && o.stage !== stage) return false;
          return true;
        });
        return { items: items.map((o) => ({ ...o })), count: items.length };
      }
      case 'opportunity.create': {
        const id = `ghl_opp_${randomUUID().slice(0, 8)}`;
        const opp: CrmOpportunity = {
          id,
          contactId: str(payload['contactId']),
          pipelineId: str(payload['pipelineId']) ?? 'pipe_default',
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
        const next: CrmOpportunity = {
          ...existing,
          name: str(payload['name']) ?? existing.name,
          stage: str(payload['stage']) ?? existing.stage,
          status: str(payload['status']) ?? existing.status,
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
      case 'pipeline.read': {
        const pipelineId = str(payload['pipelineId']);
        if (pipelineId) {
          const pipe = ws.pipelines.get(pipelineId);
          if (!pipe) throw new Error(`pipeline not found: ${pipelineId}`);
          return { ...pipe };
        }
        const items = [...ws.pipelines.values()].map((p) => ({ ...p }));
        return { items, count: items.length };
      }
      case 'conversation.read': {
        const conversationId = str(payload['conversationId']);
        if (conversationId) {
          const c = ws.conversations.get(conversationId);
          if (!c) throw new Error(`conversation not found: ${conversationId}`);
          return { ...c };
        }
        const contactId = str(payload['contactId']);
        const items = [...ws.conversations.values()].filter(
          (c) => !contactId || c.contactId === contactId,
        );
        return { items: items.map((c) => ({ ...c })), count: items.length };
      }
      case 'appointment.read': {
        const appointmentId = str(payload['appointmentId']);
        if (appointmentId) {
          const a = ws.appointments.get(appointmentId);
          if (!a) throw new Error(`appointment not found: ${appointmentId}`);
          return { ...a };
        }
        const contactId = str(payload['contactId']);
        const items = [...ws.appointments.values()].filter(
          (a) => !contactId || a.contactId === contactId,
        );
        return { items: items.map((a) => ({ ...a })), count: items.length };
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

      case 'conversation.send': {
        const id = `ghl_msg_${randomUUID().slice(0, 8)}`;
        const message = {
          id,
          contactId: str(payload['contactId']),
          conversationId: str(payload['conversationId']),
          body: str(payload['body']) ?? str(payload['message']) ?? '',
          status: 'sent',
        };
        ws.messages.set(id, message);
        return message;
      }
      case 'appointment.create': {
        const id = `ghl_appt_${randomUUID().slice(0, 8)}`;
        const appt = normalizeAppointment({
          id,
          contactId: str(payload['contactId']),
          title: str(payload['title']) ?? 'Appointment',
          startAt: str(payload['startAt']) ?? str(payload['startTime']),
          endAt: str(payload['endAt']) ?? str(payload['endTime']),
          status: 'booked',
          calendarId: str(payload['calendarId']),
        });
        ws.appointments.set(id, appt);
        return { ...appt };
      }
      default: {
        const _exhaustive: never = action;
        throw new Error(`unsupported action: ${_exhaustive}`);
      }
    }
  }
}

function seedWorkspace(ws: Workspace, tenantId: string): void {
  const contactId = 'ghl_contact_seed';
  ws.contacts.set(
    contactId,
    normalizeContact({
      id: contactId,
      email: `seed@${tenantId}.example`,
      firstName: 'Seed',
      lastName: 'Contact',
      tags: ['seed'],
      fields: { tenantId },
    }),
  );
  const pipelineId = 'pipe_default';
  ws.pipelines.set(
    pipelineId,
    normalizePipeline({
      id: pipelineId,
      name: 'Default Pipeline',
      stages: [
        { id: 'new', name: 'New', position: 0 },
        { id: 'qualified', name: 'Qualified', position: 1 },
        { id: 'appointment', name: 'Appointment', position: 2 },
        { id: 'won', name: 'Won', position: 3 },
      ],
    }),
  );
  const oppId = 'ghl_opp_seed';
  ws.opportunities.set(
    oppId,
    normalizeOpportunity({
      id: oppId,
      contactId,
      pipelineId,
      name: 'Seed opportunity',
      stage: 'new',
      value: 1000,
    }),
  );
  ws.conversations.set(
    'ghl_conv_seed',
    normalizeConversation({
      id: 'ghl_conv_seed',
      contactId,
      channel: 'sms',
      lastMessageBody: 'Thanks for reaching out',
      lastMessageAt: '2026-09-01T12:00:00.000Z',
      unreadCount: 0,
    }),
  );
  ws.appointments.set(
    'ghl_appt_seed',
    normalizeAppointment({
      id: 'ghl_appt_seed',
      contactId,
      title: 'Discovery call',
      startAt: '2026-09-10T15:00:00.000Z',
      endAt: '2026-09-10T15:30:00.000Z',
      status: 'booked',
      calendarId: 'cal_default',
    }),
  );
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Process-wide fake used by defaultAdapters / proofs (swap for live later). */
export const sharedFakeGhlBackend = new FakeGhlBackend();
