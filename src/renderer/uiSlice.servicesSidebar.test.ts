import { describe, expect, it } from 'vitest';
import { createUiSlice } from './uiSlice';
import type { DetailMode } from './store';

/// What the sidebar toggle shows or hides on a tab, restated from App so it
/// can be tested without a window. Services never shows the conversations
/// sidebar; the toggle folds its service list instead.
function onScreen(state: {
  detailMode: DetailMode;
  sidebarVisible: boolean;
  servicesListHidden: boolean;
}): { sidebar: boolean; serviceList: boolean } {
  if (state.detailMode === 'services') return { sidebar: false, serviceList: !state.servicesListHidden };
  return { sidebar: state.sidebarVisible, serviceList: false };
}

function harness(initial: {
  detailMode: DetailMode;
  sidebarVisible?: boolean;
  servicesListHidden?: boolean;
}) {
  let state = {
    sidebarVisible: true,
    servicesListHidden: false,
    ...initial,
  };
  const set = (patch: unknown) => {
    const next = typeof patch === 'function' ? (patch as (s: typeof state) => object)(state) : patch;
    state = { ...state, ...(next as object) };
  };
  const actions = createUiSlice(set as never, (() => state) as never);
  return { actions, read: () => state };
}

describe('the navigator a tab shows', () => {
  it('opens Services with its list and without the conversations sidebar', () => {
    const { actions, read } = harness({ detailMode: 'conversation' });
    actions.setDetailMode('services');
    expect(onScreen(read())).toEqual({ sidebar: false, serviceList: true });
  });

  it('leaves Chat exactly as it was', () => {
    // The bug this replaced: hiding shared chrome as a side effect of entering
    // a tab meant every path OUT of it had to remember to undo that, and the
    // history arrows — which write state directly — never would.
    const { actions, read } = harness({ detailMode: 'conversation' });
    actions.setDetailMode('services');
    actions.setDetailMode('conversation');
    expect(onScreen(read()).sidebar).toBe(true);
  });

  it('folds the service list, not the sidebar, when toggled in Services', () => {
    const { actions, read } = harness({ detailMode: 'services' });
    actions.toggleSidebar();
    expect(onScreen(read())).toEqual({ sidebar: false, serviceList: false });
    expect(read().sidebarVisible).toBe(true);
    actions.toggleSidebar();
    expect(onScreen(read()).serviceList).toBe(true);
  });

  it('toggling elsewhere does not fold the service list', () => {
    const { actions, read } = harness({ detailMode: 'conversation' });
    actions.toggleSidebar();
    expect(read().sidebarVisible).toBe(false);
    expect(read().servicesListHidden).toBe(false);
  });

  it('remembers a folded list across tabs', () => {
    const { actions, read } = harness({ detailMode: 'services' });
    actions.toggleSidebar();
    actions.setDetailMode('conversation');
    actions.setDetailMode('services');
    expect(onScreen(read()).serviceList).toBe(false);
  });
});
