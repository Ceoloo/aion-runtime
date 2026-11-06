import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { ControlPlane } from '../control-plane.js';
import type { Logger } from '../logger.js';
import { loadConfig } from '../config.js';
import { createServer } from '../server.js';
import { gatewayListenHost, openGatewayBoundaryError } from './network-boundary.js';

test('only authenticated mode binds beyond loopback', () => {
  assert.equal(gatewayListenHost({ mode: 'open', apiKeys: [] }), '127.0.0.1');
  assert.equal(gatewayListenHost({ mode: 'required', apiKeys: [] }), '0.0.0.0');
});

test('open boundary rejects missing/malformed Host and opaque origins', () => {
  const auth = { mode: 'open' as const, apiKeys: [] };
  for (const host of [undefined, 'evil.test:8080', 'localhost.evil.test:8080',
    'localhost:8081', 'user@localhost:8080', '127.1:8080']) {
    const req = { headers: { host }, socket: { localPort: 8080 } } as http.IncomingMessage;
    assert.equal(openGatewayBoundaryError(req, auth, []), 'local_host_required');
  }
  const req = { headers: { host: 'localhost:8080', origin: 'null' },
    socket: { localPort: 8080 } } as http.IncomingMessage;
  assert.equal(openGatewayBoundaryError(req, auth, ['null']), 'cors_origin_denied');
});

test('HTTP boundary denies browser and rebinding requests before database or gateway work', async () => {
  let port = 0;
  let dbCalls = 0;
  const config = loadConfig({ DATABASE_URL: 'postgresql://test@localhost/test', GHL_BACKEND: 'fake' });
  config.port = 0;
  config.corsOrigins = ['http://localhost:5173'];
  const cp = { checkDatabase: async () => { dbCalls++; } } as unknown as ControlPlane;
  const logger = {
    info: (message: string, fields: { port?: number }) => {
      if (message === 'listening') port = fields.port!;
    }, error: () => {},
  } as unknown as Logger;
  const server = createServer(config, cp, logger);
  await server.listen();
  async function request(headers: http.OutgoingHttpHeaders = {}, method = 'GET', path = '/health/ready') {
    return new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode!));
      });
      req.on('error', reject);
      req.end();
    });
  }
  try {
    assert.equal(await request({ host: `evil.test:${port}` }), 403);
    assert.equal(await request({ origin: 'https://evil.test' }), 403);
    assert.equal(await request({ origin: 'null' }), 403);
    assert.equal(await request({ 'sec-fetch-site': 'cross-site' }), 403);
    assert.equal(await request({ origin: 'https://evil.test', 'content-type': 'text/plain' }, 'POST', '/v1/commands'), 403);
    assert.equal(await request({ origin: 'https://evil.test' }, 'OPTIONS'), 403);
    assert.equal(dbCalls, 0);
    assert.equal(await request(), 200);
    assert.equal(await request({ origin: `http://127.0.0.1:${port}` }), 200);
    assert.equal(await request({ origin: 'http://localhost:5173' }), 200);
    assert.equal(await request({ origin: 'http://localhost:5173' }, 'OPTIONS'), 204);
    assert.equal(dbCalls, 3);
  } finally {
    await server.close();
  }
});

test('required-auth boundary permits proxy hosts; authentication stays in gateway', () => {
  const req = { headers: { host: 'runtime.example.com' } } as http.IncomingMessage;
  assert.equal(openGatewayBoundaryError(req, { mode: 'required', apiKeys: [] }, []), null);
});
