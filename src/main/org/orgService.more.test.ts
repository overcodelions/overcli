import { describe, expect, it } from 'vitest';
import type { FlowRun } from '../../shared/flows/schema';
import type { Worker, WorkerJournalEntry } from '../../shared/flows/worker';
import type { Team, TeamTask } from '../../shared/flows/team';
import { serializeWorker } from '../../shared/flows/workerYaml';
import { DEFAULT_ORG_POLICY, type OrgCaller, type OrgPolicy } from '../../shared/org/policy';
import { OrgService, type PendingHire } from './orgService';
import type { AuditEntry, Rating } from './orgStores';

const PAT = 'U0ACMEPAT';
const SAM = 'U0ACMESAM';
const BOSS = 'U0ACMEBOSS';
const pat: OrgCaller = { slackUserId: PAT, name: 'Pat', admin: false };
const sam: OrgCaller = { slackUserId: SAM, name: 'Sam', admin: false };
const admin: OrgCaller = { slackUserId: BOSS, name: 'Bo', admin: true };
const NOW = new Date(2026, 9, 20, 12).getTime();

function worker(id: string, over: Partial<Worker> = {}): Worker {
  return {
    id,
    name: id[0].toUpperCase() + id.slice(1),
    jobDescription: 'Watches competitor sites and reports changes each week.',
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

function harness(opts: {
  roster?: Worker[];
  journal?: Record<string, WorkerJournalEntry[]>;
  runs?: FlowRun[];
  policy?: Partial<OrgPolicy>;
  teams?: { teams: Team[]; tasks: TeamTask[] };
}) {
  const roster = new Map((opts.roster ?? []).map((w) => [w.id, w]));
  const journal = opts.journal ?? {};
  let hires: PendingHire[] = [];
  let ratings: Rating[] = [];
  const audit: AuditEntry[] = [];
  const notes: string[] = [];
  const trusts: string[] = [];
  const teamCalls: string[] = [];
  const imported: string[] = [];
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
      journalFor: (id) => journal[id] ?? [],
      spentThisMonth: () => new Map([...roster.keys()].map((k) => [k, 5])),
      workerNames: () => [...roster.values()].map((w) => w.name),
    },
    runs: {
      listRuns: () => opts.runs ?? [],
      getRun: (id) => (opts.runs ?? []).find((r) => r.id === id) ?? null,
      steerRun: () => ({ ok: true }),
      resumeRun: () => ({ ok: true }),
    },
    rejectRun: () => ({ ok: true }),
    policy: () => policy,
    draft: async () => ({ ok: false, error: 'not in this test' }),
    saveHire: () => ({ ok: false, error: 'not in this test' }),
    hires: { list: () => hires, save: (h) => (hires = structuredClone(h)) },
    snapshots: () => [...roster.values()].map((w) => ({ worker: w, nextShiftAt: NOW + 3_600_000 })),
    setTrust: (id, trust) => {
      trusts.push(`${id}:${trust}`);
      return { ok: true };
    },
    note: (id, _orch, text) => {
      notes.push(`${id}:${text}`);
      return { ok: true };
    },
    teams: {
      list: () => opts.teams ?? { teams: [], tasks: [] },
      brief: (teamId, text, _a, _p, o) => {
        teamCalls.push(`brief:${teamId}:${text}:${o.requestedBy?.slackUserId}`);
        return { ok: true, task: { ...(opts.teams!.tasks[0] ?? {}), id: 't-new', teamId, teamName: 'Pricing', brief: text, status: 'planning', stages: [], stageIndex: 0, spentUSD: 0, budgetUSD: 40, updatedAt: NOW } as TeamTask };
      },
      answer: (id, answers) => {
        teamCalls.push(`answer:${id}:${answers.join('|')}`);
        return { ok: true };
      },
      approve: (id) => {
        teamCalls.push(`approve:${id}`);
        return { ok: true };
      },
      revise: () => ({ ok: true }),
      continueTask: () => ({ ok: true }),
      cancel: () => ({ ok: true }),
    },
    importWorker: (yaml, o) => {
      imported.push(o.extra.manager?.slackUserId ?? '');
      const w = worker('landed', { name: 'Landed', manager: o.extra.manager, mcpServers: o.mcpServers });
      roster.set(w.id, w);
      return { ok: true, worker: w };
    },
    audit: { append: (e) => audit.push(e), recent: (n) => audit.slice(-n).reverse(), all: () => [...audit] },
    ratings: { list: () => ratings, save: (r) => (ratings = r) },
    people: () => [{ name: 'Pat', slackUserId: PAT, admin: false, lastUsedAt: NOW }],
    now: () => NOW,
  });
  return { svc, roster, audit, notes, trusts, teamCalls, imported, ratings: () => ratings };
}

const done = (id: string, n: number, extra: Partial<WorkerJournalEntry> = {}): WorkerJournalEntry[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `${id}-${i}`,
    workerId: id,
    kind: 'completed' as const,
    at: NOW - (n - i) * 3_600_000,
    title: `Report ${i}`,
    orchestrationId: `o-${i}`,
    costUSD: 1,
    ...extra,
  }));

describe('today', () => {
  it('gathers what needs the caller, what came in, and spend', () => {
    const run = {
      id: 'r1',
      workerId: 'luke',
      workerName: 'Luke',
      userPrompt: 'Pricing',
      flowSnapshot: { name: 'Weekly', steps: [] },
      state: { kind: 'paused', nextStepId: 'write', reason: 'needsInput' },
      workerExchanges: [{ id: 'x', stepId: 'write', participantId: 'p', askedAt: NOW - 1000, question: 'Should I call it a price cut or a repackaging?', status: 'escalated' }],
    } as unknown as FlowRun;
    const h = harness({
      roster: [worker('luke', { manager: { name: 'Pat', slackUserId: PAT } })],
      journal: { luke: done('luke', 3) },
      runs: [run],
      policy: { budgetAllowanceUSD: 100 },
    });
    const t = h.svc.today(pat);
    expect(t.waiting).toHaveLength(1);
    expect(t.waiting[0].options).toEqual(['Price cut', 'Repackaging']);
    expect(t.delivered.map((d) => d.title)).toEqual(['Report 2', 'Report 1', 'Report 0']);
    expect(t.crew).toEqual([{ id: 'luke', name: 'Luke', state: 'waiting', nextShiftAt: NOW + 3_600_000, spentUSD: 5, budgetUSDPerMonth: 20 }]);
    expect(t.spend).toMatchObject({ spentUSD: 5, allowanceUSD: 100, committedUSD: 20 });
  });

  it('shows approvers the hires waiting on them, but not their own', () => {
    const h = harness({ policy: { approvers: [BOSS] } });
    // Seed a waiting hire by publishing over an allowance.
    const yaml = serializeWorker({ worker: worker('x', { name: 'Nadia', budgetUSDPerMonth: 500 }), flows: [] });
    const r = harness({ policy: { hirers: '*', budgetAllowanceUSD: 10, approvers: [BOSS] } });
    const pub = r.svc.publishWorker(pat, yaml);
    expect(pub).toMatchObject({ ok: true, hire: { status: 'awaitingApproval' } });
    expect(r.svc.today({ slackUserId: BOSS, name: 'Bo', admin: false }).hireApprovals).toHaveLength(1);
    expect(r.svc.today(pat).hireApprovals).toHaveLength(0);
    expect(h.svc.today(pat).hireApprovals).toHaveLength(0);
  });
});

describe('rating work', () => {
  it('records the rating and teaches the worker through its journal', () => {
    const h = harness({ roster: [worker('luke', { visibility: 'org' })], journal: { luke: done('luke', 1) } });
    expect(h.svc.rate(sam, { entryId: 'luke-0', useful: false, note: 'too long' })).toEqual({ ok: true });
    expect(h.ratings()).toMatchObject([{ entryId: 'luke-0', useful: false, by: 'Sam', note: 'too long' }]);
    expect(h.notes[0]).toContain('Sam found "Report 0" not useful: too long');
    expect(h.svc.work(sam, { mine: false })[0].rating).toEqual({ useful: false, by: 'Sam', note: 'too long' });
  });

  it('refuses work the caller cannot see', () => {
    const h = harness({ roster: [worker('luke')], journal: { luke: done('luke', 1) } });
    expect(h.svc.rate(sam, { entryId: 'luke-0', useful: true }).ok).toBe(false);
  });
});

describe('trust', () => {
  it('reports readiness from the journal and lets the manager promote', () => {
    const h = harness({ roster: [worker('luke', { manager: { name: 'Pat', slackUserId: PAT } })], journal: { luke: done('luke', 10) } });
    const d = h.svc.workerDetail(pat, 'luke');
    expect(d.ok && d.readiness.readyFor).toBe('trusted');
    expect(h.svc.setTrust(pat, 'luke', 'trusted')).toMatchObject({ ok: true });
    expect(h.trusts).toEqual(['luke:trusted']);
    expect(h.audit.at(-1)?.what).toBe('Set Luke to trusted.');
  });

  it('keeps autonomy for admins', () => {
    const h = harness({ roster: [worker('luke', { manager: { name: 'Pat', slackUserId: PAT } })] });
    expect(h.svc.setTrust(pat, 'luke', 'autonomous').ok).toBe(false);
    expect(h.svc.setTrust(admin, 'luke', 'autonomous').ok).toBe(true);
  });
});

describe('publishing a local worker', () => {
  const yaml = serializeWorker({ worker: worker('x', { name: 'Wes', budgetUSDPerMonth: 15, mcpServers: ['acme-feedback', 'warehouse'] }), flows: [] });

  it('lands it with the publisher as manager and only cleared tools', () => {
    const h = harness({ policy: { hirers: '*', budgetAllowanceUSD: 100, allowedMcpServers: ['acme-feedback'], approvers: [BOSS] } });
    // Uncleared tools need an approver; clear both to land it directly.
    const h2 = harness({ policy: { hirers: '*', budgetAllowanceUSD: 100, allowedMcpServers: ['acme-feedback', 'warehouse'] } });
    expect(h.svc.publishWorker(pat, yaml)).toMatchObject({ ok: true, hire: { status: 'awaitingApproval' } });
    const res = h2.svc.publishWorker(pat, yaml);
    expect(res).toMatchObject({ ok: true, hired: { name: 'Landed' } });
    expect(h2.imported).toEqual([PAT]);
    expect(h2.roster.get('landed')!.mcpServers).toEqual(['acme-feedback', 'warehouse']);
  });

  it('refuses a file that is not a worker, and a caller who may not hire', () => {
    const h = harness({ policy: { hirers: '*' } });
    expect(h.svc.publishWorker(pat, 'not: a worker').ok).toBe(false);
    expect(harness({}).svc.publishWorker(pat, yaml).ok).toBe(false);
  });
});

describe('teams', () => {
  const team: Team = {
    id: 'team-1',
    name: 'Pricing',
    members: [{ workerId: 'luke', role: 'Researcher' }],
    budgetUSDPerTask: 40,
    checkpoints: { askFirst: true, reviewBeforeChallenge: false, finalReview: true },
    createdAt: 0,
  };
  const task = {
    id: 't1',
    teamId: 'team-1',
    teamName: 'Pricing',
    brief: 'Review Q4 pricing',
    requestedBy: { name: 'Pat', slackUserId: PAT },
    status: 'questions',
    questions: ['Which regions?'],
    stages: [],
    stageIndex: 0,
    spentUSD: 0,
    budgetUSD: 40,
    createdAt: 0,
    updatedAt: NOW,
    folder: '/tmp',
    files: [],
  } as unknown as TeamTask;

  it('lets the manager of a member brief the team, recording who asked', () => {
    const h = harness({ roster: [worker('luke', { manager: { name: 'Pat', slackUserId: PAT } })], teams: { teams: [team], tasks: [] } });
    expect(h.svc.teams(pat)[0]).toMatchObject({ name: 'Pricing', canBrief: true });
    expect(h.svc.briefTeam(pat, 'pricing', 'Review Q4 pricing')).toMatchObject({ ok: true });
    expect(h.teamCalls).toEqual([`brief:team-1:Review Q4 pricing:${PAT}`]);
  });

  it('hides a team whose members the caller cannot see', () => {
    const h = harness({ roster: [worker('luke')], teams: { teams: [team], tasks: [] } });
    expect(h.svc.teams(sam)).toEqual([]);
    expect(h.svc.briefTeam(sam, 'Pricing', 'x x x x x x').ok).toBe(false);
  });

  it('opens a team to everyone when it is set so, and keeps it to its managers otherwise', () => {
    const open = harness({ roster: [worker('luke', { manager: { name: 'Pat', slackUserId: PAT } })], teams: { teams: [{ ...team, whoCanBrief: 'org' }], tasks: [] } });
    expect(open.svc.teams(sam)[0]).toMatchObject({ name: 'Pricing', canBrief: true });
    expect(open.svc.briefTeam(sam, 'Pricing', 'Review Q4 pricing')).toMatchObject({ ok: true });
    const shut = harness({ roster: [worker('luke', { manager: { name: 'Pat', slackUserId: PAT }, visibility: 'org' })], teams: { teams: [team], tasks: [] } });
    expect(shut.svc.teams(sam)[0]).toMatchObject({ canBrief: false });
    expect(shut.svc.briefTeam(sam, 'Pricing', 'x x x x x x')).toMatchObject({ ok: false, error: expect.stringContaining("can't give Pricing tasks") });
  });

  it('puts the task in front of whoever asked for it, and only they steer it', () => {
    const h = harness({ roster: [worker('luke', { manager: { name: 'Pat', slackUserId: PAT }, visibility: 'org' })], teams: { teams: [team], tasks: [task] } });
    expect(h.svc.today(pat).teamTasks[0]).toMatchObject({ waitingOnYou: true, needs: 'answers', questions: ['Which regions?'] });
    expect(h.svc.teamTasks(sam)[0].waitingOnYou).toBe(false);
    expect(h.svc.decideTeamTask(sam, 't1', { kind: 'answer', answers: ['US'] }).ok).toBe(false);
    expect(h.svc.decideTeamTask(pat, 't1', { kind: 'answer', answers: ['US'] }).ok).toBe(true);
    expect(h.teamCalls).toEqual(['answer:t1:US']);
  });
});

describe('admin views', () => {
  it('lists people with their workers and spend, for admins only', () => {
    const h = harness({ roster: [worker('luke', { manager: { name: 'Pat', slackUserId: PAT } })], policy: { budgetAllowanceUSD: 100 } });
    expect(h.svc.people(pat).ok).toBe(false);
    const res = h.svc.people(admin);
    expect(res.ok && res.people).toEqual([{ name: 'Pat', slackUserId: PAT, allowanceUSD: 100, role: 'Member', workers: 1, spentUSD: 5, lastSeen: NOW, devices: [] }]);
  });

  it('keeps a decision log admins can read', () => {
    const h = harness({ roster: [worker('luke', { manager: { name: 'Pat', slackUserId: PAT } })] });
    h.svc.setPaused(pat, 'luke', true);
    expect(h.svc.auditLog(pat).ok).toBe(false);
    const log = h.svc.auditLog(admin);
    expect(log.ok && log.entries[0]).toMatchObject({ by: 'Pat', what: 'Paused Luke.' });
  });

  it('reports health with rules in plain terms', () => {
    const h = harness({ policy: { hirers: '*', approvers: [PAT], name: 'Acme' } });
    const res = h.svc.health(admin);
    expect(res.ok && res.org.name).toBe('Acme');
    expect(res.ok && res.rules).toMatchObject({ hirers: 'Everyone', approvers: ['Pat'] });
  });
});

describe('offboarding someone', () => {
  it('hands their workers and drops their hires, for an admin only', () => {
    const h = harness({
      roster: [
        worker('luke', { manager: { name: 'Pat', slackUserId: PAT } }),
        worker('max', { manager: { name: 'Sam', slackUserId: SAM } }),
      ],
    });
    expect(h.svc.handOverAll(pat, PAT, { name: 'Sam', slackUserId: SAM }).ok).toBe(false);
    expect(h.svc.handOverAll(admin, PAT, { name: 'Sam', slackUserId: SAM })).toEqual({ ok: true, workers: ['Luke'], hires: 0 });
    expect(h.roster.get('luke')!.manager).toEqual({ name: 'Sam', slackUserId: SAM });
    expect(h.audit.at(-1)!.what).toMatch(/Handed Luke from U0ACMEPAT to Sam/);
  });
});

describe('the decision log', () => {
  it('searches by words and dates, newest first', () => {
    const h = harness({ roster: [worker('luke', { manager: { name: 'Pat', slackUserId: PAT } })] });
    h.audit.push({ at: NOW - 3 * 86_400_000, by: 'Bo', what: 'Approved Luke posting.' }, { at: NOW - 86_400_000, by: 'Pat', what: 'Hired Ana.' }, { at: NOW, by: 'Bo', what: 'Approved Ana.' });
    const words = h.svc.auditLog(admin, { query: 'approved' });
    expect(words.ok && words.entries.map((e) => e.what)).toEqual(['Approved Ana.', 'Approved Luke posting.']);
    const range = h.svc.auditLog(admin, { from: NOW - 2 * 86_400_000, to: NOW });
    expect(range.ok && range.entries.map((e) => e.what)).toEqual(['Hired Ana.']);
    expect(h.svc.auditLog(pat, { query: 'x' }).ok).toBe(false);
  });
});
