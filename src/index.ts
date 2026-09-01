/**
 * AION Infra reference runtime — entrypoint.
 *
 * Boot sequence (aion-infra §57 — validated config → deps → health → serve →
 * graceful shutdown):
 *   1. Load + validate config (FAIL-FAST; crash before opening a socket).
 *   2. Build the durable control plane (Core over Data over Postgres).
 *   3. Optionally run the controlled Core lifecycle self-check.
 *   4. Serve health/readiness.
 *   5. On SIGTERM/SIGINT, drain the server and close the pool cleanly.
 *
 * This host does NOT run migrations — those are applied by the separate
 * migration job/identity before deploy (aion-infra §17–18). The runtime carries
 * only the least-privileged app credential.
 */
import { loadConfig, ConfigError } from './config.js';
import { Logger } from './logger.js';
import { buildControlPlane } from './control-plane.js';
import { createServer } from './server.js';
import { runSmoke } from './smoke.js';

async function main(): Promise<void> {
  // ── 1. Config (fail-fast) ────────────────────────────────────────────────
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    // No logger yet; emit a single structured line and exit non-zero.
    const message = err instanceof ConfigError ? err.message : 'configuration error';
    process.stderr.write(
      `${JSON.stringify({ timestamp: new Date().toISOString(), level: 'error', service: 'aion-runtime', message: 'config_invalid', reason: message })}\n`,
    );
    process.exit(1);
    return;
  }

  const logger = new Logger(
    {
      service: 'aion-runtime',
      environment: config.environment,
      gitSha: config.release.gitSha,
      serviceVersion: config.release.serviceVersion,
    },
    config.logLevel,
  );

  logger.info('starting', {
    operation: 'startup',
    build_time: config.release.buildTime,
  });

  // ── 2. Durable control plane ─────────────────────────────────────────────
  const cp = buildControlPlane(config);

  // ── 3. Optional boot self-check ──────────────────────────────────────────
  if (config.runSmokeOnBoot) {
    try {
      const smoke = await runSmoke(cp);
      if (!smoke.ok) {
        logger.error('boot_smoke_failed', { operation: 'smoke', status: smoke.status, detail: smoke.detail });
        await cp.close();
        process.exit(1);
        return;
      }
      logger.info('boot_smoke_passed', { operation: 'smoke', run_id: smoke.runId, status: smoke.status });
    } catch (err) {
      logger.error('boot_smoke_error', {
        operation: 'smoke',
        error: err instanceof Error ? err.message : 'unknown',
      });
      await cp.close();
      process.exit(1);
      return;
    }
  }

  // ── 4. Serve ─────────────────────────────────────────────────────────────
  const server = createServer(config, cp, logger);
  await server.listen();

  // ── 5. Graceful shutdown ─────────────────────────────────────────────────
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting_down', { operation: 'shutdown', signal });
    try {
      await server.close();
      await cp.close();
      logger.info('shutdown_complete', { operation: 'shutdown', status: 'ok' });
      process.exit(0);
    } catch (err) {
      logger.error('shutdown_error', {
        operation: 'shutdown',
        error: err instanceof Error ? err.message : 'unknown',
      });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void main();
