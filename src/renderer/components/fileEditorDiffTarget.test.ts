import { describe, expect, it } from 'vitest';
import { resolveDiffTarget } from './FileEditorPane';

// A workspace-worktree flow run: the run's cwd is a coordinator symlink
// farm that is NOT itself a git repo, and each member symlink points at a
// minted worktree.
const ROOT = '/Users/x/Library/Application Support/overcli/coordinators/run-1';
const MEMBERS = [
  {
    name: 'zift-ecm-admin',
    path: '/Users/x/.overcli/worktrees/zift-ecm-admin/RED-6644',
    projectPath: '/Users/x/git-services/zift-ecm-admin',
    baseBranch: 'master',
    baselineCommit: 'abc123',
  },
  {
    name: 'gitrepo',
    path: '/Users/x/.overcli/worktrees/gitrepo/RED-6644',
    projectPath: '/Users/x/gitrepo',
    baseBranch: 'master',
    baselineCommit: 'def456',
  },
];

describe('resolveDiffTarget', () => {
  it('peels the bare `<member>/…` prefix onto the member worktree', () => {
    expect(resolveDiffTarget('gitrepo/src/Main.java', ROOT, MEMBERS, null)).toEqual({
      cwd: '/Users/x/.overcli/worktrees/gitrepo/RED-6644',
      path: 'src/Main.java',
      baseBranch: 'master',
      baselineCommit: 'def456',
    });
  });

  it('maps an absolute path threaded through the coordinator symlink', () => {
    // The regression: the ChangesBar opens files by their symlinked
    // absolute path, which matched neither the worktree nor the project
    // root, so git ran in the coordinator dir and failed on HEAD.
    expect(
      resolveDiffTarget(`${ROOT}/zift-ecm-admin/ecm-adminui/src/app/a.service.ts`, ROOT, MEMBERS, null),
    ).toEqual({
      cwd: '/Users/x/.overcli/worktrees/zift-ecm-admin/RED-6644',
      path: 'ecm-adminui/src/app/a.service.ts',
      baseBranch: 'master',
      baselineCommit: 'abc123',
    });
  });

  it('treats the member symlink root itself as the repo root', () => {
    expect(resolveDiffTarget(`${ROOT}/gitrepo`, ROOT, MEMBERS, null)).toEqual({
      cwd: '/Users/x/.overcli/worktrees/gitrepo/RED-6644',
      path: '.',
      baseBranch: 'master',
      baselineCommit: 'def456',
    });
  });

  it('still maps the worktree and upstream-project absolute forms', () => {
    expect(
      resolveDiffTarget('/Users/x/.overcli/worktrees/gitrepo/RED-6644/src/Main.java', ROOT, MEMBERS, null),
    ).toMatchObject({ cwd: '/Users/x/.overcli/worktrees/gitrepo/RED-6644', path: 'src/Main.java' });
    expect(
      resolveDiffTarget('/Users/x/git-services/zift-ecm-admin/ecm-adminui/a.ts', ROOT, MEMBERS, null),
    ).toMatchObject({
      cwd: '/Users/x/.overcli/worktrees/zift-ecm-admin/RED-6644',
      path: 'ecm-adminui/a.ts',
    });
  });

  it('falls back to the root for non-workspace conversations', () => {
    expect(resolveDiffTarget('/repo/src/a.ts', '/repo', null, 'main')).toEqual({
      cwd: '/repo',
      path: 'src/a.ts',
      baseBranch: 'main',
      baselineCommit: null,
    });
  });

  it('has no target for an absolute path outside the repo', () => {
    // The scratchpad artifact case: git would run in /repo against a file
    // outside it and answer `fatal: … is outside repository`, which the pane
    // then rendered as the diff. Null is what hides the Diff tab.
    expect(resolveDiffTarget('/private/tmp/scratch/page.html', '/repo', null, null)).toBeNull();
    expect(resolveDiffTarget('/other/project/src/a.ts', '/repo', MEMBERS, null)).toBeNull();
  });

  it('keeps a repo-relative path even though it is not under the root', () => {
    // Only ABSOLUTE paths can be judged by prefix. A relative one is already
    // in the form git wants and must survive the check above.
    expect(resolveDiffTarget('src/a.ts', '/repo', null, null)).toMatchObject({
      cwd: '/repo',
      path: 'src/a.ts',
    });
  });

  it('does not partial-match a member name that is a prefix of another', () => {
    const members = [
      { name: 'app', path: '/wt/app', projectPath: '/p/app', baseBranch: null },
      { name: 'app-api', path: '/wt/app-api', projectPath: '/p/app-api', baseBranch: null },
    ];
    expect(resolveDiffTarget(`${ROOT}/app-api/src/a.ts`, ROOT, members, null)).toMatchObject({
      cwd: '/wt/app-api',
      path: 'src/a.ts',
    });
  });
});
