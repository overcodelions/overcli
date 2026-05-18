// UI-only slice of the renderer store. State that has no dependency on
// projects, workspaces, conversations, or runner events lives here so it
// can be reasoned about (and potentially split into its own Zustand
// store) without touching domain code.
//
// Composed into the main store via spread; consumers still go through
// `useStore((s) => s.openSheet)` etc., so call sites are unchanged.
//
// Future slices to extract from store.ts: a runners slice (events,
// isRunning, currentModel — the hot one), a settings slice (settings +
// capabilities), and a data slice (projects, workspaces, conversations
// + persistence). Doing them in stages keeps each PR reviewable.

import type { ActiveSheet, DetailMode, OpenFileHighlight } from './store';
import { defaultFileViewMode, type FileViewMode } from './filePreview';

type SetFn<T> = (
  partial: Partial<T> | ((s: T) => Partial<T>),
) => void;

export interface UiSliceState {
  detailMode: DetailMode;
  activeSheet: ActiveSheet | null;
  openFilePath: string | null;
  openFileHighlight: OpenFileHighlight | null;
  openFileMode: FileViewMode;
  /// Where the file editor renders. 'inline' is the long-standing
  /// slot to the right of the conversation pane. 'side' parks it to
  /// the right of the SubagentDrawer so subagent-initiated file
  /// opens don't displace the conversation. Set automatically by
  /// `openSideFile`; reset to 'inline' on the next inline `openFile`
  /// or when `closeFile` runs.
  fileEditorSide: 'inline' | 'side';
  explorerRootPath: string | null;
  sidebarVisible: boolean;
  showToolActivity: boolean;
  /// Parent Task tool_use id currently being inspected in the
  /// SubagentDrawer. `null` means the drawer is closed.
  subagentDrawerParentId: string | null;
  /// Subagent tool_use ids the user has dismissed from the drawer's
  /// tab strip, scoped per-conversation. Survives the drawer
  /// mount/unmount cycle so dismissing the last tab and then opening
  /// a fresh subagent doesn't resurrect the ones you just hid.
  /// Cleared per-conversation when the runner resets (full history
  /// reload) or when the user re-opens a dismissed id explicitly.
  dismissedSubagents: Record<string, string[]>;
}

export interface UiSliceActions {
  setDetailMode(mode: DetailMode): void;
  openSheet(sheet: ActiveSheet | null): void;
  openFile(path: string, highlight?: OpenFileHighlight, mode?: FileViewMode): void;
  /// Like openFile but flags the editor to render to the right of the
  /// SubagentDrawer. Used by the drawer's file-link wiring so a click
  /// inside the agent's transcript doesn't displace the conversation.
  openSideFile(path: string, highlight?: OpenFileHighlight, mode?: FileViewMode): void;
  setOpenFileMode(mode: FileViewMode): void;
  closeFile(): void;
  toggleSidebar(): void;
  toggleToolActivity(): void;
  openSubagentDrawer(parentToolUseId: string): void;
  closeSubagentDrawer(): void;
  /// Hide a subagent tab in the given conversation's drawer.
  dismissSubagent(conversationId: string, parentToolUseId: string): void;
  /// Clear the dismissed list for a conversation (used when a runner
  /// resets / reloads history so old hides don't persist forever).
  resetDismissedSubagents(conversationId: string): void;
}

export type UiSlice = UiSliceState & UiSliceActions;

export const uiSliceInitialState: UiSliceState = {
  detailMode: 'conversation',
  activeSheet: null,
  openFilePath: null,
  openFileHighlight: null,
  openFileMode: 'edit',
  fileEditorSide: 'inline',
  explorerRootPath: null,
  sidebarVisible: true,
  showToolActivity: false,
  subagentDrawerParentId: null,
  dismissedSubagents: {},
};

export function createUiSlice<T extends UiSlice>(set: SetFn<T>): UiSliceActions {
  return {
    setDetailMode(mode) {
      set({ detailMode: mode } as Partial<T>);
    },
    openSheet(sheet) {
      set({ activeSheet: sheet } as Partial<T>);
    },
    openFile(path, highlight, mode) {
      set({
        openFilePath: path,
        openFileHighlight: highlight ?? null,
        openFileMode: defaultFileViewMode(path, !!highlight, mode),
        fileEditorSide: 'inline',
      } as Partial<T>);
    },
    openSideFile(path, highlight, mode) {
      set({
        openFilePath: path,
        openFileHighlight: highlight ?? null,
        openFileMode: defaultFileViewMode(path, !!highlight, mode),
        fileEditorSide: 'side',
      } as Partial<T>);
    },
    setOpenFileMode(mode) {
      set({ openFileMode: mode } as Partial<T>);
    },
    closeFile() {
      set({
        openFilePath: null,
        openFileHighlight: null,
        openFileMode: 'edit',
        fileEditorSide: 'inline',
      } as Partial<T>);
    },
    toggleSidebar() {
      set(((s) => ({ sidebarVisible: !s.sidebarVisible })) as (s: T) => Partial<T>);
    },
    toggleToolActivity() {
      set(((s) => ({ showToolActivity: !s.showToolActivity })) as (s: T) => Partial<T>);
    },
    openSubagentDrawer(parentToolUseId) {
      // Clicking an inline card for a previously-dismissed subagent
      // should bring it back — the user explicitly asked for it.
      set(((s) => {
        const dismissedAll = s.dismissedSubagents ?? {};
        const next: Record<string, string[]> = {};
        let mutated = false;
        for (const [convId, ids] of Object.entries(dismissedAll)) {
          const kept = ids.filter((id) => id !== parentToolUseId);
          if (kept.length !== ids.length) mutated = true;
          next[convId] = kept;
        }
        return {
          subagentDrawerParentId: parentToolUseId,
          ...(mutated ? { dismissedSubagents: next } : {}),
        } as Partial<T>;
      }) as (s: T) => Partial<T>);
    },
    closeSubagentDrawer() {
      set({ subagentDrawerParentId: null } as Partial<T>);
    },
    dismissSubagent(conversationId, parentToolUseId) {
      set(((s) => {
        const prev = s.dismissedSubagents?.[conversationId] ?? [];
        if (prev.includes(parentToolUseId)) return {} as Partial<T>;
        return {
          dismissedSubagents: {
            ...(s.dismissedSubagents ?? {}),
            [conversationId]: [...prev, parentToolUseId],
          },
        } as Partial<T>;
      }) as (s: T) => Partial<T>);
    },
    resetDismissedSubagents(conversationId) {
      set(((s) => {
        const cur = s.dismissedSubagents ?? {};
        if (!cur[conversationId]) return {} as Partial<T>;
        const { [conversationId]: _drop, ...rest } = cur;
        return { dismissedSubagents: rest } as Partial<T>;
      }) as (s: T) => Partial<T>);
    },
  };
}
