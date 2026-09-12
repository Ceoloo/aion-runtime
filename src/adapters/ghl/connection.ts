/**
 * Tenant → GHL location connection resolution.
 *
 * Phase A: single-location env binding (VPS). Multi-tenant connection store
 * can replace this without changing the adapter contract.
 */

import { GHL_API_BASE_URL, GHL_API_VERSION } from './constants.js';

export interface GhlConnection {
  tenantId: string;
  locationId: string;
  apiKey: string;
  apiVersion: string;
  baseUrl: string;
  source: 'env' | 'payload';
}

export interface ResolveGhlConnectionInput {
  tenantId: string;
  env?: NodeJS.ProcessEnv;
  /** Optional location override — must match env location in Phase A. */
  locationId?: string;
}

export function resolveGhlConnection(
  input: ResolveGhlConnectionInput,
): GhlConnection | null {
  const env = input.env ?? process.env;
  const apiKey = (env.GHL_API_KEY ?? env.AION_GHL_API_KEY)?.trim();
  const locationId = (env.GHL_LOCATION_ID ?? env.AION_GHL_LOCATION_ID)?.trim();
  if (!apiKey || !locationId) return null;

  if (input.locationId && input.locationId !== locationId) {
    // Phase A: refuse cross-location override (tenant isolation).
    return null;
  }

  return {
    tenantId: input.tenantId,
    locationId,
    apiKey,
    // Env may override, but fixtures and docs pin GHL_API_VERSION.
    apiVersion: (env.GHL_API_VERSION ?? GHL_API_VERSION).trim(),
    baseUrl: (env.GHL_API_BASE_URL ?? GHL_API_BASE_URL).replace(/\/$/, ''),
    source: 'env',
  };
}

export function ghlCredentialsPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveGhlConnection({ tenantId: '_', env }) !== null;
}
