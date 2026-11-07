import { describe, expect, it } from 'vitest';
import { withoutMissingWorktree } from './missingWorktree';

describe('withoutMissingWorktree', () => {
  it('drops the tree and its flags, keeps the rest', () => {
    const c = { id: 'c', name: 'Chat', worktreePath: '/wt/x', branchName: 'agent/x', orphaned: true, adoptedWorktree: true };
    expect(withoutMissingWorktree(c)).toEqual({ id: 'c', name: 'Chat', branchName: 'agent/x' });
  });
});
