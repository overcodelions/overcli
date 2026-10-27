import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findFileEntriesAsync, type WalkResult } from './fileWalk';
import { FileSearchCoordinator } from './fileSearch';
vi.mock('./fileWalk', () => ({ findFileEntriesAsync: vi.fn() }));
const empty: WalkResult = { entries: [], truncated: false, unlistedDirs: [] };
let requests: Array<{ signal: AbortSignal; resolve: (result: WalkResult) => void; reject: (error: Error) => void }>;
beforeEach(() => {
  requests = [];
  vi.mocked(findFileEntriesAsync).mockImplementation((_root, _query, _limit, signal) => new Promise((resolve, reject) => {
    requests.push({ signal: signal!, resolve, reject });
  }));
});
describe('file search ownership', () => {
  it('shares identical queries and aborts refined queries without late cleanup removing replacements', async () => {
    const search = new FileSearchCoordinator();
    const first = search.find(1, '/repo', ' Auth ');
    expect(search.find(1, '/repo', 'auth')).toBe(first);
    const refined = search.find(1, '/repo', 'authz');
    expect(requests[0].signal.aborted).toBe(true);
    requests[0].reject(new DOMException('Aborted', 'AbortError'));
    await expect(first).resolves.toEqual(empty);
    expect(search.find(1, '/repo', 'AUTHZ')).toBe(refined);
    requests[1].resolve(empty);
    await refined;
  });
  it('keeps the tree filter and the file finder from cancelling each other on one root', async () => {
    const search = new FileSearchCoordinator();
    const tree = search.find(1, '/repo', 'auth', 'tree');
    const finder = search.find(1, '/repo', 'auth', 'finder');
    expect(finder).not.toBe(tree);
    expect(requests.map(r => r.signal.aborted)).toEqual([false, false]);
    search.find(1, '/repo', 'authz', 'finder');
    expect(requests.map(r => r.signal.aborted)).toEqual([false, true, false]);
    for (const request of requests) request.resolve(empty);
    await Promise.all([tree, finder]);
  });
  it('isolates windows and releases all work for a destroyed sender', async () => {
    const search = new FileSearchCoordinator();
    const first = search.find(1, '/repo', 'a');
    const otherRoot = search.find(1, '/another', 'b');
    const otherWindow = search.find(2, '/repo', 'a');
    search.clear(1);
    expect(requests.map(r => r.signal.aborted)).toEqual([true, true, false]);
    for (const request of requests) request.resolve(empty);
    await Promise.all([first, otherRoot, otherWindow]);
  });
});
