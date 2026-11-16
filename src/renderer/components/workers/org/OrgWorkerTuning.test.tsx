// @vitest-environment jsdom
//
// overgo's tuning, in overcli: how a worker's work is going, a review on
// request, and each suggestion applied the console's way for its area.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrgWorkerTuning } from './OrgWorkerTuning';

const invoke = vi.fn();
let host: HTMLDivElement;
let root: Root;
const NOW = Date.now();
const server = { id: 'primary', url: 'https://overgo.acme.example', name: 'Acme', isDefault: true, tokenConfigured: true, fromEnv: false, chatTool: 'overgo', me: { org: 'Acme', name: 'Pat Lee', canHire: true } };
const tuning = {
  watching: true, orgWatching: true,
  score: { runs: [{ id: 'r-9', number: 9, at: NOW - 1000, title: 'Benchmarks?', result: 'rough', why: 'ran long', minutes: 6 }], changes: [], recent: { runs: 1 }, previous: null, verdict: { kind: 'early', basis: 'recent' }, steps: [{ id: 'explore-and-answer', minutes: 5 }] },
  signals: { notUseful: 1, refused: 0, runs: 1, longestIdle: 0, longestMinutes: 6 },
  said: [{ text: 'too long for sales', who: 'Jo Park', at: NOW - 5000 }],
  runs: [{ id: 'r-9', number: 9, title: 'Benchmarks?', flowId: 'explore', outcome: 'done', at: NOW - 1000 }],
  reviews: [{
    id: 'rv1', at: NOW - 2000, by: 'Pat Lee', summary: 'Answers run long for non-engineers.', looked: { runs: 5, answers: 3 },
    suggestions: [
      { id: 's-job', area: 'job', title: 'Lead with a two-line answer', why: 'Sales readers stop early.', change: 'Start every answer with two plain lines.', runs: [9] },
      { id: 's-note', area: 'notes', title: 'Remember the reporting owner', why: 'It looked it up twice.', change: 'Jordan Mills owns the reporting service.', runs: [] },
    ],
  }],
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (window as unknown as { overcli: { invoke: typeof invoke } }).overcli = { invoke };
  invoke.mockReset();
  invoke.mockImplementation(async (_c: string, a: { method: string; path: string }) => {
    if (a.path === '/api/workers/ada/tuning') return { ok: true, data: tuning };
    if (a.path === '/api/workers/ada/suggest-job') return { ok: true, data: { name: 'Ada', job: 'Start every answer with two plain lines. Then explain the acme code.' } };
    if (a.method === 'POST') return { ok: true, data: { ok: true } };
    return { ok: false, error: 'no' };
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
async function settle() {
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
}
const button = (t: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === t)!;
const render = () => act(() => root.render(<OrgWorkerTuning server={server as never} worker={{ id: 'ada', name: 'Ada' }} job="Explain the acme code." can onOpenRun={() => {}} onChanged={() => {}} />));

describe('OrgWorkerTuning', () => {
  it('shows how its work is going, what people said and what overgo suggests', async () => {
    render();
    await settle();
    const text = host.textContent ?? '';
    expect(text).toContain('Too early to tell');
    expect(text).toContain('1 rated not useful');
    expect(text).toContain('“too long for sales”');
    expect(text).toContain('Suggested changes 2');
    expect(text).toContain('Lead with a two-line answer');
  });

  it('rewrites its job from a suggestion, saves it and marks it applied', async () => {
    render();
    await settle();
    await act(async () => button('Rewrite its job').click());
    await settle();
    expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toContain('two plain lines');
    await act(async () => button('Save it').click());
    await settle();
    expect(invoke).toHaveBeenCalledWith('org:call', { serverId: 'primary', method: 'POST', path: '/api/workers/ada/update', body: { patch: { jobDescription: 'Start every answer with two plain lines. Then explain the acme code.' } } });
    expect(invoke).toHaveBeenCalledWith('org:call', { serverId: 'primary', method: 'POST', path: '/api/workers/ada/reviews/rv1/suggestions/s-job', body: { state: 'applied' } });
  });

  it('adds a note suggestion to its journal, and asks for a review with a complaint', async () => {
    render();
    await settle();
    await act(async () => button('Add to its notes').click());
    await settle();
    expect(invoke).toHaveBeenCalledWith('org:call', { serverId: 'primary', method: 'POST', path: '/api/workers/ada/journal', body: { note: 'Jordan Mills owns the reporting service.' } });
    const input = host.querySelector('#org-complaint') as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'answers run long');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('Review its work').click());
    await settle();
    expect(invoke).toHaveBeenCalledWith('org:call', { serverId: 'primary', method: 'POST', path: '/api/workers/ada/review', body: { complaint: 'answers run long' } });
  });
});

describe('improving it with Claude', () => {
  it('lets chats reach the org only when asked, then opens a chat with the briefing waiting', async () => {
    const st = { projects: [{ id: 'p1', name: 'overgo', path: '/Users/pat/Overcli/overgo', everyday: true, conversations: [] }], newConversation: vi.fn(async () => ({ id: 'c9' })), renameConversation: vi.fn(async () => {}), setDraft: vi.fn(), selectConversation: vi.fn() };
    const { useStore } = await import('../../../store');
    vi.spyOn(useStore, 'getState').mockReturnValue(st as never);
    invoke.mockImplementation(async (c: string, a?: { method: string; path: string }) => {
      if (c === 'org:setInChats' || c === 'org:setChatAccess') return { ok: true };
      if (a?.path === '/api/workers/ada/tuning') return { ok: true, data: tuning };
      if (a?.path?.startsWith('/api/workers/ada/journal')) return { ok: true, data: { notes: [{ id: 'n1', at: 1, note: 'Sales want two-line answers.' }], entries: [], canChange: true } };
      return { ok: false, error: 'no' };
    });
    render();
    await settle();
    await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Let chats reach Acme'))!.click());
    await settle();
    expect(invoke).toHaveBeenCalledWith('org:setInChats', { serverId: 'primary', on: true });
    expect(invoke).toHaveBeenCalledWith('org:setChatAccess', { serverId: 'primary', access: 'ask' });
    expect(st.renameConversation).toHaveBeenCalledWith('c9', 'Improve Ada');
    const draft = st.setDraft.mock.calls[0][1] as string;
    expect(draft).toContain('Help me improve Ada');
    expect(draft).toContain('Explain the acme code.');
    expect(draft).toContain('Sales want two-line answers.');
    expect(draft).toContain('#9 Benchmarks?: rough (ran long)');
    expect(draft).toContain('worker_tuning');
    expect(draft).toContain('Every change asks me first');
    expect(st.selectConversation).toHaveBeenCalledWith('c9');
  });
});
