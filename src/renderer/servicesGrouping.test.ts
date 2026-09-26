import { describe, expect, it } from 'vitest';
import { groupNames, groupServices, runnableServices, UNGROUPED } from './servicesGrouping';
import type { ServiceSpec } from '@shared/services';

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

/// The real shape: two REST services, one module with three processor copies,
/// and a front end.
const services = [
  spec({ id: 'billing-rest', group: 'REST services' }),
  spec({ id: 'acme-rest', group: 'REST services' }),
  spec({ id: 'proc', name: 'AcmeProcessor', group: 'Processors' }),
  spec({ id: 'proc-infra', name: 'acme-proc-infra', copyOf: 'proc', group: 'Processors' }),
  spec({ id: 'proc-procs', name: 'acme-proc-procs', copyOf: 'proc', group: 'Processors' }),
  spec({ id: 'proc-dm', name: 'acme-proc-dm', copyOf: 'proc', group: 'Processors' }),
  spec({ id: 'admin-console', group: 'Front ends' }),
];

describe('groupServices', () => {
  it('groups by the service’s own free-text group', () => {
    expect(groupServices(services).map((g) => g.name)).toEqual([
      'REST services',
      'Processors',
      'Front ends',
    ]);
  });

  it('keeps group order by first appearance, so nobody has to learn a sort', () => {
    const reordered = [services[6], services[0]];
    expect(groupServices(reordered).map((g) => g.name)).toEqual(['Front ends', 'REST services']);
  });

  it('nests copies under the module they share', () => {
    const processors = groupServices(services).find((g) => g.name === 'Processors');
    expect(processors?.entries).toHaveLength(1);
    expect(processors?.entries[0].spec.id).toBe('proc');
    expect(processors?.entries[0].copies.map((c) => c.id)).toEqual([
      'proc-infra',
      'proc-procs',
      'proc-dm',
    ]);
  });

  it('counts copies in the group header', () => {
    // Four things run in that group, even though only one entry is listed.
    const processors = groupServices(services).find((g) => g.name === 'Processors');
    expect(processors?.count).toBe(4);
  });

  it('does not list a copy twice', () => {
    const listed = groupServices(services).flatMap((g) => g.entries.map((e) => e.spec.id));
    expect(listed).toEqual(['billing-rest', 'acme-rest', 'proc', 'admin-console']);
  });

  it('treats a copy whose base was removed as an ordinary service', () => {
    // Otherwise deleting the base makes four services vanish from the list
    // while still running.
    const orphaned = [spec({ id: 'proc-dm', copyOf: 'gone', group: 'Processors' })];
    const groups = groupServices(orphaned);
    expect(groups[0].entries[0].spec.id).toBe('proc-dm');
    expect(groups[0].count).toBe(1);
  });

  it('files a service with no group under Other rather than "undefined"', () => {
    const groups = groupServices([spec({ id: 'loose' }), spec({ id: 'blank', group: '  ' })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe(UNGROUPED);
    expect(groups[0].count).toBe(2);
  });
});

describe('groupNames', () => {
  it('lists the groups in use, alphabetically, for the picker', () => {
    expect(groupNames(services)).toEqual(['Front ends', 'Processors', 'REST services']);
  });

  it('ignores blanks', () => {
    expect(groupNames([spec({ id: 'a' }), spec({ id: 'b', group: '   ' })])).toEqual([]);
  });
});

describe('runnableServices', () => {
  it('drops a base that has copies, keeping the copies and ordinary services', () => {
    const ids = runnableServices([
      spec({ id: 'acme-proc' }),
      spec({ id: 'proc-infra', copyOf: 'acme-proc' }),
      spec({ id: 'proc-jobs', copyOf: 'acme-proc' }),
      spec({ id: 'acme-rest' }),
    ]).map((s) => s.id);
    expect(ids).toEqual(['proc-infra', 'proc-jobs', 'acme-rest']);
  });

  it('keeps a copy whose base is gone', () => {
    expect(runnableServices([spec({ id: 'proc-infra', copyOf: 'removed' })]).map((s) => s.id)).toEqual(['proc-infra']);
  });
});
