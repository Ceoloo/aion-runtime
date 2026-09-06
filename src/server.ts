/**
 * Minimal HTTP surface for the Runtime host.
 *
 * Health / release (aion-infra §27–29):
 *   GET /health/live   — liveness
 *   GET /health/ready  — readiness (DB check)
 *   GET /              — release metadata
 *
 * Execution Gateway — reconciled INTO this same Runtime process (not a second
 * gateway service). See src/gateway.ts and Notion Progress Assessment Sep 2026.
 *   POST /v1/commands
 *   GET  /v1/runs/:runId
 *   POST /v1/approvals/:approvalId/decision
 *   GET  /v1/executions/:executionId
 *   GET  /v1/executions/by-run/:runId
 */
import http from 'node:http';
import type { ControlPlane } from './control-plane.js';
import type { RuntimeConfig } from './config.js';
import type { Logger } from './logger.js';
import { handleGatewayRequest } from './gateway.js';

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

    // Health endpoints first — cheap, GET-only.
    if (method === 'GET' && url === '/health/live') {
      send(200, { status: 'alive', ...releaseBody });
      return;
    }

    if (method === 'GET' && url === '/health/ready') {
      cp.checkDatabase()
        .then(() => send(200, { status: 'ready', database: 'up', ...releaseBody }))
        .catch((err: unknown) => {
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

    if (method === 'GET' && url === '/') {
      send(200, releaseBody);
      return;
    }

    // Execution Gateway (same process — not a second service).
    void handleGatewayRequest(method, url, req, cp, logger).then((gateway) => {
      if (gateway) {
        send(gateway.status, gateway.body);
        return;
      }
      if (method !== 'GET' && method !== 'POST') {
        send(405, { error: 'method_not_allowed' });
        return;
      }
      send(404, { error: 'not_found' });
    });
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
