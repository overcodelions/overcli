// The org MCP tools a chat in the desktop app uses to triage and configure
// the org: run against a real OrgService, so each tool is shown to go
// through the same permission checks as the console.

import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FlowRun } from '../shared/flows/schema';
import type { Worker } from '../shared/flows/worker';
import { DEFAULT_ORG_POLICY, type OrgCaller } from '../shared/org/policy';
import { OrgService, type OrgServiceDeps } from '../main/org/orgService';
import type { AuditEntry } from '../main/org/orgStores';
import type { PrWatchState } from '../main/org/prWatch';
import { registerOrgTools } from './orgMcpTools';

const PAT = 'U0ACMEPAT';
const SAM = 'U0ACMESAM';
const pat: OrgCaller = { slackUserId: PAT, name: 'Pat', admin: false };
const ada: OrgCaller = { slackUserId: 'U0ACMEADA', name: 'Ada', admin: true };
const NOW = new Date(2026, 10, 10, 12).getTime();
const HOUR = 3_600_000;

function worker(id: string, over: Partial<Worker> = {}): Worker {
  return {
    id,
    name: id[0].toUpperCase() + id.slice(1),
    jobDescription: 'Keeps the acme storefront tidy.',
    projectPath: `/repos/${id}`,
    cadence: null,
    trust: 'trusted',
    caps: { maxItemsPerShift: 1, runIn: 'worktree', allowExternalActions: false } as Worker['caps'],
    budgetUSDPerMonth: 20,
    heartbeatModel: 'sonnet',
    flowIds: ['f'],
    enabled: true,
    createdAt: 0,
    ...over,
  };
}

function flowRun(id: string, workerId: string, createdAt: number, over: Record<string, unknown> = {}): FlowRun {
  return {
    id,
    flowId: 'acme-fix',
    workerId,
    workerName: workerId,
    title: `Run ${id}`,
    flowSnapshot: { name: 'Fix a bug', steps: [{ id: 'plan', output: 'plan.md' }, { id: 'build' }] },
    state: { kind: 'done', success: true },
    attempts: [
      { stepId: 'plan', startedAt: createdAt, endedAt: createdAt + 4 * 60_000, outcome: 'success' },
      { stepId: 'build', startedAt: createdAt + 4 * 60_000, endedAt: createdAt + 10 * 60_000, outcome: 'success' },
    ],
    artifacts: {},
    userPrompt: 'Fix the acme checkout bug.',
    createdAt,
    ...over,
  } as unknown as FlowRun;
}

function artifact(name: string, body: string) {
  return { name, body, producedAt: NOW };
}

function setup(opts: { runs?: FlowRun[]; prWatch?: PrWatchState; errand?: OrgServiceDeps['workers']['runErrand'] } = {}) {
  const roster = [
    worker('mario', { manager: { name: 'Pat', slackUserId: PAT }, visibility: 'org', caps: { maxItemsPerShift: 2, runIn: 'worktree', allowExternalActions: false, continueOpenPrs: true, prAuthors: ['Pat'] } as Worker['caps'] }),
    worker('cal', { manager: { name: 'Sam', slackUserId: SAM }, visibility: 'private' }),
  ];
  const runs = opts.runs ?? [];
  const audit: AuditEntry[] = [];
  const deps: OrgServiceDeps = {
    workers: {
      roster: () => roster,
      get: (id) => roster.find((w) => w.id === id) ?? null,
      save: (w) => {
        const i = roster.findIndex((x) => x.id === w.id);
        if (i >= 0) roster[i] = w as Worker;
        return { ok: true, worker: w };
      },
      setEnabled: () => ({ ok: true }),
      remove: () => ({ ok: true }),
      runErrand: opts.errand ?? (async () => ({ ok: false, error: 'no' })),
      journalFor: () => [],
      spentThisMonth: () => new Map(),
      workerNames: () => roster.map((w) => w.name),
      remember: () => ({ ok: true }),
    },
    runs: { listRuns: () => runs, getRun: (id) => runs.find((r) => r.id === id) ?? null, steerRun: () => ({ ok: true }), resumeRun: () => ({ ok: true }) },
    rejectRun: () => ({ ok: true }),
    policy: () => ({ ...DEFAULT_ORG_POLICY, teams: { design: [SAM] } }),
    draft: async () => ({ ok: false, error: 'not in this test' }),
    saveHire: () => ({ ok: false, error: 'not in this test' }),
    hires: { list: () => [], save: () => {} },
    audit: { append: (e: AuditEntry) => audit.push(e), recent: () => [...audit].reverse(), all: () => audit } as unknown as OrgServiceDeps['audit'],
    repos: {
      list: () => [{ name: 'acme-shop', path: '/repos/mario', url: 'git@example.test:acme/acme-shop.git' }],
      workspaces: () => [],
    } as unknown as OrgServiceDeps['repos'],
    ...(opts.prWatch ? { prWatchState: () => opts.prWatch! } : {}),
    now: () => NOW,
  };
  return { org: new OrgService(deps), roster, audit };
}

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

async function connect(org: OrgService, caller: OrgCaller) {
  const server = new McpServer({ name: 'overgo', version: '1' });
  registerOrgTools(server, org, caller);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
  clients.push(client);
  return async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ text: string }>)[0].text;
    return res.isError ? { error: text } : (JSON.parse(text) as Record<string, any>);
  };
}

describe('update_worker', () => {
  it('lets a manager change the job and tagline, and says what changed', async () => {
    const { org, roster } = setup();
    const call = await connect(org, pat);
    const res = await call('update_worker', { worker: 'Mario', jobDescription: 'Fixes acme checkout bugs.', tagline: 'Checkout fixer' });
    expect(res).toEqual({ changed: ['jobDescription', 'tagline'], worker: 'Mario' });
    expect(roster[0].jobDescription).toBe('Fixes acme checkout bugs.');
  });

  it("keeps a manager from setting an admin's fields", async () => {
    const { org, roster } = setup();
    const call = await connect(org, pat);
    expect(await call('update_worker', { worker: 'Mario', anyoneMayStart: true })).toEqual({ error: expect.stringContaining('Only an admin') });
    expect(await call('update_worker', { worker: 'Mario', skipCheckpoints: true })).toEqual({ error: expect.stringContaining('Only an admin') });
    expect(await call('update_worker', { worker: 'Mario', startAudience: { people: [SAM] } })).toEqual({ error: expect.stringContaining('Only an admin') });
    expect(roster[0].caps.anyoneMayStart).toBeUndefined();
  });

  it("can't change a worker the caller can't see", async () => {
    const { org } = setup();
    const call = await connect(org, pat);
    expect(await call('update_worker', { worker: 'Cal', tagline: 'mine now' })).toHaveProperty('error');
  });

  it('lets an admin pick who starts work and who approves, checked as the console checks them', async () => {
    const { org, roster } = setup();
    const call = await connect(org, ada);
    expect(await call('update_worker', { worker: 'Mario', startAudience: { people: [SAM], groups: ['team:design'] }, approvers: { roles: ['admin'] } })).toMatchObject({ changed: ['startAudience', 'approvers'] });
    expect(roster[0].caps.startAudience).toEqual({ people: [SAM], groups: ['team:design'] });
    expect(roster[0].caps.approvers).toEqual({ roles: ['admin'] });
    expect(await call('update_worker', { worker: 'Mario', audience: { people: ['sam'] } })).toEqual({ error: 'People are picked by their Slack member id.' });
    expect(await call('update_worker', { worker: 'Mario' })).toEqual({ error: expect.stringContaining('Nothing to change') });
  });

  it('records the change as made from an overcli chat when the request said so', async () => {
    const { org, audit } = setup();
    const call = await connect(org, { ...ada, via: 'overcli chat' });
    await call('update_worker', { worker: 'Mario', continueOpenPrs: false });
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.every((e) => e.via === 'overcli chat' && e.by === 'Ada')).toBe(true);
  });
});

describe('find_people', () => {
  it('turns a name or a group into ids, without emails for someone who is not an admin', async () => {
    const { org } = setup();
    const call = await connect(org, pat);
    const res = await call('find_people', { query: 'sam' });
    expect(res.people).toEqual([expect.objectContaining({ name: 'Sam', slackUserId: SAM, groups: ['team:design'] })]);
    expect(res.people[0]).not.toHaveProperty('email');
    expect((await call('find_people', { query: 'design' })).groups).toEqual([{ id: 'team:design', name: 'design', members: 1 }]);
  });
});

describe('list_runs and get_run', () => {
  const plan = 'Plan: reproduce the acme checkout bug, then fix the rounding.';
  const runs = [
    flowRun('r-nothing', 'mario', NOW - 2 * HOUR, { artifacts: { 'plan.md': artifact('plan.md', plan) } }),
    flowRun('r-pushed', 'mario', NOW - HOUR, {
      artifacts: { 'plan.md': artifact('plan.md', 'x'.repeat(9000)), 'pull-requests.md': artifact('pull-requests.md', '- Opened a pull request for acme-shop') },
      continues: 'fix/acme-rounding',
      userPrompt: 'Fix it.\n\nCONFLICTS TO RESOLVE\nThis pull request no longer merges cleanly…',
    }),
    flowRun('r-waiting', 'mario', NOW - 10 * 60_000, { state: { kind: 'paused', reason: 'externalAction', nextStepId: 'build' } }),
    flowRun('r-private', 'cal', NOW - 30 * 60_000),
  ];

  it("lists the runs of workers the caller can see, and filters by state", async () => {
    const { org } = setup({ runs });
    const call = await connect(org, pat);
    expect((await call('list_runs', {})).runs.map((r: { runId: string }) => r.runId)).toEqual(['r-waiting', 'r-pushed', 'r-nothing']);
    expect((await call('list_runs', { state: 'paused' })).runs).toEqual([expect.objectContaining({ runId: 'r-waiting', worker: 'Mario', pausedFor: 'externalAction' })]);
    expect(await call('list_runs', { worker: 'Cal' })).toHaveProperty('error');
  });

  it('says when a run pushed nothing, and shows its plan', async () => {
    const { org } = setup({ runs });
    const call = await connect(org, pat);
    const res = await call('get_run', { runId: 'r-nothing' });
    expect(res.pushed).toContain('Nothing was pushed');
    expect(res.artifacts).toEqual([{ name: 'plan.md', text: plan }]);
    expect(res.steps).toEqual([
      { step: 'plan', status: 'success', minutes: 4 },
      { step: 'build', status: 'success', minutes: 6 },
    ]);
    expect(res.run).toMatchObject({ state: 'done', title: 'Run r-nothing' });
  });

  it('clips long text, says so, and says what a continued run was told', async () => {
    const { org } = setup({ runs });
    const call = await connect(org, pat);
    const res = await call('get_run', { worker: 'Mario', title: 'pushed' });
    expect(res.run.id).toBe('r-pushed');
    expect(res.artifacts[0]).toMatchObject({ name: 'plan.md', clipped: true, chars: 9000 });
    expect(res.artifacts[0].text.length).toBeLessThan(4100);
    expect(res).not.toHaveProperty('pushed');
    expect(res.continued).toEqual({ branch: 'fix/acme-rounding', toldOfConflicts: true, toldDefaultBranchMerged: false, toldWhyBuildFailed: false });
    expect(JSON.stringify(res)).not.toContain('Fix it.');
  });

  it("scrubs a credential a run printed before a chat reads it", async () => {
    process.env.ACME_DEPLOY_TOKEN = 'acme-live-0f9e8d7c6b5a4f3e2d1c';
    try {
      const leaky = [flowRun('r-leak', 'mario', NOW - HOUR, { artifacts: { 'plan.md': artifact('plan.md', 'Deploy with ACME_DEPLOY_TOKEN=acme-live-0f9e8d7c6b5a4f3e2d1c then check.') } })];
      const { org } = setup({ runs: leaky });
      const call = await connect(org, pat);
      const res = await call('get_run', { runId: 'r-leak' });
      expect(JSON.stringify(res)).not.toContain('acme-live-0f9e8d7c6b5a4f3e2d1c');
      expect(res.artifacts[0].text).toContain('Deploy with');
    } finally {
      delete process.env.ACME_DEPLOY_TOKEN;
    }
  });

  it("shows a paused run's reason, and none of a worker the caller can't see", async () => {
    const { org } = setup({ runs });
    const call = await connect(org, pat);
    expect((await call('get_run', { runId: 'r-waiting' })).run).toMatchObject({ state: 'paused', pausedFor: 'externalAction' });
    expect(await call('get_run', { runId: 'r-private' })).toEqual({ error: 'No run with that id that you can see.' });
  });
});

describe('pr_watch', () => {
  const prWatch: PrWatchState = {
    repos: {
      'acme-shop': {
        prs: {
          '1234': { head: 'abc', updatedAt: '', build: 'failed', comments: 3, pending: { failed: true, comments: 2 }, woken: [NOW - 2 * HOUR, NOW - 30 * HOUR], commentRounds: 1, activeAt: NOW - 5 * 60_000 },
          '1200': { head: 'def', updatedAt: '', build: 'passed', goneAt: NOW - HOUR, activeAt: NOW - 3 * HOUR },
        },
      },
      'acme-other': { prs: { '9': { head: 'x', updatedAt: '' } } },
    },
  };

  it("says what the watcher holds for the worker's repos, from its record", async () => {
    const { org } = setup({ prWatch });
    const call = await connect(org, pat);
    const res = await call('pr_watch', { worker: 'Mario' });
    expect(res).toMatchObject({ worker: 'Mario', looksAfterPullRequests: true, authors: ['Pat'], repos: ['acme-shop'], tracked: 1 });
    expect(res.pullRequests[0]).toEqual({
      repo: 'acme-shop',
      id: '1234',
      build: 'failed',
      comments: 3,
      waiting: { failed: true, comments: 2 },
      commentRounds: 1,
      wakesToday: 1,
      lastWokenAt: NOW - 2 * HOUR,
      lastActiveAt: NOW - 5 * 60_000,
    });
    expect(res.pullRequests[1]).toMatchObject({ id: '1200', goneAt: NOW - HOUR });
  });

  it("refuses a worker the caller can't see, and a server that doesn't watch", async () => {
    expect(await (await connect(setup({ prWatch }).org, pat))('pr_watch', { worker: 'Cal' })).toHaveProperty('error');
    expect(await (await connect(setup().org, pat))('pr_watch', { worker: 'Mario' })).toEqual({ error: 'Pull requests are not watched on this server.' });
  });
});

describe('tuning a worker from a chat', () => {
  it('offers the tuning tools, with reads marked read-only and changes not', async () => {
    const { org } = setup();
    const server = new McpServer({ name: 'overgo', version: '1' });
    registerOrgTools(server, org, pat);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(b);
    clients.push(client);
    const tools = new Map((await client.listTools()).tools.map((t) => [t.name, t.annotations?.readOnlyHint]));
    for (const read of ['worker_tuning', 'worker_flows', 'draft_flow_change', 'flow_trial']) expect(tools.get(read), read).toBe(true);
    for (const change of ['add_worker_note', 'save_flow_change', 'try_flow_change']) expect(tools.get(change), change).toBe(false);
  });

  it('adds a note for a worker the caller manages, and not for one they don’t', async () => {
    const { org } = setup();
    const call = await connect(org, pat);
    expect(await call('add_worker_note', { worker: 'Mario', note: 'The acme checkout lives in the payments repo.' })).toEqual({ added: 'The acme checkout lives in the payments repo.', worker: 'Mario' });
    expect(await call('add_worker_note', { worker: 'Cal', note: 'mine now' })).toHaveProperty('error');
  });
});

describe('following up on a question', () => {
  function asking() {
    const prompts: string[] = [];
    const { org } = setup({
      errand: async (_id, text) => {
        prompts.push(text);
        return { ok: true, result: { orchestrationId: 'o', count: 0, queued: 0, launchedNothing: true, reply: `Answer ${prompts.length}.` } as never };
      },
    });
    return { org, prompts };
  }

  it('lists what you asked, newest first, so a lost askId can be found instead of asking again', async () => {
    const { org } = asking();
    const call = await connect(org, pat);
    const first = await call('ask_worker', { worker: 'Mario', message: 'Which acme orders failed today?' });
    expect(first).toMatchObject({ reply: 'Answer 1.' });
    const res = await call('my_asks', { worker: 'Mario' });
    expect(res.asks).toEqual([expect.objectContaining({ askId: first.askId, worker: 'Mario', asked: 'Which acme orders failed today?', status: 'answered', reply: 'Answer 1.' })]);
    expect(await (await connect(org, ada))('my_asks', {})).toEqual({ asks: [] });
  });

  it('carries on from an earlier answer, to the same worker, quoting it', async () => {
    const { org, prompts } = asking();
    const call = await connect(org, pat);
    const first = await call('ask_worker', { worker: 'Mario', message: 'Which acme orders failed today?' });
    const next = await call('ask_worker', { followUpOn: first.askId, message: 'Retry the second one.' });
    expect(next).toMatchObject({ reply: 'Answer 2.' });
    expect(prompts[1]).toContain('I asked: "Which acme orders failed today?"');
    expect(prompts[1]).toContain('You answered: "Answer 1."');
    expect(prompts[1]).toContain('Retry the second one.');
    const listed = await call('my_asks', {});
    expect(listed.asks[0]).toMatchObject({ askId: next.askId, followUpOn: first.askId });
  });

  it('will not follow up on a question you cannot see, or send it to another worker', async () => {
    const { org } = asking();
    const call = await connect(org, pat);
    const first = await call('ask_worker', { worker: 'Mario', message: 'Which acme orders failed today?' });
    expect(await (await connect(org, { slackUserId: SAM, name: 'Sam', admin: false }))('ask_worker', { followUpOn: first.askId, message: 'and?' })).toMatchObject({ error: expect.stringContaining('No question') });
    expect(await call('ask_worker', { message: 'and?' })).toMatchObject({ error: expect.stringContaining('which worker') });
  });
});
