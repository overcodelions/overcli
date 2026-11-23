import { describe, expect, it } from 'vitest';
import type { Conversation, Project, Workspace } from '@shared/types';
import {
  applyConversationChanges,
  diffConversations,
  indexConversations,
  shallowPatch,
} from './conversationSync';

function conv(id: string, extra: Partial<Conversation> = {}): Conversation {
  return { id, name: id, createdAt: 1, ...extra } as Conversation;
}

function project(id: string, conversations: Conversation[]): Project {
  return { id, name: id, path: `/acme/${id}`, conversations } as Project;
}

function workspace(id: string, conversations: Conversation[]): Workspace {
  return { id, name: id, projectIds: [], conversations } as unknown as Workspace;
}

function baselineOf(projects: Project[], workspaces: Workspace[] = []) {
  return new Map([...indexConversations(projects, workspaces)].map(([id, v]) => [id, v.conversation]));
}

describe('diffConversations', () => {
  it('skips conversations that are the same object', () => {
    const projects = [project('p', [conv('a'), conv('b')])];
    expect(diffConversations(baselineOf(projects), projects, [])).toEqual([]);
  });

  it('reports only the fields that changed', () => {
    const before = [project('p', [conv('a', { claudeModel: 'old' } as Partial<Conversation>)])];
    const after = [project('p', [{ ...before[0]!.conversations[0]!, claudeModel: 'new' } as Conversation])];
    expect(diffConversations(baselineOf(before), after, [])).toEqual([
      { kind: 'patch', id: 'a', patch: { claudeModel: 'new' } },
    ]);
  });

  it('reports a new conversation with its owner', () => {
    const before = [workspace('w', [conv('a')])];
    const fork = conv('fork');
    const after = [workspace('w', [conv('a'), fork])];
    const changes = diffConversations(baselineOf([], before), [], after);
    expect(changes).toContainEqual({ kind: 'add', owner: { kind: 'workspace', id: 'w' }, conversation: fork });
  });
});

describe('shallowPatch', () => {
  it('ignores a fresh copy of an equal nested value', () => {
    expect(shallowPatch(conv('a', { tags: ['x'] } as Partial<Conversation>), conv('a', { tags: ['x'] } as Partial<Conversation>))).toBeNull();
  });

  it('carries a removed key as undefined', () => {
    expect(
      shallowPatch(conv('a', { pendingPermissionMode: 'plan' } as Partial<Conversation>), conv('a')),
    ).toEqual({ pendingPermissionMode: undefined });
  });
});

describe('applyConversationChanges', () => {
  it('keeps what the main window changed that the patch does not touch', () => {
    // Main retitled the chat; the conversation window only changed the model.
    const projects = [project('p', [conv('a', { name: 'Retitled by main' })])];
    const out = applyConversationChanges(projects, [], [
      { kind: 'patch', id: 'a', patch: { claudeModel: 'new' } as Partial<Conversation> },
    ]);
    expect(out.changed).toBe(true);
    expect(out.projects[0]!.conversations[0]).toMatchObject({ name: 'Retitled by main', claudeModel: 'new' });
  });

  it('removes a key patched to undefined', () => {
    const projects = [project('p', [conv('a', { pendingPermissionMode: 'plan' } as Partial<Conversation>)])];
    const out = applyConversationChanges(projects, [], [
      { kind: 'patch', id: 'a', patch: { pendingPermissionMode: undefined } },
    ]);
    expect('pendingPermissionMode' in out.projects[0]!.conversations[0]!).toBe(false);
  });

  it('returns the same arrays when the patch is already applied', () => {
    const projects = [project('p', [conv('a', { name: 'same' })])];
    const out = applyConversationChanges(projects, [], [{ kind: 'patch', id: 'a', patch: { name: 'same' } }]);
    expect(out).toEqual({ projects, workspaces: [], changed: false });
    expect(out.projects).toBe(projects);
  });

  it('adds a new conversation to its owner once', () => {
    const workspaces = [workspace('w', [conv('a')])];
    const add = { kind: 'add' as const, owner: { kind: 'workspace' as const, id: 'w' }, conversation: conv('fork') };
    const once = applyConversationChanges([], workspaces, [add]);
    expect(once.workspaces[0]!.conversations.map((c) => c.id)).toEqual(['a', 'fork']);
    expect(applyConversationChanges([], once.workspaces, [add]).changed).toBe(false);
  });

  it('drops an add whose owner is gone and a patch for an unknown id', () => {
    const projects = [project('p', [])];
    const out = applyConversationChanges(projects, [], [
      { kind: 'add', owner: { kind: 'project', id: 'gone' }, conversation: conv('x') },
      { kind: 'patch', id: 'nope', patch: { name: 'y' } },
    ]);
    expect(out.changed).toBe(false);
  });
});
