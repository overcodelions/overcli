import { describe, expect, it, vi } from 'vitest';

vi.mock('../diagnostics', () => ({ log: vi.fn() }));

import { TeamEngine, type TeamStoreDeps } from './teamEngine';
import type { MainToRendererEvent } from '../../shared/types';
import type { Orchestration, OrchestrationItemStatus } from '../../shared/flows/orchestration';
import type { Worker } from '../../shared/flows/worker';
import type { Team, TeamHireRequest, TeamTask } from '../../shared/flows/team';

const worker = (id: string, name: string, enabled = true): Worker =>
  ({
    id,
    name,
    enabled,
    jobDescription: `${name}'s job`,
    projectPath: '/ws/acme',
    heartbeatBackend: id === 'rook' ? 'codex' : 'claude',
  }) as Worker;

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

function makeHarness(opts: {
  turns?: string[];
  seedTeams?: Team[];
  seedTasks?: TeamTask[];
  spend?: number;
  commissionEmitsFirst?: boolean;
  memberReplies?: string[];
  /// Make team hiring available; each call answers one hire request.
  hire?: (req: TeamHireRequest) => { ok: true; worker: Worker } | { ok: false; error: string };
  /// Fake git for the task branch: scripted absorb results, in order.
  code?: { absorbs: Array<'ok' | 'conflict'> };
} = {}) {
  const codeCalls: string[] = [];
  const absorbs = [...(opts.code?.absorbs ?? [])];
  const crew = [worker('maya', 'Maya'), worker('ade', 'Ade'), worker('rook', 'Rook')];
  const hireRequests: TeamHireRequest[] = [];
  const emitted: MainToRendererEvent[] = [];
  const files = new Map<string, string>();
  const teams = new Map<string, Team>((opts.seedTeams ?? []).map((t) => [t.id, t]));
  const tasks = new Map<string, TeamTask>((opts.seedTasks ?? []).map((t) => [t.id, t]));
  const batches = new Map<string, Orchestration>();
  const commissions: Array<{
    workerId: string;
    prompt: string;
    stage: number;
    id: string;
    projectPath?: string;
    allowExternalActions?: boolean;
    baseBranch?: string;
  }> = [];
  const turns = [...(opts.turns ?? [])];
  const turnMessages: string[] = [];
  const turnAttachments: string[][] = [];
  const memberPrompts: Array<{ name: string; prompt: string; attachments: string[] }> = [];
  const memberReplies = [...(opts.memberReplies ?? [])];
  const deliverables = new Map<string, Array<{ name: string; body?: string }>>();
  const cancelledBatches: string[] = [];
  let ids = 0;
  let spend = opts.spend ?? 0;

  const store: TeamStoreDeps = {
    loadTeams: () => [...teams.values()],
    saveTeam: (t) => void teams.set(t.id, structuredClone(t)),
    deleteTeam: (id) => void teams.delete(id),
    loadTasks: () => [...tasks.values()].map((t) => structuredClone(t)),
    saveTask: (t) => void tasks.set(t.id, structuredClone(t)),
    deleteTask: (id) => void tasks.delete(id),
    taskDir: (id) => `/data/team-files/${id}`,
    writeFile: (taskId, name, body) => void files.set(`${taskId}/${name}`, body),
    readFile: (taskId, name) => files.get(`${taskId}/${name}`) ?? null,
    removeTaskDir: () => {},
    copyIn: (taskId, name, sourcePath) => void files.set(`${taskId}/${name}`, `copied from ${sourcePath}`),
    writeBytes: (taskId, name, bytes) => void files.set(`${taskId}/${name}`, bytes.toString('utf8')),
    readBytes: (taskId, name) => {
      const body = files.get(`${taskId}/${name}`);
      return body === undefined ? null : Buffer.from(body, 'utf8');
    },
    pathOf: (taskId, name) => `/data/team-files/${taskId}/${name}`,
  };

  let engine: TeamEngine;
  const batchFor = (
    workerId: string,
    team: { teamId: string; teamName: string; taskId: string; stage: number },
    id: string,
    status: OrchestrationItemStatus,
    runId?: string,
  ): Orchestration =>
    ({
      id,
      title: 'x',
      projectPath: '/p',
      runIn: 'cwd',
      maxConcurrent: 1,
      producer: { prompt: '', reply: '' },
      createdAt: 0,
      origin: { kind: 'worker', workerId, workerName: workerId, task: 'errand', team },
      items: [{ candidate: { id: 'c', title: 't', prompt: '' }, flowId: 'f', status, runId }],
    }) as Orchestration;

  engine = new TeamEngine({
    emit: (e) => emitted.push(e),
    notify: () => {},
    workers: () => crew,
    ...(opts.code
      ? {
          code: {
            open: ({ title, projectPath }: { title: string; projectPath: string }) => {
              codeCalls.push(`open ${title} ${projectPath}`);
              return {
                ok: true as const,
                code: { branch: 'team/x', repos: [{ name: 'overcli', projectPath, base: 'main', worktreePath: '/wt' }] },
              };
            },
            pieceRepos: (runId: string) => [{ projectPath: '/code/overcli', worktreePath: `/runs/${runId}`, branchName: `agent/${runId}` }],
            absorb: ({ message }: { message: string }) => {
              codeCalls.push(`absorb ${message}`);
              return absorbs.shift() === 'conflict'
                ? { ok: false as const, error: 'overcli: conflict in README.md' }
                : { ok: true as const, merged: ['overcli'] };
            },
            land: () => {
              codeCalls.push('land');
              return { ok: true as const, message: 'Merged' };
            },
            close: () => void codeCalls.push('close'),
          },
        }
      : {}),
    projects: () => [
      { name: 'Acme', path: '/ws/acme' },
      { name: 'overcli', path: '/code/overcli' },
      { name: 'overgit', path: '/code/overgit' },
    ],
    ...(opts.hire
      ? {
          hire: async (req: TeamHireRequest) => {
            hireRequests.push(req);
            const res = opts.hire!(req);
            if (res.ok) crew.push(res.worker);
            return res;
          },
        }
      : {}),
    commission: async (workerId, args) => {
      const id = `batch-${++ids}`;
      commissions.push({
        workerId,
        prompt: args.prompt,
        stage: args.team.stage,
        id,
        projectPath: args.projectPath,
        allowExternalActions: args.allowExternalActions,
        baseBranch: args.baseBranch,
      });
      const b = batchFor(workerId, args.team, id, 'running', `run-${id}`);
      batches.set(id, b);
      // The orchestrator emits the batch while parkDirect is still in flight.
      if (opts.commissionEmitsFirst) engine.observeEvent({ type: 'orchestrationUpdate', orchestration: b });
      return { ok: true, orchestrationId: id };
    },
    batch: (id) => batches.get(id) ?? null,
    cancelBatch: (id) => void cancelledBatches.push(id),
    memberTurn: async ({ worker, prompt, attachments }) => {
      memberPrompts.push({ name: worker.name, prompt, attachments: (attachments ?? []).map((a) => a.label ?? a.id) });
      const next = memberReplies.shift();
      return next === undefined ? { ok: false, error: 'no scripted reply' } : { ok: true, text: next };
    },
    coordinatorTurn: async ({ message, attachments }) => {
      turnMessages.push(message);
      turnAttachments.push((attachments ?? []).map((a) => a.label ?? a.id));
      const next = turns.shift();
      return next === undefined ? { ok: false, error: 'no scripted turn' } : { ok: true, text: next };
    },
    deliverablesFor: (runId) => deliverables.get(runId) ?? [],
    spendForRuns: () => spend,
    now: () => 1_000,
    newId: () => `id-${++ids}`,
    store,
  });

  /// Finish (or fail) one commissioned piece, as the orchestrator would.
  const settle = (
    batchId: string,
    status: OrchestrationItemStatus,
    answer = `answer from ${batchId}`,
    written: Array<{ name: string; sourcePath: string }> = [],
  ) => {
    const b = batches.get(batchId)!;
    const runId = `run-${batchId}`;
    deliverables.set(runId, [{ name: 'notes', body: 'supporting' }, { name: 'answer', body: answer }, ...written]);
    const next = { ...b, items: [{ ...b.items[0], status, runId, note: status === 'failed' ? 'boom' : undefined }] };
    batches.set(batchId, next);
    engine.observeEvent({ type: 'orchestrationUpdate', orchestration: next });
  };

  return {
    engine,
    emitted,
    files,
    tasks,
    commissions,
    cancelledBatches,
    turnMessages,
    turnAttachments,
    memberPrompts,
    settle,
    hireRequests,
    codeCalls,
    setSpend: (n: number) => (spend = n),
    pushTurn: (t: string) => turns.push(t),
  };
}

const team = (overrides: Partial<Team> = {}): Team => ({
  id: 'team-1',
  name: 'Discovery',
  members: [
    { workerId: 'maya', role: 'Market analyst' },
    { workerId: 'ade', role: 'Architect' },
    { workerId: 'rook', role: 'Challenger' },
  ],
  budgetUSDPerTask: 12,
  checkpoints: { askFirst: true, reviewBeforeChallenge: false, finalReview: true },
  createdAt: 0,
  ...overrides,
});

const PLAN = `<team_plan>${JSON.stringify({
  title: 'Teams proposal',
  deliverables: ['PROPOSAL.md'],
  stages: [
    {
      kind: 'contribute',
      title: 'Market and shape',
      assignments: [
        { member: 'Maya', ask: 'Market' },
        { member: 'Ade', ask: 'Feasibility' },
      ],
    },
    { kind: 'challenge', title: 'Attack', assignments: [{ member: 'Rook', ask: 'Object' }] },
    { kind: 'synthesize', title: 'Pack', ask: 'Write the pack' },
  ],
})}</team_plan>`;

const PACK = '<summary>Build it.</summary><file name="PROPOSAL.md"># Proposal</file><file name="challenge-log.md">| # |</file>';

function task(h: ReturnType<typeof makeHarness>): TeamTask {
  return h.engine.list().tasks[0];
}

describe('TeamEngine', () => {
  it('runs a task from brief to reviewed pack', async () => {
    const h = makeHarness({
      seedTeams: [team()],
      turns: ['<team_questions>["Who is it for?"]</team_questions>', PLAN, PACK],
    });
    h.engine.start();

    const res = h.engine.brief('team-1', 'A proposal for teams');
    expect(res.ok).toBe(true);
    await flush();
    expect(task(h).status).toBe('questions');
    expect(task(h).questions).toEqual(['Who is it for?']);

    expect(h.engine.answer(task(h).id, ['Solo builders']).ok).toBe(true);
    await flush();
    expect(h.turnMessages[1]).toContain('A: Solo builders');
    expect(task(h).status).toBe('proposed');
    expect(task(h).stages).toHaveLength(3);

    expect(h.engine.approve(task(h).id).ok).toBe(true);
    await flush();
    // Both members of the first stage are commissioned at once.
    expect(h.commissions.map((c) => [c.workerId, c.stage])).toEqual([
      ['maya', 0],
      ['ade', 0],
    ]);
    expect(h.commissions[0].prompt).toContain('Market');
    expect(h.commissions[0].prompt).toContain('brief.md');

    h.settle(h.commissions[0].id, 'done', 'Maya says hi');
    expect(task(h).stageIndex).toBe(0);
    h.settle(h.commissions[1].id, 'done');
    await flush();

    // Stage 2 reads stage 1's pieces from the shared folder.
    expect(h.commissions[2]).toMatchObject({ workerId: 'rook', stage: 1 });
    expect(h.commissions[2].prompt).toContain('Maya says hi');
    expect(h.commissions[2].prompt).toContain('ATTACK');
    const piece = [...h.files.entries()].find(([k]) => k.endsWith('01-market-and-shape-maya.md'));
    expect(piece?.[1]).toContain('Maya says hi');
    expect(piece?.[1]).toContain('Supporting material');

    h.settle(h.commissions[2].id, 'done', '1. High: too costly');
    await flush();
    expect(h.turnMessages[2]).toContain('too costly');

    const t = task(h);
    expect(t.status).toBe('review');
    expect(t.pack).toEqual({ summary: 'Build it.', files: ['pack/PROPOSAL.md', 'pack/challenge-log.md'] });
    expect(h.files.get(`${t.id}/pack/PROPOSAL.md`)).toBe('# Proposal\n');
    expect(h.engine.readFile(t.id, 'pack/PROPOSAL.md')).toEqual({ ok: true, body: '# Proposal\n' });

    expect(h.engine.accept(t.id).ok).toBe(true);
    expect(task(h).status).toBe('done');
  });

  it('copies the files a run wrote into the shared folder and links them from the piece', async () => {
    const h = makeHarness({ seedTeams: [team({ checkpoints: { askFirst: false, reviewBeforeChallenge: false, finalReview: true } })], turns: [PLAN] });
    h.engine.start();
    h.engine.brief('team-1', 'x');
    await flush();
    h.engine.approve(task(h).id);
    await flush();
    h.settle(h.commissions[0].id, 'done', 'The written answer', [
      { name: 'designs/00-index.html', sourcePath: '/run/designs/00-index.html' },
      { name: '../escape.html', sourcePath: '/run/escape.html' },
    ]);
    const t = task(h);
    expect(h.files.get(`${t.id}/files/maya/designs/00-index.html`)).toBe('copied from /run/designs/00-index.html');
    expect(h.files.get(`${t.id}/files/maya/escape.html`)).toBe('copied from /run/escape.html');
    const piece = h.files.get(`${t.id}/01-market-and-shape-maya.md`)!;
    // The answer is the run's last STEP output, not the last file it wrote.
    expect(piece).toMatch(/^# Market and shape — Maya\n\nThe written answer/);
    expect(piece).toContain('`files/maya/designs/00-index.html`');
    expect(t.stages[0].assignments[0].filesCopied).toBe(true);
    expect(h.engine.filePath(t.id, 'files/maya/designs/00-index.html')).toBe(`/data/team-files/${t.id}/files/maya/designs/00-index.html`);
    expect(h.engine.filePath(t.id, '../../etc/passwd')).toBeNull();
  });

  it('matches a batch update that arrives before the launch call returns', async () => {
    const h = makeHarness({ seedTeams: [team({ checkpoints: { askFirst: false, reviewBeforeChallenge: false, finalReview: false } })], turns: [PLAN, PACK], commissionEmitsFirst: true });
    h.engine.start();
    h.engine.brief('team-1', 'x');
    await flush();
    h.engine.approve(task(h).id);
    await flush();
    const a = task(h).stages[0].assignments;
    expect(a.map((x) => x.orchestrationId)).toEqual([h.commissions[0].id, h.commissions[1].id]);
    expect(a.every((x) => x.status === 'running')).toBe(true);
  });

  it('waits when a piece fails, and a retry relaunches only that piece', async () => {
    const h = makeHarness({ seedTeams: [team({ checkpoints: { askFirst: false, reviewBeforeChallenge: false, finalReview: true } })], turns: [PLAN] });
    h.engine.start();
    h.engine.brief('team-1', 'x');
    await flush();
    h.engine.approve(task(h).id);
    await flush();
    h.settle(h.commissions[0].id, 'done');
    h.settle(h.commissions[1].id, 'failed');
    await flush();
    expect(task(h).status).toBe('waiting');
    expect(task(h).waiting?.reason).toBe('failed');
    expect(task(h).waiting?.message).toContain('Ade');

    expect(h.engine.retry(task(h).id).ok).toBe(true);
    await flush();
    expect(h.commissions).toHaveLength(3);
    expect(h.commissions[2].workerId).toBe('ade');
    // A stale update from the failed batch changes nothing.
    h.settle(h.commissions[1].id, 'failed');
    expect(task(h).status).toBe('running');
  });

  it('can carry on without a failed piece', async () => {
    const h = makeHarness({ seedTeams: [team({ checkpoints: { askFirst: false, reviewBeforeChallenge: false, finalReview: true } })], turns: [PLAN] });
    h.engine.start();
    h.engine.brief('team-1', 'x');
    await flush();
    h.engine.approve(task(h).id);
    await flush();
    h.settle(h.commissions[0].id, 'done');
    h.settle(h.commissions[1].id, 'failed');
    await flush();
    expect(h.engine.continueTask(task(h).id).ok).toBe(true);
    await flush();
    expect(task(h).stages[0].status).toBe('done');
    expect(h.commissions[2].workerId).toBe('rook');
  });

  describe('skipping', () => {
    const noStops = { askFirst: false, reviewBeforeChallenge: false, finalReview: true };

    it('stops a running piece and carries on without it, without asking', async () => {
      const h = makeHarness({ seedTeams: [team({ checkpoints: noStops })], turns: [PLAN] });
      h.engine.start();
      h.engine.brief('team-1', 'x');
      await flush();
      h.engine.approve(task(h).id);
      await flush();
      expect(h.engine.skipPiece(task(h).id, 0, 'ade').ok).toBe(true);
      expect(h.cancelledBatches).toEqual([h.commissions[1].id]);
      expect(task(h).stages[0].assignments[1].status).toBe('skipped');
      // The stopped batch reporting itself cancelled is not a failure.
      h.settle(h.commissions[1].id, 'cancelled');
      h.settle(h.commissions[0].id, 'done');
      await flush();
      expect(task(h).status).toBe('running');
      expect(task(h).stages[0].status).toBe('done');
      expect(h.commissions[2].workerId).toBe('rook');
    });

    it('skips a later stage so it never runs', async () => {
      const h = makeHarness({ seedTeams: [team({ checkpoints: noStops })], turns: [PLAN, PACK] });
      h.engine.start();
      h.engine.brief('team-1', 'x');
      await flush();
      h.engine.approve(task(h).id);
      await flush();
      expect(h.engine.skipStage(task(h).id, 1).ok).toBe(true);
      expect(task(h).stages[1].status).toBe('skipped');
      h.settle(h.commissions[0].id, 'done');
      h.settle(h.commissions[1].id, 'done');
      await flush();
      expect(h.commissions.map((c) => c.workerId)).toEqual(['maya', 'ade']);
      expect(task(h).status).toBe('review');
    });

    it('skipping the only piece of a stage that has not started skips the stage', async () => {
      const h = makeHarness({ seedTeams: [team({ checkpoints: noStops })], turns: [PLAN] });
      h.engine.start();
      h.engine.brief('team-1', 'x');
      await flush();
      h.engine.approve(task(h).id);
      await flush();
      expect(h.engine.skipPiece(task(h).id, 1, 'rook').ok).toBe(true);
      expect(task(h).stages[1].status).toBe('skipped');
    });

    it('moves past a checkpoint on the stage you skip', async () => {
      const h = makeHarness({
        seedTeams: [team({ checkpoints: { ...noStops, reviewBeforeChallenge: true } })],
        turns: [PLAN, PACK],
      });
      h.engine.start();
      h.engine.brief('team-1', 'x');
      await flush();
      h.engine.approve(task(h).id);
      await flush();
      h.settle(h.commissions[0].id, 'done');
      h.settle(h.commissions[1].id, 'done');
      await flush();
      expect(task(h).waiting?.reason).toBe('checkpoint');
      expect(h.engine.skipStage(task(h).id, 1).ok).toBe(true);
      await flush();
      expect(h.commissions).toHaveLength(2);
      expect(task(h).status).toBe('review');
    });

    it('will not skip the final pack, a finished stage, or a finished piece', async () => {
      const h = makeHarness({ seedTeams: [team({ checkpoints: noStops })], turns: [PLAN] });
      h.engine.start();
      h.engine.brief('team-1', 'x');
      await flush();
      h.engine.approve(task(h).id);
      await flush();
      h.settle(h.commissions[0].id, 'done');
      await flush();
      expect(h.engine.skipStage(task(h).id, 2).ok).toBe(false);
      expect(h.engine.skipPiece(task(h).id, 0, 'maya').ok).toBe(false);
      h.settle(h.commissions[1].id, 'done');
      await flush();
      expect(h.engine.skipStage(task(h).id, 0).ok).toBe(false);
    });
  });

  it('stops at the budget and continues once you add to it', async () => {
    const h = makeHarness({ seedTeams: [team({ checkpoints: { askFirst: false, reviewBeforeChallenge: false, finalReview: true } })], turns: [PLAN] });
    h.engine.start();
    h.engine.brief('team-1', 'x');
    await flush();
    h.engine.approve(task(h).id);
    await flush();
    h.setSpend(12.5);
    h.settle(h.commissions[0].id, 'done');
    h.settle(h.commissions[1].id, 'done');
    await flush();
    expect(task(h).status).toBe('waiting');
    expect(task(h).waiting?.reason).toBe('budget');
    expect(h.engine.continueTask(task(h).id).ok).toBe(false);
    expect(h.engine.continueTask(task(h).id, { extraBudgetUSD: 6 }).ok).toBe(true);
    await flush();
    expect(task(h).budgetUSD).toBe(18);
    expect(h.commissions[2].workerId).toBe('rook');
  });

  it('lifts a task to its team\'s raised budget', async () => {
    const h = makeHarness({ seedTeams: [team({ checkpoints: { askFirst: false, reviewBeforeChallenge: false, finalReview: true } })], turns: [PLAN] });
    h.engine.start();
    h.engine.brief('team-1', 'x');
    await flush();
    const t = team();
    h.engine.save({ id: t.id, name: t.name, members: t.members, budgetUSDPerTask: 100, checkpoints: t.checkpoints });
    expect(task(h).budgetUSD).toBe(100);
    h.engine.save({ id: t.id, name: t.name, members: t.members, budgetUSDPerTask: 5, checkpoints: t.checkpoints });
    expect(task(h).budgetUSD).toBe(100);
  });

  it('pauses before a challenge when the team asks to read the draft first', async () => {
    const h = makeHarness({ seedTeams: [team({ checkpoints: { askFirst: false, reviewBeforeChallenge: true, finalReview: true } })], turns: [PLAN] });
    h.engine.start();
    h.engine.brief('team-1', 'x');
    await flush();
    h.engine.approve(task(h).id);
    await flush();
    h.settle(h.commissions[0].id, 'done');
    h.settle(h.commissions[1].id, 'done');
    await flush();
    expect(task(h).waiting?.reason).toBe('checkpoint');
    expect(h.commissions).toHaveLength(2);
    h.engine.continueTask(task(h).id);
    await flush();
    expect(h.commissions).toHaveLength(3);
  });

  it('gives every planning turn the files attached to the brief', async () => {
    const h = makeHarness({ seedTeams: [team()], turns: ['<team_questions>["Which market?"]</team_questions>', PLAN] });
    h.engine.start();
    const spec = { id: 's', label: 'spec.pdf', mimeType: 'application/pdf', dataBase64: Buffer.from('%PDF').toString('base64') };
    h.engine.brief('team-1', 'Build from the spec', [spec]);
    await flush();
    h.engine.answer(task(h).id, ['Spain']);
    await flush();
    // Rebuilt from the shared folder for the second turn, not held in memory.
    expect(h.turnAttachments).toEqual([['spec.pdf'], ['spec.pdf']]);
    expect(task(h).attachments).toEqual(['attachments/spec.pdf']);
    expect(h.files.get(`${task(h).id}/brief.md`)).toContain('`attachments/spec.pdf`');
  });

  it('asks the coordinator again when its plan cannot be used, then gives up', async () => {
    const h = makeHarness({ seedTeams: [team({ checkpoints: { askFirst: false, reviewBeforeChallenge: false, finalReview: true } })], turns: ['no plan here', 'still none'] });
    h.engine.start();
    h.engine.brief('team-1', 'x');
    await flush();
    expect(h.turnMessages[1]).toContain('YOUR LAST REPLY COULD NOT BE USED');
    expect(task(h).status).toBe('failed');
    h.pushTurn(PLAN);
    expect(h.engine.retry(task(h).id).ok).toBe(true);
    await flush();
    expect(task(h).status).toBe('proposed');
  });

  it('refuses a second task while one is active', async () => {
    const h = makeHarness({ seedTeams: [team()], turns: [] });
    h.engine.start();
    expect(h.engine.brief('team-1', 'one').ok).toBe(true);
    expect(h.engine.brief('team-1', 'two')).toMatchObject({ ok: false });
  });

  it('re-runs a coordinator stage that a restart interrupted', async () => {
    const seeded: TeamTask = {
      id: 'task-9',
      teamId: 'team-1',
      teamName: 'Discovery',
      brief: 'x',
      status: 'running',
      createdAt: 0,
      updatedAt: 0,
      stages: [
        { kind: 'contribute', title: 'W', assignments: [], status: 'done' },
        { kind: 'synthesize', title: 'Pack', assignments: [], status: 'running' },
      ],
      stageIndex: 1,
      spentUSD: 0,
      budgetUSD: 12,
      folder: '/data/team-files/task-9',
      files: [],
    };
    const h = makeHarness({ seedTeams: [team()], seedTasks: [seeded], turns: [PACK] });
    h.engine.start();
    await flush();
    expect(task(h).status).toBe('review');
    expect(task(h).pack?.files).toEqual(['pack/PROPOSAL.md', 'pack/challenge-log.md']);
  });

  it('validates and saves teams, and will not delete one mid-task', async () => {
    const h = makeHarness({ turns: [] });
    h.engine.start();
    expect(h.engine.save({ name: 'Solo', members: [{ workerId: 'maya', role: '' }], budgetUSDPerTask: 5, checkpoints: { askFirst: true, reviewBeforeChallenge: false, finalReview: true } })).toMatchObject({ ok: false });
    const saved = h.engine.save({ name: ' Duo ', members: [{ workerId: 'maya', role: ' Analyst ' }, { workerId: 'ade', role: '' }], budgetUSDPerTask: 5, checkpoints: { askFirst: true, reviewBeforeChallenge: false, finalReview: true } });
    if (!saved.ok) throw new Error(saved.error);
    expect(saved.team.name).toBe('Duo');
    expect(saved.team.members[0].role).toBe('Analyst');
    h.engine.brief(saved.team.id, 'x');
    expect(h.engine.remove(saved.team.id)).toMatchObject({ ok: false });
    h.engine.cancel(task(h).id);
    expect(h.engine.remove(saved.team.id)).toEqual({ ok: true });
    expect(h.engine.list()).toEqual({ teams: [], tasks: [] });
  });
});

describe('TeamEngine room', () => {
  const reviewTask = (status: TeamTask['status'] = 'review'): TeamTask => ({
    id: 'task-r',
    teamId: 'team-1',
    teamName: 'Discovery',
    brief: 'Translate supplier PDFs',
    title: 'Auto-translation',
    status,
    createdAt: 0,
    updatedAt: 0,
    stages: [],
    stageIndex: 0,
    spentUSD: 0,
    budgetUSD: 12,
    folder: '/data/team-files/task-r',
    files: [
      { name: '01-market-maya.md', author: 'Maya', at: 0 },
      { name: '01-tech-ade.md', author: 'Ade', at: 0 },
      { name: 'pack/PROPOSAL.md', author: 'Coordinator', at: 0 },
    ],
    pack: { summary: 'Build it.', files: ['pack/PROPOSAL.md'] },
  });
  const room = (opts: { turns?: string[]; memberReplies?: string[]; status?: TeamTask['status']; autoStart?: boolean }) => {
    // Most room tests hold hand-offs for you, so each step can be seen.
    const checkpoints = { askFirst: true, reviewBeforeChallenge: false, finalReview: true, approveRoomWork: !opts.autoStart };
    const h = makeHarness({ seedTeams: [team({ checkpoints })], seedTasks: [reviewTask(opts.status)], turns: opts.turns, memberReplies: opts.memberReplies });
    h.files.set('task-r/01-market-maya.md', 'Maya market notes');
    h.files.set('task-r/01-tech-ade.md', 'Ade tech notes');
    h.files.set('task-r/pack/PROPOSAL.md', '# Proposal v1');
    h.engine.start();
    return h;
  };
  const said = (h: ReturnType<typeof makeHarness>) =>
    (task(h).room?.messages ?? []).map((m) => `${m.speaker.kind === 'member' ? m.speaker.name : m.speaker.kind}${m.wrapUp ? '*' : ''}: ${m.text}`);

  it('routes a question, lets members answer and respond, then wraps up', async () => {
    const h = room({
      turns: ['<route>["Maya", "Ade"]</route>', 'Agreed: OCR first.'],
      memberReplies: ['Market says Spain first.', 'OCR is the hard part, Maya.', 'PASS', 'Ade is right about OCR.'],
    });
    expect(h.engine.roomAsk('task-r', 'What is the riskiest part?')).toEqual({ ok: true });
    await flush();
    expect(said(h)).toEqual([
      'you: What is the riskiest part?',
      'Maya: Market says Spain first.',
      'Ade: OCR is the hard part, Maya.',
      'Ade: Ade is right about OCR.',
      'coordinator*: Agreed: OCR first.',
    ]);
    // Ade answers having read Maya, and each sees only its own pieces.
    expect(h.memberPrompts[1].prompt).toContain('Maya: Market says Spain first.');
    expect(h.memberPrompts[1].prompt).toContain('Ade tech notes');
    expect(h.memberPrompts[1].prompt).not.toContain('Maya market notes');
    expect(h.memberPrompts[2].prompt).toContain('reply with exactly: PASS');
    expect(task(h).room?.busy).toBeNull();
    expect(h.files.get('task-r/conversation.md')).toContain('OCR is the hard part');
  });

  it('saves what you attach and hands it to whoever answers', async () => {
    const h = room({ turns: [], memberReplies: ['That screenshot shows the old flow.'] });
    const shot = { id: 'a1', label: 'screen.png', mimeType: 'image/png', dataBase64: Buffer.from('PNG').toString('base64') };
    expect(h.engine.roomAsk('task-r', '@maya what is wrong here?', [shot])).toEqual({ ok: true });
    await flush();
    expect(h.files.get('task-r/attachments/screen.png')).toBe('PNG');
    expect(task(h).room?.messages[0].attachments).toEqual(['attachments/screen.png']);
    expect(h.memberPrompts[0].attachments).toEqual(['screen.png']);
    expect(h.memberPrompts[0].prompt).toContain('[attached: screen.png]');
  });

  it('lets the member you name answer, and needs no wrap-up for one voice', async () => {
    const h = room({ turns: ['<route>["Ade"]</route>'], memberReplies: ['Here is the pricing.'] });
    h.engine.roomAsk('task-r', '@maya what about pricing?');
    await flush();
    expect(said(h)).toEqual(['you: @maya what about pricing?', 'Maya: Here is the pricing.']);
    // Routed only to tell talk from work; the name you used wins.
    expect(h.turnMessages).toHaveLength(1);
    expect(h.turnMessages[0]).toContain('The user addressed Maya directly');
  });

  it('has the coordinator answer when the question is about the pack as a whole', async () => {
    const h = room({ turns: ['<route>[]</route>', 'The pack says build it.'] });
    h.engine.roomAsk('task-r', 'Summarise the verdict');
    await flush();
    expect(said(h)).toEqual(['you: Summarise the verdict', 'coordinator: The pack says build it.']);
  });

  it('folds the conversation into a new pack version and keeps the old one', async () => {
    const h = room({
      status: 'done',
      turns: ['<route>[]</route>', 'OCR matters.', '<summary>Now with OCR.</summary><file name="PROPOSAL.md"># Proposal v2</file>'],
    });
    expect(h.engine.updatePack('task-r')).toMatchObject({ ok: false });
    h.engine.roomAsk('task-r', 'What about scans?');
    await flush();
    expect(h.engine.updatePack('task-r')).toEqual({ ok: true });
    await flush();
    const t = task(h);
    expect(h.files.get('task-r/pack/PROPOSAL.md')).toBe('# Proposal v2\n');
    expect(h.files.get('task-r/pack-v1/PROPOSAL.md')).toBe('# Proposal v1');
    expect(t.pack).toMatchObject({ summary: 'Now with OCR.', version: 2 });
    expect(t.files.map((f) => f.name)).toContain('pack-v1/PROPOSAL.md');
    expect(t.status).toBe('review');
    expect(h.engine.updatePack('task-r')).toMatchObject({ ok: false });
  });

  it('refuses while the team is still working, or while someone is answering', async () => {
    const h = room({ status: 'proposed', turns: [] });
    expect(h.engine.roomAsk('task-r', 'hi')).toMatchObject({ ok: false });
    const h2 = room({ turns: ['<route>["Maya"]</route>'] });
    h2.engine.roomAsk('task-r', 'one');
    expect(h2.engine.roomAsk('task-r', 'two')).toMatchObject({ ok: false });
  });

  describe('handing off work', () => {
    const WORK = `<work>${JSON.stringify({
      title: 'Redo the designs on the console',
      assign: [{ name: 'Maya', ask: 'Redraw D-01 against the console billing UI.' }],
    })}</work>`;

    it('turns a request to do something into a proposal, and runs it as a stage once started', async () => {
      const h = room({ turns: [WORK] });
      h.engine.roomAsk('task-r', '@maya can you do the redesign on the console');
      await flush();
      const proposal = task(h).room!.messages[1];
      expect(proposal.handoff).toMatchObject({ title: 'Redo the designs on the console', status: 'proposed' });
      expect(h.memberPrompts).toHaveLength(0);
      expect(h.commissions).toHaveLength(0);

      expect(h.engine.roomStartWork('task-r', proposal.id)).toEqual({ ok: true });
      await flush();
      let t = task(h);
      expect(t.status).toBe('running');
      expect(t.stages[0]).toMatchObject({ title: 'Redo the designs on the console', fromRoom: { messageId: proposal.id } });
      expect(t.room!.messages[1].handoff).toMatchObject({ status: 'started', stage: 0 });
      expect(h.commissions).toHaveLength(1);
      const prompt = h.commissions[0].prompt;
      expect(prompt).toContain('FOLLOW-UP WORK');
      expect(prompt).toContain('can you do the redesign on the console');
      expect(prompt).toContain('Redraw D-01 against the console billing UI.');
      expect(prompt).toContain('# Proposal v1');
      expect(prompt).toContain('/data/team-files/task-r/files/maya/');

      h.settle(h.commissions[0].id, 'done', 'Redrew D-01 with the credit banner.', [
        { name: 'designs/01-page.html', sourcePath: '/run/designs/01-page.html' },
      ]);
      await flush();
      t = task(h);
      expect(t.status).toBe('review');
      expect(h.files.get('task-r/files/maya/designs/01-page.html')).toBe('copied from /run/designs/01-page.html');
      const report = t.room!.messages.at(-1)!;
      expect(report).toMatchObject({ speaker: { kind: 'member', name: 'Maya' }, workReport: { stage: 0 } });
      expect(report.text).toContain('Redrew D-01 with the credit banner.');
      expect(report.text).toContain('`files/maya/designs/01-page.html`');

      // The pack update reads what the work produced.
      h.pushTurn('<summary>With the new designs.</summary><file name="PROPOSAL.md"># Proposal v2</file>');
      expect(h.engine.updatePack('task-r')).toEqual({ ok: true });
      await flush();
      expect(h.turnMessages.at(-1)).toContain('WORK MEMBERS DID SINCE');
      expect(h.turnMessages.at(-1)).toContain('Redrew D-01 with the credit banner.');
    });

    it('keeps talking while the work runs, but holds new work until it reports back', async () => {
      const h = room({ turns: [WORK] });
      h.engine.roomAsk('task-r', 'redo the designs');
      await flush();
      h.engine.roomStartWork('task-r', task(h).room!.messages[1].id);
      await flush();

      h.pushTurn('<route>[]</route>');
      h.pushTurn('Maya is still on it; nothing back yet.');
      expect(h.engine.roomAsk('task-r', 'how is it going?')).toEqual({ ok: true });
      await flush();
      expect(h.turnMessages.at(-1)).toContain('RIGHT NOW: Maya is doing "Redo the designs on the console"');
      expect(task(h).room!.messages.at(-1)).toMatchObject({
        speaker: { kind: 'coordinator' },
        text: 'Maya is still on it; nothing back yet.',
      });
      expect(task(h).status).toBe('running');

      h.pushTurn(WORK);
      h.engine.roomAsk('task-r', 'and then redo the mobile one');
      await flush();
      const proposal = task(h).room!.messages.at(-1)!;
      expect(proposal.handoff?.status).toBe('proposed');
      expect(h.engine.roomStartWork('task-r', proposal.id)).toMatchObject({ ok: false });
      expect(h.engine.updatePack('task-r')).toMatchObject({ ok: false });
    });

    it('lets the team take a new task while work handed off from the room runs', async () => {
      const h = room({ turns: [WORK] });
      h.engine.roomAsk('task-r', 'redo the designs');
      await flush();
      h.engine.roomStartWork('task-r', task(h).room!.messages[1].id);
      await flush();
      const res = h.engine.brief('team-1', 'Next idea');
      expect(res).toMatchObject({ ok: true });
      expect(h.engine.brief('team-1', 'And another')).toMatchObject({ ok: false, error: expect.stringContaining('still on') });
    });

    it('can set a proposal aside', async () => {
      const h = room({ turns: [WORK] });
      h.engine.roomAsk('task-r', 'redo the designs');
      await flush();
      const id = task(h).room!.messages[1].id;
      expect(h.engine.roomDismissWork('task-r', id)).toEqual({ ok: true });
      expect(task(h).room!.messages[1].handoff!.status).toBe('dismissed');
      expect(h.engine.roomStartWork('task-r', id)).toMatchObject({ ok: false });
    });

    it('hands off what a member said they would do', async () => {
      const h = room({ turns: ['<route>["Maya"]</route>'], memberReplies: ['I would redraw D-01 first.'] });
      h.engine.roomAsk('task-r', 'could the designs use the console?');
      await flush();
      const answer = task(h).room!.messages[1];
      expect(h.engine.roomHandOff('task-r', answer.id)).toEqual({ ok: true });
      const proposal = task(h).room!.messages.at(-1)!;
      expect(proposal.handoff!.assignments[0]).toMatchObject({ workerId: 'maya' });
      expect(proposal.handoff!.assignments[0].ask).toContain('I would redraw D-01 first.');
      expect(proposal.handoff!.title).toBe('Could the designs use the console?');
    });

    describe('without approving follow-up work', () => {
      it('starts the work as soon as it is handed off', async () => {
        const h = room({ turns: [WORK], autoStart: true });
        h.engine.roomAsk('task-r', '@maya redo the designs on the console');
        await flush();
        const t = task(h);
        expect(t.room!.messages[1].handoff).toMatchObject({ status: 'started', stage: 0 });
        expect(t.room!.messages[1].text).toContain('Maya is on it');
        expect(t.status).toBe('running');
        expect(h.commissions).toHaveLength(1);
      });

      it('queues work asked for while other work runs, and starts it when that reports back', async () => {
        const h = room({ turns: [WORK], autoStart: true });
        h.engine.roomAsk('task-r', 'redo the designs');
        await flush();
        h.pushTurn(`<work>${JSON.stringify({ title: 'Redo the mobile one', assign: [{ name: 'Ade', ask: 'Mobile too.' }] })}</work>`);
        h.engine.roomAsk('task-r', 'and then redo the mobile one');
        await flush();
        const queued = task(h).room!.messages.at(-1)!;
        expect(queued.handoff?.status).toBe('queued');
        expect(queued.text).toContain('once "Redo the designs on the console" reports back');
        expect(h.commissions).toHaveLength(1);

        h.settle(h.commissions[0].id, 'done', 'Redrew D-01.');
        await flush();
        const t = task(h);
        expect(t.status).toBe('running');
        expect(t.stages.map((s) => s.title)).toEqual(['Redo the designs on the console', 'Redo the mobile one']);
        expect(t.room!.messages.find((m) => m.id === queued.id)!.handoff).toMatchObject({ status: 'started', stage: 1 });
        expect(h.commissions).toHaveLength(2);

        h.settle(h.commissions[1].id, 'done', 'Mobile done.');
        await flush();
        expect(task(h).status).toBe('review');
      });

      it('can take queued work back before it starts', async () => {
        const h = room({ turns: [WORK, WORK], autoStart: true });
        h.engine.roomAsk('task-r', 'redo the designs');
        await flush();
        h.engine.roomAsk('task-r', 'again');
        await flush();
        const queued = task(h).room!.messages.at(-1)!;
        expect(h.engine.roomDismissWork('task-r', queued.id)).toEqual({ ok: true });
        h.settle(h.commissions[0].id, 'done', 'Done.');
        await flush();
        expect(task(h).status).toBe('review');
        expect(h.commissions).toHaveLength(1);
      });

      it('holds queued work for you once you stop the work ahead of it', async () => {
        const h = room({ turns: [WORK, WORK], autoStart: true });
        h.engine.roomAsk('task-r', 'redo the designs');
        await flush();
        h.engine.roomAsk('task-r', 'again');
        await flush();
        const queued = task(h).room!.messages.at(-1)!;
        expect(h.engine.cancel('task-r')).toEqual({ ok: true });
        expect(task(h).status).toBe('review');
        expect(task(h).room!.messages.find((m) => m.id === queued.id)!.handoff!.status).toBe('proposed');
        expect(h.commissions).toHaveLength(1);
      });
    });

    it('stops the work, not the task, and says so in the room', async () => {
      const h = room({ turns: [WORK] });
      h.engine.roomAsk('task-r', 'redo the designs');
      await flush();
      h.engine.roomStartWork('task-r', task(h).room!.messages[1].id);
      await flush();
      expect(h.engine.cancel('task-r')).toEqual({ ok: true });
      const t = task(h);
      expect(t.status).toBe('review');
      expect(t.stages[0].status).toBe('failed');
      expect(t.room!.messages.at(-1)).toMatchObject({ failed: true, text: expect.stringContaining('You stopped it.') });
      expect(h.engine.roomAsk('task-r', 'ok, something else')).toEqual({ ok: true });
    });
  });
});

describe('TeamEngine hiring', () => {
  const HIRING_PLAN = `<team_plan>${JSON.stringify({
    title: 'Priced proposal',
    stages: [
      {
        kind: 'contribute',
        title: 'Market and price',
        assignments: [
          { member: 'Maya', ask: 'Market' },
          { member: 'Pricing analyst', ask: 'Price it' },
        ],
      },
      { kind: 'synthesize', title: 'Pack', ask: 'Write the pack' },
    ],
    hires: [{ name: 'Pricing analyst', role: 'Prices the offer', job: 'Builds pricing models.', why: 'Nobody prices.' }],
  })}</team_plan>`;
  const noQuestions = { askFirst: false, reviewBeforeChallenge: false, finalReview: true };

  it('hires what the approved plan needs, puts them on the team, then runs', async () => {
    const h = makeHarness({
      seedTeams: [team({ checkpoints: noQuestions })],
      turns: [HIRING_PLAN],
      hire: () => ({ ok: true, worker: worker('pia', 'Pia') }),
    });
    h.engine.start();
    h.engine.brief('team-1', 'A priced proposal');
    await flush();
    expect(h.turnMessages[0]).toContain('HIRING: if the brief clearly needs');
    expect(task(h).status).toBe('proposed');
    expect(task(h).hires).toMatchObject([{ name: 'Pricing analyst', status: 'proposed' }]);

    h.engine.approve(task(h).id);
    await flush();
    expect(h.hireRequests).toEqual([
      { job: 'Builds pricing models.', role: 'Prices the offer', teamName: 'Discovery', teamId: 'team-1', purpose: undefined },
    ]);
    expect(task(h).hires?.[0]).toMatchObject({ status: 'hired', workerId: 'pia' });
    expect(task(h).stages[0].assignments[1]).toMatchObject({ workerId: 'pia', workerName: 'Pia' });
    expect(h.engine.list().teams[0].members.at(-1)).toEqual({ workerId: 'pia', role: 'Prices the offer' });
    expect(h.commissions.map((c) => c.workerId)).toEqual(['maya', 'pia']);
  });

  it('holds the plan when a hire fails, and can carry on without them', async () => {
    const h = makeHarness({
      seedTeams: [team({ checkpoints: noQuestions })],
      turns: [HIRING_PLAN],
      hire: () => ({ ok: false, error: 'drafter down' }),
    });
    h.engine.start();
    h.engine.brief('team-1', 'A priced proposal');
    await flush();
    h.engine.approve(task(h).id);
    await flush();
    expect(task(h).status).toBe('waiting');
    expect(task(h).waiting?.message).toContain('drafter down');
    expect(h.commissions).toHaveLength(0);

    expect(h.engine.retry(task(h).id).ok).toBe(true);
    await flush();
    expect(h.hireRequests).toHaveLength(2);
    expect(task(h).status).toBe('waiting');

    expect(h.engine.continueTask(task(h).id).ok).toBe(true);
    await flush();
    expect(task(h).hires).toBeUndefined();
    expect(task(h).stages[0].assignments.map((a) => a.workerId)).toEqual(['maya']);
    expect(h.commissions.map((c) => c.workerId)).toEqual(['maya']);
  });

  it('tells the coordinator it cannot hire when hiring is unavailable', async () => {
    const h = makeHarness({ seedTeams: [team({ checkpoints: noQuestions })], turns: [HIRING_PLAN, PLAN] });
    h.engine.start();
    h.engine.brief('team-1', 'A priced proposal');
    await flush();
    expect(h.turnMessages[0]).toContain('HIRING: not possible');
    // The hiring plan is refused and the retry plans with the team as is.
    expect(h.turnMessages[1]).toContain('cannot hire');
    expect(task(h).status).toBe('proposed');
    expect(task(h).hires).toBeUndefined();
  });

  it('suggests a roster from the crew and new hires', async () => {
    const h = makeHarness({
      turns: [
        `<team_roster>${JSON.stringify({
          name: 'Pricing',
          purpose: 'Prices things',
          note: 'Maya knows the market.',
          members: [
            { worker: 'maya', role: 'Market' },
            { worker: 'Nobody', role: 'x' },
            { hire: 'Builds pricing models. Loves spreadsheets.', role: '' },
          ],
        })}</team_roster>`,
      ],
    });
    const res = await h.engine.draftRoster({ brief: 'price our product' });
    expect(res).toEqual({
      ok: true,
      draft: {
        name: 'Pricing',
        purpose: 'Prices things',
        note: 'Maya knows the market.',
        members: [
          { kind: 'worker', workerId: 'maya', role: 'Market' },
          { kind: 'hire', job: 'Builds pricing models. Loves spreadsheets.', role: 'Builds pricing models' },
        ],
      },
    });
    expect(h.turnMessages[0]).toContain("- Rook [works in Acme] — Rook's job");
  });
});

describe('TeamEngine projects', () => {
  const noQuestions = { askFirst: false, reviewBeforeChallenge: false, finalReview: true };

  it("runs every piece in the team's project and tells members it is not their usual one", async () => {
    const h = makeHarness({ seedTeams: [team({ checkpoints: noQuestions, projectPath: '/code/overcli' })], turns: [PLAN] });
    h.engine.start();
    h.engine.brief('team-1', 'Ship the release candidate');
    await flush();
    expect(task(h).projectPath).toBe('/code/overcli');
    expect(h.turnMessages[0]).toContain('WORKS IN: the overcli project');
    h.engine.approve(task(h).id);
    await flush();
    expect(h.commissions.map((c) => c.projectPath)).toEqual(['/code/overcli', '/code/overcli']);
    expect(h.commissions[0].prompt).toContain('THE PROJECT: overcli — /code/overcli');
    expect(h.commissions[0].prompt).toContain('not Acme');
  });

  it('lets one brief work somewhere else, or in each member\'s own project', async () => {
    const h = makeHarness({ seedTeams: [team({ checkpoints: noQuestions, projectPath: '/code/overcli' })], turns: [PLAN] });
    h.engine.start();
    h.engine.brief('team-1', 'Ship overgit', [], '/code/overgit');
    expect(task(h).projectPath).toBe('/code/overgit');
    h.engine.cancel(task(h).id);
    h.engine.brief('team-1', 'Just research', [], null);
    expect(h.engine.list().tasks.find((t) => t.brief === 'Just research')?.projectPath).toBeUndefined();
    expect(h.engine.brief('team-1', 'x', [], '/gone').ok).toBe(false);
  });

  it("hires plan members into the task's project", async () => {
    const HIRING = `<team_plan>${JSON.stringify({
      stages: [{ kind: 'contribute', title: 'Cut it', assignments: [{ member: 'Release lead', ask: 'Cut the release' }] }],
      hires: [{ name: 'Release lead', role: 'Cuts releases', job: 'Cuts releases.', why: 'Nobody ships.' }],
    })}</team_plan>`;
    const h = makeHarness({
      seedTeams: [team({ checkpoints: noQuestions, projectPath: '/code/overcli' })],
      turns: [HIRING],
      hire: () => ({ ok: true, worker: { ...worker('rel', 'Rel'), projectPath: '/code/overcli' } }),
    });
    h.engine.start();
    h.engine.brief('team-1', 'Ship it');
    await flush();
    h.engine.approve(task(h).id);
    await flush();
    expect(h.hireRequests[0]).toMatchObject({ projectPath: '/code/overcli', projectName: 'overcli' });
    // Their piece runs where they live, so it carries no "not your usual project" note.
    const piece = h.commissions.find((c) => c.workerId === 'rel')!;
    expect(piece.projectPath).toBe('/code/overcli');
    expect(piece.prompt).not.toContain('THE PROJECT:');
  });

  it('shows the roster drafter where everyone works, and takes a project the brief names', async () => {
    const h = makeHarness({
      turns: [
        `<team_roster>${JSON.stringify({
          name: 'Release crew',
          purpose: 'Ships it',
          project: 'overcli',
          members: [{ worker: 'Maya', role: 'Checks' }, { hire: 'Cuts releases.', role: 'Release lead' }],
        })}</team_roster>`,
      ],
    });
    const res = await h.engine.draftRoster({ brief: 'release team for overcli' });
    expect(h.turnMessages[0]).toContain('- Maya [works in Acme]');
    expect(h.turnMessages[0]).toContain("THE USER'S PROJECTS: Acme, overcli, overgit");
    expect(res.ok && res.draft.projectPath).toBe('/code/overcli');
  });

  it('shows the roster drafter only the team\'s project when asked to', async () => {
    const h = makeHarness({
      turns: [
        `<team_roster>${JSON.stringify({
          name: 'Release crew',
          members: [{ hire: 'Checks releases.', role: 'Checker' }, { hire: 'Cuts releases.', role: 'Release lead' }],
        })}</team_roster>`,
      ],
    });
    await h.engine.draftRoster({
      brief: 'release team',
      current: { members: [], projectPath: '/code/overcli', ownProjectOnly: true },
    });
    expect(h.turnMessages[0]).toContain('nobody yet');
    expect(h.turnMessages[0]).not.toContain('Maya');
    expect(h.turnMessages[0]).toContain('only overcli people');
  });
});

describe('TeamEngine piece permissions', () => {
  const noQuestions = { askFirst: false, reviewBeforeChallenge: false, finalReview: true };
  const firstStage = async (overrides: Partial<Team>) => {
    const h = makeHarness({ seedTeams: [team({ checkpoints: noQuestions, ...overrides })], turns: [PLAN] });
    h.engine.start();
    h.engine.brief('team-1', 'Ship it');
    await flush();
    h.engine.approve(task(h).id);
    await flush();
    return h.commissions;
  };

  it('lets pieces work without asking by default', async () => {
    expect((await firstStage({})).map((c) => c.allowExternalActions)).toEqual([true, true]);
  });

  it("holds pieces to each member's own permissions when the team says so", async () => {
    expect((await firstStage({ piecesAskFirst: true })).map((c) => c.allowExternalActions)).toEqual([undefined, undefined]);
  });
});

describe('TeamEngine task branch', () => {
  const noQuestions = { askFirst: false, reviewBeforeChallenge: false, finalReview: true };
  const start = async (absorbs: Array<'ok' | 'conflict'>) => {
    const h = makeHarness({
      seedTeams: [team({ checkpoints: noQuestions, projectPath: '/code/overcli' })],
      turns: [PLAN, PACK],
      code: { absorbs },
    });
    h.engine.start();
    h.engine.brief('team-1', 'Ship it');
    await flush();
    h.engine.approve(task(h).id);
    await flush();
    return h;
  };

  it('cuts the branch when the plan is approved, and forks every piece off it', async () => {
    const h = await start(['ok', 'ok', 'ok']);
    expect(h.codeCalls[0]).toBe('open Teams proposal /code/overcli');
    expect(task(h).code?.branch).toBe('team/x');
    expect(h.commissions.map((c) => c.baseBranch)).toEqual(['team/x', 'team/x']);
    h.settle(h.commissions[0].id, 'done');
    h.settle(h.commissions[1].id, 'done');
    await flush();
    expect(h.codeCalls.filter((c) => c.startsWith('absorb'))).toEqual(['absorb Maya: Market and shape', 'absorb Ade: Market and shape']);
    expect(h.commissions[2]).toMatchObject({ workerId: 'rook', baseBranch: 'team/x' });
  });

  it('stops the stage on a conflict; Retry merges again, Continue drops it', async () => {
    const h = await start(['ok', 'conflict', 'ok']);
    h.settle(h.commissions[0].id, 'done');
    h.settle(h.commissions[1].id, 'done');
    await flush();
    expect(task(h).status).toBe('waiting');
    expect(task(h).waiting?.message).toContain('conflict in README.md');
    expect(h.commissions).toHaveLength(2);

    expect(h.engine.retry(task(h).id).ok).toBe(true);
    await flush();
    // Resolved: the next stage starts from the merged branch.
    expect(h.commissions[2]).toMatchObject({ workerId: 'rook' });
  });

  it('can carry on without changes that would not merge, and land the branch at the end', async () => {
    const h = await start(['conflict', 'ok', 'ok']);
    h.settle(h.commissions[0].id, 'done');
    h.settle(h.commissions[1].id, 'done');
    await flush();
    expect(task(h).status).toBe('waiting');
    expect(h.engine.continueTask(task(h).id).ok).toBe(true);
    await flush();
    h.settle(h.commissions[2].id, 'done', '1. High: too costly');
    await flush();
    expect(task(h).status).toBe('review');
    expect(h.engine.landCode(task(h).id, '/code/overcli')).toEqual({ ok: true, message: 'Merged' });
    expect(task(h).code?.repos[0].landed).toBe(true);
  });

  it('gives a task with no project no branch', async () => {
    const h = makeHarness({ seedTeams: [team({ checkpoints: noQuestions })], turns: [PLAN], code: { absorbs: [] } });
    h.engine.start();
    h.engine.brief('team-1', 'Research only');
    await flush();
    h.engine.approve(task(h).id);
    await flush();
    expect(task(h).code).toBeUndefined();
    expect(h.commissions[0].baseBranch).toBeUndefined();
  });
});
