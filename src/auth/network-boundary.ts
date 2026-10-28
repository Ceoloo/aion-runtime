import type { IncomingMessage } from 'node:http';
import type { GatewayAuthConfig } from './types.js';

/** Open proof/dev gateways must never become LAN-facing through a default bind. */
export function gatewayListenHost(auth: GatewayAuthConfig): string {
  return auth.mode === 'open' ? '127.0.0.1' : '0.0.0.0';
}

/** Runs before routing, including health and preflight. CORS alone is not CSRF protection. */
export function openGatewayBoundaryError(
  req: IncomingMessage,
  auth: GatewayAuthConfig,
  corsOrigins: readonly string[],
): string | null {
  if (auth.mode !== 'open') return null;
  const port = req.socket.localPort;
  const authorities = ['127.0.0.1', 'localhost'].flatMap((host) =>
    port === 80 ? [host, `${host}:80`] : [`${host}:${port}`],
  );
  const host = req.headers.host?.toLowerCase();
  // Exact authorities, no DNS resolution, forwarded-header trust or suffix matching.
  if (!host || !authorities.includes(host)) return 'local_host_required';
  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (origin === 'null' ||
        (origin !== `http://${host}` && !corsOrigins.includes(origin))) {
      return 'cors_origin_denied';
    }
  } else if (req.headers['sec-fetch-site'] === 'cross-site') {
    return 'cross_site_request_denied';
  }
  return null;
}
