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

export {
  GHL_API_VERSION,
  GHL_API_BASE_URL,
  CRM_CONTACT_UPSERT_MIN_CONFIDENCE,
  GHL_DISABLED_ACTIONS,
  GHL_AMBIGUOUS_WRITE_ERROR_CODES,
} from './constants.js';
export { validateGhlPayload, type PayloadValidationError } from './payload-validation.js';
export { mapGhlHttpError, type MappedProviderError } from './provider-errors.js';
