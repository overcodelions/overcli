// What the server is doing, for the org's own monitoring: Prometheus text at
// /metrics on a listener of its own (`--metrics` / $OVERCLI_METRICS), off
// unless someone turns it on.
//
// Everything is read from the state the server already keeps, at scrape time:
// the runs, the roster and its spend, what's waiting on people. Nothing is
// sent anywhere; a Prometheus (or an OpenTelemetry collector's prometheus
// receiver) inside the network pulls it.
//
// The counters (runs finished, their cost and length) count runs that ended
// since this process started. Runs already over at startup are seeded as
// seen, so a restart reads as a counter reset, which Prometheus expects,
// never as a burst of old work.

import type { FlowRun } from '../../shared/flows/schema';
import type { UUID } from '../../shared/types';
import type { ToolTrouble } from './toolHealth';

export interface MetricsSource {
  workers(): Array<{ id: UUID; name: string; budgetUSDPerMonth: number }>;
  spentThisMonth(): Map<UUID, number>;
  runs(): FlowRun[];
  /// Work waiting for each worker to be free. Absent: not reported.
  waiting?(): Map<UUID, number>;
  /// Hires waiting on an approver, asks still being answered, tools failing.
  counts(): { hiresAwaiting: number; asksWorking: number; toolTrouble: ToolTrouble[] };
  version?(): string;
  now?(): number;
}

type Outcome = 'done' | 'failed' | 'stopped';
type Waiting = 'working' | 'approval' | 'question' | 'failure' | 'interrupted' | 'held';

/// Run length buckets, in seconds: a minute to two hours, then the rest.
export const DURATION_BUCKETS = [60, 300, 900, 1800, 3600, 7200];

const NO_WORKER = '';

export class ServerMetrics {
  private readonly seen = new Set<UUID>();
  private readonly finished = new Map<string, number>();
  private readonly cost = new Map<string, number>();
  private readonly durations = new Map<string, { buckets: number[]; sum: number; count: number }>();

  constructor(private readonly src: MetricsSource) {
    for (const r of src.runs()) if (outcomeOf(r)) this.seen.add(r.id);
  }

  private now(): number {
    return this.src.now?.() ?? Date.now();
  }

  /// Count runs that ended since the last look.
  private collect(runs: FlowRun[], names: Map<UUID, string>): void {
    for (const r of runs) {
      const outcome = outcomeOf(r);
      if (!outcome || this.seen.has(r.id)) continue;
      this.seen.add(r.id);
      const worker = r.workerId ? names.get(r.workerId) ?? r.workerId : NO_WORKER;
      const key = labels({ worker, outcome });
      this.finished.set(key, (this.finished.get(key) ?? 0) + 1);
      const wk = labels({ worker });
      if (r.costUSD) this.cost.set(wk, (this.cost.get(wk) ?? 0) + r.costUSD);
      const seconds = Math.max(0, (endedAt(r) - r.createdAt) / 1000);
      const d = this.durations.get(wk) ?? { buckets: DURATION_BUCKETS.map(() => 0), sum: 0, count: 0 };
      DURATION_BUCKETS.forEach((le, i) => {
        if (seconds <= le) d.buckets[i] += 1;
      });
      d.sum += seconds;
      d.count += 1;
      this.durations.set(wk, d);
    }
  }

  /// The exposition, in Prometheus text format 0.0.4.
  render(): string {
    const now = this.now();
    const roster = this.src.workers();
    const names = new Map(roster.map((w) => [w.id, w.name]));
    const runs = this.src.runs();
    this.collect(runs, names);
    const workerOf = (r: FlowRun): string => (r.workerId ? names.get(r.workerId) ?? r.workerId : NO_WORKER);

    const out: string[] = [];
    const metric = (name: string, type: 'gauge' | 'counter' | 'histogram', help: string, rows: Array<[string, number]>) => {
      out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
      for (const [l, v] of rows) out.push(`${name}${l} ${num(v)}`);
    };

    const version = this.src.version?.();
    metric('overcli_up', 'gauge', 'The server is up.', [['', 1]]);
    if (version) metric('overcli_build_info', 'gauge', 'The server version.', [[labels({ version }), 1]]);
    metric('overcli_workers', 'gauge', 'Workers on the server.', [['', roster.length]]);

    // Runs under way, by what they are doing; and the oldest of each kind of
    // wait on a person, timed from when the run last did anything.
    const going = new Map<string, number>();
    const oldest = new Map<string, number>();
    for (const r of runs) {
      const state = waitingOf(r);
      if (!state) continue;
      const k = labels({ worker: workerOf(r), state });
      going.set(k, (going.get(k) ?? 0) + 1);
      if (state !== 'working') {
        const s = labels({ state });
        oldest.set(s, Math.max(oldest.get(s) ?? 0, Math.max(0, (now - endedAt(r)) / 1000)));
      }
    }
    metric('overcli_runs_in_progress', 'gauge', 'Runs not yet over, by worker and state (working, or waiting on approval, a question, a failure, a restart, a hold).', [...going]);
    metric('overcli_runs_waiting_oldest_seconds', 'gauge', 'How long the longest-waiting run in each state has been waiting on a person.', [...oldest]);

    metric('overcli_runs_finished_total', 'counter', 'Runs that ended since the server started, by worker and outcome.', [...this.finished]);
    metric('overcli_run_cost_usd_total', 'counter', 'What runs that ended since the server started cost, by worker.', [...this.cost]);
    out.push('# HELP overcli_run_duration_seconds How long runs that ended since the server started took, by worker.', '# TYPE overcli_run_duration_seconds histogram');
    for (const [wk, d] of this.durations) {
      DURATION_BUCKETS.forEach((le, i) => out.push(`overcli_run_duration_seconds_bucket${withLabel(wk, 'le', String(le))} ${d.buckets[i]}`));
      out.push(`overcli_run_duration_seconds_bucket${withLabel(wk, 'le', '+Inf')} ${d.count}`);
      out.push(`overcli_run_duration_seconds_sum${wk} ${num(d.sum)}`, `overcli_run_duration_seconds_count${wk} ${d.count}`);
    }

    const waiting = this.src.waiting?.();
    if (waiting) {
      metric('overcli_worker_queue_depth', 'gauge', 'Work waiting for a worker to be free.', roster.map((w) => [labels({ worker: w.name }), waiting.get(w.id) ?? 0]));
    }

    const spent = this.src.spentThisMonth();
    metric('overcli_worker_spend_month_usd', 'gauge', 'What each worker has spent this calendar month.', roster.map((w) => [labels({ worker: w.name }), spent.get(w.id) ?? 0]));
    metric('overcli_worker_budget_month_usd', 'gauge', 'Each worker\'s monthly budget.', roster.map((w) => [labels({ worker: w.name }), w.budgetUSDPerMonth]));

    const c = this.src.counts();
    metric('overcli_asks_in_progress', 'gauge', 'Questions people asked that are still being answered.', [['', c.asksWorking]]);
    metric('overcli_hires_awaiting_approval', 'gauge', 'Hires waiting on an approver.', [['', c.hiresAwaiting]]);
    metric('overcli_tool_errors_in_a_row', 'gauge', 'Tools failing now: errors since the last call that worked, by tool and kind (auth, gone, failing).', c.toolTrouble.map((t) => [labels({ tool: t.tool, kind: t.kind }), t.count]));

    return `${out.join('\n')}\n`;
  }
}

function outcomeOf(r: FlowRun): Outcome | null {
  switch (r.state.kind) {
    case 'done':
    case 'watching':
    case 'archived':
      return r.state.kind === 'done' && !r.state.success ? 'failed' : 'done';
    case 'aborted':
      return 'stopped';
    default:
      return null;
  }
}

function waitingOf(r: FlowRun): Waiting | null {
  if (r.state.kind === 'running') return 'working';
  if (r.state.kind !== 'paused') return null;
  switch (r.state.reason) {
    case 'needsInput':
      return 'question';
    case 'externalAction':
    case 'riskyStep':
    case 'preStep':
      return 'approval';
    case 'failure':
      return 'failure';
    case 'interrupted':
      return 'interrupted';
    case 'held':
      return 'held';
  }
}

function endedAt(r: FlowRun): number {
  return Math.max(r.createdAt, ...(r.attempts ?? []).map((a) => a.endedAt ?? a.startedAt ?? 0));
}

function escape(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

/// `{a="x",b="y"}`, in the order given; empty for no labels.
export function labels(l: Record<string, string>): string {
  const parts = Object.entries(l).map(([k, v]) => `${k}="${escape(v)}"`);
  return parts.length ? `{${parts.join(',')}}` : '';
}

function withLabel(set: string, k: string, v: string): string {
  const one = `${k}="${escape(v)}"`;
  return set ? `${set.slice(0, -1)},${one}}` : `{${one}}`;
}

function num(v: number): string {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Infinity) return '+Inf';
  if (v === -Infinity) return '-Inf';
  return String(Math.round(v * 1e6) / 1e6);
}
