// The test-systems browser's way out: a small HTTP proxy on loopback that
// every request the browser makes goes through (testSystemsServer.ts starts
// Playwright MCP with --proxy-server pointing here, loopback included). It
// looks each host up itself, refuses one that resolves to a private,
// loopback, link-local or reserved address (blockedAddress) unless it is
// one of the apps' own, and then connects to exactly the address it checked.
//
// Checking here rather than before each browser call covers what a check of
// the page's address can't: a frame, an image, a fetch from the page, a
// redirect mid-load, and a name whose DNS answer changes between the check
// and the browser's own lookup (the browser never looks anything up; the
// proxy does, once, and uses that answer).

import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';

import type { TestSystem } from '../../shared/testSystems';
import { REFUSED_MARK, blockedAddress } from './testSystemsSession';

export interface BrowserProxyDeps {
  /// The apps, read on each request: a change on Setup → Apps to test applies at once.
  systems(): TestSystem[];
  /// Hosts allowed beyond the apps' (Discover's address being read).
  alsoAllowed?: string[];
  /// Every address a name resolves to. Default: the system resolver.
  lookup?(host: string): Promise<string[]>;
  /// Opens the connection a CONNECT tunnels to. Default: net.connect.
  connect?(ip: string, port: number): net.Socket;
  now?(): number;
}

export interface BrowserProxy {
  /// `http://127.0.0.1:<port>`, for --proxy-server.
  url: string;
  port: number;
  close(): Promise<void>;
}

/// The cloud metadata ranges: never opened, even on an app's own domain.
const LINK_LOCAL = (() => {
  const b = new net.BlockList();
  b.addSubnet('169.254.0.0', 16, 'ipv4');
  b.addSubnet('fe80::', 10, 'ipv6');
  return b;
})();

function linkLocal(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '');
  if (net.isIPv4(bare)) return LINK_LOCAL.check(bare, 'ipv4');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare);
  if (mapped) return LINK_LOCAL.check(mapped[1], 'ipv4');
  return net.isIPv6(bare) && LINK_LOCAL.check(bare, 'ipv6');
}

const bareHost = (h: string) => h.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();

/// Where an app lives, as rules for its private addresses: an IP address on
/// its own port only; a name, that name and its siblings under the same
/// parent (an app at staging.billing.acme.dev calls api.billing.acme.dev;
/// a feature environment at bill-7.feature.billing.acme.dev, its own api).
function appRules(systems: TestSystem[], extra: string[]): Array<{ ip: string; port: number } | { domain: string }> {
  const rules: Array<{ ip: string; port: number } | { domain: string }> = [];
  for (const raw of [...systems.flatMap((s) => [s.url, s.envPattern ?? '']), ...extra]) {
    if (!raw) continue;
    let u: URL;
    try {
      u = new URL(raw.replace('{env}', 'env'));
    } catch {
      continue;
    }
    const host = bareHost(u.hostname);
    if (net.isIP(host)) {
      rules.push({ ip: host, port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80) });
      continue;
    }
    // The pattern's own host, then its parent: `{env}-web.qa.acme.dev`
    // allows anything under qa.acme.dev. Only from four labels up, so the
    // parent is never a registry's (`app.acme.co.uk` stays exact; widening it
    // to co.uk would let anyone's name that points inside through).
    const labels = host.split('.');
    rules.push({ domain: labels.length >= 4 ? labels.slice(1).join('.') : host });
  }
  return rules;
}

/// Whether `host:port` is one of the apps' own, so it may be private.
export function appsOwn(systems: TestSystem[], host: string, port: number, extra: string[] = []): boolean {
  const h = bareHost(host);
  return appRules(systems, extra).some((r) => ('ip' in r ? r.ip === h && r.port === port : h === r.domain || h.endsWith(`.${r.domain}`)));
}

export type Verdict = { ok: true; ip: string } | { ok: false; why: string };

const DNS_TTL_MS = 30_000;

async function systemLookup(host: string): Promise<string[]> {
  const found = await dns.promises.lookup(host, { all: true, verbatim: true });
  return found.map((a) => a.address);
}

/// The proxy's judgement of one destination, and the address to use.
export class HostJudge {
  private cache = new Map<string, { at: number; ips: string[] }>();

  constructor(private readonly deps: BrowserProxyDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async resolve(host: string): Promise<string[]> {
    const hit = this.cache.get(host);
    if (hit && this.now() - hit.at < DNS_TTL_MS) return hit.ips;
    const ips = await (this.deps.lookup ?? systemLookup)(host);
    this.cache.set(host, { at: this.now(), ips });
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value as string);
    return ips;
  }

  async judge(rawHost: string, port: number): Promise<Verdict> {
    const host = bareHost(rawHost);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, why: `${rawHost}:${port} isn’t an address the browser can open.` };
    const own = appsOwn(this.deps.systems(), host, port, this.deps.alsoAllowed ?? []);
    const refuse = `${host} is on a private network (or this server), so the browser doesn’t go there. Only the apps’ own environments may be private.`;
    if (!own && (host === 'localhost' || host.endsWith('.localhost'))) return { ok: false, why: refuse };
    let ips: string[];
    if (net.isIP(host)) ips = [host];
    else {
      try {
        ips = await this.resolve(host);
      } catch {
        return { ok: false, why: `${host} couldn’t be looked up.` };
      }
    }
    if (!ips.length) return { ok: false, why: `${host} couldn’t be looked up.` };
    if (ips.some(linkLocal)) return { ok: false, why: refuse };
    if (!own && ips.some(blockedAddress)) return { ok: false, why: refuse };
    // IPv4 first: a server without IPv6 routing fails on a v6 answer.
    return { ok: true, ip: ips.find((ip) => net.isIPv4(ip)) ?? ips[0] };
  }
}

function hostPort(authority: string, defaultPort: number): { host: string; port: number } | null {
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(authority.trim());
  if (!m) return null;
  return { host: m[1], port: m[2] ? Number(m[2]) : defaultPort };
}

const HOP_HEADERS = new Set(['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade']);

/// Start the proxy on 127.0.0.1, on a port of its own.
export async function startBrowserProxy(deps: BrowserProxyDeps): Promise<BrowserProxy> {
  const judge = new HostJudge(deps);
  const sockets = new Set<net.Socket>();
  const server = http.createServer(async (req, res) => {
    // A proxy request names the whole address: GET http://host/path.
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end(`${REFUSED_MARK} not a proxy request.`);
      return;
    }
    if (target.protocol !== 'http:') {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end(`${REFUSED_MARK} only http is proxied this way.`);
      return;
    }
    const port = Number(target.port) || 80;
    const verdict = await judge.judge(target.hostname, port);
    if (!verdict.ok) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end(`${REFUSED_MARK} ${verdict.why}`);
      return;
    }
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_HEADERS.has(k.toLowerCase()) && v !== undefined) headers[k] = v;
    headers.host = target.host;
    const upstream = http.request({ host: verdict.ip, port, method: req.method, path: `${target.pathname}${target.search}`, headers, setHost: false }, (up) => {
      const back: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(up.headers)) if (!HOP_HEADERS.has(k.toLowerCase()) && v !== undefined) back[k] = v;
      res.writeHead(up.statusCode ?? 502, back);
      up.pipe(res);
    });
    upstream.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`Couldn’t reach ${target.host}: ${err.message}`);
    });
    req.pipe(upstream);
  });
  // https, and WebSockets: a tunnel to host:port, opened to the checked address.
  server.on('connect', async (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    client.on('error', () => client.destroy());
    const at = hostPort(req.url ?? '', 443);
    const verdict = at ? await judge.judge(at.host, at.port) : ({ ok: false, why: 'not a host and port.' } as const);
    if (!at || !verdict.ok) {
      const body = `${REFUSED_MARK} ${verdict.ok ? '' : verdict.why}`;
      client.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
      return;
    }
    const upstream = (deps.connect ?? ((ip: string, port: number) => net.connect(port, ip)))(verdict.ip, at.port);
    upstream.on('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => {
      if (client.writable) client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    });
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
  });
  // A WebSocket over plain http comes as an upgrade, not a tunnel: not proxied.
  server.on('upgrade', (_req, socket: net.Socket) => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
  server.on('connection', (s: net.Socket) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
