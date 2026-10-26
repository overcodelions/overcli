import { describe, expect, it } from 'vitest';
import { DEFAULT_ORG_POLICY, type OrgCaller } from '../../shared/org/policy';
import { OrgService, type OrgServiceDeps } from './orgService';
import { OVERDB_TOOL } from './overdb';
import type { ToolInput } from './tools';

const pat: OrgCaller = { slackUserId: 'U0ACMEPAT', name: 'Pat', admin: false };
const outsider: OrgCaller = { name: 'Lee', admin: false };
const admin: OrgCaller = { slackUserId: 'U0ACMEBOSS', name: 'Bo', admin: true };

const shopStaging = {
  id: 'c1',
  name: 'shop-staging',
  env: 'staging',
  engine: 'postgres',
  host: 'db.internal',
  user: 'agents_ro',
  credential: { source: 'secret', env: 'OVERDB_SHOP_STAGING_PASSWORD' },
};
const ordersProd = {
  id: 'c2',
  name: 'orders-prod',
  env: 'prod',
  engine: 'mysql',
  host: 'orders.internal',
  user: 'agents_ro',
  credential: { source: 'aws-iam' },
};

function harness(opts: { headless?: string | null } = {}) {
  const audit: string[] = [];
  const installs: ToolInput[] = [];
  // The overdb tool's env as installed: what the next install starts from.
  let installedEnv: Record<string, string> = {};
  let queryLog = '';
  const svc = new OrgService({
    policy: () => ({ ...DEFAULT_ORG_POLICY, hirers: ['U0ACMEPAT'] }),
    audit: { append: (e: { what: string }) => audit.push(e.what), recent: () => [], all: () => [] },
    now: () => 0,
    tools: {
      list: () => ({ tools: [], missing: [] }),
      install: (input: ToolInput) => {
        installs.push(input);
        installedEnv = input.env ?? {};
        return { ok: true };
      },
      uninstall: () => ({ ok: true }),
      check: async () => null,
    },
    overdb: {
      headlessPath: () => (opts.headless === undefined ? '/opt/overdb/dist/mcp/headless.js' : opts.headless),
      connectionsFile: () => '/data/org/overdb-connections.json',
      toolEnv: () => installedEnv,
      queryLogFile: () => '/data/org/overdb-queries.jsonl',
      readQueryLog: () => queryLog,
    },
  } as unknown as OrgServiceDeps);
  const offerId = (name: string) => {
    const list = svc.databases.overdbConnections(admin);
    if (!list.ok) throw new Error(list.error);
    return list.offers.find((o) => o.connection.name === name)!.id;
  };
  const file = () => {
    const list = svc.databases.overdbConnections(admin);
    if (!list.ok) throw new Error(list.error);
    return list.connections.map((c) => c.name);
  };
  return { svc, audit, installs, offerId, file, setQueryLog: (s: string) => (queryLog = s) };
}

describe('databases from overdb', () => {
  it('takes a published connection from someone who may hire, and waits for an admin', () => {
    const h = harness();
    expect(h.svc.databases.publishOverdbConnection(pat, { connection: shopStaging })).toEqual({ ok: true, waiting: true });
    expect(h.svc.databases.publishOverdbConnection(outsider, { connection: shopStaging }).ok).toBe(false);
    expect(h.svc.databases.publishOverdbConnection(pat, { connection: { ...shopStaging, engine: 'sqlite' } }).ok).toBe(false);
    // Publishing it again replaces what Pat sent, rather than queueing a twin.
    h.svc.databases.publishOverdbConnection(pat, { connection: { ...shopStaging, user: 'agents_ro2' } });
    const list = h.svc.databases.overdbConnections(admin);
    expect(list.ok && list.offers.map((o) => o.connection.user)).toEqual(['agents_ro2']);
    expect(h.svc.databases.overdbConnections(pat).ok).toBe(false);
    expect(h.installs).toEqual([]);
  });

  it('needs the password, over a private channel, before a password connection is set up', () => {
    const h = harness();
    h.svc.databases.publishOverdbConnection(pat, { connection: shopStaging });
    const id = h.offerId('shop-staging');
    expect(h.svc.databases.approveOverdbConnection(admin, id, undefined, true)).toEqual({ ok: false, error: 'shop-staging needs its password.' });
    expect(h.svc.databases.approveOverdbConnection(admin, id, 'pw-1', false).ok).toBe(false);
    expect(h.svc.databases.approveOverdbConnection(pat, id, 'pw-1', true).ok).toBe(false);
    expect(h.installs).toEqual([]);
    expect(h.file()).toEqual([]);
  });

  it('installs the overdb tool on the connections file, with each password only in its env', () => {
    const h = harness();
    h.svc.databases.publishOverdbConnection(pat, { connection: shopStaging });
    expect(h.svc.databases.approveOverdbConnection(admin, h.offerId('shop-staging'), 'pw-1', true)).toEqual({ ok: true });
    expect(h.installs.at(-1)).toEqual({
      name: OVERDB_TOOL,
      kind: 'command',
      command: 'node',
      args: ['/opt/overdb/dist/mcp/headless.js', '--connections', '/data/org/overdb-connections.json', '--query-log', '/data/org/overdb-queries.jsonl'],
      env: { OVERDB_SHOP_STAGING_PASSWORD: 'pw-1' },
    });

    // A second database keeps the first one's password.
    h.svc.databases.publishOverdbConnection(pat, { connection: ordersProd });
    expect(h.svc.databases.approveOverdbConnection(admin, h.offerId('orders-prod'), undefined, true)).toEqual({ ok: true });
    expect(h.installs.at(-1)!.env).toEqual({ OVERDB_SHOP_STAGING_PASSWORD: 'pw-1' });
    expect(h.file()).toEqual(['shop-staging', 'orders-prod']);

    // Removing one takes its password with it.
    expect(h.svc.databases.removeOverdbConnection(admin, 'c1')).toEqual({ ok: true });
    expect(h.installs.at(-1)!.env).toEqual({});
    expect(h.file()).toEqual(['orders-prod']);

    expect(h.audit.join('\n')).not.toContain('pw-1');
    expect(h.audit.join('\n')).toContain('OVERDB_SHOP_STAGING_PASSWORD');
  });

  it('keeps the file in the format overdb’s headless server reads', () => {
    const saved: unknown[] = [];
    const h = harness();
    // Swap in a store to see what is written.
    (h.svc as unknown as { deps: OrgServiceDeps }).deps.overdbConnections = {
      load: () => (saved.at(-1) as never) ?? { version: 1, connections: [] },
      save: (v) => saved.push(structuredClone(v)),
    };
    h.svc.databases.publishOverdbConnection(pat, { connection: ordersProd });
    h.svc.databases.approveOverdbConnection(admin, h.offerId('orders-prod'), undefined, true);
    expect(saved.at(-1)).toEqual({ version: 1, connections: [ordersProd] });
  });

  it('updates a connection published again, and refuses a different one under the same name', () => {
    const h = harness();
    h.svc.databases.publishOverdbConnection(pat, { connection: ordersProd });
    h.svc.databases.approveOverdbConnection(admin, h.offerId('orders-prod'), undefined, true);
    h.svc.databases.publishOverdbConnection(pat, { connection: { ...ordersProd, database: 'orders' } });
    const list = h.svc.databases.overdbConnections(admin);
    expect(list.ok && list.offers[0].replaces).toBe(true);
    expect(h.svc.databases.approveOverdbConnection(admin, h.offerId('orders-prod'), undefined, true)).toEqual({ ok: true });
    expect(h.file()).toEqual(['orders-prod']);

    h.svc.databases.publishOverdbConnection(pat, { connection: { ...ordersProd, id: 'other' } });
    expect(h.svc.databases.approveOverdbConnection(admin, h.offerId('orders-prod'), undefined, true)).toMatchObject({ ok: false, error: expect.stringMatching(/already set up/) });
  });

  it('never sends a kept password to an address an update changed', () => {
    const h = harness();
    h.svc.databases.publishOverdbConnection(pat, { connection: shopStaging });
    h.svc.databases.approveOverdbConnection(admin, h.offerId('shop-staging'), 'pw-1', true);

    // Same id, somewhere else, with TLS off.
    h.svc.databases.publishOverdbConnection(pat, { connection: { ...shopStaging, host: 'db.acme-elsewhere.example', ssl: 'disable' } });
    const list = h.svc.databases.overdbConnections(admin);
    expect(list.ok && list.offers[0].moved).toEqual(['host', 'ssl']);
    const id = h.offerId('shop-staging');
    expect(h.svc.databases.approveOverdbConnection(admin, id, undefined, true)).toMatchObject({ ok: false, error: expect.stringMatching(/host, ssl.*password again/) });
    expect(h.installs).toHaveLength(1);

    // Typed again, the admin chose to send it there.
    expect(h.svc.databases.approveOverdbConnection(admin, id, 'pw-2', true)).toEqual({ ok: true });
    expect(h.installs.at(-1)!.env).toEqual({ OVERDB_SHOP_STAGING_PASSWORD: 'pw-2' });
  });

  it('keeps the password when an update only changes what agents are told', () => {
    const h = harness();
    h.svc.databases.publishOverdbConnection(pat, { connection: shopStaging });
    h.svc.databases.approveOverdbConnection(admin, h.offerId('shop-staging'), 'pw-1', true);
    h.svc.databases.publishOverdbConnection(pat, { connection: { ...shopStaging, defaultSchema: 'shop' } });
    const list = h.svc.databases.overdbConnections(admin);
    expect(list.ok && list.offers[0].moved).toEqual([]);
    expect(h.svc.databases.approveOverdbConnection(admin, h.offerId('shop-staging'), undefined, true)).toEqual({ ok: true });
    expect(h.installs.at(-1)!.env).toEqual({ OVERDB_SHOP_STAGING_PASSWORD: 'pw-1' });
  });

  it('says overdb is missing rather than half setting it up', () => {
    const h = harness({ headless: null });
    h.svc.databases.publishOverdbConnection(pat, { connection: ordersProd });
    const res = h.svc.databases.approveOverdbConnection(admin, h.offerId('orders-prod'), undefined, true);
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/OVERDB_HEADLESS/) });
    expect(h.file()).toEqual([]);
    expect(h.installs).toEqual([]);
  });
});

describe('what workers asked of the databases', () => {
  it('reads the query log newest first, for admins only, skipping a torn line', () => {
    const h = harness();
    h.setQueryLog(
      [
        JSON.stringify({ at: '2026-10-24T10:00:00.000Z', worker: 'Triage', tool: 'query', connection: 'shop-staging', ok: true, ms: 4, sql: 'select 1', rowCount: 1 }),
        '{"at":"2026-10-24T10:01',
        JSON.stringify({ at: '2026-10-24T10:02:00.000Z', worker: 'Triage', tool: 'list_tables', connection: 'orders-prod', ok: false, ms: 1, error: 'No connection called "orders-prod" is open to agents.' }),
        '',
      ].join('\n'),
    );
    const res = h.svc.databases.overdbQueries(admin);
    expect(res.ok && res.queries.map((q) => q.tool)).toEqual(['list_tables', 'query']);
    expect(h.svc.databases.overdbQueries(pat).ok).toBe(false);
  });

  it('keeps what agents are told with the connection it finishes', () => {
    const h = harness();
    const context = { tenant: { schema: 'public', table: 'clients', column: 'id', via: ['client_id'] }, notes: 'Amounts are in cents.' };
    h.svc.databases.publishOverdbConnection(pat, { connection: { ...ordersProd, context } });
    h.svc.databases.approveOverdbConnection(admin, h.offerId('orders-prod'), undefined, true);
    const list = h.svc.databases.overdbConnections(admin);
    expect(list.ok && list.connections[0].context).toEqual(context);
  });
});
