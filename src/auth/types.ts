/**
 * Runtime identity plane — principal model.
 *
 * A Principal is what Authentication establishes (who holds the credential).
 * An Actor is what Authorization evaluates (what grants are durable in Data).
 * Callers must never self-assert grants; Runtime loads Actors from Data after
 * binding the request to a Principal (aion-docs security-model / permissions).
 */

export type AuthMode = 'open' | 'required';

export type PrincipalKind = 'operator' | 'service' | 'agent-worker';

export type PrincipalRole = 'invoke' | 'approve' | 'register';

export interface Principal {
  /** Stable id for audit (not the bearer token). */
  principalId: string;
  kind: PrincipalKind;
  /** Durable Actor this credential is bound to (authority subject). */
  actorId: string;
  /** Tenants this principal may operate in (header must be ⊆ this set). */
  tenantIds: string[];
  /** Least-privilege roles for gateway operations. */
  roles: PrincipalRole[];
}

export interface ApiKeyRecord {
  /** Raw bearer token value (compared with timing-safe equality). */
  token: string;
  principal: Principal;
}

export interface GatewayAuthConfig {
  mode: AuthMode;
  apiKeys: ApiKeyRecord[];
}

export type AuthFailureCode =
  | 'auth_required'
  | 'auth_invalid'
  | 'tenant_forbidden'
  | 'actor_forbidden'
  | 'actor_not_registered'
  | 'register_forbidden'
  | 'approve_forbidden'
  | 'approver_mismatch'
  | 'approver_not_human';
