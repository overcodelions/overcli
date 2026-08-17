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
