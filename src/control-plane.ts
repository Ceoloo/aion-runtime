/**
 * Wires a REAL AION Core Orchestrator to AION Data's durable Postgres adapters.
 *
 * This is the whole point of the reference host: prove the Phase 3
 * infrastructure runs the ACTUAL Phase 1/2 workload unchanged — Core decides,
 * Data persists, PostgreSQL stores — with Core staying database-agnostic
 * (aion-core/README, aion-data/docs/architecture.md). The wiring mirrors
 * aion-data's own integration harness so there is one canonical assembly.
 */
import {
  Orchestrator,
  PolicyEngine,
  ExecutionRegistry,
  ApprovalGate,
  EventEmitter,
  Telemetry,
  systemClock,
  MockExecutionAdapter,
  capability,
} from '@aion/core';
import type { ExecutionAdapter, Capability } from '@aion/core';
import { createDataLayer, type DataLayer } from '@aion/data';
import type { RuntimeConfig } from './config.js';

/** The low-risk capability used by the boot self-check (aion-infra §45). */
export const SMOKE_CAPABILITY: Capability = capability('infra.smoke');

/** Mission 001 revenue capabilities (pipeline + live-call Copilot). */
export const MISSION_001_CAPABILITIES: Capability[] = [
  capability('revenue.lead.research'),
  capability('revenue.lead.enrich'),
  capability('revenue.lead.score'),
  capability('revenue.outreach.generate'),
  capability('revenue.followup.execute'),
  capability('revenue.context'),
  capability('revenue.extraction'),
  capability('revenue.conversationstate'),
  capability('revenue.signals'),
  capability('revenue.objection'),
  capability('revenue.nextaction'),
];

const DEFAULT_CAPABILITY_RISK: Record<string, 'R0' | 'R1' | 'R2'> = {
  'infra.smoke': 'R0',
  'revenue.lead.research': 'R1',
  'revenue.lead.enrich': 'R1',
  'revenue.lead.score': 'R1',
  'revenue.outreach.generate': 'R1',
  'revenue.followup.execute': 'R2',
  'revenue.context': 'R1',
  'revenue.extraction': 'R1',
  'revenue.conversationstate': 'R1',
  'revenue.signals': 'R1',
  'revenue.objection': 'R1',
  'revenue.nextaction': 'R1',
};

function defaultAdapters(): ExecutionAdapter[] {
  return [
    new MockExecutionAdapter({
      name: 'smoke-mock',
      capabilities: [SMOKE_CAPABILITY],
      cost: { units: 1 },
      output: { value: { ok: true }, message: 'smoke ok' },
    }),
    new MockExecutionAdapter({
      name: 'mission-001-mock',
      capabilities: MISSION_001_CAPABILITIES,
      // Non-zero cost so Week 3 cost/outcome attribution is observable.
      cost: { units: 5, tokens: 100 },
      output: { value: { stub: true, source: 'mission-001-mock' } },
      durationMs: 5,
    }),
  ];
}

export interface ControlPlane {
  dataLayer: DataLayer;
  orchestrator: Orchestrator;
  /** SELECT 1 against the app connection — the readiness probe's DB check. */
  checkDatabase(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Builds the durable control plane from validated config. Does NOT run
 * migrations — schema is applied by the separate migration job/identity
 * (aion-infra §17–18); the runtime only connects with the app role.
 */
export function buildControlPlane(
  config: RuntimeConfig,
  adapters: ExecutionAdapter[] = defaultAdapters(),
): ControlPlane {
  const dataLayer = createDataLayer({
    connectionString: config.databaseUrl,
    applicationName: `aion-runtime-${config.environment}`,
    ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
    // Bounded pool + timeouts so a stuck DB surfaces fast instead of hanging.
    maxConnections: 5,
    connectionTimeoutMs: 5000,
    statementTimeoutMs: 15000,
  });

  // Fail SAFE, not fatal: when the database drops (restart, failover, network
  // blip) node-postgres emits 'error' on idle pool clients. Without a listener
  // that event crashes the process. We swallow it with a non-secret structured
  // log so the runtime STAYS UP and merely reports not-ready until the DB
  // returns — readiness then recovers with no redeploy (aion-infra §62).
  dataLayer.pool.on('error', (err: Error) => {
    process.stderr.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'warn',
        service: 'aion-runtime',
        environment: config.environment,
        message: 'db_pool_error',
        reason: 'database_connection_lost',
        error: err.message,
      })}\n`,
    );
  });

  const clock = systemClock;
  const events = new EventEmitter(dataLayer.events, clock);
  const telemetry = new Telemetry(dataLayer.telemetry, clock);
  // R2 capabilities must be explicitly gated — risk classification alone does
  // not pause for approval (PolicyEngine.requiresApproval). Catalog marks
  // revenue.followup.execute as approvalRequired; honor that here.
  const gatedCapabilities = MISSION_001_CAPABILITIES.filter(
    (cap) => DEFAULT_CAPABILITY_RISK[cap] === 'R2',
  );
  const policyEngine = new PolicyEngine(
    {
      risk: { capabilityRisk: DEFAULT_CAPABILITY_RISK },
      gatedCapabilities,
    },
    { clock },
  );
  const approvalGate = new ApprovalGate(dataLayer.approvals, clock);

  const registry = new ExecutionRegistry();
  for (const adapter of adapters) registry.register(adapter);

  const orchestrator = new Orchestrator({
    policyEngine,
    registry,
    approvalGate,
    runRepository: dataLayer.runs,
    events,
    telemetry,
    clock,
  });

  return {
    dataLayer,
    orchestrator,
    async checkDatabase(): Promise<void> {
      await dataLayer.pool.query('SELECT 1');
    },
    close: () => dataLayer.close(),
  };
}
