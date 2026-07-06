import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }));

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
  spawnSync: vi.fn(() => ({ stdout: '', stderr: '', status: 0 })),
}));

vi.mock('node:fs', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    default: { ...real, existsSync: () => true },
    existsSync: () => true,
    promises: {
      ...real.promises,
      // No untracked files in these fixtures, so disk reads never run.
      stat: vi.fn(),
      readFile: vi.fn(),
    },
  };
});

import { worktreeChanges } from './git';

/// Route each git invocation to a canned stdout by matching the argv. Any
/// unmatched command resolves empty (exit 0) so the function's optional
/// probes don't blow up the fixture.
function routeGit(byCmd: Record<string, string>) {
  mockExecFile.mockImplementation((_bin, args: string[], _opts, cb) => {
    const cmd = args.join(' ');
    const stdout = byCmd[cmd] ?? '';
    cb(null, stdout, '');
  });
}

beforeEach(() => {
  mockExecFile.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('worktreeChanges', () => {
  it('counts committed + uncommitted files vs the fork point', async () => {
    // The bug scenario: one file committed into the branch, one still
    // uncommitted. `git diff --numstat <base>` rolls both into one pass.
    routeGit({
      'rev-parse --is-inside-work-tree': 'true\n',
      'branch --show-current': 'feature/x\n',
      'diff --numstat base-sha':
        '26\t1\tsrc/app/api-explorer.component.html\n54\t0\tsrc/app/api-explorer.component.spec.ts\n',
      'diff --name-status base-sha':
        'M\tsrc/app/api-explorer.component.html\nA\tsrc/app/api-explorer.component.spec.ts\n',
      'ls-files --others --exclude-standard': '',
    });

    const res = await worktreeChanges({ worktreePath: '/wt', baseBranch: 'base-sha' });

    expect(res.isRepo).toBe(true);
    expect(res.changes).toEqual([
      {
        path: 'src/app/api-explorer.component.html',
        status: 'M',
        additions: 26,
        deletions: 1,
      },
      {
        path: 'src/app/api-explorer.component.spec.ts',
        status: 'A',
        additions: 54,
        deletions: 0,
      },
    ]);
    expect(res.insertions).toBe(80);
    expect(res.deletions).toBe(1);
  });

  it('returns an empty, non-repo result when the path is not a work tree', async () => {
    routeGit({ 'rev-parse --is-inside-work-tree': 'false\n' });
    const res = await worktreeChanges({ worktreePath: '/nope', baseBranch: 'base' });
    expect(res).toEqual({
      isRepo: false,
      currentBranch: '',
      changes: [],
      insertions: 0,
      deletions: 0,
    });
  });

  it('short-circuits without a base ref', async () => {
    const res = await worktreeChanges({ worktreePath: '/wt', baseBranch: '' });
    expect(res.isRepo).toBe(false);
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});
