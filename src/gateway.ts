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
 *   GET  /v1/runs/:runId                  — fetch run state
 *   POST /v1/approvals/:approvalId/decision — human gate decision
 *   GET  /v1/executions/:executionId      — canonical Execution Object
 *   GET  /v1/executions/by-run/:runId     — Execution Object by run
 *   GET  /v1/services                     — list Service Catalog (?status=)
 *   GET  /v1/services/:serviceKey         — fetch one catalog service
 */
import type { IncomingMessage } from 'node:http';
import {
  Actor,
  ApprovalDecision,
  Capability,
  ServiceKey,
  createExecutionObject,
  type AgentActor,
  type CommandInput,
  type RiskLevel,
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

    const approvalMatch = /^\/v1\/approvals\/([^/]+)\/decision$/.exec(path);
    if (method === 'POST' && approvalMatch) {
      return await decideApproval(approvalMatch[1]!, await readJsonBody(req), cp, logger);
    }

    const exeMatch = /^\/v1\/executions\/([^/]+)$/.exec(path);
    if (method === 'GET' && exeMatch) {
      return await getExecution(exeMatch[1]!, cp);
    }

    const exeByRunMatch = /^\/v1\/executions\/by-run\/([^/]+)$/.exec(path);
    if (method === 'GET' && exeByRunMatch) {
      return await getExecutionByRun(exeByRunMatch[1]!, cp);
    }
  } catch (err) {
    if (err instanceof SyntaxError) {
      return jsonError(400, 'invalid_json', 'request body must be valid JSON');
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

  const metadata: Record<string, unknown> = {
    ...(raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)
      ? (raw.metadata as Record<string, unknown>)
      : {}),
    ...(catalogServiceKey ? { serviceKey: catalogServiceKey } : {}),
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
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };

  const result = await cp.orchestrator.submit(input);
  const agent = actor.actorType === 'agent' ? (actor as AgentActor) : undefined;
  const execution = createExecutionObject({
    run: result.run,
    agent,
    result: result.result,
    tenantId: agent?.tenantId,
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

  const result = await cp.orchestrator.resume(parsed.data);
  const actor = await cp.dataLayer.actors.get(result.run.actorId);
  const agent = actor?.actorType === 'agent' ? actor : undefined;
  const existing = await cp.dataLayer.executions.getByRunId(result.run.runId);
  const execution = createExecutionObject({
    run: result.run,
    agent,
    result: result.result,
    executionId: existing?.executionId,
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

async function getExecution(executionId: string, cp: ControlPlane): Promise<GatewayResponse> {
  const execution = await cp.dataLayer.executions.get(executionId as never);
  if (!execution) {
    return jsonError(404, 'execution_not_found', `execution ${executionId} not found`);
  }
  return { status: 200, body: { execution } };
}

async function getExecutionByRun(runId: string, cp: ControlPlane): Promise<GatewayResponse> {
  const execution = await cp.dataLayer.executions.getByRunId(runId as never);
  if (!execution) {
    return jsonError(404, 'execution_not_found', `no execution for run ${runId}`);
  }
  return { status: 200, body: { execution } };
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
