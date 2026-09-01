/**
 * Runtime configuration — validated at startup, FAIL-FAST.
 *
 * The service refuses to boot if required production configuration is missing or
 * malformed, and never silently falls back to an insecure default
 * (aion-infra §41–42). Configuration comes from the environment/secrets, never
 * from source edits: DATABASE_URL is injected from the platform's secret store
 * into the environment (provider-neutral — see contracts/deployment-contract.md).
 */

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
  /** Run the controlled Core lifecycle self-check on boot. */
  runSmokeOnBoot: boolean;
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

  return {
    environment,
    databaseUrl,
    port,
    logLevel,
    databaseSsl,
    runSmokeOnBoot: env.RUN_SMOKE_ON_BOOT === 'true',
    release: {
      serviceVersion: env.SERVICE_VERSION ?? 'unknown',
      gitSha: env.GIT_SHA ?? 'unknown',
      buildTime: env.BUILD_TIME ?? 'unknown',
    },
  };
}
