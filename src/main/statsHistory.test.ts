import { describe, expect, it } from 'vitest';
import { DailyBucket } from '../shared/types';
import { DailyHistory, mergeDailyHistory, mergeDay, trimHistory } from './statsHistory';

function day(
  d: string,
  byBackend: Partial<Record<'claude' | 'codex', Partial<{ turns: number; inputTokens: number }>>>,
): DailyBucket {
  const full: any = {};
  let turns = 0;
  let inputTokens = 0;
  for (const [b, v] of Object.entries(byBackend)) {
    full[b] = {
      turns: v?.turns ?? 0,
      inputTokens: v?.inputTokens ?? 0,
      outputTokens: 0,
      linesAdded: 0,
      linesDeleted: 0,
    };
    turns += full[b].turns;
    inputTokens += full[b].inputTokens;
  }
  return { day: d, turns, inputTokens, outputTokens: 0, linesAdded: 0, linesDeleted: 0, byBackend: full };
}

describe('mergeDay', () => {
  it('keeps the stored value when the scan has lost the transcripts', () => {
    const stored = day('2026-05-01', { claude: { turns: 40, inputTokens: 900 } });
    // Claude pruned the day; codex still has its rollouts.
    const scanned = day('2026-05-01', { claude: { turns: 0, inputTokens: 0 }, codex: { turns: 5 } });
    const merged = mergeDay(stored, scanned);
    expect(merged.byBackend?.claude?.turns).toBe(40);
    expect(merged.byBackend?.claude?.inputTokens).toBe(900);
    expect(merged.byBackend?.codex?.turns).toBe(5);
  });

  it('takes the higher value when a later session lands the same day', () => {
    const stored = day('2026-05-01', { claude: { turns: 3 } });
    const scanned = day('2026-05-01', { claude: { turns: 9 } });
    expect(mergeDay(stored, scanned).byBackend?.claude?.turns).toBe(9);
  });

  it('is idempotent — a second scan of the same data cannot double-count', () => {
    const scanned = day('2026-05-01', { claude: { turns: 7, inputTokens: 100 } });
    const once = mergeDay(undefined, scanned);
    const twice = mergeDay(once, scanned);
    expect(twice).toEqual(once);
  });

  it('recomputes the day total from the merged backends', () => {
    const stored = day('2026-05-01', { claude: { turns: 40 } });
    const scanned = day('2026-05-01', { claude: { turns: 0 }, codex: { turns: 5 } });
    expect(mergeDay(stored, scanned).turns).toBe(45);
  });

  it('falls back to a flat max for rows with no per-backend breakdown', () => {
    const stored = { day: '2026-05-01', turns: 12, inputTokens: 5, outputTokens: 0, linesAdded: 0, linesDeleted: 0 };
    const scanned = { day: '2026-05-01', turns: 0, inputTokens: 9, outputTokens: 0, linesAdded: 0, linesDeleted: 0 };
    const merged = mergeDay(stored, scanned);
    expect(merged.turns).toBe(12);
    expect(merged.inputTokens).toBe(9);
  });
});

describe('mergeDailyHistory', () => {
  it('carries forward days the scan no longer sees at all', () => {
    const stored: DailyHistory = { '2026-01-01': day('2026-01-01', { claude: { turns: 11 } }) };
    const merged = mergeDailyHistory(stored, [day('2026-05-01', { codex: { turns: 2 } })]);
    expect(Object.keys(merged).sort()).toEqual(['2026-01-01', '2026-05-01']);
    expect(merged['2026-01-01'].turns).toBe(11);
  });
});

describe('persistence round-trip', () => {
  it('survives a JSON serialize/parse cycle, which is what a restart is', () => {
    const first = mergeDailyHistory({}, [day('2026-05-01', { claude: { turns: 40, inputTokens: 900 } })]);
    const reloaded: DailyHistory = JSON.parse(JSON.stringify(first));
    // Next launch: claude has pruned the day, so the scan reports nothing.
    const second = mergeDailyHistory(reloaded, [day('2026-05-01', { claude: { turns: 0 } })]);
    expect(second['2026-05-01'].byBackend?.claude?.turns).toBe(40);
    expect(second['2026-05-01'].inputTokens).toBe(900);
  });
});

describe('trimHistory', () => {
  it('keeps the newest days', () => {
    const h: DailyHistory = {
      '2026-01-01': day('2026-01-01', {}),
      '2026-01-02': day('2026-01-02', {}),
      '2026-01-03': day('2026-01-03', {}),
    };
    expect(Object.keys(trimHistory(h, 2))).toEqual(['2026-01-02', '2026-01-03']);
  });

  it('leaves a short history untouched', () => {
    const h: DailyHistory = { '2026-01-01': day('2026-01-01', {}) };
    expect(trimHistory(h, 5)).toBe(h);
  });
});
