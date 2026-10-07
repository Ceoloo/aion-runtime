/**
 * Continuous Assurance gateway connectors (AIO-47 / SIS-CA-*).
 *
 * Runtime owns the HTTP surface; Core owns the check catalog, evidence schema,
 * and prototype evaluators (CA-AG-*, CA-RT-01, CA-RV-02). Non-prototype catalog
 * checks return `unknown` until external connectors are wired.
 *
 * Spec: aion-docs/architecture/continuous-assurance-v1.md §7
 */
import type { IncomingMessage } from 'node:http';
import {
  ASSURANCE_CHECK_CATALOG,
  AssuranceCheckId,
  type AgentActor,
  type AssuranceEvidence,
  type AssuranceRunResult,
  runAssuranceChecks,
} from '@aion/core';
import type { ControlPlane } from './control-plane.js';
import type { Principal } from './auth/types.js';
import { assertPrincipalTenantAccess } from './auth/authenticate.js';

export interface AssuranceGatewayResponse {
  status: number;
  body: unknown;
}

/** Process-local evidence index for the AIO-47 prototype (not multi-tenant durable). */
const evidenceByTenant = new Map<string, AssuranceEvidence[]>();
const MAX_EVIDENCE_PER_TENANT = 500;

function jsonError(
  status: number,
  code: string,
  message: string,
): AssuranceGatewayResponse {
  return { status, body: { error: { code, message } } };
}

function callerTenantId(req: IncomingMessage): string | undefined {
  const raw = req.headers['x-aion-tenant-id'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asAgent(actor: { actorType: string }): actor is AgentActor {
  return actor.actorType === 'agent';
}

function rememberEvidence(tenantId: string, evidence: AssuranceEvidence[]): void {
  const prev = evidenceByTenant.get(tenantId) ?? [];
  const next = [...evidence, ...prev].slice(0, MAX_EVIDENCE_PER_TENANT);
  evidenceByTenant.set(tenantId, next);
}

/** Test helper — clear process-local evidence store. */
export function clearAssuranceEvidenceStore(): void {
  evidenceByTenant.clear();
}

export async function getAssuranceCatalog(): Promise<AssuranceGatewayResponse> {
  return {
    status: 200,
    body: {
      standard: 'SIS-CA-01',
      catalog: ASSURANCE_CHECK_CATALOG,
      prototypeCheckIds: ASSURANCE_CHECK_CATALOG.filter((c) => c.prototype).map(
        (c) => c.checkId,
      ),
      count: ASSURANCE_CHECK_CATALOG.length,
    },
  };
}

export async function listAssuranceEvidence(
  cp: ControlPlane,
  req: IncomingMessage,
  principal: Principal | null,
  url: string,
): Promise<AssuranceGatewayResponse> {
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
  if (!tenantId) {
    return jsonError(400, 'tenant_required', 'x-aion-tenant-id required');
  }
  const params = new URL(url, 'http://localhost').searchParams;
  const statusFilter = params.get('status');
  const checkFilter = params.get('checkId');
  let items = evidenceByTenant.get(tenantId) ?? [];
  if (statusFilter) {
    items = items.filter((e) => e.status === statusFilter);
  }
  if (checkFilter) {
    items = items.filter((e) => e.checkId === checkFilter);
  }
  return {
    status: 200,
    body: {
      tenantId,
      evidence: items,
      count: items.length,
    },
  };
}

export async function runAssurance(
  body: unknown,
  cp: ControlPlane,
  req: IncomingMessage,
  principal: Principal | null,
): Promise<AssuranceGatewayResponse> {
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
  if (!tenantId) {
    return jsonError(400, 'tenant_required', 'x-aion-tenant-id required');
  }

  const payload =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};

  let checkIds: AssuranceCheckId[] | undefined;
  if (Array.isArray(payload.checkIds)) {
    const parsed: AssuranceCheckId[] = [];
    for (const raw of payload.checkIds) {
      const result = AssuranceCheckId.safeParse(raw);
      if (!result.success) {
        return jsonError(
          400,
          'invalid_check_id',
          `unknown checkId: ${String(raw)}`,
        );
      }
      parsed.push(result.data);
    }
    checkIds = parsed;
  }

  const observedFromBody = Array.isArray(payload.observedAgentIds)
    ? payload.observedAgentIds.filter((v): v is string => typeof v === 'string')
    : [];

  const actors = await cp.dataLayer.actors.list();
  const registered = actors.filter(
    (a): a is AgentActor => asAgent(a) && a.tenantId === tenantId,
  );

  const recent = await cp.dataLayer.executions.listRecentForTenant(tenantId, 200);
  const observedAgentIds = [
    ...new Set([
      ...observedFromBody,
      ...recent
        .map((e) => e.agentUri)
        .filter((u): u is string => typeof u === 'string' && u.length > 0),
    ]),
  ];

  const recentDenyCount = recent.filter((e) => e.status === 'denied').length;
  const recentExecutionCount = recent.length;

  let runtimeHealthy = true;
  try {
    await cp.checkDatabase();
  } catch {
    runtimeHealthy = false;
  }
  // Partial CA-RT-01: Core Orchestrator kill-switch path is compiled in;
  // Runtime does not yet bind a live FeatureGate provider on ControlPlane.
  const killSwitchAvailable =
    typeof payload.killSwitchAvailable === 'boolean'
      ? payload.killSwitchAvailable
      : true;
  if (typeof payload.runtimeHealthy === 'boolean') {
    runtimeHealthy = payload.runtimeHealthy;
  }

  const result: AssuranceRunResult = runAssuranceChecks({
    tenantId,
    registered,
    observedAgentIds,
    recentExecutions: recent,
    runtimeHealthy,
    killSwitchAvailable,
    recentDenyCount,
    recentExecutionCount,
    ...(checkIds ? { checkIds } : {}),
    ...(typeof payload.now === 'string' ? { now: payload.now } : {}),
  });

  rememberEvidence(tenantId, result.evidence);

  return {
    status: 200,
    body: {
      ...result,
      connectors: {
        registry: 'aion-runtime /v1/registry/*',
        executions: 'executions.listRecentForTenant',
        runtimeHealth: 'ControlPlane.checkDatabase',
        killSwitch: 'Core Orchestrator FeatureGate path (partial)',
      },
    },
  };
}
