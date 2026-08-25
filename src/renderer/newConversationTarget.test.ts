import { describe, expect, it } from 'vitest';

import { newConversationLabel, resolveNewConversationTarget } from './newConversationTarget';
import type { Conversation, Project, Workspace } from '../shared/types';

function conv(id: string): Conversation {
  return { id, name: id, backend: 'claude', permissionMode: 'default', model: 'sonnet', createdAt: 0 } as unknown as Conversation;
}

function project(id: string, conversations: Conversation[] = []): Project {
  return { id, name: `proj-${id}`, path: `/repo/${id}`, conversations } as Project;
}

function workspace(id: string, conversations: Conversation[] = []): Workspace {
  return { id, name: `ws-${id}`, rootPath: `/root/${id}`, conversations, projectIds: [], createdAt: 0 } as Workspace;
}

describe('resolveNewConversationTarget', () => {
  it('follows the open conversation into its project', () => {
    const p = project('p1', [conv('c1')]);
    expect(
      resolveNewConversationTarget({
        projects: [p, project('p2')],
        workspaces: [],
        selectedConversationId: 'c1',
      }),
    ).toEqual({ kind: 'project', id: 'p1', name: 'proj-p1' });
  });

  it('follows a workspace-hosted conversation to its workspace', () => {
    const ws = workspace('w1', [conv('coord')]);
    expect(
      resolveNewConversationTarget({
        projects: [project('p1')],
        workspaces: [ws],
        selectedConversationId: 'coord',
      }),
    ).toEqual({ kind: 'workspace', id: 'w1', name: 'ws-w1' });
  });

  it('falls back to the focused place when nothing is open', () => {
    expect(
      resolveNewConversationTarget({
        projects: [project('p1'), project('p2')],
        workspaces: [],
        selectedConversationId: null,
        focusedProjectId: 'p2',
      }),
    ).toEqual({ kind: 'project', id: 'p2', name: 'proj-p2' });
  });

  it('prefers a focused workspace over a focused project', () => {
    expect(
      resolveNewConversationTarget({
        projects: [project('p1')],
        workspaces: [workspace('w1')],
        selectedConversationId: null,
        focusedProjectId: 'p1',
        focusedWorkspaceId: 'w1',
      }),
    ).toEqual({ kind: 'workspace', id: 'w1', name: 'ws-w1' });
  });

  it('takes the only project there is', () => {
    expect(
      resolveNewConversationTarget({
        projects: [project('p1')],
        workspaces: [],
        selectedConversationId: null,
      }),
    ).toEqual({ kind: 'project', id: 'p1', name: 'proj-p1' });
  });

  it('refuses to guess between several places', () => {
    expect(
      resolveNewConversationTarget({
        projects: [project('p1'), project('p2')],
        workspaces: [],
        selectedConversationId: null,
      }),
    ).toBeNull();
  });

  it('refuses to guess when a lone project sits beside a workspace', () => {
    expect(
      resolveNewConversationTarget({
        projects: [project('p1')],
        workspaces: [workspace('w1')],
        selectedConversationId: null,
      }),
    ).toBeNull();
  });

  it('ignores a stale selection that no longer resolves', () => {
    expect(
      resolveNewConversationTarget({
        projects: [project('p1'), project('p2')],
        workspaces: [],
        selectedConversationId: 'gone',
      }),
    ).toBeNull();
  });

  it('names the destination, and says nothing it does not know', () => {
    expect(newConversationLabel({ kind: 'project', id: 'p1', name: 'overcli' })).toBe(
      'New conversation in overcli',
    );
    expect(newConversationLabel(null)).toBe('New conversation…');
  });
});
