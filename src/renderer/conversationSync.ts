// Keeping a popped-out conversation window and the main window in step.
//
// The main window is the only one that writes projects and workspaces to
// disk: two renderers each saving their whole copy of the tree would undo
// each other. A conversation window instead reports what IT changed, field
// by field, and main hands that to the main window to apply and save.
//
// Field by field, not the whole conversation: both windows see the same
// stream, but some changes only ever happen in the main window (the
// auto-namer retitles a chat, the Work list records its branch). A whole
// copy from the conversation window would put the old title back. A patch
// only carries what the conversation window actually changed since it last
// heard from main, so anything else main did survives.

import type { Conversation, ConversationChange, Project, UUID, Workspace } from '@shared/types';

export type { ConversationChange };

/// Every conversation in the tree, by id, with its owner.
export function indexConversations(
  projects: readonly Project[],
  workspaces: readonly Workspace[],
): Map<UUID, { conversation: Conversation; owner: { kind: 'project' | 'workspace'; id: UUID } }> {
  const out = new Map<UUID, { conversation: Conversation; owner: { kind: 'project' | 'workspace'; id: UUID } }>();
  for (const p of projects) {
    for (const c of p.conversations) out.set(c.id, { conversation: c, owner: { kind: 'project', id: p.id } });
  }
  for (const w of workspaces) {
    for (const c of w.conversations ?? []) out.set(c.id, { conversation: c, owner: { kind: 'workspace', id: w.id } });
  }
  return out;
}

/// What changed between `baseline` (the tree as last agreed with main) and
/// the window's current tree. Conversations are immutable in the store, so an
/// unchanged one is the same object and costs nothing to skip.
export function diffConversations(
  baseline: ReadonlyMap<UUID, Conversation>,
  projects: readonly Project[],
  workspaces: readonly Workspace[],
): ConversationChange[] {
  const changes: ConversationChange[] = [];
  for (const [id, { conversation, owner }] of indexConversations(projects, workspaces)) {
    const before = baseline.get(id);
    if (before === conversation) continue;
    if (!before) {
      changes.push({ kind: 'add', owner, conversation });
      continue;
    }
    const patch = shallowPatch(before, conversation);
    if (patch) changes.push({ kind: 'patch', id, patch });
  }
  return changes;
}

/// The keys of `after` that differ from `before`. A key that was removed is
/// carried as `undefined`, so applying the patch removes it too.
export function shallowPatch(before: Conversation, after: Conversation): Partial<Conversation> | null {
  const patch: Record<string, unknown> = {};
  let any = false;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    const a = (before as unknown as Record<string, unknown>)[k];
    const b = (after as unknown as Record<string, unknown>)[k];
    if (a === b || sameJson(a, b)) continue;
    patch[k] = b;
    any = true;
  }
  return any ? (patch as Partial<Conversation>) : null;
}

/// Apply changes from a conversation window. Returns the same arrays when
/// nothing changed, so the caller can skip the save; an `add` whose owner is
/// gone, or that already exists, is dropped.
export function applyConversationChanges(
  projects: Project[],
  workspaces: Workspace[],
  changes: readonly ConversationChange[],
): { projects: Project[]; workspaces: Workspace[]; changed: boolean } {
  let nextProjects = projects;
  let nextWorkspaces = workspaces;
  let changed = false;
  const known = indexConversations(projects, workspaces);
  for (const change of changes) {
    if (change.kind === 'add') {
      if (known.has(change.conversation.id)) continue;
      const { owner, conversation } = change;
      if (owner.kind === 'project') {
        if (!nextProjects.some((p) => p.id === owner.id)) continue;
        nextProjects = nextProjects.map((p) =>
          p.id === owner.id ? { ...p, conversations: [...p.conversations, conversation] } : p,
        );
      } else {
        if (!nextWorkspaces.some((w) => w.id === owner.id)) continue;
        nextWorkspaces = nextWorkspaces.map((w) =>
          w.id === owner.id ? { ...w, conversations: [...(w.conversations ?? []), conversation] } : w,
        );
      }
      changed = true;
      continue;
    }
    const apply = (c: Conversation): Conversation => {
      const merged = { ...c, ...change.patch } as Record<string, unknown>;
      for (const [k, v] of Object.entries(change.patch)) if (v === undefined) delete merged[k];
      return merged as unknown as Conversation;
    };
    const owner = known.get(change.id)?.owner;
    if (!owner) continue;
    const current = known.get(change.id)!.conversation;
    if (!shallowPatch(current, apply(current))) continue;
    if (owner.kind === 'project') {
      nextProjects = nextProjects.map((p) =>
        p.id === owner.id
          ? { ...p, conversations: p.conversations.map((c) => (c.id === change.id ? apply(c) : c)) }
          : p,
      );
    } else {
      nextWorkspaces = nextWorkspaces.map((w) =>
        w.id === owner.id
          ? { ...w, conversations: (w.conversations ?? []).map((c) => (c.id === change.id ? apply(c) : c)) }
          : w,
      );
    }
    changed = true;
  }
  return { projects: nextProjects, workspaces: nextWorkspaces, changed };
}

function sameJson(a: unknown, b: unknown): boolean {
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
