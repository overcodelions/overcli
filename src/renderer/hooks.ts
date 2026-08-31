import { useMemo } from 'react';
import { useStore } from './store';
import { Backend, Conversation, SystemInitInfo, UUID } from '@shared/types';
import { SlashCommandEntry } from './components/Composer';
import { findConversation, findContainerPath } from './conversationLookup';
import { useRunnerEvents } from './runnersStore';
import { backendFromModel } from './theme';

/// Memoized lookup of a conversation anywhere in the store. Recomputes
/// only when the underlying projects/workspaces arrays change — cheap
/// enough because React's shallow equality via Zustand returns the same
/// reference when nothing touched the parent arrays.
export function useConversation(id: UUID | null | undefined): Conversation | null {
  return useStore((s) => (id ? findConversation(s, id) : null));
}

/// Union of slash commands exposed to the given backend: the filesystem
/// scan (skills/agents/commands that back named `/foo` handlers), plus
/// the live built-ins reported by an init block (e.g. `/help`, `/design`).
///
/// Preference order for the live half: this conversation's own init event,
/// then the global `lastInit`. The conversation's own is authoritative, but
/// it only exists after a first turn has run — so before that, and on the
/// WelcomePane (which has no conversation at all), every command the CLI
/// bundles rather than keeps on disk was invisible in the menu while still
/// working when typed blind. The global is a last-writer-wins record across
/// backends, which is why it was avoided here originally; gating it on the
/// backend that produced it keeps Claude-only commands out of a Codex
/// conversation, and falls back to the filesystem scan alone when the last
/// init came from some other backend.
export function useSlashCommands(
  backend: Backend | undefined,
  conversationId?: UUID | null,
): SlashCommandEntry[] {
  const capabilities = useStore((s) => s.capabilities);
  const events = useRunnerEvents(conversationId);
  const lastInit = useStore((s) => s.lastInit);
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
    const liveNames = pickLiveSlashNames(latestInitSlashCommands(events), lastInit, backend);
    for (const raw of liveNames) {
      const name = raw.startsWith('/') ? raw.slice(1) : raw;
      if (!name) continue;
      if (byName.has(name)) continue;
      byName.set(name, { name });
    }
    return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [capabilities, events, backend, lastInit]);
}

/// Which init block's command list to trust: the conversation's own when it
/// has one, otherwise the global last-seen init — but only when that init came
/// from the same backend, so a Codex session's commands never surface in a
/// Claude composer. Exported for tests; the backend guard is the whole reason
/// this is more than `a.length ? a : b`.
export function pickLiveSlashNames(
  ownNames: string[],
  lastInit: SystemInitInfo | undefined,
  backend: Backend | undefined,
): string[] {
  if (ownNames.length) return ownNames;
  if (!lastInit) return [];
  if (backend && backendFromModel(lastInit.model) !== backend) return [];
  return lastInit.slashCommands ?? [];
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
  return useStore((s) => (id ? findContainerPath(s, id) : null));
}

