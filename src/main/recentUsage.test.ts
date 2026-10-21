import { describe, expect, it } from 'vitest';
import {
  computeRecentUsage,
  RECENT_BUCKET_MS,
  RECENT_RANGE_MS,
  RecentEvent,
  RecentTranscript,
  estimateResultTokens,
  summarizeTools,
  toolGroup,
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

describe('computeRecentUsage — what filled the context', () => {
  const CONFLUENCE = 'mcp__claude_ai_Atlassian_Rovo__getConfluencePage';

  it('charges a result its cache write plus a re-read on every later reply until compaction', () => {
    const r = computeRecentUsage(
      [
        transcript({
          events: [
            ev({ cacheR: 10_000 }),
            ev({ cacheR: 110_000, toolResults: [{ name: CONFLUENCE, tokens: 100_000 }] }),
            ev({ cacheR: 110_000 }),
            ev({ cacheR: 20_000, afterCompact: true }),
            ev({ cacheR: 20_000 }),
          ],
        }),
      ],
      NOW,
    );
    expect(r.byTool).toHaveLength(1);
    const t = r.byTool[0];
    expect(t).toMatchObject({ name: 'Atlassian Rovo', mcp: true, calls: 1, resultTokens: 100_000, largestResult: 100_000 });
    expect(t.tools).toEqual(['getConfluencePage']);
    // 100k written at 1.25× $5/M, then read once at $0.50/M before compaction.
    expect(t.costUSD).toBeCloseTo(0.625 + 0.05);
  });

  it('charges results from before the range for the replies inside it that re-read them', () => {
    const r = computeRecentUsage(
      [
        transcript({
          events: [
            ev({ ts: START - 60_000, toolResults: [{ name: 'Read', tokens: 200_000 }] }),
            ev({ cacheR: 200_000 }),
          ],
        }),
      ],
      NOW,
    );
    expect(r.byTool[0]).toMatchObject({ name: 'Read', mcp: false, calls: 0, resultTokens: 0 });
    expect(r.byTool[0].costUSD).toBeCloseTo(0.1);
  });

  it('reports the fixed prompt as the smallest one each transcript sent, re-read every reply', () => {
    const r = computeRecentUsage(
      [transcript({ events: [ev({ cacheR: 40_000 }), ev({ cacheR: 30_000, cacheC: 10_000 }), ev({ cacheR: 90_000 })] })],
      NOW,
    );
    expect(r.overhead.tokensPerReply).toBe(40_000);
    expect(r.overhead.costUSD).toBeCloseTo(3 * 40_000 * 0.5e-6);
    expect(r.sessions[0].baselineTokens).toBe(40_000);
  });

  it('ranks tools by cost', () => {
    const r = computeRecentUsage(
      [
        transcript({
          events: [
            ev({
              toolResults: [
                { name: 'Grep', tokens: 1_000 },
                { name: 'mcp__acme_tracker__search', tokens: 50_000 },
                { name: 'mcp__acme_tracker__get', tokens: 5_000 },
                { name: 'mcp__acme_tracker__search', tokens: 5_000 },
              ],
            }),
          ],
        }),
      ],
      NOW,
    );
    expect(r.byTool.map((t) => t.name)).toEqual(['acme tracker', 'Grep']);
    expect(r.byTool[0].calls).toBe(3);
    expect(r.byTool[0].tools).toEqual(['search ×2', 'get']);
    expect(r.byTool[1].tools).toBeUndefined();
  });
});

describe('computeRecentUsage — recommendations', () => {
  const replies = (n: number, overrides: Partial<RecentEvent> = {}) => Array.from({ length: n }, () => ev(overrides));

  it('flags a heavy fixed prompt in a session that never touches MCP, offering Turbo when the work is light', () => {
    const r = computeRecentUsage([transcript({ events: replies(30, { cacheR: 60_000 }) })], NOW);
    expect(r.recommendations).toHaveLength(1);
    const rec = r.recommendations[0];
    expect(rec).toMatchObject({ kind: 'mcp-overhead', sessionId: 's1', baselineTokens: 60_000, mcpCalls: 0, turns: 30 });
    if (rec.kind !== 'mcp-overhead') throw new Error();
    expect(rec.suggestTurbo).toBe(true);
    // 40k over a lean prompt, 30 replies, Opus cache reads at $0.50/M.
    expect(rec.impactUSD).toBeCloseTo(0.6);
  });

  it("doesn't offer Turbo to a session making real edits, or flag one that uses its MCP", () => {
    const editing = computeRecentUsage(
      [transcript({ events: replies(30, { cacheR: 60_000, msgAdded: 10 }) })],
      NOW,
    ).recommendations[0];
    expect(editing).toMatchObject({ kind: 'mcp-overhead', suggestTurbo: false });

    const usesMcp = computeRecentUsage(
      [transcript({ events: replies(30, { cacheR: 60_000, tools: ['mcp__acme__search'] }) })],
      NOW,
    );
    expect(usesMcp.recommendations).toEqual([]);
  });

  it('flags a long conversation that never compacted, but not one that did', () => {
    const events = [ev({ cacheR: 20_000 }), ...replies(39, { cacheR: 200_000 })];
    const rec = computeRecentUsage([transcript({ events })], NOW).recommendations[0];
    expect(rec).toMatchObject({ kind: 'long-session', turns: 40, avgContextTokens: 195_500, compactedTokens: 50_000 });
    expect(rec.impactUSD).toBeCloseTo(195_500 * 40 * 0.5e-6 * (1 - 50_000 / 195_500));

    const compacted = [...events.slice(0, 20), ev({ cacheR: 200_000, afterCompact: true }), ...events.slice(21)];
    expect(computeRecentUsage([transcript({ events: compacted })], NOW).recommendations).toEqual([]);
  });

  it('flags a tool whose results came back huge, naming the session that paid most, but never a subagent', () => {
    const r = computeRecentUsage(
      [
        transcript({
          sessionId: 'docs',
          events: [
            ev({ toolResults: [{ name: 'mcp__acme_wiki__getPage', tokens: 100_000 }, { name: 'Agent', tokens: 100_000 }] }),
            ...replies(10),
          ],
        }),
      ],
      NOW,
    );
    expect(r.recommendations).toHaveLength(1);
    expect(r.recommendations[0]).toMatchObject({
      kind: 'chatty-tool',
      sessionId: 'docs',
      tool: 'acme wiki',
      mcp: true,
      calls: 1,
      largestResult: 100_000,
    });
    expect(r.recommendations[0].impactUSD).toBeCloseTo(0.625 + 10 * 0.05);
  });

  it('keeps the three biggest and drops anything under fifty cents', () => {
    const r = computeRecentUsage(
      ['a', 'b', 'c', 'd'].map((id, i) => transcript({ sessionId: id, events: replies(30 + i * 10, { cacheR: 60_000 }) })),
      NOW,
    );
    expect(r.recommendations.map((x) => x.sessionId)).toEqual(['d', 'c', 'b']);
    expect(computeRecentUsage([transcript({ events: replies(20, { cacheR: 45_000 }) })], NOW).recommendations).toEqual([]);
  });
});

describe('toolGroup', () => {
  it('groups MCP tools by server and leaves built-ins alone', () => {
    expect(toolGroup('mcp__claude_ai_Atlassian_Rovo__getJiraIssue')).toEqual({
      key: 'mcp:claude_ai_Atlassian_Rovo',
      name: 'Atlassian Rovo',
      mcp: true,
      tool: 'getJiraIssue',
    });
    expect(toolGroup('Bash')).toEqual({ key: 'Bash', name: 'Bash', mcp: false });
  });
});

describe('estimateResultTokens', () => {
  it('counts text at ~4 chars a token and images at a flat rate', () => {
    expect(estimateResultTokens('x'.repeat(400))).toBe(100);
    expect(estimateResultTokens([{ type: 'text', text: 'x'.repeat(40) }, { type: 'image', source: {} }])).toBe(10 + 1600);
    expect(estimateResultTokens(undefined)).toBe(0);
  });
});

describe('summarizeTools', () => {
  it('counts repeats, most-used first', () => {
    expect(summarizeTools(['Read', 'Task', 'Read', 'Read', 'Edit', 'Edit'])).toEqual(['Read ×3', 'Edit ×2', 'Task']);
    expect(summarizeTools([])).toEqual([]);
  });
});
