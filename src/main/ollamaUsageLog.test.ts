// The Ollama token log is the only record of local model spend — nothing
// else on disk has the counts. It has to survive a missing file, a torn
// line from a crash mid-append, and unbounded growth.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let userDataDir: string;
vi.mock('electron', () => ({ app: { getPath: () => userDataDir } }));

import {
  MAX_ENTRIES,
  MIN_BYTES_PER_ENTRY,
  TRIM_SLACK,
  ollamaUsageLogPath,
  readOllamaUsage,
  recordOllamaUsage,
} from './ollamaUsageLog';

const entry = (over: Partial<Parameters<typeof recordOllamaUsage>[0]> = {}) => ({
  ts: 1_700_000_000_000,
  cwd: '/tmp/proj',
  model: 'gemma4:26b',
  inputTokens: 100,
  outputTokens: 20,
  ...over,
});

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-usage-'));
});

afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('recordOllamaUsage / readOllamaUsage', () => {
  it('returns nothing when the log has never been written', () => {
    expect(readOllamaUsage()).toEqual([]);
  });

  it('appends rounds and reads them back in order', () => {
    recordOllamaUsage(entry());
    recordOllamaUsage(entry({ ts: 1_700_000_060_000, outputTokens: 55 }));
    const rows = readOllamaUsage();
    expect(rows).toHaveLength(2);
    expect(rows[0].inputTokens).toBe(100);
    expect(rows[1].outputTokens).toBe(55);
    expect(rows[1].model).toBe('gemma4:26b');
  });

  it('drops rounds with no counts rather than logging a zero row', () => {
    recordOllamaUsage(entry({ inputTokens: 0, outputTokens: 0 }));
    expect(readOllamaUsage()).toEqual([]);
  });

  it('skips a torn line instead of losing the whole log', () => {
    recordOllamaUsage(entry());
    fs.appendFileSync(ollamaUsageLogPath(), '{"ts":170000006', 'utf-8');
    recordOllamaUsage(entry({ ts: 1_700_000_120_000 }));
    const rows = readOllamaUsage();
    expect(rows.map((r) => r.ts)).toEqual([1_700_000_000_000, 1_700_000_120_000]);
  });

  it('ignores rows without a usable timestamp', () => {
    fs.writeFileSync(ollamaUsageLogPath(), '{"cwd":"/tmp","inputTokens":5}\n', 'utf-8');
    expect(readOllamaUsage()).toEqual([]);
  });

  it('trims the log once it grows past the cap', () => {
    const lines = Array.from(
      { length: 56_000 },
      (_, i) => JSON.stringify(entry({ ts: 1_700_000_000_000 + i })),
    ).join('\n');
    fs.writeFileSync(ollamaUsageLogPath(), `${lines}\n`, 'utf-8');
    recordOllamaUsage(entry({ ts: 1_800_000_000_000 }));
    const rows = readOllamaUsage();
    expect(rows).toHaveLength(50_000);
    // The newest round survives; the oldest are the ones dropped.
    expect(rows[rows.length - 1].ts).toBe(1_800_000_000_000);
    expect(rows[0].ts).toBeGreaterThan(1_700_000_000_000);
  });

  it('sets the precheck threshold above a freshly-trimmed file, not below it', () => {
    // A freshly-trimmed file holds MAX_ENTRIES lines at ~90 bytes each. The
    // precheck threshold is (MAX_ENTRIES + TRIM_SLACK) * MIN_BYTES_PER_ENTRY;
    // if that sits BELOW the trimmed size, every append after a trim would
    // re-trigger a full read, which is the bug this constant guards against.
    expect(MAX_ENTRIES * 90 > (MAX_ENTRIES + TRIM_SLACK) * MIN_BYTES_PER_ENTRY).toBe(false);
  });
});
