import path from 'node:path';
import { findFileEntriesAsync, type WalkResult } from './fileWalk';

/// Shares an identical search per renderer/root/caller and cancels a
/// superseded one. The caller is part of the key: the tree's filter and the
/// file finder search the same root in the same window, and one refining its
/// query must not end the other's search.
export class FileSearchCoordinator {
  private running = new Map<string, { query: string; controller: AbortController; promise: Promise<WalkResult> }>();

  find(senderId: number, root: string, query: string, caller = ''): Promise<WalkResult> {
    const key = `${senderId}\0${caller}\0${path.resolve(root)}`;
    const normalized = query.trim().toLowerCase();
    const old = this.running.get(key);
    if (old?.query === normalized) return old.promise;
    old?.controller.abort();
    const controller = new AbortController();
    const entry = { query: normalized, controller, promise: Promise.resolve({ entries: [], truncated: false, unlistedDirs: [] } as WalkResult) };
    entry.promise = findFileEntriesAsync(root, query, 500, controller.signal)
      .catch((err: unknown) => {
        if ((err as { name?: string }).name === 'AbortError') return { entries: [], truncated: false, unlistedDirs: [] };
        throw err;
      })
      .finally(() => { if (this.running.get(key) === entry) this.running.delete(key); });
    this.running.set(key, entry);
    return entry.promise;
  }

  clear(senderId: number): void {
    for (const [key, entry] of this.running) if (key.startsWith(`${senderId}\0`)) { entry.controller.abort(); this.running.delete(key); }
  }
}
