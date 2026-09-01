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

import { useTestHost } from './testHost';

let userDataDir: string;

useTestHost(() => userDataDir);

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

// Open editor tabs are persisted per scope so returning to a conversation
// reopens the files you had there. Two things have to hold: what reaches
// disk stays bounded (this file is rewritten on every mutation), and what
// comes back is openable — a strip of tabs that all render "this file was
// deleted" is worse than no restore at all.
describe('file tabs', () => {
  it('persists tabs per scope', async () => {
    const { Store, flushStoreSync } = await loadStore();
    Store.saveFileTabs({
      'conv:c1': { paths: ['/tmp/a.ts', '/tmp/b.ts'], activePath: '/tmp/b.ts' },
    });
    flushStoreSync();
    expect(readPersisted().fileTabs).toEqual({
      'conv:c1': { paths: ['/tmp/a.ts', '/tmp/b.ts'], activePath: '/tmp/b.ts' },
    });
  });

  it('caps paths per scope and drops duplicates', async () => {
    const { Store, flushStoreSync } = await loadStore();
    const paths = Array.from({ length: 40 }, (_, i) => `/tmp/f${i}.ts`);
    Store.saveFileTabs({ 'conv:c1': { paths: [...paths, '/tmp/f0.ts'] } });
    flushStoreSync();
    const saved = (readPersisted().fileTabs as Record<string, { paths: string[] }>)['conv:c1'];
    expect(saved.paths).toHaveLength(12);
    expect(new Set(saved.paths).size).toBe(12);
  });

  it('caps how many scopes reach disk, keeping the most recent', async () => {
    const { Store, flushStoreSync } = await loadStore();
    const tabs: Record<string, { paths: string[] }> = {};
    for (let i = 0; i < 200; i += 1) tabs[`conv:c${i}`] = { paths: [`/tmp/f${i}.ts`] };
    Store.saveFileTabs(tabs);
    flushStoreSync();
    const saved = readPersisted().fileTabs as Record<string, unknown>;
    expect(Object.keys(saved)).toHaveLength(60);
    expect(saved['conv:c199']).toBeDefined();
    expect(saved['conv:c0']).toBeUndefined();
  });

  it('repairs an activePath that is not in the list', async () => {
    const { Store, flushStoreSync } = await loadStore();
    Store.saveFileTabs({ 'conv:c1': { paths: ['/tmp/a.ts'], activePath: '/tmp/gone.ts' } });
    flushStoreSync();
    const saved = (readPersisted().fileTabs as Record<string, { activePath: string }>)['conv:c1'];
    expect(saved.activePath).toBe('/tmp/a.ts');
  });

  it('ignores malformed entries rather than persisting them', async () => {
    const { Store, flushStoreSync } = await loadStore();
    Store.saveFileTabs({
      'conv:c1': { paths: ['' as never, 42 as never] },
      'conv:c2': { paths: 'nope' as never },
      'conv:c3': { paths: ['/tmp/ok.ts'] },
    });
    flushStoreSync();
    expect(Object.keys(readPersisted().fileTabs as object)).toEqual(['conv:c3']);
  });

  it('prunes files that have left disk and scopes for deleted conversations', async () => {
    const { Store, flushStoreSync } = await loadStore();
    const alive = path.join(userDataDir, 'alive.ts');
    fs.writeFileSync(alive, 'x');
    Store.saveProjects([project('p1', [{ id: 'c1', name: 'one' }])] as never);
    Store.saveFileTabs({
      'conv:c1': { paths: [alive, path.join(userDataDir, 'gone.ts')], activePath: path.join(userDataDir, 'gone.ts') },
      'conv:deleted': { paths: [alive] },
      'explorer:/tmp/repo': { paths: [alive] },
    });

    await Store.pruneFileTabs();
    flushStoreSync();

    const saved = readPersisted().fileTabs as Record<string, { paths: string[]; activePath: string }>;
    expect(Object.keys(saved).sort()).toEqual(['conv:c1', 'explorer:/tmp/repo']);
    expect(saved['conv:c1'].paths).toEqual([alive]);
    // The active file was the one that vanished; fall back to a live tab.
    expect(saved['conv:c1'].activePath).toBe(alive);
  });

  it('leaves relative workspace-member paths alone when pruning', async () => {
    // `<member>/src/foo.ts` only resolves against a root the renderer
    // holds, so main can't stat it — dropping it would silently lose every
    // workspace-conversation tab.
    const { Store, flushStoreSync } = await loadStore();
    Store.saveProjects([project('p1', [{ id: 'c1', name: 'one' }])] as never);
    Store.saveFileTabs({ 'conv:c1': { paths: ['member/src/foo.ts'] } });

    await Store.pruneFileTabs();
    flushStoreSync();

    const saved = readPersisted().fileTabs as Record<string, { paths: string[] }>;
    expect(saved['conv:c1'].paths).toEqual(['member/src/foo.ts']);
  });

  it('drops unopenable tabs on load through the same sanitizer', async () => {
    const { Store, flushStoreSync, loadState } = await loadStore();
    Store.saveFileTabs({ 'conv:c1': { paths: ['/tmp/a.ts'] } });
    flushStoreSync();
    // Hand-edit the file the way an older build (or a bug) might have.
    const raw = readPersisted();
    raw.fileTabs = { 'conv:c1': { paths: [] }, 'conv:c2': null };
    fs.writeFileSync(storeFile(), JSON.stringify(raw));
    expect(loadState().fileTabs).toBeUndefined();
  });
});

describe('model lifting on load', () => {
  let loadState: Awaited<ReturnType<typeof loadStore>>['loadState'];

  beforeEach(async () => {
    ({ loadState } = await loadStore());
  });

  /// Seed overcli.json the way a build from before the catalog moved would
  /// have written it, then read it back through the real load path.
  function loadWithConversation(conv: Record<string, unknown>) {
    fs.writeFileSync(
      storeFile(),
      JSON.stringify({
        projects: [{ ...project('p1', []), conversations: [{ id: 'c1', name: 'one', ...conv }] }],
      }),
    );
    return loadState();
  }

  function conversation(state: ReturnType<typeof loadState>) {
    return state.projects[0].conversations[0] as unknown as Record<string, unknown>;
  }

  it('lifts a conversation pinned to a superseded model', () => {
    const state = loadWithConversation({
      primaryBackend: 'claude',
      currentModel: 'claude-fable-5',
      claudeModel: 'claude-fable-5',
    });
    // Flows lift through parseFlowYaml; without this the next send failed the
    // catalog check and the user had to repick the model by hand.
    expect(conversation(state).currentModel).toBe('claude-fable-5-1');
    expect(conversation(state).claudeModel).toBe('claude-fable-5-1');
  });

  it('lifts each per-backend pin against its own backend', () => {
    const state = loadWithConversation({
      primaryBackend: 'claude',
      currentModel: 'claude-opus-5',
      codexModel: 'gpt-5.2',
      geminiModel: 'gemini-2.5-pro',
    });
    expect(conversation(state).codexModel).toBe('gpt-5.4');
    expect(conversation(state).geminiModel).toBe('gemini-3.1-pro');
  });

  it('drops a retired model with no successor so the send falls back to the default', () => {
    // The whole `gpt-*-codex` line is gone, so there is nothing to lift to.
    const state = loadWithConversation({ primaryBackend: 'codex', codexModel: 'gpt-5.3-codex' });
    expect(conversation(state).codexModel).toBeUndefined();
  });

  it('leaves ollama tags alone — they are local pulls, not catalog ids', () => {
    const state = loadWithConversation({
      primaryBackend: 'ollama',
      currentModel: 'qwen2.5-coder:32b',
      ollamaModel: 'qwen2.5-coder:32b',
      reviewOllamaModel: 'qwen2.5-coder:32b',
    });
    expect(conversation(state).currentModel).toBe('qwen2.5-coder:32b');
    expect(conversation(state).ollamaModel).toBe('qwen2.5-coder:32b');
    expect(conversation(state).reviewOllamaModel).toBe('qwen2.5-coder:32b');
  });

  it('leaves a legacy conversation with no primaryBackend alone', () => {
    // Without a backend we can't tell a stale catalog id from a local tag,
    // and rewriting the latter would point the conversation at nothing.
    const state = loadWithConversation({ currentModel: 'some-local-tag' });
    expect(conversation(state).currentModel).toBe('some-local-tag');
  });

  it('lifts the reviewer pin against the reviewer backend, not the primary', () => {
    const state = loadWithConversation({
      primaryBackend: 'claude',
      currentModel: 'claude-opus-5',
      reviewBackend: 'codex',
      reviewModel: 'gpt-5.2',
    });
    expect(conversation(state).reviewModel).toBe('gpt-5.4');
  });

  it('lifts settings pins instead of clearing them', () => {
    fs.writeFileSync(
      storeFile(),
      JSON.stringify({
        settings: {
          backendDefaultModels: { claude: 'claude-fable-5' },
          flowModelDefaults: { claude: { frontier: 'claude-fable-5' } },
        },
      }),
    );
    const state = loadState();
    // Dropping the pin would silently fall back to auto; lifting keeps the
    // user's explicit choice pointed at the model that replaced it.
    expect(state.settings.backendDefaultModels?.claude).toBe('claude-fable-5-1');
    expect(state.settings.flowModelDefaults?.claude?.frontier).toBe('claude-fable-5-1');
  });
});
