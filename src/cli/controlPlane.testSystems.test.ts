import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createControlPlane, listenControlPlane } from './controlPlane';
import { AccessService } from '../main/org/accessService';
import type { OrgService } from '../main/org/orgService';
import type { TestSystemsService } from '../main/org/testSystems';
import { parseOrgPolicy, type OrgCaller } from '../shared/org/policy';

const ADMIN: OrgCaller = { slackUserId: 'U0ACMEBOSS', name: 'Bo', admin: true };
const PAT: OrgCaller = { slackUserId: 'U0ACMEPAT', name: 'Pat', admin: false };

let raw: Record<string, unknown> = { name: 'Acme', admins: [ADMIN.slackUserId] };
const access = new AccessService({
  policy: () => parseOrgPolicy(raw).policy,
  store: { invites: () => [], saveInvites: () => {}, requests: () => [], saveRequests: () => {} },
  tokens: { create: () => ({ token: 'x' }), revokeFor: () => 0, revoke: () => true, list: () => [] },
  updateOrg: (mutate) => {
    const next = structuredClone(raw);
    mutate(next);
    raw = next;
  },
});

// What each route handed the service, to check the routing and the arguments.
const calls: Array<[string, ...unknown[]]> = [];
const systems = {
  list: (c: OrgCaller) => (calls.push(['list', c.name]), { ok: true, systems: [], tool: 'test-systems' }),
  save: (c: OrgCaller, b: unknown) => (calls.push(['save', c.name, b]), { ok: true }),
  remove: (c: OrgCaller, id: string) => (calls.push(['remove', c.name, id]), { ok: true }),
  test: async (c: OrgCaller, id: string, env?: string) => (calls.push(['test', c.name, id, env]), { ok: true, detail: 'Signed in' }),
  discover: async (c: OrgCaller, url: string, user?: string) => (calls.push(['discover', c.name, url, user]), { ok: true, found: { name: 'Billing' } }),
} as unknown as TestSystemsService;

let server: http.Server;
let base: string;

beforeAll(async () => {
  server = createControlPlane({
    org: { whoami: (c: OrgCaller) => ({ name: c.name }) } as unknown as OrgService,
    access,
    testSystems: systems,
    log: () => {},
    authenticate: (t) => (t === 'ocli_admin' ? ADMIN : t === 'ocli_pat' ? PAT : null),
  });
  await listenControlPlane(server, { host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (method: string, path: string, body?: unknown, token = 'ocli_admin'): Promise<any> =>
  fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((r) => r.json());

describe('Setup → Apps to test over HTTP', () => {
  it('routes each call to the service with its arguments', async () => {
    calls.length = 0;
    expect((await call('GET', '/api/admin/test-systems')).tool).toBe('test-systems');
    await call('POST', '/api/admin/test-systems', { system: { name: 'Billing' }, credentials: { username: 'qa' }, previousId: 'old' });
    expect((await call('POST', '/api/admin/test-systems/billing/test', { environment: 'feature-12' })).detail).toBe('Signed in');
    await call('POST', '/api/admin/test-systems/billing/test', {});
    expect((await call('POST', '/api/admin/test-systems/discover', { url: 'https://staging.billing.acme.dev', username: 'qa@acme.dev' })).found.name).toBe('Billing');
    await call('POST', '/api/admin/test-systems/billing/remove', {});
    expect(calls).toEqual([
      ['list', 'Bo'],
      ['save', 'Bo', { system: { name: 'Billing' }, credentials: { username: 'qa' }, previousId: 'old' }],
      ['test', 'Bo', 'billing', 'feature-12'],
      ['test', 'Bo', 'billing', ''],
      ['discover', 'Bo', 'https://staging.billing.acme.dev', 'qa@acme.dev'],
      ['remove', 'Bo', 'billing'],
    ]);
  });

  it('takes no app id that isn’t a slug', async () => {
    calls.length = 0;
    const res = await fetch(`${base}/api/admin/test-systems/..%2Fx/test`, { method: 'POST', headers: { Authorization: 'Bearer ocli_admin' }, body: '{}' });
    expect(res.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('answers nobody without a token', async () => {
    expect((await fetch(`${base}/api/admin/test-systems`)).status).toBe(401);
  });
});

describe('starter roles over HTTP', () => {
  it('lists them, and an admin adds one to the catalog once', async () => {
    const list = await call('GET', '/api/roles/starters');
    expect(list.roles.map((r: { name: string }) => r.name)).toEqual(['Developer', 'QA', 'Analyst', 'PR Fixer', 'Test Automation']);
    expect(list.roles.every((r: { inCatalog: boolean }) => !r.inCatalog)).toBe(true);
    expect(await call('POST', '/api/roles/starters/add', { name: 'QA' })).toMatchObject({ ok: true, role: 'QA' });
    expect((await call('GET', '/api/roles/starters')).roles.find((r: { name: string }) => r.name === 'QA').inCatalog).toBe(true);
    expect(((raw.roles as Array<{ name: string }>) ?? []).filter((r) => r.name === 'QA')).toHaveLength(1);
  });

  it('keeps adding to admins, and refuses a name that isn’t a starter', async () => {
    expect((await call('POST', '/api/roles/starters/add', { name: 'Analyst' }, 'ocli_pat')).ok).toBe(false);
    expect((await call('POST', '/api/roles/starters/add', { name: 'Astronaut' })).ok).toBe(false);
  });
});

describe('pictures over HTTP', () => {
  it('draws by kind, and says the kinds', async () => {
    const robots = await call('GET', '/api/avatars?kind=drawn&group=robots');
    expect(robots.groups.map((g: { id: string }) => g.id)).toContain('robots');
    expect(new Set(robots.choices.map((c: { style: string }) => c.style))).toEqual(new Set(['voxel-bot', 'pixelbot']));
    expect(robots.choices.every((c: { url: string; preview: string }) => /\/png\?/.test(c.url) && /\/svg\?/.test(c.preview))).toBe(true);
  });

  it('puts drawn pictures first in a search for their kind, then the emoji', async () => {
    const found = await call('GET', '/api/avatars?q=robot');
    expect(found.choices[0].style).toMatch(/voxel-bot|pixelbot/);
    expect(found.choices.map((c: { style: string }) => c.style)).toContain('Robot');
    const owl = await call('GET', '/api/avatars?q=owl');
    expect(owl.choices[0].style).toBe('Owl');
    expect(owl.choices[0].preview).toBeUndefined();
  });
});
