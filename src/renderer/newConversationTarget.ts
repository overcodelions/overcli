// Where does "new conversation" land when the user didn't say?
//
// Two callers ask this — ⌘N and the sidebar's compose button — and they have
// to agree, or the button and the shortcut quietly create chats in different
// places. Hence one resolver rather than two fallback chains.
//
// The answer is deliberately allowed to be `null`. The old ⌘N handler fell
// back to `projects[0]` when it had no context, which meant a user with eight
// projects got a conversation in whichever one happened to be first. Better to
// admit we don't know and let the caller ask.

import type { Project, UUID, Workspace } from '../shared/types';
import { findConvLocation } from './conversationLookup';

export type NewConversationTarget =
  | { kind: 'project'; id: UUID; name: string }
  | { kind: 'workspace'; id: UUID; name: string };

export interface NewConversationSource {
  projects: readonly Project[];
  workspaces: readonly Workspace[];
  selectedConversationId: UUID | null;
  focusedProjectId?: UUID | null;
  focusedWorkspaceId?: UUID | null;
}

/// Best guess at the place the user means, or null when there is no honest
/// guess to make. In precedence order: whatever conversation is open, then
/// whatever place the app is focused on, then the only project there is.
export function resolveNewConversationTarget(
  src: NewConversationSource,
): NewConversationTarget | null {
  const convId = src.selectedConversationId;
  if (convId) {
    // Flow-hosted conversations aren't in this index (no flowRuns passed) and
    // shouldn't be anyway: a flow participant's project is the runtime's
    // business, not a place the user picked to chat in.
    const hit = findConvLocation(src, convId);
    if (hit?.kind === 'project') return { kind: 'project', id: hit.project.id, name: hit.project.name };
    if (hit?.kind === 'workspace') {
      return { kind: 'workspace', id: hit.workspace.id, name: hit.workspace.name };
    }
  }
  if (src.focusedWorkspaceId) {
    const ws = src.workspaces.find((w) => w.id === src.focusedWorkspaceId);
    if (ws) return { kind: 'workspace', id: ws.id, name: ws.name };
  }
  if (src.focusedProjectId) {
    const p = src.projects.find((x) => x.id === src.focusedProjectId);
    if (p) return { kind: 'project', id: p.id, name: p.name };
  }
  // One project and no workspaces is not a guess, it's the only option.
  if (src.projects.length === 1 && src.workspaces.length === 0) {
    const p = src.projects[0]!;
    return { kind: 'project', id: p.id, name: p.name };
  }
  return null;
}

/// Tooltip / menu wording. Naming the destination is the whole point of the
/// affordance — a bare "New conversation" leaves the user to find out where it
/// went by creating one.
export function newConversationLabel(target: NewConversationTarget | null): string {
  return target ? `New conversation in ${target.name}` : 'New conversation…';
}
