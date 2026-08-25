import { describe, expect, it } from 'vitest';
import { ModelUsage, StreamEvent, ToolUseBlock } from '@shared/types';
import { BATCHING_DIRECTIVE } from '@shared/turbo';
import { relativeTimelineWidth, summarizeTurns, totalTiming } from './turnTiming';

let nextId = 0;

function ev(timestamp: number, kind: StreamEvent['kind']): StreamEvent {
  nextId += 1;
  return { id: `e${nextId}`, timestamp, raw: '', kind, revision: 0 };
}

function user(timestamp: number, text: string): StreamEvent {
  return ev(timestamp, { type: 'localUser', text });
}

function usage(over: Partial<ModelUsage> = {}): ModelUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    ...over,
  };
}

function toolUse(inputJSON: string, id = 'tu'): ToolUseBlock {
  return { id, name: 'Bash', inputJSON };
}

function assistant(
  timestamp: number,
  opts: {
    text?: string;
    thinking?: string[];
    toolUses?: ToolUseBlock[];
    usage?: ModelUsage;
    isPartial?: boolean;
    model?: string;
  } = {},
): StreamEvent {
  return ev(timestamp, {
    type: 'assistant',
    info: {
      model: opts.model ?? 'claude-opus-5',
      text: opts.text ?? '',
      toolUses: opts.toolUses ?? [],
      thinking: opts.thinking ?? [],
      isPartial: opts.isPartial,
      usage: opts.usage,
    },
  });
}

function toolResult(timestamp: number, ...ids: string[]): StreamEvent {
  const use = ids.length ? ids : ['tu'];
  return ev(timestamp, {
    type: 'toolResult',
    results: use.map((id) => ({ id, content: 'ok', isError: false })),
  });
}

describe('summarizeTurns', () => {
  it('uses display-safe user text for timing row labels', () => {
    const [turn] = summarizeTurns([
      user(
        0,
        `<image name=[Image #1] path="/private/screenshot.png"></image>${BATCHING_DIRECTIVE}\n\nWhat is shown?`,
      ),
      assistant(1000, { text: 'An app' }),
    ]);

    expect(turn.prompt).toBe('What is shown?');
    expect(turn.prompt).not.toContain('/private/');
    expect(turn.prompt).not.toContain('Prefer fewer');
  });

  it('shows unresolved tools through the live clock for an active turn', () => {
    const [turn] = summarizeTurns(
      [
        user(0, 'go'),
        assistant(1000, { toolUses: [toolUse('{}', 'bash')], usage: usage({ outputTokens: 10 }) }),
      ],
      5000,
    );

    expect(turn.wallMs).toBe(5000);
    expect(turn.toolMs).toBe(4000);
    expect(turn.tools).toEqual([
      expect.objectContaining({ name: 'Bash', calls: 1, busyMs: 4000 }),
    ]);
    expect(turn.timeline).toEqual([
      { kind: 'model', startMs: 0, endMs: 1000, toolNames: [] },
      { kind: 'tool', startMs: 1000, endMs: 5000, toolNames: ['Bash'] },
    ]);
  });

  it('splits on localUser and drops events before the first prompt', () => {
    const turns = summarizeTurns([
      ev(0, { type: 'assistant', info: { model: null, text: 'resumed history', toolUses: [], thinking: [] } }),
      user(1000, 'first'),
      assistant(2000, { usage: usage({ outputTokens: 10 }) }),
      user(3000, 'second'),
      assistant(4000, { usage: usage({ outputTokens: 20 }) }),
    ]);

    expect(turns.map((t) => t.prompt)).toEqual(['first', 'second']);
    expect(turns[0].outputTokens).toBe(10);
  });

  it('charges the assistant -> toolResult gap to tools and everything else to the model', () => {
    const [turn] = summarizeTurns([
      user(0, 'go'),
      // 5s waiting for the model to decide on a tool call
      assistant(5000, { toolUses: [toolUse('{}')], usage: usage({ outputTokens: 100 }) }),
      // 2s of bash
      toolResult(7000),
      // 3s for the model to read the result and answer
      assistant(10000, { text: 'done', usage: usage({ outputTokens: 50 }) }),
    ]);

    expect(turn.toolMs).toBe(2000);
    expect(turn.modelMs).toBe(8000);
    expect(turn.wallMs).toBe(10000);
    expect(turn.toolCalls).toBe(1);
    expect(turn.timeline).toEqual([
      { kind: 'model', startMs: 0, endMs: 5000, toolNames: [] },
      { kind: 'tool', startMs: 5000, endMs: 7000, toolNames: ['Bash'] },
      { kind: 'model', startMs: 7000, endMs: 10000, toolNames: [] },
    ]);
  });

  it('shows parallel tools as overlapping phases in the request timeline', () => {
    const [turn] = summarizeTurns([
      user(0, 'go'),
      assistant(1000, {
        toolUses: [toolUse('{}', 'bash'), { ...toolUse('{}', 'read'), name: 'Read' }],
      }),
      toolResult(3000, 'bash'),
      toolResult(4000, 'read'),
      assistant(5000, { text: 'done' }),
    ]);

    expect(turn.timeline).toEqual([
      { kind: 'model', startMs: 0, endMs: 1000, toolNames: [] },
      { kind: 'tool', startMs: 1000, endMs: 3000, toolNames: ['Bash', 'Read'] },
      { kind: 'tool', startMs: 3000, endMs: 4000, toolNames: ['Read'] },
      { kind: 'model', startMs: 4000, endMs: 5000, toolNames: [] },
    ]);
  });

  it('derives reasoning tokens as the residual of visible output', () => {
    // 400 chars of prose ~= 100 tokens, 80 chars of tool args ~= 20 tokens.
    const [turn] = summarizeTurns([
      user(0, 'go'),
      assistant(1000, {
        text: 'x'.repeat(400),
        toolUses: [toolUse('y'.repeat(80))],
        usage: usage({ outputTokens: 1000 }),
      }),
    ]);

    expect(turn.textTokensEst).toBe(100);
    expect(turn.toolArgTokensEst).toBe(20);
    expect(turn.reasoningTokensEst).toBe(880);
  });

  it('counts visible reasoning as text so codex does not read as pure residual', () => {
    const [turn] = summarizeTurns([
      user(0, 'go'),
      assistant(1000, {
        thinking: ['z'.repeat(2000)],
        usage: usage({ outputTokens: 600 }),
      }),
    ]);

    expect(turn.textTokensEst).toBe(500);
    expect(turn.reasoningTokensEst).toBe(100);
  });

  it('never reports negative reasoning when the character estimate overshoots', () => {
    const [turn] = summarizeTurns([
      user(0, 'go'),
      assistant(1000, { text: 'x'.repeat(4000), usage: usage({ outputTokens: 10 }) }),
    ]);

    expect(turn.reasoningTokensEst).toBe(0);
  });

  it('ignores partial snapshots so repeated deltas do not inflate visible output', () => {
    const [turn] = summarizeTurns([
      user(0, 'go'),
      assistant(500, { text: 'hel', isPartial: true }),
      assistant(800, { text: 'hello there', isPartial: true }),
      assistant(1000, { text: 'hello there', usage: usage({ outputTokens: 40 }) }),
    ]);

    expect(turn.requests).toBe(1);
    expect(turn.textTokensEst).toBe(3);
  });

  it('measures first response from the first partial assistant event and ignores system events', () => {
    const [turn] = summarizeTurns([
      user(0, 'go'),
      ev(250, { type: 'systemNotice', text: 'still preparing' }),
      assistant(500, { text: 'hel', isPartial: true }),
      assistant(1000, { text: 'hello', usage: usage({ outputTokens: 10 }) }),
    ]);

    expect(turn.firstResponseMs).toBe(500);
  });

  it('reports null first response when no assistant event arrives', () => {
    const [turn] = summarizeTurns([user(0, 'go'), ev(1000, { type: 'systemNotice', text: 'still preparing' })]);

    expect(turn.firstResponseMs).toBeNull();
  });

  it('separates transport readiness, first model activity, visible text, and streaming', () => {
    const final = assistant(1400, { text: 'hello there' });
    final.firstSeenAt = 400;
    final.firstVisibleAt = 700;
    const [turn] = summarizeTurns([
      user(0, 'go'),
      ev(100, {
        type: 'systemInit',
        info: { sessionId: 's', model: 'claude', cwd: '/repo', apiKeySource: 'login', tools: [], slashCommands: [], mcpServers: [] },
      }),
      final,
    ]);

    expect(turn.transportReadyMs).toBe(100);
    expect(turn.firstResponseMs).toBe(400);
    expect(turn.firstVisibleMs).toBe(700);
    expect(turn.streamingMs).toBe(1000);
  });

  it('surfaces a cache-write spike, the tell for a respawn and resume', () => {
    const [turn] = summarizeTurns([
      user(0, 'go'),
      assistant(1000, {
        usage: usage({ outputTokens: 50, cacheReadInputTokens: 15904, cacheCreationInputTokens: 56657 }),
      }),
    ]);

    expect(turn.cacheCreationTokens).toBe(56657);
    expect(turn.cacheReadTokens).toBe(15904);
  });

  it('reports decode rate over model time only, not wall clock', () => {
    const [turn] = summarizeTurns([
      user(0, 'go'),
      assistant(2000, { toolUses: [toolUse('{}')], usage: usage({ outputTokens: 160 }) }),
      toolResult(10000),
    ]);

    // 160 tokens over 2s of model time is 80 tok/s — the 8s of tool time
    // must not drag it down to 16.
    expect(turn.modelMs).toBe(2000);
    expect(turn.decodeTokensPerSec).toBeCloseTo(80);
  });
});

describe('totalTiming', () => {
  it('recomputes the rate from summed totals rather than averaging turns', () => {
    const turns = summarizeTurns([
      // Fast, tiny turn: 10 tokens in 1s = 10 tok/s.
      user(0, 'a'),
      assistant(1000, { usage: usage({ outputTokens: 10 }) }),
      // Slow, large turn: 990 tokens in 9s = 110 tok/s.
      user(2000, 'b'),
      assistant(11000, { usage: usage({ outputTokens: 990 }) }),
    ]);
    const total = totalTiming(turns);

    // Averaging the two turn rates would give 60; the honest figure is
    // 1000 tokens over 10s of model time.
    expect(total?.decodeTokensPerSec).toBeCloseTo(100);
    expect(total?.outputTokens).toBe(1000);
  });

  it('returns null with no turns', () => {
    expect(totalTiming([])).toBeNull();
  });

  it('averages only non-null first response timings', () => {
    const turns = summarizeTurns([
      user(0, 'a'),
      assistant(1000),
      user(2000, 'b'),
      ev(5000, { type: 'systemNotice', text: 'still preparing' }),
      user(6000, 'c'),
      assistant(9000),
    ]);

    expect(totalTiming(turns)?.firstResponseMs).toBe(2000);
  });
});

describe('relativeTimelineWidth', () => {
  it('scales every request against the longest turn', () => {
    expect(relativeTimelineWidth(5000, 10000)).toBe(50);
    expect(relativeTimelineWidth(10000, 10000)).toBe(100);
    expect(relativeTimelineWidth(12000, 10000)).toBe(100);
    expect(relativeTimelineWidth(5000, 0)).toBe(0);
  });
});

describe('cold-resume detection', () => {
  it('flags the opening request re-prefilling instead of reading cache', () => {
    const [turn] = summarizeTurns([
      user(0, 'go'),
      assistant(1000, {
        usage: usage({ outputTokens: 50, cacheReadInputTokens: 15904, cacheCreationInputTokens: 56657 }),
      }),
    ]);

    expect(turn.resumedColdCache).toBe(true);
  });

  it('does not flag a long turn that merely accumulates cache writes', () => {
    // 30 requests each extending the cached prefix by ~3k sums well past the
    // floor, but every one of them read its prefix from cache. Summing the
    // writes would call this a respawn; looking at the opening request does not.
    const events: StreamEvent[] = [user(0, 'go')];
    for (let i = 0; i < 30; i += 1) {
      events.push(
        assistant(1000 + i * 100, {
          usage: usage({
            outputTokens: 500,
            cacheReadInputTokens: 60000 + i * 3000,
            cacheCreationInputTokens: 3000,
          }),
        }),
      );
    }
    const [turn] = summarizeTurns(events);

    expect(turn.cacheCreationTokens).toBe(90000);
    expect(turn.resumedColdCache).toBe(false);
  });

  it('ignores a small cold prefix so first turns are not flagged forever', () => {
    const [turn] = summarizeTurns([
      user(0, 'go'),
      assistant(1000, {
        usage: usage({ outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 4000 }),
      }),
    ]);

    expect(turn.resumedColdCache).toBe(false);
  });
});

describe('tool time', () => {
  it('correlates results to requests by id, not by adjacency', () => {
    // A streaming snapshot lands between the request and its result — the
    // interleaving that made an adjacency test score every turn 0% tools.
    const [turn] = summarizeTurns([
      user(0, 'go'),
      assistant(1000, { toolUses: [toolUse('{}')], usage: usage({ outputTokens: 10 }) }),
      assistant(1500, { text: 'still going', isPartial: true }),
      toolResult(3000),
      assistant(5000, { text: 'done', usage: usage({ outputTokens: 10 }) }),
    ]);

    expect(turn.toolMs).toBe(2000);
    expect(turn.modelMs).toBe(3000);
  });

  it('merges overlapping spans so parallel calls are not double counted', () => {
    // Two tools issued together, finishing 2s and 3s later. Wall cost is 3s,
    // not the 5s that summing each duration would report.
    const [turn] = summarizeTurns([
      user(0, 'go'),
      assistant(1000, {
        toolUses: [toolUse('{}', 'a'), toolUse('{}', 'b')],
        usage: usage({ outputTokens: 10 }),
      }),
      toolResult(3000, 'a'),
      toolResult(4000, 'b'),
    ]);

    expect(turn.toolMs).toBe(3000);
  });

  it('sums disjoint spans separately', () => {
    const [turn] = summarizeTurns([
      user(0, 'go'),
      assistant(1000, { toolUses: [toolUse('{}', 'a')], usage: usage({ outputTokens: 10 }) }),
      toolResult(2000, 'a'),
      assistant(5000, { toolUses: [toolUse('{}', 'b')], usage: usage({ outputTokens: 10 }) }),
      toolResult(9000, 'b'),
    ]);

    expect(turn.toolMs).toBe(5000);
    expect(turn.modelMs).toBe(4000);
  });

  it('model and tool time always add up to the wall clock', () => {
    const [turn] = summarizeTurns([
      user(0, 'go'),
      assistant(1000, { toolUses: [toolUse('{}', 'a')], usage: usage({ outputTokens: 10 }) }),
      toolResult(4500, 'a'),
      assistant(7000, { text: 'done', usage: usage({ outputTokens: 10 }) }),
    ]);

    expect(turn.modelMs + turn.toolMs).toBe(turn.wallMs);
  });

  it('ignores a result with no matching request', () => {
    const [turn] = summarizeTurns([user(0, 'go'), toolResult(5000, 'orphan')]);
    expect(turn.toolMs).toBe(0);
  });
});

describe('per-tool breakdown', () => {
  it('attributes tool time to each tool name', () => {
    const turns = summarizeTurns([
      user(0, 'go'),
      assistant(1000, {
        toolUses: [
          { id: 'a', name: 'Bash', inputJSON: '{}' },
          { id: 'b', name: 'Read', inputJSON: '{}' },
        ],
      }),
      toolResult(2000, 'b'),
      toolResult(9000, 'a'),
    ]);
    const [turn] = turns;
    expect(turn.toolMs).toBe(8000);
    expect(turn.tools.map((t) => t.name)).toEqual(['Bash', 'Read']);
    expect(turn.tools[0].busyMs).toBe(8000);
    expect(turn.tools[1].busyMs).toBe(1000);
    // Overlapping calls: slices are rescaled so they add up to toolMs.
    expect(turn.tools.reduce((n, t) => n + t.ms, 0)).toBeCloseTo(turn.toolMs);
  });

  it('aggregates calls, slowest call and errors per tool', () => {
    const [turn] = summarizeTurns([
      user(0, 'go'),
      assistant(1000, { toolUses: [{ id: 'a', name: 'Bash', inputJSON: '{}' }] }),
      toolResult(2000, 'a'),
      assistant(3000, { toolUses: [{ id: 'b', name: 'Bash', inputJSON: '{}' }] }),
      ev(8000, {
        type: 'toolResult',
        results: [{ id: 'b', content: 'boom', isError: true }],
      }),
    ]);
    expect(turn.tools).toHaveLength(1);
    expect(turn.tools[0]).toMatchObject({
      name: 'Bash',
      calls: 2,
      busyMs: 6000,
      slowestMs: 5000,
      errors: 1,
    });
  });

  it('merges per-tool timings across turns in the total', () => {
    const turns = summarizeTurns([
      user(0, 'one'),
      assistant(1000, { toolUses: [{ id: 'a', name: 'Bash', inputJSON: '{}' }] }),
      toolResult(2000, 'a'),
      user(3000, 'two'),
      assistant(4000, { toolUses: [{ id: 'b', name: 'Bash', inputJSON: '{}' }] }),
      toolResult(7000, 'b'),
      assistant(7500, { toolUses: [{ id: 'c', name: 'Grep', inputJSON: '{}' }] }),
      toolResult(8000, 'c'),
    ]);
    const total = totalTiming(turns)!;
    expect(total.tools.map((t) => [t.name, t.calls, t.busyMs])).toEqual([
      ['Bash', 2, 4000],
      ['Grep', 1, 500],
    ]);
  });
});
