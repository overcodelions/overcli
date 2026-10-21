import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolSignIn } from './toolSignIn';

const MCP = 'https://mcp.acme.example/mcp';
const AS = 'https://auth.acme.example';
const BASE = 'https://overcli.acme.example';
const admin = { name: 'Pat', slackUserId: 'U0PAT', admin: true };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/// An MCP server that wants OAuth, and its authorization server.
function service(opts: { registers?: boolean; prm?: boolean; refresh?: 'ok' | 'invalid_grant' } = {}) {
  const calls: Array<{ url: string; body: string; auth?: string }> = [];
  let issued = 0;
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const body = init?.body ? String(init.body) : '';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, body, ...(headers.Authorization ? { auth: headers.Authorization } : {}) });
    if (url === MCP) {
      return new Response('', { status: 401, headers: { 'WWW-Authenticate': `Bearer resource_metadata="https://mcp.acme.example/.well-known/oauth-protected-resource/mcp"` } });
    }
    if (url === 'https://mcp.acme.example/.well-known/oauth-protected-resource/mcp') {
      return opts.prm === false ? json({}, 404) : json({ resource: MCP, authorization_servers: [AS], scopes_supported: ['read', 'write'] });
    }
    if (url === `${AS}/.well-known/oauth-authorization-server`) {
      return json({
        issuer: AS,
        authorization_endpoint: `${AS}/authorize`,
        token_endpoint: `${AS}/token`,
        ...(opts.registers === false ? {} : { registration_endpoint: `${AS}/register` }),
        code_challenge_methods_supported: ['S256'],
        scopes_supported: ['read', 'write', 'offline_access'],
      });
    }
    if (url === `${AS}/register`) return json({ client_id: 'client-1', token_endpoint_auth_method: 'none' }, 201);
    if (url === `${AS}/token`) {
      const p = new URLSearchParams(body);
      if (p.get('grant_type') === 'refresh_token' && opts.refresh === 'invalid_grant') return json({ error: 'invalid_grant' }, 400);
      issued++;
      return json({ access_token: `access-${issued}`, refresh_token: `refresh-${issued}`, expires_in: 3600 });
    }
    return json({}, 404);
  };
  return { fetchImpl, calls };
}

function harness(svc: ReturnType<typeof service>, now = { t: 1_000_000 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-signin-'));
  dirs.push(dir);
  const key = randomBytes(32);
  const installed = new Map<string, { url: string; token: string }>();
  const signIn = new ToolSignIn({
    dir: () => dir,
    publicUrl: () => undefined,
    sealKey: async () => key,
    install: (name, url, token) => {
      installed.set(name, { url, token });
      return { ok: true };
    },
    installedUrl: (name) => installed.get(name)?.url,
    fetchImpl: svc.fetchImpl as never,
    now: () => now.t,
  });
  return { signIn, installed, dir, now };
}

async function signInAs(h: ReturnType<typeof harness>, input: Record<string, string> = {}) {
  const started = await h.signIn.start(admin, { name: 'acme', url: MCP, base: BASE, next: '#setup/tools', ...input });
  if (!started.ok) throw new Error(started.error);
  const page = new URL(started.url);
  return { started, page, back: await h.signIn.callback(new URLSearchParams({ state: page.searchParams.get('state')!, code: 'the-code' }), started.browserKey) };
}

describe('ToolSignIn', () => {
  it('finds the sign-in through the server’s metadata', async () => {
    const h = harness(service());
    expect(await h.signIn.discover(MCP, BASE)).toEqual({ ok: true, signIn: 'oauth', issuer: 'auth.acme.example', registers: true, redirectUri: `${BASE}/oauth/tools/callback` });
  });

  it('says a server with no sign-in metadata wants a token', async () => {
    const svc = service({ prm: false });
    const plain = harness({ ...svc, fetchImpl: (async (url: string, init?: RequestInit) => (url.includes('oauth-authorization-server') || url.includes('openid') ? new Response('', { status: 404 }) : svc.fetchImpl(url, init))) as never });
    expect(await plain.signIn.discover(MCP, BASE)).toEqual({ ok: true, signIn: 'token' });
  });

  it('registers, signs in with PKCE, and installs the tool with the token', async () => {
    const svc = service();
    const h = harness(svc);
    const { page, back } = await signInAs(h);
    expect(page.origin + page.pathname).toBe(`${AS}/authorize`);
    expect(page.searchParams.get('client_id')).toBe('client-1');
    expect(page.searchParams.get('code_challenge_method')).toBe('S256');
    expect(page.searchParams.get('resource')).toBe(MCP);
    expect(page.searchParams.get('scope')).toBe('read write offline_access');
    expect(back).toMatchObject({ ok: true, name: 'acme', by: 'Pat', location: '/#setup/tools?signedin=acme' });
    expect(h.installed.get('acme')).toEqual({ url: MCP, token: 'access-1' });
    const exchange = svc.calls.find((c) => c.url === `${AS}/token`)!;
    expect(new URLSearchParams(exchange.body).get('code_verifier')).toBeTruthy();
    expect(h.signIn.summaries().acme).toMatchObject({ by: 'Pat', issuer: 'auth.acme.example' });
    // The refresh token is sealed, never in the clear on disk.
    expect(fs.readFileSync(path.join(h.dir, 'tool-signins.json'), 'utf8')).not.toContain('refresh-1');
  });

  it('refuses a callback from another browser', async () => {
    const h = harness(service());
    const started = await h.signIn.start(admin, { name: 'acme', url: MCP, base: BASE });
    if (!started.ok) throw new Error(started.error);
    const state = new URL(started.url).searchParams.get('state')!;
    const back = await h.signIn.callback(new URLSearchParams({ state, code: 'c' }), 'someone-elses-cookie');
    expect(back).toMatchObject({ ok: false, reason: 'browser' });
    expect(h.installed.size).toBe(0);
    // The state was used up.
    expect(await h.signIn.callback(new URLSearchParams({ state, code: 'c' }), started.browserKey)).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('asks for a client when the service won’t register apps', async () => {
    const h = harness(service({ registers: false }));
    const started = await h.signIn.start(admin, { name: 'acme', url: MCP, base: BASE });
    expect(started).toMatchObject({ ok: false });
    const pasted = await h.signIn.start(admin, { name: 'acme', url: MCP, base: BASE, clientId: 'made-by-admin' });
    expect(pasted.ok && new URL(pasted.url).searchParams.get('client_id')).toBe('made-by-admin');
  });

  it('renews a token close to running out and rewrites the header', async () => {
    const svc = service();
    const h = harness(svc);
    await signInAs(h);
    await h.signIn.tick();
    expect(h.installed.get('acme')!.token).toBe('access-1');
    h.now.t += 45 * 60 * 1000;
    await h.signIn.tick();
    expect(h.installed.get('acme')!.token).toBe('access-2');
    const renew = svc.calls.filter((c) => c.url === `${AS}/token`).pop()!;
    expect(new URLSearchParams(renew.body).get('refresh_token')).toBe('refresh-1');
  });

  it('marks a sign-in the service ended', async () => {
    const h = harness(service({ refresh: 'invalid_grant' }));
    await signInAs(h);
    h.now.t += 59 * 60 * 1000;
    await h.signIn.tick();
    expect(h.signIn.summaries().acme).toMatchObject({ ended: true });
  });

  it('forgets a tool that was removed', async () => {
    const h = harness(service());
    await signInAs(h);
    h.installed.delete('acme');
    await h.signIn.tick();
    expect(h.signIn.summaries().acme).toBeUndefined();
  });
});
