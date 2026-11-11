import { describe, expect, it } from 'vitest';
import { overapiToolName, parseApiPush } from './overapiProject';

const good = () => ({
  version: 1,
  kind: 'overapi-project',
  id: 'p1',
  createdAt: '2026-11-01T10:00:00.000Z',
  env: 'staging',
  secrets: ['ACME_TOKEN', 'ACME_TENANT'],
  project: {
    overapi: 1,
    name: 'acme-orders',
    title: 'Acme Orders',
    instructions: 'Amounts are in cents.',
    envs: [
      {
        name: 'staging',
        baseUrl: 'https://orders.acme.example',
        auth: { type: 'bearer', tokenVar: 'ACME_TOKEN' },
        allowWrites: false,
        headers: { 'X-Tenant': '${ACME_TENANT}' },
      },
    ],
    tools: [{ id: 'GET /orders', name: 'list_orders', method: 'GET', path: '/orders', safety: 'read', params: [], bodyMode: 'none', enabled: true }],
  },
});

describe('parseApiPush', () => {
  it('reads a push overapi wrote, carrying the project as published', () => {
    const res = parseApiPush(good());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.push.project.instructions).toBe('Amounts are in cents.');
    expect(res.push.project.tools[0].params).toEqual([]);
    expect(overapiToolName(res.push.project.name)).toBe('overapi-acme-orders');
  });

  it('refuses what the server could not serve safely', () => {
    const bad = (mutate: (p: ReturnType<typeof good>) => void) => {
      const p = good();
      mutate(p);
      return parseApiPush(p);
    };
    expect(bad((p) => (p.kind = 'overdb-connection')).ok).toBe(false);
    expect(bad((p) => (p.version = 2)).ok).toBe(false);
    expect(bad((p) => (p.env = 'prod')).ok).toBe(false);
    expect(bad((p) => (p.project.name = '../etc')).ok).toBe(false);
    expect(bad((p) => (p.project.name = 'Acme Orders')).ok).toBe(false);
    expect(bad((p) => (p.project.envs[0].baseUrl = 'file:///etc/passwd')).ok).toBe(false);
    expect(bad((p) => (p.secrets = ['acme_token'])).ok).toBe(false);
    expect(bad((p) => ((p.project.tools[0] as Record<string, unknown>).safety = 'maybe')).ok).toBe(false);
    expect(bad((p) => ((p.project.tools[0] as Record<string, unknown>).method = 'FETCH')).ok).toBe(false);
    expect(bad((p) => ((p.project.tools[0] as Record<string, unknown>).name = undefined)).ok).toBe(false);
  });

  it('refuses a variable the environment reads but does not list as a secret', () => {
    const p = good();
    p.secrets = ['ACME_TOKEN'];
    const res = parseApiPush(p);
    expect(res).toMatchObject({ ok: false, reason: expect.stringMatching(/ACME_TENANT/) });
  });
});

describe('log in with a request, and steps that run first', () => {
  // overapi's "log in with a request": the login tool rides along (even
  // though agents never see it), its password a ${SECRET} in its saved values.
  const withLogin = () => {
    const p = good();
    p.secrets = ['ACME_TENANT', 'ACME_PASSWORD'];
    (p.project.envs[0] as Record<string, unknown>).auth = { type: 'login', toolId: 'POST /auth/login', from: 'body', path: 'data.access_token', sendAs: 'bearer', refreshMinutes: 50 };
    p.project.tools.push({
      id: 'POST /auth/login',
      name: 'login',
      method: 'POST',
      path: '/auth/login',
      safety: 'write',
      params: [],
      bodyMode: 'json-fields',
      enabled: false,
      example: { user: 'wile', password: '${ACME_PASSWORD}' },
    } as never);
    (p.project.tools[0] as Record<string, unknown>).before = [{ toolId: 'POST /auth/login', when: 'missing', var: 'token' }];
    return p;
  };

  it('reads them', () => {
    const res = parseApiPush(withLogin());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.push.project.envs[0].auth).toEqual({ type: 'login', toolId: 'POST /auth/login', from: 'body', path: 'data.access_token', sendAs: 'bearer', refreshMinutes: 50 });
  });

  it('asks for the login request’s secrets, not only the environment’s', () => {
    const p = withLogin();
    p.secrets = ['ACME_TENANT'];
    expect(parseApiPush(p)).toMatchObject({ ok: false, reason: expect.stringMatching(/ACME_PASSWORD/) });
  });

  it('refuses a sign-in or a first step pointing at a request that isn’t there', () => {
    const noLogin = withLogin();
    noLogin.project.tools = noLogin.project.tools.filter((t) => t.name !== 'login');
    (noLogin.project.tools[0] as Record<string, unknown>).before = undefined;
    expect(parseApiPush(noLogin)).toMatchObject({ ok: false, reason: expect.stringMatching(/signs in with POST \/auth\/login/) });

    const badStep = withLogin();
    (badStep.project.tools[0] as Record<string, unknown>).before = [{ toolId: 'GET /nope', when: 'always' }];
    expect(parseApiPush(badStep)).toMatchObject({ ok: false, reason: expect.stringMatching(/runs GET \/nope first/) });

    const badKind = withLogin();
    ((badKind.project.envs[0] as Record<string, unknown>).auth as Record<string, unknown>).sendAs = 'carrier-pigeon';
    expect(parseApiPush(badKind).ok).toBe(false);
  });
});
