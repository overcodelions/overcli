import { describe, expect, it } from 'vitest';

import { pendingWorkspaceMembers, undismissedWorkspaceMembers } from './workspaceMembers';

// Structural params mean these fixtures are exactly the fields the function
// reads — no need to fabricate a whole FlowRun/Workspace/Project.
const projects = [
  { id: 'p-a' as never, name: 'alpha', path: '/repo/alpha' },
  { id: 'p-b' as never, name: 'bravo', path: '/repo/bravo' },
  { id: 'p-c' as never, name: 'charlie', path: '/repo/charlie' },
];

const workspaces = [
  { rootPath: '/ws/unifyr', projectIds: ['p-a', 'p-b', 'p-c'] as never[] },
  { rootPath: '/ws/other', projectIds: ['p-a'] as never[] },
];

function runWith(memberPaths: string[], sourceProjectPath = '/ws/unifyr') {
  return {
    sourceProjectPath,
    workspaceWorktrees: memberPaths.map((p, i) => ({
      name: `m${i}`,
      projectPath: p,
      worktreePath: `/wt/${i}`,
      branchName: 'agent/x',
    })),
  };
}

describe('pendingWorkspaceMembers', () => {
  it('reports projects added to the workspace after launch', () => {
    const run = runWith(['/repo/alpha', '/repo/bravo']);
    expect(pendingWorkspaceMembers(run, workspaces, projects)).toEqual([
      { name: 'charlie', path: '/repo/charlie' },
    ]);
  });

  it('is empty when the run already covers every member', () => {
    const run = runWith(['/repo/alpha', '/repo/bravo', '/repo/charlie']);
    expect(pendingWorkspaceMembers(run, workspaces, projects)).toEqual([]);
  });

  it('ignores a run with no minted worktrees (single-project or runIn cwd)', () => {
    expect(
      pendingWorkspaceMembers({ sourceProjectPath: '/ws/unifyr', workspaceWorktrees: [] }, workspaces, projects),
    ).toEqual([]);
    expect(
      pendingWorkspaceMembers({ sourceProjectPath: '/ws/unifyr' }, workspaces, projects),
    ).toEqual([]);
  });

  it('ignores a run that is not rooted in a workspace', () => {
    const run = { workspaceWorktrees: runWith(['/repo/alpha']).workspaceWorktrees };
    expect(pendingWorkspaceMembers(run, workspaces, projects)).toEqual([]);
  });

  it('is empty when the workspace no longer exists', () => {
    const run = runWith(['/repo/alpha'], '/ws/deleted');
    expect(pendingWorkspaceMembers(run, workspaces, projects)).toEqual([]);
  });

  it('matches by path, so a project re-added under a new id is not pending twice', () => {
    // charlie re-added: same path, fresh id, and the run already has it.
    const reAdded = [...projects, { id: 'p-c2' as never, name: 'charlie', path: '/repo/charlie' }];
    const ws = [{ rootPath: '/ws/unifyr', projectIds: ['p-a', 'p-b', 'p-c2'] as never[] }];
    const run = runWith(['/repo/alpha', '/repo/bravo', '/repo/charlie']);
    expect(pendingWorkspaceMembers(run, ws, reAdded)).toEqual([]);
  });

  it('does not report a member REMOVED from the workspace (adoption is additive)', () => {
    const ws = [{ rootPath: '/ws/unifyr', projectIds: ['p-a'] as never[] }];
    const run = runWith(['/repo/alpha', '/repo/bravo']);
    expect(pendingWorkspaceMembers(run, ws, projects)).toEqual([]);
  });

  it('skips workspace ids with no matching project record', () => {
    const ws = [{ rootPath: '/ws/unifyr', projectIds: ['p-a', 'p-gone'] as never[] }];
    const run = runWith(['/repo/alpha']);
    expect(pendingWorkspaceMembers(run, ws, projects)).toEqual([]);
  });
});

describe('undismissedWorkspaceMembers', () => {
  const pending = [
    { name: 'bravo', path: '/repo/bravo' },
    { name: 'charlie', path: '/repo/charlie' },
  ];

  it('passes everything through when nothing is dismissed', () => {
    expect(undismissedWorkspaceMembers(pending, undefined)).toEqual(pending);
    expect(undismissedWorkspaceMembers(pending, [])).toEqual(pending);
  });

  it('drops the dismissed paths', () => {
    expect(undismissedWorkspaceMembers(pending, ['/repo/bravo'])).toEqual([
      { name: 'charlie', path: '/repo/charlie' },
    ]);
  });

  it('hides the banner once every pending member is dismissed', () => {
    expect(undismissedWorkspaceMembers(pending, ['/repo/bravo', '/repo/charlie'])).toEqual([]);
  });

  it('still surfaces a project added AFTER the dismissal', () => {
    // The whole point of recording paths rather than a hide flag: yesterday's
    // dismissal must not blind the run to today's addition.
    const later = [...pending, { name: 'delta', path: '/repo/delta' }];
    expect(undismissedWorkspaceMembers(later, ['/repo/bravo', '/repo/charlie'])).toEqual([
      { name: 'delta', path: '/repo/delta' },
    ]);
  });

  it('ignores dismissed paths that are no longer pending', () => {
    expect(undismissedWorkspaceMembers(pending, ['/repo/gone'])).toEqual(pending);
  });
});
