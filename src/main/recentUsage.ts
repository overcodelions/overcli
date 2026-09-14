// The trailing-8-hours view on the Usage page: what used up a Claude
// session window. Pure — stats.ts hands over the transcripts it has already
// parsed, so this adds no extra disk reads.

import { RecentSession, RecentTurn, RecentUsage } from '../shared/types';
import { estimateCost } from '../shared/modelPricing';

export const RECENT_RANGE_MS = 8 * 3600 * 1000;
export const RECENT_BUCKET_MS = 15 * 60 * 1000;
const HEAVIEST_TURNS = 5;

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

  for (const t of transcripts) {
    let counted = false;
    for (const e of t.events) {
      if (e.ts === null || e.ts < start || e.ts >= end) continue;
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
          firstTs: e.ts,
          lastTs: e.ts,
          contextSum: 0,
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
        s.turns += 1;
        s.contextSum += e.inT + e.cacheR + e.cacheC;
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
    .map(({ contextSum, ...s }) => ({
      ...s,
      models: Array.from(models.get(s.id) ?? []).sort(),
      avgContextTokens: s.turns > 0 ? Math.round(contextSum / s.turns) : 0,
    }))
    .sort((a, b) => b.costUSD - a.costUSD);

  const heaviestTurns = turns.sort((a, b) => b.costUSD - a.costUSD).slice(0, HEAVIEST_TURNS);

  const limitWindow =
    limit && limit.resetsAt > start && limit.start < end ? { ...limit } : undefined;

  return {
    start,
    end,
    bucketMs: RECENT_BUCKET_MS,
    buckets,
    sessions: sessionRows,
    heaviestTurns,
    byType,
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
