import { describe, expect, it } from 'vitest';
import { parseWorktreeList } from '@shared/worktrees';

describe('parseWorktreeList', () => {
  const porcelain = [
    'worktree /repos/billing-rest',
    'HEAD 9c5cc5960a4d8b0c1e2f3a4b5c6d7e8f90123456',
    'branch refs/heads/master',
    '',
    'worktree /wt/cost-ceiling',
    'HEAD 771a1aa31122334455667788990011223344aabb',
    'branch refs/heads/feat/cost-ceiling',
    '',
  ].join('\n');

  it('lists every checkout with its short branch name', () => {
    expect(parseWorktreeList(porcelain)).toEqual([
      { path: '/repos/billing-rest', ref: 'master', primary: true, detached: false },
      { path: '/wt/cost-ceiling', ref: 'feat/cost-ceiling', primary: false, detached: false },
    ]);
  });

  it('marks only the first entry as the main checkout', () => {
    // git always lists it first, and it is usually where a pinned service
    // should sit.
    expect(parseWorktreeList(porcelain).filter((w) => w.primary)).toHaveLength(1);
  });

  it('falls back to a short sha for a detached tree', () => {
    // "detached" repeated down a menu tells you nothing about which is which.
    const detached = [
      'worktree /wt/review',
      'HEAD abcdef1234567890abcdef1234567890abcdef12',
      'detached',
    ].join('\n');
    expect(parseWorktreeList(detached)[0]).toEqual({
      path: '/wt/review',
      ref: 'abcdef12',
      primary: true,
      detached: true,
    });
  });

  it('ignores a trailing blank block rather than emitting an empty row', () => {
    expect(parseWorktreeList(`${porcelain}\n\n`)).toHaveLength(2);
  });

  it('returns nothing for empty output', () => {
    expect(parseWorktreeList('')).toEqual([]);
  });
});
