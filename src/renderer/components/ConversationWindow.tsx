// A conversation popped out into a window of its own: two chats on two
// screens, or one kept in view while you work in the main window.
//
// Loaded by the same renderer bundle with `?conversation=<id>` (see main.tsx).
// It streams and sends like the main window, but never writes the store:
// main forwards it its own conversation's events, its saves go back to the
// main window as field-level changes, and what the main window saves comes
// back here (see conversationSync.ts). The main window shows a placeholder
// meanwhile, so there is one composer per conversation.

import { useEffect, useState } from 'react';
import type { UUID } from '@shared/types';
import { setConversationSyncBaseline, useStore } from '../store';
import { useRunnersStore } from '../runnersStore';
import { useConversation } from '../hooks';
import { useThemeEffect } from '../useThemeEffect';
import { useRunningReconcile } from '../useRunningReconcile';
import { ConversationColumn } from './ConversationPane';
import { SheetHost } from './SheetHost';

export function ConversationWindow({ id }: { id: UUID }) {
  const [ready, setReady] = useState(false);
  const conv = useConversation(id);
  useThemeEffect();
  useRunningReconcile();

  useEffect(() => {
    let live = true;
    void Promise.all([
      window.overcli.invoke('store:load'),
      window.overcli.invoke('runner:runningSnapshot').catch(() => []),
    ]).then(([state, running]) => {
      if (!live) return;
      useStore.setState({
        storeLoaded: true,
        settings: state.settings,
        projects: state.projects,
        workspaces: state.workspaces,
        colosseums: state.colosseums,
        lastInit: state.lastInit,
        selectedConversationId: id,
        detailMode: 'conversation',
      });
      setConversationSyncBaseline(state.projects, state.workspaces);
      // A turn already under way when the window opened: show it as running
      // now rather than at its next event.
      const now = running.find((r) => r.conversationId === id);
      if (now) {
        useRunnersStore.getState().patchRunner(id, {
          isRunning: true,
          runningSince: Date.now(),
          activityLabel: now.activityLabel,
        });
      }
      const store = useStore.getState();
      void store.loadHistoryIfNeeded(id);
      void store.refreshBackendHealth();
      setReady(true);
    });
    return () => {
      live = false;
    };
  }, [id]);

  // Main forwards only this conversation's events, plus what the main
  // window saved of it.
  useEffect(() => window.overcli.onMainEvent((e) => useStore.getState().ingestMainEvent(e)), []);

  useEffect(() => {
    document.title = conv?.name ?? 'Conversation';
  }, [conv?.name]);

  return (
    <div className="flex h-screen w-screen flex-col bg-surface">
      {/* The inset traffic lights sit over this strip, so it is the window's
          drag handle and keeps its text clear of them. */}
      <div className="draggable flex h-9 flex-shrink-0 items-center justify-between border-b border-card bg-surface-muted pl-20 pr-2">
        <div className="min-w-0 truncate text-[11.5px] text-ink-muted" title={conv?.name}>
          {conv?.name ?? ''}
        </div>
        <button
          className="no-drag rounded px-1.5 py-0.5 text-[11px] text-ink-faint hover:bg-card hover:text-ink"
          title="Close this window and show the conversation in the main window again"
          onClick={() => void window.overcli.invoke('conversation:popIn', { id })}
        >
          Put back
        </button>
      </div>
      <div className="flex flex-1 min-h-0">
        {!ready ? null : conv ? (
          <ConversationColumn conversationId={id} />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-ink-muted">
            This conversation is no longer here.
          </div>
        )}
      </div>
      <SheetHost />
    </div>
  );
}
