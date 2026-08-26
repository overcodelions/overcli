// `noteVersionsRestored` runs after `git read-tree -u --reset`, which
// rewrites the WHOLE working tree — not just the file that was open. A dirty
// buffer left behind for any other file under the project is stale and would
// auto-save right back over the restore.

import { beforeEach, describe, expect, it, vi } from 'vitest';

function stubBridge(): void {
  const invoke = vi.fn(async () => undefined);
  (globalThis as unknown as { window: unknown }).window = {
    overcli: { invoke, onMainEvent: () => () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

stubBridge();

const { useStore } = await import('./store');

beforeEach(() => {
  useStore.setState({
    dirtyFiles: {},
    versionRestoreToken: 0,
  } as never);
});

describe('noteVersionsRestored', () => {
  it('drops every dirty buffer under the restored project, and leaves other projects alone', () => {
    useStore.setState({
      dirtyFiles: {
        '/Users/x/git/proj/a.md': true,
        '/Users/x/git/proj/nested/b.md': true,
        '/Users/x/git/other-proj/c.md': true,
      },
    } as never);

    useStore.getState().noteVersionsRestored('/Users/x/git/proj');

    expect(useStore.getState().dirtyFiles).toEqual({
      '/Users/x/git/other-proj/c.md': true,
    });
  });

  it('bumps versionRestoreToken so an open editor knows to re-read from disk', () => {
    const before = useStore.getState().versionRestoreToken;

    useStore.getState().noteVersionsRestored('/Users/x/git/proj');

    expect(useStore.getState().versionRestoreToken).toBe(before + 1);
  });
});
