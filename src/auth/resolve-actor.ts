/**
 * Resolve the durable Actor used for authorization.
 *
 * Rules:
 * - Body-supplied permissions / tenant / risk ceiling are never authority when
 *   a durable Actor already exists — Data wins.
 * - In auth mode=required, the Principal's actorId must match the command actor,
 *   and unregistered actors may only be created by principals with `register`.
 * - In auth mode=open (local proofs), first registration from the body is
 *   allowed; subsequent calls cannot escalate grants via the body.
 */
import type { Actor, AgentActor } from '@aion/core';
import type { ControlPlane } from '../control-plane.js';
import type { AuthMode, Principal } from './types.js';
import type { AuthDenied } from './authenticate.js';
import { principalHasRole } from './authenticate.js';

export type ResolveActorResult =
  | { ok: true; actor: Actor; registered: boolean }
  | AuthDenied;

function asAgent(actor: Actor): AgentActor | undefined {
  return actor.actorType === 'agent' ? (actor as AgentActor) : undefined;
}

export async function resolveDurableActor(
  cp: ControlPlane,
  claimed: Actor,
  principal: Principal | null,
  mode: AuthMode,
): Promise<ResolveActorResult> {
  if (mode === 'required') {
    if (!principal) {
      return {
        ok: false,
        status: 401,
        code: 'auth_required',
        message: 'authenticated principal is required to resolve actors',
      };
    }
    if (claimed.actorId !== principal.actorId) {
      return {
        ok: false,
        status: 403,
        code: 'actor_forbidden',
        message: `principal ${principal.principalId} cannot act as actor ${claimed.actorId}`,
      };
    }
    if (
      !principalHasRole(principal, 'invoke') &&
      !principalHasRole(principal, 'register')
    ) {
      return {
        ok: false,
        status: 403,
        code: 'actor_forbidden',
        message: `principal ${principal.principalId} lacks invoke role`,
      };
    }
    const agent = asAgent(claimed);
    if (agent?.tenantId && !principal.tenantIds.includes(agent.tenantId)) {
      return {
        ok: false,
        status: 403,
        code: 'tenant_forbidden',
        message: `principal ${principal.principalId} cannot use agent tenant ${agent.tenantId}`,
      };
    }
  }

  const existing = await cp.dataLayer.actors.get(claimed.actorId);
  if (existing) {
    // Durable grants win — body cannot escalate permissions/tenant/risk.
    return { ok: true, actor: existing, registered: false };
  }

  if (mode === 'required') {
    if (!principal || !principalHasRole(principal, 'register')) {
      return {
        ok: false,
        status: 403,
        code: principal ? 'register_forbidden' : 'actor_not_registered',
        message: `actor ${claimed.actorId} is not registered; principal lacks register role`,
      };
    }
  }

  await cp.dataLayer.actors.save(claimed);
  return { ok: true, actor: claimed, registered: true };
}

export async function resolveApproverActor(
  cp: ControlPlane,
  decidedBy: string,
  claimedActor: Actor | undefined,
  principal: Principal | null,
  mode: AuthMode,
): Promise<ResolveActorResult> {
  if (mode === 'required') {
    if (!principal) {
      return {
        ok: false,
        status: 401,
        code: 'auth_required',
        message: 'authenticated principal is required to decide approvals',
      };
    }
    if (!principalHasRole(principal, 'approve')) {
      return {
        ok: false,
        status: 403,
        code: 'approve_forbidden',
        message: `principal ${principal.principalId} lacks approve role`,
      };
    }
    if (decidedBy !== principal.actorId) {
      return {
        ok: false,
        status: 403,
        code: 'approver_mismatch',
        message: `decidedBy ${decidedBy} must match authenticated principal actor ${principal.actorId}`,
      };
    }
  }

  const existing = await cp.dataLayer.actors.get(decidedBy as never);
  if (existing) {
    if (existing.actorType !== 'human') {
      return {
        ok: false,
        status: 403,
        code: 'approver_not_human',
        message: `approver ${decidedBy} must be a human actor (got ${existing.actorType})`,
      };
    }
    return { ok: true, actor: existing, registered: false };
  }

  if (!claimedActor) {
    return {
      ok: false,
      status: 403,
      code: 'actor_not_registered',
      message: `approver actor ${decidedBy} is not registered`,
    };
  }
  if (claimedActor.actorId !== decidedBy) {
    return {
      ok: false,
      status: 403,
      code: 'approver_mismatch',
      message: 'actor.actorId must match decidedBy',
    };
  }
  if (claimedActor.actorType !== 'human') {
    return {
      ok: false,
      status: 403,
      code: 'approver_not_human',
      message: 'approver actor must have actorType human',
    };
  }

  if (
    mode === 'required' &&
    principal &&
    !principalHasRole(principal, 'register')
  ) {
    return {
      ok: false,
      status: 403,
      code: 'register_forbidden',
      message: `approver ${decidedBy} is not registered; principal lacks register role`,
    };
  }

  await cp.dataLayer.actors.save(claimedActor);
  return { ok: true, actor: claimedActor, registered: true };
}
