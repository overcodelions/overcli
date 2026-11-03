// The /metrics listener: Prometheus text from ServerMetrics, on its own port
// so it can stay inside the network while the console is reached some other
// way. Off unless `--metrics` / $OVERCLI_METRICS names an address.
//
// $OVERCLI_METRICS_TOKEN, when set, is required as a bearer token: worker
// names and spend are in the output, and not every network is one team.

import crypto from 'node:crypto';
import http from 'node:http';

import type { ServerMetrics } from '../main/org/metrics';
import { bearer } from './controlPlane';

export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/// What Setup → Readiness shows about metrics. Never the token itself.
export interface MetricsStatus {
  on: boolean;
  /// The port it listens on, when on.
  port?: number;
  /// Loopback only: nothing outside this machine (or container) can scrape it.
  loopback?: boolean;
  token: boolean;
  /// The last scrape that got the metrics, and the last turned away for want
  /// of the token. Since this start.
  lastScrapeAt?: number;
  lastRefusedAt?: number;
  /// A bad $OVERCLI_METRICS, or the port wouldn't open.
  error?: string;
}

export function createMetricsServer(
  metrics: ServerMetrics,
  opts: { token?: string; log?: (line: string) => void; onScrape?: (ok: boolean) => void } = {},
): http.Server {
  const want = opts.token ? crypto.createHash('sha256').update(opts.token).digest() : null;
  return http.createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://local').pathname;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    if (path !== '/metrics') {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found. Metrics are at /metrics.\n');
      return;
    }
    if (want) {
      // The control plane's prefix check: a regex here backtracks on a header
      // of whitespace, before the token is even compared.
      const given = bearer(req) ?? '';
      const got = crypto.createHash('sha256').update(given).digest();
      if (!crypto.timingSafeEqual(got, want)) {
        opts.onScrape?.(false);
        res.writeHead(401, { 'WWW-Authenticate': 'Bearer', 'Content-Type': 'text/plain' }).end('A bearer token is required.\n');
        return;
      }
    }
    let body: string;
    try {
      body = metrics.render();
    } catch (err) {
      opts.log?.(`metrics: could not read the server's state — ${err instanceof Error ? err.message : String(err)}`);
      res.writeHead(500, { 'Content-Type': 'text/plain' }).end('Could not read the server state.\n');
      return;
    }
    opts.onScrape?.(true);
    res.writeHead(200, { 'Content-Type': METRICS_CONTENT_TYPE, 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
}
