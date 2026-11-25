import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listLinkedWorktrees } from './git';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });

describe('listLinkedWorktrees', () => {
  it('lists linked worktrees with a branch, skipping the main checkout, detached heads and deleted folders', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'llw-')));
    try {
      const repo = join(root, 'repo');
      execFileSync('git', ['init', '-q', '-b', 'main', repo]);
      git(repo, '-c', 'user.email=a@example.com', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'init');
      git(repo, 'worktree', 'add', '-q', '-b', 'feature/one', join(root, 'one'));
      git(repo, 'worktree', 'add', '-q', '--detach', join(root, 'detached'));
      git(repo, 'worktree', 'add', '-q', '-b', 'feature/gone', join(root, 'gone'));
      rmSync(join(root, 'gone'), { recursive: true, force: true });

      expect(listLinkedWorktrees(repo)).toEqual([{ branch: 'feature/one', worktreePath: join(root, 'one') }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns nothing outside a repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llw-none-'));
    try {
      expect(listLinkedWorktrees(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
