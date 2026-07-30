// Persistence behavior for the disk-backed app store.
//
// The store used to write synchronously on every mutation. With a real
// conversation list that meant serializing hundreds of KB on the single
// main-process thread — the same thread that brokers every streaming IPC
// message — so a few agents finishing turns at once stalled the window.
// Writes are now debounced and async, which buys throughput at the cost of
// three things that can silently regress:
//
//   1. a mutation inside the debounce window must still reach disk,
//   2. a quit inside that window must not drop the last mutation,
//   3. the write must stay atomic (no half-written JSON on next launch).
//
// Plus `patchConversation`, the targeted write that replaced the bulk save
// on the hottest path (turn completion).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let userDataDir: string;

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
}));

/// The store module holds its debounce timer in module scope, so every
/// `loadStore()` produces a fresh, independently-armed instance. Tests that
/// leave one armed used to leak across the file: the timer fires during a
/// LATER test and writes to whatever `userDataDir` is current by then
/// (`storePath()` re-reads the mocked `app.getPath` at write time), which
/// showed up as a phantom extra `fs.promises.writeFile` call in the
/// coalescing test. `afterEach` disarms the instance via `flushStoreSync`.
let loaded: Awaited<ReturnType<typeof loadStore>> | null = null;

async function loadStore() {
  vi.resetModules();
  const mod = await import('./store');
  loaded = mod;
  return mod;
}

function storeFile(): string {
  return path.join(userDataDir, 'overcli.json');
}

function readPersisted(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(storeFile(), 'utf-8'));
}

/// Real timers on purpose: the debounced write ends in genuine libuv file
/// I/O, which fake timers can't advance past. Poll for the outcome instead
/// of guessing a sleep duration.
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the store write');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function persistedProjectIds(): string[] {
  return (readPersisted().projects as { id: string }[]).map((p) => p.id);
}

function project(id: string, conversations: { id: string; name: string }[]) {
  return { id, name: `p-${id}`, path: `/tmp/${id}`, conversations };
}

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-store-'));
});

afterEach(() => {
  // Disarm any pending debounced write before this test's temp dir goes
  // away, so it can't fire into the next test's directory. Writes into the
  // dir we're about to delete, which is the point.
  loaded?.flushStoreSync();
  loaded = null;
  vi.restoreAllMocks();
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('store persistence', () => {
  it('does not touch disk synchronously on save', async () => {
    const { Store } = await loadStore();
    Store.saveProjects([project('a', [])] as never);
    // The whole point of the change: the caller returns before any I/O.
    expect(fs.existsSync(storeFile())).toBe(false);
  });

  it('writes once the debounce window elapses', async () => {
    const { Store } = await loadStore();
    Store.saveProjects([project('a', [{ id: 'c1', name: 'one' }])] as never);
    await waitFor(() => fs.existsSync(storeFile()));
    expect(readPersisted().projects).toHaveLength(1);
  });

  it('coalesces a burst of saves into a single write carrying the last state', async () => {
    const { Store, SAVE_DEBOUNCE_MS } = await loadStore();
    const writeSpy = vi.spyOn(fs.promises, 'writeFile');
    for (let i = 0; i < 25; i++) {
      Store.saveProjects([project(`p${i}`, [])] as never);
    }
    await waitFor(() => fs.existsSync(storeFile()));
    // Give any (incorrectly) queued follow-up writes a chance to land before
    // asserting the count, so this can't pass by racing them.
    await new Promise((resolve) => setTimeout(resolve, SAVE_DEBOUNCE_MS * 2));

    expect(writeSpy).toHaveBeenCalledTimes(1);
    // Coalescing must not lose the newest state — the payload is read at
    // fire time, not at call time.
    expect(persistedProjectIds()[0]).toBe('p24');
    writeSpy.mockRestore();
  });

  it('flushes synchronously so a quit inside the debounce window keeps the last mutation', async () => {
    const { Store, flushStoreSync } = await loadStore();
    Store.saveProjects([project('late', [{ id: 'c9', name: 'unsaved' }])] as never);
    expect(fs.existsSync(storeFile())).toBe(false);

    flushStoreSync();

    expect((readPersisted().projects as { id: string }[])[0].id).toBe('late');
  });

  it('leaves no tmp file behind after a write', async () => {
    const { Store } = await loadStore();
    Store.saveProjects([project('a', [])] as never);
    await waitFor(() => fs.existsSync(storeFile()));
    expect(fs.existsSync(`${storeFile()}.tmp`)).toBe(false);
  });

  it('keeps persisting after a flush, so a cancelled quit is not fatal', async () => {
    const { Store, flushStoreSync } = await loadStore();
    Store.saveProjects([project('first', [])] as never);
    flushStoreSync();
    expect(persistedProjectIds()[0]).toBe('first');

    Store.saveProjects([project('second', [])] as never);
    await waitFor(() => persistedProjectIds()[0] === 'second');

    expect(persistedProjectIds()[0]).toBe('second');
  });
});

describe('patchConversation', () => {
  it('updates a single conversation without disturbing its siblings', async () => {
    const { Store, flushStoreSync } = await loadStore();
    Store.saveProjects([
      project('a', [
        { id: 'c1', name: 'one' },
        { id: 'c2', name: 'two' },
      ]),
    ] as never);

    const ok = Store.patchConversation('c2' as never, { name: 'renamed' } as never);
    flushStoreSync();

    expect(ok).toBe(true);
    const convs = (readPersisted().projects as { conversations: { id: string; name: string }[] }[])[0]
      .conversations;
    expect(convs.map((c) => c.name)).toEqual(['one', 'renamed']);
  });

  it('finds conversations that live on a workspace rather than a project', async () => {
    const { Store, flushStoreSync } = await loadStore();
    Store.saveWorkspaces([
      { id: 'w1', name: 'ws', rootPath: '/tmp/ws', projectIds: [], conversations: [{ id: 'wc1', name: 'x' }] },
    ] as never);

    const ok = Store.patchConversation('wc1' as never, { name: 'y' } as never);
    flushStoreSync();

    expect(ok).toBe(true);
    const wss = readPersisted().workspaces as { conversations: { name: string }[] }[];
    expect(wss[0].conversations[0].name).toBe('y');
  });

  it('reports a miss so the caller can fall back to a full save', async () => {
    const { Store } = await loadStore();
    Store.saveProjects([project('a', [{ id: 'c1', name: 'one' }])] as never);
    expect(Store.patchConversation('nope' as never, { name: 'x' } as never)).toBe(false);
  });
});
