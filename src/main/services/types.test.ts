import { describe, expect, it } from 'vitest';
import { normalizeWatchPatterns, restartDependents, shouldRestartOnChange, startOrder } from './types';
import type { ServiceSpec } from './types';

function spec(over: Partial<ServiceSpec> & { id: string }): ServiceSpec {
  return {
    name: over.id,
    runner: 'command',
    command: ['true'],
    ready: { kind: 'none' },
    selfReloads: false,
    config: {},
    ...over,
  };
}

describe('shouldRestartOnChange', () => {
  it('leaves a self-reloading runner alone', () => {
    // ng serve and vite patch a running process better than we can from
    // outside — the correct action on a file change is none at all.
    expect(shouldRestartOnChange({ selfReloads: true, watch: ['src/**'] })).toBe(false);
  });

  it('restarts a watched runner that does not reload itself', () => {
    expect(shouldRestartOnChange({ selfReloads: false, watch: ['src/**'] })).toBe(true);
  });

  it('does nothing when nothing is watched', () => {
    expect(shouldRestartOnChange({ selfReloads: false })).toBe(false);
  });
});

describe('normalizeWatchPatterns', () => {
  it('keeps unique checkout-relative globs and rejects paths that escape it', () => {
    expect(normalizeWatchPatterns([
      ' src/** ', 'src/**', 'app\\**\\*.py', '../other/**', '/tmp/**', 'C:\\tmp\\**',
    ])).toEqual(['src/**', 'app/**/*.py']);
  });
});

describe('startOrder', () => {
  const specs = [
    spec({ id: 'web', deps: ['api'] }),
    spec({ id: 'api', deps: ['db', 'redis'] }),
    spec({ id: 'db' }),
    spec({ id: 'redis' }),
  ];

  it('brings dependencies up before the service, deepest first', () => {
    expect(startOrder(specs, 'web')).toEqual(['db', 'redis', 'api']);
  });

  it('excludes the service itself', () => {
    expect(startOrder(specs, 'db')).toEqual([]);
  });

  it('breaks a cycle rather than refusing to start anything', () => {
    // A mis-detected edge should degrade the ordering, not take the stack
    // down with it.
    const cyclic = [spec({ id: 'a', deps: ['b'] }), spec({ id: 'b', deps: ['a'] })];
    expect(startOrder(cyclic, 'a')).toEqual(['b']);
  });

  it('ignores an edge pointing at a service that is not in the stack', () => {
    expect(startOrder([spec({ id: 'api', deps: ['ghost'] })], 'api')).toEqual([]);
  });
});

describe('restartDependents', () => {
  const specs = [spec({ id: 'api' }), spec({ id: 'web', deps: ['api'] })];

  it('propagates nothing by default', () => {
    // An HTTP client reconnects. Restarting the frontend because the backend
    // restarted is the behaviour this whole model exists to avoid.
    expect(restartDependents(specs, 'api')).toEqual([]);
  });

  it('propagates only where the edge was marked', () => {
    const marked = [spec({ id: 'api', restartDependents: true }), spec({ id: 'web', deps: ['api'] })];
    expect(restartDependents(marked, 'api')).toEqual(['web']);
  });
});
