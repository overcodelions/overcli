// Exercises registerIpc() against real electron-shaped stubs so the
// fs:reviseDocument handler's own containment logic runs for real. Everything
// stateful that registerIpc() constructs directly (RunnerManager, FlowRuntime,
// OrchestratorImpl, SchedulerEngine, WorkerEngine, SymbolLookupManager) is
// replaced with an inert stand-in — none of it is reachable from the one
// handler this file cares about, and the real versions spawn timers and
// subprocesses that have no business running in a unit test.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers, storeStateRef } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: any) => any>(),
  storeStateRef: { current: { projects: [] as any[], workspaces: [] as any[], settings: {} } },
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => os.tmpdir()),
    getName: vi.fn(() => 'overcli'),
    isPackaged: false,
    whenReady: () => new Promise(() => {}), // never resolves — keeps createWindow/updater/etc. from running
    on: vi.fn(),
    commandLine: { appendSwitch: vi.fn() },
  },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
  },
  dialog: { showOpenDialog: vi.fn(), showMessageBox: vi.fn() },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, args: any) => any) => {
      handlers.set(channel, fn);
    },
  },
  session: { defaultSession: { clearCodeCaches: vi.fn(), clearCache: vi.fn() } },
  shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
  Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
  nativeTheme: {},
  powerMonitor: { on: vi.fn() },
  Notification: class {
    static isSupported() {
      return false;
    }
  },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
}));

vi.mock('./store', () => ({
  Store: { load: () => storeStateRef.current },
  flushStoreSync: vi.fn(),
}));

vi.mock('./runner', () => ({
  RunnerManager: class {},
}));
vi.mock('./flows/runtime', () => ({
  FlowRuntime: class {
    setRunObserver() {}
    setWorkerSupervisor() {}
    observeEvent() {}
    listRuns() {
      return [];
    }
    getRun() {
      return null;
    }
    deleteRun() {
      return { ok: false, error: 'not implemented' };
    }
  },
}));
vi.mock('./flows/orchestrator', () => ({
  OrchestratorImpl: class {
    list() {
      return [];
    }
    get() {
      return null;
    }
    delete() {}
    startBatch() {
      return Promise.resolve({ ok: false, error: 'not implemented' });
    }
  },
}));
vi.mock('./flows/scheduler', () => ({
  SchedulerEngine: class {
    start() {}
    onRunUpdate() {}
  },
}));
vi.mock('./flows/workerEngine', () => ({
  WorkerEngine: class {
    start() {}
    observeEvent() {}
    workerIds() {
      return [];
    }
    answerFlowQuestion() {
      return Promise.resolve(null);
    }
  },
}));
vi.mock('./symbolLookup', () => ({
  SymbolLookupManager: class {},
  resolveSearchRoot: vi.fn(),
}));

import { registerIpc } from './index';

function mkdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

beforeEach(() => {
  handlers.clear();
  storeStateRef.current = { projects: [], workspaces: [], settings: {} };
});

describe('fs:reviseDocument', () => {
  it('refuses a target outside the given rootPath, even when both are separately registered roots', () => {
    const rootA = mkdir('overcli-idx-root-a-');
    const rootB = mkdir('overcli-idx-root-b-');
    try {
      storeStateRef.current = {
        projects: [
          { path: rootA, conversations: [] },
          { path: rootB, conversations: [] },
        ],
        workspaces: [],
        settings: {},
      };
      registerIpc();
      const handler = handlers.get('fs:reviseDocument');
      expect(handler).toBeDefined();

      const outside = path.join(rootB, 'evil.md');
      const res = handler!(null, { path: outside, rootPath: rootA, prompt: 'x' });
      expect(res).toEqual({
        ok: false,
        error: 'Refused: path outside a registered project root.',
      });
    } finally {
      fs.rmSync(rootA, { recursive: true, force: true });
      fs.rmSync(rootB, { recursive: true, force: true });
    }
  });
});
