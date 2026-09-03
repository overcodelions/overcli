// @vitest-environment jsdom
//
// Issue #267: the per-conversation Chrome picker added alongside #265 was
// gated on `backend === 'claude' && !compact`, copying the shape of its
// neighbour ReboundPicker — but unlike Rebound (which has a fallback home
// in the settings dropdown), Chrome has none, and it already carries an
// `iconOnly` prop plus a `<ChromeIcon active={...}>` that renders its own
// on/off state. So it should degrade to icon-only like the effort and
// response-mode pickers, not disappear the moment the header goes compact.
//
// This renders the real ConversationHeader under jsdom with a stubbed
// ResizeObserver driving the header's width, and reads out the rendered
// buttons the same way a user would find them: by title or label text.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Conversation } from '@shared/types';

vi.mock('./CommitButton', () => ({
  CommitButton: () => null,
}));

vi.mock('../runnersStore', () => ({
  getRunner: () => undefined,
  useRunnerCodexFlags: () => ({ runtimeMode: 'default', sandboxMode: '', approvalPolicy: '' }),
  useRunnerCurrentModel: () => '',
  useRunnerIsRunning: () => false,
  useRunnersStore: { getState: () => ({ patchRunner: () => {} }) },
}));

let conv: Conversation;

vi.mock('../hooks', () => ({
  useConversation: () => conv,
  useConversationRoot: () => null,
}));

const noop = () => {};
const noopAsync = async () => {};

vi.mock('../store', () => ({
  useStore: Object.assign(
    (selector: (s: unknown) => unknown) =>
      selector({
        backendHealth: {},
        installedReviewers: {},
        settings: DEFAULT_SETTINGS,
        projects: [],
        workspaces: [],
        showToolActivity: false,
        explorerRootPath: null,
        openExplorer: noop,
        closeExplorer: noop,
        setPrimaryBackend: noopAsync,
        setPermissionMode: noopAsync,
        setEffortLevel: noopAsync,
        setResponseMode: noopAsync,
        setBackendModel: noopAsync,
        setReviewBackend: noopAsync,
        setReviewMode: noopAsync,
        setReviewModel: noopAsync,
        setReviewPersona: noopAsync,
        setReviewPreset: noopAsync,
        setReviewOllamaModel: noopAsync,
        setReviewYolo: noopAsync,
        setChrome: noopAsync,
        promoteReviewAgent: noopAsync,
        checkoutReviewBranchLocally: noopAsync,
        removeAgent: noopAsync,
        resetConversation: noopAsync,
        openSheet: noop,
        toggleToolActivity: noop,
        send: noopAsync,
        gitStatusByConv: {},
      }),
    { setState: noop, getState: () => ({}) },
  ),
}));

// Stub ResizeObserver so the header's width-driven `compact` / `iconsOnly`
// state can be driven deterministically. The real callback receives
// `ResizeObserverEntry[]`; only `contentRect.width` is read.
let roCallback: ((entries: { contentRect: { width: number } }[]) => void) | null = null;
class FakeResizeObserver {
  constructor(cb: (entries: { contentRect: { width: number } }[]) => void) {
    roCallback = cb;
  }
  observe() {}
  disconnect() {}
}

function setHeaderWidth(width: number) {
  act(() => {
    roCallback?.([{ contentRect: { width } }]);
  });
}

function buttonLabels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('button')).map(
    (b) => b.getAttribute('title') || b.textContent || '',
  );
}

describe('ConversationHeader — Chrome picker at compact widths (#267)', () => {
  let container: HTMLDivElement;
  let root: Root;
  const originalResizeObserver = global.ResizeObserver;

  beforeEach(async () => {
    conv = {
      id: 'conv-1',
      name: 'Test conversation',
      createdAt: 0,
      totalCostUSD: 0,
      turnCount: 0,
      currentModel: '',
      permissionMode: 'default',
      primaryBackend: 'claude',
    } as unknown as Conversation;

    roCallback = null;
    // @ts-expect-error test stub, not a full ResizeObserver
    global.ResizeObserver = FakeResizeObserver;

    container = document.createElement('div');
    document.body.appendChild(container);
    const { ConversationHeader } = await import('./ConversationHeader');
    root = createRoot(container);
    act(() => {
      root.render(<ConversationHeader conversationId={conv.id} />);
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    global.ResizeObserver = originalResizeObserver;
    vi.resetModules();
  });

  it('shows the Chrome picker at full width', () => {
    setHeaderWidth(1200);
    const labels = buttonLabels(container);
    expect(labels.some((l) => l.startsWith('Chrome'))).toBe(true);
  });

  it('keeps the Chrome picker, with its label, in the compact (not icon-only) band', () => {
    // < 980: Fork/Rebound move into the settings dropdown, but Chrome has
    // no such fallback and should stay in the header.
    setHeaderWidth(900);
    const labels = buttonLabels(container);
    expect(labels.some((l) => l.startsWith('Chrome'))).toBe(true);
  });

  it('collapses the Chrome picker to icon-only (tooltip) rather than hiding it once iconsOnly kicks in', () => {
    // < 760: labels drop from the remaining pickers; the label moves into
    // `title=`, which is exactly how the effort/response-mode pickers
    // already behave at this width.
    setHeaderWidth(700);
    const buttons = Array.from(container.querySelectorAll('button'));
    const chromeButton = buttons.find((b) => (b.getAttribute('title') || '').startsWith('Chrome'));
    expect(chromeButton).toBeTruthy();
    // Icon-only: no visible label span, no chevron — same shape as the
    // effort/response-mode pickers' icon-only state.
    expect(chromeButton!.querySelector('span')).toBeNull();
  });
});
