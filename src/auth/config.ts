/**
 * Load gateway auth configuration from the environment.
 *
 * AION_AUTH_MODE=open|required
 *   open     — local/proof default: no bearer required, but durable actor
 *              grants still win over body self-assertion once registered.
 *   required — staging/production: bearer mandatory; grants load from Data.
 *
 * AION_GATEWAY_API_KEYS — JSON array of
 *   { "token", "principalId", "kind", "actorId", "tenantIds", "roles" }
 */
import type {
  ApiKeyRecord,
  AuthMode,
  GatewayAuthConfig,
  Principal,
  PrincipalKind,
  PrincipalRole,
} from './types.js';
export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthConfigError';
  }
}

const PRINCIPAL_KINDS: readonly PrincipalKind[] = [
  'operator',
  'service',
  'agent-worker',
];
const PRINCIPAL_ROLES: readonly PrincipalRole[] = [
  'invoke',
  'approve',
  'register',
];

function parseApiKeys(raw: string | undefined): ApiKeyRecord[] {
  if (raw === undefined || raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new AuthConfigError('AION_GATEWAY_API_KEYS must be valid JSON');
  }
  if (!Array.isArray(parsed)) {
    throw new AuthConfigError('AION_GATEWAY_API_KEYS must be a JSON array');
  }
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new AuthConfigError(`AION_GATEWAY_API_KEYS[${index}] must be an object`);
    }
    const row = entry as Record<string, unknown>;
    if (typeof row.token !== 'string' || row.token.length < 8) {
      throw new AuthConfigError(
        `AION_GATEWAY_API_KEYS[${index}].token must be a string (≥ 8 chars)`,
      );
    }
    if (typeof row.principalId !== 'string' || row.principalId.length < 1) {
      throw new AuthConfigError(
        `AION_GATEWAY_API_KEYS[${index}].principalId is required`,
      );
    }
    if (typeof row.actorId !== 'string' || row.actorId.length < 1) {
      throw new AuthConfigError(
        `AION_GATEWAY_API_KEYS[${index}].actorId is required`,
      );
    }
    const kind = row.kind as PrincipalKind;
    if (!PRINCIPAL_KINDS.includes(kind)) {
      throw new AuthConfigError(
        `AION_GATEWAY_API_KEYS[${index}].kind must be one of ${PRINCIPAL_KINDS.join(', ')}`,
      );
    }
    if (!Array.isArray(row.tenantIds) || row.tenantIds.length < 1) {
      throw new AuthConfigError(
        `AION_GATEWAY_API_KEYS[${index}].tenantIds must be a non-empty string array`,
      );
    }
    const tenantIds = row.tenantIds.map((t, j) => {
      if (typeof t !== 'string' || t.length < 1) {
        throw new AuthConfigError(
          `AION_GATEWAY_API_KEYS[${index}].tenantIds[${j}] must be a non-empty string`,
        );
      }
      return t;
    });
    if (!Array.isArray(row.roles) || row.roles.length < 1) {
      throw new AuthConfigError(
        `AION_GATEWAY_API_KEYS[${index}].roles must be a non-empty array`,
      );
    }
    const roles = row.roles.map((r, j) => {
      if (!PRINCIPAL_ROLES.includes(r as PrincipalRole)) {
        throw new AuthConfigError(
          `AION_GATEWAY_API_KEYS[${index}].roles[${j}] must be one of ${PRINCIPAL_ROLES.join(', ')}`,
        );
      }
      return r as PrincipalRole;
    });
    const principal: Principal = {
      principalId: row.principalId,
      kind,
      actorId: row.actorId,
      tenantIds,
      roles,
    };
    return { token: row.token, principal };
  });
}

export function resolveAuthMode(
  environment: 'local' | 'staging' | 'production',
  raw: string | undefined,
): AuthMode {
  if (raw === 'open' || raw === 'required') return raw;
  if (raw !== undefined && raw.trim() !== '') {
    throw new AuthConfigError(
      `invalid AION_AUTH_MODE '${raw}' (expected open|required)`,
    );
  }
  // Fail closed off-local: staging/production require bearer auth by default.
  return environment === 'local' ? 'open' : 'required';
}

export function loadGatewayAuthConfig(
  env: NodeJS.ProcessEnv,
  environment: 'local' | 'staging' | 'production',
): GatewayAuthConfig {
  const mode = resolveAuthMode(environment, env.AION_AUTH_MODE);
  const apiKeys = parseApiKeys(env.AION_GATEWAY_API_KEYS);
  if (mode === 'required' && apiKeys.length === 0) {
    throw new AuthConfigError(
      'AION_AUTH_MODE=required requires at least one entry in AION_GATEWAY_API_KEYS',
    );
  }
  return { mode, apiKeys };
}
