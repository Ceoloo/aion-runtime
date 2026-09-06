/**
 * HTTP client for the AION Runtime Execution Gateway.
 *
 * External workers (Grok, Kimi, Codex, …) and products must submit work through
 * this client — not by embedding an in-memory control plane. The client talks
 * only to Runtime's reconciled gateway surface (ADR-003): there is no second
 * gateway process.
 */
import type { Actor, Capability, RiskLevel, ServiceKey } from '@aion/core';

export interface RuntimeClientOptions {
  /** Base URL of aion-runtime, e.g. http://127.0.0.1:8080 */
  baseUrl: string;
  /** Optional fetch implementation (tests / custom agents). */
  fetch?: typeof fetch;
  /**
   * Default tenant for Mission 003 isolation on execution reads.
   * Sent as `x-aion-tenant-id` when method-level tenantId is omitted.
   */
  tenantId?: string;
}

export interface TenantScopedRequest {
  /** Caller tenant — required by gateway for GET /v1/executions* (Mission 003). */
  tenantId?: string;
}

export interface SubmitCommandRequest {
  name: string;
  actor: Actor;
  /** Direct capability — mutually exclusive with serviceKey in practice. */
  capability?: Capability | string;
  /** Preferred: resolve via Service Catalog, then submit capability. */
  serviceKey?: ServiceKey | string;
  requestId?: string;
  missionId?: string;
  workflowId?: string;
  toolId?: string;
  payload?: Record<string, unknown>;
  riskLevel?: RiskLevel | string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeApiErrorBody {
  error: string;
  message: string;
}

export class RuntimeApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeApiError';
  }
}

export class RuntimeClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly defaultTenantId?: string;

  constructor(options: RuntimeClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.fetchFn = options.fetch ?? fetch;
    this.defaultTenantId = options.tenantId;
  }

  async submitCommand(input: SubmitCommandRequest): Promise<unknown> {
    return this.request('POST', '/v1/commands', { body: input });
  }

  async getRun(runId: string): Promise<unknown> {
    return this.request('GET', `/v1/runs/${encodeURIComponent(runId)}`);
  }

  async decideApproval(
    approvalId: string,
    body: {
      approve: boolean;
      decidedBy: string;
      note?: string;
      /** Optional full actor record so Runtime can persist decidedBy for FK/attribution. */
      actor?: Actor;
    },
  ): Promise<unknown> {
    return this.request('POST', `/v1/approvals/${encodeURIComponent(approvalId)}/decision`, {
      body,
    });
  }

  async getExecution(
    executionId: string,
    opts?: TenantScopedRequest,
  ): Promise<unknown> {
    return this.request('GET', `/v1/executions/${encodeURIComponent(executionId)}`, {
      tenantId: opts?.tenantId,
    });
  }

  async getExecutionByRun(runId: string, opts?: TenantScopedRequest): Promise<unknown> {
    return this.request('GET', `/v1/executions/by-run/${encodeURIComponent(runId)}`, {
      tenantId: opts?.tenantId,
    });
  }

  async listServices(): Promise<unknown> {
    return this.request('GET', '/v1/services');
  }

  async getService(serviceKey: string): Promise<unknown> {
    return this.request('GET', `/v1/services/${encodeURIComponent(serviceKey)}`);
  }

  private async request(
    method: string,
    path: string,
    options?: { body?: unknown; tenantId?: string },
  ): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (options?.body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    const tenantId = options?.tenantId ?? this.defaultTenantId;
    if (tenantId) {
      headers['x-aion-tenant-id'] = tenantId;
    }
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    const text = await res.text();
    let parsed: unknown = {};
    if (text) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = { error: 'invalid_json', message: text };
      }
    }
    if (!res.ok) {
      const err = parsed as RuntimeApiErrorBody;
      throw new RuntimeApiError(
        res.status,
        typeof err.error === 'string' ? err.error : 'http_error',
        typeof err.message === 'string' ? err.message : `HTTP ${res.status}`,
      );
    }
    return parsed;
  }
}
