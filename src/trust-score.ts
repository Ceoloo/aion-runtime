/**
 * Agent Trust Score wire-up (ADR-006).
 *
 * Runtime computes Trust Score on terminal Execution Objects and persists it
 * under `execution.metadata.agentTrustScore` (no Data migration). Optional
 * `auditTrace` event `trust.computed` records status + confidence.
 */
import {
  computeAgentTrustScore,
  type AgentActor,
  type AgentTrustScore,
  type AgentTrustScoreEvidence,
  type EvaluationResult,
  type ExecutionObject,
  type PolicyDecision,
} from '@aion/core';

const TERMINAL_EXECUTION_STATUSES = new Set([
  'succeeded',
  'failed',
  'denied',
  'cancelled',
]);

export function isTerminalExecutionStatus(status: string): boolean {
  return TERMINAL_EXECUTION_STATUSES.has(status);
}

export type TrustScoreAttachInput = {
  execution: ExecutionObject;
  agent?: AgentActor;
  authorizeDecision?: AgentTrustScoreEvidence['authorizeDecision'];
  /** Prefer structured PolicyDecision.checks when available. */
  policyDecision?: PolicyDecision;
  policyEvents?: AgentTrustScoreEvidence['policyEvents'];
  gateRequired?: boolean;
  approvalGranted?: boolean;
  approvalByHuman?: boolean;
  evaluation?: EvaluationResult | null;
  outcomeStatus?: AgentTrustScoreEvidence['outcomeStatus'];
  computedAt?: string;
};

function toolsFromAudit(execution: ExecutionObject): string[] {
  const tools: string[] = [];
  for (const entry of execution.auditTrace ?? []) {
    const detail = entry.detail ?? {};
    const toolId = detail['toolId'] ?? detail['tool'];
    if (typeof toolId === 'string' && toolId.length > 0) tools.push(toolId);
  }
  return tools;
}

function policyEventsFrom(
  input: TrustScoreAttachInput,
): AgentTrustScoreEvidence['policyEvents'] {
  if (input.policyEvents) return input.policyEvents;
  if (!input.policyDecision) return undefined;
  return input.policyDecision.checks.map((c) => ({
    kind: c.kind,
    decision: c.passed
      ? ('ALLOW' as const)
      : input.policyDecision!.decision === 'REQUIRE_APPROVAL'
        ? ('REQUIRE_APPROVAL' as const)
        : ('DENY' as const),
  }));
}

/**
 * Attach a computed AgentTrustScore to a terminal execution.
 * Non-terminal executions are returned unchanged.
 */
export function attachAgentTrustScore(
  input: TrustScoreAttachInput,
): ExecutionObject {
  const { execution } = input;
  if (!isTerminalExecutionStatus(execution.status)) return execution;

  const computedAt = input.computedAt ?? new Date().toISOString();
  const evaluation = input.evaluation ?? null;
  const evidence: AgentTrustScoreEvidence = {
    executionId: execution.executionId,
    computedAt,
    executionStatus: execution.status,
    ...(input.authorizeDecision
      ? { authorizeDecision: input.authorizeDecision }
      : input.policyDecision
        ? { authorizeDecision: input.policyDecision.decision }
        : execution.status === 'denied'
          ? { authorizeDecision: 'DENY' }
          : {}),
    ...(policyEventsFrom(input)
      ? { policyEvents: policyEventsFrom(input) }
      : {}),
    ...(input.gateRequired !== undefined
      ? { gateRequired: input.gateRequired }
      : {}),
    ...(input.approvalGranted !== undefined
      ? { approvalGranted: input.approvalGranted }
      : {}),
    ...(input.approvalByHuman !== undefined
      ? { approvalByHuman: input.approvalByHuman }
      : {}),
    evaluationPresent: evaluation != null,
    ...(evaluation
      ? {
          evaluationSuccess: evaluation.success,
          qualityScore: evaluation.qualityScore,
          policyEvents: [
            ...(policyEventsFrom(input) ?? []),
            ...evaluation.policyEvents.map((e) => ({
              kind: e.kind,
              decision: e.decision,
            })),
          ],
        }
      : {}),
    ...(input.outcomeStatus ? { outcomeStatus: input.outcomeStatus } : {}),
    toolsUsed: toolsFromAudit(execution),
    ...(input.agent
      ? { allowedTools: input.agent.allowedTools.map(String) }
      : {}),
    costUnits: execution.cost?.units ?? 0,
    ...(execution.cost?.estimatedDollars !== undefined
      ? { costUsd: execution.cost.estimatedDollars }
      : {}),
    ...(input.agent?.costBudget !== undefined
      ? { budgetCeiling: input.agent.costBudget }
      : {}),
  };

  const score: AgentTrustScore = computeAgentTrustScore(evidence);
  return {
    ...execution,
    metadata: {
      ...execution.metadata,
      agentTrustScore: score,
    },
    auditTrace: [
      ...execution.auditTrace,
      {
        at: computedAt,
        event: 'trust.computed',
        detail: {
          status: score.status,
          confidence: score.confidence,
        },
      },
    ],
    updatedAt: computedAt,
  };
}

/** Read persisted Trust Score from execution metadata (if present). */
export function readAgentTrustScore(
  execution: ExecutionObject,
): AgentTrustScore | undefined {
  const raw = execution.metadata?.['agentTrustScore'];
  if (!raw || typeof raw !== 'object') return undefined;
  return raw as AgentTrustScore;
}

/**
 * Compute Trust Score (when terminal), persist via `save`, return stored EO.
 */
export async function persistExecutionWithTrustScore(
  save: (execution: ExecutionObject) => Promise<void>,
  loadEvaluation: (
    executionId: string,
  ) => Promise<EvaluationResult | null | undefined>,
  input: TrustScoreAttachInput,
): Promise<ExecutionObject> {
  let evaluation = input.evaluation;
  if (
    evaluation === undefined &&
    isTerminalExecutionStatus(input.execution.status)
  ) {
    try {
      evaluation = (await loadEvaluation(input.execution.executionId)) ?? null;
    } catch {
      evaluation = null;
    }
  }
  const scored = attachAgentTrustScore({
    ...input,
    evaluation: evaluation ?? null,
  });
  await save(scored);
  return scored;
}
