import { describe, expect, it } from 'vitest';
import type { FlowRun } from '../../shared/flows/schema';
import type { Worker } from '../../shared/flows/worker';
import { DEFAULT_ORG_POLICY, type OrgCaller, type OrgPolicy } from '../../shared/org/policy';
import { OrgService, type PendingHire } from './orgService';
import type { DraftedHire } from './hireDraft';

const PAT = 'U0ACMEPAT';
const SAM = 'U0ACMESAM';
const BOSS = 'U0ACMEBOSS';
const pat: OrgCaller = { slackUserId: PAT, name: 'Pat', admin: false };
const sam: OrgCaller = { slackUserId: SAM, name: 'Sam', admin: false };
const boss: OrgCaller = { slackUserId: BOSS, name: 'Bo', admin: false };

function worker(id: string, over: Partial<Worker> = {}): Worker {
  return {
    id,
    name: id[0].toUpperCase() + id.slice(1),
    jobDescription: 'Reads the product board and writes a weekly summary.',
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

function drafted(over: Partial<DraftedHire['contract']> = {}): DraftedHire {
  return {
    ok: true,
    summary: '',
    flowPlan: [{ flowId: 'weekly' }],
    contract: {
      name: 'Ana',
      jobDescription: 'Watches usage data and writes a weekly product summary.',
      cadence: null,
      maxItemsPerShift: 1,
      budgetUSDPerMonth: 30,
      heartbeatModel: 'sonnet',
      flows: [{ flowId: 'weekly' }],
      ...over,
    },
  } as DraftedHire;
}

function harness(opts: { roster?: Worker[]; runs?: FlowRun[]; policy?: Partial<OrgPolicy>; draft?: DraftedHire | string[] } = {}) {
  const roster = new Map((opts.roster ?? []).map((w) => [w.id, w]));
  const runs = new Map((opts.runs ?? []).map((r) => [r.id, r]));
  let hires: PendingHire[] = [];
  const calls: string[] = [];
  const awaiting: Array<{ hire: PendingHire; approvers: string[] }> = [];
  const decided: Array<{ approved: boolean; by: string }> = [];
  const policy: OrgPolicy = { ...DEFAULT_ORG_POLICY, ...opts.policy };
  const svc = new OrgService({
    workers: {
      roster: () => [...roster.values()],
      get: (id) => roster.get(id) ?? null,
      save: (w) => {
        roster.set(w.id, w);
        return { ok: true, worker: w };
      },
      setEnabled: (id, enabled) => {
        roster.get(id)!.enabled = enabled;
        return { ok: true };
      },
      remove: (id) => {
        roster.delete(id);
        return { ok: true };
      },
      runErrand: async (id, text) => {
        calls.push(`errand:${id}:${text}`);
        return { ok: true, result: { orchestrationId: 'o', count: 0, queued: 0, launchedNothing: true, reply: 'Done.' } };
      },
      journalFor: () => [],
      spentThisMonth: () => new Map(),
      workerNames: () => [...roster.values()].map((w) => w.name),
    },
    runs: {
      listRuns: () => [...runs.values()],
      getRun: (id) => runs.get(id) ?? null,
      steerRun: (a) => {
        calls.push(`steer:${a.runId}:${a.text}`);
        return { ok: true };
      },
      resumeRun: (a) => {
        calls.push(`resume:${a.runId}`);
        return { ok: true };
      },
    },
    rejectRun: (id) => {
      calls.push(`reject:${id}`);
      return { ok: true };
    },
    policy: () => policy,
    draft: async () => {
      const d = opts.draft ?? drafted();
      return Array.isArray(d) ? { ok: true, kind: 'questions', questions: d } : { ok: true, kind: 'drafted', drafted: d };
    },
    saveHire: (d, o) => {
      const w = worker('ana', { name: d.contract.name, ...o.extra, mcpServers: o.mcpServers, budgetUSDPerMonth: o.budgetUSDPerMonth ?? d.contract.budgetUSDPerMonth });
      roster.set(w.id, w);
      return { ok: true, worker: w };
    },
    hires: { list: () => hires, save: (h) => (hires = structuredClone(h)) },
    onHireAwaitingApproval: (hire, approvers) => awaiting.push({ hire, approvers }),
    onHireDecided: (_h, o) => decided.push(o),
  });
  return { svc, roster, calls, awaiting, decided, hires: () => hires };
}

const paused = (reason: 'needsInput' | 'externalAction', workerId = 'chief'): FlowRun =>
  ({
    id: 'run-1',
    workerId,
    userPrompt: 'Weekly summary',
    flowSnapshot: { name: 'Weekly', steps: [] },
    state: { kind: 'paused', nextStepId: 'write', reason },
    workerExchanges: [{ id: 'x', stepId: 'write', participantId: 'p', askedAt: 5, question: 'Which segment?', status: 'escalated', note: 'no notes' }],
  }) as unknown as FlowRun;

describe('OrgService visibility', () => {
  const roster = [
    worker('chief', { manager: { name: 'Pat', slackUserId: PAT } }),
    worker('analyst', { reportsTo: 'chief' }),
    worker('open', { manager: { name: 'Sam', slackUserId: SAM }, visibility: 'org' }),
    worker('hidden', { manager: { name: 'Sam', slackUserId: SAM } }),
  ];

  it('lists only what the caller may see', () => {
    const { svc } = harness({ roster });
    expect(svc.listWorkers(pat).map((w) => w.id)).toEqual(['analyst', 'chief', 'open']);
    expect(svc.listWorkers(pat).find((w) => w.id === 'analyst')).toMatchObject({ manager: 'Pat', managerInherited: true, youManage: true });
  });

  it('does not resolve a hidden worker by name', () => {
    const { svc } = harness({ roster });
    expect(svc.getWorker(pat, 'Hidden').ok).toBe(false);
  });

  it('lets anyone who can see a worker ask it, and says who asked', async () => {
    const { svc, calls } = harness({ roster });
    const res = await svc.ask(pat, 'Open', 'what changed?');
    expect(res).toMatchObject({ ok: true, reply: 'Done.' });
    expect(calls[0]).toContain('Asked by Pat');
  });
});

describe('OrgService runs', () => {
  const roster = [worker('chief', { manager: { name: 'Pat', slackUserId: PAT } })];

  it('lists what waits on the manager, and not on others', () => {
    const { svc } = harness({ roster, runs: [paused('needsInput')] });
    expect(svc.listWaiting(pat)).toMatchObject([{ runId: 'run-1', kind: 'question', question: 'Which segment?' }]);
    expect(svc.listWaiting(sam)).toEqual([]);
  });

  it('answers as a steer plus a resume, for the manager only', () => {
    const { svc, calls } = harness({ roster, runs: [paused('needsInput')] });
    expect(svc.answer(sam, 'run-1', 'x').ok).toBe(false);
    expect(svc.answer(pat, 'run-1', 'Over 500 seats').ok).toBe(true);
    expect(calls).toEqual(['steer:run-1:Pat answered your question:\nOver 500 seats', 'resume:run-1']);
  });

  it('approves and rejects external actions', () => {
    const { svc, calls } = harness({ roster, runs: [paused('externalAction')] });
    expect(svc.answer(pat, 'run-1', 'x').ok).toBe(false);
    expect(svc.decideRun(pat, 'run-1', false).ok).toBe(true);
    expect(calls).toEqual(['reject:run-1']);
  });
});

describe('OrgService manage', () => {
  it('refuses changes from someone who does not manage the worker', () => {
    const { svc } = harness({ roster: [worker('open', { manager: { name: 'Sam', slackUserId: SAM }, visibility: 'org' })] });
    expect(svc.setPaused(pat, 'open', true)).toMatchObject({ ok: false });
  });

  it('needs an admin to widen visibility to the whole org', () => {
    const { svc } = harness({ roster: [worker('mine', { manager: { name: 'Pat', slackUserId: PAT } })] });
    expect(svc.update(pat, 'mine', { visibility: 'org' })).toMatchObject({ ok: false });
    expect(svc.update(pat, 'mine', { visibility: 'team' })).toMatchObject({ ok: true });
  });

  it('holds a budget raise to the allowance', () => {
    const { svc } = harness({
      roster: [worker('mine', { manager: { name: 'Pat', slackUserId: PAT } })],
      policy: { budgetAllowanceUSD: 50 },
    });
    expect(svc.update(pat, 'mine', { budgetUSDPerMonth: 80 })).toMatchObject({ ok: false });
    expect(svc.update(pat, 'mine', { budgetUSDPerMonth: 40 })).toMatchObject({ ok: true });
  });
});

describe('OrgService hiring', () => {
  it('refuses before spending a model turn when the caller may not hire', async () => {
    const { svc } = harness();
    expect(await svc.draftHire(pat, { jobDescription: 'Watch usage and write a weekly summary for product.' })).toMatchObject({ ok: false });
  });

  it('carries an interview through to a contract', async () => {
    const h = harness({ policy: { hirers: '*', budgetAllowanceUSD: 100 }, draft: ['Which product area?'] });
    const first = await h.svc.draftHire(pat, { jobDescription: 'Watch usage and write a weekly summary for product.' });
    expect(first).toMatchObject({ ok: true, hire: { questions: ['Which product area?'] } });
    if (!first.ok) return;
    expect(h.svc.confirmHire(pat, first.hire.hireId)).toMatchObject({ ok: false });
    expect(h.hires()[0].conversation).toEqual([]);
  });

  it('hires inside the allowance, with the asker as manager and only cleared connectors', async () => {
    const h = harness({
      policy: { hirers: '*', budgetAllowanceUSD: 100, allowedMcpServers: ['productboard'] },
      draft: drafted({ mcpServers: ['productboard'] }),
    });
    const d = await h.svc.draftHire(pat, { jobDescription: 'Watch usage and write a weekly summary for product.' });
    if (!d.ok) throw new Error(d.error);
    const res = h.svc.confirmHire(pat, d.hire.hireId);
    expect(res).toMatchObject({ ok: true, hired: { name: 'Ana', manager: 'Pat' } });
    expect(h.roster.get('ana')!.mcpServers).toEqual(['productboard']);
    expect(h.hires()).toEqual([]);
  });

  it('routes a hire over the allowance to an approver, who cannot be the asker', async () => {
    const h = harness({ policy: { hirers: '*', budgetAllowanceUSD: 10, approvers: [BOSS] } });
    const d = await h.svc.draftHire(pat, { jobDescription: 'Watch usage and write a weekly summary for product.' });
    if (!d.ok) throw new Error(d.error);
    expect(h.svc.confirmHire(pat, d.hire.hireId)).toMatchObject({ ok: true, hire: { status: 'awaitingApproval' } });
    expect(h.awaiting[0].approvers).toEqual([BOSS]);
    expect(h.svc.decideHire(pat, d.hire.hireId, true)).toMatchObject({ ok: false });
    expect(h.svc.decideHire(sam, d.hire.hireId, true)).toMatchObject({ ok: false });
    expect(h.svc.decideHire(boss, d.hire.hireId, true)).toMatchObject({ ok: true, hired: { manager: 'Pat' } });
    expect(h.decided).toEqual([{ approved: true, by: 'Bo', worker: expect.anything() }]);
  });

  it('refuses a stranger\'s hire', async () => {
    const h = harness({ policy: { hirers: '*', budgetAllowanceUSD: 100 } });
    const d = await h.svc.draftHire(pat, { jobDescription: 'Watch usage and write a weekly summary for product.' });
    if (!d.ok) throw new Error(d.error);
    expect(h.svc.confirmHire(sam, d.hire.hireId)).toMatchObject({ ok: false });
  });
});
