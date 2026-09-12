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
 *   PATCH /v1/missions/:missionId         — close / update mission status + metadata
 *                                         (OL-001 terminal outcomes / visible waivers)
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
 *   POST /v1/autonomy/evaluate            — Mission 008 dry-run eligible level
 *   POST /v1/autonomy/promote             — Mission 008 create/activate grant
 *   POST /v1/autonomy/demote              — Mission 008 revoke / lower grant
 *   GET  /v1/autonomy/grants              — Mission 008 list grants
 *   GET  /v1/autonomy/grants/:grantId     — Mission 008 fetch grant
 *   GET  /v1/side-effects                 — Mission 009 list external side-effects
 *   GET  /v1/side-effects/:id             — Mission 009 fetch side-effect
 *   POST /v1/implementations              — IE-001 create ImplementationCase
 *   GET  /v1/implementations              — IE-001 list cases (tenant)
 *   GET  /v1/implementations/:caseId      — IE-001 fetch case
 *   POST /v1/implementations/:caseId/intake — IE-001 complete intake + qualify
 *   POST /v1/implementations/:caseId/blueprint — IE-001 draft/edit blueprint
 *   POST /v1/implementations/:caseId/blueprint/approve — IE-001 approve blueprint
 *   POST /v1/implementations/:caseId/provisioning/start — IE-002 start provisioning
 *   POST /v1/implementations/:caseId/provisioning/steps/:key — IE-002 update step
 *   POST /v1/implementations/:caseId/provisioning/steps/:key/probe — IE-002 readiness probe
 *   POST /v1/implementations/:caseId/activation/ready — IE-002 mark activation_ready
 *   POST /v1/implementations/:caseId/activate — IE-002 human activate → active
 *   POST /v1/outcomes                     — create durable business outcome
 *   GET  /v1/outcomes/:outcomeId          — fetch outcome
 *   GET  /v1/outcomes?runId=|missionId=   — list outcomes by run or mission
 *   PATCH /v1/outcomes/:outcomeId         — update outcome as reality resolves
 *   POST /v1/revenue-sessions             — create opaque revenue session
 *   GET  /v1/revenue-sessions/:sessionId  — fetch revenue session
 *   PUT  /v1/revenue-sessions/:sessionId  — checkpoint / finalize (revision)
 *   GET  /v1/revenue-sessions?status=     — list active ids or finalized records
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
  MissionStatus,
  OutcomeId,
  OutcomeStatus,
  RoutingOverride,
  RunId,
  ServiceKey,
  Workflow,
  createEvaluationResult,
  createExecutionObject,
  createMission,
  createWorkflow,
  createAutonomyGrant,
  computeEligibleAutonomyLevel,
  demoteAutonomyLevel,
  buildAutonomyEvidence,
  AutonomyGrant,
  AutonomyGrantId,
  ImplementationCase,
  ImplementationCaseId,
  ImplementationIntake,
  ImplementationPackage,
  ProvisioningStepKey,
  ProvisioningStepStatus,
  SolutionBlueprint,
  activateImplementation,
  applyIntake,
  approveBlueprint,
  attachBlueprintDraft,
  createImplementationCase,
  draftBlueprintFromCase,
  markActivationReady,
  startProvisioning,
  updateProvisioningStep,
  isAionError,
  newCommandId,
  newCorrelationId,
  newExecutionId,
  newRequestId,
  newRunId,
  recommendRoute,
  type AgentActor,
  type AutonomyEnvironment,
  type CommandInput,
  type RiskLevel,
  type Run,
} from '@aion/core';
import { isDataError, toOutcomeReference } from '@aion/data';
import type { ControlPlane } from './control-plane.js';
import type { Logger } from './logger.js';

export interface GatewayResponse {
  status: number;
  body: unknown;
}

/**
 * Single-process coalescing for concurrent POSTs that share a requestId.
 * Between awaits JS runs to completion, so get-or-create on this Map closes
 * the check-then-act race left by getByRequestId under Promise.all.
 * Multi-process hardening still needs UNIQUE(request_id) in Data.
 */
const inflightSubmits = new Map<string, Promise<void>>();

/**
 * Persist a durable business Outcome (Data-owned) and project it to Core's
 * OutcomeReference. Execution *results* stay distinct from *outcomes*
 * (principle #6); Runtime only seeds a pending/failed outcome seed so the
 * Execution Object can expose a stable outcomeId across restarts.
 */
async function seedDurableOutcome(
  cp: ControlPlane,
  input: {
    runId: Run['runId'];
    missionId?: Run['missionId'];
    status: 'completed' | 'failed';
    outcomeSummary?: string;
  },
): Promise<{ outcomeId: string; outcomeReference: ReturnType<typeof toOutcomeReference> }> {
  const outcome = await cp.dataLayer.outcomes.create({
    runId: input.runId,
    ...(input.missionId ? { missionId: input.missionId } : {}),
    status: input.status === 'failed' ? 'failed' : 'pending',
    ...(input.outcomeSummary
      ? { metadata: { summary: input.outcomeSummary } }
      : {}),
  });
  return {
    outcomeId: outcome.outcomeId,
    outcomeReference: toOutcomeReference(outcome),
  };
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
    if (method === 'PATCH' && missionMatch) {
      return await patchMission(
        decodeURIComponent(missionMatch[1]!),
        await readJsonBody(req),
        cp,
        req,
      );
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

    if (method === 'POST' && path === '/v1/outcomes') {
      return await createOutcome(await readJsonBody(req), cp);
    }
    if (method === 'GET' && path === '/v1/outcomes') {
      return await listOutcomes(url, cp);
    }
    const outcomeMatch = /^\/v1\/outcomes\/([^/]+)$/.exec(path);
    if (method === 'GET' && outcomeMatch) {
      return await getOutcome(decodeURIComponent(outcomeMatch[1]!), cp);
    }
    if (method === 'PATCH' && outcomeMatch) {
      return await patchOutcome(
        decodeURIComponent(outcomeMatch[1]!),
        await readJsonBody(req),
        cp,
      );
    }

    if (method === 'POST' && path === '/v1/revenue-sessions') {
      return await createRevenueSession(await readJsonBody(req), cp);
    }
    if (method === 'GET' && path === '/v1/revenue-sessions') {
      return await listRevenueSessions(url, cp);
    }
    const revenueSessionMatch = /^\/v1\/revenue-sessions\/([^/]+)$/.exec(path);
    if (method === 'GET' && revenueSessionMatch) {
      return await getRevenueSession(decodeURIComponent(revenueSessionMatch[1]!), cp);
    }
    if (method === 'PUT' && revenueSessionMatch) {
      return await putRevenueSession(
        decodeURIComponent(revenueSessionMatch[1]!),
        await readJsonBody(req),
        cp,
      );
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

    if (method === 'POST' && path === '/v1/autonomy/evaluate') {
      return await evaluateAutonomyEligibility(await readJsonBody(req), cp, req);
    }
    if (method === 'POST' && path === '/v1/autonomy/promote') {
      return await promoteAutonomy(await readJsonBody(req), cp, req);
    }
    if (method === 'POST' && path === '/v1/autonomy/demote') {
      return await demoteAutonomy(await readJsonBody(req), cp, req);
    }
    if (method === 'GET' && path === '/v1/autonomy/grants') {
      return await listAutonomyGrants(url, cp, req);
    }
    const autonomyGrantMatch = /^\/v1\/autonomy\/grants\/([^/]+)$/.exec(path);
    if (method === 'GET' && autonomyGrantMatch) {
      return await getAutonomyGrant(
        decodeURIComponent(autonomyGrantMatch[1]!),
        cp,
        req,
      );
    }

    if (method === 'GET' && path === '/v1/side-effects') {
      return await listSideEffects(url, cp, req);
    }
    const sideEffectMatch = /^\/v1\/side-effects\/([^/]+)$/.exec(path);
    if (method === 'GET' && sideEffectMatch) {
      return await getSideEffect(decodeURIComponent(sideEffectMatch[1]!), cp, req);
    }

    if (method === 'POST' && path === '/v1/implementations') {
      return await createImplementation(await readJsonBody(req), cp, req);
    }
    if (method === 'GET' && path === '/v1/implementations') {
      return await listImplementations(url, cp, req);
    }
    const implApproveMatch =
      /^\/v1\/implementations\/([^/]+)\/blueprint\/approve$/.exec(path);
    if (method === 'POST' && implApproveMatch) {
      return await approveImplementationBlueprint(
        decodeURIComponent(implApproveMatch[1]!),
        await readJsonBody(req),
        cp,
        req,
      );
    }
    const implBlueprintMatch =
      /^\/v1\/implementations\/([^/]+)\/blueprint$/.exec(path);
    if (method === 'POST' && implBlueprintMatch) {
      return await upsertImplementationBlueprint(
        decodeURIComponent(implBlueprintMatch[1]!),
        await readJsonBody(req),
        cp,
        req,
      );
    }
    const implIntakeMatch = /^\/v1\/implementations\/([^/]+)\/intake$/.exec(path);
    if (method === 'POST' && implIntakeMatch) {
      return await submitImplementationIntake(
        decodeURIComponent(implIntakeMatch[1]!),
        await readJsonBody(req),
        cp,
        req,
      );
    }
    const implProvStartMatch =
      /^\/v1\/implementations\/([^/]+)\/provisioning\/start$/.exec(path);
    if (method === 'POST' && implProvStartMatch) {
      return await startImplementationProvisioning(
        decodeURIComponent(implProvStartMatch[1]!),
        await readJsonBody(req),
        cp,
        req,
      );
    }
    const implStepProbeMatch =
      /^\/v1\/implementations\/([^/]+)\/provisioning\/steps\/([^/]+)\/probe$/.exec(
        path,
      );
    if (method === 'POST' && implStepProbeMatch) {
      return await probeImplementationProvisioningStep(
        decodeURIComponent(implStepProbeMatch[1]!),
        decodeURIComponent(implStepProbeMatch[2]!),
        await readJsonBody(req),
        cp,
        req,
      );
    }
    const implStepMatch =
      /^\/v1\/implementations\/([^/]+)\/provisioning\/steps\/([^/]+)$/.exec(path);
    if (method === 'POST' && implStepMatch) {
      return await updateImplementationProvisioningStep(
        decodeURIComponent(implStepMatch[1]!),
        decodeURIComponent(implStepMatch[2]!),
        await readJsonBody(req),
        cp,
        req,
      );
    }
    const implActReadyMatch =
      /^\/v1\/implementations\/([^/]+)\/activation\/ready$/.exec(path);
    if (method === 'POST' && implActReadyMatch) {
      return await markImplementationActivationReady(
        decodeURIComponent(implActReadyMatch[1]!),
        await readJsonBody(req),
        cp,
        req,
      );
    }
    const implActivateMatch = /^\/v1\/implementations\/([^/]+)\/activate$/.exec(path);
    if (method === 'POST' && implActivateMatch) {
      return await activateImplementationCase(
        decodeURIComponent(implActivateMatch[1]!),
        await readJsonBody(req),
        cp,
        req,
      );
    }
    const implMatch = /^\/v1\/implementations\/([^/]+)$/.exec(path);
    if (method === 'GET' && implMatch) {
      return await getImplementation(decodeURIComponent(implMatch[1]!), cp, req);
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
    if (isDataError(err)) {
      const status =
        err.code === 'NOT_FOUND'
          ? 404
          : err.code === 'CONCURRENCY'
            ? 409
            : err.code === 'MAPPING'
              ? 400
              : 500;
      logger.error('gateway_data_error', {
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
  let autonomyGrant: AutonomyGrant | undefined;
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
    const environment: AutonomyEnvironment =
      raw.environment === 'production' ? 'production' : 'staging';
    autonomyGrant =
      catalogServiceKey
        ? await cp.dataLayer.autonomyGrants.getActive({
            tenantId: agent.tenantId,
            agentId: agent.agentId,
            environment,
            serviceKey: catalogServiceKey,
          })
        : undefined;
    if (!autonomyGrant) {
      autonomyGrant = await cp.dataLayer.autonomyGrants.getActive({
        tenantId: agent.tenantId,
        agentId: agent.agentId,
        environment,
        capability: String(cap),
      });
    }
    const authz = cp.policyEngine.authorize(authReq, {
      actor,
      ...(approval ? { approval } : {}),
      ...(catalogServiceKey ? { resolvedServiceKey: catalogServiceKey } : {}),
      ...(autonomyGrant ? { autonomyGrant } : {}),
      ...(raw.manualAutonomyDemote === true ? { manualAutonomyDemote: true } : {}),
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

  // Submit idempotency + single-process coalescing for concurrent same requestId.
  // Sequential retries hit the DB path; concurrent duplicates await the in-flight leader.
  const requestId =
    typeof raw.requestId === 'string' && raw.requestId.length > 0
      ? raw.requestId
      : undefined;

  const respondIdempotentReplay = async (
    existing: Awaited<ReturnType<typeof cp.dataLayer.runs.getByRequestId>> & object,
  ): Promise<GatewayResponse> => {
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
      request_id: requestId,
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
  };

  let releaseInflight: (() => void) | undefined;
  if (requestId) {
    const existing = await cp.dataLayer.runs.getByRequestId(requestId);
    if (existing) {
      return respondIdempotentReplay(existing);
    }

    const inflight = inflightSubmits.get(requestId);
    if (inflight) {
      await inflight.catch(() => undefined);
      const created = await cp.dataLayer.runs.getByRequestId(requestId);
      if (created) {
        return respondIdempotentReplay(created);
      }
      // Leader failed before persistence — fall through and create.
    } else {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      inflightSubmits.set(requestId, gate);
      releaseInflight = () => {
        inflightSubmits.delete(requestId);
        release();
      };
    }
  }

  try {
    const metadata: Record<string, unknown> = {
      ...(raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)
        ? (raw.metadata as Record<string, unknown>)
        : {}),
      ...(actor.actorType === 'agent' && (actor as AgentActor).tenantId
        ? { tenantId: (actor as AgentActor).tenantId }
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
      ...(autonomyGrant ? { autonomyGrant } : {}),
      ...(raw.manualAutonomyDemote === true ? { manualAutonomyDemote: true } : {}),
      ...(typeof raw.approvalId === 'string' ? { approvalId: raw.approvalId } : {}),
    };

    const mintedExecutionId =
      typeof raw.executionId === 'string' && raw.executionId.length > 0
        ? raw.executionId
        : newExecutionId();

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
      executionId: mintedExecutionId,
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

    // On terminal completion/failure, seed a durable Outcome and expose it on
    // the Execution Object so clients get a stable outcomeId (not only a stub
    // OutcomeReference without identity).
    let seededOutcome:
      | { outcomeId: string; outcomeReference: ReturnType<typeof toOutcomeReference> }
      | undefined;
    if (result.status === 'completed' || result.status === 'failed') {
      seededOutcome = await seedDurableOutcome(cp, {
        runId: result.run.runId,
        missionId: result.run.missionId,
        status: result.status,
        ...(outcomeSummary !== undefined ? { outcomeSummary } : {}),
      });
    }

    const execution = createExecutionObject({
      run: result.run,
      agent,
      result: result.result,
      executionId:
        (typeof raw.executionId === 'string' ? (raw.executionId as never) : undefined) ??
        result.command.executionId ??
        (mintedExecutionId as never),
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
      ...(seededOutcome ? { outcomeId: seededOutcome.outcomeId as never } : {}),
    });
    await cp.dataLayer.executions.save(execution);

    logger.info('gateway_command_submitted', {
      operation: 'POST /v1/commands',
      run_id: result.run.runId,
      execution_id: execution.executionId,
      status: result.status,
      ...(seededOutcome ? { outcome_id: seededOutcome.outcomeId } : {}),
      ...(catalogServiceKey ? { service_key: catalogServiceKey } : {}),
    });

    const outcomeReference =
      seededOutcome?.outcomeReference ?? result.outcomeReference;

    return {
      status: result.status === 'denied' ? 403 : result.status === 'awaiting_approval' ? 202 : 200,
      body: {
        status: result.status,
        run: result.run,
        execution,
        decision: result.decision,
        ...(result.result ? { result: result.result } : {}),
        ...(result.approval ? { approval: result.approval } : {}),
        ...(outcomeReference ? { outcomeReference } : {}),
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
  } finally {
    releaseInflight?.();
  }
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

  let seededOutcome:
    | { outcomeId: string; outcomeReference: ReturnType<typeof toOutcomeReference> }
    | undefined;
  if (
    (result.status === 'completed' || result.status === 'failed') &&
    !existing?.outcomeId
  ) {
    seededOutcome = await seedDurableOutcome(cp, {
      runId: result.run.runId,
      missionId: result.run.missionId,
      status: result.status,
      ...(existing?.outcomeSummary ? { outcomeSummary: existing.outcomeSummary } : {}),
    });
  }

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
    outcomeId:
      (seededOutcome?.outcomeId as never) ?? existing?.outcomeId,
    outcomeSummary: existing?.outcomeSummary,
    revenueAttributed: existing?.revenueAttributed,
    auditTrace: [
      ...(existing?.auditTrace ?? []),
      {
        at: result.run.updatedAt,
        event: parsed.data.approve ? 'approval.granted' : 'approval.rejected',
        detail: { approvalId },
      },
      ...(seededOutcome
        ? [
            {
              at: result.run.updatedAt,
              event: 'outcome.seeded',
              detail: { outcomeId: seededOutcome.outcomeId },
            },
          ]
        : []),
    ],
  });
  await cp.dataLayer.executions.save(execution);

  logger.info('gateway_approval_decided', {
    operation: 'POST /v1/approvals/:id/decision',
    approval_id: approvalId,
    run_id: result.run.runId,
    execution_id: execution.executionId,
    status: result.status,
    ...(execution.outcomeId ? { outcome_id: execution.outcomeId } : {}),
  });

  return {
    status: result.status === 'denied' ? 403 : 200,
    body: {
      status: result.status,
      run: result.run,
      execution,
      decision: result.decision,
      ...(result.result ? { result: result.result } : {}),
      ...(seededOutcome
        ? { outcomeReference: seededOutcome.outcomeReference }
        : result.outcomeReference
          ? { outcomeReference: result.outcomeReference }
          : {}),
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
 * OL-001 — update mission status and/or merge metadata (terminal outcomes).
 *
 * Used to close production missions with an explicit, visible outcome — including
 * `completed_with_exception` recorded under `metadata.terminalOutcome` while
 * Core `Mission.status` stays within the existing enum (`completed`).
 * Waivers must not be silent: callers put step-level PASS/WAIVED evidence in
 * `metadata.terminalOutcome`.
 */
async function patchMission(
  missionIdRaw: string,
  body: unknown,
  cp: ControlPlane,
  req: IncomingMessage,
): Promise<GatewayResponse> {
  const callerTenant = callerTenantId(req);
  if (!callerTenant) {
    return jsonError(
      403,
      'tenant_required',
      'x-aion-tenant-id header is required to patch missions',
    );
  }
  const parsedId = MissionId.safeParse(missionIdRaw);
  if (!parsedId.success) {
    return jsonError(400, 'invalid_mission_id', 'missionId must be a Core MissionId');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonError(400, 'invalid_body', 'PATCH body must be a JSON object');
  }
  const raw = body as Record<string, unknown>;
  if (raw.status === undefined && raw.metadata === undefined) {
    return jsonError(
      400,
      'invalid_body',
      'PATCH requires status and/or metadata',
    );
  }

  const existing = await cp.dataLayer.missions.get(parsedId.data);
  if (!existing) {
    return jsonError(404, 'mission_not_found', `mission ${missionIdRaw} not found`);
  }
  const tenantMissions = await cp.dataLayer.missions.listForTenant(callerTenant);
  if (!tenantMissions.some((m) => m.missionId === existing.missionId)) {
    return jsonError(
      403,
      'tenant_isolation_denied',
      `caller tenant ${callerTenant} cannot patch mission ${missionIdRaw}`,
    );
  }

  let nextStatus = existing.status;
  if (raw.status !== undefined) {
    const statusParsed = MissionStatus.safeParse(raw.status);
    if (!statusParsed.success) {
      return jsonError(
        400,
        'invalid_status',
        'status must be a Core MissionStatus (draft|active|paused|completed|cancelled)',
      );
    }
    nextStatus = statusParsed.data;
  }

  let nextMetadata: Record<string, unknown> = { ...existing.metadata };
  if (raw.metadata !== undefined) {
    if (!raw.metadata || typeof raw.metadata !== 'object' || Array.isArray(raw.metadata)) {
      return jsonError(400, 'invalid_metadata', 'metadata must be a JSON object');
    }
    nextMetadata = {
      ...nextMetadata,
      ...(raw.metadata as Record<string, unknown>),
    };
  }

  // Honest OL close: if terminalOutcome declares completed_with_exception,
  // force Core status to completed so the mission leaves "active" without a
  // silent drop. Display layers read terminalOutcome.status for the badge.
  const terminal = nextMetadata.terminalOutcome;
  if (
    terminal &&
    typeof terminal === 'object' &&
    !Array.isArray(terminal) &&
    (terminal as Record<string, unknown>).status === 'completed_with_exception'
  ) {
    nextStatus = 'completed';
    nextMetadata = {
      ...nextMetadata,
      outcomeStatus: 'completed_with_exception',
    };
  }

  const updated = Mission.parse({
    ...existing,
    status: nextStatus,
    metadata: nextMetadata,
  });
  await cp.dataLayer.missions.save(updated);
  return { status: 200, body: { mission: updated } };
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

function parseEnvironment(raw: unknown): AutonomyEnvironment {
  return raw === 'production' ? 'production' : 'staging';
}

/** Mission 008 — dry-run eligible autonomy level from evidence. */
async function evaluateAutonomyEligibility(
  body: unknown,
  _cp: ControlPlane,
  req: IncomingMessage,
): Promise<GatewayResponse> {
  const callerTenant = callerTenantId(req);
  if (!callerTenant) {
    return jsonError(
      403,
      'tenant_required',
      'x-aion-tenant-id header is required for autonomy evaluate (Mission 008)',
    );
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonError(400, 'invalid_body', 'evaluate body must be a JSON object');
  }
  const raw = body as Record<string, unknown>;
  if (raw.tenantId && raw.tenantId !== callerTenant) {
    return jsonError(
      403,
      'tenant_isolation_denied',
      `caller tenant ${callerTenant} cannot evaluate autonomy for ${String(raw.tenantId)}`,
    );
  }
  let evidence;
  try {
    evidence = buildAutonomyEvidence(
      (raw.evidence ?? {
        sampleCount: raw.sampleCount,
        successCount: raw.successCount,
        policyViolationCount: raw.policyViolationCount ?? 0,
        humanInterventionCount: raw.humanInterventionCount ?? 0,
        sumEvalScore: raw.sumEvalScore,
        costs: raw.costs,
        rollbackCount: raw.rollbackCount,
      }) as Parameters<typeof buildAutonomyEvidence>[0],
    );
  } catch (err) {
    return jsonError(
      400,
      'invalid_evidence',
      err instanceof Error ? err.message : 'invalid evidence',
    );
  }
  const serviceRisk = (typeof raw.serviceRisk === 'string'
    ? raw.serviceRisk
    : 'R1') as RiskLevel;
  const environment = parseEnvironment(raw.environment);
  const l4Allowed = raw.l4Allowed === true;
  const eligibleLevel = computeEligibleAutonomyLevel({
    evidence,
    serviceRisk,
    environment,
    l4Allowed,
  });
  return {
    status: 200,
    body: { eligibleLevel, evidence, serviceRisk, environment, l4Allowed },
  };
}

async function promoteAutonomy(
  body: unknown,
  cp: ControlPlane,
  req: IncomingMessage,
): Promise<GatewayResponse> {
  const callerTenant = callerTenantId(req);
  if (!callerTenant) {
    return jsonError(
      403,
      'tenant_required',
      'x-aion-tenant-id header is required for autonomy promote (Mission 008)',
    );
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonError(400, 'invalid_body', 'promote body must be a JSON object');
  }
  const raw = body as Record<string, unknown>;
  if (raw.tenantId && raw.tenantId !== callerTenant) {
    return jsonError(
      403,
      'tenant_isolation_denied',
      `caller tenant ${callerTenant} cannot promote autonomy for ${String(raw.tenantId)}`,
    );
  }
  if (typeof raw.agentId !== 'string') {
    return jsonError(400, 'invalid_agent_id', 'agentId is required');
  }
  let evidence;
  try {
    evidence = buildAutonomyEvidence(
      (raw.evidence ?? raw) as Parameters<typeof buildAutonomyEvidence>[0],
    );
  } catch (err) {
    return jsonError(
      400,
      'invalid_evidence',
      err instanceof Error ? err.message : 'invalid evidence',
    );
  }
  const serviceRisk = (typeof raw.serviceRisk === 'string'
    ? raw.serviceRisk
    : 'R1') as RiskLevel;
  const environment = parseEnvironment(raw.environment);
  const l4Allowed = raw.l4Allowed === true;
  const eligibleLevel = computeEligibleAutonomyLevel({
    evidence,
    serviceRisk,
    environment,
    l4Allowed,
  });
  const levelOrder = ['L0', 'L1', 'L2', 'L3', 'L4'] as const;
  const requested =
    typeof raw.currentLevel === 'string' ? raw.currentLevel : eligibleLevel;
  const reqIdx = levelOrder.indexOf(requested as (typeof levelOrder)[number]);
  const eligIdx = levelOrder.indexOf(eligibleLevel);
  const currentLevel =
    reqIdx >= 0 && reqIdx <= eligIdx
      ? (requested as (typeof levelOrder)[number])
      : eligibleLevel;

  if (eligibleLevel === 'L1' && raw.force !== true) {
    return jsonError(
      409,
      'insufficient_evidence',
      'evidence does not qualify for promotion above L1',
    );
  }

  try {
    const grant = createAutonomyGrant({
      agentId: raw.agentId as never,
      tenantId: callerTenant,
      environment,
      currentLevel,
      eligibleLevel,
      evidence,
      grantReason:
        typeof raw.grantReason === 'string'
          ? raw.grantReason
          : `promoted to ${currentLevel} by evidence`,
      ...(typeof raw.serviceKey === 'string'
        ? { serviceKey: raw.serviceKey as never }
        : {}),
      ...(typeof raw.capability === 'string'
        ? { capability: raw.capability as never }
        : {}),
      grantedBy: raw.grantedBy === 'human' ? 'human' : 'policy',
      l4Allowed,
      maxWaiveRisk: serviceRisk === 'R3' ? 'R2' : (serviceRisk as never),
    });
    const safeGrant = AutonomyGrant.parse({
      ...grant,
      maxWaiveRisk: grant.maxWaiveRisk === 'R3' ? 'R2' : grant.maxWaiveRisk,
    });
    await cp.dataLayer.autonomyGrants.save(safeGrant);
    return { status: 201, body: { grant: safeGrant } };
  } catch (err) {
    return jsonError(
      400,
      'invalid_grant',
      err instanceof Error ? err.message : 'grant failed',
    );
  }
}

async function demoteAutonomy(
  body: unknown,
  cp: ControlPlane,
  req: IncomingMessage,
): Promise<GatewayResponse> {
  const callerTenant = callerTenantId(req);
  if (!callerTenant) {
    return jsonError(
      403,
      'tenant_required',
      'x-aion-tenant-id header is required for autonomy demote (Mission 008)',
    );
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonError(400, 'invalid_body', 'demote body must be a JSON object');
  }
  const raw = body as Record<string, unknown>;
  if (raw.tenantId && raw.tenantId !== callerTenant) {
    return jsonError(
      403,
      'tenant_isolation_denied',
      `caller tenant ${callerTenant} cannot demote autonomy for ${String(raw.tenantId)}`,
    );
  }
  const environment = parseEnvironment(raw.environment);
  let grant =
    typeof raw.grantId === 'string'
      ? await cp.dataLayer.autonomyGrants.get(raw.grantId)
      : undefined;
  if (!grant && typeof raw.agentId === 'string') {
    grant = await cp.dataLayer.autonomyGrants.getActive({
      tenantId: callerTenant,
      agentId: raw.agentId,
      environment,
      ...(typeof raw.serviceKey === 'string'
        ? { serviceKey: raw.serviceKey }
        : {}),
      ...(typeof raw.capability === 'string'
        ? { capability: raw.capability }
        : {}),
    });
  }
  if (!grant || grant.tenantId !== callerTenant) {
    return jsonError(404, 'grant_not_found', 'active autonomy grant not found');
  }
  const reason =
    raw.reason === 'policy_violation' ||
    raw.reason === 'evidence_degraded' ||
    raw.reason === 'high_risk'
      ? raw.reason
      : 'manual';
  const nextLevel = demoteAutonomyLevel(grant.currentLevel, reason);
  const demoted = AutonomyGrant.parse({
    ...grant,
    currentLevel: nextLevel,
    eligibleLevel: nextLevel,
    status: 'revoked',
    lastReviewedAt: new Date().toISOString(),
    revokedAt: new Date().toISOString(),
    revokeReason:
      typeof raw.revokeReason === 'string'
        ? raw.revokeReason
        : `demoted to ${nextLevel} (${reason})`,
  });
  await cp.dataLayer.autonomyGrants.save(demoted);
  return { status: 200, body: { grant: demoted } };
}

async function listAutonomyGrants(
  url: string,
  cp: ControlPlane,
  req: IncomingMessage,
): Promise<GatewayResponse> {
  const callerTenant = callerTenantId(req);
  if (!callerTenant) {
    return jsonError(
      403,
      'tenant_required',
      'x-aion-tenant-id header is required to list autonomy grants (Mission 008)',
    );
  }
  const params = new URL(url, 'http://localhost').searchParams;
  const queryTenant = params.get('tenantId');
  if (queryTenant && queryTenant !== callerTenant) {
    return jsonError(
      403,
      'tenant_isolation_denied',
      `caller tenant ${callerTenant} cannot list grants for ${queryTenant}`,
    );
  }
  const grants = await cp.dataLayer.autonomyGrants.listForTenant(callerTenant, {
    ...(params.get('agentId') ? { agentId: params.get('agentId')! } : {}),
    ...(params.get('status') ? { status: params.get('status')! } : {}),
  });
  return { status: 200, body: { grants, count: grants.length } };
}

async function getAutonomyGrant(
  grantIdRaw: string,
  cp: ControlPlane,
  req: IncomingMessage,
): Promise<GatewayResponse> {
  const callerTenant = callerTenantId(req);
  if (!callerTenant) {
    return jsonError(
      403,
      'tenant_required',
      'x-aion-tenant-id header is required to read autonomy grants (Mission 008)',
    );
  }
  const parsed = AutonomyGrantId.safeParse(grantIdRaw);
  if (!parsed.success) {
    return jsonError(400, 'invalid_grant_id', 'grantId must be an AutonomyGrantId');
  }
  const grant = await cp.dataLayer.autonomyGrants.get(parsed.data);
  if (!grant) {
    return jsonError(404, 'grant_not_found', `grant ${grantIdRaw} not found`);
  }
  if (grant.tenantId !== callerTenant) {
    return jsonError(
      403,
      'tenant_isolation_denied',
      `caller tenant ${callerTenant} cannot read grant owned by ${grant.tenantId}`,
    );
  }
  return { status: 200, body: { grant } };
}

async function listSideEffects(
  url: string,
  cp: ControlPlane,
  req: IncomingMessage,
): Promise<GatewayResponse> {
  const callerTenant = callerTenantId(req);
  if (!callerTenant) {
    return jsonError(
      403,
      'tenant_required',
      'x-aion-tenant-id header is required to list side-effects (Mission 009)',
    );
  }
  const params = new URL(url, 'http://localhost').searchParams;
  const queryTenant = params.get('tenantId');
  if (queryTenant && queryTenant !== callerTenant) {
    return jsonError(
      403,
      'tenant_isolation_denied',
      `caller tenant ${callerTenant} cannot list side-effects for ${queryTenant}`,
    );
  }
  const effects = await cp.dataLayer.externalSideEffects.listForTenant(callerTenant, {
    ...(params.get('executionId') ? { executionId: params.get('executionId')! } : {}),
  });
  return { status: 200, body: { sideEffects: effects, count: effects.length } };
}

async function getSideEffect(
  sideEffectIdRaw: string,
  cp: ControlPlane,
  req: IncomingMessage,
): Promise<GatewayResponse> {
  const callerTenant = callerTenantId(req);
  if (!callerTenant) {
    return jsonError(
      403,
      'tenant_required',
      'x-aion-tenant-id header is required to read side-effects (Mission 009)',
    );
  }
  const effect = await cp.dataLayer.externalSideEffects.get(sideEffectIdRaw);
  if (!effect) {
    return jsonError(404, 'side_effect_not_found', `side-effect ${sideEffectIdRaw} not found`);
  }
  if (effect.tenantId !== callerTenant) {
    return jsonError(
      403,
      'tenant_isolation_denied',
      `caller tenant ${callerTenant} cannot read side-effect owned by ${effect.tenantId}`,
    );
  }
  return { status: 200, body: { sideEffect: effect } };
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

// ── IE-001 Implementation Engine ────────────────────────────────────────────

async function loadImplementationForTenant(
  caseIdRaw: string,
  callerTenant: string,
  cp: ControlPlane,
): Promise<{ caseRecord: ImplementationCase } | GatewayResponse> {
  const parsed = ImplementationCaseId.safeParse(caseIdRaw);
  if (!parsed.success) {
    return jsonError(
      400,
      'invalid_case_id',
      'caseId must be an ImplementationCaseId (icase_…)',
    );
  }
  const caseRecord = await cp.dataLayer.implementationCases.get(parsed.data);
  if (!caseRecord) {
    return jsonError(404, 'case_not_found', `implementation case ${caseIdRaw} not found`);
  }
  if (caseRecord.tenantId !== callerTenant) {
    return jsonError(
      403,
      'tenant_isolation_denied',
      `caller tenant ${callerTenant} cannot access case owned by ${caseRecord.tenantId}`,
    );
  }
  return { caseRecord };
}

async function createImplementation(
  body: unknown,
  cp: ControlPlane,
  req: IncomingMessage,
): Promise<GatewayResponse> {
  const callerTenant = callerTenantId(req);
  if (!callerTenant) {
    return jsonError(
      403,
      'tenant_required',
      'x-aion-tenant-id header is required to create implementation cases (IE-001)',
    );
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonError(400, 'invalid_body', 'implementation body must be a JSON object');
  }
  const raw = body as Record<string, unknown>;
  if (raw.tenantId && raw.tenantId !== callerTenant) {
    return jsonError(
      403,
      'tenant_isolation_denied',
      `caller tenant ${callerTenant} cannot create cases for ${String(raw.tenantId)}`,
    );
  }
  try {
    const caseRecord = createImplementationCase({
      tenantId: callerTenant,
      clientRef: String(raw.clientRef ?? ''),
      clientName: String(raw.clientName ?? ''),
      ownerId: String(raw.ownerId ?? ''),
      ...(typeof raw.commercialStatus === 'string'
        ? { commercialStatus: raw.commercialStatus as never }
        : {}),
      ...(typeof raw.nextAction === 'string' ? { nextAction: raw.nextAction } : {}),
      ...(raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)
        ? { metadata: raw.metadata as Record<string, unknown> }
        : {}),
    });
    await cp.dataLayer.implementationCases.save(caseRecord);
    return { status: 201, body: { case: caseRecord } };
  } catch (err) {
    return jsonError(
      400,
      'invalid_implementation',
      err instanceof Error ? err.message : 'failed to create implementation case',
    );
  }
}

async function listImplementations(
  url: string,
  cp: ControlPlane,
  req: IncomingMessage,
): Promise<GatewayResponse> {
  const callerTenant = callerTenantId(req);
  if (!callerTenant) {
    return jsonError(
      403,
      'tenant_required',
      'x-aion-tenant-id header is required to list implementation cases (IE-001)',
    );
  }
  const params = new URL(url, 'http://localhost').searchParams;
  const queryTenant = params.get('tenantId');
  if (queryTenant && queryTenant !== callerTenant) {
    return jsonError(
      403,
      'tenant_isolation_denied',
      `caller tenant ${callerTenant} cannot list cases for ${queryTenant}`,
    );
  }
  const deliveryStatus = params.get('deliveryStatus') ?? undefined;
  const cases = await cp.dataLayer.implementationCases.listForTenant(callerTenant, {
    deliveryStatus: deliveryStatus ?? undefined,
  });
  return { status: 200, body: { cases, count: cases.length } };
}

async function getImplementation(
  caseIdRaw: string,
  cp: ControlPlane,
  req: IncomingMessage,
): Promise<GatewayResponse> {
  const callerTenant = callerTenantId(req);
  if (!callerTenant) {
    return jsonError(
      403,
      'tenant_required',
      'x-aion-tenant-id header is required to read implementation cases (IE-001)',
    );
  }
  const loaded = await loadImplementationForTenant(caseIdRaw, callerTenant, cp);
  if ('status' in loaded) return loaded;
  return { status: 200, body: { case: loaded.caseRecord } };
}

async function submitImplementationIntake(
  caseIdRaw: string,
  body: unknown,
  cp: ControlPlane,
  req: IncomingMessage,
): Promise<GatewayResponse> {
  const callerTenant = callerTenantId(req);
  if (!callerTenant) {
    return jsonError(
      403,
      'tenant_required',
      'x-aion-tenant-id header is required to submit intake (IE-001)',
    );
  }
  const loaded = await loadImplementationForTenant(caseIdRaw, callerTenant, cp);
  if ('status' in loaded) return loaded;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonError(400, 'invalid_body', 'intake body must be a JSON object');
  }
  const intakeParsed = ImplementationIntake.safeParse(body);
  if (!intakeParsed.success) {
    return jsonError(
      400,
      'invalid_intake',
      intakeParsed.error.issues.map((i) => i.message).join('; '),
    );
  }
  try {
    const updated = applyIntake(loaded.caseRecord, intakeParsed.data);
    await cp.dataLayer.implementationCases.save(updated);
    return {
      status: 200,
      body: {
        case: updated,
        recommendation: updated.recommendation,
      },
    };
  } catch (err) {
    return jsonError(
      409,
      'illegal_transition',
      err instanceof Error ? err.message : 'intake rejected',
    );
  }
}

async function upsertImplementationBlueprint(
  caseIdRaw: string,
  body: unknown,
  cp: ControlPlane,
  req: IncomingMessage,
): Promise<GatewayResponse> {
  const callerTenant = callerTenantId(req);
  if (!callerTenant) {
    return jsonError(
      403,
      'tenant_required',
      'x-aion-tenant-id header is required to draft blueprints (IE-001)',
    );
  }
  const loaded = await loadImplementationForTenant(caseIdRaw, callerTenant, cp);
  if ('status' in loaded) return loaded;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonError(400, 'invalid_body', 'blueprint body must be a JSON object');
  }
  const raw = body as Record<string, unknown>;
  const packageParsed = ImplementationPackage.safeParse(
    raw.packageKey ??
      loaded.caseRecord.recommendation?.humanOverridePackage ??
      loaded.caseRecord.recommendation?.recommendedPackage,
  );
  if (!packageParsed.success) {
    return jsonError(
      400,
      'invalid_package',
      'packageKey required (or complete intake with a recommendable package first)',
    );
  }
  const deliveryOwner =
    typeof raw.deliveryOwner === 'string' && raw.deliveryOwner.trim()
      ? raw.deliveryOwner
      : loaded.caseRecord.ownerId;

  try {
    let blueprint: SolutionBlueprint;
    if (raw.blueprint && typeof raw.blueprint === 'object') {
      const drafted = draftBlueprintFromCase({
        caseRecord: loaded.caseRecord,
        packageKey: packageParsed.data,
        deliveryOwner,
      });
      const merged = SolutionBlueprint.safeParse({
        ...drafted,
        ...(raw.blueprint as object),
        version: drafted.version,
        packageKey: packageParsed.data,
        status: 'draft',
        approvedAt: undefined,
        approvedBy: undefined,
        updatedAt: new Date().toISOString(),
      });
      if (!merged.success) {
        return jsonError(
          400,
          'invalid_blueprint',
          merged.error.issues.map((i) => i.message).join('; '),
        );
      }
      blueprint = merged.data;
    } else {
      blueprint = draftBlueprintFromCase({
        caseRecord: loaded.caseRecord,
        packageKey: packageParsed.data,
        deliveryOwner,
        overrides:
          raw.overrides && typeof raw.overrides === 'object'
            ? (raw.overrides as Partial<SolutionBlueprint>)
            : undefined,
      });
    }
    const updated = attachBlueprintDraft(loaded.caseRecord, blueprint);
    await cp.dataLayer.implementationCases.save(updated);
    return { status: 200, body: { case: updated, blueprint: updated.blueprint } };
  } catch (err) {
    return jsonError(
      409,
      'illegal_transition',
      err instanceof Error ? err.message : 'blueprint draft rejected',
    );
  }
}

async function approveImplementationBlueprint(
  caseIdRaw: string,
  body: unknown,
  cp: ControlPlane,
  req: IncomingMessage,
): Promise<GatewayResponse> {
  const callerTenant = callerTenantId(req);
  if (!callerTenant) {
    return jsonError(
      403,
      'tenant_required',
      'x-aion-tenant-id header is required to approve blueprints (IE-001)',
    );
  }
  const loaded = await loadImplementationForTenant(caseIdRaw, callerTenant, cp);
  if ('status' in loaded) return loaded;
  const raw =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const approvedBy =
    typeof raw.approvedBy === 'string' && raw.approvedBy.trim()
      ? raw.approvedBy
      : loaded.caseRecord.ownerId;
  try {
    const updated = approveBlueprint(loaded.caseRecord, approvedBy);
    await cp.dataLayer.implementationCases.save(updated);
    return { status: 200, body: { case: updated, blueprint: updated.blueprint } };
  } catch (err) {
    return jsonError(
      409,
      'illegal_transition',
      err instanceof Error ? err.message : 'blueprint approval rejected',
    );
  }
}

// ── IE-002 Provisioning + Activation Gate ───────────────────────────────────

async function startImplementationProvisioning(
  caseIdRaw: string,
  body: unknown,
  cp: ControlPlane,
  req: IncomingMessage,
): Promise<GatewayResponse> {
  const callerTenant = callerTenantId(req);
  if (!callerTenant) {
    return jsonError(
      403,
      'tenant_required',
      'x-aion-tenant-id header is required to start provisioning (IE-002)',
    );
  }
  const loaded = await loadImplementationForTenant(caseIdRaw, callerTenant, cp);
  if ('status' in loaded) return loaded;
  const raw =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const startedBy =
    typeof raw.startedBy === 'string' && raw.startedBy.trim()
      ? raw.startedBy
      : loaded.caseRecord.ownerId;
  try {
    const updated = startProvisioning(loaded.caseRecord, startedBy);
    await cp.dataLayer.implementationCases.save(updated);
    return { status: 200, body: { case: updated } };
  } catch (err) {
    return jsonError(
      409,
      'illegal_transition',
      err instanceof Error ? err.message : 'start provisioning rejected',
    );
  }
}

async function updateImplementationProvisioningStep(
  caseIdRaw: string,
  stepKeyRaw: string,
  body: unknown,
  cp: ControlPlane,
  req: IncomingMessage,
): Promise<GatewayResponse> {
  const callerTenant = callerTenantId(req);
  if (!callerTenant) {
    return jsonError(
      403,
      'tenant_required',
      'x-aion-tenant-id header is required to update provisioning steps (IE-002)',
    );
  }
  const loaded = await loadImplementationForTenant(caseIdRaw, callerTenant, cp);
  if ('status' in loaded) return loaded;
  const keyParsed = ProvisioningStepKey.safeParse(stepKeyRaw);
  if (!keyParsed.success) {
    return jsonError(400, 'invalid_step', `unknown provisioning step ${stepKeyRaw}`);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonError(400, 'invalid_body', 'step body must be a JSON object');
  }
  const raw = body as Record<string, unknown>;
  const statusParsed = ProvisioningStepStatus.safeParse(raw.status);
  if (!statusParsed.success) {
    return jsonError(400, 'invalid_status', 'status must be a ProvisioningStepStatus');
  }
  try {
    const updated = updateProvisioningStep(loaded.caseRecord, {
      key: keyParsed.data,
      status: statusParsed.data,
      ...(typeof raw.evidence === 'string' ? { evidence: raw.evidence } : {}),
      ...(typeof raw.completedBy === 'string'
        ? { completedBy: raw.completedBy }
        : {}),
      ...(typeof raw.blockReason === 'string'
        ? { blockReason: raw.blockReason }
        : {}),
    });
    await cp.dataLayer.implementationCases.save(updated);
    return { status: 200, body: { case: updated } };
  } catch (err) {
    return jsonError(
      409,
      'illegal_transition',
      err instanceof Error ? err.message : 'step update rejected',
    );
  }
}

/**
 * Config-presence / evidence probes for P0 gates (GHL + model).
 * Does not auto-provision. When probe ok + confirm, marks step verified.
 */
function probeGhlReadiness(raw: Record<string, unknown>): {
  ok: boolean;
  evidence: string;
  missing: string[];
} {
  const apiKey =
    process.env.AION_GHL_API_KEY ||
    process.env.GHL_API_KEY ||
    (typeof raw.apiKeyPresent === 'boolean' && raw.apiKeyPresent ? 'provided' : '');
  const locationId =
    (typeof raw.locationId === 'string' && raw.locationId.trim()) ||
    process.env.AION_GHL_LOCATION_ID ||
    process.env.GHL_LOCATION_ID ||
    '';
  const missing: string[] = [];
  if (!apiKey) missing.push('ghl_api_key');
  if (!locationId) missing.push('ghl_location_id');
  const ok = missing.length === 0;
  return {
    ok,
    missing,
    evidence: ok
      ? `GHL readiness probe ok — locationId=${locationId} (api key present; Phase A live backend selectable; live CRM call not performed in probe)`
      : `GHL readiness probe failed — missing ${missing.join(', ')}`,
  };
}

function probeModelReadiness(raw: Record<string, unknown>): {
  ok: boolean;
  evidence: string;
  missing: string[];
} {
  const provider =
    (typeof raw.provider === 'string' && raw.provider.trim()) ||
    process.env.AION_MODEL_PROVIDER ||
    '';
  const hasKey = Boolean(
    process.env.OPENAI_API_KEY ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.AION_MODEL_API_KEY ||
      (typeof raw.apiKeyPresent === 'boolean' && raw.apiKeyPresent),
  );
  const missing: string[] = [];
  if (!provider && !hasKey) missing.push('model_provider_or_api_key');
  else if (!hasKey && provider) {
    // Provider named but no key in env — still allow explicit apiKeyPresent.
    if (!(typeof raw.apiKeyPresent === 'boolean' && raw.apiKeyPresent)) {
      missing.push('model_api_key');
    }
  }
  const ok = missing.length === 0;
  const resolvedProvider = provider || (hasKey ? 'env-configured' : 'none');
  return {
    ok,
    missing,
    evidence: ok
      ? `Model readiness probe ok — provider=${resolvedProvider} (capability call not performed)`
      : `Model readiness probe failed — missing ${missing.join(', ')}`,
  };
}

async function probeImplementationProvisioningStep(
  caseIdRaw: string,
  stepKeyRaw: string,
  body: unknown,
  cp: ControlPlane,
  req: IncomingMessage,
): Promise<GatewayResponse> {
  const callerTenant = callerTenantId(req);
  if (!callerTenant) {
    return jsonError(
      403,
      'tenant_required',
      'x-aion-tenant-id header is required for provisioning probes (IE-002)',
    );
  }
  const loaded = await loadImplementationForTenant(caseIdRaw, callerTenant, cp);
  if ('status' in loaded) return loaded;
  if (stepKeyRaw !== 'ghl_connection' && stepKeyRaw !== 'model_access') {
    return jsonError(
      400,
      'probe_unsupported',
      'only ghl_connection and model_access support probes in IE-002',
    );
  }
  const raw =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const probe =
    stepKeyRaw === 'ghl_connection' ? probeGhlReadiness(raw) : probeModelReadiness(raw);
  const completedBy =
    typeof raw.completedBy === 'string' && raw.completedBy.trim()
      ? raw.completedBy
      : loaded.caseRecord.ownerId;
  const confirm = raw.confirm === true;

  if (!confirm) {
    return {
      status: 200,
      body: {
        probe: { step: stepKeyRaw, ...probe },
        case: loaded.caseRecord,
        hint: 'Re-POST with confirm:true to record verified/blocked from probe result',
      },
    };
  }

  try {
    let working = loaded.caseRecord;
    if (working.deliveryStatus === 'blueprint_approved') {
      working = startProvisioning(working, completedBy);
    }
    const updated = updateProvisioningStep(working, {
      key: stepKeyRaw as 'ghl_connection' | 'model_access',
      status: probe.ok ? 'verified' : 'blocked',
      evidence: probe.evidence,
      completedBy,
      ...(probe.ok ? {} : { blockReason: probe.evidence }),
    });
    await cp.dataLayer.implementationCases.save(updated);
    return {
      status: 200,
      body: { probe: { step: stepKeyRaw, ...probe }, case: updated },
    };
  } catch (err) {
    return jsonError(
      409,
      'illegal_transition',
      err instanceof Error ? err.message : 'probe apply rejected',
    );
  }
}

async function markImplementationActivationReady(
  caseIdRaw: string,
  body: unknown,
  cp: ControlPlane,
  req: IncomingMessage,
): Promise<GatewayResponse> {
  const callerTenant = callerTenantId(req);
  if (!callerTenant) {
    return jsonError(
      403,
      'tenant_required',
      'x-aion-tenant-id header is required to mark activation ready (IE-002)',
    );
  }
  const loaded = await loadImplementationForTenant(caseIdRaw, callerTenant, cp);
  if ('status' in loaded) return loaded;
  const raw =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const markedBy =
    typeof raw.markedBy === 'string' && raw.markedBy.trim()
      ? raw.markedBy
      : loaded.caseRecord.ownerId;
  try {
    const updated = markActivationReady(loaded.caseRecord, markedBy);
    await cp.dataLayer.implementationCases.save(updated);
    return { status: 200, body: { case: updated } };
  } catch (err) {
    return jsonError(
      409,
      'illegal_transition',
      err instanceof Error ? err.message : 'activation ready rejected',
    );
  }
}

async function activateImplementationCase(
  caseIdRaw: string,
  body: unknown,
  cp: ControlPlane,
  req: IncomingMessage,
): Promise<GatewayResponse> {
  const callerTenant = callerTenantId(req);
  if (!callerTenant) {
    return jsonError(
      403,
      'tenant_required',
      'x-aion-tenant-id header is required to activate implementations (IE-002)',
    );
  }
  const loaded = await loadImplementationForTenant(caseIdRaw, callerTenant, cp);
  if ('status' in loaded) return loaded;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonError(400, 'invalid_body', 'activate body must include approvedBy');
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.approvedBy !== 'string' || !raw.approvedBy.trim()) {
    return jsonError(400, 'approved_by_required', 'activate requires approvedBy (human gate)');
  }
  try {
    const updated = activateImplementation(loaded.caseRecord, raw.approvedBy.trim());
    await cp.dataLayer.implementationCases.save(updated);
    return { status: 200, body: { case: updated } };
  } catch (err) {
    return jsonError(
      409,
      'illegal_transition',
      err instanceof Error ? err.message : 'activation rejected',
    );
  }
}

// ── Durable outcomes + revenue sessions (ADR-003 host surface) ──────────────

/**
 * Create a durable business outcome via Data. When an Execution Object already
 * exists for the run and has no outcomeId, link the minted id (field already
 * on the Execution Object contract — no schema invention).
 */
async function createOutcome(
  body: unknown,
  cp: ControlPlane,
): Promise<GatewayResponse> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonError(400, 'invalid_body', 'outcome body must be a JSON object');
  }
  const raw = body as Record<string, unknown>;
  const runParsed = RunId.safeParse(raw.runId);
  if (!runParsed.success) {
    return jsonError(400, 'invalid_run_id', 'runId must be a Core RunId');
  }
  let missionId: string | undefined;
  if (raw.missionId !== undefined) {
    const missionParsed = MissionId.safeParse(raw.missionId);
    if (!missionParsed.success) {
      return jsonError(400, 'invalid_mission_id', 'missionId must be a Core MissionId');
    }
    missionId = missionParsed.data;
  }
  let status: OutcomeStatus | undefined;
  if (raw.status !== undefined) {
    const statusParsed = OutcomeStatus.safeParse(raw.status);
    if (!statusParsed.success) {
      return jsonError(400, 'invalid_status', 'status must be a Core OutcomeStatus');
    }
    status = statusParsed.data;
  }
  if (raw.value !== undefined && typeof raw.value !== 'number') {
    return jsonError(400, 'invalid_value', 'value must be a number when provided');
  }
  if (raw.currency !== undefined && typeof raw.currency !== 'string') {
    return jsonError(400, 'invalid_currency', 'currency must be a string when provided');
  }
  if (
    raw.metadata !== undefined &&
    (typeof raw.metadata !== 'object' || raw.metadata === null || Array.isArray(raw.metadata))
  ) {
    return jsonError(400, 'invalid_metadata', 'metadata must be a JSON object when provided');
  }

  const outcome = await cp.dataLayer.outcomes.create({
    runId: runParsed.data,
    ...(missionId ? { missionId: missionId as never } : {}),
    ...(status ? { status } : {}),
    ...(typeof raw.outcomeType === 'string' ? { outcomeType: raw.outcomeType } : {}),
    ...(typeof raw.externalReference === 'string'
      ? { externalReference: raw.externalReference }
      : {}),
    ...(typeof raw.value === 'number' ? { value: raw.value } : {}),
    ...(typeof raw.currency === 'string' ? { currency: raw.currency } : {}),
    ...(typeof raw.measuredAt === 'string' ? { measuredAt: raw.measuredAt } : {}),
    ...(raw.metadata && typeof raw.metadata === 'object'
      ? { metadata: raw.metadata as Record<string, unknown> }
      : {}),
  });

  // Optional link — only when the execution row exists and outcomeId is unset.
  const execution = await cp.dataLayer.executions.getByRunId(outcome.runId);
  if (execution && !execution.outcomeId) {
    await cp.dataLayer.executions.save({
      ...execution,
      outcomeId: outcome.outcomeId,
      updatedAt: new Date().toISOString(),
    });
  }

  return { status: 201, body: { outcome } };
}

async function getOutcome(
  outcomeIdRaw: string,
  cp: ControlPlane,
): Promise<GatewayResponse> {
  const parsed = OutcomeId.safeParse(outcomeIdRaw);
  if (!parsed.success) {
    return jsonError(400, 'invalid_outcome_id', 'outcomeId must be a Core OutcomeId');
  }
  const outcome = await cp.dataLayer.outcomes.get(parsed.data);
  if (!outcome) {
    return jsonError(404, 'outcome_not_found', `outcome ${outcomeIdRaw} not found`);
  }
  return { status: 200, body: { outcome } };
}

async function listOutcomes(url: string, cp: ControlPlane): Promise<GatewayResponse> {
  const params = new URL(url, 'http://localhost').searchParams;
  const runIdRaw = params.get('runId');
  const missionIdRaw = params.get('missionId');
  if (runIdRaw && missionIdRaw) {
    return jsonError(
      400,
      'ambiguous_query',
      'provide exactly one of runId or missionId',
    );
  }
  if (runIdRaw) {
    const parsed = RunId.safeParse(runIdRaw);
    if (!parsed.success) {
      return jsonError(400, 'invalid_run_id', 'runId must be a Core RunId');
    }
    const outcomes = await cp.dataLayer.outcomes.listByRun(parsed.data);
    return { status: 200, body: { outcomes, count: outcomes.length } };
  }
  if (missionIdRaw) {
    const parsed = MissionId.safeParse(missionIdRaw);
    if (!parsed.success) {
      return jsonError(400, 'invalid_mission_id', 'missionId must be a Core MissionId');
    }
    const outcomes = await cp.dataLayer.outcomes.listByMission(parsed.data);
    return { status: 200, body: { outcomes, count: outcomes.length } };
  }
  return jsonError(
    400,
    'query_required',
    'GET /v1/outcomes requires runId or missionId',
  );
}

async function patchOutcome(
  outcomeIdRaw: string,
  body: unknown,
  cp: ControlPlane,
): Promise<GatewayResponse> {
  const parsed = OutcomeId.safeParse(outcomeIdRaw);
  if (!parsed.success) {
    return jsonError(400, 'invalid_outcome_id', 'outcomeId must be a Core OutcomeId');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonError(400, 'invalid_body', 'outcome patch must be a JSON object');
  }
  const raw = body as Record<string, unknown>;
  const patch: {
    status?: OutcomeStatus;
    outcomeType?: string;
    externalReference?: string;
    value?: number;
    currency?: string;
    measuredAt?: string;
    metadata?: Record<string, unknown>;
  } = {};
  if (raw.status !== undefined) {
    const statusParsed = OutcomeStatus.safeParse(raw.status);
    if (!statusParsed.success) {
      return jsonError(400, 'invalid_status', 'status must be a Core OutcomeStatus');
    }
    patch.status = statusParsed.data;
  }
  if (typeof raw.outcomeType === 'string') patch.outcomeType = raw.outcomeType;
  if (typeof raw.externalReference === 'string') {
    patch.externalReference = raw.externalReference;
  }
  if (raw.value !== undefined) {
    if (typeof raw.value !== 'number') {
      return jsonError(400, 'invalid_value', 'value must be a number when provided');
    }
    patch.value = raw.value;
  }
  if (typeof raw.currency === 'string') patch.currency = raw.currency;
  if (typeof raw.measuredAt === 'string') patch.measuredAt = raw.measuredAt;
  if (raw.metadata !== undefined) {
    if (typeof raw.metadata !== 'object' || raw.metadata === null || Array.isArray(raw.metadata)) {
      return jsonError(400, 'invalid_metadata', 'metadata must be a JSON object when provided');
    }
    patch.metadata = raw.metadata as Record<string, unknown>;
  }
  if (Object.keys(patch).length === 0) {
    return jsonError(400, 'empty_patch', 'outcome patch must include at least one field');
  }
  const outcome = await cp.dataLayer.outcomes.update(parsed.data, patch);
  return { status: 200, body: { outcome } };
}

async function createRevenueSession(
  body: unknown,
  cp: ControlPlane,
): Promise<GatewayResponse> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonError(400, 'invalid_body', 'revenue session body must be a JSON object');
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.sessionId !== 'string' || !raw.sessionId.trim()) {
    return jsonError(400, 'session_id_required', 'sessionId is required');
  }
  if (raw.checkpoint === undefined) {
    return jsonError(400, 'checkpoint_required', 'checkpoint is required');
  }
  const sessionId = raw.sessionId.trim();
  try {
    await cp.dataLayer.revenueSessions.create(sessionId, raw.checkpoint);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/duplicate|unique|already exists/i.test(message)) {
      return jsonError(409, 'session_exists', `revenue session ${sessionId} already exists`);
    }
    throw err;
  }
  const session = await cp.dataLayer.revenueSessions.get(sessionId);
  return { status: 201, body: { session } };
}

async function getRevenueSession(
  sessionId: string,
  cp: ControlPlane,
): Promise<GatewayResponse> {
  const session = await cp.dataLayer.revenueSessions.get(sessionId);
  if (!session) {
    return jsonError(404, 'session_not_found', `revenue session ${sessionId} not found`);
  }
  return { status: 200, body: { session } };
}

async function putRevenueSession(
  sessionId: string,
  body: unknown,
  cp: ControlPlane,
): Promise<GatewayResponse> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonError(400, 'invalid_body', 'revenue session body must be a JSON object');
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.revision !== 'number' || !Number.isInteger(raw.revision)) {
    return jsonError(400, 'revision_required', 'revision (integer) is required');
  }
  const existing = await cp.dataLayer.revenueSessions.get(sessionId);
  if (!existing) {
    return jsonError(404, 'session_not_found', `revenue session ${sessionId} not found`);
  }
  if (existing.finalRecord !== null && existing.finalRecord !== undefined) {
    return jsonError(409, 'session_finalized', `revenue session ${sessionId} is finalized`);
  }
  // Schema XOR: active rows keep checkpoint; finalization clears it.
  const finalRecord =
    raw.finalRecord !== undefined ? raw.finalRecord : existing.finalRecord;
  const checkpoint =
    raw.checkpoint !== undefined
      ? raw.checkpoint
      : raw.finalRecord !== undefined
        ? null
        : existing.checkpoint;

  try {
    await cp.dataLayer.revenueSessions.save({
      sessionId,
      checkpoint,
      finalRecord,
      revision: raw.revision,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/stale or finalized/i.test(message)) {
      return jsonError(409, 'stale_or_finalized', message);
    }
    throw err;
  }
  const session = await cp.dataLayer.revenueSessions.get(sessionId);
  return { status: 200, body: { session } };
}

async function listRevenueSessions(
  url: string,
  cp: ControlPlane,
): Promise<GatewayResponse> {
  const status = new URL(url, 'http://localhost').searchParams.get('status');
  if (status === 'active') {
    const sessionIds = await cp.dataLayer.revenueSessions.listActive();
    return { status: 200, body: { sessionIds, count: sessionIds.length } };
  }
  if (status === 'finalized') {
    const records = await cp.dataLayer.revenueSessions.listFinalized();
    return { status: 200, body: { records, count: records.length } };
  }
  return jsonError(
    400,
    'invalid_status',
    'GET /v1/revenue-sessions requires status=active|finalized',
  );
}
