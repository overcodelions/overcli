import { describe, expect, it } from 'vitest';
import { DEFAULT_ORG_POLICY, type OrgCaller } from '../../shared/org/policy';
import type { OverapiProject } from '../../shared/overapiProject';
import { OrgService, type OrgServiceDeps } from './orgService';
import type { ToolInput } from './tools';

const pat: OrgCaller = { slackUserId: 'U0ACMEPAT', name: 'Pat', admin: false };
const outsider: OrgCaller = { name: 'Lee', admin: false };
const admin: OrgCaller = { slackUserId: 'U0ACMEBOSS', name: 'Bo', admin: true };

const project = (over: { baseUrl?: string; allowWrites?: boolean; auth?: unknown } = {}) => ({
  overapi: 1,
  name: 'acme-orders',
  title: 'Acme Orders',
  description: 'Orders for the acme shop.',
  version: '0.1.0',
  envs: [
    {
      name: 'staging',
      baseUrl: over.baseUrl ?? 'https://orders.acme.example',
      auth: over.auth ?? { type: 'basic', userVar: 'ACME_USER', passVar: 'ACME_PASS' },
      allowWrites: over.allowWrites ?? true,
    },
  ],
  tools: [
    { id: 'GET /orders', name: 'list_orders', description: '', enabled: true, safety: 'read', method: 'GET', path: '/orders', params: [], bodyMode: 'none' },
    { id: 'POST /orders', name: 'create_order', description: '', enabled: true, safety: 'write', method: 'POST', path: '/orders', params: [], bodyMode: 'json-fields' },
    { id: 'DELETE /orders/{id}', name: 'delete_order', description: '', enabled: true, safety: 'destructive', method: 'DELETE', path: '/orders/{id}', params: [], bodyMode: 'none' },
  ],
});

const push = (over: Parameters<typeof project>[0] & { id?: string; secrets?: string[] } = {}) => ({
  version: 1,
  kind: 'overapi-project',
  id: over.id ?? 'p1',
  createdAt: '2026-11-01T10:00:00.000Z',
  env: 'staging',
  secrets: over.secrets ?? ['ACME_USER', 'ACME_PASS'],
  project: project(over),
});

const both = { ACME_USER: 'agent', ACME_PASS: 'pw-1' };

function harness(opts: { cli?: string | null } = {}) {
  const audit: string[] = [];
  const installs: ToolInput[] = [];
  const uninstalls: string[] = [];
  const files = new Map<string, OverapiProject>();
  // Each tool's env as installed: what the next install starts from.
  const installedEnv = new Map<string, Record<string, string>>();
  const svc = new OrgService({
    policy: () => ({ ...DEFAULT_ORG_POLICY, hirers: ['U0ACMEPAT'] }),
    audit: { append: (e: { what: string }) => audit.push(e.what), recent: () => [], all: () => [] },
    now: () => 0,
    tools: {
      list: () => ({ tools: [], missing: [] }),
      install: (input: ToolInput) => {
        installs.push(input);
        installedEnv.set(input.name, input.env ?? {});
        return { ok: true };
      },
      uninstall: (name: string) => {
        uninstalls.push(name);
        installedEnv.delete(name);
        return { ok: true };
      },
      check: async () => null,
    },
    overapi: {
      cliPath: () => (opts.cli === undefined ? '/opt/overapi/dist/cli/index.js' : opts.cli),
      projectFile: (name: string) => `/data/org/overapi/${name}.json`,
      writeProject: (name: string, p: OverapiProject) => files.set(name, structuredClone(p)),
      removeProject: (name: string) => files.delete(name),
      toolEnv: (tool: string) => installedEnv.get(tool) ?? {},
    },
  } as unknown as OrgServiceDeps);
  const list = () => {
    const res = svc.apis.list(admin);
    if (!res.ok) throw new Error(res.error);
    return res;
  };
  const offerId = () => list().offers[0].id;
  return { svc, audit, installs, uninstalls, files, list, offerId };
}

describe('APIs from overapi', () => {
  it('takes a published API from someone who may hire, and waits for an admin', () => {
    const h = harness();
    expect(h.svc.apis.publish(pat, { push: push() })).toEqual({ ok: true, waiting: true });
    expect(h.svc.apis.publish(outsider, { push: push() }).ok).toBe(false);
    expect(h.svc.apis.publish(pat, { push: { ...push(), env: 'prod' } }).ok).toBe(false);
    expect(h.svc.apis.publish(pat, { push: { ...push(), secrets: ['lower_case'] } }).ok).toBe(false);
    // Publishing it again replaces what Pat sent, rather than queueing a twin.
    h.svc.apis.publish(pat, { push: push({ id: 'p2' }) });
    expect(h.list().offers.map((o) => o.push.id)).toEqual(['p2']);
    const o = h.list().offers[0];
    expect(o.baseUrl).toBe('https://orders.acme.example');
    expect(o.tools.map((t) => `${t.name}:${t.safety}`)).toEqual(['list_orders:read', 'create_order:write', 'delete_order:destructive']);
    expect(h.svc.apis.list(pat).ok).toBe(false);
    expect(h.installs).toEqual([]);
  });

  it('needs every secret, over a private channel, from an admin', () => {
    const h = harness();
    h.svc.apis.publish(pat, { push: push() });
    const id = h.offerId();
    expect(h.svc.apis.approve(admin, id, { allowWrites: false, secrets: { ACME_USER: 'agent' } }, true)).toEqual({ ok: false, error: 'acme-orders needs ACME_PASS.' });
    expect(h.svc.apis.approve(admin, id, { allowWrites: false, secrets: { ...both, ACME_PASS: '' } }, true).ok).toBe(false);
    expect(h.svc.apis.approve(admin, id, { allowWrites: false, secrets: both }, false).ok).toBe(false);
    expect(h.svc.apis.approve(pat, id, { allowWrites: false, secrets: both }, true).ok).toBe(false);
    expect(h.installs).toEqual([]);
    expect([...h.files.keys()]).toEqual([]);
  });

  it('writes the project and installs its own tool, with the secrets only in its env', () => {
    const h = harness();
    h.svc.apis.publish(pat, { push: push() });
    // A secret the push does not name is not carried.
    expect(h.svc.apis.approve(admin, h.offerId(), { allowWrites: false, secrets: { ...both, OTHER: 'x' } }, true)).toEqual({ ok: true });
    expect(h.installs.at(-1)).toEqual({
      name: 'overapi-acme-orders',
      kind: 'command',
      command: 'node',
      args: ['/opt/overapi/dist/cli/index.js', 'serve', '/data/org/overapi/acme-orders.json', '--env', 'staging'],
      env: both,
    });
    // Read-only by default, whatever the publisher allowed.
    expect(h.files.get('acme-orders')!.envs).toEqual([{ ...project().envs[0], allowWrites: false }]);
    expect(h.files.get('acme-orders')!.tools).toHaveLength(3);
    const live = h.list();
    expect(live.offers).toEqual([]);
    expect(live.apis.map((a) => [a.name, a.allowWrites, a.missing])).toEqual([['acme-orders', false, []]]);
    expect(h.audit.join('\n')).not.toContain('pw-1');
    expect(h.audit.join('\n')).toContain('ACME_PASS');
    expect(h.audit.join('\n')).toContain('read-only');
  });

  it('allows writes only when both the publisher and the admin do', () => {
    const h = harness();
    h.svc.apis.publish(pat, { push: push({ allowWrites: false }) });
    h.svc.apis.approve(admin, h.offerId(), { allowWrites: true, secrets: both }, true);
    expect(h.files.get('acme-orders')!.envs[0].allowWrites).toBe(false);

    h.svc.apis.publish(pat, { push: push() });
    h.svc.apis.approve(admin, h.offerId(), { allowWrites: true, secrets: {} }, true);
    expect(h.files.get('acme-orders')!.envs[0].allowWrites).toBe(true);
  });

  it('keeps the secrets when an update points at the same place', () => {
    const h = harness();
    h.svc.apis.publish(pat, { push: push() });
    h.svc.apis.approve(admin, h.offerId(), { allowWrites: false, secrets: both }, true);
    h.svc.apis.publish(pat, { push: push({ id: 'p2' }) });
    const o = h.list().offers[0];
    expect([o.replaces, o.moved, o.kept]).toEqual([true, [], ['ACME_USER', 'ACME_PASS']]);
    expect(h.svc.apis.approve(admin, o.id, { allowWrites: false, secrets: {} }, true)).toEqual({ ok: true });
    expect(h.installs.at(-1)!.env).toEqual(both);
  });

  it('never sends kept secrets to a base URL an update changed', () => {
    const h = harness();
    h.svc.apis.publish(pat, { push: push() });
    h.svc.apis.approve(admin, h.offerId(), { allowWrites: false, secrets: both }, true);

    h.svc.apis.publish(pat, { push: push({ id: 'p2', baseUrl: 'https://orders.acme-elsewhere.example' }) });
    const o = h.list().offers[0];
    expect([o.moved, o.kept]).toEqual([['base URL'], []]);
    expect(h.svc.apis.approve(admin, o.id, { allowWrites: false, secrets: {} }, true)).toMatchObject({ ok: false, error: expect.stringMatching(/base URL.*ACME_USER, ACME_PASS again/) });
    expect(h.installs).toHaveLength(1);
    expect(h.files.get('acme-orders')!.envs[0].baseUrl).toBe('https://orders.acme.example');

    // Typed again, the admin chose to send them there.
    expect(h.svc.apis.approve(admin, o.id, { allowWrites: false, secrets: { ACME_USER: 'agent', ACME_PASS: 'pw-2' } }, true)).toEqual({ ok: true });
    expect(h.installs.at(-1)!.env).toEqual({ ACME_USER: 'agent', ACME_PASS: 'pw-2' });
  });

  it('removes an API: its tool, its secrets and its file', () => {
    const h = harness();
    h.svc.apis.publish(pat, { push: push() });
    h.svc.apis.approve(admin, h.offerId(), { allowWrites: false, secrets: both }, true);
    expect(h.svc.apis.remove(pat, 'acme-orders').ok).toBe(false);
    expect(h.svc.apis.remove(admin, 'acme-orders')).toEqual({ ok: true });
    expect(h.uninstalls).toEqual(['overapi-acme-orders']);
    expect([...h.files.keys()]).toEqual([]);
    expect(h.list().apis).toEqual([]);
    expect(h.svc.apis.remove(admin, 'acme-orders').ok).toBe(false);
  });

  it('dismisses an offer without setting anything up', () => {
    const h = harness();
    h.svc.apis.publish(pat, { push: push() });
    expect(h.svc.apis.dismissOffer(admin, h.offerId())).toEqual({ ok: true });
    expect(h.list().offers).toEqual([]);
    expect(h.installs).toEqual([]);
  });

  it('says overapi is missing rather than half setting it up', () => {
    const h = harness({ cli: null });
    h.svc.apis.publish(pat, { push: push() });
    const res = h.svc.apis.approve(admin, h.offerId(), { allowWrites: false, secrets: both }, true);
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/OVERAPI_CLI/) });
    expect([...h.files.keys()]).toEqual([]);
    expect(h.installs).toEqual([]);
    expect(h.list().cli).toBeNull();
  });
});
