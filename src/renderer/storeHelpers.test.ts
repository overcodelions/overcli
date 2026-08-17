// Pure helpers hanging off the renderer store: the health-probe gate and the
// editor-tab persistence projection.

import { describe, expect, it } from 'vitest';
import type { AppSettings, Conversation } from '@shared/types';
import {
  backendSettingsChanged,
  hydrateFileTabs,
  isLiveWorkspaceAgent,
  ownsWorktree,
  serializeFileTabs,
} from './store';

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

// Deleting an agent runs `git worktree remove` + branch delete. A chat
// opened into a flow run's worktree ("New chat here") points at a tree it
// doesn't own — deleting it must leave the run's tree and branch intact,
// or the run loses the work it's holding for Review & merge.
describe('ownsWorktree', () => {
  const conv = (over: Partial<Conversation>) => ({ id: 'c1', ...over }) as Conversation;

  it('is true for an agent that minted its own worktree', () => {
    expect(ownsWorktree(conv({ worktreePath: '/wt/a', branchName: 'feature/a' }))).toBe(true);
  });

  it('is false for a chat borrowing a flow run worktree', () => {
    expect(
      ownsWorktree(conv({ worktreePath: '/wt/a', branchName: 'feature/a', adoptedWorktree: true })),
    ).toBe(false);
  });

  it('is false for a plain conversation with no worktree', () => {
    expect(ownsWorktree(conv({}))).toBe(false);
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

  it('restores each tab in its natural default mode, with no line jump', () => {
    const hydrated = hydrateFileTabs({
      'conv:c1': { paths: ['/repo/README.md', '/repo/Button.tsx', '/repo/main.ts'] },
    });
    const [readme, button, main] = hydrated['conv:c1'].tabs;
    // Markdown and components render; source files open as source.
    expect(readme.mode).toBe('preview');
    expect(button.mode).toBe('preview');
    expect(main.mode).toBe('edit');
    // The per-extension memory is session-scoped, so there is none to apply
    // at hydration, and a line number saved days ago is not worth restoring.
    expect(readme.highlight).toBeNull();
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

// The Edit-workspace sheet offers to push newly added projects into the
// workspace's agents. It counted every coordinator the workspace had ever
// held, so an archived backlog showed up as "Apply to 23 agents" against a
// sidebar listing none — and applying would have cut worktrees for all 23.
describe('isLiveWorkspaceAgent', () => {
  const coordinator = (over: Partial<Conversation> = {}): Conversation =>
    ({ id: 'c1', name: 'agent', workspaceAgentMemberIds: ['m1'], ...over }) as Conversation;

  it('counts a coordinator with members', () => {
    expect(isLiveWorkspaceAgent(coordinator())).toBe(true);
  });

  it('skips archived coordinators', () => {
    expect(isLiveWorkspaceAgent(coordinator({ hidden: true }))).toBe(false);
  });

  it('skips coordinators whose worktrees were dissolved back into the repos', () => {
    expect(isLiveWorkspaceAgent(coordinator({ continuedLocally: true }))).toBe(false);
  });

  it('skips plain conversations and members', () => {
    expect(isLiveWorkspaceAgent(coordinator({ workspaceAgentMemberIds: [] }))).toBe(false);
    expect(
      isLiveWorkspaceAgent({ id: 'm1', name: 'member', worktreePath: '/wt' } as Conversation),
    ).toBe(false);
  });
});
