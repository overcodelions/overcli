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

import { workspaceCommitStatus, worktreeChanges } from './git';

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
      // base..HEAD: only the .html is committed on the branch.
      'diff --name-status base-sha HEAD': 'M\tsrc/app/api-explorer.component.html\n',
      // working tree vs HEAD: only the .spec.ts is still uncommitted.
      'status --porcelain=v1 --untracked-files=all': 'A  src/app/api-explorer.component.spec.ts\n',
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
        commitState: 'committed',
      },
      {
        path: 'src/app/api-explorer.component.spec.ts',
        status: 'A',
        additions: 54,
        deletions: 0,
        commitState: 'uncommitted',
      },
    ]);
    expect(res.insertions).toBe(80);
    expect(res.deletions).toBe(1);
  });

  it('flags a file that is committed and has further uncommitted edits as "both"', async () => {
    routeGit({
      'rev-parse --is-inside-work-tree': 'true\n',
      'branch --show-current': 'feature/x\n',
      'diff --numstat base-sha': '10\t2\tsrc/app/thing.ts\n',
      'diff --name-status base-sha': 'M\tsrc/app/thing.ts\n',
      'diff --name-status base-sha HEAD': 'M\tsrc/app/thing.ts\n',
      'status --porcelain=v1 --untracked-files=all': ' M src/app/thing.ts\n',
      'ls-files --others --exclude-standard': '',
    });

    const res = await worktreeChanges({ worktreePath: '/wt', baseBranch: 'base-sha' });

    expect(res.changes).toEqual([
      { path: 'src/app/thing.ts', status: 'M', additions: 10, deletions: 2, commitState: 'both' },
    ]);
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

describe('workspaceCommitStatus base-relative routing', () => {
  it('counts a member with a baseBranch against its fork point and prefixes the path', async () => {
    routeGit({
      'rev-parse --is-inside-work-tree': 'true\n',
      'branch --show-current': 'feature/x\n',
      'diff --numstat base-sha': '3\t0\tsrc/a.ts\n2\t1\tsrc/b.ts\n',
      'diff --name-status base-sha': 'A\tsrc/a.ts\nM\tsrc/b.ts\n',
      'ls-files --others --exclude-standard': '',
    });

    const res = await workspaceCommitStatus([
      { name: 'unifyr-r', path: '/wt/unifyr-r', baseBranch: 'base-sha' },
    ]);

    // A base-relative member routes through worktreeChanges (`diff --numstat
    // <base>`), so a committed file still shows — the whole point of the fix.
    const calls = mockExecFile.mock.calls.map((c) => (c[1] as string[]).join(' '));
    expect(calls).toContain('diff --numstat base-sha');
    expect(calls).not.toContain('diff HEAD --numstat');
    expect(res.changes.map((c) => c.path)).toEqual(['unifyr-r/src/a.ts', 'unifyr-r/src/b.ts']);
    expect(res.insertions).toBe(5);
    expect(res.deletions).toBe(1);
  });

  it('falls back to HEAD-relative for a member without a baseBranch', async () => {
    routeGit({
      'rev-parse --is-inside-work-tree': 'true\n',
      'branch --show-current': 'main\n',
      'status --porcelain=v1 --untracked-files=all': ' M src/c.ts\n',
      'diff HEAD --numstat': '4\t2\tsrc/c.ts\n',
    });

    const res = await workspaceCommitStatus([{ name: 'proj', path: '/main/proj' }]);

    const calls = mockExecFile.mock.calls.map((c) => (c[1] as string[]).join(' '));
    expect(calls).toContain('diff HEAD --numstat');
    expect(res.changes.map((c) => c.path)).toEqual(['proj/src/c.ts']);
  });
});
