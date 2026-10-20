/**
 * Live Twenty CRM backend stub (CRM-001).
 *
 * Wiring + connection checks only. Mutation dispatch lands in a follow-up
 * slice once compose + fake proofs are green. Production must stay on GHL
 * (CRM_PROVIDER unset/ghl) until then.
 */
import { randomUUID } from 'node:crypto';
import type { CrmBackend, CrmBackendRequest, CrmBackendResult } from './types.js';

export interface TwentyConnection {
  baseUrl: string;
  apiKey: string;
}

export function resolveTwentyConnection(env: NodeJS.ProcessEnv = process.env): TwentyConnection | null {
  const baseUrl = env.TWENTY_API_BASE_URL?.trim().replace(/\/$/, '');
  const apiKey = env.TWENTY_API_KEY?.trim();
  if (!baseUrl || !apiKey) {
    return null;
  }
  return { baseUrl, apiKey };
}

export class LiveTwentyBackend implements CrmBackend {
  readonly name = 'twenty-live';

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async execute(request: CrmBackendRequest): Promise<CrmBackendResult> {
    const connection = resolveTwentyConnection(this.env);
    if (!connection) {
      return {
        ok: false,
        errorCode: 'TWENTY_CONNECTION_MISSING',
        errorMessage: 'TWENTY_API_BASE_URL and TWENTY_API_KEY required for live Twenty CRM',
        retryable: false,
      };
    }

    // Preserve request correlation for ledger tests while live HTTP mapping lands.
    void request;
    return {
      ok: false,
      errorCode: 'TWENTY_LIVE_NOT_IMPLEMENTED',
      errorMessage:
        `Live Twenty mutation "${request.action}" is not implemented yet ` +
        `(connected to ${connection.baseUrl}). Use TWENTY_BACKEND=fake for CRM-001 proofs; ` +
        'keep CRM_PROVIDER=ghl in production until the live adapter and rollback gate pass.',
      retryable: false,
    };
  }
}

/** Test helper — unused in production path. */
export function twentyRequestId(): string {
  return `twenty_req_${randomUUID()}`;
}
