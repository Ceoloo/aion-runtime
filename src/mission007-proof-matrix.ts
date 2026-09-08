/**
 * Mission 007 proof matrix — Evaluations + Performance Routing on live Runtime.
 *
 * PASS A — Identical evaluation inputs produce identical rankings (replay).
 * PASS B — Insufficient sample size cannot automatically win.
 * PASS C — Failed / policy-denying executions are penalized vs clean successes.
 * PASS D — Cross-tenant DENY + missing tenant header DENY on eval/scorecard/recommend.
 * PASS E — Manual override sets recommended; fallback remains deterministic.
 *
 * Invoked by scripts/mission007-proof-matrix.sh against a live Runtime + Postgres.
 */
import {
  ROUTING_MIN_SAMPLES,
  formatServiceKey,
  newExecutionId,
} from '@aion/core';
import { RuntimeClient, RuntimeApiError } from './clients/runtime-client.js';

const BASE_URL =
  process.env.AION_RUNTIME_URL ?? `http://127.0.0.1:${process.env.PORT ?? '8097'}`;
const TENANT = 'aion-systems';
const OTHER_TENANT = 'aion-media';
const CAPABILITY = 'revenue.call.analyze';
const SERVICE_KEY = formatServiceKey(CAPABILITY, 1);

function fail(pass: string, msg: string): never {
  console.error(`[FAIL ${pass}] ${msg}`);
  process.exit(1);
}

function ok(pass: string, msg: string): void {
  console.log(`[PASS ${pass}] ${msg}`);
}

interface RecommendationBody {
  recommendation: {
    rankings: Array<{
      rank: number;
      scorecard: {
        eligible: boolean;
        rankingScore: number;
        candidate: { provider?: string; model?: string };
      };
    }>;
    recommended?: { provider?: string; model?: string };
    fallback: string;
    override?: { reason: string };
  };
}

async function seedProvider(
  client: RuntimeClient,
  provider: string,
  n: number,
  opts: {
    success: boolean;
    quality: number;
    cost: number;
    latencyMs: number;
    deny?: boolean;
    tenantId?: string;
  },
): Promise<void> {
  for (let i = 0; i < n; i++) {
    await client.createEvaluation(
      {
        executionId: newExecutionId(),
        serviceKey: SERVICE_KEY,
        serviceVersion: 1,
        provider,
        model: `${provider}-model`,
        workflowVersion: '1.0.0',
        qualityScore: opts.quality,
        success: opts.success,
        latencyMs: opts.latencyMs,
        totalCost: opts.cost,
        humanIntervention: false,
        policyEvents: opts.deny
          ? [{ kind: 'policy.denied', decision: 'DENY', detail: 'proof' }]
          : [],
        economicValue: opts.success ? 10 : 0,
        metadata: { capability: CAPABILITY },
        evaluatedAt: '2026-09-06T23:00:00.000Z',
      },
      { tenantId: opts.tenantId ?? TENANT },
    );
  }
}

async function main(): Promise<void> {
  const client = new RuntimeClient({ baseUrl: BASE_URL, tenantId: TENANT });
  // Unique provider names per run so prior proof residue cannot inflate sample
  // counts (certify:platform-v020 re-runs M007 on a shared DB).
  const run = `r${Date.now().toString(36)}`;
  const PA = `provider-a-${run}`;
  const PB = `provider-b-${run}`;
  const PC = `provider-c-${run}`;
  const PD = `provider-dirty-${run}`;

  // ── PASS A + B + C seed ─────────────────────────────────────────────────
  await seedProvider(client, PA, ROUTING_MIN_SAMPLES, {
    success: true,
    quality: 0.94,
    cost: 0.18,
    latencyMs: 1900,
  });
  await seedProvider(client, PB, ROUTING_MIN_SAMPLES, {
    success: true,
    quality: 0.96,
    cost: 0.42,
    latencyMs: 3100,
  });
  await seedProvider(client, PC, ROUTING_MIN_SAMPLES - 1, {
    success: true,
    quality: 0.99,
    cost: 0.05,
    latencyMs: 800,
  });
  await seedProvider(client, PD, ROUTING_MIN_SAMPLES, {
    success: false,
    quality: 0.4,
    cost: 0.2,
    latencyMs: 2500,
    deny: true,
  });

  const rec1 = (await client.recommendRoute({
    tenantId: TENANT,
    capability: CAPABILITY,
  })) as RecommendationBody;
  const rec2 = (await client.recommendRoute({
    tenantId: TENANT,
    capability: CAPABILITY,
  })) as RecommendationBody;

  // Rankings include historical providers — compare only this run's cards for
  // replay identity of scores for our seeded providers.
  const slice = (body: RecommendationBody) =>
    body.recommendation.rankings
      .filter((r) =>
        [PA, PB, PC, PD].includes(String(r.scorecard.candidate.provider ?? '')),
      )
      .map((r) => ({
        provider: r.scorecard.candidate.provider,
        score: r.scorecard.rankingScore,
        eligible: r.scorecard.eligible,
      }))
      .sort((a, b) => String(a.provider).localeCompare(String(b.provider)));
  const ranks1 = slice(rec1);
  const ranks2 = slice(rec2);
  if (JSON.stringify(ranks1) !== JSON.stringify(ranks2)) {
    fail('A', `rankings not identical on replay: ${JSON.stringify(ranks1)} vs ${JSON.stringify(ranks2)}`);
  }
  if (rec1.recommendation.fallback !== 'deterministic') {
    fail('A', 'fallback must be deterministic');
  }
  ok('A', `identical rankings on replay (run=${run})`);

  const cCard = rec1.recommendation.rankings.find(
    (r) => r.scorecard.candidate.provider === PC,
  );
  if (!cCard || cCard.scorecard.eligible) {
    fail('B', `${PC} with insufficient samples must be ineligible`);
  }
  if (rec1.recommendation.recommended?.provider === PC) {
    fail('B', `insufficient-sample ${PC} must not win`);
  }
  ok('B', `${PC} ineligible (samples < ${ROUTING_MIN_SAMPLES})`);

  if (rec1.recommendation.recommended?.provider === PD) {
    fail('C', `policy-denying / failing ${PD} must not win`);
  }
  const dirty = rec1.recommendation.rankings.find(
    (r) => r.scorecard.candidate.provider === PD,
  );
  const clean = rec1.recommendation.rankings.find(
    (r) => r.scorecard.candidate.provider === PA,
  );
  if (!dirty || !clean) fail('C', 'missing dirty/clean scorecards');
  if (dirty.scorecard.rankingScore >= clean.scorecard.rankingScore) {
    fail(
      'C',
      `dirty score ${dirty.scorecard.rankingScore} should be < clean ${clean.scorecard.rankingScore}`,
    );
  }
  ok('C', 'failed/policy-denying executions penalized vs clean successes');

  // ── PASS D tenant isolation ─────────────────────────────────────────────
  const noHeader = await fetch(
    `${BASE_URL}/v1/routing/recommend?capability=${encodeURIComponent(CAPABILITY)}`,
  );
  if (noHeader.status !== 403) {
    fail('D', `missing tenant header expected 403, got ${noHeader.status}`);
  }
  const other = (await client.recommendRoute({
    tenantId: OTHER_TENANT,
    capability: CAPABILITY,
  })) as RecommendationBody;
  if ((other.recommendation.rankings ?? []).length !== 0) {
    fail('D', 'aion-media must not see aion-systems scorecards');
  }
  try {
    await client.createEvaluation(
      {
        executionId: newExecutionId(),
        qualityScore: 0.5,
        success: true,
        latencyMs: 1,
        totalCost: 1,
        tenantId: OTHER_TENANT,
      },
      { tenantId: TENANT },
    );
    fail('D', 'cross-tenant evaluation write should DENY');
  } catch (err) {
    if (!(err instanceof RuntimeApiError) || err.status !== 403) {
      fail('D', `cross-tenant write expected 403, got ${String(err)}`);
    }
  }
  ok('D', 'tenant header required + cross-tenant DENY on eval/recommend');

  // ── PASS E manual override ──────────────────────────────────────────────
  // Prefer overriding to PB among this run's clean providers.
  const overrideTarget = PB;
  await client.setRoutingOverride(
    {
      capability: CAPABILITY,
      override: {
        candidate: { provider: overrideTarget, model: `${overrideTarget}-model` },
        reason: 'ops prefer override target for proof',
        setBy: 'human:m007-proof',
        setAt: '2026-09-06T23:00:00.000Z',
      },
    },
    { tenantId: TENANT },
  );
  const overridden = (await client.recommendRoute({
    tenantId: TENANT,
    capability: CAPABILITY,
  })) as RecommendationBody;
  if (overridden.recommendation.recommended?.provider !== overrideTarget) {
    fail(
      'E',
      `override did not win (got ${overridden.recommendation.recommended?.provider})`,
    );
  }
  if (overridden.recommendation.fallback !== 'deterministic') {
    fail('E', 'fallback must remain deterministic after override');
  }
  if (!overridden.recommendation.override?.reason) {
    fail('E', 'override payload missing on recommendation');
  }
  const firstEligible = overridden.recommendation.rankings.find(
    (r) => r.scorecard.eligible,
  );
  if (!firstEligible) fail('E', 'no eligible ranking after override');
  ok(
    'E',
    `manual override → ${overrideTarget}; fallback=deterministic; scorecards present (${firstEligible.scorecard.candidate.provider})`,
  );

  console.log('[PROOF] Mission 007 matrix A–E complete');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
