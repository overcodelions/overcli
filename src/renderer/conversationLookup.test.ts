import { describe, expect, it } from 'vitest';
import {
  findContainerPath,
  findConvLocation,
  findConvWithProjectPath,
  findConversation,
  findOwnerProject,
} from './conversationLookup';
import type { Conversation, Project, Workspace } from '../shared/types';

function conv(id: string, overrides: Partial<Conversation> = {}): Conversation {
  return {
    id,
    name: id,
    backend: 'claude',
    permissionMode: 'default',
    model: 'sonnet',
    createdAt: 0,
    ...overrides,
  } as Conversation;
}

function project(id: string, path: string, conversations: Conversation[]): Project {
  return { id, name: id, path, conversations };
}

function workspace(id: string, rootPath: string, conversations: Conversation[]): Workspace {
  return { id, name: id, rootPath, conversations, projectIds: [], createdAt: 0 };
}

describe('conversationLookup', () => {
  it('returns null when id missing', () => {
    expect(findConversation({ projects: [], workspaces: [] }, 'x')).toBeNull();
  });

  it('finds a project-hosted conversation', () => {
    const c = conv('c1');
    const p = project('p1', '/repo', [c]);
    const src = { projects: [p], workspaces: [] };
    expect(findConversation(src, 'c1')).toBe(c);
    expect(findOwnerProject(src, 'c1')).toBe(p);
    expect(findConvLocation(src, 'c1')).toEqual({ kind: 'project', project: p, conversation: c });
  });

  it('finds a workspace-hosted conversation and reports no owner project', () => {
    const c = conv('coord');
    const ws = workspace('ws1', '/wsroot', [c]);
    const src = { projects: [], workspaces: [ws] };
    expect(findConversation(src, 'coord')).toBe(c);
    expect(findOwnerProject(src, 'coord')).toBeNull();
    expect(findConvLocation(src, 'coord')?.kind).toBe('workspace');
  });

  it('container path prefers worktree over project path', () => {
    const c = conv('c1', { worktreePath: '/wt' });
    const p = project('p1', '/repo', [c]);
    expect(findContainerPath({ projects: [p], workspaces: [] }, 'c1')).toBe('/wt');
  });

  it('container path falls back to project path when no worktree', () => {
    const c = conv('c1');
    const p = project('p1', '/repo', [c]);
    expect(findContainerPath({ projects: [p], workspaces: [] }, 'c1')).toBe('/repo');
  });

  it('container path for workspace coordinator prefers coordinatorRootPath', () => {
    const c = conv('coord', { coordinatorRootPath: '/symroot', worktreePath: '/wt' });
    const ws = workspace('ws1', '/wsroot', [c]);
    expect(findContainerPath({ projects: [], workspaces: [ws] }, 'coord')).toBe('/symroot');
  });

  it('container path for workspace falls back to workspace rootPath', () => {
    const c = conv('coord');
    const ws = workspace('ws1', '/wsroot', [c]);
    expect(findContainerPath({ projects: [], workspaces: [ws] }, 'coord')).toBe('/wsroot');
  });

  it('findConvWithProjectPath returns null ownerProjectPath for workspace convs', () => {
    const c = conv('coord');
    const ws = workspace('ws1', '/wsroot', [c]);
    const hit = findConvWithProjectPath({ projects: [], workspaces: [ws] }, 'coord');
    expect(hit?.conv).toBe(c);
    expect(hit?.ownerProjectPath).toBeNull();
  });

  it('findConvWithProjectPath returns project path for project convs', () => {
    const c = conv('c1');
    const p = project('p1', '/repo', [c]);
    const hit = findConvWithProjectPath({ projects: [p], workspaces: [] }, 'c1');
    expect(hit?.conv).toBe(c);
    expect(hit?.ownerProjectPath).toBe('/repo');
  });

  it('reuses the cached index across consecutive lookups', () => {
    const c1 = conv('c1');
    const c2 = conv('c2');
    const p = project('p1', '/repo', [c1, c2]);
    const src = { projects: [p], workspaces: [] };
    // No public way to assert cache hit; just verify correctness across many reads.
    for (let i = 0; i < 100; i++) {
      expect(findConversation(src, 'c1')).toBe(c1);
      expect(findConversation(src, 'c2')).toBe(c2);
    }
  });

  it('rebuilds the index when the projects array reference changes', () => {
    const c1 = conv('c1');
    const p1 = project('p1', '/repo', [c1]);
    expect(findConversation({ projects: [p1], workspaces: [] }, 'c1')).toBe(c1);
    const c2 = conv('c2');
    const p2 = project('p2', '/repo2', [c2]);
    expect(findConversation({ projects: [p2], workspaces: [] }, 'c1')).toBeNull();
    expect(findConversation({ projects: [p2], workspaces: [] }, 'c2')).toBe(c2);
  });
});
