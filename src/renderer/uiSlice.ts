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
import { dropBuffer } from './fileBuffers';

type SetFn<T> = (
  partial: Partial<T> | ((s: T) => Partial<T>),
) => void;

/// One open file in the editor's tab strip.
export interface FileTab {
  path: string;
  mode: FileViewMode;
  /// Line range to scroll to and tint, when the tab was opened from a
  /// `path:line` link. Per-tab so coming back to a tab returns you to the
  /// line you jumped to rather than the top of the file.
  highlight: OpenFileHighlight | null;
}

/// One scope's saved tabs. A scope is a conversation, a flow run, or an
/// explorer root — see `fileScopeKeyFor`.
export interface ScopeTabs {
  tabs: FileTab[];
  activePath: string | null;
}

/// Tabs per scope. Enough for a real editing session, low enough that the
/// strip stays readable and an agent opening file after file can't grow
/// the persisted state without bound.
export const MAX_TABS_PER_SCOPE = 12;

/// Scopes kept in memory. Each is at most 12 short strings, so this is a
/// backstop against a very long session rather than a tight budget. Main
/// applies its own cap when persisting.
export const MAX_TAB_SCOPES = 100;

export interface UiSliceState {
  detailMode: DetailMode;
  activeSheet: ActiveSheet | null;
  /// The active tab's path, mode and highlight. Kept as three top-level
  /// fields (rather than reading through `tabs`) because every consumer in
  /// the app already subscribes to them individually, and because the
  /// editor mutates the active tab's mode far more often than the tab list
  /// changes. `commitActiveTab` folds them back into `tabs` whenever the
  /// active tab changes.
  openFilePath: string | null;
  openFileHighlight: OpenFileHighlight | null;
  openFileMode: FileViewMode;
  /// Open tabs for the scope currently on screen, left to right.
  tabs: FileTab[];
  /// Which scope `tabs` belongs to. Owned by `switchFileScope`, driven by
  /// the `useFileScope` hook.
  fileScopeKey: string | null;
  /// Saved tabs for every scope EXCEPT the live one — the live scope's
  /// tabs are flushed in here when it's switched away from. Restored from
  /// disk on launch, so files you had open in a conversation come back
  /// when you return to it.
  fileTabsByScope: Record<string, ScopeTabs>;
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
  /// Conversation that owns the active subagent. Set when the inline
  /// SubagentCard opens the drawer so the drawer can subscribe to the
  /// right runner — without this, opening a drawer from inside a flow
  /// step would fall back to `selectedConversationId` (null in flows
  /// mode) and the drawer would render against the wrong events.
  subagentDrawerConversationId: string | null;
  /// Paths with unsaved edits in the file editor. The text itself lives
  /// in ./fileBuffers.ts (out of the store, so keystrokes don't churn
  /// it); this is the reactive part — the tab strip's modified dot and
  /// the header's Save button read it. Set membership only; the value is
  /// always `true`.
  dirtyFiles: Record<string, true>;
  /// Subagent tool_use ids the user has dismissed from the drawer's
  /// tab strip, scoped per-conversation. Survives the drawer
  /// mount/unmount cycle so dismissing the last tab and then opening
  /// a fresh subagent doesn't resurrect the ones you just hid.
  /// Cleared per-conversation when the runner resets (full history
  /// reload) or when the user re-opens a dismissed id explicitly.
  dismissedSubagents: Record<string, string[]>;
  /// Whether release notes are waiting to be read — main decides (see
  /// whatsNew.ts), App seeds it on launch, and the title bar's About
  /// button wears a dot while it's true. Cleared when the What's New
  /// sheet is opened.
  whatsNewUnseen: boolean;
}

export interface UiSliceActions {
  setDetailMode(mode: DetailMode): void;
  openSheet(sheet: ActiveSheet | null): void;
  /// Open `path` in the editor, or focus its tab if it's already open.
  openFile(path: string, highlight?: OpenFileHighlight, mode?: FileViewMode): void;
  /// Like openFile but flags the editor to render to the right of the
  /// SubagentDrawer. Used by the drawer's file-link wiring so a click
  /// inside the agent's transcript doesn't displace the conversation.
  openSideFile(path: string, highlight?: OpenFileHighlight, mode?: FileViewMode): void;
  setOpenFileMode(mode: FileViewMode): void;
  /// Focus an already-open tab. No-op for a path that isn't open.
  selectTab(path: string): void;
  /// Move `delta` tabs left or right of the active one, wrapping.
  selectAdjacentTab(delta: number): void;
  /// Point an open tab at a different path for the same file. Callers open
  /// paths as they receive them — a ChangesBar row hands over a
  /// repo-relative one — and only learn the absolute path once
  /// `fs:fileInfo` has resolved it. Re-opening with the resolved path would
  /// leave two tabs on one file, so the tab is retargeted in place instead.
  retargetTab(from: string, to: string): void;
  /// Close one tab, discarding its unsaved buffer. Callers confirm with
  /// the user first when the tab is dirty (the tab strip does).
  closeTab(path: string): void;
  /// Close the editor pane — every tab in the current scope. Buffers for
  /// dirty files are deliberately kept, so reopening the file restores the
  /// unsaved work instead of silently losing it.
  closeFile(): void;
  /// Point the editor at a different scope: the live tabs are saved under
  /// the outgoing key and the incoming scope's tabs are restored. Called
  /// by `useFileScope` whenever the user changes conversation, flow run or
  /// explorer root.
  switchFileScope(key: string | null): void;
  toggleSidebar(): void;
  toggleToolActivity(): void;
  setWhatsNewUnseen(unseen: boolean): void;
  markFileDirty(path: string): void;
  clearFileDirty(path: string): void;
  openSubagentDrawer(parentToolUseId: string, conversationId?: string): void;
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
  tabs: [],
  fileScopeKey: null,
  fileTabsByScope: {},
  fileEditorSide: 'inline',
  explorerRootPath: null,
  sidebarVisible: true,
  showToolActivity: false,
  subagentDrawerParentId: null,
  subagentDrawerConversationId: null,
  dirtyFiles: {},
  dismissedSubagents: {},
  whatsNewUnseen: false,
};

/// The subset of state the tab helpers below read. Declared structurally
/// so they can be unit-tested without building a whole store.
export interface TabState {
  tabs: FileTab[];
  openFilePath: string | null;
  openFileHighlight: OpenFileHighlight | null;
  openFileMode: FileViewMode;
  dirtyFiles: Record<string, true>;
}

type TabPatch = Partial<Pick<UiSliceState, 'tabs' | 'openFilePath' | 'openFileHighlight' | 'openFileMode'>>;

/// Fold the live active-tab fields back into the tab list. The active
/// tab's mode and highlight live in `openFileMode`/`openFileHighlight`
/// while it's on screen, so anything that changes *which* tab is active
/// has to write them back first or the user's Diff/Preview choice is lost
/// the moment they switch away.
export function commitActiveTab(s: TabState): FileTab[] {
  if (!s.openFilePath) return s.tabs;
  let changed = false;
  const next = s.tabs.map((t) => {
    if (t.path !== s.openFilePath) return t;
    if (t.mode === s.openFileMode && t.highlight === s.openFileHighlight) return t;
    changed = true;
    return { ...t, mode: s.openFileMode, highlight: s.openFileHighlight };
  });
  return changed ? next : s.tabs;
}

/// Make room for one more tab by dropping the leftmost (oldest) tab that
/// isn't the one just opened and has no unsaved edits. If every candidate
/// is dirty we go over the cap rather than throw away someone's work.
function evictForRoom(tabs: FileTab[], keepPath: string, dirtyFiles: Record<string, true>): FileTab[] {
  const idx = tabs.findIndex((t) => t.path !== keepPath && !dirtyFiles[t.path]);
  if (idx === -1) return tabs;
  dropBuffer(tabs[idx].path);
  return [...tabs.slice(0, idx), ...tabs.slice(idx + 1)];
}

/// Open-or-focus `tab`. A new tab lands immediately right of the active
/// one, so opening a chain of files (go-to-definition, a stack trace)
/// reads left to right in the order you walked it.
export function focusTabState(s: TabState, tab: FileTab): TabPatch {
  const committed = commitActiveTab(s);
  const existing = committed.findIndex((t) => t.path === tab.path);
  let tabs: FileTab[];
  if (existing >= 0) {
    tabs = committed.slice();
    tabs[existing] = tab;
  } else {
    const activeIdx = s.openFilePath ? committed.findIndex((t) => t.path === s.openFilePath) : -1;
    const at = activeIdx >= 0 ? activeIdx + 1 : committed.length;
    tabs = [...committed.slice(0, at), tab, ...committed.slice(at)];
    if (tabs.length > MAX_TABS_PER_SCOPE) tabs = evictForRoom(tabs, tab.path, s.dirtyFiles);
  }
  return {
    tabs,
    openFilePath: tab.path,
    openFileHighlight: tab.highlight,
    openFileMode: tab.mode,
  };
}

/// Remove one tab. Closing the active tab moves to the tab that slid into
/// its slot, else the one to its left, else empties the pane.
export function closeTabState(s: TabState, path: string): TabPatch {
  const idx = s.tabs.findIndex((t) => t.path === path);
  if (idx === -1) return {};
  const tabs = commitActiveTab(s).filter((t) => t.path !== path);
  if (s.openFilePath !== path) return { tabs };
  const next = tabs[idx] ?? tabs[idx - 1] ?? null;
  return {
    tabs,
    openFilePath: next?.path ?? null,
    openFileHighlight: next?.highlight ?? null,
    openFileMode: next?.mode ?? 'edit',
  };
}

/// Drop the least-recently-used scopes once the map outgrows the cap.
/// Object key order is insertion order and `switchFileScope` re-inserts
/// the scope it saves, so the front of the list is the coldest.
function pruneScopes(byScope: Record<string, ScopeTabs>): Record<string, ScopeTabs> {
  const keys = Object.keys(byScope);
  if (keys.length <= MAX_TAB_SCOPES) return byScope;
  const next = { ...byScope };
  for (const key of keys.slice(0, keys.length - MAX_TAB_SCOPES)) delete next[key];
  return next;
}

function newTab(
  path: string,
  highlight: OpenFileHighlight | undefined,
  mode: FileViewMode | undefined,
): FileTab {
  return {
    path,
    mode: defaultFileViewMode(path, !!highlight, mode),
    highlight: highlight ?? null,
  };
}

export function createUiSlice<T extends UiSlice>(set: SetFn<T>, get: () => T): UiSliceActions {
  return {
    setDetailMode(mode) {
      set({ detailMode: mode } as Partial<T>);
    },
    openSheet(sheet) {
      set({ activeSheet: sheet } as Partial<T>);
    },
    openFile(path, highlight, mode) {
      set(((s) => ({
        ...focusTabState(s, newTab(path, highlight, mode)),
        fileEditorSide: 'inline',
      })) as (s: T) => Partial<T>);
    },
    openSideFile(path, highlight, mode) {
      set(((s) => ({
        ...focusTabState(s, newTab(path, highlight, mode)),
        fileEditorSide: 'side',
      })) as (s: T) => Partial<T>);
    },
    setOpenFileMode(mode) {
      // No need to touch `tabs`: commitActiveTab folds the live mode back
      // into the active tab whenever we leave it.
      set({ openFileMode: mode } as Partial<T>);
    },
    selectTab(path) {
      set(((s) => {
        if (s.openFilePath === path) return {} as Partial<T>;
        const tab = s.tabs.find((t) => t.path === path);
        if (!tab) return {} as Partial<T>;
        return {
          tabs: commitActiveTab(s),
          openFilePath: tab.path,
          openFileHighlight: tab.highlight,
          openFileMode: tab.mode,
        } as Partial<T>;
      }) as (s: T) => Partial<T>);
    },
    selectAdjacentTab(delta) {
      const s = get();
      if (s.tabs.length < 2) return;
      const idx = s.tabs.findIndex((t) => t.path === s.openFilePath);
      if (idx === -1) return;
      // Wrap, so ⌥⌘→ off the right edge lands back on the first tab.
      const next = s.tabs[(idx + delta + s.tabs.length) % s.tabs.length];
      if (next) get().selectTab(next.path);
    },
    retargetTab(from, to) {
      set(((s) => {
        if (from === to) return {} as Partial<T>;
        const idx = s.tabs.findIndex((t) => t.path === from);
        if (idx === -1) return {} as Partial<T>;
        const tabs = s.tabs.slice();
        // Already open under the resolved path: drop the duplicate rather
        // than end up with the same file twice.
        if (tabs.some((t) => t.path === to)) tabs.splice(idx, 1);
        else tabs[idx] = { ...tabs[idx], path: to };
        return {
          tabs,
          ...(s.openFilePath === from ? { openFilePath: to } : {}),
        } as Partial<T>;
      }) as (s: T) => Partial<T>);
    },
    closeTab(path) {
      dropBuffer(path);
      set(((s) => {
        const patch = closeTabState(s, path);
        if (!patch.tabs) return {} as Partial<T>;
        const { [path]: _drop, ...dirtyFiles } = s.dirtyFiles;
        return {
          ...patch,
          dirtyFiles,
          // Nothing left to render — put the editor back in its default
          // slot so the next open isn't stuck beside the subagent drawer.
          ...(patch.openFilePath ? {} : { fileEditorSide: 'inline' as const }),
        } as Partial<T>;
      }) as (s: T) => Partial<T>);
    },
    closeFile() {
      const s = get();
      // Keep buffers for dirty files: closing the pane is not "discard my
      // edits", and reopening the file should bring them back.
      for (const tab of s.tabs) if (!s.dirtyFiles[tab.path]) dropBuffer(tab.path);
      set({
        tabs: [] as FileTab[],
        openFilePath: null,
        openFileHighlight: null,
        openFileMode: 'edit',
        fileEditorSide: 'inline',
      } as Partial<T>);
    },
    switchFileScope(key) {
      set(((s) => {
        if (s.fileScopeKey === key) return {} as Partial<T>;
        const outgoing = commitActiveTab(s);
        let fileTabsByScope = s.fileTabsByScope;
        if (s.fileScopeKey) {
          fileTabsByScope = { ...fileTabsByScope };
          // Re-insert (delete first) so key order stays LRU for pruning.
          delete fileTabsByScope[s.fileScopeKey];
          if (outgoing.length) {
            fileTabsByScope[s.fileScopeKey] = { tabs: outgoing, activePath: s.openFilePath };
          }
          fileTabsByScope = pruneScopes(fileTabsByScope);
        }
        const restored = key ? fileTabsByScope[key] : undefined;
        const tabs = restored?.tabs ?? [];
        const active = tabs.find((t) => t.path === restored?.activePath) ?? tabs[0] ?? null;
        return {
          fileScopeKey: key,
          fileTabsByScope,
          tabs,
          openFilePath: active?.path ?? null,
          openFileHighlight: active?.highlight ?? null,
          openFileMode: active?.mode ?? 'edit',
          fileEditorSide: 'inline',
        } as Partial<T>;
      }) as (s: T) => Partial<T>);
    },
    toggleSidebar() {
      set(((s) => ({ sidebarVisible: !s.sidebarVisible })) as (s: T) => Partial<T>);
    },
    toggleToolActivity() {
      set(((s) => ({ showToolActivity: !s.showToolActivity })) as (s: T) => Partial<T>);
    },
    setWhatsNewUnseen(unseen) {
      set(((s) => (s.whatsNewUnseen === unseen ? {} : { whatsNewUnseen: unseen })) as (
        s: T,
      ) => Partial<T>);
    },
    markFileDirty(path) {
      set(((s) => (s.dirtyFiles[path] ? {} : { dirtyFiles: { ...s.dirtyFiles, [path]: true } })) as (
        s: T,
      ) => Partial<T>);
    },
    clearFileDirty(path) {
      set(((s) => {
        if (!s.dirtyFiles[path]) return {} as Partial<T>;
        const { [path]: _drop, ...rest } = s.dirtyFiles;
        return { dirtyFiles: rest } as Partial<T>;
      }) as (s: T) => Partial<T>);
    },
    openSubagentDrawer(parentToolUseId, conversationId) {
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
          subagentDrawerConversationId: conversationId ?? null,
          ...(mutated ? { dismissedSubagents: next } : {}),
        } as Partial<T>;
      }) as (s: T) => Partial<T>);
    },
    closeSubagentDrawer() {
      set({
        subagentDrawerParentId: null,
        subagentDrawerConversationId: null,
      } as Partial<T>);
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
