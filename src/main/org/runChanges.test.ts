import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { changesAsDiff, changesOfRun, changesSummary } from './runChanges';
import type { FlowRun } from '../../shared/flows/schema';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-changes-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd }).toString().trim();

function repo(name: string): { path: string; base: string } {
  const p = path.join(root, name);
  fs.mkdirSync(p);
  git(p, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(p, 'app.ts'), 'one\ntwo\n');
  git(p, 'add', '.');
  git(p, 'commit', '-qm', 'first');
  return { path: p, base: git(p, 'rev-parse', 'HEAD') };
}

describe('changesOfRun', () => {
  it('reads what a run changed in each worktree against where it started, new files too', async () => {
    const api = repo('api');
    const web = repo('web');
    fs.writeFileSync(path.join(api.path, 'app.ts'), 'one\n2\nthree\n');
    fs.writeFileSync(path.join(api.path, 'new.ts'), 'hello\n');
    const run = {
      projectPath: root,
      workspaceWorktrees: [
        { name: 'api', projectPath: api.path, worktreePath: api.path, branchName: 'agent/acme-1' },
        { name: 'web', projectPath: web.path, worktreePath: web.path, branchName: 'agent/acme-1' },
      ],
      baselineCommitsByMember: { api: { path: api.path, commit: api.base }, web: { path: web.path, commit: web.base } },
    } as unknown as FlowRun;
    const c = await changesOfRun(run, { diff: true });
    expect(c.repos.map((r) => r.name)).toEqual(['api']);
    expect(c.repos[0]).toMatchObject({ branch: 'agent/acme-1', insertions: 3, deletions: 1 });
    expect(c.repos[0].files.map((f) => f.path).sort()).toEqual(['app.ts', 'new.ts']);
    expect(changesSummary(c)).toBe('2 files, +3 −1 in api');
    expect(changesAsDiff(c)).toContain('+hello');
  });

  it('says so when the checkout is gone', async () => {
    const run = { projectPath: root, worktreePath: path.join(root, 'gone'), baselineCommit: 'abc' } as unknown as FlowRun;
    expect(await changesOfRun(run)).toEqual({ repos: [], gone: true });
  });
});
