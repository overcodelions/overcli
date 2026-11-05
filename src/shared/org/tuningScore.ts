// How a worker is doing, from its runs: the Tuning tab's scoreboard. Counted,
// with no model turn. It says whether runs went cleanly and how long they took,
// not whether the answers were right: only a person's rating speaks to that.

export type RunResult = 'good' | 'rough' | 'failed' | 'running';

export interface ScoredRun {
  id: string;
  number: number;
  at: number;
  title: string;
  result: RunResult;
  /// Why it isn't good, in a few words.
  why?: string;
  minutes: number;
  /// Inside its steps.
  working: number;
  /// Between its steps, nothing happening: approvals, mostly.
  waiting: number;
  /// Tool calls refused in it.
  refused?: number;
  steps: Array<{ id: string; minutes: number }>;
}

export interface RunStats {
  runs: number;
  /// Runs that went cleanly, of those that ended.
  cleanPct: number;
  medianMinutes: number;
  medianWaiting: number;
  /// Runs with a tool refused.
  refusedRuns: number;
}

export type VerdictKind = 'better' | 'same' | 'worse' | 'waiting' | 'early';

export interface Verdict {
  kind: VerdictKind;
  /// What was compared: around its latest change, or recent runs and earlier ones.
  basis: 'change' | 'recent';
  before?: RunStats;
  after?: RunStats;
  /// Runs still needed before it can say.
  needs?: number;
}

export interface TuningScore {
  runs: ScoredRun[];
  changes: Array<{ at: number; title: string }>;
  recent: RunStats;
  previous: RunStats | null;
  verdict: Verdict;
  /// Where its recent time goes: typical minutes per step, biggest first.
  steps: Array<{ id: string; minutes: number }>;
}

/// Runs a comparison stands on, each side. Fewer is noise.
export const MIN_RUNS = 3;
const WINDOW = 10;

const round = (n: number) => Math.round(n * 10) / 10;

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}

export function runStats(runs: readonly ScoredRun[]): RunStats {
  const ended = runs.filter((r) => r.result !== 'running');
  return {
    runs: ended.length,
    cleanPct: ended.length ? Math.round((100 * ended.filter((r) => r.result === 'good').length) / ended.length) : 0,
    medianMinutes: median(ended.map((r) => r.minutes)),
    medianWaiting: median(ended.map((r) => r.waiting)),
    refusedRuns: ended.filter((r) => (r.refused ?? 0) > 0).length,
  };
}

/// Better, worse or the same. Going wrong more often outweighs being quicker:
/// a run that fails fast isn't an improvement.
export function judge(before: RunStats, after: RunStats): 'better' | 'same' | 'worse' {
  const clean = after.cleanPct - before.cleanPct;
  if (clean <= -10) return 'worse';
  if (clean >= 10) return 'better';
  if (before.medianMinutes <= 0) return 'same';
  const time = (after.medianMinutes - before.medianMinutes) / before.medianMinutes;
  if (time <= -0.2) return 'better';
  if (time >= 0.25) return 'worse';
  return 'same';
}

/// What should make overgo look at a worker by itself: what has gone wrong
/// since its last review, in words. None: leave it be.
export function watchReasons(runsSince: readonly ScoredRun[], notUsefulSince: number): string[] {
  const ended = runsSince.filter((r) => r.result !== 'running').slice(-10);
  const out: string[] = [];
  const refused = ended.filter((r) => (r.refused ?? 0) > 0).length;
  if (refused >= 3) out.push(`${refused} of its last ${ended.length} runs had tools refused`);
  const failed = ended.filter((r) => r.result === 'failed').length;
  if (failed >= 2) out.push(`${failed} of its last ${ended.length} runs failed`);
  const waited = ended.filter((r) => r.waiting >= 5 && r.waiting > r.working).length;
  if (waited >= 3) out.push(`${waited} of its last ${ended.length} runs spent most of their time waiting`);
  if (notUsefulSince >= 2) out.push(`${notUsefulSince} pieces of its work were marked not useful`);
  return out;
}

/// What a change did, in a line: "Since this change: 0 of 5 runs had tools
/// refused (was 3 of 10); waiting down from 25 min to 2 min; a typical run
/// takes 3 min (was 5 min)."
export function impactLine(before: RunStats, after: RunStats): string {
  const parts = [`${after.refusedRuns} of ${after.runs} runs had tools refused (was ${before.refusedRuns} of ${before.runs})`];
  const [was, now] = [before.medianWaiting, after.medianWaiting];
  if (was !== now) parts.push(`waiting ${now < was ? 'down' : 'up'} from ${was} min to ${now} min`);
  parts.push(`a typical run takes ${after.medianMinutes} min (was ${before.medianMinutes} min)`);
  parts.push(`${after.cleanPct}% ran clean (was ${before.cleanPct}%)`);
  return `Since this change: ${parts.join('; ')}.`;
}

/// Its runs either side of a moment, as far as they can be compared.
export function aroundChange(runs: readonly ScoredRun[], at: number): Omit<Verdict, 'basis'> {
  const ended = runs.filter((r) => r.result !== 'running');
  const before = runStats(ended.filter((r) => r.at <= at).slice(-WINDOW));
  const after = runStats(ended.filter((r) => r.at > at).slice(0, WINDOW));
  if (before.runs < MIN_RUNS) return { kind: 'early', before, after };
  if (after.runs < MIN_RUNS) return { kind: 'waiting', before, after, needs: MIN_RUNS - after.runs };
  return { kind: judge(before, after), before, after };
}

/// The scoreboard. `runs` oldest first.
export function scoreRuns(runs: readonly ScoredRun[], changes: ReadonlyArray<{ at: number; title: string }> = []): TuningScore {
  const ended = runs.filter((r) => r.result !== 'running');
  const recentRuns = ended.slice(-WINDOW);
  const earlier = ended.slice(0, -WINDOW).slice(-WINDOW);
  const recent = runStats(recentRuns);
  const previous = earlier.length ? runStats(earlier) : null;
  const latest = changes.reduce<number | null>((m, c) => (m === null || c.at > m ? c.at : m), null);
  let verdict: Verdict;
  if (latest !== null) verdict = { basis: 'change', ...aroundChange(runs, latest) };
  else if (previous && previous.runs >= MIN_RUNS && recent.runs >= MIN_RUNS) verdict = { basis: 'recent', kind: judge(previous, recent), before: previous, after: recent };
  else verdict = { basis: 'recent', kind: 'early', needs: Math.max(0, 2 * MIN_RUNS - ended.length) };
  const byStep = new Map<string, number[]>();
  for (const r of recentRuns) for (const s of r.steps) byStep.set(s.id, [...(byStep.get(s.id) ?? []), s.minutes]);
  const steps = [...byStep.entries()].map(([id, m]) => ({ id, minutes: median(m) })).sort((a, b) => b.minutes - a.minutes).slice(0, 8);
  return { runs: [...runs], changes: [...changes], recent, previous, verdict, steps };
}
