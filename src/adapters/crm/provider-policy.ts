/**
 * CRM SoE provider selection (ADR-019 / CRM-001).
 *
 * Default unset / "ghl" preserves today's production GHL path.
 * "twenty" is opt-in and must not be set in production until workflow,
 * isolation, governance, and rollback proofs pass.
 */

export type CrmProvider = 'ghl' | 'twenty';

export class CrmProviderSelectionError extends Error {}

export function resolveCrmProvider(env: NodeJS.ProcessEnv = process.env): CrmProvider {
  const raw = env.CRM_PROVIDER?.trim().toLowerCase();
  if (!raw || raw === 'ghl') {
    return 'ghl';
  }
  if (raw === 'twenty') {
    return 'twenty';
  }
  throw new CrmProviderSelectionError(
    `CRM_PROVIDER must be "ghl" or "twenty" (unset defaults to ghl), got "${env.CRM_PROVIDER}"`,
  );
}
