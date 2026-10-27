// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MainToRendererEvent } from '@shared/types';
vi.mock('../store', () => ({ useStore: (select: (s: unknown) => unknown) => select({ openFile: vi.fn(), openFilePath: null }) }));
vi.mock('../terminalStore', () => ({ useTerminalStore: { getState: () => ({}) } }));
import { FileTree } from './FileTree';
let host: HTMLDivElement;
let root: Root;
let listener: (event: MainToRendererEvent) => void;
const empty = { entries: [], truncated: false, unlistedDirs: [] };
const invoke = vi.fn(async (channel: string, dir: string): Promise<unknown> => {
  if (channel === 'fs:watchTree') return { ok: true, key: dir };
  if (channel === 'fs:listFileEntries') return dir === '/repo'
    ? { ...empty, truncated: true, unlistedDirs: ['/repo/a', '/repo/b'] }
    : { ...empty, entries: [{ path: `${dir}/file.ts`, sizeBytes: 1 }] };
  return { ok: true };
});
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  invoke.mockClear();
  Object.defineProperty(window, 'overcli', { configurable: true, value: {
    invoke,
    onMainEvent: (fn: typeof listener) => { listener = fn; return () => {}; },
  } });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function expand(name: string) {
  const row = [...host.querySelectorAll<HTMLElement>('[role="button"]')].find(el => [...el.querySelectorAll('span')].some(span => span.textContent === name));
  expect(row).toBeDefined();
  await act(async () => row!.click());
}
const listed = () => invoke.mock.calls.filter(([channel]) => channel === 'fs:listFileEntries').map(([, dir]) => dir);
describe('file tree refresh', () => {
  it('refreshes only affected cached folders, with a full manual-refresh fallback', async () => {
    await act(async () => root.render(<FileTree rootPath="/repo" />));
    await expand('a'); await expand('b');
    invoke.mockClear();
    await act(async () => listener({ type: 'fileTreeChanged', root: '/repo', changedPaths: ['/repo/a/file.ts'] }));
    expect(listed()).toEqual(['/repo', '/repo/a']);
    invoke.mockClear();
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Refresh file list"]')!.click());
    expect(listed()).toEqual(['/repo', '/repo/a', '/repo/b']);
    invoke.mockClear();
    await act(async () => listener({ type: 'fileTreeChanged', root: '/repo', changedPaths: ['/repo/a'] }));
    expect(listed()).toEqual(['/repo', '/repo/a']);
  });
  it('discards a late expansion response after switching roots', async () => {
    await act(async () => root.render(<FileTree rootPath="/repo" />));
    let finish!: (value: unknown) => void;
    invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await expand('a');
    await act(async () => root.render(<FileTree rootPath="/different" />));
    await act(async () => finish({ ...empty, entries: [{ path: '/repo/a/stale.ts', sizeBytes: 1 }] }));
    expect(host.textContent).not.toContain('stale.ts');
    expect(host.textContent).toContain('file.ts');
  });
  it('retains changes from a superseded refresh while another folder changes', async () => {
    await act(async () => root.render(<FileTree rootPath="/repo" />));
    await expand('a'); await expand('b');
    invoke.mockClear();
    let finish!: (value: unknown) => void;
    invoke.mockImplementationOnce(async () => ({ ...empty, truncated: true, unlistedDirs: ['/repo/a', '/repo/b'] }));
    invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => listener({ type: 'fileTreeChanged', root: '/repo', changedPaths: ['/repo/a/file.ts'] }));
    expect(finish).toBeDefined();
    await act(async () => listener({ type: 'fileTreeChanged', root: '/repo', changedPaths: ['/repo/b/file.ts'] }));
    expect(listed()).toEqual(['/repo', '/repo/a', '/repo', '/repo/a', '/repo/b']);
    await act(async () => finish({ ...empty, entries: [{ path: '/repo/a/stale.ts', sizeBytes: 1 }] }));
    expect(host.textContent).not.toContain('stale.ts');
  });
});
