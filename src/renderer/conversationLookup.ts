// Memoized conversation index. Conversations live under either a Project
// or a Workspace (workspace-agent coordinators); we want O(1) lookup by
// id without forcing every caller to iterate both arrays.
//
// The cache is keyed off the (projects, workspaces) array references.
// Zustand replaces those arrays on every mutation, so two consecutive
// reads from the same store snapshot share the same Map. When a
// mutation lands the next read rebuilds it lazily.

import type { Conversation, Project, UUID, Workspace } from '../shared/types';

/// Window during which a conversation counts as "Active" — surfaces it
/// in the top-of-sidebar Active section and suppresses redundant
/// project reordering when it gets re-selected.
export const ACTIVE_CONVERSATION_WINDOW_MS = 10 * 60 * 1000;

export function conversationActivityAt(conv: Conversation): number {
  return conv.lastActiveAt ?? conv.createdAt ?? 0;
}

export function isActiveConversation(
  conv: Conversation,
  isRunning: boolean,
  cutoff: number = Date.now() - ACTIVE_CONVERSATION_WINDOW_MS,
): boolean {
  return isRunning || conversationActivityAt(conv) >= cutoff;
}

export type ConvLocation =
  | { kind: 'project'; project: Project; conversation: Conversation }
  | { kind: 'workspace'; workspace: Workspace; conversation: Conversation };

let cachedProjects: readonly Project[] | null = null;
let cachedWorkspaces: readonly Workspace[] | null = null;
let cachedIndex: Map<UUID, ConvLocation> | null = null;

function getIndex(
  projects: readonly Project[],
  workspaces: readonly Workspace[],
): Map<UUID, ConvLocation> {
  if (cachedIndex && cachedProjects === projects && cachedWorkspaces === workspaces) {
    return cachedIndex;
  }
  const idx = new Map<UUID, ConvLocation>();
  for (const project of projects) {
    for (const conversation of project.conversations) {
      idx.set(conversation.id, { kind: 'project', project, conversation });
    }
  }
  for (const workspace of workspaces) {
    for (const conversation of workspace.conversations ?? []) {
      idx.set(conversation.id, { kind: 'workspace', workspace, conversation });
    }
  }
  cachedProjects = projects;
  cachedWorkspaces = workspaces;
  cachedIndex = idx;
  return idx;
}

export interface LookupSource {
  projects: readonly Project[];
  workspaces: readonly Workspace[];
}

export function findConvLocation(src: LookupSource, id: UUID): ConvLocation | null {
  return getIndex(src.projects, src.workspaces).get(id) ?? null;
}

export function findConversation(src: LookupSource, id: UUID): Conversation | null {
  return findConvLocation(src, id)?.conversation ?? null;
}

/// The project that owns this conversation directly. Workspace-hosted
/// conversations (coordinators) return null — they aren't owned by a
/// specific project even if their members are.
export function findOwnerProject(src: LookupSource, id: UUID): Project | null {
  const hit = findConvLocation(src, id);
  return hit?.kind === 'project' ? hit.project : null;
}

/// Filesystem root the conversation runs out of. For project-hosted convs
/// it's the worktree (if any) or the project path. For workspace-hosted
/// coordinators it's the coordinator root (a symlink farm) or the
/// workspace's main rootPath.
export function findContainerPath(src: LookupSource, id: UUID): string | null {
  const hit = findConvLocation(src, id);
  if (!hit) return null;
  if (hit.kind === 'project') {
    return hit.conversation.worktreePath ?? hit.project.path;
  }
  return hit.conversation.coordinatorRootPath ?? hit.conversation.worktreePath ?? hit.workspace.rootPath;
}

/// Like findConvLocation but unwraps to the (conv, owning-project-path)
/// pair the legacy store helpers want. ownerProjectPath is null for
/// workspace-hosted conversations.
export function findConvWithProjectPath(
  src: LookupSource,
  id: UUID,
): { conv: Conversation; ownerProjectPath: string | null } | null {
  const hit = findConvLocation(src, id);
  if (!hit) return null;
  return {
    conv: hit.conversation,
    ownerProjectPath: hit.kind === 'project' ? hit.project.path : null,
  };
}
