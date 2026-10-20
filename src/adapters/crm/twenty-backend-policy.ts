/**
 * Twenty backend fake|live selection — mirrors GHL policy, separate env vars.
 * Used only when CRM_PROVIDER=twenty.
 */
import type { CrmBackendChoice } from '../ghl/backend-policy.js';

export class TwentyBackendSelectionError extends Error {}

function twentyCredentialsPresent(env: NodeJS.ProcessEnv): boolean {
  const base = env.TWENTY_API_BASE_URL?.trim();
  const key = env.TWENTY_API_KEY?.trim();
  return Boolean(base && key);
}

export function resolveTwentyBackendChoice(env: NodeJS.ProcessEnv = process.env): CrmBackendChoice {
  const requested = env.TWENTY_BACKEND?.trim().toLowerCase();
  const proofContext = env.AION_PROOF === '1';
  const production = (env.AION_ENVIRONMENT ?? 'local').trim().toLowerCase() === 'production';
  if (requested && requested !== 'fake' && requested !== 'live') {
    throw new TwentyBackendSelectionError(`TWENTY_BACKEND must be "fake" or "live", got "${requested}"`);
  }
  const hasCredentials = twentyCredentialsPresent(env);

  if (requested === 'fake') {
    if (production) {
      if (env.AION_ACK_FAKE_CRM !== '1') {
        throw new TwentyBackendSelectionError(
          'TWENTY_BACKEND=fake is refused when AION_ENVIRONMENT=production; ' +
            'acknowledge with AION_ACK_FAKE_CRM=1 only for image boot-certification',
        );
      }
      return {
        kind: 'fake',
        source: 'explicit',
        productionFakeAcknowledged: true,
        warning: 'FAKE Twenty CRM backend acknowledged in production (AION_ACK_FAKE_CRM=1)',
      };
    }
    return { kind: 'fake', source: 'explicit' };
  }

  if (requested === 'live') {
    if (proofContext && env.AION_PROOF_LIVE !== '1') {
      throw new TwentyBackendSelectionError('live Twenty backend in a proof context requires AION_PROOF_LIVE=1');
    }
    if (!hasCredentials) {
      throw new TwentyBackendSelectionError(
        'TWENTY_BACKEND=live but TWENTY_API_BASE_URL / TWENTY_API_KEY are not set',
      );
    }
    return { kind: 'live', source: 'explicit' };
  }

  // TWENTY_BACKEND unset
  if (proofContext) {
    throw new TwentyBackendSelectionError(
      'AION_PROOF=1 requires an explicit TWENTY_BACKEND=fake|live when CRM_PROVIDER=twenty',
    );
  }
  if (production) {
    // Refuse silent Twenty cutover in production — keep operators on GHL until certified.
    throw new TwentyBackendSelectionError(
      'CRM_PROVIDER=twenty in production requires an explicit TWENTY_BACKEND=live|fake ' +
        '(and CRM-001 proofs). Leave CRM_PROVIDER unset to keep GHL.',
    );
  }
  return hasCredentials
    ? { kind: 'live', source: 'inferred_credentials' }
    : { kind: 'fake', source: 'inferred_no_credentials' };
}
