// Pure helpers hanging off the renderer store: the health-probe gate and the
// editor-tab persistence projection.

import { describe, expect, it } from 'vitest';
import type { AppSettings } from '@shared/types';
import { backendSettingsChanged, hydrateFileTabs, serializeFileTabs } from './store';

function settings(over: Partial<AppSettings> = {}): AppSettings {
  return {
    backendPaths: {},
    disabledBackends: {},
    ...over,
  } as AppSettings;
}

// Health probing executes every installed CLI, so it must not ride along on
// unrelated settings writes — pane widths are persisted through the same
// action, which is what made dragging a divider stutter.
describe('backendSettingsChanged', () => {
  it('is false for cosmetic settings changes', () => {
    const prev = settings({ editorPaneWidth: 540 } as Partial<AppSettings>);
    const next = settings({ editorPaneWidth: 700 } as Partial<AppSettings>);
    expect(backendSettingsChanged(prev, next)).toBe(false);
  });

  it('is true when a backend binary path changes', () => {
    const prev = settings({ backendPaths: {} } as Partial<AppSettings>);
    const next = settings({ backendPaths: { claude: '/opt/claude' } } as Partial<AppSettings>);
    expect(backendSettingsChanged(prev, next)).toBe(true);
    expect(backendSettingsChanged(next, prev)).toBe(true);
  });

  it('is true when a backend is enabled or disabled', () => {
    const prev = settings({ disabledBackends: {} } as Partial<AppSettings>);
    const next = settings({ disabledBackends: { gemini: true } } as Partial<AppSettings>);
    expect(backendSettingsChanged(prev, next)).toBe(true);
  });

  it('survives missing maps on either side', () => {
    const bare = {} as AppSettings;
    expect(backendSettingsChanged(bare, settings())).toBe(false);
    expect(backendSettingsChanged(settings(), bare)).toBe(false);
  });
});

describe('file tab persistence', () => {
  it('round-trips paths and the active tab', () => {
    const hydrated = hydrateFileTabs({
      'conv:c1': { paths: ['/repo/a.ts', '/repo/b.ts'], activePath: '/repo/b.ts' },
    });
    expect(hydrated['conv:c1'].tabs.map((t) => t.path)).toEqual(['/repo/a.ts', '/repo/b.ts']);
    expect(hydrated['conv:c1'].activePath).toBe('/repo/b.ts');

    const out = serializeFileTabs({
      fileTabsByScope: hydrated,
      fileScopeKey: null,
      tabs: [],
      openFilePath: null,
    } as never);
    expect(out).toEqual({
      'conv:c1': { paths: ['/repo/a.ts', '/repo/b.ts'], activePath: '/repo/b.ts' },
    });
  });

  it('restores every tab in the editor, not preview', () => {
    // A restored README used to come back as a rendered page.
    const hydrated = hydrateFileTabs({ 'conv:c1': { paths: ['/repo/README.md'] } });
    expect(hydrated['conv:c1'].tabs[0].mode).toBe('edit');
    expect(hydrated['conv:c1'].tabs[0].highlight).toBeNull();
  });

  it('repairs an activePath that is not in the list', () => {
    const hydrated = hydrateFileTabs({
      'conv:c1': { paths: ['/repo/a.ts'], activePath: '/repo/gone.ts' },
    });
    expect(hydrated['conv:c1'].activePath).toBe('/repo/a.ts');
  });

  it('drops empty scopes and tolerates nothing saved', () => {
    expect(hydrateFileTabs({ 'conv:c1': { paths: [] } })).toEqual({});
    expect(hydrateFileTabs(undefined)).toEqual({});
  });

  it('folds the live scope in, since it is not in the map until switched away from', () => {
    const out = serializeFileTabs({
      fileTabsByScope: { 'conv:old': { tabs: [{ path: '/repo/x.ts' }], activePath: '/repo/x.ts' } },
      fileScopeKey: 'conv:live',
      tabs: [{ path: '/repo/live.ts' }, { path: '/repo/two.ts' }],
      openFilePath: '/repo/two.ts',
    } as never);
    expect(out['conv:live']).toEqual({
      paths: ['/repo/live.ts', '/repo/two.ts'],
      activePath: '/repo/two.ts',
    });
    expect(out['conv:old'].paths).toEqual(['/repo/x.ts']);
  });

  it('clears the live scope when its last tab closes', () => {
    const out = serializeFileTabs({
      fileTabsByScope: { 'conv:live': { tabs: [{ path: '/repo/stale.ts' }], activePath: null } },
      fileScopeKey: 'conv:live',
      tabs: [],
      openFilePath: null,
    } as never);
    expect(out['conv:live']).toBeUndefined();
  });
});
