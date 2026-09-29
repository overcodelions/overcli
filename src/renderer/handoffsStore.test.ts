import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundHandoff } from '@shared/handoff';
import { useStore } from './store';
import { handoffSettledBy, initHandoffs, useHandoffsStore } from './handoffsStore';

const WELCOME = '__welcome__';

const handoff: InboundHandoff = {
  v: 1,
  id: 'h1',
  from: 'overdb',
  kind: 'slow-query',
  title: 'orders_by_customer scans on prod',
  summary: 'Seq scan on orders.',
  repoHints: ['/work/acme-orders'],
  createdAt: 1000,
};

const draft = () => useStore.getState().conversationDrafts[WELCOME] ?? '';

describe('handoffsStore', () => {
  let stop: () => void;
  const startNewConversation = vi.fn();

  beforeEach(async () => {
    vi.stubGlobal('window', {
      overcli: { invoke: vi.fn(async () => [handoff]), onMainEvent: () => () => {} },
      confirm: vi.fn(() => true),
    });
    useStore.setState({
      conversationDrafts: {},
      projects: [{ id: 'p1', name: 'acme-orders', path: '/work/acme-orders', conversations: [], lastOpenedAt: 0 }],
      workspaces: [],
      startNewConversation,
    } as never);
    useHandoffsStore.setState({ handoffs: [], activeId: null });
    stop = initHandoffs();
    await vi.waitFor(() => expect(useHandoffsStore.getState().handoffs).toHaveLength(1));
  });

  afterEach(() => {
    stop();
    vi.unstubAllGlobals();
    startNewConversation.mockReset();
  });

  it('seeds the start page and shows the card', () => {
    useHandoffsStore.getState().open('h1');
    expect(startNewConversation).toHaveBeenCalledWith('p1');
    expect(draft()).toContain('Seq scan on orders.');
    expect(useHandoffsStore.getState().activeId).toBe('h1');
  });

  it('keeps the card while the person writes around the report', () => {
    useHandoffsStore.getState().open('h1');
    useStore.getState().setDraft(WELCOME, `${draft()}\n\nI think it is the new index.`);
    expect(useHandoffsStore.getState().activeId).toBe('h1');
    expect(handoffSettledBy(draft())).toBe('h1');
  });

  it('puts the card away when something else replaces the draft, so that send does not settle it', () => {
    useHandoffsStore.getState().open('h1');
    useStore.getState().setDraft(WELCOME, 'About `api.log` — ');
    expect(useHandoffsStore.getState().activeId).toBeNull();
    expect(handoffSettledBy('About `api.log` — why so slow?')).toBeNull();
  });

  it('asks before replacing an unsent message, and leaves it when told no', () => {
    useStore.getState().setDraft(WELCOME, 'half a thought');
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    useHandoffsStore.getState().open('h1');
    expect(window.confirm).toHaveBeenCalled();
    expect(draft()).toBe('half a thought');
    expect(useHandoffsStore.getState().activeId).toBeNull();
  });

  it('does not ask to replace its own earlier seed', () => {
    useHandoffsStore.getState().open('h1');
    useHandoffsStore.getState().close();
    useHandoffsStore.getState().open('h1');
    expect(window.confirm).not.toHaveBeenCalled();
  });
});
