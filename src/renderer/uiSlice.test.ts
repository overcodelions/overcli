import { beforeEach, describe, expect, it } from 'vitest';
import {
  createUiSlice,
  uiSliceInitialState,
  MAX_TABS_PER_SCOPE,
  type UiSlice,
} from './uiSlice';
import { bufferCount, clearBuffers, readBuffer, stashBuffer } from './fileBuffers';

function makeStub(): { state: UiSlice; slice: ReturnType<typeof createUiSlice<UiSlice>> } {
  const state = { ...uiSliceInitialState } as UiSlice;
  const set = (partial: Partial<UiSlice> | ((s: UiSlice) => Partial<UiSlice>)) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    Object.assign(state, patch);
  };
  const slice = createUiSlice<UiSlice>(set, () => state);
  Object.assign(state, slice);
  return { state, slice };
}

beforeEach(() => {
  clearBuffers();
});

describe('uiSliceInitialState', () => {
  it('starts with the conversation pane visible and no sheet', () => {
    expect(uiSliceInitialState.detailMode).toBe('conversation');
    expect(uiSliceInitialState.activeSheet).toBeNull();
    expect(uiSliceInitialState.sidebarVisible).toBe(true);
    expect(uiSliceInitialState.openFilePath).toBeNull();
    expect(uiSliceInitialState.showToolActivity).toBe(false);
    expect(uiSliceInitialState.subagentDrawerParentId).toBeNull();
  });
});

describe('createUiSlice', () => {
  it('openSheet sets the active sheet', () => {
    const { state, slice } = makeStub();
    slice.openSheet({ type: 'settings' });
    expect(state.activeSheet).toEqual({ type: 'settings' });
    slice.openSheet(null);
    expect(state.activeSheet).toBeNull();
  });

  it('setDetailMode swaps the pane', () => {
    const { state, slice } = makeStub();
    slice.setDetailMode('stats');
    expect(state.detailMode).toBe('stats');
  });

  it('toggleSidebar flips visibility', () => {
    const { state, slice } = makeStub();
    expect(state.sidebarVisible).toBe(true);
    slice.toggleSidebar();
    expect(state.sidebarVisible).toBe(false);
    slice.toggleSidebar();
    expect(state.sidebarVisible).toBe(true);
  });

  it('toggleToolActivity flips state', () => {
    const { state, slice } = makeStub();
    expect(state.showToolActivity).toBe(false);
    slice.toggleToolActivity();
    expect(state.showToolActivity).toBe(true);
  });

  it('openFile sets path and clears highlight when not provided', () => {
    const { state, slice } = makeStub();
    slice.openFile('/repo/foo.ts');
    expect(state.openFilePath).toBe('/repo/foo.ts');
    expect(state.openFileHighlight).toBeNull();
  });

  it('openFile records highlight when provided', () => {
    const { state, slice } = makeStub();
    slice.openFile('/repo/foo.ts', { startLine: 10, endLine: 20, requestId: 'r1' });
    expect(state.openFileHighlight).toEqual({ startLine: 10, endLine: 20, requestId: 'r1' });
  });

  it('closeFile clears all file editor state', () => {
    const { state, slice } = makeStub();
    slice.openFile('/x', { startLine: 1, endLine: 2, requestId: 'r' });
    slice.closeFile();
    expect(state.openFilePath).toBeNull();
    expect(state.openFileHighlight).toBeNull();
    expect(state.openFileMode).toBe('edit');
  });

  it('setOpenFileMode updates the view mode', () => {
    const { state, slice } = makeStub();
    slice.setOpenFileMode('preview');
    expect(state.openFileMode).toBe('preview');
  });

  it('openSubagentDrawer / closeSubagentDrawer toggle the right-drawer target', () => {
    const { state, slice } = makeStub();
    expect(state.subagentDrawerParentId).toBeNull();
    expect(state.subagentDrawerConversationId).toBeNull();
    slice.openSubagentDrawer('toolu_abc');
    expect(state.subagentDrawerParentId).toBe('toolu_abc');
    expect(state.subagentDrawerConversationId).toBeNull();
    // Reopening with a different parent id switches the focus rather than stacking.
    slice.openSubagentDrawer('toolu_def');
    expect(state.subagentDrawerParentId).toBe('toolu_def');
    slice.closeSubagentDrawer();
    expect(state.subagentDrawerParentId).toBeNull();
    expect(state.subagentDrawerConversationId).toBeNull();
  });

  it('openSubagentDrawer records the conversation id when provided', () => {
    const { state, slice } = makeStub();
    slice.openSubagentDrawer('toolu_abc', 'conv_xyz');
    expect(state.subagentDrawerParentId).toBe('toolu_abc');
    expect(state.subagentDrawerConversationId).toBe('conv_xyz');
    slice.closeSubagentDrawer();
    expect(state.subagentDrawerConversationId).toBeNull();
  });
});

describe('file editor tabs', () => {
  it('opens each new file as its own tab, right of the active one', () => {
    const { state, slice } = makeStub();
    slice.openFile('/repo/a.ts');
    slice.openFile('/repo/c.ts');
    // Go back to the first tab, then open from there: the new tab belongs
    // next to where we were, not at the end.
    slice.selectTab('/repo/a.ts');
    slice.openFile('/repo/b.ts');
    expect(state.tabs.map((t) => t.path)).toEqual(['/repo/a.ts', '/repo/b.ts', '/repo/c.ts']);
    expect(state.openFilePath).toBe('/repo/b.ts');
  });

  it('focuses the existing tab instead of duplicating it', () => {
    const { state, slice } = makeStub();
    slice.openFile('/repo/a.ts');
    slice.openFile('/repo/b.ts');
    slice.openFile('/repo/a.ts', { startLine: 12, endLine: 12, requestId: 'r1' });
    expect(state.tabs).toHaveLength(2);
    expect(state.openFilePath).toBe('/repo/a.ts');
    expect(state.openFileHighlight).toEqual({ startLine: 12, endLine: 12, requestId: 'r1' });
  });

  it('remembers each tab\'s view mode across a switch', () => {
    const { state, slice } = makeStub();
    slice.openFile('/repo/a.ts');
    slice.setOpenFileMode('diff');
    slice.openFile('/repo/b.ts');
    expect(state.openFileMode).toBe('edit');
    slice.selectTab('/repo/a.ts');
    expect(state.openFileMode).toBe('diff');
  });

  it('closing the active tab falls to its right neighbour, then its left', () => {
    const { state, slice } = makeStub();
    slice.openFile('/repo/a.ts');
    slice.openFile('/repo/b.ts');
    slice.openFile('/repo/c.ts');
    slice.selectTab('/repo/b.ts');
    slice.closeTab('/repo/b.ts');
    expect(state.openFilePath).toBe('/repo/c.ts');
    slice.closeTab('/repo/c.ts');
    expect(state.openFilePath).toBe('/repo/a.ts');
    slice.closeTab('/repo/a.ts');
    expect(state.openFilePath).toBeNull();
    expect(state.tabs).toEqual([]);
  });

  it('closing an inactive tab leaves the active one in front', () => {
    const { state, slice } = makeStub();
    slice.openFile('/repo/a.ts');
    slice.openFile('/repo/b.ts');
    slice.closeTab('/repo/a.ts');
    expect(state.openFilePath).toBe('/repo/b.ts');
    expect(state.tabs.map((t) => t.path)).toEqual(['/repo/b.ts']);
  });

  it('closing a tab drops its unsaved buffer and dirty flag', () => {
    const { state, slice } = makeStub();
    slice.openFile('/repo/a.ts');
    stashBuffer('/repo/a.ts', 'work in progress');
    slice.markFileDirty('/repo/a.ts');
    slice.closeTab('/repo/a.ts');
    expect(state.dirtyFiles['/repo/a.ts']).toBeUndefined();
    expect(readBuffer('/repo/a.ts')).toBeUndefined();
  });

  it('closing the pane keeps dirty buffers so reopening restores the work', () => {
    const { slice } = makeStub();
    slice.openFile('/repo/a.ts');
    slice.openFile('/repo/clean.ts');
    stashBuffer('/repo/a.ts', 'work in progress');
    stashBuffer('/repo/clean.ts', 'saved already');
    slice.markFileDirty('/repo/a.ts');
    slice.closeFile();
    expect(readBuffer('/repo/a.ts')).toBe('work in progress');
    expect(readBuffer('/repo/clean.ts')).toBeUndefined();
  });

  it('caps tabs per scope, evicting the oldest clean one', () => {
    const { state, slice } = makeStub();
    for (let i = 0; i < MAX_TABS_PER_SCOPE; i += 1) slice.openFile(`/repo/f${i}.ts`);
    expect(state.tabs).toHaveLength(MAX_TABS_PER_SCOPE);
    slice.openFile('/repo/one-more.ts');
    expect(state.tabs).toHaveLength(MAX_TABS_PER_SCOPE);
    expect(state.tabs.map((t) => t.path)).not.toContain('/repo/f0.ts');
    expect(state.tabs.map((t) => t.path)).toContain('/repo/one-more.ts');
  });

  it('never evicts a tab with unsaved changes', () => {
    const { state, slice } = makeStub();
    for (let i = 0; i < MAX_TABS_PER_SCOPE; i += 1) {
      slice.openFile(`/repo/f${i}.ts`);
      slice.markFileDirty(`/repo/f${i}.ts`);
    }
    slice.openFile('/repo/one-more.ts');
    // Every candidate is dirty, so we go over the cap rather than discard
    // someone's work.
    expect(state.tabs).toHaveLength(MAX_TABS_PER_SCOPE + 1);
    expect(state.tabs.map((t) => t.path)).toContain('/repo/f0.ts');
  });

  it('cycles tabs with wraparound', () => {
    const { state, slice } = makeStub();
    slice.openFile('/repo/a.ts');
    slice.openFile('/repo/b.ts');
    slice.selectAdjacentTab(1);
    expect(state.openFilePath).toBe('/repo/a.ts');
    slice.selectAdjacentTab(-1);
    expect(state.openFilePath).toBe('/repo/b.ts');
  });

  it('keeps buffer eviction and dirty flags honest', () => {
    // stashBuffer reports what it evicted so the caller can clear the flag;
    // a dot with no buffer behind it would show a file as modified while
    // the editor renders disk content.
    const { slice } = makeStub();
    slice.openFile('/repo/a.ts');
    for (let i = 0; i < 40; i += 1) stashBuffer(`/repo/f${i}.ts`, 'x');
    expect(bufferCount()).toBeLessThanOrEqual(32);
    const evicted = stashBuffer('/repo/last.ts', 'x');
    expect(evicted.length).toBeGreaterThan(0);
  });
});

describe('tab scopes', () => {
  it('parks the outgoing scope\'s tabs and restores the incoming ones', () => {
    const { state, slice } = makeStub();
    slice.switchFileScope('conv:1');
    slice.openFile('/repo/a.ts');
    slice.openFile('/repo/b.ts');

    slice.switchFileScope('conv:2');
    expect(state.tabs).toEqual([]);
    expect(state.openFilePath).toBeNull();
    slice.openFile('/repo/other.ts');

    slice.switchFileScope('conv:1');
    expect(state.tabs.map((t) => t.path)).toEqual(['/repo/a.ts', '/repo/b.ts']);
    expect(state.openFilePath).toBe('/repo/b.ts');

    slice.switchFileScope('conv:2');
    expect(state.tabs.map((t) => t.path)).toEqual(['/repo/other.ts']);
  });

  it('drops a scope from the map once its last tab closes', () => {
    const { state, slice } = makeStub();
    slice.switchFileScope('conv:1');
    slice.openFile('/repo/a.ts');
    slice.closeTab('/repo/a.ts');
    slice.switchFileScope('conv:2');
    expect(state.fileTabsByScope['conv:1']).toBeUndefined();
  });

  it('is a no-op when the scope key has not changed', () => {
    const { state, slice } = makeStub();
    slice.switchFileScope('conv:1');
    slice.openFile('/repo/a.ts');
    slice.switchFileScope('conv:1');
    expect(state.openFilePath).toBe('/repo/a.ts');
  });
});

describe('remembered view mode per extension', () => {
  it('opens markdown and components rendered without being asked', () => {
    const { state, slice } = makeStub();
    slice.openFile('/repo/README.md');
    expect(state.openFileMode).toBe('preview');

    slice.openFile('/repo/src/Button.tsx');
    expect(state.openFileMode).toBe('preview');

    slice.openFile('/repo/src/main.ts');
    expect(state.openFileMode).toBe('edit');
  });

  it('switching to File sticks for that extension', () => {
    const { state, slice } = makeStub();
    slice.openFile('/repo/README.md');
    slice.setOpenFileMode('edit');
    expect(state.fileViewModeByExt.md).toBe('edit');

    slice.openFile('/repo/docs/GUIDE.md');
    expect(state.openFileMode).toBe('edit');
  });

  it('keeps the memory per extension rather than across all types', () => {
    const { state, slice } = makeStub();
    slice.openFile('/repo/README.md');
    slice.setOpenFileMode('edit');

    // .tsx is untouched by the .md preference and still renders.
    slice.openFile('/repo/src/Button.tsx');
    expect(state.openFileMode).toBe('preview');
    expect(state.fileViewModeByExt).toEqual({ md: 'edit' });
  });

  it('lets a preview be restored after switching to File', () => {
    const { state, slice } = makeStub();
    slice.openFile('/repo/README.md');
    slice.setOpenFileMode('edit');
    slice.setOpenFileMode('preview');

    slice.openFile('/repo/docs/GUIDE.md');
    expect(state.openFileMode).toBe('preview');
  });

  it('does not remember diff', () => {
    const { state, slice } = makeStub();
    slice.openFile('/repo/README.md');
    slice.setOpenFileMode('diff');
    expect(state.fileViewModeByExt.md).toBeUndefined();

    // Falls back to the render-first default rather than to Diff.
    slice.openFile('/repo/docs/GUIDE.md');
    expect(state.openFileMode).toBe('preview');
  });

  it('does not remember a mode for a type that cannot be previewed', () => {
    const { state, slice } = makeStub();
    slice.openFile('/repo/src/main.ts');
    slice.setOpenFileMode('preview');
    expect(state.fileViewModeByExt).toEqual({});
  });

  it('lets a line jump outrank the render-first default', () => {
    const { state, slice } = makeStub();
    // Jumping to README.md:42 wants the line, not the rendered page.
    slice.openFile('/repo/docs/GUIDE.md', { startLine: 42, endLine: 42, requestId: 'r1' });
    expect(state.openFileMode).toBe('edit');
  });

  it('lets an explicitly requested mode outrank both', () => {
    const { state, slice } = makeStub();
    slice.openFile('/repo/docs/GUIDE.md', undefined, 'edit');
    expect(state.openFileMode).toBe('edit');
  });

  it('renders side-opened files too', () => {
    const { state, slice } = makeStub();
    slice.openSideFile('/repo/docs/GUIDE.md');
    expect(state.openFileMode).toBe('preview');
    expect(state.fileEditorSide).toBe('side');
  });
});
