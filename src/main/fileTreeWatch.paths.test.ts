import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeAllTreeWatchers, MAX_CHANGED_PATHS, watchTree } from './fileTreeWatch';
const directories: string[] = [];
afterEach(() => {
  closeAllTreeWatchers(); vi.restoreAllMocks(); vi.useRealTimers();
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function dir() { const result = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-paths-')); directories.push(result); return result; }
function fakeWatch() {
  vi.useFakeTimers();
  const watches: Array<{ dir: string; watcher: EventEmitter }> = [];
  vi.spyOn(fs, 'watch').mockImplementation(((root: string) => {
    const watcher = Object.assign(new EventEmitter(), { close: vi.fn() });
    watches.push({ dir: root, watcher });
    return watcher;
  }) as unknown as typeof fs.watch);
  return watches;
}
describe('changed tree paths', () => {
  it('coalesces paths and falls back to a full refresh for unnamed events', async () => {
    const root = dir(); const watches = fakeWatch(); const onChange = vi.fn();
    watchTree(root, onChange);
    watches[0].watcher.emit('change', 'change', 'a.ts');
    watches[0].watcher.emit('change', 'change', 'b.ts');
    await vi.advanceTimersByTimeAsync(300);
    expect(onChange).toHaveBeenLastCalledWith(root, [path.join(root, 'a.ts'), path.join(root, 'b.ts')]);
    watches[0].watcher.emit('change', 'change', null);
    watches[0].watcher.emit('change', 'change', 'c.ts');
    await vi.advanceTimersByTimeAsync(1500);
    expect(onChange).toHaveBeenLastCalledWith(root, undefined);
  });
  it('falls back to a full refresh once a batch names too many paths', async () => {
    const root = dir(); const watches = fakeWatch(); const onChange = vi.fn();
    watchTree(root, onChange);
    for (let i = 0; i < MAX_CHANGED_PATHS; i++) watches[0].watcher.emit('change', 'change', `file-${i}.ts`);
    await vi.advanceTimersByTimeAsync(300);
    expect(onChange).toHaveBeenLastCalledWith(root, expect.any(Array));
    expect(onChange.mock.calls[0][1]).toHaveLength(MAX_CHANGED_PATHS);
    for (let i = 0; i <= MAX_CHANGED_PATHS; i++) watches[0].watcher.emit('change', 'change', `other-${i}.ts`);
    await vi.advanceTimersByTimeAsync(1500);
    expect(onChange).toHaveBeenLastCalledWith(root, undefined);
  });
  it('maps a linked project through every workspace alias', async () => {
    const root = dir(); const target = dir();
    fs.symlinkSync(target, path.join(root, 'one'), 'dir');
    fs.symlinkSync(target, path.join(root, 'two'), 'dir');
    const watches = fakeWatch(); const onChange = vi.fn();
    watchTree(root, onChange);
    for (const watch of watches.filter(w => w.dir !== root)) watch.watcher.emit('change', 'change', 'src/a.ts');
    await vi.advanceTimersByTimeAsync(300);
    expect(onChange).toHaveBeenCalledWith(root, expect.arrayContaining([path.join(root, 'one/src/a.ts'), path.join(root, 'two/src/a.ts')]));
  });
});
