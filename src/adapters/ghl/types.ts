/**
 * GHL leaf type aliases — prefer `@/adapters/crm/types` for new code.
 * Kept so existing GHL adapter imports remain stable (production path unchanged).
 */

export type {
  CrmMutationKind as GhlMutationKind,
  CrmBackendRequest as GhlBackendRequest,
  CrmBackendSuccess as GhlBackendSuccess,
  CrmBackendFailure as GhlBackendFailure,
  CrmBackendResult as GhlBackendResult,
  CrmBackend as GhlBackend,
} from '../crm/types.js';

export { isCrmReadAction as isGhlReadAction } from '../crm/types.js';
