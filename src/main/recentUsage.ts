// The trailing-8-hours view on the Usage page: what used up a Claude
// session window. Pure — stats.ts hands over the transcripts it has already
// parsed, so this adds no extra disk reads.

import { RecentRecommendation, RecentSession, RecentToolUse, RecentTurn, RecentUsage } from '../shared/types';
import { estimateCost } from '../shared/modelPricing';

export const RECENT_RANGE_MS = 8 * 3600 * 1000;
export const RECENT_BUCKET_MS = 15 * 60 * 1000;
const HEAVIEST_TURNS = 5;
/// A rough tokens-per-character for tool output; close enough to rank tools.
const CHARS_PER_TOKEN = 4;
/// What an image in a tool result roughly costs, whatever its encoded size.
const IMAGE_TOKENS = 1600;

// Recommendations fire only on clear evidence, and only when acting on them
// would plausibly be worth something.
const MAX_RECOMMENDATIONS = 3;
const MIN_IMPACT_USD = 0.5;
/// A fixed prompt above this is carrying more than Claude Code itself needs.
const HEAVY_BASELINE = 40_000;
/// Roughly what the fixed prompt is with no MCP servers connected.
const LEAN_BASELINE = 20_000;
const MCP_BLOAT_MIN_TURNS = 20;
const MCP_BLOAT_MAX_CALLS = 2;
/// Under this many lines changed a session is light enough that Turbo's lower
/// effort won't hurt it.
const TURBO_MAX_LINES = 50;
const LONG_CONTEXT = 150_000;
const LONG_SESSION_MIN_TURNS = 30;
/// What a compacted conversation carries on top of its fixed prompt.
const COMPACTED_EXTRA = 30_000;
const CHATTY_SHARE = 0.1;
const CHATTY_LARGEST = 20_000;
/// Already a subagent, or nothing to name.
const NOT_CHATTY = new Set(['Task', 'Agent', 'unknown']);

export interface RecentToolResult {
  name: string;
  tokens: number;
}

export interface RecentEvent {
  inT: number;
  outT: number;
  cacheR: number;
  cacheC: number;
  /// The 1-hour-TTL share of `cacheC`, which bills at 2× instead of 1.25×.
  cacheC1h: number;
  model: string;
  ts: number | null;
  tools: string[];
  /// Tool results new to this reply's prompt.
  toolResults?: RecentToolResult[];
  /// The conversation was compacted just before this reply, so earlier
  /// results are no longer carried.
  afterCompact?: boolean;
  msgAdded?: number;
  msgDeleted?: number;
}

export interface RecentTranscript {
  sessionId: string;
  projectPath: string;
  isSubagent: boolean;
  title?: string;
  events: RecentEvent[];
}

export interface LimitWindow {
  start: number;
  resetsAt: number;
  usedPercent: number;
}

interface SessionAgg extends RecentSession {
  contextSum: number;
  /// What re-reading the main thread's prompt cost, reply by reply.
  contextCost: number;
  mcpCalls: number;
  linesChanged: number;
  compactions: number;
}

interface ToolAgg {
  name: string;
  mcp: boolean;
  calls: number;
  resultTokens: number;
  largestResult: number;
  costUSD: number;
  mcpTools: string[];
  costBySession: Map<string, number>;
}

export function computeRecentUsage(
  transcripts: RecentTranscript[],
  now: number,
  limit?: LimitWindow | null,
): RecentUsage {
  const end = Math.ceil(now / RECENT_BUCKET_MS) * RECENT_BUCKET_MS;
  const start = end - RECENT_RANGE_MS;
  const buckets = Array.from({ length: RECENT_RANGE_MS / RECENT_BUCKET_MS }, (_, i) => ({
    start: start + i * RECENT_BUCKET_MS,
    costUSD: 0,
    tokens: 0,
    bySession: {} as Record<string, number>,
  }));
  const byType = {
    input: { tokens: 0, costUSD: 0 },
    output: { tokens: 0, costUSD: 0 },
    cacheRead: { tokens: 0, costUSD: 0 },
    cacheWrite: { tokens: 0, costUSD: 0 },
  };

  // Titles live in the main transcript; subagent files never carry one.
  const titles = new Map<string, string>();
  for (const t of transcripts) {
    if (t.title && !t.isSubagent) titles.set(t.sessionId, t.title);
  }

  const sessions = new Map<string, SessionAgg>();
  const models = new Map<string, Set<string>>();
  const turns: RecentTurn[] = [];

  const toolAggs = new Map<string, ToolAgg>();
  let overheadCost = 0;
  let overheadTokens = 0;
  let overheadReplies = 0;

  for (const t of transcripts) {
    let counted = false;
    const baseline = baselineOf(t.events);
    // Result tokens still in context, per tool group. Walked from the start
    // of the transcript so results from before the range are still charged
    // for the replies inside it that re-read them.
    const live = new Map<string, number>();
    for (const e of t.events) {
      const inRange = e.ts !== null && e.ts >= start && e.ts < end;
      if (e.afterCompact) live.clear();
      if (inRange) {
        const readRate = estimateCost(e.model, { ...NO_TOKENS, cacheRead: 1 }).total;
        for (const [key, tokens] of live) chargeTool(toolAggs.get(key)!, t.sessionId, tokens * readRate);
        overheadCost += baseline * readRate;
        overheadTokens += baseline;
        overheadReplies += 1;
      }
      for (const r of e.toolResults ?? []) {
        const g = toolGroup(r.name);
        let agg = toolAggs.get(g.key);
        if (!agg) {
          agg = {
            name: g.name,
            mcp: g.mcp,
            calls: 0,
            resultTokens: 0,
            largestResult: 0,
            costUSD: 0,
            mcpTools: [],
            costBySession: new Map(),
          };
          toolAggs.set(g.key, agg);
        }
        live.set(g.key, (live.get(g.key) ?? 0) + r.tokens);
        if (!inRange) continue;
        agg.calls += 1;
        agg.resultTokens += r.tokens;
        agg.largestResult = Math.max(agg.largestResult, r.tokens);
        chargeTool(agg, t.sessionId, estimateCost(e.model, { ...NO_TOKENS, cacheWrite5m: r.tokens }).total);
        if (g.tool) agg.mcpTools.push(g.tool);
      }
      if (e.ts === null || !inRange) continue;
      let s = sessions.get(t.sessionId);
      if (!s) {
        s = {
          id: t.sessionId,
          title: titles.get(t.sessionId),
          projectPath: t.projectPath,
          models: [],
          turns: 0,
          subagents: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUSD: 0,
          avgContextTokens: 0,
          baselineTokens: 0,
          firstTs: e.ts,
          lastTs: e.ts,
          contextSum: 0,
          contextCost: 0,
          mcpCalls: 0,
          linesChanged: 0,
          compactions: 0,
        };
        sessions.set(t.sessionId, s);
        models.set(t.sessionId, new Set());
      }
      if (t.isSubagent && !counted) s.subagents += 1;
      counted = true;

      const cw1h = Math.min(e.cacheC1h, e.cacheC);
      const cost = estimateCost(e.model, {
        input: e.inT,
        output: e.outT,
        cacheRead: e.cacheR,
        cacheWrite5m: e.cacheC - cw1h,
        cacheWrite1h: cw1h,
      });
      const tokens = e.inT + e.outT + e.cacheR + e.cacheC;

      s.inputTokens += e.inT;
      s.outputTokens += e.outT;
      s.cacheReadTokens += e.cacheR;
      s.cacheWriteTokens += e.cacheC;
      s.costUSD += cost.total;
      s.firstTs = Math.min(s.firstTs, e.ts);
      s.lastTs = Math.max(s.lastTs, e.ts);
      models.get(t.sessionId)!.add(e.model);
      if (!t.isSubagent) {
        s.baselineTokens = baseline;
        s.turns += 1;
        s.contextSum += e.inT + e.cacheR + e.cacheC;
        s.contextCost += cost.input + cost.cacheRead + cost.cacheWrite;
        s.mcpCalls += e.tools.filter((n) => n.startsWith('mcp__')).length;
        s.linesChanged += (e.msgAdded ?? 0) + (e.msgDeleted ?? 0);
        if (e.afterCompact) s.compactions += 1;
      }

      const b = buckets[Math.floor((e.ts - start) / RECENT_BUCKET_MS)];
      b.costUSD += cost.total;
      b.tokens += tokens;
      b.bySession[t.sessionId] = (b.bySession[t.sessionId] ?? 0) + cost.total;

      byType.input.tokens += e.inT;
      byType.input.costUSD += cost.input;
      byType.output.tokens += e.outT;
      byType.output.costUSD += cost.output;
      byType.cacheRead.tokens += e.cacheR;
      byType.cacheRead.costUSD += cost.cacheRead;
      byType.cacheWrite.tokens += e.cacheC;
      byType.cacheWrite.costUSD += cost.cacheWrite;

      turns.push({
        ts: e.ts,
        sessionId: t.sessionId,
        model: e.model,
        isSubagent: t.isSubagent,
        tokens,
        costUSD: cost.total,
        tools: summarizeTools(e.tools),
      });
    }
  }

  const sessionRows: RecentSession[] = Array.from(sessions.values())
    .map(({ contextSum, contextCost, mcpCalls, linesChanged, compactions, ...s }) => ({
      ...s,
      models: Array.from(models.get(s.id) ?? []).sort(),
      avgContextTokens: s.turns > 0 ? Math.round(contextSum / s.turns) : 0,
    }))
    .sort((a, b) => b.costUSD - a.costUSD);

  const heaviestTurns = turns.sort((a, b) => b.costUSD - a.costUSD).slice(0, HEAVIEST_TURNS);

  const limitWindow =
    limit && limit.resetsAt > start && limit.start < end ? { ...limit } : undefined;

  const byTool: RecentToolUse[] = Array.from(toolAggs.values())
    .filter((a) => a.calls > 0 || a.costUSD > 0)
    .map(({ mcpTools, costBySession, ...a }) => ({ ...a, ...(a.mcp ? { tools: summarizeTools(mcpTools) } : {}) }))
    .sort((a, b) => b.costUSD - a.costUSD);

  return {
    start,
    end,
    bucketMs: RECENT_BUCKET_MS,
    buckets,
    sessions: sessionRows,
    heaviestTurns,
    byType,
    byTool,
    recommendations: recommend(
      Array.from(sessions.values()),
      Array.from(toolAggs.values()),
      buckets.reduce((sum, b) => sum + b.costUSD, 0),
    ),
    overhead: {
      tokensPerReply: overheadReplies > 0 ? Math.round(overheadTokens / overheadReplies) : 0,
      costUSD: overheadCost,
    },
    ...(limitWindow ? { limitWindow } : {}),
  };
}

/// ["Read", "Read", "Task", "Read"] → ["Read ×3", "Task"], most-used first.
export function summarizeTools(names: string[]): string[] {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([n, c]) => (c > 1 ? `${n} ×${c}` : n));
}

function chargeTool(agg: ToolAgg, sessionId: string, cost: number): void {
  agg.costUSD += cost;
  agg.costBySession.set(sessionId, (agg.costBySession.get(sessionId) ?? 0) + cost);
}

/// The few changes most worth making, by roughly what each would have saved
/// over this range. At most one of each kind per session.
function recommend(sessions: SessionAgg[], tools: ToolAgg[], totalCost: number): RecentRecommendation[] {
  const recs: RecentRecommendation[] = [];

  for (const s of sessions) {
    if (s.turns === 0) continue;
    const avgContext = s.contextSum / s.turns;
    // Per token of prompt, what this session paid to re-send it.
    const perToken = s.contextSum > 0 ? s.contextCost / s.contextSum : 0;

    if (
      s.baselineTokens >= HEAVY_BASELINE &&
      s.turns >= MCP_BLOAT_MIN_TURNS &&
      s.mcpCalls <= MCP_BLOAT_MAX_CALLS
    ) {
      recs.push({
        kind: 'mcp-overhead',
        sessionId: s.id,
        impactUSD: (s.baselineTokens - LEAN_BASELINE) * s.turns * perToken,
        baselineTokens: s.baselineTokens,
        mcpCalls: s.mcpCalls,
        turns: s.turns,
        suggestTurbo: s.linesChanged < TURBO_MAX_LINES,
      });
    }

    if (avgContext >= LONG_CONTEXT && s.turns >= LONG_SESSION_MIN_TURNS && s.compactions === 0) {
      const target = s.baselineTokens + COMPACTED_EXTRA;
      recs.push({
        kind: 'long-session',
        sessionId: s.id,
        impactUSD: s.contextCost * Math.max(0, 1 - target / avgContext),
        avgContextTokens: Math.round(avgContext),
        compactedTokens: target,
        turns: s.turns,
      });
    }
  }

  for (const t of tools) {
    if (NOT_CHATTY.has(t.name) || t.calls === 0) continue;
    if (t.costUSD < totalCost * CHATTY_SHARE && t.largestResult < CHATTY_LARGEST) continue;
    const [sessionId] = Array.from(t.costBySession).sort((a, b) => b[1] - a[1])[0] ?? [''];
    recs.push({
      kind: 'chatty-tool',
      sessionId,
      impactUSD: t.costUSD,
      tool: t.name,
      mcp: t.mcp,
      calls: t.calls,
      resultTokens: t.resultTokens,
      largestResult: t.largestResult,
    });
  }

  return recs
    .filter((r) => r.impactUSD >= MIN_IMPACT_USD)
    .sort((a, b) => b.impactUSD - a.impactUSD)
    .slice(0, MAX_RECOMMENDATIONS);
}

const NO_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };

/// The smallest prompt any reply in the transcript sent: what's there before
/// the conversation adds anything — system prompt and tool definitions.
function baselineOf(events: RecentEvent[]): number {
  let min = Infinity;
  for (const e of events) {
    const ctx = e.inT + e.cacheR + e.cacheC;
    if (ctx > 0) min = Math.min(min, ctx);
  }
  return min === Infinity ? 0 : min;
}

/// `mcp__claude_ai_Atlassian_Rovo__getJiraIssue` → the "Atlassian Rovo"
/// server, tool `getJiraIssue`; anything else is its own group.
export function toolGroup(name: string): { key: string; name: string; mcp: boolean; tool?: string } {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!m) return { key: name, name, mcp: false };
  const server = m[1].replace(/^claude_ai_/, '').replace(/[_-]+/g, ' ').trim();
  return { key: `mcp:${m[1]}`, name: server, mcp: true, tool: m[2] };
}

/// A tool_result's content — a string, or text and image blocks — as tokens.
export function estimateResultTokens(content: unknown): number {
  if (typeof content === 'string') return Math.ceil(content.length / CHARS_PER_TOKEN);
  if (!Array.isArray(content)) return 0;
  let tokens = 0;
  for (const block of content) {
    if (block?.type === 'image') tokens += IMAGE_TOKENS;
    else if (typeof block?.text === 'string') tokens += Math.ceil(block.text.length / CHARS_PER_TOKEN);
  }
  return tokens;
}
