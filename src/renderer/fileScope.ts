// Which set of editor tabs is on screen.
//
// The file editor mounts in four places — beside a conversation, beside a
// flow run, beside a worker's desk, and inside the explorer — and each of
// those should remember its own open files. Rather than have every navigation action clear the
// editor (which is what it used to do, in five different places), we derive
// a scope key from the view and let `switchFileScope` save the tabs we're
// leaving and restore the ones we're arriving at.

import { useEffect } from 'react';
import { useStore } from './store';
import { useFlowsStore } from './flowsStore';
import { useWorkersStore } from './workersStore';
import { flowRunPaneIsOnScreen } from './fileEditorRoot';

export interface FileScopeInput {
  detailMode: string;
  selectedConversationId: string | null;
  explorerRootPath: string | null;
  activeRunId: string | null;
  selectedWorkerId: string | null;
  /// Which Workers page is up — 'worker' for a desk, 'hire' for the hire
  /// screen, else the page's own name (today, queue, …).
  workersPage?: string;
}

/// Order matters. The explorer wins because ExplorerPane replaces the
/// editor pane wholesale in both of its mount sites, so its tabs are what
/// the user is looking at even when a conversation is still selected
/// underneath. Flow runs come next for the same reason (the Flows view
/// often leaves a conversation selected under the hood), then a worker's
/// desk, and a plain conversation last.
export function fileScopeKeyFor(input: FileScopeInput): string | null {
  if (input.explorerRootPath) return `explorer:${input.explorerRootPath}`;
  // A run is a run wherever it's opened from — the Flows tab or a
  // worker's own list. Its files belong to the run, not to whatever
  // conversation is selected underneath (which would carry them back
  // into a chat, where they'd resolve against the wrong repo).
  if (input.activeRunId && flowRunPaneIsOnScreen(input.detailMode)) {
    return `flow:${input.activeRunId}`;
  }
  // A worker's desk is its own place, the same way a conversation is. Its
  // files resolve against that worker's directory and it opens its own
  // report on arrival, so carrying the last worker's tabs across leaves you
  // reading the wrong worker's page under the new worker's name.
  if (input.detailMode === 'workers') {
    // `selectedWorkerId` outlives the desk — it is still set on Today — so
    // only the desk itself is that worker's place.
    if (input.workersPage === 'worker' && input.selectedWorkerId) return `worker:${input.selectedWorkerId}`;
    // Every other Workers page is a place of its own. Falling through to the
    // conversation selected underneath is how a report opened from Today
    // stayed up over the hire screen, the queue, and everything else.
    return `workers:${input.workersPage ?? 'today'}`;
  }
  if (input.detailMode === 'flows') return null;
  if (input.selectedConversationId) return `conv:${input.selectedConversationId}`;
  return null;
}

/// Keep the editor's tab scope in step with the view. Mounted once, at the
/// app root. The effect runs before paint, so switching conversations
/// doesn't flash the previous one's file.
export function useFileScope(): void {
  const detailMode = useStore((s) => s.detailMode);
  const selectedConversationId = useStore((s) => s.selectedConversationId);
  const explorerRootPath = useStore((s) => s.explorerRootPath);
  const activeRunId = useFlowsStore((s) => s.activeRunId);
  const selectedWorkerId = useWorkersStore((s) => s.selectedWorkerId);
  const workersPage = useWorkersStore((s) => (s.hire.open ? 'hire' : s.view));
  const switchFileScope = useStore((s) => s.switchFileScope);
  const key = fileScopeKeyFor({
    detailMode,
    selectedConversationId,
    explorerRootPath,
    activeRunId: activeRunId ?? null,
    selectedWorkerId,
    workersPage,
  });
  useEffect(() => {
    switchFileScope(key);
  }, [key, switchFileScope]);
}
