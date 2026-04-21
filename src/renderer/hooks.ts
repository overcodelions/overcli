import { useMemo } from 'react';
import { useStore } from './store';
import { Backend, Conversation, UUID } from '@shared/types';
import { SlashCommandEntry } from './components/Composer';

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

/// Union of slash commands exposed to the given backend: the filesystem
/// scan (skills/agents/commands that back named `/foo` handlers), plus
/// any live built-ins reported by the *specific conversation's* init
/// block (e.g. `/help`, `/clear`). The live list is sourced from this
/// conversation's runner events — not the global `lastInit` — because
/// that global reflects whichever backend most recently fired init and
/// would leak Claude-only commands into a Codex conversation (or vice
/// versa). `WelcomePane` passes no conversationId and only gets the
/// filesystem scan, which is already backend-filtered.
export function useSlashCommands(
  backend: Backend | undefined,
  conversationId?: UUID | null,
): SlashCommandEntry[] {
  const capabilities = useStore((s) => s.capabilities);
  const events = useStore((s) => (conversationId ? s.runners[conversationId]?.events : null));
  return useMemo(() => {
    const byName = new Map<string, SlashCommandEntry>();
    for (const e of capabilities?.entries ?? []) {
      if (e.kind !== 'command') continue;
      if (backend && !e.clis.includes(backend)) continue;
      byName.set(e.name, {
        name: e.name,
        description: e.description,
        source: e.source === 'builtin' ? undefined : e.source,
      });
    }
    const liveNames = latestInitSlashCommands(events);
    for (const raw of liveNames) {
      const name = raw.startsWith('/') ? raw.slice(1) : raw;
      if (!name) continue;
      if (byName.has(name)) continue;
      byName.set(name, { name });
    }
    return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [capabilities, events, backend]);
}

function latestInitSlashCommands(events: readonly unknown[] | null | undefined): string[] {
  if (!events) return [];
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i] as { kind?: { type?: string; info?: { slashCommands?: string[] } } };
    if (ev?.kind?.type === 'systemInit') {
      return ev.kind.info?.slashCommands ?? [];
    }
  }
  return [];
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

