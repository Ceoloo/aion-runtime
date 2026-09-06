/**
 * Execution Gateway — reconciled into aion-runtime (NOT a second gateway).
 *
 * Earlier multi-provider gateway concepts (routing, approvals, cost/latency/
 * outcome logging) become this HTTP surface on the Runtime host. Products and
 * external workers submit work here; Core decides; Data persists; adapters
 * execute. See Notion Progress Assessment (Sep 2026): "reconcile into Runtime,
 * do not rebuild."
 *
 * Routes:
 *   POST /v1/commands                     — submit governed work
 *                                         (capability or serviceKey)
 *   POST /v1/missions/run                 — Mission 004 multi-step orchestration
 *   GET  /v1/missions                     — Mission 006 tenant mission list
 *   GET  /v1/missions/:missionId          — Mission 006 mission detail (tenant-gated)
 *   GET  /v1/missions/:missionId/economics — Mission 005 economics rollup
 *   GET  /v1/economics                    — Mission 005 scope/holding rollup
 *   GET  /v1/runs/:runId                  — fetch run state
 *   GET  /v1/approvals                    — Mission 006 tenant approval queue
 *   POST /v1/approvals/:approvalId/decision — human gate decision
 *   GET  /v1/executions                   — Mission 006 recent tenant executions
 *   GET  /v1/executions/:executionId      — canonical Execution Object
 *   GET  /v1/executions/by-run/:runId     — Execution Object by run
 *   GET  /v1/executions/by-root/:rootId   — lineage tree under a root
 *   GET  /v1/services                     — list Service Catalog (?status=)
 *   GET  /v1/services/:serviceKey         — fetch one catalog service
 *   POST /v1/evaluations                  — Mission 007 record EvaluationResult
 *   GET  /v1/evaluations/:evaluationId    — Mission 007 fetch evaluation
 *   GET  /v1/executions/:id/evaluation    — Mission 007 evaluation by execution
 *   GET  /v1/scorecards                   — Mission 007 performance scorecards
 *   GET  /v1/routing/recommend            — Mission 007 recommendation-only route
 *   POST /v1/routing/override             — Mission 007 manual override (inspect/recommend)
 */
import type { IncomingMessage } from 'node:http';
import {
  Actor,
  ApprovalDecision,
  ApprovalStatus,
  AuthorizationRequest,
  Capability,
  EconomicsScopeDims,
  EvaluationId,
  EvaluationResult,
  ExecutionId,
  Mission,
  MissionId,
  RoutingOverride,
  ServiceKey,
  Workflow,
  createEvaluationResult,
  createExecutionObject,
  createMission,
  createWorkflow,
  isAionError,
  newCommandId,
  newCorrelationId,
  newRequestId,
  newRunId,
  recommendRoute,
  type AgentActor,
  type CommandInput,
  type RiskLevel,
  type Run,
} from '@aion/core';
import type { ControlPlane } from './control-plane.js';
import type { Logger } from './logger.js';

export interface GatewayResponse {
  status: number;
  body: unknown;
}

function jsonError(status: number, code: string, message: string): GatewayResponse {
  return { status, body: { error: code, message } };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw) as unknown;
}

/**
 * Handle an Execution Gateway request. Returns null when the path is not a
 * gateway route (caller should fall through to health/404).
 */
export async function handleGatewayRequest(
  method: string,
  url: string,
  req: IncomingMessage,
  cp: ControlPlane,
  logger: Logger,
): Promise<GatewayResponse | null> {
  const path = url.split('?')[0] ?? url;

  try {
    if (method === 'POST' && path === '/v1/commands') {
      return await submitCommand(await readJsonBody(req), cp, logger);
    }

    if (method === 'POST' && path === '/v1/missions/run') {
      return await runMission(await readJsonBody(req), cp, logger);
    }

    if (method === 'GET' && path === '/v1/missions') {
      return await listMissions(cp, req);
    }

    if (method === 'GET' && path === '/v1/economics') {
      return await getScopeEconomics(url, cp, req);
    }

    const missionEconomicsMatch = /^\/v1\/missions\/([^/]+)\/economics$/.exec(path);
    if (method === 'GET' && missionEconomicsMatch) {
      return await getMissionEconomics(
        decodeURIComponent(missionEconomicsMatch[1]!),
        cp,
        req,
      );
    }

    const missionMatch = /^\/v1\/missions\/([^/]+)$/.exec(path);
    if (method === 'GET' && missionMatch) {
      return await getMission(decodeURIComponent(missionMatch[1]!), cp, req);
    }

    if (method === 'GET' && path === '/v1/services') {
      const statusParam = new URL(url, 'http://localhost').searchParams.get('status');
      const status =
        statusParam === 'all' || statusParam === 'deprecated' || statusParam === 'active'
          ? statusParam
          : 'active';
      return await listServices(cp, status);
    }

    const serviceMatch = /^\/v1\/services\/([^/]+)$/.exec(path);
    if (method === 'GET' && serviceMatch) {
      return await getService(decodeURIComponent(serviceMatch[1]!), cp);
    }

    const runMatch = /^\/v1\/runs\/([^/]+)$/.exec(path);
    if (method === 'GET' && runMatch) {
      return await getRun(runMatch[1]!, cp);
    }

    if (method === 'GET' && path === '/v1/approvals') {
      return await listApprovals(url, cp, req);
    }

    const approvalMatch = /^\/v1\/approvals\/([^/]+)\/decision$/.exec(path);
    if (method === 'POST' && approvalMatch) {
      return await decideApproval(approvalMatch[1]!, await readJsonBody(req), cp, logger);
    }

    if (method === 'GET' && path === '/v1/executions') {
      return await listRecentExecutions(url, cp, req);
    }

    if (method === 'POST' && path === '/v1/evaluations') {
      return await createEvaluation(await readJsonBody(req), cp, req);
    }

    if (method === 'GET' && path === '/v1/scorecards') {
      return await getScorecards(url, cp, req);
    }

    if (method === 'GET' && path === '/v1/routing/recommend') {
      return await recommendRouting(url, cp, req);
    }

    if (method === 'POST' && path === '/v1/routing/override') {
      return await setRoutingOverride(await readJsonBody(req), cp, req);
    }

    const evaluationMatch = /^\/v1\/evaluations\/([^/]+)$/.exec(path);
    if (method === 'GET' && evaluationMatch) {
      return await getEvaluation(decodeURIComponent(evaluationMatch[1]!), cp, req);
    }

    const exeEvalMatch = /^\/v1\/executions\/([^/]+)\/evaluation$/.exec(path);
    if (method === 'GET' && exeEvalMatch) {
      return await getEvaluationByExecution(
        decodeURIComponent(exeEvalMatch[1]!),
        cp,
        req,
      );
    }

    const exeByRootMatch = /^\/v1\/executions\/by-root\/([^/]+)$/.exec(path);
    if (method === 'GET' && exeByRootMatch) {
      return await getExecutionsByRoot(exeByRootMatch[1]!, cp, req);
    }

    const exeMatch = /^\/v1\/executions\/([^/]+)$/.exec(path);
    if (method === 'GET' && exeMatch) {
      return await getExecution(exeMatch[1]!, cp, req);
    }

    const exeByRunMatch = /^\/v1\/executions\/by-run\/([^/]+)$/.exec(path);
    if (method === 'GET' && exeByRunMatch) {
      return await getExecutionByRun(exeByRunMatch[1]!, cp, req);
    }
  } catch (err) {
    if (err instanceof SyntaxError) {
      return jsonError(400, 'invalid_json', 'request body must be valid JSON');
    }
    // Map domain errors so approval retries / illegal transitions do not look
    // like opaque 500s (Mission 001 PASS C/D: second decision must fail closed).
    if (isAionError(err)) {
      const status =
        err.code === 'INVALID_STATE_TRANSITION'
          ? 409
          : err.code === 'NOT_FOUND'
            ? 404
            : err.code === 'PERMISSION_DENIED'
              ? 403
              : err.code === 'VALIDATION'
                ? 400
                : 500;
      logger.error('gateway_domain_error', {
        operation: `${method} ${path}`,
        code: err.code,
        error: err.message,
      });
      return jsonError(status, err.code.toLowerCase(), err.message);
    }
    logger.error('gateway_error', {
      operation: `${method} ${path}`,
      error: err instanceof Error ? err.message : 'unknown',
    });
    return jsonError(
      500,
      'internal_error',
      err instanceof Error ? err.message : 'unknown error',
    );
  }

  return null;
}

async function submitCommand(
  body: unknown,
  cp: ControlPlane,
  logger: Logger,
): Promise<GatewayResponse> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonError(400, 'invalid_body', 'command body must be a JSON object');
  }
  const raw = body as Record<string, unknown>;

  const actorParsed = Actor.safeParse(raw.actor);
  if (!actorParsed.success) {
    return jsonError(400, 'invalid_actor', 'actor must satisfy the Core Actor contract');
  }
  const actor = actorParsed.data;

  if (typeof raw.name !== 'string' || raw.name.length < 1) {
    return jsonError(400, 'invalid_name', 'name is required');
  }

  // Prefer Service Catalog resolution (serviceKey → capability). Direct
  // capability remains for smoke / low-level callers.
  let cap: Capability;
  let catalogServiceKey: string | undefined;
  let catalogRisk: RiskLevel | undefined;
  let catalogWorkflowId: string | undefined;
  let catalogApprovalRequired = false;
  let catalogRequiredPermissions: Capability[] = [];
  let catalogService: Awaited<ReturnType<typeof cp.dataLayer.services.getByKey>> | undefined;

  if (typeof raw.serviceKey === 'string' && raw.serviceKey.length > 0) {
    const keyParsed = ServiceKey.safeParse(raw.serviceKey);
    if (!keyParsed.success) {
      return jsonError(
        400,
        'invalid_service_key',
        'serviceKey must be name@version, e.g. revenue.lead.research@1',
      );
    }
    const service = await cp.dataLayer.services.getByKey(keyParsed.data);
    if (!service) {
      return jsonError(404, 'service_not_found', `service ${keyParsed.data} not in catalog`);
    }
    if (service.status !== 'active') {
      return jsonError(409, 'service_deprecated', `service ${keyParsed.data} is deprecated`);
    }
    if (typeof raw.capability === 'string' && raw.capability.length > 0) {
      const direct = Capability.safeParse(raw.capability);
      if (direct.success && direct.data !== service.capability) {
        return jsonError(
          400,
          'capability_mismatch',
          `capability ${direct.data} does not match service ${service.serviceKey} → ${service.capability}`,
        );
      }
    }
    cap = service.capability;
    catalogServiceKey = service.serviceKey;
    catalogRisk = service.riskLevel;
    catalogWorkflowId = service.workflowId;
    catalogApprovalRequired = service.approvalRequired === true;
    catalogRequiredPermissions = [...service.requiredPermissions];
    catalogService = service;
  } else {
    const capParsed = Capability.safeParse(raw.capability);
    if (!capParsed.success) {
      return jsonError(
        400,
        'invalid_capability',
        'capability or serviceKey is required (prefer serviceKey)',
      );
    }
    cap = capParsed.data;
  }

  // Every governed action is attributable to a registered actor.
  await cp.dataLayer.actors.save(actor);

  // Catalog contract: requiredPermissions are deny-by-default grants the caller
  // must hold (in addition to the resolved capability itself).
  if (catalogServiceKey && catalogRequiredPermissions.length > 0) {
    const grants = new Set(actor.permissions.map(String));
    const missing = catalogRequiredPermissions.filter((p) => !grants.has(String(p)));
    if (missing.length > 0) {
      return jsonError(
        403,
        'permission_denied',
        `actor lacks requiredPermissions for ${catalogServiceKey}: ${missing.join(', ')}`,
      );
    }
  }

  // Mission 003: Runtime decides ALLOW / DENY / REQUIRE_APPROVAL. Never trusts
  // agent self-claims for tenant, identity, or serviceKey authority.
  if (actor.actorType === 'agent') {
    const agent = actor as AgentActor;
    if (!agent.tenantId) {
      return jsonError(
        403,
        'tenant_required',
        'agent-driven commands require actor.tenantId (Mission 003 isolation)',
      );
    }
    const claimedAgentId =
      typeof raw.claimedAgentId === 'string' ? raw.claimedAgentId : agent.agentId;
    const resourceTenantId =
      typeof raw.resourceTenantId === 'string' ? raw.resourceTenantId : undefined;
    const authReq = AuthorizationRequest.parse({
      agentId: claimedAgentId,
      ...(agent.agentUri ? { agentUri: agent.agentUri } : {}),
      tenantId: agent.tenantId,
      ...(agent.companyId ? { companyId: agent.companyId } : {}),
      ...(catalogServiceKey ? { serviceKey: catalogServiceKey } : {}),
      capability: cap,
      action: 'invoke',
      permissions: agent.permissions.map(String),
      ...(resourceTenantId ? { resourceTenantId } : {}),
      ...(typeof raw.approvalId === 'string' ? { approvalId: raw.approvalId } : {}),
      ...(typeof raw.riskLevel === 'string'
        ? { riskLevel: raw.riskLevel }
        : catalogRisk
          ? { riskLevel: catalogRisk }
          : {}),
    });
    let approval;
    if (typeof raw.approvalId === 'string') {
      approval = await cp.dataLayer.approvals.get(raw.approvalId as never);
    }
    const authz = cp.policyEngine.authorize(authReq, {
      actor,
      ...(approval ? { approval } : {}),
      ...(catalogServiceKey ? { resolvedServiceKey: catalogServiceKey } : {}),
    });
    if (authz.decision === 'DENY') {
      // Persist a denied Execution Object so Mission 005 economics can count
      // policy denials (fail-closed still returns 403 to the caller).
      const now = new Date().toISOString();
      const deniedRun: Run = {
        runId: newRunId(),
        requestId:
          typeof raw.requestId === 'string' && raw.requestId.length > 0
            ? (raw.requestId as Run['requestId'])
            : newRequestId(),
        ...(typeof raw.missionId === 'string'
          ? { missionId: raw.missionId as Run['missionId'] }
          : {}),
        commandId: newCommandId(),
        actorId: actor.actorId,
        state: 'denied',
        ...(typeof raw.riskLevel === 'string'
          ? { riskLevel: raw.riskLevel as RiskLevel }
          : catalogRisk
            ? { riskLevel: catalogRisk }
            : {}),
        correlationId: newCorrelationId(),
        createdAt: now,
        updatedAt: now,
      };
      await cp.dataLayer.runs.save(deniedRun);
      const deniedExe = createExecutionObject({
        run: deniedRun,
        agent,
        tenantId: agent.tenantId,
        companyId: agent.companyId,
        ventureId: agent.ventureId,
        projectId: agent.projectId,
        auditTrace: [
          {
            at: now,
            event: 'policy.denied',
            detail: { reason: authz.reason, decision: 'DENY' },
          },
        ],
        metadata: {
          denialReason: authz.reason,
          ...(catalogServiceKey ? { serviceKey: catalogServiceKey } : {}),
        },
      });
      // Force status denied (createExecutionObject maps from run.state already).
      await cp.dataLayer.executions.save(deniedExe);
      logger.info('gateway_authorization_denied', {
        operation: 'POST /v1/commands',
        run_id: deniedRun.runId,
        execution_id: deniedExe.executionId,
        reason: authz.reason,
      });
      return {
        status: 403,
        body: {
          status: 'denied',
          error: 'authorization_denied',
          message: authz.reason,
          run: deniedRun,
          execution: deniedExe,
          decision: { decision: 'DENY', reason: authz.reason },
        },
      };
    }
    // REQUIRE_APPROVAL is still handled by the orchestrator / catalog gate below.
  }

  // Submit idempotency: same requestId returns the original run/execution
  // without creating a second execution (approval/retry safety).
  if (typeof raw.requestId === 'string' && raw.requestId.length > 0) {
    const existing = await cp.dataLayer.runs.getByRequestId(raw.requestId);
    if (existing) {
      const execution = await cp.dataLayer.executions.getByRunId(existing.runId);
      const approval =
        existing.approvalId != null
          ? await cp.dataLayer.approvals.get(existing.approvalId)
          : undefined;
      const status =
        existing.state === 'awaiting_approval'
          ? 'awaiting_approval'
          : existing.state === 'denied'
            ? 'denied'
            : existing.state === 'failed'
              ? 'failed'
              : 'completed';
      logger.info('gateway_command_idempotent_replay', {
        operation: 'POST /v1/commands',
        request_id: raw.requestId,
        run_id: existing.runId,
        status,
      });
      return {
        status: status === 'denied' ? 403 : status === 'awaiting_approval' ? 202 : 200,
        body: {
          status,
          run: existing,
          execution: execution ?? null,
          ...(approval ? { approval } : {}),
          idempotentReplay: true,
          ...(catalogService
            ? {
                service: {
                  serviceKey: catalogService.serviceKey,
                  version: catalogService.version,
                  riskLevel: catalogService.riskLevel,
                  approvalRequired: catalogService.approvalRequired,
                  requiredPermissions: catalogService.requiredPermissions,
                  capability: catalogService.capability,
                },
              }
            : {}),
        },
      };
    }
  }

  const metadata: Record<string, unknown> = {
    ...(raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)
      ? (raw.metadata as Record<string, unknown>)
      : {}),
    ...(catalogServiceKey ? { serviceKey: catalogServiceKey } : {}),
    ...(catalogApprovalRequired ? { approvalRequired: true } : {}),
    ...(catalogService
      ? {
          serviceVersion: catalogService.version,
          serviceRiskLevel: catalogService.riskLevel,
          serviceOwner: catalogService.owner,
        }
      : {}),
  };

  const input: CommandInput = {
    name: raw.name,
    actor,
    capability: cap,
    ...(typeof raw.requestId === 'string'
      ? { requestId: raw.requestId as CommandInput['requestId'] }
      : {}),
    ...(typeof raw.missionId === 'string'
      ? { missionId: raw.missionId as CommandInput['missionId'] }
      : {}),
    ...(typeof raw.workflowId === 'string'
      ? { workflowId: raw.workflowId as CommandInput['workflowId'] }
      : catalogWorkflowId
        ? { workflowId: catalogWorkflowId as CommandInput['workflowId'] }
        : {}),
    ...(typeof raw.toolId === 'string' ? { toolId: raw.toolId as CommandInput['toolId'] } : {}),
    ...(raw.payload && typeof raw.payload === 'object' && !Array.isArray(raw.payload)
      ? { payload: raw.payload as Record<string, unknown> }
      : {}),
    ...(typeof raw.riskLevel === 'string'
      ? { riskLevel: raw.riskLevel as RiskLevel }
      : catalogRisk
        ? { riskLevel: catalogRisk }
        : {}),
    ...(typeof raw.executionId === 'string' ? { executionId: raw.executionId } : {}),
    ...(typeof raw.parentExecutionId === 'string'
      ? { parentExecutionId: raw.parentExecutionId }
      : {}),
    ...(typeof raw.rootExecutionId === 'string' ? { rootExecutionId: raw.rootExecutionId } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };

  const result = await cp.orchestrator.submit(input);
  const agent = actor.actorType === 'agent' ? (actor as AgentActor) : undefined;
  const revenueAttributed =
    typeof raw.revenueAttributed === 'number' && Number.isFinite(raw.revenueAttributed)
      ? raw.revenueAttributed
      : undefined;
  const outcomeSummary =
    typeof raw.outcomeSummary === 'string' && raw.outcomeSummary.length > 0
      ? raw.outcomeSummary
      : undefined;
  const execution = createExecutionObject({
    run: result.run,
    agent,
    result: result.result,
    executionId:
      (typeof raw.executionId === 'string' ? (raw.executionId as never) : undefined) ??
      result.command.executionId,
    parentExecutionId:
      (typeof raw.parentExecutionId === 'string'
        ? (raw.parentExecutionId as never)
        : undefined) ?? result.command.parentExecutionId,
    rootExecutionId:
      (typeof raw.rootExecutionId === 'string' ? (raw.rootExecutionId as never) : undefined) ??
      result.command.rootExecutionId,
    tenantId: agent?.tenantId,
    companyId: agent?.companyId,
    ventureId: agent?.ventureId,
    projectId: agent?.projectId,
    ...(revenueAttributed !== undefined ? { revenueAttributed } : {}),
    ...(outcomeSummary !== undefined ? { outcomeSummary } : {}),
  });
  await cp.dataLayer.executions.save(execution);

  logger.info('gateway_command_submitted', {
    operation: 'POST /v1/commands',
    run_id: result.run.runId,
    execution_id: execution.executionId,
    status: result.status,
    ...(catalogServiceKey ? { service_key: catalogServiceKey } : {}),
  });

  return {
    status: result.status === 'denied' ? 403 : result.status === 'awaiting_approval' ? 202 : 200,
    body: {
      status: result.status,
      run: result.run,
      execution,
      decision: result.decision,
      ...(result.result ? { result: result.result } : {}),
      ...(result.approval ? { approval: result.approval } : {}),
      ...(result.outcomeReference ? { outcomeReference: result.outcomeReference } : {}),
      ...(catalogService
        ? {
            service: {
              serviceKey: catalogService.serviceKey,
              version: catalogService.version,
              riskLevel: catalogService.riskLevel,
              approvalRequired: catalogService.approvalRequired,
              requiredPermissions: catalogService.requiredPermissions,
              capability: catalogService.capability,
              owner: catalogService.owner,
              costHintUnits: catalogService.costHintUnits,
              evalRefs: catalogService.evalRefs,
            },
          }
        : {}),
    },
  };
}

async function getRun(runId: string, cp: ControlPlane): Promise<GatewayResponse> {
  const run = await cp.orchestrator.getRun(runId as never);
  if (!run) return jsonError(404, 'run_not_found', `run ${runId} not found`);
  const execution = await cp.dataLayer.executions.getByRunId(run.runId);
  return { status: 200, body: { run, execution: execution ?? null } };
}

async function decideApproval(
  approvalId: string,
  body: unknown,
  cp: ControlPlane,
  logger: Logger,
): Promise<GatewayResponse> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonError(400, 'invalid_body', 'decision body must be a JSON object');
  }
  const raw = body as Record<string, unknown>;
  const parsed = ApprovalDecision.safeParse({
    approvalId,
    approve: raw.approve,
    decidedBy: raw.decidedBy,
    ...(typeof raw.note === 'string' ? { note: raw.note } : {}),
  });
  if (!parsed.success) {
    return jsonError(
      400,
      'invalid_decision',
      'decision must include approve (boolean) and decidedBy (actor id)',
    );
  }

  // Persist the deciding actor when provided so `approvals.decided_by` FK
  // (and attribution) remain coherent after restart / approval resume.
  if (raw.actor !== undefined) {
    const actorParsed = Actor.safeParse(raw.actor);
    if (!actorParsed.success) {
      return jsonError(400, 'invalid_actor', 'actor must satisfy the Core Actor contract');
    }
    if (actorParsed.data.actorId !== parsed.data.decidedBy) {
      return jsonError(
        400,
        'actor_mismatch',
        'actor.actorId must match decidedBy',
      );
    }
    await cp.dataLayer.actors.save(actorParsed.data);
  }

  const result = await cp.orchestrator.resume(parsed.data);
  const actor = await cp.dataLayer.actors.get(result.run.actorId);
  const agent = actor?.actorType === 'agent' ? actor : undefined;
  const existing = await cp.dataLayer.executions.getByRunId(result.run.runId);
  const execution = createExecutionObject({
    run: result.run,
    agent,
    result: result.result,
    executionId:
      (typeof raw.executionId === 'string' ? (raw.executionId as never) : undefined) ??
      result.command.executionId ??
      existing?.executionId,
    parentExecutionId:
      (typeof raw.parentExecutionId === 'string'
        ? (raw.parentExecutionId as never)
        : undefined) ??
      result.command.parentExecutionId ??
      existing?.parentExecutionId,
    rootExecutionId:
      (typeof raw.rootExecutionId === 'string' ? (raw.rootExecutionId as never) : undefined) ??
      result.command.rootExecutionId ??
      existing?.rootExecutionId,
    tenantId: agent?.tenantId ?? existing?.tenantId,
    auditTrace: [
      ...(existing?.auditTrace ?? []),
      {
        at: result.run.updatedAt,
        event: parsed.data.approve ? 'approval.granted' : 'approval.rejected',
        detail: { approvalId },
      },
    ],
  });
  await cp.dataLayer.executions.save(execution);

  logger.info('gateway_approval_decided', {
    operation: 'POST /v1/approvals/:id/decision',
    approval_id: approvalId,
    run_id: result.run.runId,
    status: result.status,
  });

  return {
    status: result.status === 'denied' ? 403 : 200,
    body: {
      status: result.status,
      run: result.run,
      execution,
      decision: result.decision,
      ...(result.result ? { result: result.result } : {}),
    },
  };
}

function callerTenantId(req: IncomingMessage): string | undefined {
  const header = req.headers['x-aion-tenant-id'];
  if (typeof header === 'string' && header.length > 0) return header;
  if (Array.isArray(header) && header[0]) return header[0];
  return undefined;
}

/**
 * Mission 003: cross-tenant execution reads are DENY at the platform boundary.
 * Callers must present `x-aion-tenant-id` matching the execution's tenant.
 */
function assertExecutionTenantAccess(
  execution: { tenantId?: string },
  req: IncomingMessage,
): GatewayResponse | null {
  const callerTenant = callerTenantId(req);
  if (!callerTenant) {
    return jsonError(
      403,
      'tenant_required',
      'x-aion-tenant-id header is required to read executions (Mission 003)',
    );
  }
  if (execution.tenantId && execution.tenantId !== callerTenant) {
    return jsonError(
      403,
      'tenant_isolation_denied',
      `caller tenant ${callerTenant} cannot read execution owned by ${execution.tenantId}`,
    );
  }
  return null;
}

async function getExecution(
  executionId: string,
  cp: ControlPlane,
  req: IncomingMessage,
): Promise<GatewayResponse> {
  const execution = await cp.dataLayer.executions.get(executionId as never);
  if (!execution) {
    return jsonError(404, 'execution_not_found', `execution ${executionId} not found`);
  }
  const denied = assertExecutionTenantAccess(execution, req);
  if (denied) return denied;
  return { status: 200, body: { execution } };
}

async function getExecutionByRun(
  runId: string,
  cp: ControlPlane,
  req: IncomingMessage,
): Promise<GatewayResponse> {
  const execution = await cp.dataLayer.executions.getByRunId(runId as never);
  if (!execution) {
    return jsonError(404, 'execution_not_found', `no execution for run ${runId}`);
  }
  const denied = assertExecutionTenantAccess(execution, req);
  if (denied) return denied;
  return { status: 200, body: { execution } };
}

/**
 * Mission 004 — list Execution Objects under a shared root lineage tree.
 * Tenant header required (same isolation boundary as other execution GETs).
 */
async function getExecutionsByRoot(
  rootExecutionId: string,
  cp: ControlPlane,
  req: IncomingMessage,
): Promise<GatewayResponse> {
  const executions = await cp.dataLayer.executions.listByRoot(rootExecutionId as never);
  if (executions.length === 0) {
    return jsonError(
      404,
      'execution_not_found',
      `no executions under root ${rootExecutionId}`,
    );
  }
  // Deny if ANY tree member is cross-tenant for the caller.
  for (const execution of executions) {
    const denied = assertExecutionTenantAccess(execution, req);
    if (denied) return denied;
  }
  return {
    status: 200,
    body: { rootExecutionId, executions, count: executions.length },
  };
}

/**
 * Mission 006 — list missions referenced by tenant executions.
 */
async function listMissions(
  cp: ControlPlane,
  req: IncomingMessage,
): Promise<GatewayResponse> {
  const callerTenant = callerTenantId(req);
  if (!callerTenant) {
    return jsonError(
      403,
      'tenant_required',
      'x-aion-tenant-id header is required to list missions (Mission 006)',
    );
  }
  const missions = await cp.dataLayer.missions.listForTenant(callerTenant);
  return { status: 200, body: { missions } };
}

/**
 * Mission 006 — fetch one mission when the tenant has any execution referencing it.
 */
async function getMission(
  missionIdRaw: string,
  cp: ControlPlane,
  req: IncomingMessage,
): Promise<GatewayResponse> {
  const callerTenant = callerTenantId(req);
  if (!callerTenant) {
    return jsonError(
      403,
      'tenant_required',
      'x-aion-tenant-id header is required to read missions (Mission 006)',
    );
  }
  const parsed = MissionId.safeParse(missionIdRaw);
  if (!parsed.success) {
    return jsonError(400, 'invalid_mission_id', 'missionId must be a Core MissionId');
  }
  const mission = await cp.dataLayer.missions.get(parsed.data);
  if (!mission) {
    return jsonError(404, 'mission_not_found', `mission ${missionIdRaw} not found`);
  }
  const tenantMissions = await cp.dataLayer.missions.listForTenant(callerTenant);
  if (!tenantMissions.some((m) => m.missionId === mission.missionId)) {
    return jsonError(
      403,
      'tenant_isolation_denied',
      `caller tenant ${callerTenant} cannot read mission ${missionIdRaw}`,
    );
  }
  return { status: 200, body: { mission } };
}

/**
 * Mission 006 — recent executions for the caller tenant.
 */
async function listRecentExecutions(
  url: string,
  cp: ControlPlane,
  req: IncomingMessage,
): Promise<GatewayResponse> {
  const callerTenant = callerTenantId(req);
  if (!callerTenant) {
    return jsonError(
      403,
      'tenant_required',
      'x-aion-tenant-id header is required to list executions (Mission 006)',
    );
  }
  const params = new URL(url, 'http://localhost').searchParams;
  const limitRaw = params.get('limit');
  const limit = limitRaw ? Number(limitRaw) : 50;
  if (!Number.isFinite(limit) || limit < 1) {
    return jsonError(400, 'invalid_limit', 'limit must be a positive number');
  }
  const executions = await cp.dataLayer.executions.listRecentForTenant(
    callerTenant,
    Math.trunc(limit),
  );
  return { status: 200, body: { executions, count: executions.length } };
}

/**
 * Mission 006 — bounded approval inspect queue for the caller tenant.
 */
async function listApprovals(
  url: string,
  cp: ControlPlane,
  req: IncomingMessage,
): Promise<GatewayResponse> {
  const callerTenant = callerTenantId(req);
  if (!callerTenant) {
    return jsonError(
      403,
      'tenant_required',
      'x-aion-tenant-id header is required to list approvals (Mission 006)',
    );
  }
  const params = new URL(url, 'http://localhost').searchParams;
  const statusRaw = params.get('status');
  let status: ApprovalStatus | undefined;
  if (statusRaw) {
    const parsed = ApprovalStatus.safeParse(statusRaw);
    if (!parsed.success) {
      return jsonError(
        400,
        'invalid_status',
        'status must be pending, granted, or rejected',
      );
    }
    status = parsed.data;
  }
  const approvals = await cp.dataLayer.approvals.listForTenant(callerTenant, status);
  return { status: 200, body: { approvals, count: approvals.length } };
}

/**
 * Mission 005 — mission economics rollup (SQL-derived; tenant header required).
 */
async function getMissionEconomics(
  missionIdRaw: string,
  cp: ControlPlane,
  req: IncomingMessage,
): Promise<GatewayResponse> {
  const callerTenant = callerTenantId(req);
  if (!callerTenant) {
    return jsonError(
      403,
      'tenant_required',
      'x-aion-tenant-id header is required to read mission economics (Mission 005)',
    );
  }
  const parsed = MissionId.safeParse(missionIdRaw);
  if (!parsed.success) {
    return jsonError(400, 'invalid_mission_id', 'missionId must be a Core MissionId');
  }
  const mission = await cp.dataLayer.missions.get(parsed.data);
  if (!mission) {
    return jsonError(404, 'mission_not_found', `mission ${missionIdRaw} not found`);
  }
  const economics = await cp.dataLayer.economics.rollupByMission(
    parsed.data,
    callerTenant,
  );
  return { status: 200, body: { economics } };
}

/**
 * Mission 005 — scope / holding economics rollup.
 * Query: tenantId (optional; defaults to header), companyId, ventureId, projectId.
 * Tenant header required; query tenantId must match header when both present.
 */
async function getScopeEconomics(
  url: string,
  cp: ControlPlane,
  req: IncomingMessage,
): Promise<GatewayResponse> {
  const callerTenant = callerTenantId(req);
  if (!callerTenant) {
    return jsonError(
      403,
      'tenant_required',
      'x-aion-tenant-id header is required to read scope economics (Mission 005)',
    );
  }
  const params = new URL(url, 'http://localhost').searchParams;
  const queryTenant = params.get('tenantId');
  if (queryTenant && queryTenant !== callerTenant) {
    return jsonError(
      403,
      'tenant_isolation_denied',
      `caller tenant ${callerTenant} cannot roll up tenant ${queryTenant}`,
    );
  }
  const scopeRaw = {
    tenantId: queryTenant ?? callerTenant,
    ...(params.get('companyId') ? { companyId: params.get('companyId')! } : {}),
    ...(params.get('ventureId') ? { ventureId: params.get('ventureId')! } : {}),
    ...(params.get('projectId') ? { projectId: params.get('projectId')! } : {}),
  };
  const scopeParsed = EconomicsScopeDims.safeParse(scopeRaw);
  if (!scopeParsed.success) {
    return jsonError(
      400,
      'invalid_scope',
      'economics scope requires tenantId (and optional company/venture/project)',
    );
  }
  const economics = await cp.dataLayer.economics.rollupByScope(scopeParsed.data);
  return { status: 200, body: { economics } };
}

function routingOverrideKey(
  tenantId: string,
  capability?: string,
  serviceKey?: string,
): string {
  return `${tenantId}|${capability ?? serviceKey ?? '*'}`;
}

/**
 * Mission 007 — record a durable EvaluationResult (tenant header required).
 * Body may be a full EvaluationResult or CreateEvaluationInput fields.
 */
async function createEvaluation(
  body: unknown,
  cp: ControlPlane,
  req: IncomingMessage,
): Promise<GatewayResponse> {
  const callerTenant = callerTenantId(req);
  if (!callerTenant) {
    return jsonError(
      403,
      'tenant_required',
      'x-aion-tenant-id header is required to write evaluations (Mission 007)',
    );
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonError(400, 'invalid_body', 'evaluation body must be a JSON object');
  }
  const raw = body as Record<string, unknown>;
  if (raw.tenantId && raw.tenantId !== callerTenant) {
    return jsonError(
      403,
      'tenant_isolation_denied',
      `caller tenant ${callerTenant} cannot write evaluations for tenant ${String(raw.tenantId)}`,
    );
  }
  let evaluation;
  try {
    if (raw.evaluationId) {
      evaluation = EvaluationResult.parse({ ...raw, tenantId: callerTenant });
    } else {
      evaluation = createEvaluationResult({
        ...(raw as unknown as Parameters<typeof createEvaluationResult>[0]),
        tenantId: callerTenant,
      });
    }
  } catch (err) {
    return jsonError(
      400,
      'invalid_evaluation',
      err instanceof Error ? err.message : 'evaluation failed validation',
    );
  }
  await cp.dataLayer.evaluations.save(evaluation);
  return { status: 201, body: { evaluation } };
}

async function getEvaluation(
  evaluationIdRaw: string,
  cp: ControlPlane,
  req: IncomingMessage,
): Promise<GatewayResponse> {
  const callerTenant = callerTenantId(req);
  if (!callerTenant) {
    return jsonError(
      403,
      'tenant_required',
      'x-aion-tenant-id header is required to read evaluations (Mission 007)',
    );
  }
  const parsed = EvaluationId.safeParse(evaluationIdRaw);
  if (!parsed.success) {
    return jsonError(400, 'invalid_evaluation_id', 'evaluationId must be a Core EvaluationId');
  }
  const evaluation = await cp.dataLayer.evaluations.get(parsed.data);
  if (!evaluation) {
    return jsonError(404, 'evaluation_not_found', `evaluation ${evaluationIdRaw} not found`);
  }
  if (evaluation.tenantId && evaluation.tenantId !== callerTenant) {
    return jsonError(
      403,
      'tenant_isolation_denied',
      `caller tenant ${callerTenant} cannot read evaluation owned by ${evaluation.tenantId}`,
    );
  }
  return { status: 200, body: { evaluation } };
}

async function getEvaluationByExecution(
  executionIdRaw: string,
  cp: ControlPlane,
  req: IncomingMessage,
): Promise<GatewayResponse> {
  const callerTenant = callerTenantId(req);
  if (!callerTenant) {
    return jsonError(
      403,
      'tenant_required',
      'x-aion-tenant-id header is required to read evaluations (Mission 007)',
    );
  }
  const parsed = ExecutionId.safeParse(executionIdRaw);
  if (!parsed.success) {
    return jsonError(400, 'invalid_execution_id', 'executionId must be a Core ExecutionId');
  }
  const evaluation = await cp.dataLayer.evaluations.getByExecutionId(parsed.data);
  if (!evaluation) {
    return jsonError(
      404,
      'evaluation_not_found',
      `no evaluation for execution ${executionIdRaw}`,
    );
  }
  if (evaluation.tenantId && evaluation.tenantId !== callerTenant) {
    return jsonError(
      403,
      'tenant_isolation_denied',
      `caller tenant ${callerTenant} cannot read evaluation owned by ${evaluation.tenantId}`,
    );
  }
  return { status: 200, body: { evaluation } };
}

async function getScorecards(
  url: string,
  cp: ControlPlane,
  req: IncomingMessage,
): Promise<GatewayResponse> {
  const callerTenant = callerTenantId(req);
  if (!callerTenant) {
    return jsonError(
      403,
      'tenant_required',
      'x-aion-tenant-id header is required to read scorecards (Mission 007)',
    );
  }
  const params = new URL(url, 'http://localhost').searchParams;
  const queryTenant = params.get('tenantId');
  if (queryTenant && queryTenant !== callerTenant) {
    return jsonError(
      403,
      'tenant_isolation_denied',
      `caller tenant ${callerTenant} cannot read scorecards for tenant ${queryTenant}`,
    );
  }
  const capability = params.get('capability') ?? undefined;
  const serviceKey = params.get('serviceKey') ?? undefined;
  const scorecards = await cp.dataLayer.evaluations.scorecardsForTenant(callerTenant, {
    ...(capability ? { capability } : {}),
    ...(serviceKey ? { serviceKey } : {}),
  });
  return { status: 200, body: { scorecards, count: scorecards.length } };
}

/**
 * Mission 007 — recommendation-only routing. Deterministic fallback always
 * present; does not reorder ExecutionRegistry adapters.
 */
async function recommendRouting(
  url: string,
  cp: ControlPlane,
  req: IncomingMessage,
): Promise<GatewayResponse> {
  const callerTenant = callerTenantId(req);
  if (!callerTenant) {
    return jsonError(
      403,
      'tenant_required',
      'x-aion-tenant-id header is required for routing recommendations (Mission 007)',
    );
  }
  const params = new URL(url, 'http://localhost').searchParams;
  const queryTenant = params.get('tenantId');
  if (queryTenant && queryTenant !== callerTenant) {
    return jsonError(
      403,
      'tenant_isolation_denied',
      `caller tenant ${callerTenant} cannot recommend routes for tenant ${queryTenant}`,
    );
  }
  const capability = params.get('capability') ?? undefined;
  const serviceKeyRaw = params.get('serviceKey') ?? undefined;
  let serviceKey: ReturnType<typeof ServiceKey.parse> | undefined;
  if (serviceKeyRaw) {
    const sk = ServiceKey.safeParse(serviceKeyRaw);
    if (!sk.success) {
      return jsonError(400, 'invalid_service_key', 'serviceKey must match name@version');
    }
    serviceKey = sk.data;
  }
  const scorecards = await cp.dataLayer.evaluations.scorecardsForTenant(callerTenant, {
    ...(capability ? { capability } : {}),
    ...(serviceKey ? { serviceKey } : {}),
  });
  const override =
    cp.routingOverrides.get(routingOverrideKey(callerTenant, capability, serviceKey)) ??
    cp.routingOverrides.get(routingOverrideKey(callerTenant, capability)) ??
    cp.routingOverrides.get(routingOverrideKey(callerTenant, undefined, serviceKey));
  const recommendation = recommendRoute({
    tenantId: callerTenant,
    ...(capability ? { capability } : {}),
    ...(serviceKey ? { serviceKey } : {}),
    scorecards,
    ...(override ? { override } : {}),
  });
  return { status: 200, body: { recommendation } };
}

async function setRoutingOverride(
  body: unknown,
  cp: ControlPlane,
  req: IncomingMessage,
): Promise<GatewayResponse> {
  const callerTenant = callerTenantId(req);
  if (!callerTenant) {
    return jsonError(
      403,
      'tenant_required',
      'x-aion-tenant-id header is required to set routing overrides (Mission 007)',
    );
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonError(400, 'invalid_body', 'override body must be a JSON object');
  }
  const raw = body as Record<string, unknown>;
  const capability =
    typeof raw.capability === 'string' ? raw.capability : undefined;
  const serviceKey =
    typeof raw.serviceKey === 'string' ? raw.serviceKey : undefined;
  const overrideParsed = RoutingOverride.safeParse(raw.override ?? raw);
  if (!overrideParsed.success) {
    return jsonError(
      400,
      'invalid_override',
      'override requires candidate, reason, setBy, setAt',
    );
  }
  const key = routingOverrideKey(callerTenant, capability, serviceKey);
  cp.routingOverrides.set(key, overrideParsed.data);
  return {
    status: 200,
    body: {
      override: overrideParsed.data,
      key,
      note: 'Recommendation-only — ExecutionRegistry deterministic route remains fallback',
    },
  };
}

/**
 * Mission 004 — run (or resume) a multi-step Mission via MissionOrchestrator.
 *
 * Accepts either already-saved missionId/workflowId, or inline mission/workflow
 * objects that are persisted first. Persists one Execution Object per step with
 * correct parent/root lineage.
 */
async function runMission(
  body: unknown,
  cp: ControlPlane,
  logger: Logger,
): Promise<GatewayResponse> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonError(400, 'invalid_body', 'mission run body must be a JSON object');
  }
  const raw = body as Record<string, unknown>;

  const actorParsed = Actor.safeParse(raw.actor);
  if (!actorParsed.success) {
    return jsonError(400, 'invalid_actor', 'actor must satisfy the Core Actor contract');
  }
  const actor = actorParsed.data;
  await cp.dataLayer.actors.save(actor);

  let missionId: string | undefined =
    typeof raw.missionId === 'string' ? raw.missionId : undefined;
  let workflowId: string | undefined =
    typeof raw.workflowId === 'string' ? raw.workflowId : undefined;

  if (raw.mission !== undefined) {
    if (!raw.mission || typeof raw.mission !== 'object' || Array.isArray(raw.mission)) {
      return jsonError(400, 'invalid_mission', 'mission must be a JSON object');
    }
    const missionRaw = raw.mission as Record<string, unknown>;
    const full = Mission.safeParse(missionRaw);
    const mission = full.success
      ? full.data
      : createMission({
          name: typeof missionRaw.name === 'string' ? missionRaw.name : 'untitled',
          owner: typeof missionRaw.owner === 'string' ? missionRaw.owner : 'runtime',
          objective:
            typeof missionRaw.objective === 'string'
              ? missionRaw.objective
              : 'mission orchestration',
          ...(typeof missionRaw.description === 'string'
            ? { description: missionRaw.description }
            : {}),
          ...(typeof missionRaw.status === 'string' ? { status: missionRaw.status as never } : {}),
          ...(typeof missionRaw.riskLevel === 'string'
            ? { riskLevel: missionRaw.riskLevel as RiskLevel }
            : {}),
          ...(Array.isArray(missionRaw.successCriteria)
            ? { successCriteria: missionRaw.successCriteria as string[] }
            : {}),
          ...(missionRaw.metadata &&
          typeof missionRaw.metadata === 'object' &&
          !Array.isArray(missionRaw.metadata)
            ? { metadata: missionRaw.metadata as Record<string, unknown> }
            : {}),
        });
    await cp.dataLayer.missions.save(mission);
    missionId = mission.missionId;
  }

  if (raw.workflow !== undefined) {
    if (!raw.workflow || typeof raw.workflow !== 'object' || Array.isArray(raw.workflow)) {
      return jsonError(400, 'invalid_workflow', 'workflow must be a JSON object');
    }
    const workflowRaw = raw.workflow as Record<string, unknown>;
    const full = Workflow.safeParse(workflowRaw);
    let workflow;
    if (full.success) {
      workflow = full.data;
    } else {
      if (!Array.isArray(workflowRaw.steps) || typeof workflowRaw.name !== 'string') {
        return jsonError(
          400,
          'invalid_workflow',
          'inline workflow requires name and steps[]',
        );
      }
      try {
        workflow = createWorkflow({
          name: workflowRaw.name,
          steps: workflowRaw.steps as never,
          ...(typeof workflowRaw.description === 'string'
            ? { description: workflowRaw.description }
            : {}),
          ...(typeof workflowRaw.version === 'string'
            ? { version: workflowRaw.version }
            : {}),
          ...(workflowRaw.metadata &&
          typeof workflowRaw.metadata === 'object' &&
          !Array.isArray(workflowRaw.metadata)
            ? { metadata: workflowRaw.metadata as Record<string, unknown> }
            : {}),
        });
      } catch (err) {
        return jsonError(
          400,
          'invalid_workflow',
          err instanceof Error ? err.message : 'invalid workflow',
        );
      }
    }
    await cp.dataLayer.workflows.save(workflow);
    workflowId = workflow.workflowId;
  }

  if (!missionId || !workflowId) {
    return jsonError(
      400,
      'missing_ids',
      'missionId+workflowId or inline mission+workflow are required',
    );
  }

  const stepPayloads =
    raw.stepPayloads && typeof raw.stepPayloads === 'object' && !Array.isArray(raw.stepPayloads)
      ? (raw.stepPayloads as Record<string, Record<string, unknown>>)
      : undefined;

  const result = await cp.missionOrchestrator.run({
    missionId,
    workflowId,
    actor,
    ...(stepPayloads ? { stepPayloads } : {}),
    ...(typeof raw.resumeFromStep === 'number' ? { resumeFromStep: raw.resumeFromStep } : {}),
    ...(typeof raw.rootExecutionId === 'string'
      ? { rootExecutionId: raw.rootExecutionId as never }
      : {}),
    ...(typeof raw.parentExecutionId === 'string'
      ? { parentExecutionId: raw.parentExecutionId as never }
      : {}),
    ...(typeof raw.requestIdPrefix === 'string'
      ? { requestIdPrefix: raw.requestIdPrefix }
      : {}),
    ...(raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)
      ? { metadata: raw.metadata as Record<string, unknown> }
      : {}),
  });

  const agent = actor.actorType === 'agent' ? (actor as AgentActor) : undefined;
  const persistedSteps = [];
  for (const step of result.steps) {
    const existing = await cp.dataLayer.executions.getByRunId(step.orchestration.run.runId);
    const execution = createExecutionObject({
      run: step.orchestration.run,
      agent,
      result: step.orchestration.result,
      executionId: step.executionId,
      parentExecutionId: step.parentExecutionId,
      rootExecutionId: step.rootExecutionId,
      tenantId: agent?.tenantId,
      companyId: agent?.companyId,
      ventureId: agent?.ventureId,
      projectId: agent?.projectId,
      auditTrace: existing?.auditTrace,
    });
    await cp.dataLayer.executions.save(execution);
    persistedSteps.push({
      stepIndex: step.stepIndex,
      stepName: step.step.name,
      capability: step.step.capability,
      status: step.status,
      executionId: step.executionId,
      parentExecutionId: step.parentExecutionId ?? null,
      rootExecutionId: step.rootExecutionId,
      runId: step.orchestration.run.runId,
      approvalId: step.orchestration.approval?.approvalId ?? null,
      result: step.orchestration.result ?? null,
    });
  }

  logger.info('gateway_mission_run', {
    operation: 'POST /v1/missions/run',
    mission_id: result.mission.missionId,
    workflow_id: result.workflow.workflowId,
    root_execution_id: result.rootExecutionId,
    status: result.status,
    steps: String(result.steps.length),
  });

  return {
    status:
      result.status === 'denied'
        ? 403
        : result.status === 'awaiting_approval'
          ? 202
          : result.status === 'failed'
            ? 500
            : 200,
    body: {
      status: result.status,
      rootExecutionId: result.rootExecutionId,
      stoppedAtStep: result.stoppedAtStep ?? null,
      steps: persistedSteps,
      mission: result.mission,
      workflow: result.workflow,
    },
  };
}

async function listServices(
  cp: ControlPlane,
  status: 'active' | 'deprecated' | 'all',
): Promise<GatewayResponse> {
  const services = await cp.dataLayer.services.list(status);
  return { status: 200, body: { services, count: services.length } };
}

async function getService(serviceKey: string, cp: ControlPlane): Promise<GatewayResponse> {
  const keyParsed = ServiceKey.safeParse(serviceKey);
  if (!keyParsed.success) {
    return jsonError(
      400,
      'invalid_service_key',
      'serviceKey must be name@version, e.g. revenue.lead.research@1',
    );
  }
  const service = await cp.dataLayer.services.getByKey(keyParsed.data);
  if (!service) {
    return jsonError(404, 'service_not_found', `service ${keyParsed.data} not in catalog`);
  }
  return { status: 200, body: { service } };
}
