/**
 * UHP / HarnessRouter-backed {@link HarnessExecutionProvider} (ADR-011 pilot).
 *
 * Speaks the Unified Harness Protocol task surface (OpenAI Responses-compatible
 * `POST /v1/responses`) against a self-hosted or Cloud HarnessRouter instance.
 * Core never imports this module — it is injected at the Runtime composition
 * root, behind PolicyEngine authorization, exactly like GhlAdapter.
 *
 * Boundary rules honored here:
 *  - Not authority: selection of harness_id/model is routing only.
 *  - Fail-closed activation: when `enabled` is false, every run fails visibly.
 *  - Idempotency-Key forwarded so retries reconcile rather than re-execute.
 *  - Transport / ambiguous outcomes → `indeterminate` (never silent failed).
 *  - Secrets stay as env refs; the optional `resolveEnv` callback is owned by
 *    the composition root (vault / header resolution), never Core.
 */

import type {
  HarnessDescriptor,
  HarnessEnvRef,
  HarnessExecutionProvider,
  HarnessId,
  HarnessRunRequest,
  HarnessRunResult,
} from '@aion/core';

/** Minimal fetch surface so tests inject a fake without DOM types. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export interface UhpHarnessProviderOptions {
  /** Base URL including the `/api/harness` prefix, no trailing slash. */
  baseUrl: string;
  /** CE / Cloud API key — never logged. */
  apiKey: string;
  /**
   * Kill switch (ADR-011 fail-closed activation). When false, `supports` is
   * false and `run` returns a failed result without contacting the network.
   */
  enabled?: boolean;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: FetchLike;
  /**
   * Optional static harness catalog. When omitted, `listHarnesses` GETs
   * `/v1/harnesses` (and caches the result until process exit / clear).
   */
  harnesses?: HarnessDescriptor[];
  /** Resolve vault/header env refs at the composition root. */
  resolveEnv?: (ref: HarnessEnvRef) => string | undefined;
  /** Optional UHP-Version header (defaults omitted — server picks). */
  uhpVersion?: string;
}

interface UhpHarnessObject {
  id?: string;
  base?: string;
  name?: string;
  defaultModel?: string;
}

interface UhpResponseObject {
  id?: string;
  status?: string;
  model?: string;
  error?: { code?: string; message?: string } | null;
  output?: unknown[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  } | null;
  metadata?: Record<string, unknown> | null;
}

export class UhpHarnessProvider implements HarnessExecutionProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly enabled: boolean;
  private readonly fetchImpl: FetchLike;
  private readonly staticHarnesses: HarnessDescriptor[] | undefined;
  private readonly resolveEnv: ((ref: HarnessEnvRef) => string | undefined) | undefined;
  private readonly uhpVersion: string | undefined;
  private cachedHarnesses: HarnessDescriptor[] | undefined;
  /** sessionId → last response id (for cancel-by-session). */
  private readonly lastResponseBySession = new Map<string, string>();
  /** runId → last response id. */
  private readonly lastResponseByRun = new Map<string, string>();

  constructor(options: UhpHarnessProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.enabled = options.enabled ?? true;
    this.fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
    this.staticHarnesses = options.harnesses;
    this.resolveEnv = options.resolveEnv;
    this.uhpVersion = options.uhpVersion;
  }

  async listHarnesses(): Promise<HarnessDescriptor[]> {
    if (!this.enabled) return [];
    if (this.staticHarnesses) return [...this.staticHarnesses];
    if (this.cachedHarnesses) return [...this.cachedHarnesses];

    try {
      const res = await this.fetchImpl(`${this.baseUrl}/v1/harnesses`, {
        method: 'GET',
        headers: this.headers(),
      });
      if (!res.ok) return [];
      const body = (await res.json()) as { harnesses?: UhpHarnessObject[] };
      const mapped = (body.harnesses ?? [])
        .filter((h): h is UhpHarnessObject & { id: string } => typeof h.id === 'string')
        .map((h) => ({
          id: h.id,
          kind: typeof h.base === 'string' && h.base.length > 0 ? h.base : 'uhp',
          ...(typeof h.defaultModel === 'string' && h.defaultModel.length > 0
            ? { models: [h.defaultModel] }
            : {}),
          capabilities: [],
        }));
      this.cachedHarnesses = mapped;
      return [...mapped];
    } catch {
      return [];
    }
  }

  async supports(harnessId: HarnessId): Promise<boolean> {
    if (!this.enabled) return false;
    if (this.staticHarnesses) {
      return this.staticHarnesses.some((h) => h.id === harnessId);
    }
    const listed = await this.listHarnesses();
    // Empty live catalog: still allow the requested id through — the server
    // will 404 harness_not_found if unknown (fail closed on the run).
    if (listed.length === 0) return true;
    return listed.some((h) => h.id === harnessId);
  }

  async run(request: HarnessRunRequest): Promise<HarnessRunResult> {
    if (!this.enabled) {
      return {
        status: 'failed',
        harnessId: request.harnessId,
        ...(request.model !== undefined ? { model: request.model } : {}),
        error: {
          code: 'HARNESS_DISABLED',
          message: 'uhp harness provider is disabled (fail-closed kill switch)',
          retryable: false,
        },
      };
    }

    const body: Record<string, unknown> = {
      input: request.input,
      stream: false,
      metadata: { harness_id: request.harnessId },
    };
    if (request.model !== undefined) body.model = request.model;
    if (request.sessionId !== undefined) {
      // Resume via previous_response_id when the caller passes a response id as
      // sessionId; UHP sessions continue from a response id.
      body.previous_response_id = request.sessionId;
    }
    if (request.budgetUnits !== undefined) {
      // Abstract AION budget → UHP max_step as a coarse ceiling. Exact FinOps
      // accounting stays on our ledger; this only bounds the remote loop.
      body.max_step = Math.max(1, Math.floor(request.budgetUnits));
    }

    const env = this.resolveEnvMap(request.env);
    if (env && Object.keys(env).length > 0) {
      // UHP harness env is configured on the harness object; per-task env rides
      // as request metadata for servers that honor it. Always listed so a
      // non-honoring server can put it in ignored_fields.
      (body.metadata as Record<string, unknown>).env = env;
    }
    if (request.contextReference !== undefined) {
      (body.metadata as Record<string, unknown>).context_reference = request.contextReference;
    }
    if (request.fileRefs !== undefined && request.fileRefs.length > 0) {
      (body.metadata as Record<string, unknown>).file_refs = request.fileRefs;
    }

    const headers = this.headers();
    if (request.idempotencyKey) {
      headers['Idempotency-Key'] = request.idempotencyKey;
    }

    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/responses`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Ambiguous: the request may have been accepted. Do not claim failed.
      return {
        status: 'indeterminate',
        harnessId: request.harnessId,
        ...(request.model !== undefined ? { model: request.model } : {}),
        error: {
          code: 'HARNESS_TRANSPORT_LOST',
          message: err instanceof Error ? err.message : 'uhp transport lost',
          retryable: true,
        },
      };
    }

    if (!res.ok) {
      return this.mapHttpFailure(request, res.status, await safeText(res));
    }

    let payload: UhpResponseObject;
    try {
      payload = (await res.json()) as UhpResponseObject;
    } catch {
      return {
        status: 'indeterminate',
        harnessId: request.harnessId,
        ...(request.model !== undefined ? { model: request.model } : {}),
        error: {
          code: 'HARNESS_TRANSPORT_LOST',
          message: 'uhp response body unreadable',
          retryable: true,
        },
      };
    }

    return this.mapResponse(request, payload);
  }

  async cancel(ref: { sessionId?: string; runId?: string }): Promise<void> {
    if (!this.enabled) return;
    const responseId =
      (ref.sessionId ? this.lastResponseBySession.get(ref.sessionId) : undefined) ??
      (ref.runId ? this.lastResponseByRun.get(ref.runId) : undefined) ??
      ref.sessionId;

    if (!responseId) return;

    try {
      // Prefer response cancel; session cancel when the ref looks like a session.
      const path = responseId.startsWith('hsess')
        ? `/v1/sessions/${encodeURIComponent(responseId)}/cancel`
        : `/v1/responses/${encodeURIComponent(responseId)}/cancel`;
      await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: this.headers(),
      });
    } catch {
      // Best-effort — cancel failures are not rethrown (port contract).
    }
  }

  /** Drop the cached harness list (tests / after remote catalog changes). */
  clearHarnessCache(): void {
    this.cachedHarnesses = undefined;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (this.uhpVersion) headers['UHP-Version'] = this.uhpVersion;
    return headers;
  }

  private resolveEnvMap(
    refs: HarnessEnvRef[] | undefined,
  ): Record<string, string> | undefined {
    if (!refs || refs.length === 0 || !this.resolveEnv) return undefined;
    const out: Record<string, string> = {};
    for (const ref of refs) {
      const value = this.resolveEnv(ref);
      if (value !== undefined) out[ref.name] = value;
    }
    return out;
  }

  private mapResponse(
    request: HarnessRunRequest,
    payload: UhpResponseObject,
  ): HarnessRunResult {
    const responseId = typeof payload.id === 'string' ? payload.id : undefined;
    const sessionId =
      (typeof payload.metadata?.['session_id'] === 'string'
        ? (payload.metadata['session_id'] as string)
        : undefined) ?? responseId;
    const model =
      typeof payload.model === 'string' && payload.model.length > 0
        ? payload.model
        : request.model;

    if (sessionId && responseId) this.lastResponseBySession.set(sessionId, responseId);
    if (request.runId && responseId) this.lastResponseByRun.set(request.runId, responseId);

    const tokens =
      typeof payload.usage?.total_tokens === 'number'
        ? payload.usage.total_tokens
        : undefined;
    const usage =
      tokens !== undefined
        ? { units: tokens, tokens }
        : undefined;

    const base = {
      harnessId: request.harnessId,
      ...(model !== undefined ? { model } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(responseId !== undefined ? { transcriptRef: `uhp:response:${responseId}` } : {}),
      ...(usage !== undefined ? { usage } : {}),
    };

    const status = payload.status ?? 'failed';
    if (status === 'completed') {
      return {
        ...base,
        status: 'succeeded',
        output: {
          responseId,
          items: payload.output ?? [],
          text: extractAssistantText(payload.output),
        },
      };
    }
    if (status === 'cancelled') {
      return {
        ...base,
        status: 'cancelled',
        error: {
          code: 'HARNESS_CANCELLED',
          message: payload.error?.message ?? 'cancelled',
          retryable: false,
        },
      };
    }
    if (status === 'incomplete') {
      return {
        ...base,
        status: 'failed',
        error: {
          code: payload.error?.code ?? 'HARNESS_INCOMPLETE',
          message: payload.error?.message ?? 'incomplete',
          retryable: true,
        },
      };
    }
    // failed or unknown terminal
    return {
      ...base,
      status: 'failed',
      error: {
        code: payload.error?.code ?? 'HARNESS_FAILED',
        message: payload.error?.message ?? status,
        retryable: false,
      },
    };
  }

  private mapHttpFailure(
    request: HarnessRunRequest,
    status: number,
    bodyText: string,
  ): HarnessRunResult {
    // 408 / 504 / 502 / 503: may have accepted — indeterminate when we cannot
    // prove the server rejected before execution.
    if (status === 408 || status === 502 || status === 503 || status === 504) {
      return {
        status: 'indeterminate',
        harnessId: request.harnessId,
        ...(request.model !== undefined ? { model: request.model } : {}),
        error: {
          code: 'HARNESS_TRANSPORT_LOST',
          message: `uhp upstream status=${status}`,
          retryable: true,
        },
      };
    }

    let code = 'HARNESS_HTTP_ERROR';
    let message = `uhp upstream status=${status}`;
    try {
      const parsed = JSON.parse(bodyText) as {
        error?: { code?: string; message?: string };
      };
      if (parsed.error?.code) code = parsed.error.code;
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      // keep defaults — never echo raw bodies that might contain secrets
    }

    return {
      status: 'failed',
      harnessId: request.harnessId,
      ...(request.model !== undefined ? { model: request.model } : {}),
      error: {
        code,
        message,
        retryable: status === 429,
      },
    };
  }
}

function extractAssistantText(output: unknown[] | undefined): string {
  if (!output) return '';
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as {
      type?: string;
      content?: Array<{ type?: string; text?: string }>;
    };
    if (rec.type !== 'message' || !Array.isArray(rec.content)) continue;
    for (const c of rec.content) {
      if (c?.type === 'output_text' && typeof c.text === 'string') parts.push(c.text);
    }
  }
  return parts.join('\n');
}

async function safeText(res: { text: () => Promise<string> }): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
