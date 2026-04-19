import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock `electron` BEFORE importing the preload module. contextBridge captures
// the exposed API so we can assert shape + behavior without a real renderer.
const invoke = vi.fn();
const on = vi.fn();
const off = vi.fn();
let exposed: Record<string, any> = {};
const exposeInMainWorld = vi.fn((key: string, api: any) => {
  exposed[key] = api;
});

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: any) => exposeInMainWorld(key, api),
  },
  ipcRenderer: {
    invoke: (...args: unknown[]) => invoke(...args),
    on: (...args: unknown[]) => on(...args),
    off: (...args: unknown[]) => off(...args),
  },
}));

describe('preload bridge', () => {
  beforeEach(async () => {
    vi.resetModules();
    invoke.mockReset();
    on.mockReset();
    off.mockReset();
    exposeInMainWorld.mockClear();
    exposed = {};
    await import('./index');
  });

  it('exposes the overcli API on the main world', () => {
    expect(exposeInMainWorld).toHaveBeenCalledTimes(1);
    expect(exposeInMainWorld).toHaveBeenCalledWith('overcli', expect.any(Object));
    expect(exposed.overcli).toMatchObject({
      invoke: expect.any(Function),
      onMainEvent: expect.any(Function),
    });
  });

  it('forwards invoke calls to ipcRenderer.invoke and returns its promise', async () => {
    invoke.mockResolvedValue('ok');
    const result = await exposed.overcli.invoke('store:load');
    expect(invoke).toHaveBeenCalledWith('store:load');
    expect(result).toBe('ok');
  });

  it('spreads additional arguments positionally', async () => {
    invoke.mockResolvedValue(undefined);
    await exposed.overcli.invoke('git:run', { args: ['status'], cwd: '/tmp' });
    expect(invoke).toHaveBeenCalledWith('git:run', { args: ['status'], cwd: '/tmp' });
  });

  it('registers a main-event listener and unwraps ipc payloads', () => {
    const handler = vi.fn();
    const unsubscribe = exposed.overcli.onMainEvent(handler);
    expect(on).toHaveBeenCalledTimes(1);
    const [channel, listener] = on.mock.calls[0];
    expect(channel).toBe('main:event');

    // Simulate electron dispatching a payload — it passes (event, payload).
    const payload = { type: 'error', conversationId: 'c', message: 'boom' };
    (listener as (e: unknown, p: unknown) => void)({}, payload);
    expect(handler).toHaveBeenCalledWith(payload);

    unsubscribe();
    expect(off).toHaveBeenCalledWith('main:event', listener);
  });
});
