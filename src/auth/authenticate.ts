/**
 * Authenticate a gateway request to a Principal.
 *
 * Bearer tokens are the V1 credential. Future OIDC/mTLS can mint the same
 * Principal shape without changing authorize() — identity plane stays at the
 * Runtime boundary; Core still evaluates durable Actor grants only.
 */
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type {
  AuthFailureCode,
  GatewayAuthConfig,
  Principal,
  PrincipalRole,
} from './types.js';

export interface AuthOk {
  ok: true;
  principal: Principal | null;
}

export interface AuthDenied {
  ok: false;
  status: 401 | 403;
  code: AuthFailureCode;
  message: string;
}

function extractBearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1]?.trim() || undefined;
}

function tokensEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

export function authenticateRequest(
  req: IncomingMessage,
  config: GatewayAuthConfig,
): AuthOk | AuthDenied {
  const token = extractBearer(req);

  if (!token) {
    if (config.mode === 'required') {
      return {
        ok: false,
        status: 401,
        code: 'auth_required',
        message: 'Authorization Bearer token is required',
      };
    }
    return { ok: true, principal: null };
  }

  const match = config.apiKeys.find((k) => tokensEqual(k.token, token));
  if (!match) {
    return {
      ok: false,
      status: 401,
      code: 'auth_invalid',
      message: 'Authorization Bearer token is invalid',
    };
  }
  return { ok: true, principal: match.principal };
}

/**
 * When a Principal is bound, x-aion-tenant-id must be one of principal.tenantIds.
 * The header is never authority on its own.
 */
export function assertPrincipalTenantAccess(
  principal: Principal | null,
  tenantId: string | undefined,
  options: { requireTenant: boolean },
): AuthDenied | null {
  if (options.requireTenant && (!tenantId || tenantId.length < 1)) {
    return {
      ok: false,
      status: 403,
      code: 'tenant_forbidden',
      message: 'x-aion-tenant-id header is required',
    };
  }
  if (!tenantId) return null;
  if (principal && !principal.tenantIds.includes(tenantId)) {
    return {
      ok: false,
      status: 403,
      code: 'tenant_forbidden',
      message: `principal ${principal.principalId} cannot operate in tenant ${tenantId}`,
    };
  }
  return null;
}

export function principalHasRole(
  principal: Principal,
  role: PrincipalRole,
): boolean {
  return principal.roles.includes(role);
}
