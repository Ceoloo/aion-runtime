/**
 * Factory: select CRM SoE provider + fake|live backend.
 * Default provider ghl → existing createGhlBackendFromEnv (production unchanged).
 */
import type { CrmBackend } from './types.js';
import { resolveCrmProvider, CrmProviderSelectionError } from './provider-policy.js';
import {
  resolveTwentyBackendChoice,
  TwentyBackendSelectionError,
} from './twenty-backend-policy.js';
import { LiveTwentyBackend } from './live-twenty-backend.js';
import { sharedFakeTwentyBackend } from '../ghl/fake-ghl-backend.js';
import {
  createGhlBackendFromEnv,
  GhlBackendSelectionError,
} from '../ghl/live-ghl-backend.js';
import type { CrmBackendChoice } from '../ghl/backend-policy.js';
import { resolveGhlBackendChoice } from '../ghl/backend-policy.js';

export class CrmBackendSelectionError extends Error {}

export interface CrmBackendSelection {
  provider: 'ghl' | 'twenty';
  choice: CrmBackendChoice;
  backend: CrmBackend;
}

export function resolveCrmBackendSelection(
  env: NodeJS.ProcessEnv = process.env,
): CrmBackendSelection {
  let provider: 'ghl' | 'twenty';
  try {
    provider = resolveCrmProvider(env);
  } catch (err) {
    if (err instanceof CrmProviderSelectionError) {
      throw new CrmBackendSelectionError(err.message);
    }
    throw err;
  }

  if (provider === 'ghl') {
    try {
      const choice = resolveGhlBackendChoice(env);
      return {
        provider: 'ghl',
        choice,
        backend: createGhlBackendFromEnv(env),
      };
    } catch (err) {
      if (err instanceof GhlBackendSelectionError) {
        throw new CrmBackendSelectionError(err.message);
      }
      throw err;
    }
  }

  try {
    const choice = resolveTwentyBackendChoice(env);
    const backend: CrmBackend =
      choice.kind === 'live'
        ? new LiveTwentyBackend(env)
        : sharedFakeTwentyBackend;
    return { provider: 'twenty', choice, backend };
  } catch (err) {
    if (err instanceof TwentyBackendSelectionError) {
      throw new CrmBackendSelectionError(err.message);
    }
    throw err;
  }
}

export function createCrmBackendFromEnv(env: NodeJS.ProcessEnv = process.env): CrmBackend {
  return resolveCrmBackendSelection(env).backend;
}
