import { describe, expect, it } from 'vitest';
import type { FlowRun } from '../../shared/flows/schema';
import type { Worker } from '../../shared/flows/worker';
import type { Team, TeamTask } from '../../shared/flows/team';
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

function harness(opts: { roster?: Worker[]; runs?: FlowRun[]; policy?: Partial<OrgPolicy>; draft?: DraftedHire | string[]; teams?: boolean; overlap?: string; launches?: number; hold?: Promise<void> } = {}) {
  const roster = new Map((opts.roster ?? []).map((w) => [w.id, w]));
  const teams = new Map<string, Team>();
  const teamTasks: TeamTask[] = [];
  const runs = new Map((opts.runs ?? []).map((r) => [r.id, r]));
  let hires: PendingHire[] = [];
  const calls: string[] = [];
  const awaiting: Array<{ hire: PendingHire; approvers: string[] }> = [];
  const decided: Array<{ approved: boolean; by: string }> = [];
  const wanted: Array<{ tools: string[]; admins: string[] }> = [];
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
      runErrand: async (id, text, _attachments, _conversation, untrusted) => {
        calls.push(`errand:${id}:${text}${untrusted ? ':untrusted' : ''}`);
        if (opts.hold) await opts.hold;
        const n = opts.launches ?? 0;
        return { ok: true, result: { orchestrationId: 'o', count: n, queued: n, launchedNothing: !n, reply: 'Done.' } };
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
    stopRun: (id) => {
      calls.push(`stop:${id}`);
      return { ok: true };
    },
    stopBatch: (id) => {
      calls.push(`stopBatch:${id}`);
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
    ...(opts.overlap ? { overlap: async () => ({ workerId: opts.overlap!, why: 'already writes these summaries' }) } : {}),
    onHireAwaitingApproval: (hire, approvers) => awaiting.push({ hire, approvers }),
    onHireDecided: (_h, o) => decided.push(o),
    onToolsWanted: (_h, tools, admins) => wanted.push({ tools: tools.map((t) => t.name), admins }),
    ...(opts.teams
      ? {
          teams: {
            list: () => ({ teams: [...teams.values()], tasks: teamTasks }),
            disband: (id: string, by: string) => {
              teams.set(id, { ...teams.get(id)!, disbanded: { at: 1, by } });
              return { ok: true as const, cancelled: 0 };
            },
            remove: (id: string) => {
              teams.delete(id);
              teamTasks.splice(0, teamTasks.length, ...teamTasks.filter((t) => t.teamId !== id));
              return { ok: true as const };
            },
            brief: () => ({ ok: false, error: 'no' }),
            answer: () => ({ ok: true }),
            approve: () => ({ ok: true }),
            revise: () => ({ ok: true }),
            continueTask: () => ({ ok: true }),
            cancel: () => ({ ok: true }),
            save: (input: Omit<Team, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }) => {
              const team = { ...input, id: input.id ?? `team-${teams.size + 1}`, createdAt: 0 } as Team;
              teams.set(team.id, team);
              return { ok: true as const, team };
            },
          },
        }
      : {}),
  });
  return { svc, roster, calls, awaiting, decided, wanted, teams, teamTasks, hires: () => hires };
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

  it('keeps a question and its answer, for the asker and the manager, whether or not anyone waited', async () => {
    const { svc } = harness({ roster });
    const started = svc.startAsk(pat, 'Open', 'what changed?');
    if (!started.ok) throw new Error(started.error);
    expect(svc.askStatus(pat, started.askId)).toMatchObject({ ok: true, ask: { status: 'working', by: 'Pat', via: 'console' } });
    await started.done;
    expect(svc.askStatus(pat, started.askId)).toMatchObject({ ok: true, ask: { status: 'answered', reply: 'Done.' } });
    expect(svc.askStatus(sam, started.askId).ok).toBe(true);
    expect(svc.workerDetail(pat, 'Open')).toMatchObject({ ok: true, asks: [{ id: started.askId, status: 'answered' }] });
  });
});

describe('asks for a process stage', () => {
  const roster = [worker('chief', { manager: { name: 'Pat', slackUserId: PAT } })];

  it('takes a proposal as one even from the manager', async () => {
    const { svc, calls } = harness({ roster });
    const started = svc.startAsk(pat, 'chief', 'draft the notes', 'console', undefined, undefined, undefined, undefined, true);
    if (!started.ok) throw new Error(started.error);
    await started.done;
    expect(calls[0]).toContain('who is not your manager');
    expect(calls[0]).toMatch(/:untrusted$/);
  });

  it('stops what a called-off ask started, whether it had answered or not', async () => {
    const answered = harness({ roster, launches: 2 });
    const first = answered.svc.startAsk(pat, 'chief', 'draft the notes');
    if (!first.ok) throw new Error(first.error);
    await first.done;
    expect(answered.svc.cancelAsk(first.askId).ok).toBe(true);
    expect(answered.calls).toContain('stopBatch:o');

    let release = () => {};
    const thinking = harness({ roster, launches: 2, hold: new Promise<void>((r) => (release = r)) });
    const second = thinking.svc.startAsk(pat, 'chief', 'draft the notes');
    if (!second.ok) throw new Error(second.error);
    expect(thinking.svc.cancelAsk(second.askId).ok).toBe(true);
    expect(thinking.calls).not.toContain('stopBatch:o');
    release();
    await second.done;
    expect(thinking.calls).toContain('stopBatch:o');
  });
});

describe('questions across a restart', () => {
  it('marks a question that was still working as failed, not working forever', () => {
    let saved = [{ id: 'a1', workerId: 'open', workerName: 'Open', by: 'Pat', slackUserId: PAT, text: 'x', at: 1, status: 'working' as const }];
    const h = harness({ roster: [worker('open', { manager: { name: 'Sam', slackUserId: SAM }, visibility: 'org' })] });
    const svc = new OrgService({ ...(h.svc as unknown as { deps: ConstructorParameters<typeof OrgService>[0] }).deps, asks: { list: () => saved, save: (a) => (saved = a as typeof saved) } });
    expect(svc.askStatus(pat, 'a1')).toMatchObject({ ok: true, ask: { status: 'failed', error: expect.stringMatching(/restarted/) } });
  });
});

describe('a worker’s picture', () => {
  it('is set and cleared by its manager, must be an https link, and shows on its summary', () => {
    const { svc, roster } = harness({ roster: [worker('open', { manager: { name: 'Pat', slackUserId: PAT } })] });
    expect(svc.update(sam, 'open', { avatarUrl: 'https://img.acme.example/a.png' }).ok).toBe(false);
    expect(svc.update(pat, 'open', { avatarUrl: 'http://img.acme.example/a.png' }).ok).toBe(false);
    const set = svc.update(pat, 'open', { avatarUrl: 'https://img.acme.example/a.png' });
    if (!set.ok) throw new Error(set.error);
    expect(set.worker.avatarUrl).toBe('https://img.acme.example/a.png');
    expect(roster.get('open')!.avatarUrl).toBe('https://img.acme.example/a.png');
    expect(svc.update(pat, 'open', { avatarUrl: null }).ok).toBe(true);
    expect(roster.get('open')!.avatarUrl).toBeUndefined();
  });
});

describe('a picture picked for a worker', () => {
  const setup = (pick: string | null, over: Partial<Worker> = {}) => {
    const h = harness({ roster: [worker('open', { manager: { name: 'Pat', slackUserId: PAT }, ...over }), worker('other', { avatarUrl: 'https://img.acme.example/owl.png' })] });
    const asked: Array<{ name: string; taken: string[] }> = [];
    const svc = new OrgService({
      ...(h.svc as unknown as { deps: ConstructorParameters<typeof OrgService>[0] }).deps,
      pickPicture: async (w, taken) => (asked.push({ name: w.name, taken }), pick),
    });
    return { svc, roster: h.roster, asked };
  };

  it('is given to a worker with none, unlike any other worker’s, and never over one someone chose', async () => {
    const a = setup('https://img.acme.example/fox.png');
    expect(await a.svc.choosePicture('open')).toBe('https://img.acme.example/fox.png');
    expect(a.roster.get('open')!.avatarUrl).toBe('https://img.acme.example/fox.png');
    expect(a.asked[0].taken).toEqual(['https://img.acme.example/owl.png']);
    const b = setup('https://img.acme.example/fox.png', { avatarUrl: 'https://img.acme.example/mine.png' });
    expect(await b.svc.choosePicture('open')).toBeNull();
    expect(b.roster.get('open')!.avatarUrl).toBe('https://img.acme.example/mine.png');
  });

  it('is picked again on request by its manager, and says so when nothing suited', async () => {
    const a = setup('https://img.acme.example/fox.png', { avatarUrl: 'https://img.acme.example/mine.png' });
    expect(await a.svc.pickWorkerPicture(sam, 'open')).toMatchObject({ ok: false });
    expect(await a.svc.pickWorkerPicture(pat, 'open')).toEqual({ ok: true, avatarUrl: 'https://img.acme.example/fox.png' });
    expect(await setup(null).svc.pickWorkerPicture(pat, 'open')).toMatchObject({ ok: false, error: expect.stringMatching(/Nothing suited/) });
  });
});

describe('a team’s picture', () => {
  it('is set by whoever may change the team, and Slack posts the team and its workers under their pictures, initials otherwise', async () => {
    const ours = (id: string, over: Partial<Worker> = {}) => worker(id, { manager: { name: 'Pat', slackUserId: PAT }, ...over });
    const h = harness({ roster: [ours('vantage'), ours('lena', { avatarUrl: 'https://img.acme.example/lena.png' })], policy: { hirers: '*', budgetAllowanceUSD: 100 }, teams: true });
    const made = await h.svc.makeTeamWithHires(pat, { name: 'Council', budgetUSDPerTask: 50, members: [{ workerId: 'vantage', role: 'Drafts' }, { workerId: 'lena', role: 'Customers' }], hires: [] });
    if (!made.ok) throw new Error(made.error);
    const id = [...h.teams.values()][0].id;
    expect(h.svc.pictureOf(id)).toMatch(/\/initials\/png\?seed=C&/);
    expect(h.svc.updateTeamSettings(pat, id, { avatarUrl: 'http://img.acme.example/t.png' }).ok).toBe(false);
    expect(h.svc.updateTeamSettings(pat, id, { avatarUrl: 'https://img.acme.example/t.png' }).ok).toBe(true);
    expect(h.svc.pictureOf(id)).toBe('https://img.acme.example/t.png');
    expect(h.svc.teams(pat)[0].avatarUrl).toBe('https://img.acme.example/t.png');
    expect(h.svc.pictureOf('lena')).toBe('https://img.acme.example/lena.png');
    expect(h.svc.pictureOf('vantage')).toMatch(/\/initials\/png\?seed=V&/);
    expect(h.svc.updateTeamSettings(pat, id, { avatarUrl: null }).ok).toBe(true);
    expect(h.teams.get(id)!.avatarUrl).toBeUndefined();
  });
});

describe('a worker’s journal', () => {
  it('shows its notes apart from what it did, and lets its manager add and remove them', () => {
    const journal: Array<{ id: string; workerId: string; kind: string; at: number; title: string; note?: string }> = [
      { id: 'e1', workerId: 'open', kind: 'shift', at: 1, title: '', note: 'Looked, found nothing.' },
      { id: 'n1', workerId: 'open', kind: 'note', at: 2, title: '', note: 'Each weekly check also covers Introw.' },
    ];
    const h = harness({ roster: [worker('open', { manager: { name: 'Pat', slackUserId: PAT }, visibility: 'org' })] });
    const deps = (h.svc as unknown as { deps: ConstructorParameters<typeof OrgService>[0] }).deps;
    const svc = new OrgService({
      ...deps,
      workers: {
        ...deps.workers,
        journalFor: () => journal as never,
        remember: (id, text) => (journal.push({ id: `n${journal.length + 1}`, workerId: id, kind: 'note', at: 9, title: '', note: text }), { ok: true }),
        forgetNote: (_id, entryId) => (journal.splice(journal.findIndex((e) => e.id === entryId), 1), { ok: true }),
      },
    });
    const page = svc.workerJournal(sam, 'open');
    if (!page.ok) throw new Error(page.error);
    expect(page.notes.map((n) => n.note)).toEqual(['Each weekly check also covers Introw.']);
    expect(page.entries.map((e) => e.kind)).toEqual(['shift']);
    expect(page.canChange).toBe(false);
    expect(svc.addWorkerNote(sam, 'open', 'stop').ok).toBe(false);
    expect(svc.addWorkerNote(pat, 'open', 'Skip the pricing page.').ok).toBe(true);
    expect(journal.at(-1)!.note).toBe('From Pat: Skip the pricing page.');
    expect(svc.forgetWorkerNote(pat, 'open', 'n1').ok).toBe(true);
    expect(journal.some((e) => e.id === 'n1')).toBe(false);
  });
});

describe('handed-off work', () => {
  const batch = { id: 'o1', items: [{ candidate: { title: 'Ticket tally' }, status: 'done', runId: 'r1' }] };
  const setup = (ask: Record<string, unknown>) => {
    let saved = [{ id: 'a1', workerId: 'open', workerName: 'Open', by: 'Pat', slackUserId: PAT, text: 'graph my tickets', status: 'answered' as const, orchestrationId: 'o1', via: 'slack' as const, conversation: 'slack:D1:1.0', ...ask }];
    const h = harness({ roster: [worker('open', { manager: { name: 'Pat', slackUserId: PAT } })] });
    const svc = new OrgService({
      ...(h.svc as unknown as { deps: ConstructorParameters<typeof OrgService>[0] }).deps,
      asks: { list: () => saved as never, save: (a) => (saved = a as typeof saved) },
      orchestration: () => batch as never,
      runDeliverables: () => [{ name: 'result.json', body: '{"total":429,"monthly":{"2026-09":125}}' }],
    });
    return { svc, calls: h.calls, saved: () => saved };
  };

  it('knows the Slack thread the work was asked for in, by its batch or a run it started', () => {
    const { svc } = setup({ at: Date.now(), conversation: 'slack:D0REQ:1792.5' });
    expect(svc.slackThreadFor({ orchestrationId: 'o1' })).toEqual({ channel: 'D0REQ', threadTs: '1792.5', slackUserId: PAT });
    expect(svc.slackThreadFor({ runId: 'r1' })).toEqual({ channel: 'D0REQ', threadTs: '1792.5', slackUserId: PAT });
    expect(svc.slackThreadFor({ runId: 'r9' })).toBeNull();
  });

  it('goes back to the worker, in the same conversation, to finish up for a business reader', async () => {
    const { svc, calls, saved } = setup({ at: Date.now() });
    const back = svc.handBack('a1');
    if (!back) throw new Error('nothing handed back');
    await back.done;
    expect(calls[0]).toContain('The work you handed off for Pat\'s request has finished: Ticket tally.');
    expect(calls[0]).toContain('--- result.json\n{"total":429');
    expect(calls[0]).toMatch(/No raw JSON/);
    const reply = saved().find((a) => a.id !== 'a1')!;
    expect(reply).toMatchObject({ replyTo: 'ask:a1', via: 'slack', conversation: 'slack:D1:1.0', status: 'answered', handedBack: true });
    expect(saved().find((a) => a.id === 'a1')).toMatchObject({ handedBack: true });
    expect(svc.handBack('a1')).toBeNull();
  });

  it('hands back console asks made since the server started, and leaves older ones alone', () => {
    expect(setup({ via: 'console', at: 1 }).svc.handBackDue()).toBe(0);
    expect(setup({ via: 'console', at: Date.now() + 1000 }).svc.handBackDue()).toBe(1);
    expect(setup({ via: 'slack', at: Date.now() + 1000 }).svc.handBackDue()).toBe(0);
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

  it('does not let a manager drop or hand off a worker to dodge the allowance', () => {
    const { svc, roster } = harness({
      roster: [
        worker('boss', { manager: { name: 'Pat', slackUserId: PAT }, budgetUSDPerMonth: 10 }),
        worker('mine', { manager: { name: 'Pat', slackUserId: PAT }, reportsTo: 'boss', budgetUSDPerMonth: 10 }),
      ],
      policy: { budgetAllowanceUSD: 50 },
    });
    expect(svc.update(pat, 'mine', { manager: null, budgetUSDPerMonth: 5000 })).toMatchObject({ ok: false });
    expect(svc.update(pat, 'mine', { manager: { name: 'Sam', slackUserId: SAM } })).toMatchObject({ ok: false });
    expect(roster.get('mine')!.budgetUSDPerMonth).toBe(10);
  });

  it('holds a raise on a worker managed through its boss to the boss\'s manager', () => {
    const { svc } = harness({
      roster: [
        worker('boss', { manager: { name: 'Pat', slackUserId: PAT }, budgetUSDPerMonth: 30 }),
        worker('under', { reportsTo: 'boss', budgetUSDPerMonth: 10 }),
      ],
      policy: { budgetAllowanceUSD: 50 },
    });
    expect(svc.update(pat, 'under', { budgetUSDPerMonth: 30 })).toMatchObject({ ok: false });
    expect(svc.update(pat, 'under', { budgetUSDPerMonth: 20 })).toMatchObject({ ok: true });
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
      policy: { hirers: '*', budgetAllowanceUSD: 100, allowedMcpServers: ['acme-feedback'] },
      draft: drafted({ mcpServers: ['acme-feedback'] }),
    });
    const d = await h.svc.draftHire(pat, { jobDescription: 'Watch usage and write a weekly summary for product.' });
    if (!d.ok) throw new Error(d.error);
    const res = h.svc.confirmHire(pat, d.hire.hireId);
    expect(res).toMatchObject({ ok: true, hired: { name: 'Ana', manager: 'Pat' } });
    expect(h.roster.get('ana')!.mcpServers).toEqual(['acme-feedback']);
    expect(h.hires()).toEqual([]);
  });

  it('asks the admins, once, for the tools a hire wants that the server lacks', async () => {
    const h = harness({
      policy: { hirers: '*', budgetAllowanceUSD: 100, admins: [BOSS] },
      draft: drafted({ wantedTools: [{ name: 'Acme Tracker', why: 'reads the sprint board' }] }),
    });
    const d = await h.svc.draftHire(pat, { jobDescription: 'Watch the sprint board and summarize it weekly.' });
    if (!d.ok) throw new Error(d.error);
    expect(d.hire.contract?.wantedTools).toEqual([{ name: 'Acme Tracker', why: 'reads the sprint board', inCatalog: false }]);
    const res = h.svc.askForTools(pat, d.hire.hireId);
    expect(res).toMatchObject({ ok: true, asked: [BOSS], hire: { contract: { toolsAsked: true } } });
    expect(h.wanted).toEqual([{ tools: ['Acme Tracker'], admins: [BOSS] }]);
    expect(h.svc.askForTools(pat, d.hire.hireId)).toMatchObject({ ok: false });
    expect(h.svc.askForTools(sam, d.hire.hireId)).toMatchObject({ ok: false });
    expect(h.wanted).toHaveLength(1);
  });

  it('has no one to ask for tools when the org has no admin', async () => {
    const h = harness({ policy: { hirers: '*', budgetAllowanceUSD: 100 }, draft: drafted({ wantedTools: [{ name: 'Acme Tracker' }] }) });
    const d = await h.svc.draftHire(pat, { jobDescription: 'Watch the sprint board and summarize it weekly.' });
    if (!d.ok) throw new Error(d.error);
    expect(h.svc.askForTools(pat, d.hire.hireId)).toMatchObject({ ok: false, error: expect.stringContaining('no one') });
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

describe('making a team with a new hire', () => {
  const mine = (id: string) => worker(id, { manager: { name: 'Pat', slackUserId: PAT } });
  const pat: OrgCaller = { slackUserId: PAT, name: 'Pat', admin: false };
  const hire = { job: 'Reviews the current UX and writes recommendations for each screen.', role: 'UX reviewer' };

  it('hires the suggested member and puts it on the team', async () => {
    const h = harness({ roster: [mine('vantage')], policy: { hirers: '*', budgetAllowanceUSD: 100 }, teams: true });
    const res = await h.svc.makeTeamWithHires(pat, { name: 'Product', budgetUSDPerTask: 50, members: [{ workerId: 'vantage', role: 'Drafts' }], hires: [hire] });
    if (!res.ok) throw new Error(res.error);
    expect(res.hired).toEqual([{ name: expect.any(String), role: 'UX reviewer' }]);
    expect([...h.teams.values()][0].members.map((m) => m.role)).toEqual(['Drafts', 'UX reviewer']);
  });

  it('makes the team now and adds a hire that waited on an approver once it’s approved', async () => {
    const h = harness({ roster: [mine('vantage'), mine('lena')], policy: { hirers: '*', budgetAllowanceUSD: 10, approvers: [BOSS] }, teams: true });
    const res = await h.svc.makeTeamWithHires(pat, { name: 'Product', budgetUSDPerTask: 50, members: [{ workerId: 'vantage', role: 'Drafts' }, { workerId: 'lena', role: 'Customers' }], hires: [hire] });
    if (!res.ok) throw new Error(res.error);
    expect(res.waiting).toHaveLength(1);
    const team = [...h.teams.values()][0];
    expect(team.members).toHaveLength(2);
    const waiting = h.hires().find((x) => x.status === 'awaitingApproval')!;
    expect(waiting.joinTeam).toEqual({ teamId: team.id, role: 'UX reviewer' });
    expect(h.svc.decideHire({ slackUserId: BOSS, name: 'Bo', admin: false }, waiting.id, true).ok).toBe(true);
    expect(h.teams.get(team.id)!.members.map((m) => m.role)).toEqual(['Drafts', 'Customers', 'UX reviewer']);
  });

  it('keeps how the team should work, set by whoever manages a member', async () => {
    const h = harness({ roster: [mine('vantage'), mine('lena')], policy: { hirers: '*', budgetAllowanceUSD: 100 }, teams: true });
    const made = await h.svc.makeTeamWithHires(pat, { name: 'Product', budgetUSDPerTask: 50, members: [{ workerId: 'vantage', role: 'Drafts' }, { workerId: 'lena', role: 'Customers' }], hires: [] });
    if (!made.ok) throw new Error(made.error);
    const id = [...h.teams.values()][0].id;
    expect(h.svc.updateTeamSettings(sam, id, { guidance: 'Lena first.' })).toMatchObject({ ok: false });
    expect(h.svc.updateTeamSettings(pat, id, { guidance: 'x'.repeat(20_001) })).toMatchObject({ ok: false, error: expect.stringMatching(/20,000/) });
    expect(h.svc.updateTeamSettings(pat, id, { guidance: 'When the ask is a PRFAQ: Lena pulls customer asks, then Vantage drafts.' }).ok).toBe(true);
    expect(h.teams.get(id)!.guidance).toBe('When the ask is a PRFAQ: Lena pulls customer asks, then Vantage drafts.');
    const page = h.svc.teamPage(pat, id);
    if (!page.ok) throw new Error(page.error);
    expect(page.team.guidance).toMatch(/^When the ask is a PRFAQ/);
  });

  it('disbands a team: gone from every list, its finished work still in the Library; deleting it is an admin’s call', async () => {
    const h = harness({ roster: [mine('vantage'), mine('lena')], policy: { hirers: '*', budgetAllowanceUSD: 100 }, teams: true });
    const made = await h.svc.makeTeamWithHires(pat, { name: 'Council', budgetUSDPerTask: 50, members: [{ workerId: 'vantage', role: 'Drafts' }, { workerId: 'lena', role: 'Customers' }], hires: [] });
    if (!made.ok) throw new Error(made.error);
    const id = [...h.teams.values()][0].id;
    h.teamTasks.push({ id: 'task-1', teamId: id, teamName: 'Council', brief: 'Review the roadmap', title: 'Roadmap review', status: 'done', stages: [], stageIndex: 0, files: [], createdAt: 1, updatedAt: 2, spentUSD: 3, budgetUSD: 50, pack: { summary: 'The likely plan.', files: [] } } as unknown as TeamTask);
    expect(h.svc.disbandTeam(sam, id)).toMatchObject({ ok: false });
    expect(h.svc.disbandTeam(pat, id).ok).toBe(true);
    expect(h.svc.teams(pat)).toEqual([]);
    expect(h.svc.briefTeam(pat, 'Council', 'more work')).toMatchObject({ ok: false });
    expect(h.svc.library(pat).some((x) => x.kind === 'task' && x.title === 'Roadmap review')).toBe(true);
    expect(h.svc.deleteTeam(pat, id)).toMatchObject({ ok: false, error: expect.stringMatching(/admin/) });
    expect(h.svc.deleteTeam({ name: 'Ad', admin: true }, id).ok).toBe(true);
    expect(h.teams.size).toBe(0);
    expect(h.svc.library(pat).some((x) => x.kind === 'task')).toBe(false);
  });

  it('won’t make a one-member team while the hire waits', async () => {
    const h = harness({ roster: [mine('vantage')], policy: { hirers: '*', budgetAllowanceUSD: 10, approvers: [BOSS] }, teams: true });
    const res = await h.svc.makeTeamWithHires(pat, { name: 'Product', budgetUSDPerTask: 50, members: [{ workerId: 'vantage', role: 'Drafts' }], hires: [hire] });
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('waiting on an approver') });
    expect(h.teams.size).toBe(0);
  });
});

describe('a team being made, followed as it goes', () => {
  const mine = (id: string) => worker(id, { manager: { name: 'Pat', slackUserId: PAT } });
  const pat: OrgCaller = { slackUserId: PAT, name: 'Pat', admin: false };
  const hire = { key: 'h1', job: 'Reviews the current UX and writes recommendations for each screen.', role: 'UX reviewer' };
  const settled = () => new Promise((r) => setTimeout(r, 0));

  it('shows each hire’s state, waits on a failed one, and makes the team once it’s skipped', async () => {
    // A drafter that only asks questions: the hire can't be confirmed.
    const h = harness({ roster: [mine('vantage'), mine('lena')], policy: { hirers: '*', budgetAllowanceUSD: 100 }, draft: ['Which product?'], teams: true });
    const started = h.svc.startTeamRun(pat, { name: 'Product', budgetUSDPerTask: 50, members: [{ workerId: 'vantage', role: 'Drafts' }, { workerId: 'lena', role: 'Customers' }], hires: [hire] });
    if (!started.ok) throw new Error(started.error);
    expect(started.run).toMatchObject({ status: 'hiring', hires: [{ key: 'h1', state: 'drafting' }] });
    await settled();
    const stuck = h.svc.teamRun(pat, started.run.id);
    expect(stuck).toMatchObject({ ok: true, run: { status: 'needsYou', hires: [{ state: 'failed' }] } });
    // Someone else can't see or steer it.
    expect(h.svc.teamRun({ slackUserId: SAM, name: 'Sam', admin: false }, started.run.id).ok).toBe(false);
    const skipped = h.svc.skipTeamRunHire(pat, started.run.id, 'h1');
    expect(skipped).toMatchObject({ ok: true, run: { status: 'done', team: { name: 'Product' } } });
    expect(h.teams.size).toBe(1);
    expect(h.svc.teamRunsFor(pat)).toEqual([]);
  });

  it('makes a team with no hires before it answers', () => {
    const h = harness({ roster: [mine('vantage'), mine('lena')], teams: true });
    const started = h.svc.startTeamRun(pat, { name: 'Pair', budgetUSDPerTask: 50, members: [{ workerId: 'vantage', role: 'Drafts' }, { workerId: 'lena', role: 'Customers' }] });
    expect(started).toMatchObject({ ok: true, run: { status: 'done', team: { name: 'Pair' } } });
  });
});

describe('changing an offer before it’s accepted', () => {
  const pat: OrgCaller = { slackUserId: PAT, name: 'Pat', admin: false };

  it('renames it, sets its budget and who can ask it, and confirming weighs the change', async () => {
    const h = harness({ roster: [worker('chief', { name: 'Chief', manager: { name: 'Pat', slackUserId: PAT } })], policy: { hirers: '*', budgetAllowanceUSD: 100, approvers: [BOSS] } });
    const drafted = await h.svc.draftHire(pat, { jobDescription: 'Watches usage data and writes a weekly product summary.' });
    if (!drafted.ok) throw new Error(drafted.error);
    const edited = h.svc.editHire(pat, drafted.hire.hireId, { name: 'Iris', budgetUSDPerMonth: 150, visibility: 'org', reportsTo: 'Chief' });
    expect(edited).toMatchObject({ ok: true, hire: { contract: { name: 'Iris', budgetUSDPerMonth: 150, visibility: 'org', reportsTo: 'Chief' } } });
    expect(h.svc.editHire(pat, drafted.hire.hireId, { name: 'Chief' })).toMatchObject({ ok: false, error: expect.stringContaining('already a worker') });
    expect(h.svc.editHire({ slackUserId: SAM, name: 'Sam', admin: false }, drafted.hire.hireId, { name: 'Mine' }).ok).toBe(false);
    // $150 is over Pat's $100 allowance: it goes to an approver now.
    const confirmed = h.svc.confirmHire(pat, drafted.hire.hireId);
    expect(confirmed).toMatchObject({ ok: true, hire: { status: 'awaitingApproval' } });
  });
});

describe('a hire someone already does', () => {
  it('says which worker the person can see already does the job', async () => {
    const pat: OrgCaller = { slackUserId: PAT, name: 'Pat', admin: false };
    const h = harness({ roster: [worker('hugo', { name: 'Hugo', tagline: 'Writes reports', manager: { name: 'Pat', slackUserId: PAT } })], policy: { hirers: '*' }, overlap: 'hugo' });
    const res = await h.svc.draftHire(pat, { jobDescription: 'I need a report builder for the weekly numbers.' });
    expect(res).toMatchObject({ ok: true, hire: { alreadyDoes: { workerId: 'hugo', name: 'Hugo', why: 'already writes these summaries' } } });
  });
});

describe('stopping a worker’s run', () => {
  it('lets its manager stop it, and nobody else', () => {
    const running = { ...paused('externalAction'), state: { kind: 'running', currentStepId: 'write' } } as unknown as FlowRun;
    const h = harness({ roster: [worker('chief', { manager: { name: 'Pat', slackUserId: PAT } })], runs: [running] });
    expect(h.svc.stopRun({ slackUserId: SAM, name: 'Sam', admin: false }, 'run-1')).toMatchObject({ ok: false });
    expect(h.svc.stopRun({ slackUserId: PAT, name: 'Pat', admin: false }, 'run-1')).toEqual({ ok: true });
    expect(h.calls).toContain('stop:run-1');
  });
});
