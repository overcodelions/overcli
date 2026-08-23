// `protectProject` and `createEverydayProject` are the two store actions
// behind "Everyday projects": turning on history for an existing project,
// and scaffolding + registering a brand new one in a single flow.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/types';

type InvokeResult = { ok: boolean; [key: string]: unknown };

const initRepoResult = { current: { ok: true, branch: 'main' } as InvokeResult };
const createEverydayProjectResult = {
  current: { ok: true, path: '/Users/x/Documents/Overcli Projects/Marketing copy review', historyOn: true } as InvokeResult,
};
const commitStatusResult = { current: { isRepo: true } as { isRepo: boolean } };
const setMarkerResult = { current: { ok: true } as InvokeResult };
const invoked: Array<{ channel: string; args: unknown }> = [];

function stubBridge(): void {
  const invoke = vi.fn(async (channel: string, args: unknown) => {
    invoked.push({ channel, args });
    if (channel === 'git:initRepo') return initRepoResult.current;
    if (channel === 'fs:createEverydayProject') return createEverydayProjectResult.current;
    if (channel === 'git:commitStatus') return commitStatusResult.current;
    if (channel === 'fs:setEverydayMarker') return setMarkerResult.current;
    if (channel === 'store:saveProjects' || channel === 'store:saveSettings' || channel === 'store:saveSelection') {
      return undefined;
    }
    return undefined;
  });
  (globalThis as unknown as { window: unknown }).window = {
    overcli: { invoke, onMainEvent: () => () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

stubBridge();

const { useStore } = await import('./store');

function project(over: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'proj',
    path: '/Users/x/git/proj',
    conversations: [],
    ...over,
  } as Project;
}

beforeEach(() => {
  invoked.length = 0;
  initRepoResult.current = { ok: true, branch: 'main' };
  createEverydayProjectResult.current = {
    ok: true,
    path: '/Users/x/Documents/Overcli Projects/Marketing copy review',
    historyOn: true,
  };
  commitStatusResult.current = { isRepo: true };
  setMarkerResult.current = { ok: true };
  useStore.setState({
    projects: [],
    settings: { ...DEFAULT_SETTINGS },
    projectIsGitRepo: {},
  } as never);
});

describe('protectProject', () => {
  it('errors when the project is not found', async () => {
    const res = await useStore.getState().protectProject('missing' as never);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('not found');
  });

  it('inits the repo at the project path and refreshes git status on success', async () => {
    useStore.setState({ projects: [project()] } as never);

    const res = await useStore.getState().protectProject('proj-1' as never);

    expect(res).toEqual({ ok: true, branch: 'main' });
    expect(invoked).toContainEqual({ channel: 'git:initRepo', args: { projectPath: '/Users/x/git/proj' } });
    expect(invoked.some((c) => c.channel === 'git:commitStatus')).toBe(true);
    expect(useStore.getState().projectIsGitRepo['proj-1']).toBe(true);
  });

  it('does not refresh git status when init fails', async () => {
    initRepoResult.current = { ok: false, error: 'already has a history.' };
    useStore.setState({ projects: [project()] } as never);

    const res = await useStore.getState().protectProject('proj-1' as never);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('already has a history.');
    expect(invoked.some((c) => c.channel === 'git:commitStatus')).toBe(false);
  });
});

describe('createEverydayProject', () => {
  it('registers the scaffolded folder as a project and focuses it', async () => {
    const res = await useStore.getState().createEverydayProject('Marketing copy review', 'Review our drafts.');

    expect(res.ok).toBe(true);
    const created = useStore.getState().projects.find((p) => p.name === 'Marketing copy review');
    expect(created?.path).toBe('/Users/x/Documents/Overcli Projects/Marketing copy review');
    expect(useStore.getState().focusedProjectId).toBe(created?.id);
  });

  it('falls back to the folder name when the title is blank', async () => {
    await useStore.getState().createEverydayProject('   ', 'Do the thing.');

    const created = useStore.getState().projects[0];
    expect(created.name).toBe('Marketing copy review');
  });

  // Plain-language change labels used to be a global setting flipped on here,
  // which meant trying one everyday project relabelled the changes bar in
  // every repo the user owned. It is derived per project now, so creating one
  // must not write settings at all.
  it('does not touch global settings — the vocabulary is per project', async () => {
    await useStore.getState().createEverydayProject('Marketing copy review', 'Review our drafts.');

    expect(invoked.some((c) => c.channel === 'store:saveSettings')).toBe(false);
  });

  it('registers no project and returns the error when scaffolding fails', async () => {
    createEverydayProjectResult.current = { ok: false, error: 'disk full' };

    const res = await useStore.getState().createEverydayProject('Marketing copy review', 'Review our drafts.');

    expect(res).toEqual({ ok: false, error: 'disk full' });
    expect(useStore.getState().projects).toHaveLength(0);
  });
});

// Converting a folder someone already has, in both directions. The order
// matters more than the individual steps: history has to exist before the
// app promises undo in plain words.
describe('convertToEverydayProject', () => {
  it('errors when the project is not found', async () => {
    const res = await useStore.getState().convertToEverydayProject('missing' as never);
    expect(res.ok).toBe(false);
  });

  it('turns on history first, then marks the folder and flags the project', async () => {
    useStore.setState({ projects: [project()], projectIsGitRepo: { 'proj-1': false } } as never);

    const res = await useStore.getState().convertToEverydayProject('proj-1' as never);

    expect(res).toEqual({ ok: true });
    const channels = invoked.map((c) => c.channel);
    expect(channels.indexOf('git:initRepo')).toBeLessThan(channels.indexOf('fs:setEverydayMarker'));
    expect(invoked).toContainEqual({
      channel: 'fs:setEverydayMarker',
      args: { projectPath: '/Users/x/git/proj', everyday: true },
    });
    expect(useStore.getState().projects[0].everyday).toBe(true);
    expect(useStore.getState().everydayRoots).toEqual(['/Users/x/git/proj']);
  });

  it('skips the init for a folder that already has history', async () => {
    useStore.setState({ projects: [project()], projectIsGitRepo: { 'proj-1': true } } as never);

    await useStore.getState().convertToEverydayProject('proj-1' as never);

    expect(invoked.some((c) => c.channel === 'git:initRepo')).toBe(false);
    expect(useStore.getState().projects[0].everyday).toBe(true);
  });

  // The whole everyday framing promises "you can undo anything". A folder
  // that could not get a history must not be relabelled as though it could.
  it('relabels nothing when history cannot be turned on', async () => {
    initRepoResult.current = { ok: false, error: 'too large' };
    useStore.setState({ projects: [project()], projectIsGitRepo: { 'proj-1': false } } as never);

    const res = await useStore.getState().convertToEverydayProject('proj-1' as never);

    expect(res).toEqual({ ok: false, error: 'too large' });
    expect(invoked.some((c) => c.channel === 'fs:setEverydayMarker')).toBe(false);
    expect(useStore.getState().projects[0].everyday).toBeUndefined();
  });

  it('leaves the flag alone when the marker cannot be written', async () => {
    setMarkerResult.current = { ok: false, error: 'read-only folder' };
    useStore.setState({ projects: [project()], projectIsGitRepo: { 'proj-1': true } } as never);

    const res = await useStore.getState().convertToEverydayProject('proj-1' as never);

    expect(res).toEqual({ ok: false, error: 'read-only folder' });
    expect(useStore.getState().projects[0].everyday).toBeUndefined();
  });
});

describe('revertEverydayProject', () => {
  // `false`, not `undefined`: `syncProjectMarkers` back-fills a marker for
  // anything still flagged true, and an absent flag would be re-marked on the
  // next load — the revert would silently undo itself.
  it('clears the marker and pins the flag to false', async () => {
    useStore.setState({
      projects: [project({ everyday: true })],
      everydayRoots: ['/Users/x/git/proj'],
    } as never);

    const res = await useStore.getState().revertEverydayProject('proj-1' as never);

    expect(res).toEqual({ ok: true });
    expect(invoked).toContainEqual({
      channel: 'fs:setEverydayMarker',
      args: { projectPath: '/Users/x/git/proj', everyday: false },
    });
    expect(useStore.getState().projects[0].everyday).toBe(false);
    expect(useStore.getState().everydayRoots).toEqual([]);
  });

  // Undo history is the user's by the time they change their mind; dropping
  // it is a separate, separately-confirmed decision.
  it('leaves the history in place', async () => {
    useStore.setState({ projects: [project({ everyday: true })] } as never);

    await useStore.getState().revertEverydayProject('proj-1' as never);

    expect(invoked.some((c) => c.channel === 'git:removeHistory')).toBe(false);
  });

  it('keeps the flag when the marker cannot be cleared', async () => {
    setMarkerResult.current = { ok: false, error: 'permission denied' };
    useStore.setState({ projects: [project({ everyday: true })] } as never);

    const res = await useStore.getState().revertEverydayProject('proj-1' as never);

    expect(res).toEqual({ ok: false, error: 'permission denied' });
    expect(useStore.getState().projects[0].everyday).toBe(true);
  });
});
