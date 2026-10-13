import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MainToRendererEvent, TerminalSession } from '@shared/types';
import { terminalTabLabel, useTerminalStore } from './terminalStore';

let nextPid = 100;
let listed: TerminalSession[] = [];
let mainEvent: ((e: MainToRendererEvent) => void) | null = null;
const invoke = vi.fn();

function session(id: string, cwd: string): TerminalSession {
  return { id, cwd, shell: 'zsh', pid: nextPid++, exitCode: null };
}

beforeEach(() => {
  let n = 0;
  invoke.mockReset();
  invoke.mockImplementation(async (channel: string, args: { cwd?: string }) => {
    if (channel === 'terminal:create') {
      if (args.cwd === '/nope') return { ok: false, error: 'That folder is not inside a registered project root.' };
      return { ok: true, session: session(`t${++n}`, args.cwd!) };
    }
    if (channel === 'terminal:list') return listed;
    return undefined;
  });
  (globalThis as unknown as { window: unknown }).window = {
    overcli: {
      invoke,
      onMainEvent: (h: (e: MainToRendererEvent) => void) => {
        mainEvent = h;
        return () => {
          mainEvent = null;
        };
      },
    },
  };
});

afterEach(() => {
  useTerminalStore.setState({ open: false, sessions: [], activeId: null, error: null });
  listed = [];
});

describe('useTerminalStore', () => {
  it('toggle opens the drawer with a shell where the user is, then hides it without ending the shell', async () => {
    await useTerminalStore.getState().toggle('/work/acme-api');
    let s = useTerminalStore.getState();
    expect(s.open).toBe(true);
    expect(s.sessions.map((t) => t.cwd)).toEqual(['/work/acme-api']);
    expect(s.activeId).toBe('t1');

    await useTerminalStore.getState().toggle('/work/acme-api');
    s = useTerminalStore.getState();
    expect(s.open).toBe(false);
    expect(s.sessions).toHaveLength(1);
    expect(invoke).not.toHaveBeenCalledWith('terminal:close', expect.anything());
  });

  it('reopening keeps the existing shells instead of starting another', async () => {
    await useTerminalStore.getState().show('/a');
    useTerminalStore.getState().hide();
    await useTerminalStore.getState().show('/b');
    expect(useTerminalStore.getState().sessions.map((t) => t.cwd)).toEqual(['/a']);
  });

  it('shows the reason when a shell cannot start', async () => {
    await useTerminalStore.getState().openAt('/nope');
    const s = useTerminalStore.getState();
    expect(s.open).toBe(true);
    expect(s.sessions).toEqual([]);
    expect(s.error).toMatch(/registered project root/);
  });

  it('closing a tab selects its neighbour, and closing the last puts the drawer away', async () => {
    const store = useTerminalStore.getState();
    await store.openAt('/a');
    await store.openAt('/b');
    await store.openAt('/c');
    store.select('t2');
    await store.close('t2');
    expect(useTerminalStore.getState().activeId).toBe('t3');
    await store.close('t3');
    expect(useTerminalStore.getState().activeId).toBe('t1');
    await store.close('t1');
    expect(useTerminalStore.getState()).toMatchObject({ open: false, sessions: [], activeId: null });
    expect(invoke).toHaveBeenCalledWith('terminal:close', { id: 't1' });
  });

  it('init picks up shells main still has and marks exits', async () => {
    listed = [session('t9', '/kept')];
    const off = useTerminalStore.getState().init();
    await vi.waitFor(() => expect(useTerminalStore.getState().sessions).toHaveLength(1));
    expect(useTerminalStore.getState().activeId).toBe('t9');
    mainEvent!({ type: 'terminalExit', id: 't9', exitCode: 1 });
    expect(useTerminalStore.getState().sessions[0]!.exitCode).toBe(1);
    off();
    expect(mainEvent).toBeNull();
  });

  it('shows a shell main started on its own, such as a login', () => {
    const off = useTerminalStore.getState().init();
    mainEvent!({ type: 'terminalOpened', session: session('t7', '/Users/acme') });
    mainEvent!({ type: 'terminalOpened', session: session('t7', '/Users/acme') });
    expect(useTerminalStore.getState()).toMatchObject({ open: true, activeId: 't7' });
    expect(useTerminalStore.getState().sessions).toHaveLength(1);
    off();
  });
});

describe('popped-out terminals', () => {
  it('follows a shell into its own window and back', async () => {
    const off = useTerminalStore.getState().init();
    await useTerminalStore.getState().openAt('/a');
    mainEvent!({ type: 'terminalPoppedOut', id: 't1', out: true });
    expect(useTerminalStore.getState().sessions[0]!.poppedOut).toBe(true);
    mainEvent!({ type: 'terminalPoppedOut', id: 't1', out: false });
    expect(useTerminalStore.getState().sessions[0]!.poppedOut).toBe(false);
    off();
  });
});

describe('terminalTabLabel', () => {
  it('is the folder name', () => {
    expect(terminalTabLabel(session('t1', '/Users/acme/git/acme-api'))).toBe('acme-api');
    expect(terminalTabLabel(session('t1', 'C:\\src\\acme-web'))).toBe('acme-web');
  });
});
