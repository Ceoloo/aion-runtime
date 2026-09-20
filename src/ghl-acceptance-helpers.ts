/**
 * Shared helpers for GHL acceptance matrices (fixtures + live).
 * Strict ledger evidence: output sideEffectId alone is never enough.
 */
import type { Actor } from '@aion/core';
import type { RuntimeClient } from './clients/runtime-client.js';

export const SYNTHETIC_BUSINESS_VALUE_USD = 1500;
/** Local revenue-workflow baseline cost units (note write path). */
export const LOCAL_BASELINE_COST_UNITS = 4;

export interface CommandResponse {
  status?: string;
  run?: { runId?: string; state?: string; approvalId?: string; requestId?: string };
  execution?: {
    executionId?: string;
    status?: string;
    cost?: { units?: number };
    revenueAttributed?: number | string;
    outcomeId?: string;
  };
  result?: {
    status?: string;
    output?: Record<string, unknown>;
    error?: { code?: string; message?: string };
  };
  decision?: { decision?: string; reason?: string };
  outcomeReference?: { outcomeId?: string };
}

export function fail(pass: string, msg: string): never {
  console.error(`[FAIL ${pass}] ${msg}`);
  process.exit(1);
}

export function ok(pass: string, msg: string): void {
  console.log(`[PASS ${pass}] ${msg}`);
}

export function succeeded(res: CommandResponse): boolean {
  return (
    res.result?.status === 'succeeded' ||
    res.status === 'succeeded' ||
    res.status === 'completed'
  );
}

export function awaiting(res: CommandResponse): boolean {
  return (
    res.status === 'awaiting_approval' ||
    res.run?.state === 'awaiting_approval' ||
    res.decision?.decision === 'REQUIRE_APPROVAL'
  );
}

export function denied(res: CommandResponse): boolean {
  return res.status === 'denied' || res.decision?.decision === 'DENY';
}

export function backendOf(res: CommandResponse): string {
  return String(res.result?.output?.['backend'] ?? '');
}

export function errorCode(res: CommandResponse): string {
  return (
    res.result?.error?.code ?? String(res.result?.output?.['errorCode'] ?? '')
  );
}

export function externalId(res: CommandResponse): string {
  const out = res.result?.output ?? {};
  const id =
    out['externalResourceId'] ??
    (out['body'] as Record<string, unknown> | undefined)?.['id'];
  return typeof id === 'string' ? id : '';
}

export async function approveIfNeeded(
  client: RuntimeClient,
  res: CommandResponse,
  human: Actor,
  note: string,
): Promise<CommandResponse> {
  if (!awaiting(res)) return res;
  const approvalId = res.run?.approvalId;
  if (!approvalId) fail('gate', `missing approvalId: ${JSON.stringify(res).slice(0, 400)}`);
  return (await client.decideApproval(approvalId, {
    approve: true,
    decidedBy: human.actorId,
    actor: human,
    note,
  })) as CommandResponse;
}

/**
 * Require a Postgres-persisted side-effect row linked to execution + provider id.
 * Output-only sideEffectId is insufficient.
 */
export async function assertPersistedSideEffect(
  client: RuntimeClient,
  tenantId: string,
  pass: string,
  opts: {
    sideEffectId: string;
    executionId: string;
    expectReplay?: boolean;
  },
): Promise<{
  sideEffectId: string;
  executionId: string;
  externalResourceId: string;
  serviceKey: string;
  idempotencyKey: string;
}> {
  if (!opts.sideEffectId) fail(pass, 'missing sideEffectId');
  if (!opts.executionId) fail(pass, 'missing executionId');

  const detail = (await client.getSideEffect(opts.sideEffectId, {
    tenantId,
  })) as {
    sideEffect?: {
      sideEffectId?: string;
      executionId?: string;
      externalResourceId?: string;
      serviceKey?: string;
      idempotencyKey?: string;
      status?: string;
    };
  };
  const row = detail.sideEffect;
  if (!row?.sideEffectId) {
    fail(
      pass,
      `side-effect ${opts.sideEffectId} not persisted in Postgres ledger (output-only id is not evidence)`,
    );
  }
  if (row.executionId !== opts.executionId) {
    fail(
      pass,
      `ledger executionId mismatch: expected ${opts.executionId}, got ${row.executionId}`,
    );
  }
  if (!row.externalResourceId) {
    fail(pass, `ledger row ${opts.sideEffectId} missing externalResourceId`);
  }
  if (!row.serviceKey) {
    fail(pass, `ledger row ${opts.sideEffectId} missing serviceKey`);
  }
  if (!row.idempotencyKey) {
    fail(pass, `ledger row ${opts.sideEffectId} missing idempotencyKey`);
  }

  const exe = (await client.getExecution(opts.executionId, { tenantId })) as {
    execution?: { executionId?: string };
    executionId?: string;
  };
  const exeId = exe.execution?.executionId ?? exe.executionId;
  if (exeId !== opts.executionId) {
    fail(pass, `execution ${opts.executionId} not loadable from Postgres`);
  }

  return {
    sideEffectId: row.sideEffectId!,
    executionId: row.executionId!,
    externalResourceId: row.externalResourceId!,
    serviceKey: row.serviceKey!,
    idempotencyKey: row.idempotencyKey!,
  };
}

export async function countSideEffectsByIdempotencyKey(
  client: RuntimeClient,
  tenantId: string,
  idempotencyKey: string,
): Promise<number> {
  const listed = (await client.listSideEffects({ tenantId })) as {
    sideEffects?: Array<{ idempotencyKey?: string }>;
  };
  return (listed.sideEffects ?? []).filter(
    (s) => s.idempotencyKey === idempotencyKey,
  ).length;
}
