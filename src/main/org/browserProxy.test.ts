import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import type { TestSystem } from '../../shared/testSystems';
import { HostJudge, appsOwn, startBrowserProxy, type BrowserProxy, type BrowserProxyDeps } from './browserProxy';
import { REFUSED_MARK } from './testSystemsSession';

const app = (url: string, envPattern?: string): TestSystem => ({
  id: 'billing',
  name: 'Billing',
  url,
  ...(envPattern ? { envPattern } : {}),
  signIn: { kind: 'none' },
  guide: '',
  workers: [],
});

const NAMES: Record<string, string[]> = {
  'docs.acme.dev': ['203.0.113.7'],
  'app.qa.acme.test': ['127.0.0.1'],
  'api.qa.acme.test': ['10.0.0.9'],
  'bill-7.feature.billing.acme.dev': ['10.0.4.7'],
  'evil.example': ['127.0.0.1'],
  'inside.example': ['10.1.1.1', '203.0.113.20'],
  'meta.acme.dev': ['169.254.169.254'],
  'meta.qa.acme.test': ['169.254.169.254'],
};
const lookup = async (h: string) => NAMES[h] ?? [];

describe('which hosts are the apps’ own', () => {
  const systems = [app('https://staging.billing.acme.dev', 'https://{env}.feature.billing.acme.dev'), app('http://10.1.2.3:8080'), app('https://shop.acme.co.uk')];
  it('takes a name and its siblings, an address only on its port, and never widens to a registry', () => {
    expect(appsOwn(systems, 'staging.billing.acme.dev', 443)).toBe(true);
    expect(appsOwn(systems, 'api.billing.acme.dev', 8443)).toBe(true);
    expect(appsOwn(systems, 'bill-7.feature.billing.acme.dev', 443)).toBe(true);
    expect(appsOwn(systems, '10.1.2.3', 8080)).toBe(true);
    expect(appsOwn(systems, '10.1.2.3', 22)).toBe(false);
    expect(appsOwn(systems, 'acme.dev', 443)).toBe(false);
    expect(appsOwn(systems, 'shop.acme.co.uk', 443)).toBe(true);
    expect(appsOwn(systems, 'evil.co.uk', 443)).toBe(false);
    expect(appsOwn(systems, 'billing.acme.dev.evil.example', 443)).toBe(false);
  });
});

describe('the proxy’s judgement', () => {
  const deps = (more: Partial<BrowserProxyDeps> = {}): BrowserProxyDeps => ({ systems: () => [app('http://app.qa.acme.test'), app('http://10.1.2.3:8080')], lookup, ...more });

  it('lets public names and the apps’ own private ones through, and nothing else private', async () => {
    const j = new HostJudge(deps());
    expect(await j.judge('docs.acme.dev', 443)).toEqual({ ok: true, ip: '203.0.113.7' });
    expect(await j.judge('api.qa.acme.test', 443)).toEqual({ ok: true, ip: '10.0.0.9' });
    expect(await j.judge('10.1.2.3', 8080)).toEqual({ ok: true, ip: '10.1.2.3' });
    for (const [h, p] of [['evil.example', 443], ['inside.example', 443], ['10.1.2.3', 22], ['127.0.0.1', 9464], ['localhost', 3000], ['x.localhost', 80], ['[::1]', 443], ['::ffff:7f00:1', 80], ['nowhere.example', 443], ['docs.acme.dev', 0]] as const) {
      expect((await j.judge(h, p)).ok, `${h}:${p}`).toBe(false);
    }
  });

  it('never opens a link-local (metadata) address, even on an app’s own domain', async () => {
    const j = new HostJudge(deps());
    expect((await j.judge('meta.acme.dev', 80)).ok).toBe(false);
    expect((await j.judge('meta.qa.acme.test', 80)).ok).toBe(false);
    expect((await j.judge('169.254.169.254', 80)).ok).toBe(false);
  });

  it('answers with the address it checked, so a name that changes its answer can’t slip inside', async () => {
    let t = 0;
    const answers = [['203.0.113.9'], ['127.0.0.1']];
    let asked = 0;
    const j = new HostJudge(deps({ lookup: async () => answers[Math.min(asked++, 1)], now: () => t }));
    expect(await j.judge('rebind.example', 443)).toEqual({ ok: true, ip: '203.0.113.9' });
    // Asked again soon: the same checked answer, not a fresh lookup.
    expect(await j.judge('rebind.example', 443)).toEqual({ ok: true, ip: '203.0.113.9' });
    expect(asked).toBe(1);
    // Once that answer is old, the new one is judged: inside, so refused.
    t = 60_000;
    expect((await j.judge('rebind.example', 443)).ok).toBe(false);
  });
});

describe('the proxy itself', () => {
  let proxy: BrowserProxy | null = null;
  const servers: net.Server[] = [];
  afterEach(async () => {
    await proxy?.close();
    proxy = null;
    for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  });

  const listen = async (s: net.Server) => {
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    return (s.address() as net.AddressInfo).port;
  };

  const get = (port: number, url: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const u = new URL(url);
      http
        .get({ host: '127.0.0.1', port, path: url, headers: { host: u.host } }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        })
        .on('error', reject);
    });

  const tunnel = (port: number, to: string) =>
    new Promise<{ status: number; socket: net.Socket; body: string }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: to });
      req.on('connect', (res, socket) => {
        let body = '';
        socket.on('data', (c) => (body += c));
        setTimeout(() => resolve({ status: res.statusCode ?? 0, socket, body }), 30);
      });
      req.on('error', reject);
      req.end();
    });

  it('proxies plain http to an app’s own private address, and refuses anyone else’s with a page that says why', async () => {
    // The far end notes what reached it and answers a fixed line: nothing it
    // was sent is echoed back.
    const seen: string[] = [];
    const upPort = await listen(
      http.createServer((req, res) => {
        seen.push(`host=${req.headers.host} path=${req.url}`);
        res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      }),
    );
    proxy = await startBrowserProxy({ systems: () => [app('http://app.qa.acme.test')], lookup });
    const ok = await get(proxy.port, `http://app.qa.acme.test:${upPort}/login?x=1`);
    expect(ok).toEqual({ status: 200, body: 'ok' });
    expect(seen).toEqual([`host=app.qa.acme.test:${upPort} path=/login?x=1`]);
    const refused = await get(proxy.port, `http://evil.example:${upPort}/`);
    expect(refused.status).toBe(403);
    expect(refused.body).toContain(REFUSED_MARK);
  });

  it('tunnels https to the checked address, and refuses a tunnel inside', async () => {
    const upPort = await listen(net.createServer((s) => s.on('data', (d) => s.write(`echo:${d}`))));
    const dialled: string[] = [];
    proxy = await startBrowserProxy({
      systems: () => [],
      lookup,
      connect: (ip, port) => {
        dialled.push(`${ip}:${port}`);
        return net.connect(upPort, '127.0.0.1');
      },
    });
    const open = await tunnel(proxy.port, 'docs.acme.dev:443');
    expect(open.status).toBe(200);
    open.socket.write('ping');
    await new Promise((r) => setTimeout(r, 50));
    open.socket.destroy();
    expect(dialled).toEqual(['203.0.113.7:443']);
    for (const to of ['meta.acme.dev:443', 'evil.example:443', '127.0.0.1:9464', 'localhost:443']) {
      const shut = await tunnel(proxy.port, to).catch(() => null);
      // Refused before any connection is made.
      if (shut) expect(shut.status, to).toBe(403);
    }
    expect(dialled).toEqual(['203.0.113.7:443']);
  });
});
