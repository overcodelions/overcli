// The chip has to make "these changes are in an isolated tree" and "these
// changes are in the checkout you have open" tell apart at a glance — a bare
// branch name reads identically in both cases, which is the confusion the
// `local/` prefix exists to remove.

import { describe, expect, it } from 'vitest';
import { branchLabel } from './ChangesBar';

describe('branchLabel', () => {
  it('shows a worktree branch bare', () => {
    expect(branchLabel('feat/td-1443', true)).toEqual({
      label: 'feat/td-1443',
      title: 'Worktree on branch feat/td-1443 — isolated from your main checkout',
    });
  });

  it('prefixes the main checkout with local/', () => {
    expect(branchLabel('master', false)?.label).toBe('local/master');
  });

  it('renders nothing without a branch', () => {
    // Detached HEAD, a non-repo cwd, and a workspace whose members sit on
    // different branches all arrive here as an empty string.
    expect(branchLabel('', false)).toBeNull();
    expect(branchLabel(null, true)).toBeNull();
    expect(branchLabel(undefined, false)).toBeNull();
    expect(branchLabel('  ', true)).toBeNull();
  });
});
