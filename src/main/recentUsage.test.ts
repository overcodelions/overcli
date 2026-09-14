import { describe, expect, it } from 'vitest';
import {
  computeRecentUsage,
  RECENT_BUCKET_MS,
  RECENT_RANGE_MS,
  RecentEvent,
  RecentTranscript,
  summarizeTools,
} from './recentUsage';

// On a bucket boundary so `end === NOW`.
const NOW = Math.ceil(1_790_000_000_000 / RECENT_BUCKET_MS) * RECENT_BUCKET_MS;
const START = NOW - RECENT_RANGE_MS;

function ev(overrides: Partial<RecentEvent> = {}): RecentEvent {
  return {
    inT: 0,
    outT: 0,
    cacheR: 0,
    cacheC: 0,
    cacheC1h: 0,
    model: 'claude-opus-5',
    ts: NOW - 60_000,
    tools: [],
    ...overrides,
  };
}

function transcript(overrides: Partial<RecentTranscript> = {}): RecentTranscript {
  return { sessionId: 's1', projectPath: '/code/acme-api', isSubagent: false, events: [], ...overrides };
}

describe('computeRecentUsage', () => {
  it('lays out 32 fifteen-minute buckets ending at the next boundary', () => {
    const r = computeRecentUsage([], NOW);
    expect(r.buckets).toHaveLength(32);
    expect(r.start).toBe(START);
    expect(r.end).toBe(NOW);
    expect(r.buckets[1].start - r.buckets[0].start).toBe(RECENT_BUCKET_MS);
  });

  it('ignores events outside the range and events with no timestamp', () => {
    const r = computeRecentUsage(
      [transcript({ events: [ev({ outT: 100, ts: START - 1 }), ev({ outT: 100, ts: null })] })],
      NOW,
    );
    expect(r.sessions).toEqual([]);
    expect(r.buckets.every((b) => b.costUSD === 0)).toBe(true);
  });

  it('ranks by estimated cost, not raw tokens', () => {
    const r = computeRecentUsage(
      [
        // 2M cache reads on Opus: $1.00.
        transcript({ sessionId: 'reads', events: [ev({ cacheR: 2_000_000 })] }),
        // 100k output on Opus: $2.50, from a twentieth of the tokens.
        transcript({ sessionId: 'writes', events: [ev({ outT: 100_000 })] }),
      ],
      NOW,
    );
    expect(r.sessions.map((s) => s.id)).toEqual(['writes', 'reads']);
    expect(r.sessions[0].costUSD).toBeCloseTo(2.5);
    expect(r.byType.cacheRead.tokens).toBe(2_000_000);
    expect(r.byType.cacheRead.costUSD).toBeCloseTo(1);
  });

  it('folds subagents into their session without counting their replies as turns', () => {
    const r = computeRecentUsage(
      [
        transcript({
          title: 'Refactor supervisor',
          events: [ev({ inT: 10, cacheR: 90_000 }), ev({ inT: 10, cacheR: 110_000 })],
        }),
        transcript({ isSubagent: true, events: [ev({ outT: 5 }), ev({ outT: 5 })] }),
        transcript({ isSubagent: true, events: [ev({ outT: 5 })] }),
      ],
      NOW,
    );
    expect(r.sessions).toHaveLength(1);
    const s = r.sessions[0];
    expect(s.title).toBe('Refactor supervisor');
    expect(s.turns).toBe(2);
    expect(s.subagents).toBe(2);
    expect(s.outputTokens).toBe(15);
    expect(s.avgContextTokens).toBe(100_010);
  });

  it('bills 1-hour cache writes at 2× and the rest at 1.25×', () => {
    const r = computeRecentUsage(
      [transcript({ events: [ev({ cacheC: 2_000_000, cacheC1h: 1_000_000 })] })],
      NOW,
    );
    expect(r.byType.cacheWrite.costUSD).toBeCloseTo(6.25 + 10);
  });

  it('puts each event in its bucket and attributes cost per session', () => {
    const r = computeRecentUsage(
      [transcript({ events: [ev({ outT: 40_000, ts: START + RECENT_BUCKET_MS + 5 })] })],
      NOW,
    );
    expect(r.buckets[1].costUSD).toBeCloseTo(1);
    expect(r.buckets[1].bySession.s1).toBeCloseTo(1);
    expect(r.buckets[0].costUSD).toBe(0);
  });

  it('keeps the five costliest replies with their tools summarized', () => {
    const events = [1, 2, 3, 4, 5, 6].map((n) => ev({ outT: n * 1000, tools: n === 6 ? ['Read', 'Task', 'Read'] : [] }));
    const r = computeRecentUsage([transcript({ events })], NOW);
    expect(r.heaviestTurns).toHaveLength(5);
    expect(r.heaviestTurns[0].tokens).toBe(6000);
    expect(r.heaviestTurns[0].tools).toEqual(['Read ×2', 'Task']);
  });

  it('includes the limit window only when it overlaps the range', () => {
    const overlapping = { start: NOW - 3600_000, resetsAt: NOW + 4 * 3600_000, usedPercent: 100 };
    expect(computeRecentUsage([], NOW, overlapping).limitWindow).toEqual(overlapping);
    const stale = { start: START - 6 * 3600_000, resetsAt: START - 3600_000, usedPercent: 100 };
    expect(computeRecentUsage([], NOW, stale).limitWindow).toBeUndefined();
    expect(computeRecentUsage([], NOW, null).limitWindow).toBeUndefined();
  });
});

describe('summarizeTools', () => {
  it('counts repeats, most-used first', () => {
    expect(summarizeTools(['Read', 'Task', 'Read', 'Read', 'Edit', 'Edit'])).toEqual(['Read ×3', 'Edit ×2', 'Task']);
    expect(summarizeTools([])).toEqual([]);
  });
});
