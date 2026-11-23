// The conversations — and flow runs — you have open, as tabs above the chat.
//
// The sidebar is everything you have ever started; tabs are what you are
// working on now. A tab is a conversation id, or `run:<id>` for a flow run
// (see `runTabKey`), so both share one strip, one order and one cap.
// Opening either from anywhere — sidebar, palette, a link — puts it in the
// strip beside the one you were on, and the strip survives a restart.
// Pure on purpose: the store calls these and persists the result, and every
// rule about where a tab lands or what takes over when one closes is tested
// here.

import type { UUID } from '@shared/types';

/// Enough for a real working set. Past this the oldest tab you are not on
/// falls off, the way an editor drops its least recent one, rather than the
/// strip growing until no title is readable.
export const MAX_CONVERSATION_TABS = 12;

const RUN_PREFIX = 'run:';

/// The tab key for a flow run.
export function runTabKey(runId: string): string {
  return RUN_PREFIX + runId;
}

/// What a tab key names.
export function parseTabKey(key: string): { kind: 'conversation' | 'run'; id: string } {
  return key.startsWith(RUN_PREFIX)
    ? { kind: 'run', id: key.slice(RUN_PREFIX.length) }
    : { kind: 'conversation', id: key };
}

/// Put `id` in the strip, right after `after` (the tab you were on) so a
/// conversation opened from the one you're reading lands next to it. A tab
/// that is already open stays where it is.
export function openTab(tabs: readonly UUID[], id: UUID, after: UUID | null): UUID[] {
  if (tabs.includes(id)) return tabs as UUID[];
  const at = after ? tabs.indexOf(after) : -1;
  const next = at === -1 ? [...tabs, id] : [...tabs.slice(0, at + 1), id, ...tabs.slice(at + 1)];
  if (next.length <= MAX_CONVERSATION_TABS) return next;
  // Over the cap: drop the tab furthest from the new one, never the new one
  // or the one you came from.
  const keep = new Set([id, after]);
  const dropIdx = next[0] && !keep.has(next[0]) ? 0 : next.findIndex((t) => !keep.has(t));
  return next.filter((_, i) => i !== dropIdx);
}

/// Close `id`. When it was the tab on screen, the one to its right takes
/// over (its left at the end of the strip), as in every tabbed editor; null
/// when it was the last.
export function closeTab(
  tabs: readonly UUID[],
  id: UUID,
  selected: UUID | null,
): { tabs: UUID[]; selected: UUID | null } {
  const idx = tabs.indexOf(id);
  if (idx === -1) return { tabs: tabs as UUID[], selected };
  const next = tabs.filter((t) => t !== id);
  if (selected !== id) return { tabs: next, selected };
  return { tabs: next, selected: next[idx] ?? next[idx - 1] ?? null };
}

/// Move `id` to sit where `before` is (or to the end when `before` is null).
export function moveTab(tabs: readonly UUID[], id: UUID, before: UUID | null): UUID[] {
  if (id === before || !tabs.includes(id)) return tabs as UUID[];
  const rest = tabs.filter((t) => t !== id);
  const at = before ? rest.indexOf(before) : -1;
  return at === -1 ? [...rest, id] : [...rest.slice(0, at), id, ...rest.slice(at)];
}

/// The tab `step` places along from `current`, wrapping at the ends.
/// Ctrl+Tab and Ctrl+Shift+Tab.
export function cycleTab(tabs: readonly UUID[], current: UUID | null, step: 1 | -1): UUID | null {
  if (tabs.length === 0) return null;
  const idx = current ? tabs.indexOf(current) : -1;
  if (idx === -1) return tabs[step === 1 ? 0 : tabs.length - 1]!;
  return tabs[(idx + step + tabs.length) % tabs.length]!;
}

/// Drop tabs whose conversation no longer exists (deleted, or a restored
/// strip naming one from a store that has since moved on), and duplicates.
export function pruneTabs(tabs: readonly unknown[], exists: (id: UUID) => boolean): UUID[] {
  const out: UUID[] = [];
  for (const t of tabs) {
    if (typeof t !== 'string' || !t || out.includes(t) || !exists(t)) continue;
    out.push(t);
    if (out.length >= MAX_CONVERSATION_TABS) break;
  }
  return out;
}
