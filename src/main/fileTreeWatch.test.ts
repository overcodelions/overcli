import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  activeTreeWatchCount,
  closeAllTreeWatchers,
  isIgnoredTreeChange,
  noteRelistCost,
  unwatchTree,
  watchTree,
} from './fileTreeWatch';

afterEach(() => {
  closeAllTreeWatchers();
});

describe('isIgnoredTreeChange', () => {
  it('keeps ordinary source writes', () => {
    expect(isIgnoredTreeChange('src/main/index.ts')).toBe(false);
    expect(isIgnoredTreeChange('README.md')).toBe(false);
    expect(isIgnoredTreeChange('docs\\design\\notes.md')).toBe(false);
  });

  it('drops changes under directories the tree never lists', () => {
    expect(isIgnoredTreeChange('node_modules/react/index.js')).toBe(true);
    expect(isIgnoredTreeChange('.git/index.lock')).toBe(true);
    expect(isIgnoredTreeChange('dist/main.js')).toBe(true);
    expect(isIgnoredTreeChange('packages/app/target/classes/A.class')).toBe(true);
  });

  it('drops editor scratch files', () => {
    expect(isIgnoredTreeChange('.DS_Store')).toBe(true);
    expect(isIgnoredTreeChange('src/index.ts~')).toBe(true);
    expect(isIgnoredTreeChange('src/.index.ts.swp')).toBe(true);
  });

  it('relists when the platform cannot name the change', () => {
    expect(isIgnoredTreeChange(null)).toBe(false);
  });

  it('drops the watched directory reporting itself', () => {
    expect(isIgnoredTreeChange('overcli', 'overcli')).toBe(true);
    // A file of the same name inside a subdirectory is a real change.
    expect(isIgnoredTreeChange('src/overcli', 'overcli')).toBe(false);
  });
});

describe('watchTree', () => {
  function tmpRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-tree-'));
  }

  it('shares one watcher between mounts and closes on the last release', () => {
    const root = tmpRoot();
    expect(watchTree(root, () => {}).ok).toBe(true);
    expect(watchTree(root, () => {}).ok).toBe(true);
    expect(activeTreeWatchCount()).toBe(1);
    unwatchTree(root);
    expect(activeTreeWatchCount()).toBe(1);
    unwatchTree(root);
    expect(activeTreeWatchCount()).toBe(0);
  });

  it('returns the resolved root as the change key', () => {
    const root = tmpRoot();
    const res = watchTree(path.join(root, 'sub', '..'), () => {});
    expect(res.key).toBe(path.resolve(root));
    unwatchTree(root);
  });

  it('reports a failure rather than throwing for a missing root', () => {
    const res = watchTree(path.join(os.tmpdir(), 'overcli-tree-does-not-exist'), () => {});
    expect(res.ok).toBe(false);
    expect(activeTreeWatchCount()).toBe(0);
  });

  it('fires once for a burst of writes', async () => {
    const root = tmpRoot();
    const keys: string[] = [];
    expect(watchTree(root, (key) => keys.push(key)).ok).toBe(true);
    await armed();
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(root, `note-${i}.md`), 'hello');
    }
    await waitFor(() => keys.length > 0, 4000);
    // The debounce window is 300ms; give it room to (not) fire again.
    await delay(600);
    expect(keys).toEqual([path.resolve(root)]);
    unwatchTree(root);
  });

  it('spaces out relists while writes keep coming', async () => {
    const root = tmpRoot();
    const fires: number[] = [];
    expect(watchTree(root, () => fires.push(Date.now())).ok).toBe(true);
    await armed();
    fs.writeFileSync(path.join(root, 'first.md'), 'hello');
    await waitFor(() => fires.length > 0, 4000);
    fs.writeFileSync(path.join(root, 'second.md'), 'hello');
    // The second relist waits out the minimum gap rather than following
    // 300ms behind the first.
    await delay(600);
    expect(fires).toHaveLength(1);
    await waitFor(() => fires.length > 1, 4000);
    expect(fires[1] - fires[0]).toBeGreaterThanOrEqual(1_000);
    unwatchTree(root);
  });

  it('backs off further when the root is expensive to list', async () => {
    const root = tmpRoot();
    const fires: number[] = [];
    expect(watchTree(root, () => fires.push(Date.now())).ok).toBe(true);
    // Half a second to list — the pace has to come off the floor.
    noteRelistCost(root, 500);
    await armed();
    fs.writeFileSync(path.join(root, 'first.md'), 'hello');
    await waitFor(() => fires.length > 0, 4000);
    fs.writeFileSync(path.join(root, 'second.md'), 'hello');
    await delay(2_000);
    expect(fires).toHaveLength(1);
    unwatchTree(root);
  }, 15_000);

  it('sees writes through a workspace root of symlinks', async () => {
    const root = tmpRoot();
    const project = tmpRoot();
    fs.symlinkSync(project, path.join(root, 'member'), 'dir');
    const keys: string[] = [];
    expect(watchTree(root, (key) => keys.push(key)).ok).toBe(true);
    await armed();
    // A recursive watch on `root` alone never sees this — the write lands
    // in the link target, outside the watched subtree.
    fs.writeFileSync(path.join(project, 'src.ts'), 'hello');
    await waitFor(() => keys.length > 0, 4000);
    expect(keys[0]).toBe(path.resolve(root));
    unwatchTree(root);
  });

  it('stays quiet for writes under a skipped directory', async () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true });
    const keys: string[] = [];
    expect(watchTree(root, (key) => keys.push(key)).ok).toBe(true);
    await armed();
    fs.writeFileSync(path.join(root, 'node_modules', 'dep', 'index.js'), 'x');
    await delay(1200);
    expect(keys).toEqual([]);
    unwatchTree(root);
  });
});

/// A recursive watch doesn't see writes made in the instant after it starts
/// — macOS arms the FSEvents stream asynchronously. The app watches from the
/// moment the pane mounts, so this only matters to tests writing immediately.
function armed(): Promise<void> {
  return delay(500);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error('waitFor timed out');
}
