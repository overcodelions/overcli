import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createControlPlane, listenControlPlane } from './controlPlane';
import { AccessService, type Invite, type JoinRequest } from '../main/org/accessService';
import { parseOrgPolicy, type OrgCaller } from '../shared/org/policy';
import type { OrgService } from '../main/org/orgService';

const ADMIN: OrgCaller = { slackUserId: 'U0ACMEBOSS', name: 'Bo', admin: true };
const PAT: OrgCaller = { slackUserId: 'U0ACMEPAT', name: 'Pat', admin: false };

let invites: Invite[] = [];
let requests: JoinRequest[] = [];
const minted: string[] = [];
const access = new AccessService({
  policy: () => parseOrgPolicy({ name: 'Acme', admins: [ADMIN.slackUserId] }).policy,
  store: { invites: () => invites, saveInvites: (i) => (invites = i), requests: () => requests, saveRequests: (r) => (requests = r) },
  tokens: {
    create: (a) => {
      minted.push(a.name);
      return { token: `ocli_minted_${minted.length}` };
    },
    revokeFor: () => 0,
    revoke: () => true,
    list: () => [],
  },
  updateOrg: () => {},
});

let server: http.Server;
let base: string;

beforeAll(async () => {
  server = createControlPlane({
    org: { whoami: (c: OrgCaller) => ({ name: c.name }) } as unknown as OrgService,
    access,
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
const post = (path: string, body: unknown, token?: string): Promise<any> =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }).then((r) => r.json());

describe('invites over HTTP', () => {
  it('builds the link on the address the admin reached, and the link works without a token', async () => {
    const made = await post('/api/admin/invites', { name: 'Pat Lee', slackUserId: 'U0ACMEPAT', role: 'hirer' }, 'ocli_admin');
    expect(made.ok).toBe(true);
    expect(made.link.startsWith(`${base}/join/`)).toBe(true);
    const code = made.link.split('/join/')[1];
    const page = await fetch(`${base}/join/${code}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('/console.js');
    const info = (await (await fetch(`${base}/api/join/${code}`)).json()) as Record<string, unknown>;
    expect(info).toMatchObject({ ok: true, org: 'Acme', name: 'Pat Lee', role: 'hirer' });
    expect(await post(`/api/join/${code}`, { device: 'Browser' })).toMatchObject({ ok: true, token: expect.stringMatching(/^ocli_minted_/) });
    expect((await post(`/api/join/${code}`, {})).ok).toBe(false);
  });

  it('keeps invites and roles to admins', async () => {
    expect((await post('/api/admin/invites', { name: 'X', role: 'admin' }, 'ocli_pat')).ok).toBe(false);
    expect((await fetch(`${base}/api/admin/invites`)).status).toBe(401);
  });
});

describe('pairing over HTTP', () => {
  it('starts and polls without a token, and only a signed-in person can allow it', async () => {
    const start = await post('/api/pair/start', { device: 'Mac' });
    expect(start).toMatchObject({ ok: true, verifyUrl: `${base}/pair?code=${start.userCode}` });
    expect((await fetch(`${base}/pair?code=${start.userCode}`)).status).toBe(200);
    expect(await post('/api/pair/poll', { pairId: start.pairId, pollSecret: start.pollSecret })).toEqual({ ok: true, status: 'waiting' });
    expect((await fetch(`${base}/api/pair/${start.userCode}`, { method: 'POST', body: '{"allow":true}' })).status).toBe(401);
    expect(await post(`/api/pair/${start.userCode}`, { allow: true }, 'ocli_pat')).toEqual({ ok: true });
    expect(await post('/api/pair/poll', { pairId: start.pairId, pollSecret: start.pollSecret })).toMatchObject({ ok: true, status: 'signedIn', name: 'Pat' });
  });

  it('rate-limits the public routes per address', async () => {
    let limited = false;
    for (let i = 0; i < 70 && !limited; i++) {
      const res = await fetch(`${base}/api/join/aaaaaaaaaaaaaaaaaaaa`);
      if (res.status === 429) limited = true;
    }
    expect(limited).toBe(true);
  });
});

describe('where links point', () => {
  it('ignores forwarded headers from clients, and learns the address only from admins', async () => {
    const asPat = await fetch(`${base}/api/whoami`, { headers: { Authorization: 'Bearer ocli_pat', 'X-Forwarded-Host': 'evil.example' } });
    expect(asPat.ok).toBe(true);
    expect(access.baseUrl()).not.toContain('evil.example');
    await fetch(`${base}/api/whoami`, { headers: { Authorization: 'Bearer ocli_admin', 'X-Forwarded-Host': 'evil.example' } });
    expect(access.baseUrl()).toBe(base);
  });
});
