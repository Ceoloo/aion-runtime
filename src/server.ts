/**
 * Minimal HTTP surface: health, readiness, and release metadata (aion-infra
 * §27–29). No product API, no business endpoints — this host exists to prove
 * deployability, not to serve product traffic.
 *
 *   GET /health/live   — liveness: process is up. Cheap, NO dependency work
 *                        (§29: "Do not make health checks trigger expensive
 *                        business execution"). Called by the platform's liveness
 *                        probe to restart a wedged process.
 *   GET /health/ready  — readiness: can we safely accept work? Checks database
 *                        connectivity. Fails (503) when the DB is unreachable so
 *                        the platform withholds traffic (§29, §62).
 *   GET /              — release metadata (git_sha / version / environment).
 */
import http from 'node:http';
import type { ControlPlane } from './control-plane.js';
import type { RuntimeConfig } from './config.js';
import type { Logger } from './logger.js';

export interface Server {
  listen(): Promise<void>;
  close(): Promise<void>;
}

export function createServer(
  config: RuntimeConfig,
  cp: ControlPlane,
  logger: Logger,
): Server {
  const releaseBody = {
    service: 'aion-runtime',
    environment: config.environment,
    git_sha: config.release.gitSha,
    service_version: config.release.serviceVersion,
    build_time: config.release.buildTime,
  };

  const server = http.createServer((req, res) => {
    const started = Date.now();
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    const send = (status: number, body: unknown): void => {
      const payload = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(payload);
      logger.info('http_request', {
        operation: `${method} ${url}`,
        status: String(status),
        latency_ms: Date.now() - started,
      });
    };

    if (method !== 'GET') {
      send(405, { error: 'method_not_allowed' });
      return;
    }

    if (url === '/health/live') {
      // Liveness: no dependency work.
      send(200, { status: 'alive', ...releaseBody });
      return;
    }

    if (url === '/health/ready') {
      cp.checkDatabase()
        .then(() => send(200, { status: 'ready', database: 'up', ...releaseBody }))
        .catch((err: unknown) => {
          // Fail readiness with a clear, NON-SECRET diagnostic (§62). We report
          // that the database is unreachable — never the connection string.
          logger.error('readiness_failed', {
            operation: 'GET /health/ready',
            status: '503',
            reason: 'database_unreachable',
            error: err instanceof Error ? err.message : 'unknown',
          });
          send(503, { status: 'not_ready', database: 'unreachable', ...releaseBody });
        });
      return;
    }

    if (url === '/') {
      send(200, releaseBody);
      return;
    }

    send(404, { error: 'not_found' });
  });

  return {
    listen(): Promise<void> {
      return new Promise((resolve) => {
        server.listen(config.port, () => {
          logger.info('listening', { operation: 'startup', status: 'ok', port: config.port });
          resolve();
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
