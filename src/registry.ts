/**
 * Agent Identity Registry management path (AIO-44 / SIS-AG-02).
 *
 * Runtime owns the HTTP surface; Core owns contracts + completeness /
 * governance-review helpers; Data persists registry columns on `actors`.
 */
import type { IncomingMessage } from 'node:http';
import {
  Actor,
  type AgentActor,
  registryCompleteness,
  toAgentRegistryRecord,
  reviewAgentRegistry,
  type RevocationState,
} from '@aion/core';
import type { ControlPlane } from './control-plane.js';
import type { Principal } from './auth/types.js';
import {
  assertPrincipalTenantAccess,
  principalHasRole,
} from './auth/authenticate.js';
export interface RegistryGatewayResponse {
  status: number;
  body: unknown;
}

function jsonError(
  status: number,
  code: string,
  message: string,
): RegistryGatewayResponse {
  return { status, body: { error: { code, message } } };
}

function callerTenantId(req: IncomingMessage): string | undefined {
  const raw = req.headers['x-aion-tenant-id'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asAgent(actor: Actor): AgentActor | undefined {
  return actor.actorType === 'agent' ? (actor as AgentActor) : undefined;
}

async function listAgentsForTenant(
  cp: ControlPlane,
  tenantId: string | undefined,
): Promise<AgentActor[]> {
  const actors = await cp.dataLayer.actors.list();
  return actors.filter((a): a is AgentActor => {
    if (a.actorType !== 'agent') return false;
    if (!tenantId) return true;
    return a.tenantId === tenantId;
  });
}

function registryView(agent: AgentActor) {
  const completeness = registryCompleteness(agent);
  return {
    agent,
    completeness,
    record: completeness.ok ? toAgentRegistryRecord(agent) : null,
  };
}

export async function listRegistryAgents(
  cp: ControlPlane,
  req: IncomingMessage,
  principal: Principal | null,
): Promise<RegistryGatewayResponse> {
  const tenantId = callerTenantId(req);
  const denied = assertPrincipalTenantAccess(principal, tenantId, {
    requireTenant: cp.auth.mode === 'required',
  });
  if (denied) {
    return {
      status: denied.status,
      body: { error: { code: denied.code, message: denied.message } },
    };
  }
  const agents = await listAgentsForTenant(cp, tenantId);
  const items = agents.map(registryView);
  return {
    status: 200,
    body: {
      agents: items,
      count: items.length,
      completeCount: items.filter((i) => i.completeness.ok).length,
      incompleteCount: items.filter((i) => !i.completeness.ok).length,
    },
  };
}

export async function getRegistryAgent(
  actorId: string,
  cp: ControlPlane,
  req: IncomingMessage,
  principal: Principal | null,
): Promise<RegistryGatewayResponse> {
  const tenantId = callerTenantId(req);
  const denied = assertPrincipalTenantAccess(principal, tenantId, {
    requireTenant: cp.auth.mode === 'required',
  });
  if (denied) {
    return {
      status: denied.status,
      body: { error: { code: denied.code, message: denied.message } },
    };
  }
  const actor = await cp.dataLayer.actors.get(actorId as never);
  const agent = actor ? asAgent(actor) : undefined;
  if (!agent) {
    return jsonError(404, 'agent_not_found', `agent ${actorId} not in registry`);
  }
  if (tenantId && agent.tenantId !== tenantId) {
    return jsonError(
      403,
      'tenant_isolation_denied',
      `caller tenant ${tenantId} cannot read agent ${actorId}`,
    );
  }
  return { status: 200, body: registryView(agent) };
}

export async function upsertRegistryAgent(
  body: unknown,
  cp: ControlPlane,
  req: IncomingMessage,
  principal: Principal | null,
): Promise<RegistryGatewayResponse> {
  if (cp.auth.mode === 'required') {
    if (!principal || !principalHasRole(principal, 'register')) {
      return jsonError(
        403,
        'register_forbidden',
        'register role required to upsert Agent Identity Registry entries',
      );
    }
  }
  const parsed = Actor.safeParse(body);
  if (!parsed.success) {
    return jsonError(400, 'invalid_actor', 'body must satisfy the Core Actor contract');
  }
  const agent = asAgent(parsed.data);
  if (!agent) {
    return jsonError(400, 'not_an_agent', 'registry only accepts actorType=agent');
  }
  const tenantId = callerTenantId(req) ?? agent.tenantId;
  const denied = assertPrincipalTenantAccess(principal, tenantId, {
    requireTenant: cp.auth.mode === 'required',
  });
  if (denied) {
    return {
      status: denied.status,
      body: { error: { code: denied.code, message: denied.message } },
    };
  }
  if (tenantId && agent.tenantId && agent.tenantId !== tenantId) {
    return jsonError(
      403,
      'tenant_forbidden',
      'agent.tenantId must match x-aion-tenant-id',
    );
  }
  const toSave: AgentActor = {
    ...agent,
    ...(tenantId && !agent.tenantId ? { tenantId } : {}),
    revocationState: agent.revocationState ?? 'active',
    lastActivity: new Date().toISOString(),
  };
  await cp.dataLayer.actors.save(toSave);
  return { status: 200, body: registryView(toSave) };
}

async function setRevocationState(
  actorId: string,
  state: RevocationState,
  cp: ControlPlane,
  req: IncomingMessage,
  principal: Principal | null,
): Promise<RegistryGatewayResponse> {
  if (cp.auth.mode === 'required') {
    if (!principal || !principalHasRole(principal, 'register')) {
      return jsonError(
        403,
        'register_forbidden',
        'register role required to change revocation_state',
      );
    }
  }
  const tenantId = callerTenantId(req);
  const denied = assertPrincipalTenantAccess(principal, tenantId, {
    requireTenant: cp.auth.mode === 'required',
  });
  if (denied) {
    return {
      status: denied.status,
      body: { error: { code: denied.code, message: denied.message } },
    };
  }
  const actor = await cp.dataLayer.actors.get(actorId as never);
  const agent = actor ? asAgent(actor) : undefined;
  if (!agent) {
    return jsonError(404, 'agent_not_found', `agent ${actorId} not in registry`);
  }
  if (tenantId && agent.tenantId !== tenantId) {
    return jsonError(
      403,
      'tenant_isolation_denied',
      `caller tenant ${tenantId} cannot modify agent ${actorId}`,
    );
  }
  const updated: AgentActor = {
    ...agent,
    revocationState: state,
    lastActivity: new Date().toISOString(),
  };
  await cp.dataLayer.actors.save(updated);
  return { status: 200, body: registryView(updated) };
}

export function revokeRegistryAgent(
  actorId: string,
  cp: ControlPlane,
  req: IncomingMessage,
  principal: Principal | null,
): Promise<RegistryGatewayResponse> {
  return setRevocationState(actorId, 'revoked', cp, req, principal);
}

export function suspendRegistryAgent(
  actorId: string,
  cp: ControlPlane,
  req: IncomingMessage,
  principal: Principal | null,
): Promise<RegistryGatewayResponse> {
  return setRevocationState(actorId, 'suspended', cp, req, principal);
}

export function reactivateRegistryAgent(
  actorId: string,
  cp: ControlPlane,
  req: IncomingMessage,
  principal: Principal | null,
): Promise<RegistryGatewayResponse> {
  return setRevocationState(actorId, 'active', cp, req, principal);
}

export async function reviewRegistry(
  cp: ControlPlane,
  req: IncomingMessage,
  principal: Principal | null,
  url: string,
): Promise<RegistryGatewayResponse> {
  const tenantId = callerTenantId(req);
  const denied = assertPrincipalTenantAccess(principal, tenantId, {
    requireTenant: cp.auth.mode === 'required',
  });
  if (denied) {
    return {
      status: denied.status,
      body: { error: { code: denied.code, message: denied.message } },
    };
  }
  const agents = await listAgentsForTenant(cp, tenantId);
  const params = new URL(url, 'http://localhost').searchParams;
  const observedParam = params.get('observed');
  const observedAgentIds = observedParam
    ? observedParam.split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  // Recent execution agent URIs count as observed (SIS-AG-10 orphan detection).
  if (tenantId) {
    const recent = await cp.dataLayer.executions.listRecentForTenant(tenantId, 200);
    for (const exe of recent) {
      if (exe.agentUri) observedAgentIds.push(exe.agentUri);
    }
  }

  const review = reviewAgentRegistry({
    registered: agents,
    observedAgentIds: [...new Set(observedAgentIds)],
  });
  return { status: 200, body: review };
}

export async function exportRegistryInventory(
  cp: ControlPlane,
  req: IncomingMessage,
  principal: Principal | null,
): Promise<RegistryGatewayResponse> {
  const tenantId = callerTenantId(req);
  const denied = assertPrincipalTenantAccess(principal, tenantId, {
    requireTenant: cp.auth.mode === 'required',
  });
  if (denied) {
    return {
      status: denied.status,
      body: { error: { code: denied.code, message: denied.message } },
    };
  }
  const agents = await listAgentsForTenant(cp, tenantId);
  const complete = [];
  const incomplete = [];
  for (const agent of agents) {
    const completeness = registryCompleteness(agent);
    if (completeness.ok) {
      complete.push(toAgentRegistryRecord(agent));
    } else {
      incomplete.push({
        actorId: agent.actorId,
        agentId: agent.agentUri ?? agent.agentId,
        missing: completeness.missing,
        detail: completeness.detail,
      });
    }
  }
  return {
    status: 200,
    body: {
      standard: 'SIS-AG-02',
      exportedAt: new Date().toISOString(),
      tenantId: tenantId ?? null,
      records: complete,
      incomplete,
      count: complete.length,
      incompleteCount: incomplete.length,
    },
  };
}
