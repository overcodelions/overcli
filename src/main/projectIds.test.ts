import { describe, expect, it } from 'vitest';
import type { Project, Workspace } from '../shared/types';
import { projectIdFor, repairProjectIds } from './projectIds';

const project = (id: string, path: string): Project => ({ id, name: path.split('/').pop()!, path, conversations: [] });

describe('project ids', () => {
  it('differ for repos that share a long path prefix', () => {
    expect(projectIdFor('repo', '/data/repos/app')).not.toBe(projectIdFor('repo', '/data/repos/api'));
    expect(projectIdFor('repo', '/data/repos/app')).toBe(projectIdFor('repo', '/data/repos/app'));
  });

  it('repairs a store where repos share an id, and points workspaces at the right ones', () => {
    const shared = 'repo-2f646174612f7265706f732f';
    const store = {
      projects: [project(shared, '/data/repos/app'), project(shared, '/data/repos/api'), project('u-1', '/Users/pat/notes')],
      workspaces: [{ id: 'ws-shop', name: 'Shop', projectIds: [shared, shared], rootPath: '/data/workspaces/ws-shop', conversations: [], createdAt: 0 } as Workspace],
    };
    const fixed = repairProjectIds(store)!;
    const ids = fixed.projects.map((p) => p.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toBe(shared);
    expect(fixed.workspaces[0].projectIds).toEqual([shared, ids[1]]);
    expect(repairProjectIds(fixed)).toBeNull();
  });
});
