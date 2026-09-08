/**
 * Normalized CRM entity shapes returned by GhlBackend bodies.
 * Live and fake backends both produce these so proofs / products stay stable.
 */

export interface CrmContact {
  id: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  tags: string[];
  fields: Record<string, unknown>;
}

export interface CrmOpportunity {
  id: string;
  contactId?: string;
  pipelineId?: string;
  name: string;
  stage: string;
  status?: string;
  value?: number;
  fields: Record<string, unknown>;
}

export interface CrmPipelineStage {
  id: string;
  name: string;
  position?: number;
}

export interface CrmPipeline {
  id: string;
  name: string;
  stages: CrmPipelineStage[];
}

export interface CrmConversation {
  id: string;
  contactId?: string;
  channel?: string;
  lastMessageBody?: string;
  lastMessageAt?: string;
  unreadCount?: number;
}

export interface CrmAppointment {
  id: string;
  contactId?: string;
  title: string;
  startAt?: string;
  endAt?: string;
  status?: string;
  calendarId?: string;
}

export function normalizeContact(raw: Record<string, unknown>): CrmContact {
  return {
    id: String(raw['id'] ?? ''),
    email: optionalString(raw['email']),
    firstName: optionalString(raw['firstName'] ?? raw['first_name']),
    lastName: optionalString(raw['lastName'] ?? raw['last_name']),
    phone: optionalString(raw['phone']),
    tags: Array.isArray(raw['tags']) ? (raw['tags'] as string[]) : [],
    fields:
      raw['fields'] && typeof raw['fields'] === 'object' && !Array.isArray(raw['fields'])
        ? (raw['fields'] as Record<string, unknown>)
        : {},
  };
}

export function normalizeOpportunity(raw: Record<string, unknown>): CrmOpportunity {
  return {
    id: String(raw['id'] ?? ''),
    contactId: optionalString(raw['contactId'] ?? raw['contact_id']),
    pipelineId: optionalString(raw['pipelineId'] ?? raw['pipeline_id']),
    name: String(raw['name'] ?? 'Untitled opportunity'),
    stage: String(raw['stage'] ?? raw['pipelineStageId'] ?? 'unknown'),
    status: optionalString(raw['status']),
    value: typeof raw['value'] === 'number' ? raw['value'] : undefined,
    fields:
      raw['fields'] && typeof raw['fields'] === 'object' && !Array.isArray(raw['fields'])
        ? (raw['fields'] as Record<string, unknown>)
        : {},
  };
}

export function normalizePipeline(raw: Record<string, unknown>): CrmPipeline {
  const stagesRaw = Array.isArray(raw['stages']) ? raw['stages'] : [];
  return {
    id: String(raw['id'] ?? ''),
    name: String(raw['name'] ?? 'Pipeline'),
    stages: stagesRaw.map((s, i) => {
      const stage = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
      return {
        id: String(stage['id'] ?? `stage_${i}`),
        name: String(stage['name'] ?? `Stage ${i + 1}`),
        position: typeof stage['position'] === 'number' ? stage['position'] : i,
      };
    }),
  };
}

export function normalizeConversation(raw: Record<string, unknown>): CrmConversation {
  return {
    id: String(raw['id'] ?? ''),
    contactId: optionalString(raw['contactId'] ?? raw['contact_id']),
    channel: optionalString(raw['channel'] ?? raw['type']),
    lastMessageBody: optionalString(raw['lastMessageBody'] ?? raw['last_message_body']),
    lastMessageAt: optionalString(raw['lastMessageAt'] ?? raw['last_message_date']),
    unreadCount: typeof raw['unreadCount'] === 'number' ? raw['unreadCount'] : undefined,
  };
}

export function normalizeAppointment(raw: Record<string, unknown>): CrmAppointment {
  return {
    id: String(raw['id'] ?? ''),
    contactId: optionalString(raw['contactId'] ?? raw['contact_id']),
    title: String(raw['title'] ?? raw['name'] ?? 'Appointment'),
    startAt: optionalString(raw['startAt'] ?? raw['startTime'] ?? raw['start_time']),
    endAt: optionalString(raw['endAt'] ?? raw['endTime'] ?? raw['end_time']),
    status: optionalString(raw['status']),
    calendarId: optionalString(raw['calendarId'] ?? raw['calendar_id']),
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
