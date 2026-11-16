// @vitest-environment jsdom
//
// A task a worker handed to this desktop: Allow claims it and opens a local
// chat with the task waiting (Chrome on for browser work); Send back returns
// what the person checked; Decline tells the worker why.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const st = {
  projects: [{ id: 'p1', name: 'overgo', path: '/Users/pat/Overcli/overgo', everyday: true, conversations: [] }],
  newConversation: vi.fn(async () => ({ id: 'c1' })),
  setChrome: vi.fn(async () => {}),
  renameConversation: vi.fn(async () => {}),
  setDraft: vi.fn(),
  selectConversation: vi.fn(),
};
vi.mock('../../../store', () => ({ useStore: Object.assign(() => null, { getState: () => st }) }));
vi.mock('../../../runnersStore', () => ({ useRunnersStore: (pick: (s: unknown) => unknown) => pick({ runners: { c1: { events: [{ kind: { type: 'assistant', info: { text: 'The new tier shows, at $40.' } } }] } } }) }));

import { DesktopTaskCard, desktopPrompt } from './DesktopTaskCard';

const invoke = vi.fn();
let host: HTMLDivElement;
let root: Root;
const server = { id: 'primary', url: 'https://overgo.acme.example', name: 'Acme', isDefault: true, tokenConfigured: true, fromEnv: false, chatTool: 'overgo' };
const task = { id: 't1', workerId: 'robin', workerName: 'Robin', task: 'Check the acme partner portal shows the new tier.', kind: 'browser' as const, at: Date.now() - 60_000, status: 'waiting' as const };

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (window as unknown as { overcli: { invoke: typeof invoke } }).overcli = { invoke };
  invoke.mockReset();
  invoke.mockResolvedValue({ ok: true, data: { ok: true } });
  Object.values(st).forEach((f) => typeof f === 'function' && 'mockClear' in f && (f as ReturnType<typeof vi.fn>).mockClear());
  localStorage.clear();
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
const button = (t: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(t))!;

describe('DesktopTaskCard', () => {
  it('claims it on Allow and opens a chat with the task waiting, Chrome on, nothing sent', async () => {
    act(() => root.render(<DesktopTaskCard server={server as never} task={task} showServer={false} onDone={() => {}} />));
    await act(async () => button('Allow').click());
    await settle();
    expect(invoke).toHaveBeenCalledWith('org:call', { serverId: 'primary', method: 'POST', path: '/api/desktop/tasks/t1/claim', body: {} });
    expect(st.newConversation).toHaveBeenCalledWith('p1');
    expect(st.setChrome).toHaveBeenCalledWith('c1', true);
    expect(st.setDraft).toHaveBeenCalledWith('c1', desktopPrompt(task, server as never));
    expect(st.selectConversation).toHaveBeenCalledWith('c1');
  });

  it('sends back what the chat came to, after the person checks it', async () => {
    localStorage.setItem('overcli.org.desktopChats', JSON.stringify({ t1: 'c1' }));
    act(() => root.render(<DesktopTaskCard server={server as never} task={{ ...task, status: 'claimed' }} showServer={false} onDone={() => {}} />));
    await act(async () => button('Send back…').click());
    expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('The new tier shows, at $40.');
    await act(async () => button('Send back').click());
    await settle();
    expect(invoke).toHaveBeenCalledWith('org:call', { serverId: 'primary', method: 'POST', path: '/api/desktop/tasks/t1/result', body: { result: 'The new tier shows, at $40.' } });
  });

  it('declines with a reason', async () => {
    act(() => root.render(<DesktopTaskCard server={server as never} task={task} showServer={false} onDone={() => {}} />));
    await act(async () => button('Decline').click());
    const input = host.querySelector('input') as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Not signed in there');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('Decline').click());
    await settle();
    expect(invoke).toHaveBeenCalledWith('org:call', { serverId: 'primary', method: 'POST', path: '/api/desktop/tasks/t1/decline', body: { why: 'Not signed in there' } });
  });
});
