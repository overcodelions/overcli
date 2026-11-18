import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlowRun } from '../../shared/flows/schema';
import { BranchLander } from './landBranches';

// Real git into temp repos, which a slow CI runner can take past the 5s default.
vi.setConfig({ testTimeout: 20_000 });

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const BRANCH = 'overcli/first-change-111111';
const gitSync = (args: string[], cwd: string) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@acme.example', ...args], { cwd, stdio: 'pipe' }).toString();

/// An earlier run's branch on origin, and a follow-up's checkout started from
/// it with a change of its own. `test` sees the checkout as it is when the
/// tests run, so a case can say which tree was tested.
function setUp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-continue-'));
  dirs.push(root);
  gitSync(['init', '-q', '--bare', '-b', 'trunk', 'app.git'], root);
  gitSync(['clone', '-q', 'app.git', 'app'], root);
  const app = path.join(root, 'app');
  fs.writeFileSync(path.join(app, 'README.md'), '# app\n');
  gitSync(['checkout', '-q', '-b', 'trunk'], app);
  gitSync(['add', '-A'], app);
  gitSync(['commit', '-qm', 'init'], app);
  gitSync(['push', '-q', 'origin', 'trunk'], app);
  gitSync(['checkout', '-q', '-b', 'first'], app);
  fs.appendFileSync(path.join(app, 'README.md'), 'First.\n');
  gitSync(['commit', '-qam', 'First change'], app);
  gitSync(['push', '-q', 'origin', `HEAD:refs/heads/${BRANCH}`], app);
  gitSync(['checkout', '-q', 'trunk'], app);
  const wt = path.join(root, 'wt');
  gitSync(['worktree', 'add', '-q', '-b', 'agent/z', wt, `origin/${BRANCH}`], app);
  fs.appendFileSync(path.join(wt, 'README.md'), 'Softer.\n');

  /// Someone else adds to the branch on origin after the checkout was made.
  const moveOrigin = (file: string, text: string, message: string) => {
    const other = path.join(root, `other-${dirs.length}-${Date.now()}`);
    gitSync(['clone', '-q', '-b', BRANCH, 'app.git', other], root);
    fs.writeFileSync(path.join(other, file), text);
    gitSync(['add', '-A'], other);
    gitSync(['commit', '-qm', message], other);
    gitSync(['push', '-q', 'origin', `HEAD:refs/heads/${BRANCH}`], other);
  };

  const tested: Array<{ head: string; files: string[] }> = [];
  const lander = new BranchLander({
    git: async (args, cwd) => {
      try {
        return { ok: true, stdout: gitSync(args, cwd) };
      } catch (err) {
        const e = err as { stderr?: Buffer; stdout?: Buffer };
        return { ok: false, error: `${e.stderr ?? ''}${e.stdout ?? ''}` };
      }
    },
    repos: () => [{ name: 'app', url: 'git@bitbucket.org:acme/app.git', path: app, defaultBranch: 'trunk', testCommand: 'true', addedBy: 'Bo', at: 0 }],
    test: async (_command, cwd) => {
      tested.push({ head: gitSync(['rev-parse', 'HEAD'], cwd).trim(), files: fs.readdirSync(cwd).filter((f) => f !== '.git').sort() });
      return { ok: true };
    },
    attach: () => {},
    log: () => {},
  });
  const followUp = { id: '222333444', flowId: 'org-pr-app', projectPath: wt, sourceProjectPath: app, worktreePath: wt, userPrompt: 'Soften the wording', artifacts: {}, continues: BRANCH } as unknown as FlowRun;
  const remoteLog = () => gitSync(['log', '--format=%s', BRANCH], path.join(root, 'app.git')).trim().split('\n');
  const remoteHead = () => gitSync(['rev-parse', BRANCH], path.join(root, 'app.git')).trim();
  return { root, wt, lander, followUp, tested, moveOrigin, remoteLog, remoteHead };
}

describe('adding a follow-up to the branch it continues', () => {
  it('pushes straight on when the branch has not moved: no merge, and the pushed tree is the tested one', async () => {
    const { wt, lander, followUp, tested, remoteLog, remoteHead } = setUp();
    expect(await lander.land(followUp)).toEqual([{ repo: 'app', branch: BRANCH, updated: true }]);
    expect(remoteLog()).toEqual(['Soften the wording', 'First change', 'init']);
    expect(tested).toHaveLength(1);
    expect(tested[0].head).toBe(remoteHead());
    expect(remoteHead()).toBe(gitSync(['rev-parse', 'HEAD'], wt).trim());
  });

  it('merges the branch’s newer commits first, tests the merged tree, and pushes exactly that', async () => {
    const { wt, lander, followUp, tested, moveOrigin, remoteLog, remoteHead } = setUp();
    moveOrigin('NOTES.md', 'From a teammate.\n', 'Teammate note');
    expect(await lander.land(followUp)).toEqual([{ repo: 'app', branch: BRANCH, updated: true }]);
    expect(remoteLog()[0]).toBe(`Merge ${BRANCH} into Soften the wording`);
    expect(remoteLog()).toContain('Teammate note');
    expect(remoteLog()).toContain('Soften the wording');
    // The tests ran once, after the merge, on the commit that went out.
    expect(tested).toHaveLength(1);
    expect(tested[0].files).toContain('NOTES.md');
    expect(tested[0].head).toBe(remoteHead());
    expect(fs.existsSync(path.join(wt, '.git'))).toBe(true);
  });

  it('says which files conflict, aborts the merge cleanly, and pushes nothing', async () => {
    const { wt, lander, followUp, tested, moveOrigin, remoteLog } = setUp();
    moveOrigin('README.md', '# app\nFirst.\nHarder.\n', 'Teammate wording');
    const before = remoteLog();
    const [landed] = await lander.land(followUp);
    expect(landed.updated).toBeUndefined();
    expect(landed.branch).toBeUndefined();
    expect(landed.skipped).toContain('they conflict with its change in README.md');
    expect(landed.skipped).toContain('nothing was pushed (and no second pull request opened)');
    expect(tested).toEqual([]);
    expect(remoteLog()).toEqual(before);
    // No merge left half-done in the checkout, and its own commit still there.
    expect(gitSync(['status', '--porcelain'], wt).trim()).toBe('');
    expect(() => gitSync(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], wt)).toThrow();
    expect(gitSync(['log', '-1', '--format=%s'], wt).trim()).toBe('Soften the wording');
  });

  it('reports a merge that fails for another reason as that, not as a conflict', async () => {
    const { root, wt, lander, followUp, tested, remoteLog } = setUp();
    // The branch on origin replaced by one with no history in common.
    const other = path.join(root, 'unrelated');
    gitSync(['init', '-q', '-b', 'x', other], root);
    fs.writeFileSync(path.join(other, 'OTHER.md'), 'Elsewhere.\n');
    gitSync(['add', '-A'], other);
    gitSync(['commit', '-qm', 'Unrelated'], other);
    gitSync(['push', '-q', '-f', path.join(root, 'app.git'), `HEAD:refs/heads/${BRANCH}`], other);
    const [landed] = await lander.land(followUp);
    expect(landed.updated).toBeUndefined();
    expect(landed.skipped).toContain(`couldn't merge ${BRANCH}'s newer commits`);
    expect(landed.skipped).toContain('unrelated histories');
    expect(landed.skipped).not.toContain('conflict');
    expect(tested).toEqual([]);
    expect(remoteLog()).toEqual(['Unrelated']);
    expect(gitSync(['status', '--porcelain'], wt).trim()).toBe('');
    expect(gitSync(['log', '-1', '--format=%s'], wt).trim()).toBe('Soften the wording');
  });
});
