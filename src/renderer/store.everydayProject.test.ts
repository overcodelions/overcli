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
const invoked: Array<{ channel: string; args: unknown }> = [];

function stubBridge(): void {
  const invoke = vi.fn(async (channel: string, args: unknown) => {
    invoked.push({ channel, args });
    if (channel === 'git:initRepo') return initRepoResult.current;
    if (channel === 'fs:createEverydayProject') return createEverydayProjectResult.current;
    if (channel === 'git:commitStatus') return commitStatusResult.current;
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
