import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { landedOnBase } from './squashMerged';
import { worktreeStatus } from './git';
import { scanWorktrees } from './worktreeSweep';

let root: string;
let repo: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const commit = (cwd: string, file: string, text: string) => {
  writeFileSync(join(cwd, file), text);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', `change ${file}`);
};

/// A branch of two commits, the second touching the first's file again: only a
/// combined patch can match its squash.
function feature(branch = 'agent/x') {
  git(repo, 'checkout', '-q', '-b', branch);
  commit(repo, 'feature.txt', 'one\n');
  commit(repo, 'feature.txt', 'one\ntwo\n');
  git(repo, 'checkout', '-q', 'master');
}
const squash = (branch = 'agent/x') => {
  git(repo, 'merge', '-q', '--squash', branch);
  git(repo, 'commit', '-qm', 'Merged in x (pull request #1)');
};

beforeEach(() => {
  // Real path: git reports them resolved, and the scan compares against git.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'overcli-squash-')));
  repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'master', repo], { stdio: 'ignore' });
  git(repo, 'config', 'user.email', 'flows@overcli.test');
  git(repo, 'config', 'user.name', 'Overcli Test');
  commit(repo, 'README.md', 'base\n');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('landedOnBase', () => {
  it('sees a multi-commit branch squashed into the base', async () => {
    feature();
    squash();
    expect(await landedOnBase(repo, 'refs/heads/agent/x', 'master')).toBe('squash');
  });

  it('still sees it once the base has moved on and touched other files', async () => {
    feature();
    squash();
    commit(repo, 'later.txt', 'later\n');
    expect(await landedOnBase(repo, 'refs/heads/agent/x', 'master')).toBe('squash');
  });

  it('does not call unmerged work landed', async () => {
    feature();
    commit(repo, 'other.txt', 'unrelated\n');
    expect(await landedOnBase(repo, 'refs/heads/agent/x', 'master')).toBeNull();
  });

  it('does not call a branch landed when it gained commits after the squash', async () => {
    feature();
    squash();
    git(repo, 'checkout', '-q', 'agent/x');
    commit(repo, 'after.txt', 'more work\n');
    git(repo, 'checkout', '-q', 'master');
    expect(await landedOnBase(repo, 'refs/heads/agent/x', 'master')).toBeNull();
  });

  it('finds a squash on origin when the local base is behind', async () => {
    const before = git(repo, 'rev-parse', 'HEAD');
    feature();
    squash();
    git(repo, 'update-ref', 'refs/remotes/origin/master', 'HEAD');
    git(repo, 'reset', '-q', '--hard', before);
    expect(await landedOnBase(repo, 'refs/heads/agent/x', 'master')).toBe('squash');
  });

  it('finds an ordinary merge on origin when the local base is behind', async () => {
    const before = git(repo, 'rev-parse', 'HEAD');
    feature();
    git(repo, 'merge', '-q', '--no-ff', '-m', 'merge', 'agent/x');
    git(repo, 'update-ref', 'refs/remotes/origin/master', 'HEAD');
    git(repo, 'reset', '-q', '--hard', before);
    expect(await landedOnBase(repo, 'refs/heads/agent/x', 'master')).toBe('ancestor');
  });
});

describe('the checks that use it', () => {
  const tree = () => {
    const worktreePath = join(root, 'wt');
    git(repo, 'worktree', 'add', '-q', worktreePath, 'agent/x');
    return worktreePath;
  };
  const status = (worktreePath: string) =>
    worktreeStatus({ projectPath: repo, worktreePath, branchName: 'agent/x', baseBranch: 'master' });

  it('worktreeStatus reads a squashed branch as merged', async () => {
    feature();
    squash();
    expect(await status(tree())).toMatchObject({ isMergedIntoBase: true, squashMerged: true });
  });

  it('worktreeStatus keeps uncommitted work and unmerged branches unmerged', async () => {
    feature();
    const unmerged = tree();
    expect((await status(unmerged)).isMergedIntoBase).toBe(false);
    squash();
    writeFileSync(join(unmerged, 'scratch.txt'), 'half done\n');
    expect((await status(unmerged)).isMergedIntoBase).toBe(false);
  });

  it('the Clean up scan offers a squashed tree', async () => {
    feature();
    squash();
    // Only trees under the managed root are ours to classify.
    const home = process.env.HOME;
    process.env.HOME = root;
    try {
      git(repo, 'worktree', 'add', '-q', join(root, '.overcli/worktrees/acme/x'), 'agent/x');
      const res = await scanWorktrees({ projects: [{ path: repo, name: 'acme' }], claims: [], measureSizes: false });
      expect(res.entries.map((e) => [e.branchName, e.bucket, e.isMergedIntoBase])).toEqual([['agent/x', 'reclaimable', true]]);
    } finally {
      process.env.HOME = home;
    }
  });

  it('the Clean up scan holds a tree whose work never landed', async () => {
    feature();
    const home = process.env.HOME;
    process.env.HOME = root;
    try {
      git(repo, 'worktree', 'add', '-q', join(root, '.overcli/worktrees/acme/x'), 'agent/x');
      const res = await scanWorktrees({ projects: [{ path: repo, name: 'acme' }], claims: [], measureSizes: false });
      expect(res.entries.map((e) => e.bucket)).toEqual(['has-work']);
    } finally {
      process.env.HOME = home;
    }
  });
});
