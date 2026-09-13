import { describe, expect, it } from 'vitest';
import { createUiSlice } from './uiSlice';
import type { DetailMode } from './store';

/// Which sidebar a tab reads. The rule App applies at render time, restated
/// here so it can be tested without a window.
function showSidebar(state: {
  detailMode: DetailMode;
  sidebarVisible: boolean;
  servicesSidebarVisible: boolean;
}): boolean {
  return state.detailMode === 'services' ? state.servicesSidebarVisible : state.sidebarVisible;
}

function harness(initial: {
  detailMode: DetailMode;
  sidebarVisible?: boolean;
  servicesSidebarVisible?: boolean;
}) {
  let state = {
    sidebarVisible: true,
    servicesSidebarVisible: false,
    ...initial,
  };
  const set = (patch: unknown) => {
    const next = typeof patch === 'function' ? (patch as (s: typeof state) => object)(state) : patch;
    state = { ...state, ...(next as object) };
  };
  const actions = createUiSlice(set as never, (() => state) as never);
  return { actions, read: () => state };
}

describe('the sidebar a tab shows', () => {
  it('opens Services without the conversations sidebar', () => {
    // The service list IS what you move between there; a second navigation
    // beside it takes a third of the width from the output.
    const { actions, read } = harness({ detailMode: 'conversation' });
    actions.setDetailMode('services');
    expect(showSidebar(read())).toBe(false);
  });

  it('leaves Chat exactly as it was', () => {
    // The bug this replaced: hiding shared chrome as a side effect of entering
    // a tab meant every path OUT of it had to remember to undo that, and the
    // history arrows — which write state directly — never would.
    const { actions, read } = harness({ detailMode: 'conversation' });
    actions.setDetailMode('services');
    actions.setDetailMode('conversation');
    expect(showSidebar(read())).toBe(true);
  });

  it('cannot leak however the tab was left', () => {
    // Whatever route changes detailMode — a tab, a back arrow, a restored
    // session — the answer is computed from the tab, never stored.
    const { read } = harness({ detailMode: 'services' });
    expect(showSidebar(read())).toBe(false);
    expect(showSidebar({ ...read(), detailMode: 'flows' })).toBe(true);
  });

  it('toggling inside Services changes only Services', () => {
    const { actions, read } = harness({ detailMode: 'services' });
    actions.toggleSidebar();
    expect(showSidebar(read())).toBe(true);
    expect(read().sidebarVisible).toBe(true);
    expect(showSidebar({ ...read(), detailMode: 'conversation' })).toBe(true);
  });

  it('toggling elsewhere does not turn it on in Services', () => {
    const { actions, read } = harness({ detailMode: 'conversation', sidebarVisible: false });
    actions.toggleSidebar();
    expect(read().sidebarVisible).toBe(true);
    expect(read().servicesSidebarVisible).toBe(false);
  });

  it('remembers a sidebar deliberately opened in Services', () => {
    const { actions, read } = harness({ detailMode: 'services' });
    actions.toggleSidebar();
    actions.setDetailMode('conversation');
    actions.setDetailMode('services');
    expect(showSidebar(read())).toBe(true);
  });
});
