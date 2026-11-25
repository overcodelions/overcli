import { describe, expect, it } from 'vitest';
import { launchPlacement } from './FlowLaunch';

const base = { canUseWorktree: true, baseBranch: 'main', existingBranch: 'feature/x' };

describe('launchPlacement', () => {
  it('runs in the main tree when asked, or when worktrees are unavailable', () => {
    expect(launchPlacement({ ...base, runIn: 'cwd' })).toEqual({ runIn: 'cwd' });
    expect(launchPlacement({ ...base, canUseWorktree: false, runIn: 'existing' })).toEqual({ runIn: 'cwd' });
  });

  it('forks a fresh worktree off the base branch', () => {
    expect(launchPlacement({ ...base, runIn: 'worktree' })).toEqual({ runIn: 'worktree', baseBranch: 'main' });
  });

  it('sends the existing branch, not a base, for an existing worktree', () => {
    expect(launchPlacement({ ...base, runIn: 'existing' })).toEqual({ runIn: 'worktree', existingBranch: 'feature/x' });
  });
});
