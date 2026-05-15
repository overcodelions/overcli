import { describe, expect, it } from 'vitest';
import { createUiSlice, uiSliceInitialState, type UiSlice } from './uiSlice';

function makeStub(): { state: UiSlice; slice: ReturnType<typeof createUiSlice<UiSlice>> } {
  const state = { ...uiSliceInitialState } as UiSlice;
  const set = (partial: Partial<UiSlice> | ((s: UiSlice) => Partial<UiSlice>)) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    Object.assign(state, patch);
  };
  const slice = createUiSlice<UiSlice>(set);
  Object.assign(state, slice);
  return { state, slice };
}

describe('uiSliceInitialState', () => {
  it('starts with the conversation pane visible and no sheet', () => {
    expect(uiSliceInitialState.detailMode).toBe('conversation');
    expect(uiSliceInitialState.activeSheet).toBeNull();
    expect(uiSliceInitialState.sidebarVisible).toBe(true);
    expect(uiSliceInitialState.openFilePath).toBeNull();
    expect(uiSliceInitialState.showToolActivity).toBe(false);
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
});
