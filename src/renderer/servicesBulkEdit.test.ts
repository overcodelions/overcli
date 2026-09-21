import { describe, expect, it } from 'vitest';
import { buildProbe, describeReady, planBulkEdit, portFor, type BulkService } from './servicesBulkEdit';

function service(over: Partial<BulkService> & { key: string }): BulkService {
  return {
    name: over.key,
    ref: 'master',
    reachableRefs: ['master', 'feat/price-caps'],
    ...over,
    spec: {
      selfReloads: false,
      ready: { kind: 'none' },
      port: 8080,
      ...over.spec,
    },
  };
}

describe('a field left alone', () => {
  it('writes nothing at all', () => {
    // The rule the whole modal rests on: opening this on eight services to
    // change one thing must not touch the other four fields.
    const plan = planBulkEdit([service({ key: 'a' }), service({ key: 'b' })], {});
    expect(plan.changing).toBe(0);
    expect(plan.blocked).toBe(0);
    expect(plan.unchanged).toBe(2);
    expect(plan.rows.every((r) => r.changes.length === 0)).toBe(true);
  });

  it('is not the same answer as clearing it', () => {
    // `group: ''` empties the group; `group: undefined` leaves it. A single
    // optional field would have collapsed the two.
    const grouped = service({ key: 'a', spec: { selfReloads: false, ready: { kind: 'none' }, group: 'core' } });
    expect(planBulkEdit([grouped], {}).changing).toBe(0);
    expect(planBulkEdit([grouped], { group: '' }).rows[0].changes[0]).toMatchObject({
      field: 'group',
      now: 'core',
      after: 'ungrouped',
    });
  });
});

describe('branch', () => {
  it('counts a service already there as unchanged, not as changing', () => {
    const plan = planBulkEdit([service({ key: 'a', ref: 'master' })], { ref: 'master' });
    expect(plan.changing).toBe(0);
    expect(plan.unchanged).toBe(1);
  });

  it('blocks one whose repo has no such branch, and says so', () => {
    // One flow usually touches two of six repos; this is the common case,
    // not an error.
    const plan = planBulkEdit(
      [service({ key: 'a', reachableRefs: ['master'] })],
      { ref: 'feat/price-caps' },
    );
    expect(plan.changing).toBe(0);
    expect(plan.blocked).toBe(1);
    expect(plan.rows[0].blocks[0]).toMatchObject({ field: 'branch', reason: 'no such branch in its repo' });
  });

  it('blocks a pinned service, and names the pin', () => {
    const pinned = service({
      key: 'a',
      ref: 'TASK-1',
      spec: { selfReloads: false, ready: { kind: 'none' }, pinnedRef: 'TASK-1' },
    });
    expect(planBulkEdit([pinned], { ref: 'master' }).rows[0].blocks[0].reason).toBe('pinned to TASK-1');
  });

  it('lets an explicit pin replace an older one', () => {
    // Pinning is the stronger act: it is meant to override the pin already
    // there, where an ordinary move must not.
    const pinned = service({
      key: 'a',
      ref: 'TASK-1',
      spec: { selfReloads: false, ready: { kind: 'none' }, pinnedRef: 'TASK-1' },
    });
    const plan = planBulkEdit([pinned], { ref: 'master', pin: true });
    expect(plan.blocked).toBe(0);
    expect(plan.rows[0].changes[0]).toMatchObject({ field: 'branch', after: 'master' });
  });
});

describe('ready when', () => {
  it('keeps each service its own port', () => {
    // The reason this field is safe in bulk: the path is shared across a
    // stack of Spring services, the port never is.
    const plan = planBulkEdit(
      [
        service({ key: 'a', spec: { selfReloads: false, ready: { kind: 'tcp', port: 5002 } } }),
        service({ key: 'b', spec: { selfReloads: false, ready: { kind: 'none' }, port: 5024 } }),
      ],
      { ready: { kind: 'http', path: '/actuator/health' } },
    );
    expect(plan.rows[0].changes[0].after).toBe('GET :5002/actuator/health');
    expect(plan.rows[1].changes[0].after).toBe('GET :5024/actuator/health');
  });

  it('blocks a service with no port rather than inventing one', () => {
    const portless = service({ key: 'a', spec: { selfReloads: false, ready: { kind: 'none' }, port: undefined } });
    const plan = planBulkEdit([portless], { ready: { kind: 'http', path: '/health' } });
    expect(plan.rows[0].blocks[0]).toMatchObject({ field: 'ready', reason: 'no port — give it one first' });
    expect(plan.changing).toBe(0);
  });

  it('still takes a log probe on a service with no port', () => {
    // Matching output needs no port, so the block must be about the shape
    // asked for, not about the service.
    const portless = service({ key: 'a', spec: { selfReloads: false, ready: { kind: 'none' }, port: undefined } });
    const plan = planBulkEdit([portless], { ready: { kind: 'log', pattern: 'Started' } });
    expect(plan.blocked).toBe(0);
    expect(plan.rows[0].changes[0].after).toBe('output matches /Started/');
  });

  it('does not count an identical probe as a change', () => {
    const already = service({
      key: 'a',
      spec: { selfReloads: false, ready: { kind: 'http', path: '/actuator/health', port: 8080 } },
    });
    expect(planBulkEdit([already], { ready: { kind: 'http', path: '/actuator/health' } }).changing).toBe(0);
  });

  it('reads the port off the probe before the service', () => {
    // A service serving on one port and probed on another keeps the probe's.
    const spec = { selfReloads: false, ready: { kind: 'tcp', port: 9999 } as const, port: 8080 };
    expect(portFor(spec)).toBe(9999);
  });
});

describe('reload', () => {
  it('changes only the ones that are not already set that way', () => {
    const plan = planBulkEdit(
      [
        service({ key: 'off' }),
        service({ key: 'on', spec: { selfReloads: false, ready: { kind: 'none' }, watch: ['src/**'] } }),
      ],
      { reload: 'restart' },
    );
    expect(plan.changing).toBe(1);
    expect(plan.rows[0].changes[0]).toMatchObject({ field: 'reload', now: 'nothing', after: 'restarts' });
  });
});

describe('several fields at once', () => {
  it('reports one row with a change per field, and blocks independently', () => {
    // A row can be blocked on branch and still change its group: a block is
    // per field, not per service.
    const plan = planBulkEdit(
      [service({ key: 'a', reachableRefs: ['master'], spec: { selfReloads: false, ready: { kind: 'none' }, group: 'old' } })],
      { ref: 'nope', group: 'core', reload: 'restart' },
    );
    expect(plan.rows[0].changes.map((c) => c.field)).toEqual(['reload', 'group']);
    expect(plan.rows[0].blocks.map((b) => b.field)).toEqual(['branch']);
    expect(plan.changing).toBe(1);
  });
});

describe('buildProbe', () => {
  it('refuses a port-shaped probe without a port', () => {
    expect(buildProbe({ kind: 'http', path: '/x' }, undefined)).toBeUndefined();
    expect(buildProbe({ kind: 'tcp' }, undefined)).toBeUndefined();
  });

  it('falls back to a root path rather than writing an empty one', () => {
    expect(buildProbe({ kind: 'http', path: '' }, 80)).toEqual({ kind: 'http', path: '/', port: 80 });
  });

  it('describes every probe kind, including one it cannot set', () => {
    expect(describeReady({ kind: 'command', command: ['pg_isready', '-q'] })).toBe('pg_isready -q');
    expect(describeReady({ kind: 'none' })).toBe('ready on start');
  });
});
