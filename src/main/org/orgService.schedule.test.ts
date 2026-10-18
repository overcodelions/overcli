import { describe, expect, it } from 'vitest';
import type { Orchestration } from '../../shared/flows/orchestration';
import type { Worker } from '../../shared/flows/worker';
import { DEFAULT_ORG_POLICY, type OrgCaller, type OrgPolicy } from '../../shared/org/policy';
import { OrgService, scheduleText } from './orgService';

const PAT = 'U0ACMEPAT';
const SAM = 'U0ACMESAM';
const pat: OrgCaller = { slackUserId: PAT, name: 'Pat', admin: false };
const sam: OrgCaller = { slackUserId: SAM, name: 'Sam', admin: false };
const NOW = new Date(2026, 9, 20, 12).getTime();

function worker(id: string, over: Partial<Worker> = {}): Worker {
  return {
    id,
    name: id[0].toUpperCase() + id.slice(1),
    jobDescription: 'Triages the support queue each morning.',
    projectPath: '/repo',
    cadence: { kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] },
    trust: 'probation',
    caps: { maxItemsPerShift: 3, runIn: 'worktree', allowExternalActions: false } as Worker['caps'],
    budgetUSDPerMonth: 20,
    heartbeatModel: 'sonnet',
    flowIds: ['f'],
    enabled: true,
    createdAt: 0,
    manager: { name: 'Pat', slackUserId: PAT },
    ...over,
  };
}

function batch(id: string, workerId: string, statuses: string[]): Orchestration {
  return {
    id,
    createdAt: NOW - 60_000,
    origin: { kind: 'worker', workerId, workerName: 'Triage', task: 'shift' },
    items: statuses.map((status, i) => ({ status, candidate: { id: `c${i}`, title: `Fix ticket ${i}`, note: i === 0 ? 'Customers hit it daily' : undefined } })),
  } as unknown as Orchestration;
}

function harness(opts: { roster?: Worker[]; batches?: Orchestration[]; policy?: Partial<OrgPolicy> } = {}) {
  const roster = new Map((opts.roster ?? [worker('triage')]).map((w) => [w.id, w]));
  const batches = opts.batches ?? [];
  const calls: string[] = [];
  const policy: OrgPolicy = { ...DEFAULT_ORG_POLICY, ...opts.policy };
  const svc = new OrgService({
    workers: {
      roster: () => [...roster.values()],
      get: (id) => roster.get(id) ?? null,
      save: (w) => {
        roster.set(w.id, w);
        return { ok: true, worker: w };
      },
      setEnabled: () => ({ ok: true }),
      remove: () => ({ ok: true }),
      runErrand: async () => ({ ok: false, error: 'no' }),
      journalFor: () => [],
      spentThisMonth: () => new Map(),
      workerNames: () => [...roster.values()].map((w) => w.name),
    },
    runs: { listRuns: () => [], getRun: () => null, steerRun: () => ({ ok: true }), resumeRun: () => ({ ok: true }) },
    rejectRun: () => ({ ok: true }),
    policy: () => policy,
    draft: async () => ({ ok: false, error: 'not in this test' }),
    saveHire: () => ({ ok: false, error: 'not in this test' }),
    hires: { list: () => [], save: () => {} },
    batches: {
      list: () => batches,
      approve: async (id, ids) => {
        calls.push(`approve:${id}:${ids === 'all' ? 'all' : ids.join(',')}`);
        const b = batches.find((x) => x.id === id)!;
        for (const it of b.items) if (ids === 'all' ? it.status === 'proposed' : ids.includes(it.candidate.id)) (it as { status: string }).status = 'queued';
        return { ok: true, queued: ids === 'all' ? b.items.length : ids.length };
      },
      reject: (id, cid) => {
        calls.push(`skip:${id}:${cid}`);
        const it = batches.find((x) => x.id === id)!.items.find((i) => i.candidate.id === cid)!;
        (it as { status: string }).status = 'rejected';
        return { ok: true };
      },
    },
    runNow: async (id) => {
      calls.push(`run:${id}`);
      return { ok: true };
    },
    snapshots: () => [...roster.values()].map((w) => ({ worker: w, nextShiftAt: NOW + 3_600_000 })),
    now: () => NOW,
  });
  return { svc, roster, calls, batches };
}

describe('schedules', () => {
  it('describes a schedule in words, and shows the next run', () => {
    expect(scheduleText(null)).toBe('When asked');
    const { svc } = harness();
    const [w] = svc.listWorkers(pat);
    expect(w.schedule).not.toBe('When asked');
    expect(w.cadence).toMatchObject({ kind: 'daily', time: '09:00' });
    expect(w.nextRunAt).toBe(NOW + 3_600_000);
  });

  it('lets the manager change the schedule, and not someone else', () => {
    const h = harness();
    expect(h.svc.update(pat, 'triage', { cadence: { kind: 'interval', everyMinutes: 240 } }).ok).toBe(true);
    expect(h.roster.get('triage')!.cadence).toEqual({ kind: 'interval', everyMinutes: 240 });
    expect(h.svc.update(pat, 'triage', { cadence: null }).ok).toBe(true);
    expect(h.roster.get('triage')!.cadence).toBeNull();
    expect(h.svc.update(sam, 'triage', { cadence: { kind: 'daily', time: '07:00' } }).ok).toBe(false);
  });

  it('lets the manager rewrite the job, within sense, and nobody else', () => {
    const h = harness();
    expect(h.svc.update(pat, 'triage', { jobDescription: '  Every morning, triage the new support tickets and label each one.  ' }).ok).toBe(true);
    expect(h.roster.get('triage')!.jobDescription).toBe('Every morning, triage the new support tickets and label each one.');
    expect(h.svc.update(pat, 'triage', { jobDescription: 'too short' }).ok).toBe(false);
    expect(h.svc.update(sam, 'triage', { jobDescription: 'Every morning, do something else entirely for me.' }).ok).toBe(false);
  });

  it('runs a worker now for its manager, but not when paused', async () => {
    const h = harness({ roster: [worker('triage'), worker('idle', { enabled: false })] });
    expect(await h.svc.runNow(pat, 'Triage')).toEqual({ ok: true, name: 'Triage' });
    expect((await h.svc.runNow(sam, 'Triage')).ok).toBe(false);
    expect((await h.svc.runNow(pat, 'idle')).ok).toBe(false);
    expect(h.calls).toEqual(['run:triage']);
  });
});

describe('proposals', () => {
  it('shows a worker’s proposed work to its manager only, and counts it on Today', () => {
    const h = harness({ batches: [batch('b1', 'triage', ['proposed', 'proposed', 'queued'])] });
    const mine = h.svc.proposals(pat);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ batchId: 'b1', workerId: 'triage', task: 'shift' });
    expect(mine[0].items.map((i) => i.candidateId)).toEqual(['c0', 'c1']);
    expect(mine[0].items[0].detail).toBe('Customers hit it daily');
    expect(h.svc.proposals(sam)).toEqual([]);
    expect(h.svc.today(pat).proposals).toHaveLength(1);
    expect(h.svc.managerSlackId('triage')).toBe(PAT);
  });

  it('approves some and skips the rest', async () => {
    const h = harness({ batches: [batch('b1', 'triage', ['proposed', 'proposed', 'proposed'])] });
    expect(await h.svc.decideProposal(pat, 'b1', { approve: ['c0', 'c2'], skip: ['c1'] })).toEqual({ ok: true, queued: 2, skipped: 1 });
    expect(h.calls).toEqual(['skip:b1:c1', 'approve:b1:c0,c2']);
    expect(h.svc.proposals(pat)).toEqual([]);
  });

  it('approves everything with "all", and refuses someone who is not the manager', async () => {
    const h = harness({ batches: [batch('b1', 'triage', ['proposed', 'proposed'])] });
    expect((await h.svc.decideProposal(sam, 'b1', { approve: 'all' })).ok).toBe(false);
    expect(await h.svc.decideProposal(pat, 'b1', { approve: 'all' })).toEqual({ ok: true, queued: 2, skipped: 0 });
    expect(h.calls).toEqual(['approve:b1:all']);
    expect((await h.svc.decideProposal(pat, 'b1', { approve: 'all' })).ok).toBe(false);
  });

  it('skips everything without approving anything', async () => {
    const h = harness({ batches: [batch('b1', 'triage', ['proposed', 'proposed'])] });
    expect(await h.svc.decideProposal(pat, 'b1', { approve: [], skip: ['c0', 'c1'] })).toEqual({ ok: true, queued: 0, skipped: 2 });
    expect(h.calls).toEqual(['skip:b1:c0', 'skip:b1:c1']);
  });
});
