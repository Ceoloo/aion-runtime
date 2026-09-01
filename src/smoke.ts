/**
 * Controlled Core-lifecycle self-check (aion-infra §45 smoke test).
 *
 * Runs ONE low-risk (R0), non-destructive command through the real orchestrator
 * against durable Postgres and asserts it completes. This proves the deployed
 * stack can execute a governed Core lifecycle end-to-end — command → policy →
 * execution → result → events/telemetry persisted — without touching anything
 * external or destructive (§45: "Do not trigger external communications or
 * destructive actions"). Test data is identifiable (actor/mission names carry a
 * clear marker) and lives only in the events/telemetry logs.
 */
import { createAgentActor } from '@aion/core';
import type { ControlPlane } from './control-plane.js';
import { SMOKE_CAPABILITY } from './control-plane.js';

export interface SmokeResult {
  ok: boolean;
  runId?: string;
  status: string;
  detail?: string;
}

export async function runSmoke(cp: ControlPlane): Promise<SmokeResult> {
  const actor = createAgentActor({
    name: 'InfraSmokeAgent',
    purpose: 'Phase 3 deployability self-check — non-destructive.',
    owner: 'aion-infra',
    permissions: [SMOKE_CAPABILITY],
    maxRiskLevel: 'R1',
  });

  // Every governed action is attributable to a registered actor (no ambient
  // authority — aion-docs/architecture/security-model.md); runs.actor_id is a
  // foreign key to actors, so the identity must be persisted first.
  await cp.dataLayer.actors.save(actor);

  const result = await cp.orchestrator.submit({
    name: 'infra-smoke-check',
    actor,
    capability: SMOKE_CAPABILITY,
    metadata: { source: 'aion-infra', kind: 'deployability-smoke' },
  });

  const ok = result.status === 'completed';
  return {
    ok,
    runId: result.run.runId,
    status: result.status,
    detail: ok ? undefined : `expected completed, got ${result.status}`,
  };
}
