// Per-turn latency breakdown, derived from the stream events a conversation
// already carries. No new IPC, no new persistence — `runner.events` holds
// timestamps, per-message `usage`, tool-use args and tool results, which is
// everything needed to answer "where did those 40 seconds go".
//
// The point of this module is to make speed work measurable instead of
// vibes-driven. Two questions it exists to settle:
//
//   1. Model vs tools. A turn that feels slow is almost always decode-bound,
//      but "almost always" is not a measurement. The split below is exact.
//   2. Reasoning volume. Claude bills reasoning as output tokens but ships
//      the blocks redacted, so you cannot count them directly — see
//      `reasoningTokensEst`. On backends that emit reasoning in the clear
//      (codex) the same residual still works, because visible reasoning is
//      counted as text by the parser and drops out of the subtraction.
//
// Backend-neutral on purpose. Comparing a claude turn against a codex turn
// side by side is the whole reason this is worth building.

import type { ModelUsage, StreamEvent } from '../../../shared/types';

/// Rough chars-per-token for content we can see. Only used to subtract
/// *visible* output (text + tool arguments) from the API's authoritative
/// `outputTokens`, so the error lands entirely in `reasoningTokensEst` and
/// never in the totals. 4 is the usual English/code approximation.
const CHARS_PER_TOKEN = 4;

export interface TurnTiming {
  /// Stream-event id of the `localUser` event that opened the turn — stable
  /// React key, and lets a caller scroll the Stream tab to the same turn.
  id: string;
  /// First line of the prompt, for identifying the row.
  prompt: string;
  startedAt: number;
  /// Wall clock from the user's prompt to the last event of the turn.
  /// Excludes the time the user spent reading and typing the *next* prompt,
  /// because the turn ends at its last event, not at the next `localUser`.
  wallMs: number;
  /// Time attributable to the model: waiting for a response plus streaming
  /// it out. Everything in the turn that isn't tool execution.
  modelMs: number;
  /// Time between the model asking for tools and the results landing.
  toolMs: number;
  /// Non-partial assistant messages — i.e. API requests that reported usage.
  requests: number;
  toolCalls: number;
  outputTokens: number;
  /// Visible prose the model produced, estimated from character count.
  textTokensEst: number;
  /// Tool-call arguments, estimated from the raw argument JSON.
  toolArgTokensEst: number;
  /// Reasoning, as the residual of `outputTokens` after visible output is
  /// subtracted. Floored at zero: on a turn that is nearly all tool calls
  /// the character estimate can overshoot the true token count, and a
  /// negative "reasoning" reading would be nonsense rather than signal.
  reasoningTokensEst: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /// True when the turn opened by re-prefilling its whole prefix instead of
  /// reading it from cache — the tell for a backend respawn-and-resume
  /// (model, permission mode, cwd, effort or turbo changed, or the idle
  /// session timer released the process).
  ///
  /// Judged on the turn's FIRST request only, comparing writes against
  /// reads. A turn's *total* cache writes are not evidence of anything: a
  /// long turn legitimately writes a few thousand tokens per request as it
  /// extends the cached prefix, so summing them makes every long turn look
  /// like a respawn. What a respawn actually looks like is the reads
  /// collapsing on the opening request while the writes spike past them.
  resumedColdCache: boolean;
  /// Output tokens per second of model time. The headline number: if this
  /// is low and `reasoningTokensEst` is high, no amount of tool work helps.
  decodeTokensPerSec: number | null;
  models: string[];
}

/// Split a conversation's event stream into turns and measure each one.
///
/// Events before the first `localUser` (a resumed transcript's history, the
/// `systemInit` line) belong to no turn and are dropped.
export function summarizeTurns(events: StreamEvent[]): TurnTiming[] {
  const turns: TurnTiming[] = [];
  let current: StreamEvent[] | null = null;

  for (const e of events) {
    if (e.kind.type === 'localUser') {
      if (current) turns.push(measureTurn(current));
      current = [e];
    } else if (current) {
      current.push(e);
    }
  }
  if (current) turns.push(measureTurn(current));
  return turns;
}

/// Aggregate across turns. Rates are recomputed from the summed totals
/// rather than averaged, so one 2-second turn can't outweigh a 90-second one.
export function totalTiming(turns: TurnTiming[]): TurnTiming | null {
  if (turns.length === 0) return null;
  const sum = (pick: (t: TurnTiming) => number) => turns.reduce((n, t) => n + pick(t), 0);
  const modelMs = sum((t) => t.modelMs);
  const outputTokens = sum((t) => t.outputTokens);
  return {
    id: 'total',
    prompt: `${turns.length} turn${turns.length === 1 ? '' : 's'}`,
    startedAt: turns[0].startedAt,
    wallMs: sum((t) => t.wallMs),
    modelMs,
    toolMs: sum((t) => t.toolMs),
    requests: sum((t) => t.requests),
    toolCalls: sum((t) => t.toolCalls),
    outputTokens,
    textTokensEst: sum((t) => t.textTokensEst),
    toolArgTokensEst: sum((t) => t.toolArgTokensEst),
    reasoningTokensEst: sum((t) => t.reasoningTokensEst),
    cacheReadTokens: sum((t) => t.cacheReadTokens),
    cacheCreationTokens: sum((t) => t.cacheCreationTokens),
    resumedColdCache: turns.some((t) => t.resumedColdCache),
    decodeTokensPerSec: modelMs > 0 ? outputTokens / (modelMs / 1000) : null,
    models: Array.from(new Set(turns.flatMap((t) => t.models))),
  };
}

function measureTurn(events: StreamEvent[]): TurnTiming {
  const first = events[0];
  const prompt = first.kind.type === 'localUser' ? first.kind.text : '';

  const wallMs = events[events.length - 1].timestamp - first.timestamp;
  const toolMs = measureToolTime(events);
  // Whatever wasn't a tool was the model: waiting on the API, or streaming
  // a response out. Deriving it by subtraction rather than by summing gaps
  // guarantees the two shares add up to the wall clock exactly.
  const modelMs = Math.max(0, wallMs - toolMs);

  let requests = 0;
  let toolCalls = 0;
  let outputTokens = 0;
  let textChars = 0;
  let toolArgChars = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let firstUsage: ModelUsage | undefined;
  const models = new Set<string>();

  for (const e of events) {
    if (e.kind.type !== 'assistant') continue;
    // Streaming snapshots re-send the whole message so far and carry no
    // usage. Counting them would multiply the visible text by the number of
    // deltas while leaving `outputTokens` alone — which would silently
    // inflate reasoning's complement rather than reasoning itself.
    if (e.kind.info.isPartial) continue;
    requests += 1;
    toolCalls += e.kind.info.toolUses.length;
    textChars += e.kind.info.text.length;
    for (const t of e.kind.info.toolUses) toolArgChars += t.inputJSON.length;
    for (const t of e.kind.info.thinking) textChars += t.length;
    if (e.kind.info.model) models.add(e.kind.info.model);
    const usage: ModelUsage | undefined = e.kind.info.usage;
    if (usage) {
      firstUsage ??= usage;
      outputTokens += usage.outputTokens;
      cacheReadTokens += usage.cacheReadInputTokens;
      cacheCreationTokens += usage.cacheCreationInputTokens;
    }
  }

  const textTokensEst = Math.round(textChars / CHARS_PER_TOKEN);
  const toolArgTokensEst = Math.round(toolArgChars / CHARS_PER_TOKEN);

  return {
    id: first.id,
    prompt: prompt.split('\n')[0].slice(0, 120),
    startedAt: first.timestamp,
    wallMs,
    modelMs,
    toolMs,
    requests,
    toolCalls,
    outputTokens,
    textTokensEst,
    toolArgTokensEst,
    reasoningTokensEst: Math.max(0, outputTokens - textTokensEst - toolArgTokensEst),
    cacheReadTokens,
    cacheCreationTokens,
    resumedColdCache: isColdResume(firstUsage),
    decodeTokensPerSec: modelMs > 0 ? outputTokens / (modelMs / 1000) : null,
    models: Array.from(models),
  };
}

/// Below this a cold prefix isn't worth reporting — a short conversation
/// legitimately writes its opening context, and calling that a regression
/// would flag every conversation's first turn forever.
const COLD_RESUME_FLOOR_TOKENS = 20_000;

function isColdResume(first: ModelUsage | undefined): boolean {
  if (!first) return false;
  return (
    first.cacheCreationInputTokens >= COLD_RESUME_FLOOR_TOKENS &&
    first.cacheCreationInputTokens > first.cacheReadInputTokens
  );
}


/// Wall-clock time this turn spent inside tools.
///
/// Correlates each `tool_result` block back to the assistant message that
/// requested it, by tool-use id, rather than assuming the result event sits
/// directly after the request. It doesn't: streaming snapshots, subagent
/// traffic and per-tool reveal rows all interleave, and an adjacency test
/// silently scored every turn as 0% tools.
///
/// Intervals are merged rather than summed, because parallel tool calls
/// overlap — issuing four greps at once costs one grep of wall clock, and
/// adding the four durations would report more tool time than the turn took.
function measureToolTime(events: StreamEvent[]): number {
  const requestedAt = new Map<string, number>();
  const spans: Array<[number, number]> = [];

  for (const e of events) {
    if (e.kind.type === 'assistant') {
      for (const use of e.kind.info.toolUses) {
        // A partial snapshot can carry the tool call before the message is
        // complete; the tool cannot start until it is, so keep the latest
        // sighting rather than the first.
        requestedAt.set(use.id, e.timestamp);
      }
    } else if (e.kind.type === 'toolResult') {
      for (const r of e.kind.results) {
        const start = requestedAt.get(r.id);
        if (start === undefined || e.timestamp <= start) continue;
        spans.push([start, e.timestamp]);
      }
    }
  }

  spans.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let openFrom = 0;
  let openTo = 0;
  for (const [from, to] of spans) {
    if (from > openTo) {
      total += openTo - openFrom;
      openFrom = from;
      openTo = to;
    } else if (to > openTo) {
      openTo = to;
    }
  }
  return total + (openTo - openFrom);
}

export function formatSeconds(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

/// Share of a turn spent on something, as a percentage of model + tool time.
/// Deliberately not a share of `wallMs`: a turn that stalls on a permission
/// prompt would otherwise report every component as tiny.
export function shareOfWork(part: number, turn: TurnTiming): number {
  const work = turn.modelMs + turn.toolMs;
  return work > 0 ? (part / work) * 100 : 0;
}
