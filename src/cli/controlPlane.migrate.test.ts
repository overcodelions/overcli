// Moving the whole org through the control plane: GET /api/org/export and
// POST /api/org/import, as the console, the desktop's Move everything and
// `overcli org export|import` call them.

import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createControlPlane, listenControlPlane } from './controlPlane';
import type { OrgCaller } from '../shared/org/policy';
import { ORG_BUNDLE_FORMAT, ORG_BUNDLE_VERSION, type OrgBundle } from '../main/org/orgBundle';

const ADMIN: OrgCaller = { name: 'Alex', slackUserId: 'U0ACMEADM', admin: true };
const PAT: OrgCaller = { name: 'Pat', slackUserId: 'U0ACMEPAT', admin: false };

const bundle: OrgBundle = {
  format: ORG_BUNDLE_FORMAT,
  version: ORG_BUNDLE_VERSION,
  exportedAt: 1,
  source: { kind: 'server', org: 'Acme', slackTeamId: 'T0ACME001' },
  workers: [{ sourceId: 'w-1', yaml: 'worker:\n  name: Triage\n', trust: 'trusted', enabled: true }],
  teams: [],
  processes: [],
};

describe('org move routes', () => {
  let server: http.Server;
  let base: string;
  let imports: Array<{ dryRun?: boolean; start?: boolean; keepTrust?: boolean; workers: number }> = [];
  const report = (dryRun: boolean, keepsTrust: boolean) => ({ dryRun, keepsTrust, trustWhy: '', workers: [], teams: [], processes: [], setup: [], needsKeys: [], notes: [] });
  const org = {
    exportOrg: (c: OrgCaller) => (c.admin ? { ok: true, bundle: { ...bundle, processes: undefined }, left: ['Secret values.'] } : { ok: false, error: 'Only an admin can export the whole org.' }),
    exportSetup: () => ({ ok: true, setup: {} }),
    importOrg: async (c: OrgCaller, b: OrgBundle, opts: { dryRun?: boolean; start?: boolean; keepTrust?: boolean } = {}) => {
      if (!c.admin) return { ok: false, error: 'Only an admin can import an org.' };
      imports.push({ ...opts, workers: b.workers.length });
      return { ok: true, report: report(!!opts.dryRun, !!opts.keepTrust) };
    },
    importSetup: () => ({ ok: true, rows: [] }),
    publishedTeamId: () => undefined,
    publishedWorkerId: () => undefined,
  };
  const call = async (who: OrgCaller, method: string, p: string, body?: unknown) => {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: { Authorization: `Bearer ${who === ADMIN ? 'ocli_admin' : 'ocli_pat'}`, 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return (await res.json()) as Record<string, any>;
  };

  beforeAll(async () => {
    server = createControlPlane({
      org: org as never,
      log: () => {},
      authenticate: (t) => (t === 'ocli_admin' ? ADMIN : t === 'ocli_pat' ? PAT : null),
    });
    await listenControlPlane(server, { host: '127.0.0.1', port: 0 });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
  });
  beforeEach(() => {
    imports = [];
  });

  it('exports the org for an admin, as a file and what stayed behind', async () => {
    const res = await call(ADMIN, 'GET', '/api/org/export');
    expect(res).toMatchObject({ ok: true, bundle: { format: ORG_BUNDLE_FORMAT, source: { kind: 'server', org: 'Acme' }, processes: [] }, filename: expect.any(String) });
    expect(res.left.join(' ')).toMatch(/Secret values/);
  });

  it('refuses the export to someone who isn’t an admin', async () => {
    expect(await call(PAT, 'GET', '/api/org/export')).toMatchObject({ ok: false, error: expect.stringMatching(/admin/) });
  });

  it('imports a file, a dry run first, and only vouches for it when told to in so many words', async () => {
    const dry = await call(ADMIN, 'POST', '/api/org/import', { bundle, dryRun: true });
    expect(dry).toMatchObject({ ok: true, report: { dryRun: true, keepsTrust: false } });
    // Anything but true is no: "true" as a string doesn't vouch.
    await call(ADMIN, 'POST', '/api/org/import', { bundle, keepTrust: 'true', start: 1 });
    await call(ADMIN, 'POST', '/api/org/import', { bundle, keepTrust: true, start: true });
    const real = imports.filter((i) => i.workers > 0);
    expect(real).toEqual([
      { dryRun: true, start: false, keepTrust: false, workers: 1 },
      { dryRun: false, start: false, keepTrust: false, workers: 1 },
      { dryRun: false, start: true, keepTrust: true, workers: 1 },
    ]);
  });

  it('refuses something that isn’t an org file, before anything is imported', async () => {
    expect(await call(ADMIN, 'POST', '/api/org/import', { bundle: { format: 'nope' } })).toMatchObject({ ok: false, error: expect.stringMatching(/not an org file/) });
    expect(await call(ADMIN, 'POST', '/api/org/import', {})).toMatchObject({ ok: false });
    expect(imports).toEqual([]);
  });

  it('refuses the import to someone who isn’t an admin', async () => {
    expect(await call(PAT, 'POST', '/api/org/import', { bundle })).toMatchObject({ ok: false, error: expect.stringMatching(/admin/) });
  });
});
