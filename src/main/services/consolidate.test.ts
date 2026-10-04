import { describe, expect, it } from 'vitest';
import { differingNames, findSharedValues, machineNameFor, referToShared, withMachineValue } from './consolidate';
import type { ServiceSpec } from './types';

function spec(over: Partial<ServiceSpec> & { id: string }): ServiceSpec {
  return {
    name: over.id,
    runner: 'gradle',
    command: ['./gradlew', 'bootRun'],
    ready: { kind: 'none' },
    selfReloads: false,
    config: {},
    ...over,
  };
}

const stack = (...services: ServiceSpec[]) => [{ workspaceId: 'ws', services }];

describe('machineNameFor', () => {
  it('lands a system property and its env var on one name', () => {
    expect(machineNameFor('-Ddb.host')).toBe('DB_HOST');
    expect(machineNameFor('DB_HOST')).toBe('DB_HOST');
  });
});

describe('findSharedValues', () => {
  it('offers a value two services have typed identically', () => {
    const found = findSharedValues(
      stack(
        spec({ id: 'billing', config: { inject: { DB_HOST: 'db.acme.test' } } }),
        spec({ id: 'orders', options: [{ key: '-Ddb.host', value: 'db.acme.test' }] }),
      ),
      {},
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: 'DB_HOST', value: 'db.acme.test', secret: false });
    expect(found[0].uses.map((u) => [u.serviceId, u.kind, u.key])).toEqual([
      ['billing', 'env', 'DB_HOST'],
      ['orders', 'option', '-Ddb.host'],
    ]);
  });

  it('offers nothing for a name whose value differs in any service', () => {
    const stacks = stack(
      spec({ id: 'a', config: { inject: { REGION: 'us-east-1' } } }),
      spec({ id: 'b', config: { inject: { REGION: 'us-east-1' } } }),
      spec({ id: 'c', config: { inject: { REGION: 'eu-west-1' } } }),
    );
    expect(findSharedValues(stacks, {})).toEqual([]);
    expect(differingNames(stacks)).toEqual(['REGION']);
  });

  it('needs two services, not one service saying it twice', () => {
    expect(
      findSharedValues(
        stack(spec({ id: 'a', options: [{ key: '-Ddb.host', value: 'h1' }], config: { inject: { DB_HOST: 'h1' } } })),
        {},
      ),
    ).toEqual([]);
  });

  it('never matches on value alone', () => {
    expect(
      findSharedValues(
        stack(
          spec({ id: 'a', config: { inject: { DB_URL: 'jdbc:acme' } } }),
          spec({ id: 'b', config: { inject: { DATABASE_URL: 'jdbc:acme' } } }),
        ),
        {},
      ),
    ).toEqual([]);
  });

  it('skips ports, flags, references and disabled options', () => {
    expect(
      findSharedValues(
        stack(
          spec({
            id: 'a',
            options: [{ key: '-Dfeature.x', value: 'v1', enabled: false }],
            config: { inject: { SERVER_PORT: '8080', DEBUG: 'true', DB_USER: '${DB_USER}', TAG: '1' } },
          }),
          spec({
            id: 'b',
            options: [{ key: '-Dfeature.x', value: 'v1', enabled: false }],
            config: { inject: { SERVER_PORT: '8080', DEBUG: 'true', DB_USER: '${DB_USER}', TAG: '1' } },
          }),
        ),
        {},
      ),
    ).toEqual([]);
  });

  it('marks a credential as secret by name', () => {
    const [found] = findSharedValues(
      stack(
        spec({ id: 'a', options: [{ key: '-Ddb.password', value: 'hunter22' }] }),
        spec({ id: 'b', options: [{ key: '-Ddb.password', value: 'hunter22' }] }),
      ),
      {},
    );
    expect(found.secret).toBe(true);
  });

  it('tells an existing machine value it can reuse from one whose name is taken', () => {
    const stacks = stack(
      spec({ id: 'a', config: { inject: { DB_HOST: 'h1', QUEUE: 'acme-q' } } }),
      spec({ id: 'b', config: { inject: { DB_HOST: 'h1', QUEUE: 'acme-q' } } }),
    );
    const found = findSharedValues(stacks, { DB_HOST: 'h1', QUEUE: 'other-q' });
    expect(Object.fromEntries(found.map((f) => [f.name, f.existing]))).toEqual({ DB_HOST: 'same', QUEUE: 'different' });
  });

  it('keeps an id stable across scans', () => {
    const stacks = stack(
      spec({ id: 'a', config: { inject: { DB_HOST: 'h1' } } }),
      spec({ id: 'b', config: { inject: { DB_HOST: 'h1' } } }),
    );
    expect(findSharedValues(stacks, {})[0].id).toBe(findSharedValues(stacks, {})[0].id);
  });
});

describe('referToShared', () => {
  it('points each typed-in copy at the machine value', () => {
    const a = spec({ id: 'a', options: [{ key: '-Ddb.host', value: 'h1' }], config: { inject: { DB_HOST: 'h1', MODE: 'x' } } });
    const b = spec({ id: 'b', config: { inject: { DB_HOST: 'h1' } } });
    const chosen = findSharedValues(stack(a, b), {});

    const next = referToShared(a, chosen);
    expect(next.options).toEqual([{ key: '-Ddb.host', value: '${DB_HOST}' }]);
    expect(next.config.inject).toEqual({ DB_HOST: '${DB_HOST}', MODE: 'x' });
  });

  it('leaves a service alone when its value changed since the scan', () => {
    const a = spec({ id: 'a', config: { inject: { DB_HOST: 'h1' } } });
    const b = spec({ id: 'b', config: { inject: { DB_HOST: 'h1' } } });
    const chosen = findSharedValues(stack(a, b), {});
    const edited = spec({ id: 'a', config: { inject: { DB_HOST: 'h2' } } });
    expect(referToShared(edited, chosen).config.inject).toEqual({ DB_HOST: 'h2' });
  });

  it('returns the same spec when nothing applies', () => {
    const c = spec({ id: 'c' });
    expect(referToShared(c, [])).toBe(c);
  });
});

describe('withMachineValue', () => {
  it('injects the value under its own name', () => {
    const next = withMachineValue(spec({ id: 'a', config: { inject: { MODE: 'x' } } }), 'DB_HOST', true);
    expect(next.config.inject).toEqual({ MODE: 'x', DB_HOST: '${DB_HOST}' });
  });

  it('passes it as an option when asked', () => {
    const next = withMachineValue(spec({ id: 'a' }), 'DATABASE_PORT', true, { kind: 'option', key: '-Ddatabase.port' });
    expect(next.options).toEqual([{ key: '-Ddatabase.port', value: '${DATABASE_PORT}' }]);
    expect(next.config.inject).toBeUndefined();
  });

  it('puts the reference in place of an option the service already sets, switched on', () => {
    const a = spec({ id: 'a', options: [{ key: '-Ddatabase.port', value: '5432', enabled: false }, { key: '-Xmx2g' }] });
    const next = withMachineValue(a, 'DATABASE_PORT', true, { kind: 'option', key: '-Ddatabase.port' });
    expect(next.options).toEqual([{ key: '-Ddatabase.port', value: '${DATABASE_PORT}' }, { key: '-Xmx2g' }]);
  });

  it('adds nothing to a service that already refers to it', () => {
    const a = spec({ id: 'a', options: [{ key: '-Ddb.host', value: '${DB_HOST}' }] });
    expect(withMachineValue(a, 'DB_HOST', true)).toBe(a);
  });

  it('adds nothing to a copy whose base already passes it, and leaves that to the base', () => {
    const base = spec({ id: 'proc', options: [{ key: '-Ddatabase.port', value: '${DATABASE_PORT}' }] });
    const copy = spec({ id: 'proc-dm', copyOf: 'proc' });
    expect(withMachineValue(copy, 'DATABASE_PORT', true, { kind: 'option', key: '-Ddatabase.port' }, base)).toBe(copy);
    expect(withMachineValue(copy, 'DATABASE_PORT', false, { kind: 'env' }, base)).toBe(copy);
  });

  it('takes away exact references, never a longer value', () => {
    const a = spec({
      id: 'a',
      options: [{ key: '-Ddb.host', value: '${DB_HOST}' }, { key: '-Ddb.url', value: 'jdbc://${DB_HOST}/acme' }],
      config: { inject: { DB_HOST: '${DB_HOST}', DB_URL: 'jdbc://${DB_HOST}/acme' } },
    });
    const next = withMachineValue(a, 'DB_HOST', false);
    expect(next.config.inject).toEqual({ DB_URL: 'jdbc://${DB_HOST}/acme' });
    expect(next.options).toEqual([{ key: '-Ddb.url', value: 'jdbc://${DB_HOST}/acme' }]);
  });
});
