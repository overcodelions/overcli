import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerJournalEntry } from './workerJournal';

let userDataDir = '';
const { mockGetPath } = vi.hoisted(() => ({
  mockGetPath: vi.fn(() => userDataDir),
}));

vi.mock('electron', () => ({
  app: {
    getPath: mockGetPath,
  },
}));

vi.mock('../diagnostics', () => ({
  log: vi.fn(),
}));

// Re-imported fresh each test (resetModules below) so the module-level cache
// doesn't bleed state between cases.
type Store = typeof import('./workerJournal');

async function freshStore(): Promise<Store> {
  vi.resetModules();
  return import('./workerJournal');
}

function makeEntry(overrides: Partial<WorkerJournalEntry> = {}): WorkerJournalEntry {
  return {
    id: 'entry-1',
    workerId: 'worker-1',
    kind: 'proposed',
    at: 1,
    title: 'Candidate',
    ...overrides,
  };
}

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-worker-journal-'));
});

afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('workerJournal', () => {
  it('appending twice with the same id yields one entry', async () => {
    const store = await freshStore();
    store.appendWorkerJournalEntry(makeEntry());
    store.appendWorkerJournalEntry(makeEntry());
    expect(store.loadWorkerJournal('worker-1')).toHaveLength(1);
  });

  it('excludes entries for another worker', async () => {
    const store = await freshStore();
    store.appendWorkerJournalEntry(makeEntry({ id: 'one', workerId: 'worker-1' }));
    store.appendWorkerJournalEntry(makeEntry({ id: 'two', workerId: 'worker-2' }));
    expect(store.loadWorkerJournal('worker-1').map((entry) => entry.id)).toEqual(['one']);
  });

  it('loads entries newest first', async () => {
    const store = await freshStore();
    store.appendWorkerJournalEntry(makeEntry({ id: 'old', at: 1 }));
    store.appendWorkerJournalEntry(makeEntry({ id: 'new', at: 2 }));
    expect(store.loadWorkerJournal('worker-1').map((entry) => entry.id)).toEqual(['new', 'old']);
  });

  it('returns only rejected titles, lowercased and deduped', async () => {
    const store = await freshStore();
    store.appendWorkerJournalEntry(makeEntry({ id: 'one', kind: 'rejected', title: '  Fix Bug  ' }));
    store.appendWorkerJournalEntry(makeEntry({ id: 'two', kind: 'rejected', title: 'fix bug' }));
    store.appendWorkerJournalEntry(makeEntry({ id: 'three', kind: 'launched', title: 'Other Work' }));
    expect(store.workerRejectedTitles('worker-1')).toEqual(['fix bug']);
  });

  it('returns an empty digest for an unknown worker and one line per entry otherwise', async () => {
    const store = await freshStore();
    expect(store.digestWorkerJournal('unknown')).toBe('');
    store.appendWorkerJournalEntry(makeEntry({ id: 'one', at: Date.UTC(2024, 0, 1), title: 'Old' }));
    store.appendWorkerJournalEntry(makeEntry({ id: 'two', at: Date.UTC(2024, 0, 2), title: 'New' }));
    expect(store.digestWorkerJournal('worker-1')).toBe('2024-01-02 proposed: New\n2024-01-01 proposed: Old');
  });

  it('caps the journal at the maximum entry count while retaining the newest entry', async () => {
    const first = await freshStore();
    for (let i = 0; i < first.WORKER_JOURNAL_MAX_ENTRIES + 10; i++) {
      first.appendWorkerJournalEntry(makeEntry({ id: `entry-${i}`, at: i }));
    }
    const second = await freshStore();
    const loaded = second.loadWorkerJournal('worker-1');
    expect(loaded.length).toBeLessThanOrEqual(second.WORKER_JOURNAL_MAX_ENTRIES);
    expect(loaded.some((entry) => entry.id === `entry-${second.WORKER_JOURNAL_MAX_ENTRIES + 9}`)).toBe(true);
  }, 15_000);

  it('re-compacts within a single session, not only at the next launch', async () => {
    // The bound used to be enforced once per process, so a desktop app left
    // running for weeks grew monotonically and only shrank on restart.
    const store = await freshStore();
    const journalFile = path.join(userDataDir, 'worker-journal.jsonl');
    for (let i = 0; i < store.WORKER_JOURNAL_MAX_ENTRIES + 250; i++) {
      store.appendWorkerJournalEntry(makeEntry({ id: `entry-${i}`, at: i }));
    }
    // Read the file directly: no reload, no fresh import — this is the same
    // process that did the appending.
    const appended = store.WORKER_JOURNAL_MAX_ENTRIES + 250;
    const lines = fs.readFileSync(journalFile, 'utf-8').trim().split('\n');
    // In-session the file settles at the cap plus at most one compaction
    // interval of fresh appends — the point is that it no longer grows with
    // every append until the next launch.
    expect(lines.length).toBeLessThanOrEqual(store.WORKER_JOURNAL_MAX_ENTRIES + 200);
    expect(lines.length).toBeLessThan(appended);
    // The newest entry survives the compaction.
    expect(
      store.loadWorkerJournal('worker-1')[0]?.id,
    ).toBe(`entry-${store.WORKER_JOURNAL_MAX_ENTRIES + 249}`);
  }, 20_000);
});

describe('clearWorkerJournal', () => {
  it('drops one worker’s entries and keeps everybody else’s', async () => {
    const store = await freshStore();
    store.appendWorkerJournalEntry(makeEntry({ id: 'a1', workerId: 'worker-1' }));
    store.appendWorkerJournalEntry(makeEntry({ id: 'a2', workerId: 'worker-1' }));
    store.appendWorkerJournalEntry(makeEntry({ id: 'b1', workerId: 'worker-2' }));

    expect(store.clearWorkerJournal('worker-1')).toBe(2);
    expect(store.loadWorkerJournal('worker-1')).toEqual([]);
    expect(store.loadWorkerJournal('worker-2').map((e) => e.id)).toEqual(['b1']);
  });

  it('un-bans titles the worker had been told no about', async () => {
    const store = await freshStore();
    store.appendWorkerJournalEntry(
      makeEntry({ id: 'r1', kind: 'rejected', title: 'Rewrite in Rust' }),
    );
    expect(store.workerRejectedTitles('worker-1')).toEqual(['rewrite in rust']);

    store.clearWorkerJournal('worker-1');
    expect(store.workerRejectedTitles('worker-1')).toEqual([]);
  });

  it('lets a cleared entry id be appended again', async () => {
    const store = await freshStore();
    store.appendWorkerJournalEntry(makeEntry({ id: 'a1' }));
    store.clearWorkerJournal('worker-1');

    // The dedupe index is keyed by id alone, so a stale index here would
    // silently swallow the first entry of the worker's new life.
    expect(store.appendWorkerJournalEntry(makeEntry({ id: 'a1' }))).toBe(true);
    expect(store.loadWorkerJournal('worker-1').map((e) => e.id)).toEqual(['a1']);
  });

  it('is a no-op for a worker with nothing on file', async () => {
    const store = await freshStore();
    store.appendWorkerJournalEntry(makeEntry({ id: 'b1', workerId: 'worker-2' }));
    expect(store.clearWorkerJournal('worker-1')).toBe(0);
    expect(store.loadWorkerJournal('worker-2')).toHaveLength(1);
  });
});

describe('a journal that cannot be rewritten', () => {
  it('reports the failure instead of half-clearing', async () => {
    const store = await freshStore();
    store.appendWorkerJournalEntry(makeEntry({ id: 'a1' }));
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('EIO');
    });
    try {
      expect(() => store.clearWorkerJournal('worker-1')).toThrow(/rewrite/i);
    } finally {
      spy.mockRestore();
    }
    // Still there, so nothing downstream may act as if it started over.
    expect(store.loadWorkerJournal('worker-1')).toHaveLength(1);
  });
});

describe('deleteWorkerJournalEntries', () => {
  it('drops one batch’s entries and leaves the rest of the memory', async () => {
    const store = await freshStore();
    store.appendWorkerJournalEntry(makeEntry({ id: 'a', orchestrationId: 'orch-1' }));
    store.appendWorkerJournalEntry(makeEntry({ id: 'b', orchestrationId: 'orch-1' }));
    store.appendWorkerJournalEntry(makeEntry({ id: 'c', orchestrationId: 'orch-2' }));
    // Same batch id, different worker — batch ids are unique, but the filter
    // must be scoped to the worker anyway or the guarantee rests on luck.
    store.appendWorkerJournalEntry(
      makeEntry({ id: 'd', workerId: 'worker-2', orchestrationId: 'orch-1' }),
    );

    expect(store.deleteWorkerJournalEntries('worker-1', { orchestrationId: 'orch-1' })).toBe(2);

    expect(store.loadWorkerJournal('worker-1').map((e) => e.id)).toEqual(['c']);
    expect(store.loadWorkerJournal('worker-2').map((e) => e.id)).toEqual(['d']);
  });

  it('also takes entries named outright — a failed shift’s note has no batch', async () => {
    const store = await freshStore();
    store.appendWorkerJournalEntry(makeEntry({ id: 'shift-worker-1-4', kind: 'shift' }));
    store.appendWorkerJournalEntry(makeEntry({ id: 'other' }));

    expect(
      store.deleteWorkerJournalEntries('worker-1', {
        orchestrationId: 'orch-1',
        ids: ['shift-worker-1-4'],
      }),
    ).toBe(1);

    expect(store.loadWorkerJournal('worker-1').map((e) => e.id)).toEqual(['other']);
  });

  it('frees the id for re-use, so a re-run can reuse the shift number', async () => {
    const store = await freshStore();
    store.appendWorkerJournalEntry(
      makeEntry({ id: 'shift-worker-1-4', kind: 'shift', orchestrationId: 'orch-1' }),
    );
    store.deleteWorkerJournalEntries('worker-1', { orchestrationId: 'orch-1' });

    // Idempotent append is keyed on the id — without the index being dropped,
    // the re-run's note would be silently swallowed and the shift would look
    // as though it never happened.
    expect(store.hasWorkerJournalEntry('shift-worker-1-4')).toBe(false);
    expect(
      store.appendWorkerJournalEntry(
        makeEntry({ id: 'shift-worker-1-4', kind: 'shift', orchestrationId: 'orch-2' }),
      ),
    ).toBe(true);
    expect(store.loadWorkerJournal('worker-1')[0].orchestrationId).toBe('orch-2');
  });

  it('is a no-op when nothing matches', async () => {
    const store = await freshStore();
    store.appendWorkerJournalEntry(makeEntry({ id: 'a', orchestrationId: 'orch-2' }));

    expect(store.deleteWorkerJournalEntries('worker-1', { orchestrationId: 'orch-1' })).toBe(0);
    expect(store.loadWorkerJournal('worker-1')).toHaveLength(1);
  });
});
