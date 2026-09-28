// Handoffs waiting in `~/.overcli/inbox` — work another tool (overdb first)
// passed over. Main reads the folder; everything about WHERE a handoff opens
// is decided here, because the projects and workspaces live in this process.
//
// A handoff is on the title-bar tray and counted on its place in the sidebar
// until it is started or dismissed. Opening one lands on the start page of
// its target with the composer seeded and a card above it; nothing is sent
// until the person sends it.

import { useMemo } from 'react';
import { create } from 'zustand';

import {
  handoffDraft,
  handoffQuote,
  handoffTargetId,
  resolveHandoffTarget,
  type HandoffTarget,
  type InboundHandoff,
} from '@shared/handoff';
import type { Conversation, Project, Workspace } from '@shared/types';
import { conversationActivityAt } from './conversationLookup';
import { useStore } from './store';

const WELCOME_KEY = '__welcome__';

interface HandoffsState {
  handoffs: InboundHandoff[];
  /// The one whose card is showing on the start page. Cleared when it is
  /// started or dismissed, and when the person goes somewhere else — the
  /// card belongs to the draft it seeded, not to the start page forever.
  activeId: string | null;
  setHandoffs(handoffs: InboundHandoff[]): void;
  open(id: string): void;
  close(): void;
  /// Started or dismissed. Removed here at once; main moves the file.
  resolve(id: string): Promise<void>;
}

export const useHandoffsStore = create<HandoffsState>((set, get) => ({
  handoffs: [],
  activeId: null,

  setHandoffs(handoffs) {
    set((s) => ({
      handoffs,
      activeId: s.activeId && handoffs.some((h) => h.id === s.activeId) ? s.activeId : null,
    }));
  },

  open(id) {
    const h = get().handoffs.find((x) => x.id === id);
    if (!h) return;
    const st = useStore.getState();
    // The start page has one draft. Something typed there and not sent is
    // the person's, so it is only replaced when they say so — a handoff's own
    // earlier seed is fair game.
    const existing = (st.conversationDrafts[WELCOME_KEY] ?? '').trim();
    if (
      existing &&
      !get().handoffs.some((x) => existing.includes(handoffQuote(x))) &&
      !window.confirm('Replace the unsent message on the start page with this handoff?')
    ) {
      return;
    }
    const target = handoffTarget(h, st.projects, st.workspaces);
    if (target.kind === 'workspace') st.startNewConversationInWorkspace(target.workspaceId);
    else if (target.kind === 'project') st.startNewConversation(target.projectId);
    else {
      // Nothing matched. Open on whatever was in focus; the card says so and
      // the place picker under the composer is how you move it.
      const fallback = st.focusedProjectId ?? st.projects[0]?.id;
      if (!fallback) return;
      st.startNewConversation(fallback);
    }
    st.setDraft(WELCOME_KEY, handoffDraft(h));
    set({ activeId: id });
  },

  close() {
    set({ activeId: null });
  },

  async resolve(id) {
    set((s) => ({
      handoffs: s.handoffs.filter((h) => h.id !== id),
      activeId: s.activeId === id ? null : s.activeId,
    }));
    await window.overcli.invoke('handoffs:resolve', id).catch(() => false);
  },
}));

/// Load what is waiting and follow the folder. Called once from App.
export function initHandoffs(): () => void {
  void window.overcli
    .invoke('handoffs:list')
    .then((list) => useHandoffsStore.getState().setHandoffs(list ?? []))
    .catch(() => {});
  const offEvents = window.overcli.onMainEvent((e) => {
    if (e.type === 'handoffsChanged') useHandoffsStore.getState().setHandoffs(e.handoffs);
  });
  // The card belongs to the draft it seeded. Once that draft no longer holds
  // the report — sent, cleared, or replaced by something else that seeds the
  // start page — the card goes too, so a later, unrelated send from the
  // start page cannot settle it.
  const offDraft = useStore.subscribe((s, prev) => {
    const draft = s.conversationDrafts[WELCOME_KEY];
    if (draft === prev.conversationDrafts[WELCOME_KEY]) return;
    const active = activeHandoff();
    if (active && !(draft ?? '').includes(handoffQuote(active))) useHandoffsStore.getState().close();
  });
  return () => {
    offEvents();
    offDraft();
  };
}

function activeHandoff(): InboundHandoff | undefined {
  const { handoffs, activeId } = useHandoffsStore.getState();
  return activeId ? handoffs.find((h) => h.id === activeId) : undefined;
}

/// The handoff a message being sent from the start page settles: the active
/// one, and only if its report is in what is being sent.
export function handoffSettledBy(prompt: string): string | null {
  const active = activeHandoff();
  return active && prompt.includes(handoffQuote(active)) ? active.id : null;
}

export function handoffTarget(
  h: InboundHandoff,
  projects: readonly Project[],
  workspaces: readonly Workspace[],
): HandoffTarget {
  const activity = (convs: readonly Conversation[] | undefined) =>
    Math.max(0, ...(convs ?? []).map(conversationActivityAt));
  return resolveHandoffTarget(
    h.repoHints,
    projects.map((p) => ({ id: p.id, path: p.path, activityAt: activity(p.conversations) })),
    workspaces.map((w) => ({
      id: w.id,
      projectIds: w.projectIds,
      activityAt: activity(w.conversations),
    })),
  );
}

/// Waiting handoffs per place id — the sidebar's "needs you" share.
export function useHandoffCountsByPlace(): Map<string, number> {
  const handoffs = useHandoffsStore((s) => s.handoffs);
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  return useMemo(() => {
    const counts = new Map<string, number>();
    for (const h of handoffs) {
      const id = handoffTargetId(handoffTarget(h, projects, workspaces));
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }, [handoffs, projects, workspaces]);
}
