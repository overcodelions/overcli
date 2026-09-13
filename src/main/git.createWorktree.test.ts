import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorktree, createWorktreeAsync } from './git';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('createWorktree collision handling', () => {
  let sandbox: string;
  let projectPath: string;
  let homeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-create-worktree-'));
    projectPath = path.join(sandbox, 'repo');
    fs.mkdirSync(projectPath);
    git(projectPath, ['init', '-b', 'main']);
    git(projectPath, ['-c', 'user.name=Overcli Test', '-c', 'user.email=test@overcli.local', 'commit', '--allow-empty', '-m', 'initial']);
    homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(sandbox);
  });

  afterEach(() => {
    homeSpy.mockRestore();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('suffixes the name when the requested managed directory already exists', () => {
    const root = path.join(sandbox, '.overcli', 'worktrees', 'repo');
    fs.mkdirSync(path.join(root, 'repeat-this-prompt'), { recursive: true });

    const result = createWorktree({
      projectPath,
      agentName: 'repeat-this-prompt',
      baseBranch: 'main',
      branchPrefix: 'agent/',
    });

    expect(result).toEqual({
      ok: true,
      worktreePath: path.join(root, 'repeat-this-prompt-2'),
      branchName: 'agent/repeat-this-prompt-2',
    });
  });

  it('suffixes past both existing branches and directories in the async creator', async () => {
    const root = path.join(sandbox, '.overcli', 'worktrees', 'repo');
    fs.mkdirSync(path.join(root, 'repeat-this-prompt'), { recursive: true });
    git(projectPath, ['branch', 'agent/repeat-this-prompt-2']);

    const result = await createWorktreeAsync({
      projectPath,
      agentName: 'repeat-this-prompt',
      baseBranch: 'main',
      branchPrefix: 'agent/',
    });

    expect(result).toEqual({
      ok: true,
      worktreePath: path.join(root, 'repeat-this-prompt-3'),
      branchName: 'agent/repeat-this-prompt-3',
    });
  });
});
