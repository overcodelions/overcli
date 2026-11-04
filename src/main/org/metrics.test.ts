import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import type { FlowRun, FlowRunState } from '../../shared/flows/schema';
import { ServerMetrics, labels, type MetricsSource } from './metrics';
import { createMetricsServer, METRICS_CONTENT_TYPE } from '../../cli/metricsServer';
import { parseArgs } from '../../cli/args';

const NOW = 1_800_000_000_000;

function run(id: string, state: FlowRunState, opts: { workerId?: string; createdAt?: number; endedAt?: number; costUSD?: number } = {}): FlowRun {
  const createdAt = opts.createdAt ?? NOW - 600_000;
  return {
    id,
    flowId: 'f',
    flowSnapshot: { steps: [] },
    projectPath: '/p',
    userPrompt: '',
    conversationIds: {},
    artifacts: {},
    state,
    createdAt,
    ...(opts.workerId ? { workerId: opts.workerId } : {}),
    ...(opts.costUSD ? { costUSD: opts.costUSD } : {}),
    attempts: opts.endedAt ? [{ stepId: 's', startedAt: createdAt, endedAt: opts.endedAt }] : [],
  } as unknown as FlowRun;
}

function source(runs: FlowRun[], over: Partial<MetricsSource> = {}): MetricsSource & { runsList: FlowRun[] } {
  const s: MetricsSource & { runsList: FlowRun[] } = {
    runsList: runs,
    workers: () => [
      { id: 'w1', name: 'Analyst', budgetUSDPerMonth: 50 },
      { id: 'w2', name: 'Say "hi"\\now', budgetUSDPerMonth: 20 },
    ],
    spentThisMonth: () => new Map([['w1', 12.5]]),
    runs: (): FlowRun[] => s.runsList,
    waiting: () => new Map([['w1', 2]]),
    counts: () => ({ hiresAwaiting: 1, asksWorking: 3, toolTrouble: [{ tool: 'tracker', kind: 'auth' as const, since: 0, lastAt: 0, count: 4, lastError: '401', workers: [] }] }),
    version: () => '0.24.5',
    now: () => NOW,
    ...over,
  };
  return s;
}

function line(text: string, prefix: string): string | undefined {
  return text.split('\n').find((l) => l.startsWith(prefix));
}

describe('ServerMetrics', () => {
  it('reports gauges from the state it reads', () => {
    const text = new ServerMetrics(
      source([
        run('a', { kind: 'running', currentStepId: 's' } as FlowRunState, { workerId: 'w1' }),
        run('b', { kind: 'paused', nextStepId: 's', reason: 'externalAction' }, { workerId: 'w1', endedAt: NOW - 90_000 }),
        run('c', { kind: 'paused', nextStepId: 's', reason: 'riskyStep' }, { workerId: 'w2', endedAt: NOW - 30_000 }),
        run('d', { kind: 'paused', nextStepId: 's', reason: 'needsInput' }, { endedAt: NOW - 5_000 }),
      ]),
    ).render();

    expect(text).toContain('overcli_up 1');
    expect(text).toContain('overcli_build_info{version="0.24.5"} 1');
    expect(text).toContain('overcli_workers 2');
    expect(text).toContain('overcli_runs_in_progress{worker="Analyst",state="working"} 1');
    expect(text).toContain('overcli_runs_in_progress{worker="Analyst",state="approval"} 1');
    expect(text).toContain('overcli_runs_in_progress{worker="",state="question"} 1');
    expect(text).toContain('overcli_runs_waiting_oldest_seconds{state="approval"} 90');
    expect(text).toContain('overcli_runs_waiting_oldest_seconds{state="question"} 5');
    expect(text).toContain('overcli_worker_queue_depth{worker="Analyst"} 2');
    expect(text).toContain('overcli_worker_spend_month_usd{worker="Analyst"} 12.5');
    expect(text).toContain('overcli_worker_budget_month_usd{worker="Analyst"} 50');
    expect(text).toContain('overcli_asks_in_progress 3');
    expect(text).toContain('overcli_hires_awaiting_approval 1');
    expect(text).toContain('overcli_tool_errors_in_a_row{tool="tracker",kind="auth"} 4');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('escapes label values', () => {
    expect(labels({ worker: 'Say "hi"\\now\nok' })).toBe('{worker="Say \\"hi\\"\\\\now\\nok"}');
    const text = new ServerMetrics(source([])).render();
    expect(text).toContain('overcli_worker_budget_month_usd{worker="Say \\"hi\\"\\\\now"} 20');
  });

  it('counts only runs that end after it starts, once each', () => {
    const src = source([run('old', { kind: 'done', success: true }, { workerId: 'w1', costUSD: 9 })]);
    const metrics = new ServerMetrics(src);
    expect(line(metrics.render(), 'overcli_runs_finished_total{')).toBeUndefined();

    src.runsList = [
      ...src.runsList,
      run('ok', { kind: 'done', success: true }, { workerId: 'w1', createdAt: NOW - 120_000, endedAt: NOW, costUSD: 1.25 }),
      run('bad', { kind: 'done', success: false }, { workerId: 'w1', createdAt: NOW - 30_000, endedAt: NOW, costUSD: 0.5 }),
      run('stop', { kind: 'aborted' }, { workerId: 'w2' }),
      run('busy', { kind: 'running', currentStepId: 's' } as FlowRunState, { workerId: 'w1' }),
    ];
    const first = metrics.render();
    expect(first).toContain('overcli_runs_finished_total{worker="Analyst",outcome="done"} 1');
    expect(first).toContain('overcli_runs_finished_total{worker="Analyst",outcome="failed"} 1');
    expect(first).toContain('overcli_runs_finished_total{worker="Say \\"hi\\"\\\\now",outcome="stopped"} 1');
    expect(first).toContain('overcli_run_cost_usd_total{worker="Analyst"} 1.75');
    expect(first).toContain('overcli_run_duration_seconds_bucket{worker="Analyst",le="60"} 1');
    expect(first).toContain('overcli_run_duration_seconds_bucket{worker="Analyst",le="300"} 2');
    expect(first).toContain('overcli_run_duration_seconds_bucket{worker="Analyst",le="+Inf"} 2');
    expect(first).toContain('overcli_run_duration_seconds_sum{worker="Analyst"} 150');
    expect(first).toContain('overcli_run_duration_seconds_count{worker="Analyst"} 2');

    // A watched run is still a finished one, and is not counted again.
    src.runsList = src.runsList.map((r) => (r.id === 'ok' ? { ...r, state: { kind: 'archived' } as FlowRunState } : r));
    expect(metrics.render()).toContain('overcli_runs_finished_total{worker="Analyst",outcome="done"} 1');
  });

  it('leaves the queue out when nothing reports it', () => {
    expect(new ServerMetrics(source([], { waiting: undefined })).render()).not.toContain('overcli_worker_queue_depth');
  });
});

describe('the metrics listener', () => {
  let server: http.Server | null = null;
  afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

  async function serve(token?: string, onScrape?: (ok: boolean) => void): Promise<string> {
    server = createMetricsServer(new ServerMetrics(source([])), { ...(token ? { token } : {}), ...(onScrape ? { onScrape } : {}) });
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('serves the exposition at /metrics and nothing else', async () => {
    const base = await serve();
    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(METRICS_CONTENT_TYPE);
    expect(await res.text()).toContain('overcli_up 1');
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/metrics`, { method: 'POST' })).status).toBe(405);
  });

  it('asks for the bearer token when one is set, and says who got in', async () => {
    const seen: boolean[] = [];
    const base = await serve('s3cret', (ok) => seen.push(ok));
    expect((await fetch(`${base}/metrics`)).status).toBe(401);
    expect((await fetch(`${base}/metrics`, { headers: { Authorization: 'Bearer nope' } })).status).toBe(401);
    expect((await fetch(`${base}/metrics`, { headers: { Authorization: 'Bearer s3cret' } })).status).toBe(200);
    expect((await fetch(`${base}/elsewhere`, { headers: { Authorization: 'Bearer s3cret' } })).status).toBe(404);
    expect(seen).toEqual([false, false, true]);
  });

  it('turns away a header of whitespace quickly', async () => {
    const base = await serve('s3cret');
    const started = Date.now();
    const res = await fetch(`${base}/metrics`, { headers: { Authorization: `bearer\t${'\t'.repeat(8000)}x` } });
    expect(res.status).toBe(401);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('--metrics', () => {
  it('takes a port or host:port, loopback by default', () => {
    const bare = parseArgs(['serve', '--metrics', '9464']);
    expect(bare.ok && bare.args.serve?.metrics).toEqual({ host: '127.0.0.1', port: 9464 });
    const any = parseArgs(['serve', '--metrics', '0.0.0.0:9464']);
    expect(any.ok && any.args.serve?.metrics).toEqual({ host: '0.0.0.0', port: 9464 });
  });

  it('names itself in a bad address', () => {
    const bad = parseArgs(['serve', '--metrics', 'nope']);
    expect(!bad.ok && bad.error).toContain('--metrics wants a port or host:port, e.g. 9464');
  });
});
