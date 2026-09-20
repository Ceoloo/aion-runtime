/**
 * GoHighLevel / CRM backend port — Runtime-only.
 *
 * Agents never call GHL directly. Adapters invoke this port after identity,
 * tenant, permission, risk, autonomy, approval, and budget checks.
 */

export type GhlMutationKind =
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

export interface GhlBackendRequest {
  tenantId: string;
  /** CRM workspace id within the tenant (defaults to tenantId). */
  workspaceId?: string;
  /** Provider location id when known (live GHL). */
  locationId?: string;
  action: GhlMutationKind;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}

export interface GhlBackendSuccess {
  ok: true;
  externalResourceId: string;
  externalRequestId: string;
  body: Record<string, unknown>;
}

export interface GhlBackendFailure {
  ok: false;
  errorCode: string;
  errorMessage: string;
  retryable?: boolean;
}

export type GhlBackendResult = GhlBackendSuccess | GhlBackendFailure;

export interface GhlBackend {
  readonly name: string;
  execute(request: GhlBackendRequest): Promise<GhlBackendResult>;
  /** Test / proof helper — count successful mutations for a tenant. */
  mutationCount?(tenantId: string): number;
  /** Test / proof helper — inject next failure (rate limit, timeout, …). */
  injectFailure?(failure: GhlBackendFailure): void;
}

export function isGhlReadAction(action: GhlMutationKind): boolean {
  return (
    action.endsWith('.read') ||
    action === 'contact.search' ||
    action === 'opportunity.search'
  );
}
