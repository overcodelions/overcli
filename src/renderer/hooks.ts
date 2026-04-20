import { useStore } from './store';
import { Conversation, UUID } from '@shared/types';

/// Memoized lookup of a conversation anywhere in the store. Recomputes
/// only when the underlying projects/workspaces arrays change — cheap
/// enough because React's shallow equality via Zustand returns the same
/// reference when nothing touched the parent arrays.
export function useConversation(id: UUID | null | undefined): Conversation | null {
  return useStore((s) => {
    if (!id) return null;
    for (const p of s.projects) {
      const c = p.conversations.find((x) => x.id === id);
      if (c) return c;
    }
    for (const w of s.workspaces) {
      const c = (w.conversations ?? []).find((x) => x.id === id);
      if (c) return c;
    }
    return null;
  });
}

export function useConversationRoot(id: UUID | null | undefined): string | null {
  return useStore((s) => {
    if (!id) return null;
    for (const p of s.projects) {
      const c = p.conversations.find((x) => x.id === id);
      if (c) return c.worktreePath ?? p.path;
    }
    for (const w of s.workspaces) {
      const c = (w.conversations ?? []).find((x) => x.id === id);
      if (c) return c.coordinatorRootPath ?? c.worktreePath ?? w.rootPath;
    }
    return null;
  });
}

