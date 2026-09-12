export type {
  AuthMode,
  Principal,
  PrincipalKind,
  PrincipalRole,
  ApiKeyRecord,
  GatewayAuthConfig,
  AuthFailureCode,
} from './types.js';
export { loadGatewayAuthConfig, resolveAuthMode } from './config.js';
export {
  authenticateRequest,
  assertPrincipalTenantAccess,
  principalHasRole,
  type AuthOk,
  type AuthDenied,
} from './authenticate.js';
export {
  resolveDurableActor,
  resolveApproverActor,
  type ResolveActorResult,
} from './resolve-actor.js';
