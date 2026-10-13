import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  absorbPiece,
  closeTaskBranch,
  landTaskBranch,
  openTaskBranch,
  pushTaskBranch,
  taskBranchAhead,
  taskRepos,
  type TaskCode,
} from './teamBranch';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Overcli Test',
  GIT_AUTHOR_EMAIL: 'test@overcli.local',
  GIT_COMMITTER_NAME: 'Overcli Test',
  GIT_COMMITTER_EMAIL: 'test@overcli.local',
};

describe('a team task branch across a workspace', () => {
  let sandbox: string;
  let overcli: string;
  let overgit: string;
  let homeSpy: ReturnType<typeof vi.spyOn>;
  const saved: Record<string, string | undefined> = {};

  const repo = (name: string, base: string) => {
    const dir = path.join(sandbox, name);
    fs.mkdirSync(dir);
    git(dir, ['init', '-b', base]);
    fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'initial']);
    return dir;
  };

  /// A piece's run: its own worktree, forked off the task branch.
  const piece = (repoPath: string, code: TaskCode, name: string, file: string, body: string) => {
    const worktreePath = path.join(sandbox, 'runs', `${path.basename(repoPath)}-${name}`);
    git(repoPath, ['worktree', 'add', '-b', `agent/${name}`, worktreePath, code.branch]);
    fs.writeFileSync(path.join(worktreePath, file), body);
    return { projectPath: repoPath, worktreePath, branchName: `agent/${name}` };
  };

  beforeEach(() => {
    sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-team-branch-')));
    for (const [k, v] of Object.entries(IDENTITY)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    overcli = repo('overcli', 'main');
    // Members that disagree about their base still share one task branch.
    overgit = repo('overgit', 'master');
    fs.mkdirSync(path.join(sandbox, 'notes'));
    homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(sandbox);
  });

  afterEach(() => {
    homeSpy.mockRestore();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('finds the repos of a workspace, leaving out plain folders', () => {
    const repos = taskRepos(path.join(sandbox, 'ws'), [
      { rootPath: path.join(sandbox, 'ws'), memberPaths: [overcli, overgit, path.join(sandbox, 'notes')] },
    ]);
    expect(repos.map((r) => r.name)).toEqual(['overcli', 'overgit']);
    expect(taskRepos(path.join(sandbox, 'notes'), [])).toEqual([]);
  });

  it('cuts one branch name in every repo, each from its own base', () => {
    const res = openTaskBranch({
      taskId: 't1',
      title: 'Auto-translation of supplier assets',
      repos: [
        { name: 'overcli', projectPath: overcli },
        { name: 'overgit', projectPath: overgit },
      ],
    });
    if (!res.ok || !res.code) throw new Error('no code');
    expect(res.code.branch).toBe('team/auto-translation-of-supplier-assets');
    expect(res.code.repos.map((r) => r.base)).toEqual(['main', 'master']);
    // Your checkouts are untouched.
    expect(git(overcli, ['branch', '--show-current'])).toBe('main');
    expect(git(res.code.repos[0].worktreePath, ['branch', '--show-current'])).toBe(res.code.branch);
  });

  it('gives repos whose names slug alike a checkout each', () => {
    fs.mkdirSync(path.join(sandbox, 'acme'));
    const api = repo(path.join('acme', 'Api'), 'main');
    const res = openTaskBranch({
      taskId: 't-slug',
      title: 'Rename the client',
      repos: [
        { name: 'api', projectPath: overcli },
        { name: 'Api', projectPath: api },
      ],
    });
    if (!res.ok || !res.code) throw new Error('no code');
    const [a, b] = res.code.repos.map((r) => r.worktreePath);
    expect(a).not.toBe(b);
    expect(git(a, ['branch', '--show-current'])).toBe(res.code.branch);
    expect(git(b, ['branch', '--show-current'])).toBe(res.code.branch);
  });

  it('merges finished pieces in, so the next piece starts from them, and lands the result', () => {
    const res = openTaskBranch({ taskId: 't2', title: 'Release', repos: [{ name: 'overcli', projectPath: overcli }] });
    if (!res.ok || !res.code) throw new Error('no code');
    const code = res.code;

    // Stage 1: uncommitted work is committed and merged.
    const first = piece(overcli, code, 'theo', 'fix.txt', 'stability fix\n');
    expect(absorbPiece({ code, piece: [first], message: 'Theo: fixes' })).toEqual({ ok: true, merged: ['overcli'] });

    // Stage 2 forks off the task branch, so it sees stage 1's work.
    const second = piece(overcli, code, 'bram', 'notes.txt', 'release notes\n');
    expect(fs.existsSync(path.join(second.worktreePath, 'fix.txt'))).toBe(true);
    expect(absorbPiece({ code, piece: [second], message: 'Bram: notes' }).ok).toBe(true);

    // A piece that changed nothing merges nothing.
    const idle = piece(overcli, code, 'idle', 'fix.txt', 'stability fix\n');
    expect(absorbPiece({ code, piece: [idle], message: 'nothing' })).toEqual({ ok: true, merged: [] });

    expect(landTaskBranch(code, code.repos[0], 'Release').ok).toBe(true);
    expect(fs.readFileSync(path.join(overcli, 'notes.txt'), 'utf8')).toBe('release notes\n');
    closeTaskBranch({ ...code, repos: code.repos.map((r) => ({ ...r, landed: true })) });
    expect(fs.existsSync(code.repos[0].worktreePath)).toBe(false);
  });

  it('commits the work of a piece that ran in the task branch checkout itself, with no merge', () => {
    const res = openTaskBranch({ taskId: 't-solo', title: 'Solo', repos: [{ name: 'overcli', projectPath: overcli }] });
    if (!res.ok || !res.code) throw new Error('no code');
    const code = res.code;
    const tree = code.repos[0].worktreePath;
    fs.writeFileSync(path.join(tree, 'tests.txt'), 'new tests\n');
    // An adopted run reports the task's own checkout and branch as its piece.
    const adopted = { projectPath: overcli, worktreePath: tree, branchName: code.branch };
    expect(absorbPiece({ code, piece: [adopted], message: 'Triage: tests' })).toEqual({ ok: true, merged: [] });
    expect(git(tree, ['status', '--porcelain'])).toBe('');
    expect(git(tree, ['log', '-1', '--format=%s'])).toBe('Triage: tests');
    expect(git(tree, ['rev-list', '--merges', '--count', 'HEAD'])).toBe('0');
  });

  it('stops when a piece committed its work on a branch of its own, instead of dropping it', () => {
    const res = openTaskBranch({ taskId: 't-side', title: 'Side', repos: [{ name: 'overcli', projectPath: overcli }] });
    if (!res.ok || !res.code) throw new Error('no code');
    const code = res.code;
    const startedAt = Date.now() - 1000;
    const own = piece(overcli, code, 'greta', 'unused.txt', '');
    fs.rmSync(path.join(own.worktreePath, 'unused.txt'));
    // What the reviewer did: cut a branch off the base, commit there, and come back.
    git(own.worktreePath, ['checkout', '-b', 'review/ABC-1', 'main']);
    fs.writeFileSync(path.join(own.worktreePath, 'tests.txt'), 'tests\n');
    git(own.worktreePath, ['add', '.']);
    git(own.worktreePath, ['commit', '-m', 'ABC-1: tests']);
    git(own.worktreePath, ['checkout', own.branchName]);

    const out = absorbPiece({ code, piece: [{ ...own, startedAt }], message: 'Greta: review' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain('`review/ABC-1` took commits that are not on the task branch');

    // Merged by hand, it no longer counts, and Retry goes through.
    git(code.repos[0].worktreePath, ['merge', '--no-ff', '-m', 'take review', 'review/ABC-1']);
    expect(absorbPiece({ code, piece: [{ ...own, startedAt }], message: 'Greta: review' })).toEqual({ ok: true, merged: [] });
  });

  it('stops when a piece left its checkout on another branch', () => {
    const res = openTaskBranch({ taskId: 't-moved', title: 'Moved', repos: [{ name: 'overcli', projectPath: overcli }] });
    if (!res.ok || !res.code) throw new Error('no code');
    const own = piece(overcli, res.code, 'drift', 'x.txt', 'x\n');
    git(own.worktreePath, ['checkout', '-b', 'elsewhere']);
    const out = absorbPiece({ code: res.code, piece: [own], message: 'Drift' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain('left its branch `agent/drift` for `elsewhere`');
  });

  it('does not take a sibling piece still checked out for work on the side', () => {
    const res = openTaskBranch({ taskId: 't-sib', title: 'Sib', repos: [{ name: 'overcli', projectPath: overcli }] });
    if (!res.ok || !res.code) throw new Error('no code');
    const startedAt = Date.now() - 1000;
    const sibling = piece(overcli, res.code, 'ade', 'a.txt', 'a\n');
    git(sibling.worktreePath, ['add', '.']);
    git(sibling.worktreePath, ['commit', '-m', 'ade work']);
    const mine = piece(overcli, res.code, 'maya', 'm.txt', 'm\n');
    expect(absorbPiece({ code: res.code, piece: [{ ...mine, startedAt }], message: 'Maya' })).toEqual({
      ok: true,
      merged: ['overcli'],
    });
  });

  it('counts only the repos the task changed, and pushes the branch to the remote', () => {
    const remote = path.join(sandbox, 'remote.git');
    git(sandbox, ['init', '--bare', remote]);
    git(overcli, ['remote', 'add', 'origin', remote]);
    const res = openTaskBranch({
      taskId: 't-push',
      title: 'Push',
      repos: [
        { name: 'overcli', projectPath: overcli },
        { name: 'overgit', projectPath: overgit },
      ],
    });
    if (!res.ok || !res.code) throw new Error('no code');
    const code = res.code;
    absorbPiece({ code, piece: [piece(overcli, code, 'one', 'a.txt', 'a\n')], message: 'One' });
    expect(taskBranchAhead(code)).toEqual([2, 0]);

    expect(pushTaskBranch(code, code.repos[0], 'Push').ok).toBe(true);
    expect(git(remote, ['rev-parse', code.branch])).toBe(git(overcli, ['rev-parse', code.branch]));
  });

  it('stops on a conflict without leaving the task branch half-merged', () => {
    const res = openTaskBranch({ taskId: 't3', title: 'Clash', repos: [{ name: 'overcli', projectPath: overcli }] });
    if (!res.ok || !res.code) throw new Error('no code');
    const code = res.code;
    // Two members of one stage, both editing the same line from the same start.
    const a = piece(overcli, code, 'a', 'README.md', '# overcli — a\n');
    const b = piece(overcli, code, 'b', 'README.md', '# overcli — b\n');
    expect(absorbPiece({ code, piece: [a], message: 'a' }).ok).toBe(true);
    const clash = absorbPiece({ code, piece: [b], message: 'b' });
    expect(clash).toMatchObject({ ok: false, conflict: true });
    expect(git(code.repos[0].worktreePath, ['status', '--porcelain'])).toBe('');
    expect(fs.readFileSync(path.join(code.repos[0].worktreePath, 'README.md'), 'utf8')).toBe('# overcli — a\n');
  });
});
