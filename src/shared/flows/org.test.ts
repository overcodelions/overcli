import { describe, expect, it } from 'vitest';
import { buildOrgTree, countNodes, managerFor, reportsChain, wouldCycle } from './org';
import { validateOrgFields } from './worker';

interface W {
  id: string;
  name: string;
  enabled: boolean;
  reportsTo?: string;
  manager?: { name: string; slackUserId?: string };
}

const w = (id: string, extra: Partial<W> = {}): W => ({ id, name: id, enabled: true, ...extra });

describe('reportsChain', () => {
  it('walks up nearest first', () => {
    const roster = [w('chief'), w('pm', { reportsTo: 'chief' }), w('analyst', { reportsTo: 'pm' })];
    expect(reportsChain(roster, 'analyst').map((x) => x.id)).toEqual(['pm', 'chief']);
  });

  it('stops at a loop', () => {
    const roster = [w('a', { reportsTo: 'b' }), w('b', { reportsTo: 'a' })];
    expect(reportsChain(roster, 'a').map((x) => x.id)).toEqual(['b']);
  });

  it('skips a paused boss but keeps climbing', () => {
    const roster = [w('top'), w('mid', { reportsTo: 'top', enabled: false }), w('low', { reportsTo: 'mid' })];
    expect(reportsChain(roster, 'low').map((x) => x.id)).toEqual(['top']);
  });

  it('ends at a boss that no longer exists', () => {
    expect(reportsChain([w('low', { reportsTo: 'gone' })], 'low')).toEqual([]);
  });

  it('honours the hop limit', () => {
    const roster = [w('a'), w('b', { reportsTo: 'a' }), w('c', { reportsTo: 'b' }), w('d', { reportsTo: 'c' })];
    expect(reportsChain(roster, 'd', 2).map((x) => x.id)).toEqual(['c', 'b']);
  });

  it('ends a loop made entirely of paused workers', () => {
    const roster = [
      w('start', { reportsTo: 'x' }),
      w('x', { reportsTo: 'y', enabled: false }),
      w('y', { reportsTo: 'x', enabled: false }),
    ];
    expect(reportsChain(roster, 'start')).toEqual([]);
  });
});

describe('wouldCycle', () => {
  const roster = [w('a'), w('b', { reportsTo: 'a' }), w('c', { reportsTo: 'b' })];
  it('refuses reporting to yourself', () => expect(wouldCycle(roster, 'a', 'a')).toBe(true));
  it('refuses reporting to your own report', () => expect(wouldCycle(roster, 'a', 'c')).toBe(true));
  it('allows a fresh boss', () => expect(wouldCycle(roster, 'c', 'a')).toBe(false));
  it('allows clearing the boss', () => expect(wouldCycle(roster, 'c', undefined)).toBe(false));
});

describe('managerFor', () => {
  it('prefers the worker\'s own manager', () => {
    const roster = [w('boss', { manager: { name: 'Pat' } }), w('me', { reportsTo: 'boss', manager: { name: 'Sam' } })];
    expect(managerFor(roster, 'me')?.name).toBe('Sam');
  });

  it('inherits the nearest manager up the chain', () => {
    const roster = [
      w('chief', { manager: { name: 'Pat', slackUserId: 'U0ACME01' } }),
      w('pm', { reportsTo: 'chief' }),
      w('analyst', { reportsTo: 'pm' }),
    ];
    expect(managerFor(roster, 'analyst')?.slackUserId).toBe('U0ACME01');
  });

  it('is undefined with nobody managing the branch', () => {
    expect(managerFor([w('a', { reportsTo: 'b' }), w('b', { reportsTo: 'a' })], 'a')).toBeUndefined();
  });
});

describe('buildOrgTree', () => {
  it('groups roots by manager and nests reports', () => {
    const roster = [
      w('chief', { manager: { name: 'Pat' } }),
      w('pm', { reportsTo: 'chief' }),
      w('designer', { reportsTo: 'chief' }),
      w('solo', { manager: { name: 'pat' } }),
      w('stray'),
    ];
    const tree = buildOrgTree(roster);
    expect(tree).toHaveLength(2);
    expect(tree[0].manager?.name).toBe('Pat');
    expect(tree[0].roots.map((n) => n.worker.id)).toEqual(['chief', 'solo']);
    expect(tree[0].roots[0].reports.map((n) => n.worker.id)).toEqual(['pm', 'designer']);
    expect(tree[1].manager).toBeUndefined();
    expect(countNodes(tree[0].roots)).toBe(4);
  });

  it('draws a worker whose boss is gone as a root', () => {
    const tree = buildOrgTree([w('orphan', { reportsTo: 'gone' })]);
    expect(tree[0].roots.map((n) => n.worker.id)).toEqual(['orphan']);
  });

  it('never loses a worker caught in a loop', () => {
    const tree = buildOrgTree([w('a', { reportsTo: 'b' }), w('b', { reportsTo: 'a' })]);
    expect(countNodes(tree.flatMap((b) => b.roots))).toBe(2);
  });
});

describe('validateOrgFields', () => {
  it('accepts a full set', () => {
    expect(
      validateOrgFields({
        id: 'a',
        manager: { name: 'Pat Acme', slackUserId: 'U0ACME01' },
        reportsTo: 'b',
        visibility: 'team',
        avatarUrl: 'https://acme.example/pat.png',
      }),
    ).toBeNull();
  });

  it('refuses a malformed Slack id', () => {
    expect(validateOrgFields({ manager: { name: 'Pat', slackUserId: '@pat' } })).toMatch(/member ID/);
  });

  it('refuses a nameless manager', () => {
    expect(validateOrgFields({ manager: { name: '  ' } })).toMatch(/name/);
  });

  it('refuses reporting to yourself', () => {
    expect(validateOrgFields({ id: 'a', reportsTo: 'a' })).toMatch(/itself/);
  });

  it('refuses a non-https avatar', () => {
    expect(validateOrgFields({ avatarUrl: 'http://acme.example/a.png' })).toMatch(/https/);
    expect(validateOrgFields({ avatarUrl: 'file:///etc/passwd' })).toMatch(/https/);
  });

  it('refuses an unknown visibility', () => {
    expect(validateOrgFields({ visibility: 'public' as never })).toMatch(/ask/);
  });
});
