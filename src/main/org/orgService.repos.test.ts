import { describe, expect, it } from 'vitest';
import type { Worker } from '../../shared/flows/worker';
import type { FlowRun } from '../../shared/flows/schema';
import { DEFAULT_ORG_POLICY, type OrgCaller } from '../../shared/org/policy';
import { OrgService } from './orgService';
import type { ConnectedRepo, OrgWorkspace } from './repos';

const PAT = 'U0ACMEPAT';
const pat: OrgCaller = { slackUserId: PAT, name: 'Pat', admin: false };
const sam: OrgCaller = { slackUserId: 'U0ACMESAM', name: 'Sam', admin: false };
const admin: OrgCaller = { slackUserId: 'U0ACMEBOSS', name: 'Bo', admin: true };

const triage: Worker = {
  id: 'triage',
  name: 'Triage',
  jobDescription: 'Fixes bugs in the web app and opens pull requests.',
  projectPath: '/data/Workers',
  cadence: null,
  trust: 'probation',
  caps: { maxItemsPerShift: 1, runIn: 'worktree', allowExternalActions: false } as Worker['caps'],
  budgetUSDPerMonth: 20,
  heartbeatModel: 'sonnet',
  flowIds: ['triage-flow'],
  enabled: true,
  createdAt: 0,
  manager: { name: 'Pat', slackUserId: PAT },
};

function harness(runs: FlowRun[] = []) {
  const roster = new Map([[triage.id, structuredClone(triage)]]);
  const repos: ConnectedRepo[] = [];
  const workspaces: OrgWorkspace[] = [];
  const flows: string[] = [];
  const audit: string[] = [];
  const set: string[] = [];
  let changed = 0;
  let testsOff: string | undefined;
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
    runs: { listRuns: () => runs, getRun: (id) => runs.find((r) => r.id === id) ?? null, steerRun: () => ({ ok: true }), resumeRun: () => ({ ok: true }) },
    rejectRun: () => ({ ok: true }),
    policy: () => ({ ...DEFAULT_ORG_POLICY, hirers: '*' }),
    draft: async () => ({ ok: false, error: 'no' }),
    saveHire: () => ({ ok: false, error: 'no' }),
    hires: { list: () => [], save: () => {} },
    repos: {
      list: () => repos,
      connect: async (input, by) => {
        const repo: ConnectedRepo = { name: 'app', url: input.url, path: '/data/repos/app', defaultBranch: 'main', ...(input.testCommand ? { testCommand: input.testCommand } : {}), addedBy: by, at: 0 };
        repos.push(repo);
        return { ok: true, repo };
      },
      disconnect: () => ({ ok: true }),
      canPush: () => true,
      tokenFor: () => null,
      testsOff: () => testsOff,
      workspaces: () => workspaces,
      createWorkspace: (input, by) => {
        const workspace = { id: 'ws-shop', name: input.name, repos: input.repos, rootPath: '/data/workspaces/ws-shop', addedBy: by, at: 0 };
        workspaces.push(workspace);
        return { ok: true, workspace };
      },
      updateWorkspace: () => ({ ok: false, error: 'no' }),
      removeWorkspace: () => ({ ok: true }),
      changed: () => changed++,
    },
    saveFlow: (id) => {
      flows.push(id);
      return { ok: true };
    },
    secrets: {
      store: { kind: 'file', where: 'memory', readOnly: false },
      status: (neededBy) => ({ error: null, secrets: [{ name: 'GH_TOKEN', why: 'Pushing.', state: 'missing' as const, neededBy: neededBy('GH_TOKEN') }] }),
      set: async (name, value) => {
        set.push(`${name}=${value}`);
        return { ok: true };
      },
      remove: async () => ({ ok: true }),
    },
    audit: { append: (e) => audit.push(e.what), recent: () => [], all: () => [] },
    now: () => 0,
  });
  return { svc, roster, flows, audit, set, changed: () => changed, turnTestsOff: (why: string | undefined) => (testsOff = why) };
}

describe('repos', () => {
  it('warns, on connecting and on the list, when its tests would hold every push back', async () => {
    const h = harness();
    h.turnTestsOff('Set OVERCLI_TEST_UID.');
    const res = await h.svc.connectRepo(admin, { url: 'https://github.com/acme/app', testCommand: 'npm test' });
    expect(res).toMatchObject({ ok: true, warning: 'Repo tests are turned off on this server, so nothing is pushed from app until they\'re on. Set OVERCLI_TEST_UID.' });
    expect(h.svc.repoList(admin)).toMatchObject({ ok: true, testsOff: 'Set OVERCLI_TEST_UID.' });
    h.turnTestsOff(undefined);
    const list = h.svc.repoList(admin);
    expect(list.ok && 'testsOff' in list).toBe(false);
  });

  it('does not warn for a repo with no test command', async () => {
    const h = harness();
    h.turnTestsOff('Set OVERCLI_TEST_UID.');
    const res = await h.svc.connectRepo(admin, { url: 'https://github.com/acme/app' });
    expect(res.ok && 'warning' in res).toBe(false);
  });

  it('lets only admins connect one, and updates the grants when they do', async () => {
    const h = harness();
    expect(await h.svc.connectRepo(pat, { url: 'https://github.com/acme/app' })).toMatchObject({ ok: false });
    expect(await h.svc.connectRepo(admin, { url: 'https://github.com/acme/app' })).toMatchObject({ ok: true, repo: { name: 'app' } });
    expect(h.changed()).toBe(1);
  });

  it("points a worker at a repo with a pull request flow, for its manager only", async () => {
    const h = harness();
    await h.svc.connectRepo(admin, { url: 'https://github.com/acme/app' });
    expect(h.svc.letWorkOnRepo(sam, 'Triage', 'app').ok).toBe(false);
    expect(h.svc.letWorkOnRepo(pat, 'Triage', 'app')).toEqual({ ok: true, worker: 'Triage', flow: 'org-pr-app' });
    expect(h.roster.get('triage')).toMatchObject({ projectPath: '/data/repos/app', flowIds: ['triage-flow', 'org-pr-app'], preferredFlowId: 'org-pr-app' });
    expect(h.svc.repoList(pat)).toMatchObject({ ok: true, repos: [{ name: 'app', workers: ['Triage'] }] });
  });
  it('keeps a preferred flow someone picked, and only takes one of its own', async () => {
    const h = harness();
    await h.svc.connectRepo(admin, { url: 'https://github.com/acme/app' });
    expect(h.svc.update(pat, 'Triage', { preferredFlowId: 'nope' })).toMatchObject({ ok: false, error: expect.stringContaining("isn't one of Triage's flows") });
    expect(h.svc.update(pat, 'Triage', { preferredFlowId: 'triage-flow' }).ok).toBe(true);
    h.svc.letWorkOnRepo(pat, 'Triage', 'app');
    expect(h.roster.get('triage')!.preferredFlowId).toBe('triage-flow');
    expect(h.svc.update(pat, 'Triage', { preferredFlowId: null }).ok).toBe(true);
    expect(h.roster.get('triage')!.preferredFlowId).toBeUndefined();
  });
});

describe('branch prefix', () => {
  it('lets admins set one git takes, and refuses the rest', () => {
    let saved = 'agent/';
    const h = harness();
    const repos = (h.svc as unknown as { deps: { repos: Record<string, unknown> } }).deps.repos;
    repos.branchPrefix = () => saved;
    repos.setBranchPrefix = (p: string) => { saved = p; };
    expect(h.svc.setBranchPrefix(pat, 'overgo/').ok).toBe(false);
    expect(h.svc.setBranchPrefix(admin, 'overgo/')).toEqual({ ok: true, branchPrefix: 'overgo/' });
    expect(saved).toBe('overgo/');
    for (const bad of ['overgo', '../x/', 'a//b/', 'x y/', '-x/']) expect(h.svc.setBranchPrefix(admin, bad).ok).toBe(false);
    expect(h.svc.repoList(admin)).toMatchObject({ ok: true, branchPrefix: 'overgo/' });
  });
});

describe('secrets', () => {
  it('are for admins, and the record names the secret, never its value', async () => {
    const h = harness();
    expect(h.svc.secretList(pat).ok).toBe(false);
    expect((await h.svc.setSecret(pat, 'GH_TOKEN', 'ghs_x')).ok).toBe(false);
    expect(await h.svc.setSecret(admin, 'GH_TOKEN', 'ghs_x')).toEqual({ ok: true });
    expect(h.set).toEqual(['GH_TOKEN=ghs_x']);
    expect(h.audit.at(-1)).toBe('Set the secret GH_TOKEN.');
    expect(h.audit.join(' ')).not.toContain('ghs_x');
    expect(h.svc.secretList(admin)).toMatchObject({ ok: true, store: { where: 'memory' }, secrets: [{ name: 'GH_TOKEN', state: 'missing' }] });
  });
});

describe("a worker's runs on its page", () => {
  const steps = [{ id: 'capture' }, { id: 'compare' }, { id: 'report' }];
  const run = (id: string, state: FlowRun['state'], at: number, extra: Partial<FlowRun> = {}): FlowRun =>
    ({ id, workerId: 'triage', workerName: 'Triage', flowId: 'f', flowSnapshot: { name: 'Pricing check', steps }, userPrompt: 'Check pricing', state, createdAt: at, attempts: [], artifacts: {}, ...extra }) as unknown as FlowRun;

  it('shows what is under way, step by step, and what ended, with its result', () => {
    const h = harness([
      run('r1', { kind: 'running', currentStepId: 'compare' }, 3_000),
      run('r2', { kind: 'done', success: true }, 1_000, {
        attempts: [{ stepId: 'capture', startedAt: 1_000, endedAt: 121_000, conversationId: 'c' }] as FlowRun['attempts'],
        artifacts: { 'report.md': { name: 'report.md', kind: 'text', body: 'Prices up 10%.', producedByStepId: 'report', producedAt: 120_000 } } as FlowRun['artifacts'],
        costUSD: 0.42,
      }),
      run('r3', { kind: 'paused', nextStepId: 'capture', reason: 'interrupted' } as FlowRun['state'], 2_000),
    ]);
    const d = h.svc.workerDetail(pat, 'Triage');
    if (!d.ok) throw new Error(d.error);
    expect(d.now.map((n) => [n.runId, n.state, n.step])).toEqual([
      ['r1', 'working', { index: 2, total: 3, name: 'compare' }],
      ['r3', 'interrupted', { index: 1, total: 3, name: 'capture' }],
    ]);
    expect(d.now[0].finished).toEqual(['capture']);
    expect(d.history).toMatchObject([{ runId: 'r2', outcome: 'done', minutes: 2, costUSD: 0.42, result: { name: 'report.md', body: 'Prices up 10%.' } }]);
    expect(h.svc.resumeInterrupted(sam, 'r3').ok).toBe(false);
    expect(h.svc.resumeInterrupted(pat, 'r3')).toEqual({ ok: true });
    expect(h.svc.resumeInterrupted(pat, 'r1').ok).toBe(false);
  });
});

describe("a worker's work as threads", () => {
  const steps = [{ id: 'capture' }, { id: 'compare' }];
  const run = (id: string, state: FlowRun['state'], at: number): FlowRun =>
    ({ id, workerId: 'triage', workerName: 'Triage', flowId: 'f', flowSnapshot: { name: 'Pricing check', steps }, userPrompt: `Check ${id}`, state, createdAt: at, attempts: [], artifacts: {} }) as unknown as FlowRun;

  it('pages its threads newest first and says what it is doing now', () => {
    const h = harness([run('r1', { kind: 'running', currentStepId: 'compare' } as FlowRun['state'], 3_000), run('r2', { kind: 'done', success: true } as FlowRun['state'], 1_000)]);
    const first = h.svc.workerThreads(pat, 'Triage', { limit: 1 });
    if (!first.ok) throw new Error(first.error);
    expect(first.threads.map((t) => t.id)).toEqual(['run:r1']);
    expect(first).toMatchObject({ total: 2, nextBefore: 3_000, youManage: true });
    expect(first.now?.sentence).toBe('Triage is on step 2 of 2, compare, of “Check r1”.');
    const rest = h.svc.workerThreads(pat, 'Triage', { before: first.nextBefore! });
    expect(rest.ok && rest.threads.map((t) => t.id)).toEqual(['run:r2']);
    expect(h.svc.workerThreads(sam, 'Triage').ok).toBe(false);
  });

  it('builds the threads once for a first page and the pages behind it', () => {
    const h = harness([run('r1', { kind: 'done', success: true } as FlowRun['state'], 3_000), run('r2', { kind: 'done', success: true } as FlowRun['state'], 1_000)]);
    let clock = 10_000;
    const deps = (h.svc as unknown as { deps: { now?: () => number; runs: { listRuns: () => FlowRun[] } } }).deps;
    deps.now = () => clock;
    const first = h.svc.workerThreads(pat, 'Triage', { limit: 1 });
    if (!first.ok) throw new Error(first.error);
    // The runs go; a page behind still reads the first page's build, a new first page a few seconds on does not.
    deps.runs.listRuns = () => [];
    const rest = h.svc.workerThreads(pat, 'Triage', { before: first.nextBefore! });
    expect(rest.ok && rest.threads.map((t) => t.id)).toEqual(['run:r2']);
    clock += 5_500;
    const fresh = h.svc.workerThreads(pat, 'Triage', { limit: 1 });
    expect(fresh.ok && fresh.threads).toEqual([]);
  });

  it('reuses a first page asked for again within a moment, then builds it afresh', () => {
    const runs = [run('r1', { kind: 'running', currentStepId: 'compare' } as FlowRun['state'], 3_000)];
    const h = harness(runs);
    let clock = 10_000;
    (h.svc as unknown as { deps: { now?: () => number } }).deps.now = () => clock;
    const ids = () => {
      const t = h.svc.workerThreads(pat, 'Triage');
      if (!t.ok) throw new Error(t.error);
      return t.threads.map((x) => x.id);
    };
    expect(ids()).toEqual(['run:r1']);
    // A run starts outside this service: a poll a moment later still reads the last build,
    runs.push(run('r2', { kind: 'running', currentStepId: 'capture' } as FlowRun['state'], 4_000));
    clock += 3_200;
    expect(ids()).toEqual(['run:r1']);
    // while another caller's first look builds their own.
    expect(h.svc.workerThreads(admin, 'Triage')).toMatchObject({ ok: true, total: 2 });
    // Past the moment, it shows.
    clock += 2_000;
    expect(ids()).toEqual(['run:r2', 'run:r1']);
  });

  it('shows an ask made through here at once, however soon after the last page', async () => {
    const h = harness();
    (h.svc as unknown as { deps: { now?: () => number } }).deps.now = () => 10_000;
    const before = h.svc.workerThreads(pat, 'Triage');
    expect(before.ok && before.threads).toEqual([]);
    const asked = h.svc.startAsk(pat, 'Triage', 'how are acme signups this week', 'console');
    if (!asked.ok) throw new Error(asked.error);
    await asked.done;
    const after = h.svc.workerThreads(pat, 'Triage');
    expect(after.ok && after.threads.map((t) => t.prompt)).toEqual(['how are acme signups this week']);
  });
});

describe('replying in a thread', () => {
  it('quotes what the reply answers to the worker, keeps the thread, and keeps its one-tap answers', async () => {
    const h = harness();
    const sent: string[] = [];
    const deps = (h.svc as unknown as { deps: { workers: { runErrand: unknown } } }).deps;
    deps.workers.runErrand = async (_id: string, text: string) => {
      sent.push(text);
      return { ok: true, result: { orchestrationId: 'o', count: 0, queued: 0, launchedNothing: true, reply: sent.length === 1 ? 'Introw sells co-selling. Track it?' : 'Will do.', choices: ['Yes, track Introw'] } };
    };
    const first = h.svc.startAsk(pat, 'Triage', 'do you know introw', 'console');
    if (!first.ok) throw new Error(first.error);
    await first.done;
    const second = h.svc.startAsk(pat, 'Triage', 'Yes, track Introw', 'console', undefined, `ask:${first.askId}`);
    if (!second.ok) throw new Error(second.error);
    await second.done;
    expect(sent[1]).toContain('I asked: "do you know introw"');
    expect(sent[1]).toContain('You answered: "Introw sells co-selling. Track it?"');
    expect(sent[1]).toMatch(/My reply: Yes, track Introw$/);
    const t = h.svc.workerThreads(pat, 'Triage');
    if (!t.ok) throw new Error(t.error);
    expect(t.threads).toHaveLength(1);
    expect(t.threads[0]).toMatchObject({ choices: ['Yes, track Introw'], followUps: [{ prompt: 'Yes, track Introw', stage: 'answered' }] });
    // A thread id that isn't one is ignored rather than quoted.
    const odd = h.svc.startAsk(pat, 'Triage', 'hi', 'console', undefined, '../../etc');
    if (odd.ok) await odd.done;
    expect(sent[2]).toBe('hi');
  });
});

describe('a worker deciding what to do', () => {
  it('says so on its page and in the roster, before any run exists', () => {
    const h = harness();
    const deps = (h.svc as unknown as { deps: { planning?: (id: string) => unknown } }).deps;
    deps.planning = () => ({ since: 5_000, task: 'shift' });
    const d = h.svc.workerDetail(pat, 'Triage');
    if (!d.ok) throw new Error(d.error);
    expect(d.deciding).toEqual({ since: 5_000, task: 'shift' });
    expect(h.svc.listWorkers(pat).find((w) => w.name === 'Triage')?.state).toBe('working');
    deps.planning = () => null;
    const after = h.svc.workerDetail(pat, 'Triage');
    expect(after.ok && after.deciding).toBeNull();
  });
});

describe('workspaces in the org', () => {
  it('lets admins make one, points a worker at it with one flow, and keeps it while someone works there', async () => {
    const h = harness();
    await h.svc.connectRepo(admin, { url: 'https://github.com/acme/app' });
    expect(h.svc.createWorkspace(pat, { name: 'Shop', repos: ['app', 'api'] }).ok).toBe(false);
    expect(h.svc.createWorkspace(admin, { name: 'Shop', repos: ['app', 'api'] })).toMatchObject({ ok: true, workspace: { id: 'ws-shop' } });
    expect(h.svc.letWorkOnRepo(pat, 'Triage', 'app')).toMatchObject({ ok: true, flow: 'org-pr-app' });
    expect(h.svc.letWorkOnRepo(pat, 'Triage', 'shop')).toEqual({ ok: true, worker: 'Triage', flow: 'org-pr-ws-shop' });
    // One place at a time: the repo's flow goes when it moves to the workspace.
    expect(h.roster.get('triage')).toMatchObject({ projectPath: '/data/workspaces/ws-shop', flowIds: ['triage-flow', 'org-pr-ws-shop'], preferredFlowId: 'org-pr-ws-shop' });
    expect(h.svc.repoList(pat)).toMatchObject({ ok: true, workspaces: [{ name: 'Shop', workers: ['Triage'] }] });
    expect(h.svc.removeWorkspace(admin, 'Shop')).toMatchObject({ ok: false, error: expect.stringContaining('Triage works there') });
  });
});

describe("a team task's code", () => {
  it('pushes the branch from each repo it changed, for whoever asked', () => {
    const task = {
      id: 'task-1', teamId: 't', teamName: 'Shop crew', brief: 'Add prices', status: 'done', stages: [], stageIndex: 0, spentUSD: 1, budgetUSD: 40, updatedAt: 0,
      requestedBy: { name: 'Pat', slackUserId: PAT },
      code: { branch: 'team/add-prices', repos: [
        { name: 'app', projectPath: '/data/repos/app', base: 'main', worktreePath: '/w/app', ahead: 2 },
        { name: 'api', projectPath: '/data/repos/api', base: 'main', worktreePath: '/w/api', ahead: 0 },
      ] },
    };
    const pushed: string[] = [];
    const h = harnessWithTeams([task], (taskId, projectPath) => {
      pushed.push(projectPath);
      return { ok: true, message: 'Pushed.', url: 'https://github.com/acme/app/pull/new/team/add-prices' };
    });
    expect(h.svc.pushTeamCode(sam, 'task-1').ok).toBe(false);
    expect(h.svc.pushTeamCode(pat, 'task-1')).toEqual({ ok: true, pushed: [{ repo: 'app', url: 'https://github.com/acme/app/pull/new/team/add-prices' }], failed: [] });
    expect(pushed).toEqual(['/data/repos/app']);
  });

  it('lets an admin push a task someone else asked for from Slack', () => {
    const task = {
      id: 'task-2', teamId: 't', teamName: 'Shop crew', brief: 'Add tax', status: 'done', stages: [], stageIndex: 0, spentUSD: 1, budgetUSD: 40, updatedAt: 0,
      requestedBy: { name: 'Pat', slackUserId: PAT },
      code: { branch: 'team/add-tax', repos: [{ name: 'app', projectPath: '/data/repos/app', base: 'main', worktreePath: '/w/app', ahead: 1 }] },
    };
    const h = harnessWithTeams([task], () => ({ ok: true, message: 'Pushed.' }));
    expect(h.svc.pushTeamCode(sam, 'task-2').ok).toBe(false);
    expect(h.svc.pushTeamCode(admin, 'task-2').ok).toBe(true);
  });
});

describe('a team task asked for from the console', () => {
  it('waits on whoever asked even with no Slack id, and an admin can steer it', () => {
    const task = { id: 'task-2', teamId: 't', teamName: 'Council', brief: 'Rank the roadmap', status: 'proposed', planNote: 'Score, then rank.', stages: [], stageIndex: 0, spentUSD: 0, budgetUSD: 40, updatedAt: 0, requestedBy: { name: 'Me' } };
    const h = harnessWithTeams([task], () => ({ ok: true, message: '' }));
    const me: OrgCaller = { name: 'Me', admin: true };
    const other: OrgCaller = { name: 'Sam', admin: false };
    const summarize = (c: OrgCaller) => (h.svc as unknown as { summarizeTask: (t: unknown, c: OrgCaller, r: unknown[]) => { waitingOnYou: boolean; needs?: string } }).summarizeTask(task, c, []);
    expect(summarize(me)).toMatchObject({ waitingOnYou: true, needs: 'plan' });
    expect(summarize(other).waitingOnYou).toBe(false);
    expect(h.svc.decideTeamTask(other, 'task-2', { kind: 'approve' }).ok).toBe(false);
  });
});

describe('a team page', () => {
  it('shows who is on it, each piece of the live stage, what waits on you, and its files', () => {
    const run = { id: 'r1', workerId: 'triage', workerName: 'Triage', flowSnapshot: { name: 'p', steps: [{ id: 'read' }, { id: 'score' }] }, userPrompt: 'x', state: { kind: 'running', currentStepId: 'score' }, createdAt: 1_000, attempts: [], artifacts: {}, costUSD: 0.2 } as unknown as FlowRun;
    const task = {
      id: 'task-3', teamId: 'team-1', teamName: 'Council', brief: 'Rank the roadmap', title: 'Roadmap ranking', status: 'running', createdAt: 500, updatedAt: 2_000, stageIndex: 0, spentUSD: 0.2, budgetUSD: 40, folder: '/f',
      requestedBy: { name: 'Pat', slackUserId: PAT },
      files: [{ name: 'pieces/triage.md', author: 'Triage', at: 1_500 }],
      stages: [
        { kind: 'contribute', title: 'Score it', status: 'running', assignments: [{ workerId: 'triage', workerName: 'Triage', ask: 'Score each item for delivery risk. Use the tracker.', status: 'running', runId: 'r1' }] },
        { kind: 'synthesize', title: 'Write it up', status: 'pending', assignments: [] },
      ],
    };
    const h = harness([run]);
    const svc = h.svc as unknown as { deps: { teams: unknown } };
    svc.deps.teams = {
      list: () => ({ teams: [{ id: 'team-1', name: 'Council', purpose: 'Rank things', budgetUSDPerTask: 40, members: [{ workerId: 'triage', role: 'delivery' }] }], tasks: [task] }),
      readFile: (_id: string, name: string) => (name === 'pieces/triage.md' ? { ok: true, body: '# Scores' } : { ok: false, error: 'No such file in this task.' }),
    };
    const page = h.svc.teamPage(pat, 'council');
    if (!page.ok) throw new Error(page.error);
    expect(page.team.members).toEqual([{ workerId: 'triage', name: 'Triage', role: 'delivery', state: 'working', doing: 'Score it: Score each item for delivery risk.' }]);
    expect(page.tasks[0].stagesDetail[0]).toMatchObject({ current: true, pieces: [{ workerName: 'Triage', step: { index: 2, total: 2, name: 'score' }, costUSD: 0.2 }] });
    expect(page.now).toEqual({ sentence: 'Triage is on stage 1 of 2, contribute, of "Roadmap ranking".', taskId: 'task-3', waitingOnYou: false });
    expect(h.svc.teamTaskFile(pat, 'task-3', 'pieces/triage.md')).toEqual({ ok: true, name: 'pieces/triage.md', body: '# Scores' });
    expect(h.svc.teamTaskFile(sam, 'task-3', 'pieces/triage.md').ok).toBe(false);
    expect(h.svc.teamPage(sam, 'council').ok).toBe(false);
  });
});

describe('a setup published from a desktop', () => {
  const tracker = { name: 'tracker', kind: 'command' as const, command: 'npx', args: ['@acme/tracker-mcp'], envKeys: ['TRACKER_TOKEN'], headerKeys: [] };
  const withTools = () => {
    const h = harness();
    const installed: Array<{ name: string; env?: Record<string, string> }> = [];
    (h.svc as unknown as { deps: { tools: unknown } }).deps.tools = {
      list: () => ({ tools: installed.map((t) => ({ name: t.name, kind: 'command', target: 'npx', secrets: [], usedBy: [] })), missing: [] }),
      remember: () => {},
      install: (input: { name: string; env?: Record<string, string> }) => {
        installed.push(input);
        return { ok: true };
      },
      uninstall: () => ({ ok: true }),
      check: async () => null,
    };
    return { ...h, installed };
  };
  const input = { tools: [tracker], repos: [{ name: 'app', url: 'https://github.com/acme/app' }], workspaces: [{ name: 'Shop', repos: ['app'] }] };

  it('becomes a checklist for an admin, one per person, with nothing secret in it', async () => {
    const h = withTools();
    expect(h.svc.publishSetup(pat, input, false)).toEqual({ ok: true, installed: [], offered: { tools: 1, repos: 1, workspaces: 1 } });
    expect(h.svc.setupOffers(pat).ok).toBe(false);
    const list = h.svc.setupOffers(admin);
    if (!list.ok) throw new Error(list.error);
    expect(list.offers).toMatchObject([{ by: 'Pat', tools: [{ name: 'tracker', installed: false }], repos: [{ name: 'app', connected: false }], workspaces: [{ name: 'Shop', made: false }] }]);
    // Without the host's token, the row says which one it needs.
    const deps = (h.svc as unknown as { deps: { repos: { canPush: unknown; tokenFor: unknown } } }).deps;
    deps.repos.canPush = () => false;
    deps.repos.tokenFor = () => 'GH_TOKEN';
    const needy = h.svc.setupOffers(admin);
    expect(needy.ok && needy.offers[0].repos[0]).toMatchObject({ name: 'app', needsToken: 'GH_TOKEN' });
    deps.repos.canPush = () => true;
    deps.repos.tokenFor = () => null;
    // Publishing again replaces Pat's, rather than piling up.
    h.svc.publishSetup(pat, { ...input, repos: [] }, false);
    const again = h.svc.setupOffers(admin);
    expect(again.ok && again.offers.length).toBe(1);
    expect(again.ok && again.offers[0].repos).toEqual([]);
    expect(again.ok && h.svc.dismissSetupOffer(admin, again.offers[0].id)).toEqual({ ok: true });
  });

  it('takes keys only from an admin, only over a private channel, only for the names a tool uses', () => {
    const h = withTools();
    const keys = { tracker: { env: { TRACKER_TOKEN: 'tk-secret' } } };
    expect(h.svc.publishSetup(admin, { ...input, keys }, false)).toMatchObject({ ok: false, error: expect.stringContaining('https') });
    expect(h.svc.publishSetup(pat, { ...input, keys }, true)).toMatchObject({ ok: false, error: expect.stringContaining('Only an admin') });
    expect(h.svc.publishSetup(admin, { ...input, keys: { tracker: { env: { AWS_SECRET_ACCESS_KEY: 'x' } } } }, true)).toMatchObject({ ok: false, error: expect.stringContaining("doesn't use") });
    expect(h.installed).toEqual([]);
    expect(h.svc.publishSetup(admin, { ...input, keys }, true)).toMatchObject({ ok: true, installed: ['tracker'] });
    expect(h.installed[0]).toMatchObject({ name: 'tracker', env: { TRACKER_TOKEN: 'tk-secret' } });
    expect(h.audit.join(' ')).toContain('Sent the keys for tracker from their desktop (TRACKER_TOKEN)');
    expect(h.audit.join(' ')).not.toContain('tk-secret');
    const list = h.svc.setupOffers(admin);
    expect(list.ok && list.offers[0]).toMatchObject({ installed: ['tracker'], tools: [{ installed: true }] });
    expect(JSON.stringify(list)).not.toContain('tk-secret');
  });
});

describe('reading a Library item in full', () => {
  it('carries a preview in the list and the whole report when opened', () => {
    const long = `# Scores\n\n${'| R01 | Distribution IQ | 4 |\n'.repeat(400)}`;
    const run = { id: 'r1', workerId: 'triage', workerName: 'Triage', flowSnapshot: { name: 'p', steps: [{ id: 'score' }] }, userPrompt: 'Score it', state: { kind: 'done', success: true }, createdAt: 1_000, attempts: [], artifacts: { 'scores.md': { name: 'scores.md', kind: 'text', body: long, producedByStepId: 'score', producedAt: 2_000 } } } as unknown as FlowRun;
    const h = harness([run]);
    const item = h.svc.library(pat).find((x) => x.runId === 'r1');
    expect(item?.body?.length).toBe(6000);
    const full = h.svc.libraryItem(pat, item!.id);
    expect(full.ok && full.item.body).toBe(long);
    expect(h.svc.libraryItem(sam, item!.id).ok).toBe(false);
  });
});

describe('what is moving right now', () => {
  it('lists runs, a worker deciding, a run waiting on someone, and a team task — only what the caller can see', () => {
    const run = (id: string, state: unknown, at: number) =>
      ({ id, workerId: 'triage', workerName: 'Triage', flowSnapshot: { name: 'p', steps: [{ id: 'read' }, { id: 'compare' }] }, userPrompt: `Check ${id}`, state, createdAt: at, attempts: [], artifacts: {} }) as unknown as FlowRun;
    const h = harness([run('r1', { kind: 'running', currentStepId: 'compare' }, 2_000), run('r2', { kind: 'paused', nextStepId: 'read', reason: 'externalAction' }, 1_000), run('r3', { kind: 'done', success: true }, 500)]);
    const deps = (h.svc as unknown as { deps: { planning?: unknown } }).deps;
    deps.planning = () => ({ since: 3_000, task: 'shift', manual: true });
    const items = h.svc.workingNow(pat);
    expect(items.map((x) => [x.kind, x.title, x.detail])).toEqual([
      ['deciding', 'Deciding what to work on', 'Run now'],
      ['run', 'Check r1', 'step 2 of 2, compare'],
      ['waiting', 'Check r2', 'wants an OK · step 1 of 2, read'],
    ]);
    expect(h.svc.workingNow(sam)).toEqual([]);
  });
});

describe('watching a run', () => {
  it('shows where it is and what it did, to whoever can see its worker', () => {
    const run = { id: 'r1', workerId: 'triage', workerName: 'Triage', flowSnapshot: { name: 'p', steps: [{ id: 'read' }, { id: 'compare' }] }, userPrompt: 'Check it', state: { kind: 'running', currentStepId: 'compare' }, createdAt: 1_000, attempts: [], artifacts: {} } as unknown as FlowRun;
    const h = harness([run]);
    (h.svc as unknown as { deps: { runActivity: unknown } }).deps.runActivity = (_id: string, after: number) => [{ at: 2_000, kind: 'tool', text: 'Read SCORING.md' }].filter((x) => x.at > after);
    const live = h.svc.runLive(pat, 'r1');
    expect(live).toMatchObject({ ok: true, run: { title: 'Check it', state: 'running', step: { index: 2, total: 2, name: 'compare' } }, activity: [{ text: 'Read SCORING.md' }] });
    expect(h.svc.runLive(pat, 'r1', 2_000)).toMatchObject({ ok: true, activity: [] });
    expect(h.svc.runLive(sam, 'r1').ok).toBe(false);
  });
});

describe('trust and acting outside', () => {
  it('lets a worker on its own act outside without asking, and takes that back when it moves down', () => {
    const h = harness();
    (h.svc as unknown as { deps: { setTrust: unknown } }).deps.setTrust = (id: string, trust: string) => {
      const w = h.roster.get(id)!;
      h.roster.set(id, { ...w, trust: trust as Worker['trust'] });
      return { ok: true };
    };
    expect(h.svc.setTrust(admin, 'Triage', 'autonomous').ok).toBe(true);
    expect(h.roster.get('triage')?.caps.allowExternalActions).toBe(true);
    expect(h.svc.setTrust(admin, 'Triage', 'trusted').ok).toBe(true);
    expect(h.roster.get('triage')?.caps.allowExternalActions).toBeUndefined();
  });
});

describe('tools for every worker', () => {
  it('says who can use each, and lists a shared tool on every worker', () => {
    const h = harness();
    const deps = h.svc as unknown as { deps: { policy: () => unknown; tools: unknown } };
    deps.deps.policy = () => ({ ...DEFAULT_ORG_POLICY, hirers: '*', allowedMcpServers: ['tickets'], sharedMcpServers: ['docs'] });
    deps.deps.tools = {
      list: () => ({ tools: ['docs', 'tickets', 'crm'].map((name) => ({ name, kind: 'http', target: 'https://x.test', secrets: [], usedBy: [] })), missing: [] }),
      install: () => ({ ok: true }),
      uninstall: () => ({ ok: true }),
      check: async () => null,
    };
    const t = h.svc.tools(admin);
    expect(t.ok && t.tools.map((x) => [x.name, x.access])).toEqual([['docs', 'everyone'], ['tickets', 'managers'], ['crm', 'picked']]);
    // A manager sees the shared one even though no worker of theirs lists it.
    const mine = h.svc.tools(pat);
    expect(mine.ok && mine.tools.map((x) => x.name)).toEqual(['docs']);
    expect(h.svc.listWorkers(pat).find((w) => w.name === 'Triage')?.tools).toEqual([{ name: 'docs', ok: true, shared: true }]);
    // A manager may give the one any hire may have.
    expect(h.svc.update(pat, 'Triage', { mcpServers: ['tickets'] }).ok).toBe(true);
  });
});

describe("giving a worker a tool", () => {
  it('gives a worker with a tracker its "Ticket actions" flow, after its own', () => {
    const h = harness();
    expect(h.svc.update(admin, 'Triage', { mcpServers: ['atlassian'] }).ok).toBe(true);
    expect(h.roster.get('triage')?.flowIds).toEqual(['triage-flow', 'org-ticket-actions-atlassian']);
    expect(h.flows).toContain('org-ticket-actions-atlassian');
    expect(h.svc.update(admin, 'Triage', { budgetUSDPerMonth: 40 }).ok).toBe(true);
    expect(h.roster.get('triage')?.flowIds.filter((x) => x.startsWith('org-ticket-'))).toHaveLength(1);
  });

  it('lets a manager give tools the org allows any hire, and leaves the rest to an admin', () => {
    const h = harness();
    expect(h.svc.update(pat, 'Triage', { mcpServers: ['tracker'] })).toMatchObject({ ok: false, error: expect.stringContaining('needs an admin') });
    expect(h.svc.update(admin, 'Triage', { mcpServers: ['tracker'] }).ok).toBe(true);
    expect(h.roster.get('triage')?.mcpServers).toEqual(['tracker']);
    // Taking one away is the manager's call too.
    expect(h.svc.update(pat, 'Triage', { mcpServers: [] }).ok).toBe(true);
    expect(h.roster.get('triage')?.mcpServers).toBeUndefined();
    expect(h.svc.update(admin, 'Triage', { mcpServers: ['bad name'] }).ok).toBe(false);
  });
});

function harnessWithTeams(tasks: unknown[], pushCode: (taskId: string, projectPath: string) => { ok: true; message: string; url?: string }) {
  const h = harness();
  const svc = h.svc as unknown as { deps: { teams: unknown } };
  svc.deps.teams = {
    list: () => ({ teams: [], tasks }),
    brief: () => ({ ok: false, error: 'no' }),
    answer: () => ({ ok: true }),
    approve: () => ({ ok: true }),
    revise: () => ({ ok: true }),
    continueTask: () => ({ ok: true }),
    cancel: () => ({ ok: true }),
    pushCode,
  };
  return h;
}

describe("a worker's shifts", () => {
  it('say what each decided and why, with the runs it started, a page at a time', () => {
    const h = harness();
    const journal = [
      { id: 's1', workerId: 'triage', kind: 'shift', at: 1_000, title: 'Shift 1', orchestrationId: 'b1' },
      { id: 's2', workerId: 'triage', kind: 'shift', at: 2_000, title: 'Shift 2', note: 'Nothing worth proposing this shift.', orchestrationId: 'b2' },
      { id: 's3', workerId: 'triage', kind: 'shift', at: 3_000, title: 'Shift 3', orchestrationId: 'b3' },
    ];
    const batches: Record<string, unknown> = {
      b1: { items: [{ status: 'done', runId: 'r1' }], producer: { reply: 'Checking pricing. <candidates>[{}]</candidates>' } },
      b2: { items: [], producer: { reply: '**Too soon:** ran an hour ago.\n<candidates>[]</candidates>' } },
      b3: { items: [{ status: 'proposed' }] },
    };
    const deps = (h.svc as unknown as { deps: { workers: { journalFor: unknown }; orchestration: unknown } }).deps;
    deps.workers.journalFor = () => journal;
    deps.orchestration = (id: string) => batches[id] ?? null;
    const page = h.svc.workerShifts(pat, 'Triage', { limit: 2 });
    expect(page).toMatchObject({ ok: true, total: 3, nextBefore: 2_000 });
    if (!page.ok) return;
    expect(page.shifts.map((x) => [x.title, x.decision, x.waiting])).toEqual([['Shift 3', 'proposed', 1], ['Shift 2', 'nothing', 0]]);
    expect(page.shifts[1].reasoning).toBe('**Too soon:** ran an hour ago.');
    expect(h.svc.workerShifts(pat, 'Triage', { before: 2_000 })).toMatchObject({ ok: true, shifts: [{ title: 'Shift 1', decision: 'started', runIds: ['r1'] }] });
    expect(h.svc.workerShifts(pat, 'Triage', { decision: 'nothing' })).toMatchObject({ ok: true, total: 1 });
    const feed = h.svc.workerFeed(pat, 'Triage', { before: 4_000, days: 1 });
    expect(feed.ok && feed.shifts.map((x) => x.title)).toEqual(['Shift 3', 'Shift 2', 'Shift 1']);
  });
});
