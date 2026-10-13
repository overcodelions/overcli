// A flow that cuts its own branch moves a shared batch's worktree off the
// batch branch. Between items the batch takes it back, so later items keep
// committing where the batch will be reviewed.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('./orchestrationsStore', () => ({
  saveOrchestration: vi.fn(),
  loadAllOrchestrations: vi.fn(() => []),
  deleteOrchestration: vi.fn(),
}));

import { reclaimSharedBranch } from './orchestrator';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-shared-branch-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

function repo(name: string): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'base');
  git(dir, 'switch', '-q', '-c', 'agent/batch-1');
  return dir;
}

const shared = (dir: string) => ({
  branch: 'agent/batch-1',
  repos: [{ name: 'api', projectPath: dir, worktreePath: dir }],
});

describe('reclaimSharedBranch', () => {
  it('moves the batch branch up to a detour branch and switches back, keeping edits', async () => {
    const dir = repo('detour');
    git(dir, 'switch', '-q', '-c', 'bugfix/ABC-1');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'fix');
    fs.writeFileSync(path.join(dir, 'wip.txt'), 'uncommitted');

    await reclaimSharedBranch(shared(dir));

    expect(git(dir, 'branch', '--show-current')).toBe('agent/batch-1');
    expect(git(dir, 'log', '-1', '--format=%s', 'agent/batch-1')).toBe('fix');
    expect(fs.readFileSync(path.join(dir, 'wip.txt'), 'utf8')).toBe('uncommitted');
    // The detour branch is left where it is.
    expect(git(dir, 'rev-parse', 'bugfix/ABC-1')).toBe(git(dir, 'rev-parse', 'agent/batch-1'));
  });

  it('leaves a checkout that diverged from the batch branch alone', async () => {
    const dir = repo('diverged');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'batch work');
    git(dir, 'switch', '-q', '-c', 'other', 'main');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'elsewhere');

    await reclaimSharedBranch(shared(dir));

    expect(git(dir, 'branch', '--show-current')).toBe('other');
    expect(git(dir, 'log', '-1', '--format=%s', 'agent/batch-1')).toBe('batch work');
  });
});
