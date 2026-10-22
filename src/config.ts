/**
 * Runtime configuration — validated at startup, FAIL-FAST.
 *
 * The service refuses to boot if required production configuration is missing or
 * malformed, and never silently falls back to an insecure default
 * (aion-infra §41–42). Configuration comes from the environment/secrets, never
 * from source edits: DATABASE_URL is injected from the platform's secret store
 * into the environment (provider-neutral — see contracts/deployment-contract.md).
 */

import type { GatewayAuthConfig } from './auth/types.js';
import { loadGatewayAuthConfig, AuthConfigError } from './auth/config.js';
import type { CrmBackendChoice } from './adapters/ghl/backend-policy.js';
import {
  resolveCrmBackendSelection,
  CrmBackendSelectionError,
  type CrmProvider,
} from './adapters/crm/index.js';

export type Environment = 'local' | 'staging' | 'production';

export interface RuntimeConfig {
  environment: Environment;
  /** Application (aion_app) connection string — DML only, never the migrator. */
  databaseUrl: string;
  port: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Release metadata, surfaced through /health and every log line. */
  release: {
    serviceVersion: string;
    gitSha: string;
    buildTime: string;
  };
  /** Require TLS to the database (true off-local). */
  databaseSsl: boolean;
  /**
   * When TLS is on, verify the server certificate against trusted CAs
   * (Node defaults + optional DATABASE_SSL_CA). Never silently disable
   * verification in staging/production.
   */
  databaseSslRejectUnauthorized: boolean;
  /** Optional PEM CA bundle for private / provider database CAs. */
  databaseSslCa?: string;
  /** Run the controlled Core lifecycle self-check on boot. */
  runSmokeOnBoot: boolean;
  /**
   * Exact browser origins allowed for CORS (Operator Console on Vercel).
   * Empty = no CORS headers (same-origin / non-browser clients only).
   */
  corsOrigins: string[];
  /**
   * Gateway identity plane (Mission: authn → authz).
   * Staging/production default to mode=required; local defaults to open with
   * durable-actor anti-escalation still enforced.
   */
  auth: GatewayAuthConfig;
  /** CRM SoE provider — unset/ghl keeps production GHL (ADR-019 / CRM-001). */
  crmProvider: CrmProvider;
  /** Resolved CRM backend (fake vs live) and how it was chosen — validated at startup, reported by /health/ready. */
  crmBackend: CrmBackendChoice;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const ENVIRONMENTS: readonly Environment[] = ['local', 'staging', 'production'];
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim() === '') {
    throw new ConfigError(`missing required configuration: ${key}`);
  }
  return value;
}

/**
 * Builds and validates the runtime configuration. Throws {@link ConfigError} on
 * any missing/malformed required value — the caller must let this crash the
 * process before opening a socket.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const environment = (env.AION_ENVIRONMENT ?? 'local') as Environment;
  if (!ENVIRONMENTS.includes(environment)) {
    throw new ConfigError(
      `invalid AION_ENVIRONMENT '${environment}' (expected one of ${ENVIRONMENTS.join(', ')})`,
    );
  }

  // DATABASE_URL is always required; the runtime cannot do useful work without
  // its durable store (aion-infra §57 — fail safe if dependencies are absent).
  const databaseUrl = required(env, 'DATABASE_URL');

  // Guard against the runtime being handed the MIGRATION credential by mistake:
  // the app must never carry DDL rights (aion-infra §16–17). This is a
  // defence-in-depth check on top of the separate secret/identity wiring.
  if (env.MIGRATION_DATABASE_URL && env.MIGRATION_DATABASE_URL === databaseUrl) {
    throw new ConfigError(
      'DATABASE_URL must not equal MIGRATION_DATABASE_URL — the runtime uses the least-privileged app role only',
    );
  }

  const portRaw = env.PORT ?? '8080';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ConfigError(`invalid PORT '${portRaw}'`);
  }

  const logLevel = (env.LOG_LEVEL ?? 'info') as RuntimeConfig['logLevel'];
  if (!LOG_LEVELS.includes(logLevel)) {
    throw new ConfigError(`invalid LOG_LEVEL '${logLevel}'`);
  }

  // TLS to the DB is required everywhere except local dev.
  const databaseSsl = env.DATABASE_SSL
    ? env.DATABASE_SSL === 'true'
    : environment !== 'local';

  // Certificate verification is mandatory when TLS is on, except an explicit
  // local-only escape hatch (DATABASE_SSL_REJECT_UNAUTHORIZED=false).
  let databaseSslRejectUnauthorized = true;
  if (env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'false') {
    if (environment !== 'local') {
      throw new ConfigError(
        'DATABASE_SSL_REJECT_UNAUTHORIZED=false is not allowed outside local',
      );
    }
    databaseSslRejectUnauthorized = false;
  } else if (
    env.DATABASE_SSL_REJECT_UNAUTHORIZED !== undefined &&
    env.DATABASE_SSL_REJECT_UNAUTHORIZED !== '' &&
    env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'true'
  ) {
    throw new ConfigError(
      `invalid DATABASE_SSL_REJECT_UNAUTHORIZED '${env.DATABASE_SSL_REJECT_UNAUTHORIZED}' (expected true|false)`,
    );
  }

  const databaseSslCa = env.DATABASE_SSL_CA?.trim()
    ? env.DATABASE_SSL_CA
    : undefined;

  const corsOrigins = (env.AION_CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  let auth;
  try {
    auth = loadGatewayAuthConfig(env, environment);
  } catch (err) {
    if (err instanceof AuthConfigError) {
      throw new ConfigError(err.message);
    }
    throw err;
  }

  let crmProvider: CrmProvider;
  let crmBackend: CrmBackendChoice;
  try {
    const selected = resolveCrmBackendSelection(env);
    crmProvider = selected.provider;
    crmBackend = selected.choice;
  } catch (err) {
    if (err instanceof CrmBackendSelectionError) {
      throw new ConfigError(err.message);
    }
    throw err;
  }

  return {
    environment,
    databaseUrl,
    port,
    logLevel,
    databaseSsl,
    databaseSslRejectUnauthorized,
    ...(databaseSslCa ? { databaseSslCa } : {}),
    runSmokeOnBoot: env.RUN_SMOKE_ON_BOOT === 'true',
    corsOrigins,
    auth,
    crmProvider,
    crmBackend,
    release: {
      serviceVersion: env.SERVICE_VERSION ?? 'unknown',
      gitSha: env.GIT_SHA ?? 'unknown',
      buildTime: env.BUILD_TIME ?? 'unknown',
    },
  };
}

/** Build node-postgres `ssl` option from runtime config. */
export function databaseSslOption(
  config: Pick<
    RuntimeConfig,
    'databaseSsl' | 'databaseSslRejectUnauthorized' | 'databaseSslCa'
  >,
): boolean | { rejectUnauthorized: boolean; ca?: string } | undefined {
  if (!config.databaseSsl) return undefined;
  return {
    rejectUnauthorized: config.databaseSslRejectUnauthorized,
    ...(config.databaseSslCa ? { ca: config.databaseSslCa } : {}),
  };
}
