import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MainToRendererEvent } from '@shared/types';
import { useStore } from './store';
import { scopeTabsOf, useExplorerPopoutStore, withScopeTabs } from './explorerPopout';

const ROOT = '/repos/acme-api';
const CONV = 'conv:c1';
let mainEvent: ((e: MainToRendererEvent) => void) | null = null;
const invoke = vi.fn();

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (channel: string, args: { root?: string }) => {
    if (channel === 'explorer:list') return [];
    if (channel === 'explorer:popOut') {
      mainEvent?.({ type: 'explorerPoppedOut', root: args.root!, out: true });
      return { ok: true };
    }
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
    confirm: () => true,
    alert: () => {},
  };
  useStore.getState().switchFileScope(CONV);
  useStore.getState().openFile(`${ROOT}/a.ts`);
  useStore.getState().openFile(`${ROOT}/b.ts`);
});

afterEach(() => {
  useExplorerPopoutStore.setState({ out: {} });
  useStore.setState({ tabs: [], openFilePath: null, fileScopeKey: null, fileTabsByScope: {}, dirtyFiles: {} });
});

describe('explorer pop-out tab hand-off', () => {
  it('reads the live scope and a parked one alike', () => {
    expect(scopeTabsOf(useStore.getState(), CONV)).toEqual({
      paths: [`${ROOT}/a.ts`, `${ROOT}/b.ts`],
      activePath: `${ROOT}/b.ts`,
    });
    useStore.getState().switchFileScope('conv:other');
    expect(scopeTabsOf(useStore.getState(), CONV)?.paths).toEqual([`${ROOT}/a.ts`, `${ROOT}/b.ts`]);
  });

  it('merges returning tabs after ones opened while away', () => {
    const s = useStore.getState();
    useStore.setState(withScopeTabs(s, CONV, { paths: [`${ROOT}/b.ts`, `${ROOT}/c.ts`], activePath: `${ROOT}/c.ts` }));
    const after = useStore.getState();
    expect(after.tabs.map((t) => t.path)).toEqual([`${ROOT}/a.ts`, `${ROOT}/b.ts`, `${ROOT}/c.ts`]);
    expect(after.openFilePath).toBe(`${ROOT}/c.ts`);
  });

  it('takes the tabs out on pop-out and puts them back in the same scope on close', async () => {
    const off = useExplorerPopoutStore.getState().init();
    await useExplorerPopoutStore.getState().popOut(ROOT, CONV);

    expect(invoke).toHaveBeenCalledWith('explorer:popOut', {
      root: ROOT,
      tabs: { paths: [`${ROOT}/a.ts`, `${ROOT}/b.ts`], activePath: `${ROOT}/b.ts` },
    });
    expect(useStore.getState().tabs).toEqual([]);
    expect(useExplorerPopoutStore.getState().out).toEqual({ [ROOT]: CONV });

    mainEvent!({
      type: 'explorerPoppedOut',
      root: ROOT,
      out: false,
      tabs: { paths: [`${ROOT}/a.ts`, `${ROOT}/d.ts`], activePath: `${ROOT}/d.ts` },
    });
    expect(useExplorerPopoutStore.getState().out).toEqual({});
    expect(useStore.getState().tabs.map((t) => t.path)).toEqual([`${ROOT}/a.ts`, `${ROOT}/d.ts`]);
    expect(useStore.getState().openFilePath).toBe(`${ROOT}/d.ts`);
    off();
  });

  it('leaves tabs alone when the window was already out', async () => {
    useExplorerPopoutStore.setState({ out: { [ROOT]: CONV } });
    await useExplorerPopoutStore.getState().popOut(ROOT, CONV);
    expect(useStore.getState().tabs).toHaveLength(2);
  });
});
