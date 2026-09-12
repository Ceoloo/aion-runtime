/**
 * AIO-17 — pinned GHL / LeadConnector contract constants.
 *
 * External services connect through this adapter; Core stays vendor-agnostic.
 */

/** Pinned LeadConnector `Version` header used by live backend + fixtures. */
export const GHL_API_VERSION = '2021-07-28';

/** Default LeadConnector API host (no trailing slash). */
export const GHL_API_BASE_URL = 'https://services.leadconnectorhq.com';

/**
 * Contact upsert confidence floor.
 * Kept in the adapter (not Core) so vendor CRM policy does not leak into the kernel.
 */
export const CRM_CONTACT_UPSERT_MIN_CONFIDENCE = 0.85;

/**
 * AIO-17 first lead-workflow slice: these actions are defined (fixtures +
 * validation + error mapping) but not executable yet. Calls return
 * `CAPABILITY_DISABLED`. Remaining enablement is a follow-up to AIO-17.
 */
export const GHL_DISABLED_ACTIONS: ReadonlySet<string> = new Set([
  'conversation.read',
  'conversation.send',
  'appointment.create',
]);

/** Provider errors that mean the write outcome is uncertain — do not auto-repeat. */
export const GHL_AMBIGUOUS_WRITE_ERROR_CODES: ReadonlySet<string> = new Set([
  'GHL_AMBIGUOUS_TIMEOUT',
  'GHL_WRITE_TIMEOUT',
  'GHL_AMBIGUOUS_WRITE',
]);
