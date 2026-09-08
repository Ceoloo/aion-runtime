export type {
  GhlBackend,
  GhlBackendRequest,
  GhlBackendResult,
  GhlMutationKind,
} from './types.js';
export { isGhlReadAction } from './types.js';
export { FakeGhlBackend, sharedFakeGhlBackend } from './fake-ghl-backend.js';
export {
  LiveGhlBackend,
  createGhlBackendFromEnv,
  type LiveGhlBackendOptions,
  type FetchLike,
} from './live-ghl-backend.js';
export {
  resolveGhlConnection,
  ghlCredentialsPresent,
  type GhlConnection,
} from './connection.js';
export {
  normalizeContact,
  normalizeOpportunity,
  normalizePipeline,
  normalizeConversation,
  normalizeAppointment,
  type CrmContact,
  type CrmOpportunity,
  type CrmPipeline,
  type CrmConversation,
  type CrmAppointment,
} from './normalize.js';
export {
  GhlAdapter,
  MISSION_009_CAPABILITIES,
  type GhlAdapterDeps,
} from './ghl-adapter.js';
