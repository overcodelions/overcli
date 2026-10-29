import { describe, expect, it } from 'vitest';
import { landsAs, planPicks, resolveRef } from './servicesBranchPicks';
import type { WorktreeChoice } from './worktreeChoices';

function tree(over: Partial<WorktreeChoice> & { ref: string; path: string }): WorktreeChoice {
  return { primary: false, detached: false, ...over } as WorktreeChoice;
}

describe('landsAs', () => {
  it('names a remote branch the way git checks it out', () => {
    expect(landsAs({ kind: 'branch', ref: 'origin/feature/x', remote: true })).toBe('feature/x');
    expect(landsAs({ kind: 'branch', ref: 'feature/x' })).toBe('feature/x');
    expect(landsAs({ kind: 'checkout', ref: 'feature/x', path: '/w' })).toBe('feature/x');
  });
});

describe('resolveRef', () => {
  const refs = {
    worktrees: [
      tree({ ref: 'feature/a', path: '/scratch/a' }),
      tree({ ref: 'master', path: '/repo', primary: true }),
    ],
    branches: [
      { ref: 'feature/b', remote: false },
      { ref: 'origin/feature/c', remote: true },
    ],
  };

  it('prefers a checkout, then a local branch, then a remote one', () => {
    expect(resolveRef('feature/a', refs)).toEqual({ kind: 'checkout', ref: 'feature/a', path: '/scratch/a' });
    expect(resolveRef('feature/b', refs)).toEqual({ kind: 'branch', ref: 'feature/b' });
    expect(resolveRef('feature/c', refs)).toEqual({ kind: 'branch', ref: 'origin/feature/c', remote: true });
  });

  it('takes the main checkout over a scratch one on the same ref', () => {
    const both = { worktrees: [tree({ ref: 'master', path: '/scratch' }), ...refs.worktrees], branches: [] };
    expect(resolveRef('master', both)).toEqual({ kind: 'checkout', ref: 'master', path: '/repo' });
  });

  it('is undefined when the repo has no such ref', () => {
    expect(resolveRef('feature/z', refs)).toBeUndefined();
  });
});

describe('planPicks', () => {
  const services = [
    { key: 'w/api', ref: 'master', path: '/repo' },
    { key: 'w/worker', ref: 'master', path: '/repo' },
    { key: 'w/web', ref: 'master', path: '/web' },
  ];

  it('rebinds onto existing checkouts and skips picks that change nothing', () => {
    const plan = planPicks(services, {
      'w/web': { kind: 'checkout', ref: 'feature/a', path: '/web-a' },
      'w/api': { kind: 'checkout', ref: 'master', path: '/repo' },
    });
    expect(plan.steps).toEqual([{ key: 'w/web', kind: 'rebind', ref: 'feature/a', path: '/web-a' }]);
    expect(plan.conflicts).toEqual([]);
  });

  it('moves everyone on a checked-out folder, picked or not', () => {
    const plan = planPicks(services, { 'w/api': { kind: 'branch', ref: 'origin/feature/b', remote: true } });
    expect(plan.steps).toEqual([
      { key: 'w/api', kind: 'checkout', ref: 'origin/feature/b', to: 'feature/b' },
      { key: 'w/worker', kind: 'follow', ref: 'feature/b', path: '/repo', after: 'w/api', picked: false },
    ]);
  });

  it('lets a service leave a folder before that folder is checked out', () => {
    const plan = planPicks(services, {
      'w/api': { kind: 'branch', ref: 'feature/b' },
      'w/worker': { kind: 'checkout', ref: 'feature/a', path: '/scratch/a' },
    });
    expect(plan.steps.map((s) => [s.key, s.kind])).toEqual([
      ['w/worker', 'rebind'],
      ['w/api', 'checkout'],
    ]);
  });

  it('refuses a second pick that wants the same folder on another branch', () => {
    const plan = planPicks(services, {
      'w/api': { kind: 'branch', ref: 'feature/b' },
      'w/worker': { kind: 'branch', ref: 'feature/c' },
    });
    expect(plan.conflicts).toEqual([{ key: 'w/worker', with: 'w/api' }]);
    expect(plan.steps.map((s) => s.key)).toEqual(['w/api']);
  });

  it('counts the same branch picked twice on one folder as one checkout', () => {
    const plan = planPicks(services, {
      'w/api': { kind: 'branch', ref: 'feature/b' },
      'w/worker': { kind: 'branch', ref: 'origin/feature/b', remote: true },
    });
    expect(plan.conflicts).toEqual([]);
    expect(plan.steps).toEqual([
      { key: 'w/api', kind: 'checkout', ref: 'feature/b', to: 'feature/b' },
      { key: 'w/worker', kind: 'follow', ref: 'feature/b', path: '/repo', after: 'w/api', picked: true },
    ]);
  });
});
