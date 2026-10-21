// Explorers popped out into windows of their own.
//
// The explorer is a folder's tree and editor; popping it out moves its tabs
// into a second window so code can sit on one screen and the conversation on
// another. The tabs travel with it — taken from the scope they were open in,
// and handed back to that same scope when the window closes — so the same file
// is never open for editing in two windows at once.

import { create } from 'zustand';
import type { PersistedScopeTabs } from '@shared/types';
import { hydrateFileTabs, useStore } from './store';
import { dropBuffer } from './fileBuffers';

type StoreState = ReturnType<typeof useStore.getState>;

/// The tabs open in one scope, live or parked, in the hand-off shape.
export function scopeTabsOf(s: StoreState, key: string): PersistedScopeTabs | null {
  if (key === s.fileScopeKey) {
    return s.tabs.length ? { paths: s.tabs.map((t) => t.path), activePath: s.openFilePath } : null;
  }
  const parked = s.fileTabsByScope[key];
  return parked?.tabs.length ? { paths: parked.tabs.map((t) => t.path), activePath: parked.activePath } : null;
}

/// State that puts `tabs` in a scope, live or parked. `null` empties it.
/// Tabs already there stay (a conversation may have opened files while its
/// editor was away); the incoming ones join them and the incoming active tab
/// comes to the front.
export function withScopeTabs(
  s: StoreState,
  key: string,
  tabs: PersistedScopeTabs | null,
): Partial<StoreState> {
  const existing = tabs ? scopeTabsOf(s, key) : null;
  const merged: PersistedScopeTabs | null = tabs
    ? {
        paths: [...(existing?.paths ?? []), ...tabs.paths.filter((p) => !existing?.paths.includes(p))],
        activePath: tabs.activePath ?? existing?.activePath ?? null,
      }
    : null;
  const scope = merged ? hydrateFileTabs({ [key]: merged })[key] : undefined;
  if (key === s.fileScopeKey) {
    const active = scope?.tabs.find((t) => t.path === scope.activePath) ?? null;
    return {
      tabs: scope?.tabs ?? [],
      openFilePath: active?.path ?? null,
      openFileHighlight: null,
      openFileMode: active?.mode ?? 'edit',
    };
  }
  const fileTabsByScope = { ...s.fileTabsByScope };
  if (scope) fileTabsByScope[key] = scope;
  else delete fileTabsByScope[key];
  return { fileTabsByScope };
}

interface ExplorerPopoutState {
  /// Popped-out roots → the tab scope their tabs came from, to go back to.
  /// Null when this window didn't do the popping (it reloaded since).
  out: Record<string, string | null>;
  init(): () => void;
  /// Move `root`'s explorer into its own window, taking the tabs open in
  /// `scope` (the explorer's own scope when not given).
  popOut(root: string, scope?: string | null): Promise<void>;
  show(root: string): void;
  popIn(root: string): void;
}

export const useExplorerPopoutStore = create<ExplorerPopoutState>((set, get) => ({
  out: {},

  init() {
    void window.overcli.invoke('explorer:list').then((roots) => {
      set((s) => ({ out: { ...Object.fromEntries(roots.map((r) => [r, null])), ...s.out } }));
    });
    return window.overcli.onMainEvent((e) => {
      if (e.type !== 'explorerPoppedOut') return;
      if (e.out) {
        if (!(e.root in get().out)) set((s) => ({ out: { ...s.out, [e.root]: null } }));
        return;
      }
      const scope = get().out[e.root] ?? `explorer:${e.root}`;
      set((s) => {
        const out = { ...s.out };
        delete out[e.root];
        return { out };
      });
      if (e.tabs?.paths.length) useStore.setState((s) => withScopeTabs(s, scope, e.tabs!));
    });
  },

  async popOut(root, scope) {
    const key = scope ?? `explorer:${root}`;
    const s = useStore.getState();
    const tabs = scopeTabsOf(s, key);
    // Unsaved text lives in this window's memory; it can't travel.
    const dirty = tabs?.paths.filter((p) => s.dirtyFiles[p]) ?? [];
    if (dirty.length && !window.confirm('Some open files have unsaved changes. Discard them and open in a new window?')) {
      return;
    }
    // Asked before the invoke: main announces the new window before it returns.
    const wasOut = root in get().out;
    const res = await window.overcli.invoke('explorer:popOut', { root, tabs: tabs ?? undefined });
    if (!res.ok) {
      window.alert(res.error);
      return;
    }
    // Focusing a window that was already out moves nothing.
    if (wasOut) return;
    for (const p of dirty) {
      s.clearFileDirty(p);
      dropBuffer(p);
    }
    useStore.setState((st) => withScopeTabs(st, key, null));
    set((st) => ({ out: { ...st.out, [root]: key } }));
  },

  show(root) {
    void window.overcli.invoke('explorer:popOut', { root });
  },

  popIn(root) {
    void window.overcli.invoke('explorer:popIn', { root });
  },
}));
