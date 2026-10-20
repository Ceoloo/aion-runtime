export type {
  CrmBackend,
  CrmBackendRequest,
  CrmBackendResult,
  CrmBackendFailure,
  CrmBackendSuccess,
  CrmMutationKind,
} from './types.js';
export { isCrmReadAction } from './types.js';

export { resolveCrmProvider, CrmProviderSelectionError, type CrmProvider } from './provider-policy.js';
export {
  resolveTwentyBackendChoice,
  TwentyBackendSelectionError,
} from './twenty-backend-policy.js';
export { LiveTwentyBackend, resolveTwentyConnection } from './live-twenty-backend.js';
export {
  createCrmBackendFromEnv,
  resolveCrmBackendSelection,
  CrmBackendSelectionError,
  type CrmBackendSelection,
} from './create-backend.js';
