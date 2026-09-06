/**
 * Grok (and peer model runtimes) as clients of AION Runtime.
 *
 * Grok is elastic execution capacity — not AION's OS. This helper builds a
 * governed agent actor and submits work through the Runtime Execution Gateway
 * using Service Catalog keys (Mission 001). Never call tools directly from here.
 */
import {
  createAgentActor,
  type AgentActor,
  type ServiceKey,
} from '@aion/core';
import { RuntimeClient, type RuntimeClientOptions } from './runtime-client.js';

export interface GrokWorkerIdentity {
  name: string;
  purpose: string;
  owner?: string;
  domain?: string;
  role?: string;
  tenantId?: string;
  autonomyLevel?: AgentActor['autonomyLevel'];
  permissions?: AgentActor['permissions'];
}

export interface InvokeServiceInput {
  serviceKey: ServiceKey | string;
  payload?: Record<string, unknown>;
  /** Override command name; defaults to serviceKey. */
  name?: string;
  metadata?: Record<string, unknown>;
}

export class GrokRuntimeClient {
  readonly runtime: RuntimeClient;
  readonly actor: AgentActor;

  constructor(
    runtimeOptions: RuntimeClientOptions,
    identity: GrokWorkerIdentity,
  ) {
    this.runtime = new RuntimeClient(runtimeOptions);
    this.actor = createAgentActor({
      name: identity.name,
      purpose: identity.purpose,
      owner: identity.owner ?? 'aion-execution',
      domain: identity.domain ?? 'revenue',
      role: identity.role ?? 'grok-worker',
      tenantId: identity.tenantId ?? 'aion-systems',
      autonomyLevel: identity.autonomyLevel ?? 'L2',
      permissions: identity.permissions ?? [],
      metadata: {
        runtimeProvider: 'grok',
        providerRole: 'execution_worker',
      },
    });
  }

  /** Invoke a catalog service through Runtime (preferred Grok entrypoint). */
  async invokeService(input: InvokeServiceInput): Promise<unknown> {
    return this.runtime.submitCommand({
      name: input.name ?? String(input.serviceKey),
      actor: this.actor,
      serviceKey: input.serviceKey,
      payload: input.payload,
      metadata: {
        ...(input.metadata ?? {}),
        runtimeProvider: 'grok',
        serviceKey: input.serviceKey,
      },
    });
  }
}
