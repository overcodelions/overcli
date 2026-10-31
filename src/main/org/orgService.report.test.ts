import { describe, expect, it } from 'vitest';
import type { FlowRun } from '../../shared/flows/schema';
import type { Worker } from '../../shared/flows/worker';
import { buildWorkerReport, WORKER_HUMAN_TIME_SAVED_MULTIPLIER, type WorkerReport, type WorkerRunFact } from '../../shared/flows/workerReport';
import { DEFAULT_ORG_POLICY, type OrgCaller } from '../../shared/org/policy';
import { OrgService, type OrgServiceDeps } from './orgService';

const PAT = 'U0ACMEPAT';
const SAM = 'U0ACMESAM';
const pat: OrgCaller = { slackUserId: PAT, name: 'Pat', admin: false };
const admin: OrgCaller = { name: 'admin', admin: true };

const NOW = new Date(2026, 8, 10, 12).getTime();

function worker(id: string, over: Partial<Worker> = {}): Worker {
  return {
    id,
    name: id[0].toUpperCase() + id.slice(1),
    jobDescription: 'Watches acme competitor sites and reports changes each week.',
    projectPath: '/repo',
    cadence: null,
    trust: 'probation',
    caps: { maxItemsPerShift: 1, runIn: 'worktree', allowExternalActions: false } as Worker['caps'],
    budgetUSDPerMonth: 20,
    heartbeatModel: 'sonnet',
    flowIds: ['f'],
    enabled: true,
    createdAt: 0,
    ...over,
  };
}

function run(workerId: string, costUSD: number, at = NOW - 60_000): WorkerRunFact {
  return { workerId, completed: true, turns: 1, inputTokens: 10, outputTokens: 5, costUSD, wallClockMs: 120_000, terminalAt: at };
}

function harness(opts: { withReport?: boolean; facts?: WorkerRunFact[]; flowRuns?: FlowRun[] } = {}) {
  const roster = [
    worker('ana', { manager: { name: 'Pat', slackUserId: PAT }, budgetUSDPerMonth: 15 }),
    worker('ben', { manager: { name: 'Sam', slackUserId: SAM }, visibility: 'org' }),
    worker('cal', { manager: { name: 'Sam', slackUserId: SAM }, visibility: 'private' }),
  ];
  const facts = opts.facts ?? [run('ana', 1), run('ben', 2), run('cal', 40)];
  const asked: number[] = [];
  const report = (sinceMs: number): WorkerReport => {
    asked.push(sinceMs);
    return buildWorkerReport({ workers: roster, journal: () => [], orchestrations: [], runs: facts, sinceMs, generatedAt: NOW });
  };
  const deps: OrgServiceDeps = {
    workers: {
      roster: () => roster,
      get: (id) => roster.find((w) => w.id === id) ?? null,
      save: (w) => ({ ok: true, worker: w }),
      setEnabled: () => ({ ok: true }),
      remove: () => ({ ok: true }),
      runErrand: async () => ({ ok: false, error: 'no' }),
      journalFor: () => [],
      spentThisMonth: () => new Map(),
      workerNames: () => roster.map((w) => w.name),
    },
    runs: { listRuns: () => opts.flowRuns ?? [], getRun: () => null, steerRun: () => ({ ok: true }), resumeRun: () => ({ ok: true }) },
    rejectRun: () => ({ ok: true }),
    policy: () => ({ ...DEFAULT_ORG_POLICY }),
    draft: async () => ({ ok: false, error: 'not in this test' }),
    saveHire: () => ({ ok: false, error: 'not in this test' }),
    hires: { list: () => [], save: () => {} },
    now: () => NOW,
    ...(opts.withReport === false ? {} : { report }),
  };
  return { svc: new OrgService(deps), asked };
}

describe('OrgService.report', () => {
  it('counts the pull requests runs opened in the window, by worker and in total', () => {
    const landed = (id: string, workerId: string, createdAt: number, lines: string[]) =>
      ({ id, workerId, createdAt, state: { kind: 'done', success: true }, attempts: [], flowSnapshot: { name: 'f', steps: [] }, artifacts: { 'pull-requests.md': { name: 'pull-requests.md', body: lines.join('\n'), producedAt: createdAt } } }) as unknown as FlowRun;
    const open = (n: number) => `- Opened a pull request for acme-api: https://bitbucket.org/acme/acme-api/pull-requests/${n} (branch fix/acme-${n})`;
    const { svc } = harness({
      flowRuns: [
        landed('a1', 'ana', NOW - 3_600_000, [open(1)]),
        // A draft counts; one it only added commits to, or found open, doesn't.
        landed('a2', 'ana', NOW - 7_200_000, ['- Opened a draft pull request for acme-web: https://bitbucket.org/acme/acme-web/pull-requests/2 (branch fix/acme-web)', '- acme-api: added to fix/acme-1, so its open pull request has the new commits: https://bitbucket.org/acme/acme-api/pull-requests/1']),
        landed('a3', 'ana', NOW - 60 * 86_400_000, [open(3)]),
        landed('c1', 'cal', NOW - 3_600_000, [open(4)]),
      ],
    });
    const month = svc.report(pat, 30);
    if (!month.ok) throw new Error(month.error);
    expect(month.report.byWorker.map((r) => [r.workerId, r.pullRequests])).toEqual([['ana', 2], ['ben', 0]]);
    expect(month.report.totals.pullRequests).toBe(2);
    const all = svc.report(admin, 0);
    expect(all.ok && all.report.totals.pullRequests).toBe(4);
  });

  it('counts time saved at 1.5× agent time, and a run that opened a pull request at 6× or 1 hour, whichever is more', () => {
    const minute = 60_000;
    const pr = (id: string, workerId: string, ms: number) =>
      ({ id, workerId, createdAt: NOW - 3_600_000, state: { kind: 'done', success: true }, flowSnapshot: { name: 'f', steps: [] },
        attempts: [{ startedAt: NOW - 3_600_000, endedAt: NOW - 3_600_000 + ms }],
        artifacts: { 'pull-requests.md': { name: 'pull-requests.md', body: `- Opened a pull request for acme-api: https://bitbucket.org/acme/acme-api/pull-requests/${id} (branch fix/${id})`, producedAt: NOW } } }) as unknown as FlowRun;
    // Facts: 2 minutes of agent time each for ana and ben (the run() helper), and hidden cal.
    const { svc } = harness({ flowRuns: [pr('1', 'ana', 20 * minute), pr('2', 'ana', 3 * minute), pr('3', 'cal', 30 * minute)] });
    const res = svc.report(pat, 30);
    if (!res.ok) throw new Error(res.error);
    const base = res.report.totals.workedMs * 1.5;
    // 20 min → 120 min (6×) less the 30 it already had; 3 min → 60 min (the floor) less 4.5. Cal's is hidden.
    expect(res.saved).toEqual({ ms: base + (120 - 30) * minute + (60 - 4.5) * minute, prRuns: 2, prMultiplier: 6, prMinHours: 1 });
  });

  it('gives each worker its month so far: runs started, runs failed, pull requests opened', () => {
    const at = (id: string, createdAt: number, state: Record<string, unknown>, body = '') =>
      ({ id, workerId: 'ana', createdAt, state, attempts: [], flowSnapshot: { name: 'f', steps: [] }, artifacts: body ? { 'pull-requests.md': { name: 'pull-requests.md', body, producedAt: createdAt } } : {} }) as unknown as FlowRun;
    const { svc } = harness({
      flowRuns: [
        at('m1', NOW - 3_600_000, { kind: 'done', success: true }, '- Opened a pull request for acme-api: https://bitbucket.org/acme/acme-api/pull-requests/9 (branch fix/acme-9)'),
        at('m2', NOW - 7_200_000, { kind: 'done', success: false }),
        at('m3', NOW - 60_000, { kind: 'running', currentStepId: 's' }),
        // Last month: not counted.
        at('m4', new Date(2026, 7, 20).getTime(), { kind: 'done', success: true }, '- Opened a pull request for acme-api: https://bitbucket.org/acme/acme-api/pull-requests/8 (branch fix/acme-8)'),
      ],
    });
    const ana = svc.listWorkers(admin).find((w) => w.id === 'ana')!;
    expect(ana.month).toEqual({ runs: 3, failed: 1, pullRequests: 1 });
    expect(svc.listWorkers(admin).find((w) => w.id === 'ben')!.month).toEqual({ runs: 0, failed: 0, pullRequests: 0 });
  });

  it('shows only the workers the caller can see, and leaves the hidden ones out of the totals', () => {
    const { svc } = harness();
    const res = svc.report(pat, 30);
    if (!res.ok) throw new Error(res.error);
    expect(res.report.byWorker.map((r) => r.workerId)).toEqual(['ana', 'ben']);
    expect(res.report.totals.costUSD).toBe(3);
    expect(res.report.totals.runs).toBe(2);
    expect(res.report.daily.reduce((n, d) => n + d.costUSD, 0)).toBe(3);
    expect(res.savedMultiplier).toBe(WORKER_HUMAN_TIME_SAVED_MULTIPLIER);

    const ana = res.report.byWorker.find((r) => r.workerId === 'ana')!;
    expect(ana).toMatchObject({ manager: 'Pat', youManage: true, budgetUSDPerMonth: 15 });
    const ben = res.report.byWorker.find((r) => r.workerId === 'ben')!;
    expect(ben).toMatchObject({ manager: 'Sam', youManage: false, budgetUSDPerMonth: 20 });
  });

  it('gives an admin the whole roster', () => {
    const res = harness().svc.report(admin, 0);
    if (!res.ok) throw new Error(res.error);
    expect(res.report.byWorker).toHaveLength(3);
    expect(res.report.totals.costUSD).toBe(43);
    expect(res.report.days).toBe(0);
    expect(res.report.sinceMs).toBe(0);
  });

  it('snaps 7 and 30 days to whole local days, and refuses any other window', () => {
    const { svc, asked } = harness();
    const week = svc.report(pat, 7);
    if (!week.ok) throw new Error(week.error);
    expect(week.report.daily).toHaveLength(7);
    expect(new Date(asked[0]).getHours()).toBe(0);
    expect(svc.report(pat, 30).ok && asked[1] < asked[0]).toBe(true);
    // Not a number: the default window.
    const fallback = svc.report(pat, Number('soon'));
    expect(fallback.ok && fallback.report.days).toBe(30);
    expect(svc.report(pat, 14)).toEqual({ ok: false, error: 'Pick 7 days, 30 days or all time (0).' });
    expect(svc.report(pat, -7).ok).toBe(false);
  });

  it('says so when the host has no report', () => {
    expect(harness({ withReport: false }).svc.report(pat, 30)).toEqual({ ok: false, error: 'Reports are not available on this server.' });
  });

  it("does not let a hidden worker's earlier first activity stretch the all-time axis", () => {
    const DAY = 86_400_000;
    const { svc } = harness({ facts: [run('ana', 1, NOW - 2 * DAY), run('ben', 2, NOW), run('cal', 40, NOW - 20 * DAY)] });
    const mine = svc.report(pat, 0);
    if (!mine.ok) throw new Error(mine.error);
    expect(mine.report.daily).toHaveLength(3);
    expect(mine.report.daily[0].costUSD).toBe(1);
    for (const r of mine.report.byWorker) expect(r.daily.map((d) => d.day)).toEqual(mine.report.daily.map((d) => d.day));
    expect(mine.report.totals.costUSD).toBe(3);
    // Someone who can see the early worker still gets the whole span.
    const all = svc.report(admin, 0);
    expect(all.ok && all.report.daily).toHaveLength(21);
  });

  it('keeps one day when nothing visible ever happened', () => {
    const { svc } = harness({ facts: [run('cal', 40, NOW - 5 * 86_400_000)] });
    const res = svc.report(pat, 0);
    if (!res.ok) throw new Error(res.error);
    expect(res.report.daily).toHaveLength(1);
    expect(res.report.totals.costUSD).toBe(0);
    expect(res.report.byWorker.every((r) => r.daily.length === 1)).toBe(true);
  });
});
