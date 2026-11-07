/**
 * Opt-in Keycloak gateway credential verification.
 * This is the EXISTING aion-runtime gateway auth boundary (ADR-005), not a
 * second gateway, trusted principal header, or direct agent-to-business path.
 */
import type { IncomingMessage } from 'node:http';
import {
  createKeycloakVerifier,
  createRuntimePrincipalLookup,
  validRuntimePrincipal,
  type KeycloakVerifier,
} from '@aion/sentinel';
import type { DataLayer } from '@aion/data';
import type { GatewayAuthConfig, Principal } from './types.js';
import { authenticateRequest, type AuthOk, type AuthDenied } from './authenticate.js';

const forbidden = (): AuthDenied => ({
  ok: false, status: 401, code: 'auth_invalid', message: 'bearer credential invalid',
});

export function createKeycloakRuntimeVerifier(
  auth: GatewayAuthConfig,
  dataLayer: Pick<DataLayer, 'identityBindings' | 'actors'>,
): KeycloakVerifier {
  if (auth.provider !== 'keycloak' || !auth.keycloak || auth.mode !== 'required') {
    throw new Error('Keycloak gateway cannot be constructed without required-mode config');
  }
  // Per-request binding and Actor reads come from AION Data's canonical
  // repositories. Unknown/disabled identities cannot be auto-provisioned.
  const lookupPrincipal = createRuntimePrincipalLookup({
    getBinding: (id) => dataLayer.identityBindings.getActive(id),
    getActor: (actorId) => dataLayer.actors.get(actorId as never),
  });
  return createKeycloakVerifier({ ...auth.keycloak, lookupPrincipal });
}

/**
 * Legacy API-key authentication remains unchanged unless the operator has
 * *explicitly* selected Keycloak. Keycloak never silently falls back to keys.
 */
export async function authenticateGatewayRequest(
  req: IncomingMessage,
  config: GatewayAuthConfig,
  verifier?: KeycloakVerifier,
): Promise<AuthOk | AuthDenied> {
  if (config.provider !== 'keycloak') return authenticateRequest(req, config);
  if (config.mode !== 'required' || !config.keycloak || !verifier) return forbidden();
  const header = req.headers.authorization;
  if (typeof header !== 'string' || header.length > 17000) {
    return { ok: false, status: 401, code: 'auth_required', message: 'bearer credential required' };
  }
  // A malformed/duplicate Authorization header cannot accidentally use the
  // legacy API-key path. Do not include bearer material in logs/errors.
  const match = /^Bearer ([A-Za-z0-9._~-]+\.[A-Za-z0-9._~-]+\.[A-Za-z0-9._~-]+)$/.exec(header);
  if (!match) return forbidden();
  try {
    const verified = await verifier({ credential: match[1] });
    if (!verified.verified || !validRuntimePrincipal(verified.principal)) return forbidden();
    const p: Principal = {
      principalId: verified.principal.principalId,
      actorId: verified.principal.actorId,
      kind: verified.principal.kind,
      tenantIds: [...verified.principal.tenantIds],
      roles: [...verified.principal.roles],
    };
    // Runtime's normal resolveDurableActor/resolveDecisionIdentity/tenant
    // gates run unchanged after authentication.
    return { ok: true, principal: p };
  } catch {
    // Keycloak/JWKS failure, DB unavailability or missing bindings fail closed.
    return forbidden();
  }
}
