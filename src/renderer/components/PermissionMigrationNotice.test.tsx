// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/types';
vi.mock('../store', async () => {
  const { create } = await import('zustand');
  const { DEFAULT_SETTINGS } = await import('@shared/types');
  return { useStore: create<{ settings: typeof DEFAULT_SETTINGS; saveSettings: (next: typeof DEFAULT_SETTINGS) => Promise<void> }>((set) => ({
    settings: { ...DEFAULT_SETTINGS },
    saveSettings: vi.fn(async (settings) => { set({ settings }); }),
  })) };
});
import { useStore } from '../store';
import { PermissionMigrationNotice } from './PermissionMigrationNotice';
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useStore.setState({ settings: { ...DEFAULT_SETTINGS, defaultPermissionMode: 'auto', permissionDefaultMovedFromPlan: true } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
describe('permission migration notice', () => {
  it.each(['Keep Auto', 'Restore Plan'])('persists %s and stays dismissed after remount', async (label) => {
    await act(async () => root.render(<PermissionMigrationNotice />));
    expect(host.textContent).toContain('Auto can make changes');
    const button = [...host.querySelectorAll('button')].find(b => b.textContent === label)!;
    await act(async () => button.click());
    expect(useStore.getState().settings).toMatchObject({ defaultPermissionMode: label === 'Restore Plan' ? 'plan' : 'auto', permissionDefaultMovedFromPlan: false });
    expect(host.textContent).toBe('');
    await act(async () => { root.unmount(); root = createRoot(host); root.render(<PermissionMigrationNotice />); });
    expect(host.textContent).toBe('');
  });
  it('is absent when no migration changed the default', async () => {
    useStore.setState({ settings: { ...DEFAULT_SETTINGS } });
    await act(async () => root.render(<PermissionMigrationNotice />));
    expect(host.textContent).toBe('');
  });
});
