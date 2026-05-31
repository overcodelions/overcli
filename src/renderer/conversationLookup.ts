// Memoized conversation index. Conversations live under either a Project
// or a Workspace (workspace-agent coordinators); we want O(1) lookup by
// id without forcing every caller to iterate both arrays.
//
// The cache is keyed off the (projects, workspaces) array references.
// Zustand replaces those arrays on every mutation, so two consecutive
// reads from the same store snapshot share the same Map. When a
// mutation lands the next read rebuilds it lazily.

import type { Backend, Conversation, Project, UUID, Workspace } from '../shared/types';
import type { FlowRun } from '../shared/flows/schema';

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
  | { kind: 'workspace'; workspace: Workspace; conversation: Conversation }
  | { kind: 'flow'; run: FlowRun; participantId: string; conversation: Conversation };

let cachedProjects: readonly Project[] | null = null;
let cachedWorkspaces: readonly Workspace[] | null = null;
let cachedFlowRuns: Readonly<Record<UUID, FlowRun>> | null = null;
let cachedIndex: Map<UUID, ConvLocation> | null = null;

function getIndex(
  projects: readonly Project[],
  workspaces: readonly Workspace[],
  flowRuns: Readonly<Record<UUID, FlowRun>>,
): Map<UUID, ConvLocation> {
  if (
    cachedIndex &&
    cachedProjects === projects &&
    cachedWorkspaces === workspaces &&
    cachedFlowRuns === flowRuns
  ) {
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
  for (const run of Object.values(flowRuns)) {
    for (const [participantId, convId] of Object.entries(run.conversationIds)) {
      const conversation = synthesizeFlowConversation(run, participantId, convId);
      if (conversation) {
        idx.set(convId, { kind: 'flow', run, participantId, conversation });
      }
    }
  }
  cachedProjects = projects;
  cachedWorkspaces = workspaces;
  cachedFlowRuns = flowRuns;
  cachedIndex = idx;
  return idx;
}

/// Build a Conversation-shape object for a flow participant from its
/// FlowRun + participant config. Flow conversations don't live in
/// `projects[]`/`workspaces[]` (they're driven by the flow runtime), but
/// the rest of the app expects all conversations to be findable via the
/// shared lookup — so we synthesize one on demand. Mutations from
/// `store.send` etc. fall on the floor here (no setter is wired back to
/// flowsStore), which is intentional: flow convs are managed by the
/// runtime, not the regular conversation mutation path.
function synthesizeFlowConversation(
  run: FlowRun,
  participantId: string,
  convId: UUID,
): Conversation | null {
  const participant = run.flowSnapshot.participants?.find((p) => p.id === participantId);
  if (!participant) return null;
  const backend = participant.backend as Backend;
  const sessionId = run.sessionIdsByParticipant?.[participantId];
  // Honor a post-launch model override so EVERY turn driven through the
  // generic conversation path — most importantly answering a question the
  // model asked, which routes through `store.send` reading these model
  // fields — runs on the upgraded model, not the declared one. Same
  // source of truth the runtime uses for orchestration.
  const model = run.modelOverrides?.[participantId] ?? participant.model;
  return {
    id: convId,
    name: participant.name,
    sessionId,
    createdAt: run.createdAt,
    lastActiveAt: run.createdAt,
    totalCostUSD: 0,
    turnCount: 0,
    currentModel: model,
    permissionMode: 'bypassPermissions',
    hidden: true,
    primaryBackend: backend,
    ...(backend === 'claude' ? { claudeModel: model } : {}),
    ...(backend === 'codex' ? { codexModel: model } : {}),
    ...(backend === 'gemini' ? { geminiModel: model } : {}),
    ...(backend === 'ollama' ? { ollamaModel: model } : {}),
  };
}

export interface LookupSource {
  projects: readonly Project[];
  workspaces: readonly Workspace[];
  /// Flow runs from `useFlowsStore`. Optional so unit tests / callers
  /// that don't care about flow conversations don't have to plumb the
  /// extra store through.
  flowRuns?: Readonly<Record<UUID, FlowRun>>;
}

const EMPTY_RUNS: Record<UUID, FlowRun> = {};

export function findConvLocation(src: LookupSource, id: UUID): ConvLocation | null {
  return getIndex(src.projects, src.workspaces, src.flowRuns ?? EMPTY_RUNS).get(id) ?? null;
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
  if (hit.kind === 'flow') {
    // Flow conv's cwd is whatever the run was launched against — a
    // project path, a worktree, or a workspace symlink root.
    return hit.run.projectPath;
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
