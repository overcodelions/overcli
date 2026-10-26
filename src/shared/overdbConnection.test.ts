import { describe, expect, it } from 'vitest';
import { overdbCredentialNote, parseConnectionPush, parseOverdbConnection } from './overdbConnection';

/// Exactly what overdb writes (its overcliInbox.test.ts makes the same one).
const fromOverdb = {
  version: 1,
  kind: 'overdb-connection',
  id: 'p1',
  createdAt: '2026-01-02T03:04:05.000Z',
  connection: {
    id: 'c1',
    name: 'shop-staging',
    env: 'staging',
    engine: 'postgres',
    host: 'db.internal',
    user: 'agents_ro',
    credential: { source: 'secret', env: 'OVERDB_SHOP_STAGING_PASSWORD' },
  },
};

describe('parseConnectionPush', () => {
  it('reads what overdb writes', () => {
    const res = parseConnectionPush(fromOverdb);
    expect(res).toEqual({ ok: true, push: fromOverdb });
  });

  it('drops fields it does not know rather than carrying them to the server', () => {
    const res = parseConnectionPush({
      ...fromOverdb,
      extra: 'x',
      connection: { ...fromOverdb.connection, password: 'hunter2', secretArgv: ['cat', '/etc/shadow'] },
    });
    expect(res.ok).toBe(true);
    expect(JSON.stringify(res)).not.toMatch(/hunter2|shadow|extra/);
  });

  it.each([
    ['another kind', { ...fromOverdb, kind: 'slow-query' }, /unknown kind/],
    ['a newer version', { ...fromOverdb, version: 2 }, /version 2/],
    ['no time', { ...fromOverdb, createdAt: 'yesterday' }, /createdAt/],
    ['a SQLite file', { ...fromOverdb, connection: { ...fromOverdb.connection, engine: 'sqlite' } }, /engine/],
    ['a command to run', { ...fromOverdb, connection: { ...fromOverdb.connection, credential: { source: 'command', argv: ['sh'] } } }, /credential/],
    ['a bad variable name', { ...fromOverdb, connection: { ...fromOverdb.connection, credential: { source: 'secret', env: 'x; rm -rf' } } }, /credential/],
    ['no host', { ...fromOverdb, connection: { ...fromOverdb.connection, host: '' } }, /host/],
  ])('refuses %s', (_label, raw, why) => {
    const res = parseConnectionPush(raw);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.reason).toMatch(why);
  });
});

describe('parseOverdbConnection', () => {
  it('takes DynamoDB with a region and the server role, never IAM tokens', () => {
    const dyn = { id: 'd', name: 'events', env: 'prod', engine: 'dynamodb', region: 'eu-west-1', credential: { source: 'none' } };
    expect(parseOverdbConnection(dyn).ok).toBe(true);
    expect(parseOverdbConnection({ ...dyn, credential: { source: 'aws-iam' } }).ok).toBe(false);
  });
});

describe('overdbCredentialNote', () => {
  it('names the variable, never a value', () => {
    const res = parseOverdbConnection(fromOverdb.connection);
    if (!res.ok) throw new Error(res.reason);
    expect(overdbCredentialNote(res.connection)).toContain('OVERDB_SHOP_STAGING_PASSWORD');
  });
});

describe('context', () => {
  it('travels with the connection, checked, and junk is dropped rather than the connection', () => {
    const context = {
      tenant: { schema: 'public', table: 'clients', column: 'id', via: ['client_id'] },
      notes: 'Amounts are in cents.',
      map: { builtAt: '2026-09-01T00:00:00.000Z', schemas: { public: 'fp' }, tables: { 'public.orders': { purpose: 'An order.', values: [{ column: 'status', values: ['pending'] }], json: [], rules: [] } }, links: [] },
    };
    const res = parseConnectionPush({ ...fromOverdb, connection: { ...fromOverdb.connection, context } });
    expect(res.ok && res.push.connection.context).toEqual(context);
    const junk = parseConnectionPush({ ...fromOverdb, connection: { ...fromOverdb.connection, context: { tenant: { schema: 1 }, notes: 9, evil: 'x' } } });
    expect(junk.ok && junk.push.connection.context).toBeUndefined();
  });
});
