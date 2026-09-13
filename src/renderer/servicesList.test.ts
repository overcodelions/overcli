import { describe, expect, it } from 'vitest';
import { buildServiceList, rangeBetween, sharedBranch, type RowItem } from './servicesList';
import type { ServiceRuntime, ServiceSpec, StackView } from '@shared/services';

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

const BRANCH = 'bugfix/ABC-5185-campaign-entities';

/// The real shape: one module with copies, a lone service, and a second group.
function stack(
  refs: Record<string, string> = {},
  runtimes: ServiceRuntime[] = [],
): StackView {
  const services = [
    spec({ id: 'admin', name: 'AcmeAdmin', group: 'acme-mono' }),
    spec({ id: 'rest', name: 'AcmeREST', group: 'acme-mono' }),
    spec({ id: 'rest-mem', name: 'AcmeRest (Memcached)', copyOf: 'rest', group: 'acme-mono' }),
    spec({ id: 'rest-red', name: 'AcmeRest (Redshift)', copyOf: 'rest', group: 'acme-mono' }),
    spec({ id: 'cms', name: 'content-svc', group: 'Core' }),
  ];
  return {
    workspaceId: 'ws',
    services,
    bindings: services.map((s) => ({ serviceId: s.id, ref: refs[s.id] ?? 'master', path: '/repo' })),
    runtimes,
  };
}

function build(over: Partial<Parameters<typeof buildServiceList>[0]> = {}) {
  return buildServiceList({
    stacks: [{ name: 'Acme', stack: stack() }],
    showWorkspaceNames: false,
    query: '',
    status: 'all',
    collapsed: {},
    ...over,
  });
}

const rows = (items: ReturnType<typeof build>['items']) =>
  items.filter((i): i is RowItem => i.kind === 'row');

describe('buildServiceList', () => {
  it('keeps the groups as the structure, with copies as plain rows in them', () => {
    expect(build().items.map((i) => (i.kind === 'row' ? i.spec.id : `${i.kind}:${i.name}`))).toEqual([
      'group:acme-mono',
      'admin',
      'rest-mem',
      'rest-red',
      'group:Core',
      'cms',
    ]);
  });

  it('shows no branch at all while everything is on its default branch', () => {
    const { items } = build();
    expect(items.some((i) => i.kind === 'group' && i.ref)).toBe(false);
    expect(rows(items).some((r) => r.showRef)).toBe(false);
  });

  it('names a feature branch on the rows that are on it', () => {
    const view = stack({ admin: BRANCH, 'rest-mem': BRANCH });
    const { items } = build({ stacks: [{ name: 'Acme', stack: view }] });
    expect(items.find((i) => i.kind === 'group')).toMatchObject({ ref: undefined });
    expect(rows(items).filter((r) => r.showRef).map((r) => r.spec.id)).toEqual(['admin', 'rest-mem']);
  });

  it('says it once on the group when the whole group is on it', () => {
    const view = stack({ admin: BRANCH, 'rest-mem': BRANCH, 'rest-red': BRANCH });
    const { items } = build({ stacks: [{ name: 'Acme', stack: view }] });
    expect(items.find((i) => i.kind === 'group')).toMatchObject({ ref: BRANCH });
    expect(rows(items).some((r) => r.showRef)).toBe(false);
  });

  it('gives a workspace header every service in it, for its switch', () => {
    const { items } = build({ showWorkspaceNames: true });
    expect(items[0]).toMatchObject({
      kind: 'workspace',
      rows: ['ws/admin', 'ws/rest-mem', 'ws/rest-red', 'ws/cms'],
    });
  });

  it('hides what is under a collapsed header but still selects all of it', () => {
    const { items, visible } = build({ collapsed: { 'group:ws:acme-mono': true } });
    expect(visible).toEqual(['ws/cms']);
    expect(items[0]).toMatchObject({ kind: 'group', collapsed: true, rows: ['ws/admin', 'ws/rest-mem', 'ws/rest-red'] });
  });

  it('folds a whole workspace under its header, and opens it while filtering', () => {
    const folded = build({ showWorkspaceNames: true, collapsed: { 'workspace:ws': true } });
    expect(folded.items).toHaveLength(1);
    expect(folded.items[0]).toMatchObject({ kind: 'workspace', collapsed: true, rows: ['ws/admin', 'ws/rest-mem', 'ws/rest-red', 'ws/cms'] });
    expect(folded.visible).toEqual([]);
    const filtered = build({ showWorkspaceNames: true, query: 'content', collapsed: { 'workspace:ws': true } });
    expect(filtered.visible).toEqual(['ws/cms']);
  });

  it('opens everything while filtering, and drops headers with nothing under them', () => {
    const { visible, items } = build({ query: 'redshift', collapsed: { 'group:ws:acme-mono': true } });
    expect(visible).toEqual(['ws/rest-red']);
    expect(items.some((i) => i.kind === 'group' && i.name === 'Core')).toBe(false);
  });

  it('filters by what is running and what has failed', () => {
    const view = stack({}, [
      { serviceId: 'admin', status: 'ready' },
      { serviceId: 'cms', status: 'failed' },
    ]);
    const running = build({ stacks: [{ name: 'Acme', stack: view }], status: 'running' });
    expect(running.visible).toEqual(['ws/admin']);
    expect(running.counts).toEqual({ all: 4, running: 1, problems: 1 });
    expect(build({ stacks: [{ name: 'Acme', stack: view }], status: 'problems' }).visible).toEqual(['ws/cms']);
  });
});

describe('sharedBranch', () => {
  it('is the feature branch only when every one is on it', () => {
    expect(sharedBranch([BRANCH, BRANCH])).toBe(BRANCH);
    expect(sharedBranch([BRANCH, 'master'])).toBeUndefined();
    expect(sharedBranch(['master', 'master'])).toBeUndefined();
    expect(sharedBranch([BRANCH, undefined])).toBeUndefined();
  });
});

describe('rangeBetween', () => {
  it('selects inclusively in either direction', () => {
    expect(rangeBetween(['a', 'b', 'c', 'd'], 'c', 'a')).toEqual(['a', 'b', 'c']);
  });

  it('falls back to the clicked row when the anchor has scrolled out of the list', () => {
    expect(rangeBetween(['a', 'b'], 'gone', 'b')).toEqual(['b']);
  });
});
