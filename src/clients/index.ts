/**
 * Runtime HTTP clients — how external workers and products talk to AION.
 *
 * Grok / Kimi / Codex / products submit through these clients. They never
 * embed an in-memory control plane and never call tools directly.
 */
export {
  RuntimeClient,
  RuntimeApiError,
  type RuntimeClientOptions,
  type SubmitCommandRequest,
  type RunMissionRequest,
  type RuntimeApiErrorBody,
} from './runtime-client.js';

export {
  GrokRuntimeClient,
  type GrokWorkerIdentity,
  type InvokeServiceInput,
} from './grok-runtime-client.js';
