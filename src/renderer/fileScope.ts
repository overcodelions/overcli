// Which set of editor tabs is on screen.
//
// The file editor mounts in three places — beside a conversation, beside a
// flow run, and inside the explorer — and each of those should remember
// its own open files. Rather than have every navigation action clear the
// editor (which is what it used to do, in five different places), we derive
// a scope key from the view and let `switchFileScope` save the tabs we're
// leaving and restore the ones we're arriving at.

import { useEffect } from 'react';
import { useStore } from './store';
import { useFlowsStore } from './flowsStore';

export interface FileScopeInput {
  detailMode: string;
  selectedConversationId: string | null;
  explorerRootPath: string | null;
  activeRunId: string | null;
}

/// Order matters. The explorer wins because ExplorerPane replaces the
/// editor pane wholesale in both of its mount sites, so its tabs are what
/// the user is looking at even when a conversation is still selected
/// underneath. Flow runs come next for the same reason (the Flows view
/// often leaves a conversation selected under the hood), and a plain
/// conversation last.
export function fileScopeKeyFor(input: FileScopeInput): string | null {
  if (input.explorerRootPath) return `explorer:${input.explorerRootPath}`;
  if (input.detailMode === 'flows') {
    return input.activeRunId ? `flow:${input.activeRunId}` : null;
  }
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
  const switchFileScope = useStore((s) => s.switchFileScope);
  const key = fileScopeKeyFor({
    detailMode,
    selectedConversationId,
    explorerRootPath,
    activeRunId: activeRunId ?? null,
  });
  useEffect(() => {
    switchFileScope(key);
  }, [key, switchFileScope]);
}
