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
 *   POST /v1/missions/run
 *   GET  /v1/runs/:runId
 *   POST /v1/approvals/:approvalId/decision
 *   GET  /v1/executions/:executionId
 *   GET  /v1/executions/by-run/:runId
 *   GET  /v1/executions/by-root/:rootExecutionId
 *
 * CORS (OPS-001): when AION_CORS_ORIGINS is set, approved browser origins
 * (e.g. Vercel Operator Console) may call the gateway. Origins are an allowlist
 * only — they do not grant tenant or actor authority. VITE_* frontend hints are
 * never trusted here.
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

function corsHeaders(
  config: RuntimeConfig,
  req: http.IncomingMessage,
): Record<string, string> | null {
  if (config.corsOrigins.length === 0) return null;
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin.length === 0) return null;
  if (!config.corsOrigins.includes(origin)) return null;
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers':
      'content-type, x-aion-tenant-id, authorization',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
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
    const cors = corsHeaders(config, req);

    const send = (status: number, body: unknown): void => {
      const payload = JSON.stringify(body);
      res.writeHead(status, {
        'content-type': 'application/json',
        ...(cors ?? {}),
      });
      res.end(payload);
      logger.info('http_request', {
        operation: `${method} ${url}`,
        status: String(status),
        latency_ms: Date.now() - started,
      });
    };

    // CORS preflight — only for allowlisted origins.
    if (method === 'OPTIONS') {
      if (cors) {
        res.writeHead(204, cors);
        res.end();
        return;
      }
      if (config.corsOrigins.length > 0) {
        send(403, { error: 'cors_origin_denied' });
        return;
      }
      send(405, { error: 'method_not_allowed' });
      return;
    }

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
          logger.info('listening', {
            operation: 'startup',
            status: 'ok',
            port: config.port,
            cors_origins: String(config.corsOrigins.length),
          });
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
