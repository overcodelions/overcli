// Pure helpers hanging off the renderer store: the health-probe gate and the
// editor-tab persistence projection.

import { describe, expect, it } from 'vitest';
import type { AppSettings, Conversation, StreamEvent } from '@shared/types';
import {
  backendSettingsChanged,
  hydrateFileTabs,
  isLiveWorkspaceAgent,
  ownsWorktree,
  serializeFileTabs,
  withClaudeFastPreset,
  withFastestPreset,
  withResponseMode,
  mergeIncomingEvents,
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

describe('withClaudeFastPreset', () => {
  it('selects Claude Sonnet 5 with low effort and Turbo without changing unrelated fields', () => {
    const conversation = {
      id: 'c1',
      name: 'Keep me',
      claudeModel: 'claude-opus-5',
      currentModel: 'claude-opus-5',
      effortLevel: 'high',
      turbo: false,
      permissionMode: 'acceptEdits',
    } as Conversation;

    expect(withClaudeFastPreset(conversation)).toMatchObject({
      id: 'c1',
      name: 'Keep me',
      claudeModel: 'claude-sonnet-5',
      currentModel: 'claude-sonnet-5',
      effortLevel: 'low',
      responseStyle: 'efficient',
      responseMode: 'warp',
      turbo: true,
      permissionMode: 'acceptEdits',
    });
  });
});

describe('withResponseMode', () => {
  const conversation = {
    id: 'c1',
    name: 'Keep me',
    claudeModel: 'claude-opus-5',
    currentModel: 'claude-opus-5',
    effortLevel: 'high',
    responseStyle: 'concise',
    turbo: true,
  } as Conversation;

  it('applies Full and Swift without changing model or effort', () => {
    expect(withResponseMode(conversation, 'claude', 'full')).toMatchObject({
      responseStyle: 'normal',
      responseMode: 'full',
      turbo: false,
      claudeModel: 'claude-opus-5',
      effortLevel: 'high',
    });
    expect(withResponseMode(conversation, 'claude', 'swift')).toMatchObject({
      responseStyle: 'efficient',
      responseMode: 'swift',
      turbo: false,
      claudeModel: 'claude-opus-5',
      effortLevel: 'high',
    });
  });

  it('makes Turbo low effort while retaining the selected model', () => {
    expect(withResponseMode(conversation, 'claude', 'turbo')).toMatchObject({
      responseStyle: 'efficient',
      responseMode: 'turbo',
      turbo: true,
      claudeModel: 'claude-opus-5',
      currentModel: 'claude-opus-5',
      effortLevel: 'low',
    });
  });

  it('makes Warp the lower-latency Claude model preset', () => {
    const warp = withResponseMode(conversation, 'claude', 'warp');
    expect(warp).toMatchObject({
      responseStyle: 'efficient',
      responseMode: 'warp',
      turbo: true,
      claudeModel: 'claude-sonnet-5',
      currentModel: 'claude-sonnet-5',
      effortLevel: 'low',
      responseModeRestore: {
        models: { claude: 'claude-opus-5' },
        effortLevel: 'high',
      },
    });
    expect(withResponseMode(warp, 'claude', 'full')).toMatchObject({
      responseMode: 'full',
      claudeModel: 'claude-opus-5',
      currentModel: 'claude-opus-5',
      effortLevel: 'high',
      turbo: false,
    });
  });

  it('uses the configured default when restoring a legacy Warp conversation', () => {
    const legacyWarp = {
      ...conversation,
      claudeModel: 'claude-sonnet-5',
      currentModel: 'claude-sonnet-5',
      effortLevel: 'low',
      responseMode: 'warp',
    } as Conversation;
    expect(withResponseMode(legacyWarp, 'claude', 'full', 'claude-opus-5')).toMatchObject({
      responseMode: 'full',
      claudeModel: 'claude-opus-5',
      currentModel: 'claude-opus-5',
      turbo: false,
    });
  });

  it('reselects the configured default when Full is chosen again', () => {
    const fullOnFastModel = {
      ...conversation,
      claudeModel: 'claude-sonnet-5',
      currentModel: 'claude-sonnet-5',
      responseMode: 'full',
    } as Conversation;
    expect(withResponseMode(fullOnFastModel, 'claude', 'full', 'claude-opus-5')).toMatchObject({
      responseMode: 'full',
      claudeModel: 'claude-opus-5',
      currentModel: 'claude-opus-5',
    });
  });

  it('maps Warp to each hosted backend fast-tier model', () => {
    expect(withFastestPreset(conversation, 'codex')).toMatchObject({
      codexModel: 'gpt-5.6-luna',
      currentModel: 'gpt-5.6-luna',
      responseMode: 'warp',
    });
    expect(withFastestPreset(conversation, 'gemini')).toMatchObject({
      geminiModel: 'gemini-3.5-flash-lite',
      currentModel: 'gemini-3.5-flash-lite',
      responseMode: 'warp',
    });
    expect(withFastestPreset(conversation, 'copilot')).toMatchObject({
      copilotModel: 'claude-haiku-4.5',
      currentModel: 'claude-haiku-4.5',
      responseMode: 'warp',
    });
  });
});

describe('mergeIncomingEvents timing anchors', () => {
  const assistant = (timestamp: number, text: string, isPartial = true): StreamEvent => ({
    id: 'assistant-1',
    timestamp,
    raw: '',
    revision: 0,
    kind: {
      type: 'assistant',
      info: { model: 'claude', text, thinking: [], toolUses: [], isPartial },
    },
  });

  it('retains first activity and first visible text while replacing a streaming slot', () => {
    let events = mergeIncomingEvents([], [assistant(100, '')]);
    events = mergeIncomingEvents(events, [assistant(250, 'hel')]);
    events = mergeIncomingEvents(events, [assistant(600, 'hello', false)]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      timestamp: 600,
      firstSeenAt: 100,
      firstVisibleAt: 250,
      revision: 2,
    });
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
