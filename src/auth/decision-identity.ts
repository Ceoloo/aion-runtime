/**
 * Approval-decision identity — derived on the server from the authenticated Principal.
 *
 * Chain: bearer token → Principal (authn) → the durable human Actor bound to that principal (`principal.actorId`)
 * → `approvals.decided_by`. Nothing the client sends is authority:
 * - In auth mode=required, `decidedBy` is DERIVED from `principal.actorId`. A body `decidedBy` (or `actor.actorId`)
 *   is accepted only if it equals the derived id; anything else is denied, never trusted or registered.
 * - The approver must already be a registered HUMAN actor (registered out of band, not from the request body).
 * - The approval must belong to a tenant the principal is bound to (and to the request's tenant header, if sent).
 *   A principal in tenant A cannot decide tenant B's approval, and an approval whose tenant cannot be determined is denied.
 * - mode=open (local proofs only): legacy behaviour is unchanged — the body identifies the approver.
 *
 * NOTE: a Principal identifies a credential holder. When one operator token is shared, `decided_by` names that
 * operator ACCOUNT, not a uniquely authenticated person.
 */
import type { Actor, ApprovalRequest } from '@aion/core';
import type { ControlPlane } from '../control-plane.js';
import type { AuthMode, Principal } from './types.js';
import type { AuthDenied } from './authenticate.js';
import { assertPrincipalTenantAccess, principalHasRole } from './authenticate.js';

export interface DecisionIdentity {
  ok: true;
  /** The actor id to persist as approvals.decided_by. */
  decidedBy: string;
  actor: Actor;
  /** Present when auth is required (absent for open-mode local proofs). */
  principal: Principal | null;
  /** 'derived' = from the authenticated principal; 'claimed' = open-mode body (legacy, local only). */
  identitySource: 'derived' | 'claimed';
}

export type DecisionIdentityResult = DecisionIdentity | AuthDenied;

const deny = (status: 401 | 403, code: AuthDenied['code'], message: string): AuthDenied => ({
  ok: false,
  status,
  code,
  message,
});

/** Tenant that owns the approval: the row's own tenant, else the tenant of its execution, else the command's. */
export async function approvalTenantId(
  cp: ControlPlane,
  approval: ApprovalRequest,
): Promise<string | undefined> {
  if (approval.tenantId) return approval.tenantId;
  const execution = await cp.dataLayer.executions.getByRunId(approval.runId);
  if (execution?.tenantId) return execution.tenantId;
  return (approval.command as { tenantId?: string }).tenantId ?? undefined;
}

export async function resolveDecisionIdentity(
  cp: ControlPlane,
  input: {
    approvalId: string;
    bodyDecidedBy: unknown;
    bodyActor: Actor | undefined;
    tenantHeader: string | undefined;
  },
  principal: Principal | null,
  mode: AuthMode,
  legacyOpenResolver: () => Promise<DecisionIdentityResult>,
): Promise<DecisionIdentityResult> {
  if (mode !== 'required') return legacyOpenResolver();

  if (!principal) {
    return deny(401, 'auth_required', 'authenticated principal is required to decide approvals');
  }
  if (!principalHasRole(principal, 'approve')) {
    return deny(403, 'approve_forbidden', `principal ${principal.principalId} lacks approve role`);
  }
  const derived = principal.actorId;

  // Client-supplied identity may only restate the derived one.
  if (input.bodyDecidedBy !== undefined && input.bodyDecidedBy !== derived) {
    return deny(
      403,
      'approver_mismatch',
      `decidedBy is derived from the authenticated principal (${derived}); a different value was supplied`,
    );
  }
  if (input.bodyActor && input.bodyActor.actorId !== derived) {
    return deny(403, 'approver_mismatch', 'actor.actorId does not match the authenticated principal actor');
  }

  const tenantDenied = assertPrincipalTenantAccess(principal, input.tenantHeader, { requireTenant: true });
  if (tenantDenied) return tenantDenied;

  const approval = await cp.dataLayer.approvals.get(input.approvalId as never);
  if (approval) {
    const owner = await approvalTenantId(cp, approval);
    if (!owner || !principal.tenantIds.includes(owner) || owner !== input.tenantHeader) {
      return deny(
        403,
        'tenant_forbidden',
        `principal ${principal.principalId} cannot decide this approval (tenant not authorised or not determinable)`,
      );
    }
  }
  // (An unknown approval id falls through: the orchestrator answers 404 exactly as before.)

  const actor = await cp.dataLayer.actors.get(derived as never);
  if (!actor) {
    return deny(
      403,
      'actor_not_registered',
      `approver actor ${derived} is not registered; register the operator actor out of band (it is never created from a request)`,
    );
  }
  if (actor.actorType !== 'human') {
    return deny(403, 'approver_not_human', `approver ${derived} must be a human actor (got ${actor.actorType})`);
  }
  return { ok: true, decidedBy: derived, actor, principal, identitySource: 'derived' };
}
