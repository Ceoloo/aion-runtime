/**
 * Provider-neutral CRM backend port — Runtime-only (ADR-019 / CRM-001).
 *
 * Agents never call a CRM vendor directly. Adapters invoke this port after
 * identity, tenant, permission, risk, autonomy, approval, and budget checks.
 *
 * Implementations: GHL (migration SoE), Twenty (primary SoE), fake stand-ins.
 */

export type CrmMutationKind =
  | 'contact.read'
  | 'contact.search'
  | 'contact.enrich'
  | 'contact.update'
  | 'opportunity.read'
  | 'opportunity.search'
  | 'opportunity.create'
  | 'opportunity.update'
  | 'pipeline.read'
  | 'conversation.read'
  | 'conversation.send'
  | 'appointment.read'
  | 'appointment.create'
  | 'note.create'
  | 'task.create'
  | 'message.draft'
  | 'message.send';

export interface CrmBackendRequest {
  tenantId: string;
  /** CRM workspace id within the tenant (defaults to tenantId). */
  workspaceId?: string;
  /** Provider location / workspace id when known (e.g. GHL location). */
  locationId?: string;
  action: CrmMutationKind;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}

export interface CrmBackendSuccess {
  ok: true;
  externalResourceId: string;
  externalRequestId: string;
  body: Record<string, unknown>;
}

export interface CrmBackendFailure {
  ok: false;
  errorCode: string;
  errorMessage: string;
  retryable?: boolean;
}

export type CrmBackendResult = CrmBackendSuccess | CrmBackendFailure;

export interface CrmBackend {
  readonly name: string;
  execute(request: CrmBackendRequest): Promise<CrmBackendResult>;
  /** Test / proof helper — count successful mutations for a tenant. */
  mutationCount?(tenantId: string): number;
  /** Test / proof helper — inject next failure (rate limit, timeout, …). */
  injectFailure?(failure: CrmBackendFailure): void;
}

export function isCrmReadAction(action: CrmMutationKind): boolean {
  return (
    action.endsWith('.read') ||
    action === 'contact.search' ||
    action === 'opportunity.search'
  );
}
