/**
 * CRM (GHL) backend selection policy — the single place that decides fake vs live.
 *
 * Goal: a runtime can never *silently* execute CRM actions against the fake backend, and a proof can never
 * *silently* reach live GHL. The fake backend accepts every write and returns plausible ids, so running it in
 * production would look like success while nothing reached the CRM.
 *
 *  GHL_BACKEND=fake|live selects explicitly; any other value is rejected.
 *
 *  production (AION_ENVIRONMENT=production)
 *    live (explicit)           credentials required, else refuse to start
 *    unset + credentials       live, source=inferred_credentials  (legacy; logged as a warning — set GHL_BACKEND=live)
 *    unset + no credentials    REFUSE to start (no silent fallback to fake)
 *    fake                      REFUSE unless AION_ACK_FAKE_CRM=1 (image boot-certification only); when acknowledged it
 *                              is logged at error level and reported by /health/ready as crm_backend=fake
 *  non-production
 *    unchanged legacy behaviour: unset + credentials => live, unset + none => fake
 *  proof context (AION_PROOF=1, set by every proof script)
 *    an explicit GHL_BACKEND is mandatory; credentials never imply live; live also needs AION_PROOF_LIVE=1
 */
import { resolveGhlConnection } from './connection.js';

export type CrmBackendKind = 'fake' | 'live';
export interface CrmBackendChoice {
  kind: CrmBackendKind;
  source: 'explicit' | 'inferred_credentials' | 'inferred_no_credentials';
  /** Human-readable warning to log (legacy inference, or fake acknowledged in production). */
  warning?: string;
  productionFakeAcknowledged?: boolean;
}

export class GhlBackendSelectionError extends Error {}

export function resolveGhlBackendChoice(env: NodeJS.ProcessEnv = process.env): CrmBackendChoice {
  const requested = env.GHL_BACKEND?.trim().toLowerCase();
  const proofContext = env.AION_PROOF === '1';
  const production = (env.AION_ENVIRONMENT ?? 'local').trim().toLowerCase() === 'production';
  if (requested && requested !== 'fake' && requested !== 'live') {
    throw new GhlBackendSelectionError(`GHL_BACKEND must be "fake" or "live", got "${requested}"`);
  }
  const hasCredentials = resolveGhlConnection({ tenantId: '_probe', env }) !== null;

  if (requested === 'fake') {
    if (production) {
      if (env.AION_ACK_FAKE_CRM !== '1') {
        throw new GhlBackendSelectionError(
          'GHL_BACKEND=fake is refused when AION_ENVIRONMENT=production (CRM writes would silently go nowhere); ' +
            'image boot-certification may acknowledge it with AION_ACK_FAKE_CRM=1',
        );
      }
      return {
        kind: 'fake',
        source: 'explicit',
        productionFakeAcknowledged: true,
        warning: 'FAKE CRM backend acknowledged in production (AION_ACK_FAKE_CRM=1): no CRM action reaches GHL',
      };
    }
    return { kind: 'fake', source: 'explicit' };
  }
  if (requested === 'live') {
    if (proofContext && env.AION_PROOF_LIVE !== '1') {
      throw new GhlBackendSelectionError('live GHL backend in a proof context requires AION_PROOF_LIVE=1');
    }
    if (!hasCredentials) {
      throw new GhlBackendSelectionError('GHL_BACKEND=live but GHL_API_KEY / GHL_LOCATION_ID are not set');
    }
    return { kind: 'live', source: 'explicit' };
  }
  // GHL_BACKEND unset
  if (proofContext) {
    throw new GhlBackendSelectionError('AION_PROOF=1 requires an explicit GHL_BACKEND=fake|live — credentials never imply live mode');
  }
  if (production) {
    if (hasCredentials) {
      return { kind: 'live', source: 'inferred_credentials', warning: 'GHL_BACKEND is unset; live backend inferred from credentials — set GHL_BACKEND=live explicitly' };
    }
    throw new GhlBackendSelectionError(
      'AION_ENVIRONMENT=production but no GHL credentials and GHL_BACKEND is unset — refusing to fall back to the fake backend',
    );
  }
  return hasCredentials ? { kind: 'live', source: 'inferred_credentials' } : { kind: 'fake', source: 'inferred_no_credentials' };
}
