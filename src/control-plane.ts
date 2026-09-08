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
  MissionOrchestrator,
  PolicyEngine,
  ExecutionRegistry,
  ApprovalGate,
  EventEmitter,
  Telemetry,
  systemClock,
  MockExecutionAdapter,
  capability,
} from '@aion/core';
import type {
  ExecutionAdapter,
  Capability,
  RoutingOverride,
  RiskLevel,
} from '@aion/core';
import { createDataLayer, type DataLayer } from '@aion/data';
import type { RuntimeConfig } from './config.js';
import { GhlAdapter, MISSION_009_CAPABILITIES, createGhlBackendFromEnv } from './adapters/ghl/index.js';

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

/** Mission 002 Media/G-Star capabilities — same Runtime, different domain. */
export const MISSION_002_CAPABILITIES: Capability[] = [
  capability('media.trend.research'),
  capability('media.concept.generate'),
  capability('media.script.generate'),
  capability('media.asset.produce'),
  capability('media.post.publish'),
  capability('media.performance.ingest'),
];

/** Mission 004 client-money path — legacy GHL upsert capability (mapped by GhlAdapter). */
export const MISSION_004_CAPABILITIES: Capability[] = [
  capability('client.ghl.contact.upsert'),
];

export { MISSION_009_CAPABILITIES };

const DEFAULT_CAPABILITY_RISK: Record<string, RiskLevel> = {
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
  'media.trend.research': 'R1',
  'media.concept.generate': 'R1',
  'media.script.generate': 'R1',
  'media.asset.produce': 'R1',
  'media.post.publish': 'R2',
  'media.performance.ingest': 'R1',
  // M004 legacy mock capability — remains R1 so prior proofs stay green.
  'client.ghl.contact.upsert': 'R1',
  // Mission 009 CRM / GHL
  'crm.contact.read': 'R1',
  'crm.contact.search': 'R1',
  'crm.contact.enrich': 'R1',
  'crm.contact.update': 'R2',
  'crm.opportunity.read': 'R1',
  'crm.opportunity.search': 'R1',
  'crm.opportunity.create': 'R2',
  'crm.opportunity.update': 'R2',
  'crm.pipeline.read': 'R1',
  'crm.conversation.read': 'R1',
  'crm.appointment.read': 'R1',
  'crm.note.create': 'R1',
  'crm.task.create': 'R1',
  'crm.message.draft': 'R2',
  'crm.message.send': 'R3',
};

function baseMockAdapters(): ExecutionAdapter[] {
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
      cost: { units: 5, tokens: 100 },
      output: { value: { stub: true, source: 'mission-001-mock' } },
      durationMs: 5,
    }),
    new MockExecutionAdapter({
      name: 'mission-002-mock',
      capabilities: MISSION_002_CAPABILITIES,
      cost: { units: 7, tokens: 120 },
      output: { value: { stub: true, source: 'mission-002-mock', domain: 'media' } },
      durationMs: 5,
    }),
  ];
}

export interface ControlPlane {
  dataLayer: DataLayer;
  orchestrator: Orchestrator;
  /** Mission 004 sequential multi-step runner over durable missions/workflows. */
  missionOrchestrator: MissionOrchestrator;
  /** Shared policy engine — Runtime authorization boundary (Mission 003). */
  policyEngine: PolicyEngine;
  /**
   * Mission 007 — process-local manual routing overrides (recommendation-only).
   * Keyed by `${tenantId}|${capability||serviceKey||*}`. Not adaptive auto-routing.
   */
  routingOverrides: Map<string, RoutingOverride>;
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
  adapters?: ExecutionAdapter[],
): ControlPlane {
  const dataLayer = createDataLayer({
    connectionString: config.databaseUrl,
    applicationName: `aion-runtime-${config.environment}`,
    ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
    maxConnections: 5,
    connectionTimeoutMs: 5000,
    statementTimeoutMs: 15000,
  });

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

  const resolvedAdapters =
    adapters ??
    [
      ...baseMockAdapters(),
      // GHL adapter first among CRM handlers — governed external plane (M009).
      new GhlAdapter({
        sideEffects: dataLayer.externalSideEffects,
        backend: createGhlBackendFromEnv(),
      }),
    ];

  const clock = systemClock;
  const events = new EventEmitter(dataLayer.events, clock);
  const telemetry = new Telemetry(dataLayer.telemetry, clock);

  // Gate R2 catalog capabilities + all R3 (message.send always human-gated).
  const gatedCapabilities = [
    ...MISSION_001_CAPABILITIES,
    ...MISSION_002_CAPABILITIES,
    ...MISSION_009_CAPABILITIES,
  ].filter((cap) => {
    const risk = DEFAULT_CAPABILITY_RISK[cap];
    return risk === 'R2' || risk === 'R3';
  });

  const policyEngine = new PolicyEngine(
    {
      risk: { capabilityRisk: DEFAULT_CAPABILITY_RISK },
      gatedCapabilities,
    },
    { clock },
  );
  const approvalGate = new ApprovalGate(dataLayer.approvals, clock);

  const registry = new ExecutionRegistry();
  for (const adapter of resolvedAdapters) registry.register(adapter);

  const orchestrator = new Orchestrator({
    policyEngine,
    registry,
    approvalGate,
    runRepository: dataLayer.runs,
    events,
    telemetry,
    clock,
  });

  const missionOrchestrator = new MissionOrchestrator({
    orchestrator,
    missions: dataLayer.missions,
    workflows: dataLayer.workflows,
    clock,
  });

  return {
    dataLayer,
    orchestrator,
    missionOrchestrator,
    policyEngine,
    routingOverrides: new Map(),
    async checkDatabase(): Promise<void> {
      await dataLayer.pool.query('SELECT 1');
    },
    close: () => dataLayer.close(),
  };
}
