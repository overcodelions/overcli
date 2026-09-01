import { describe, expect, it } from 'vitest';
import { classifyProject, groupProjects, GroupingContext } from './statsGrouping';
import type { ProjectStats } from '../shared/types';

const ctx: GroupingContext = {
  homeDir: '/Users/x',
  projects: [
    { name: 'overcli', path: '/Users/x/git-services/overcli' },
    { name: 'Unifyr Services', path: '/Users/x/Documents/Overcli Projects/Unifyr Services' },
  ],
  workspaces: [{ id: 'ws-1', name: 'Unifyr' }],
  coordinators: new Map([
    // Evicted from the runs store before ownerPath existed — flow name only.
    ['run-1', { flowName: 'Release Warden' }],
    // Knows the workspace it was launched from.
    ['run-2', { flowName: 'Daily Executive Brief', ownerPath: '/Users/x/Documents/Overcli Projects/Unifyr Services' }],
  ]),
};

describe('classifyProject', () => {
  it('groups an overcli worktree with its repo', () => {
    const c = classifyProject('/Users/x//overcli/worktrees/overcli/look/at/the/usage', ctx);
    expect(c.groupId).toBe('repo:-users-x-git-services-overcli');
    expect(c.groupName).toBe('overcli');
    expect(c.groupKind).toBe('repo');
    expect(c.leafName).toBe('look-at-the-usage');
  });

  it('groups the main checkout with the same groupId', () => {
    const c = classifyProject('/Users/x/git-services/overcli', ctx);
    expect(c.groupId).toBe('repo:-users-x-git-services-overcli');
    expect(c.leafName).toBe('main checkout');
  });

  it('groups an unknown worktree by its own project segment', () => {
    const c = classifyProject('/Users/x//overcli/worktrees/DormDraft/review', ctx);
    expect(c.groupKind).toBe('worktree');
    expect(c.groupName).toBe('DormDraft');
  });

  it('groups a worktree of a multi-word (space-bearing) project name', () => {
    const c = classifyProject('/Users/x//overcli/worktrees/Unifyr/Services/read/these', ctx);
    expect(c.groupKind).toBe('repo');
    expect(c.groupName).toBe('Unifyr Services');
    expect(c.leafName).toBe('read-these');
  });

  it('groups a coordinator root by flow name when the owner is unknown', () => {
    const c = classifyProject('/Users/x/Library/Application Support/Overcli/coordinators/run/1', ctx);
    expect(c.groupId).toBe('flow:release warden');
    expect(c.groupKind).toBe('flow');
    expect(c.leafName).toBe('run-1');
  });

  it('folds a coordinator root into the project that launched the run', () => {
    const c = classifyProject('/Users/x/Library/Application Support/Overcli/coordinators/run/2', ctx);
    expect(c.groupKind).toBe('repo');
    expect(c.groupName).toBe('Unifyr Services');
    expect(c.leafName).toBe('Daily Executive Brief · run-2');
  });

  it('does not recurse when a run\'s owner path is itself a coordinator root', () => {
    const selfRef: GroupingContext = {
      ...ctx,
      coordinators: new Map([
        ['run-3', {
          flowName: 'Loop',
          ownerPath: '/Users/x/Library/Application Support/Overcli/coordinators/run-3',
        }],
      ]),
    };
    const c = classifyProject('/Users/x/Library/Application Support/Overcli/coordinators/run/3', selfRef);
    expect(c.groupId).toBe('flow:loop');
    expect(c.groupKind).toBe('flow');
  });

  it('groups a workspace root by its workspace name', () => {
    const c = classifyProject('/Users/x/Library/Application Support/Overcli/workspaces/ws/1', ctx);
    expect(c.groupName).toBe('Unifyr');
    expect(c.groupKind).toBe('workspace');
  });

  it('groups the home dir as "other"', () => {
    const c = classifyProject('/Users/x', ctx);
    expect(c.groupId).toBe('other:home');
  });

  it('matches a real checkout whose folder name has a space in it', () => {
    const c = classifyProject('/Users/x/Documents/Overcli/Projects/Unifyr/Services', ctx);
    expect(c.groupKind).toBe('repo');
    expect(c.groupName).toBe('Unifyr Services');
    expect(c.leafName).toBe('main checkout');
  });
});

describe('groupProjects', () => {
  it('sums rows sharing a groupId into one group', () => {
    const rows: ProjectStats[] = [
      {
        id: 'a',
        name: 'a',
        sessions: 1,
        turns: 1,
        inputTokens: 10,
        outputTokens: 100,
        cacheRead: 0,
        cacheCreation: 0,
        linesAdded: 0,
        linesDeleted: 0,
        groupId: 'repo:x',
        groupName: 'x',
        groupKind: 'repo',
        leafName: 'main checkout',
      },
      {
        id: 'b',
        name: 'b',
        sessions: 2,
        turns: 3,
        inputTokens: 20,
        outputTokens: 200,
        cacheRead: 0,
        cacheCreation: 0,
        linesAdded: 0,
        linesDeleted: 0,
        groupId: 'repo:x',
        groupName: 'x',
        groupKind: 'repo',
        leafName: 'wt-1',
      },
    ];
    const groups = groupProjects(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].outputTokens).toBe(300);
    expect(groups[0].children).toHaveLength(2);
  });
});
