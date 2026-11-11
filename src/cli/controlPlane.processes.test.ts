import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createControlPlane, listenControlPlane } from './controlPlane';
import { ProcessService } from '../main/org/processes';
import { TriggerService, type Deliverable, type WorkerTrigger } from '../main/org/triggers';
import type { OrgCaller } from '../shared/org/policy';
import type { ProcessState } from '../shared/org/process';
import { parseIdea } from '../main/slack/processSlack';
import { buildPeopleDirectory } from '../main/org/peopleDirectory';

const PAT: OrgCaller = { name: 'Pat', slackUserId: 'U0ACMEPAT', admin: false };
const RILEY: OrgCaller = { name: 'Riley', slackUserId: 'U0ACMERILEY', admin: false };

describe('process routes', () => {
  let server: http.Server;
  let base: string;
  let state: ProcessState = { processes: [], items: [] };
  let triggers: WorkerTrigger[] = [];
  let deliverables: Deliverable[] = [];
  const briefs: string[] = [];
  const processes = new ProcessService({
    store: { load: () => structuredClone(state), save: (s) => (state = structuredClone(s)) },
    teams: () => [{ id: 't-product', name: 'Product', owner: { name: 'Dana', slackUserId: 'U0ACMEDANA' } }],
    task: () => ({ status: 'planning' }),
    brief: (_teamId, text) => {
      briefs.push(text);
      return { ok: true, taskId: `task-${briefs.length}` };
    },
    isAdmin: (c) => c.admin,
    log: () => {},
  });
  const triggerSvc = new TriggerService({
    store: { list: () => structuredClone(triggers), save: (all) => (triggers = structuredClone(all)) },
    deliverables: { list: () => structuredClone(deliverables), save: (all) => (deliverables = structuredClone(all)) },
    worker: () => null,
    ask: () => ({ ok: false, error: 'no workers here' }),
    handTo: (hand, ev) => {
      if (hand.kind !== 'process') return { ok: false, error: 'teams not in this test' };
      const res = processes.submit({ name: ev.triggerName }, hand.processId, { title: ev.title, brief: ev.text, source: 'trigger' });
      return res.ok ? { ok: true, label: res.process.name } : res;
    },
    toolConfig: () => null,
    callTool: async () => ({ ok: false, error: 'none' }),
    log: () => {},
  });
  const org = {
    publishedTeamId: (local: string) => (local === 'desk-team-1' ? 't-product' : undefined),
    workingNow: () => [{ kind: 'deciding', id: 'deciding:w-tri', at: 2, title: 'Working out how to answer', detail: 'a question', workerId: 'w-tri', workerName: 'Triage' }, { kind: 'run', id: 'run:r1', at: 1, title: 'Weekly site audit', detail: 'step 2 of 3, crawl pages', workerId: 'w-owen', workerName: 'Owen' }],
    runningNow: () => [{ workerId: 'w-owen', workerName: 'Owen', run: { runId: 'r1', title: 'Weekly site audit', startedAt: 1, step: { index: 2, total: 3, name: 'crawl-pages' }, finished: ['plan'], state: 'working' } }],
    teamTasks: () => [],
    teams: () => [{ id: 't-product', name: 'Product' }],
    spendView: (c: OrgCaller, opts: { all?: boolean }) => ({ ok: true, who: c.name, all: !!opts.all }),
    stopTeamWork: (c: OrgCaller, id: string) => ({ ok: true, who: c.name, id }),
    library: (_c: OrgCaller, opts: { documents?: boolean; kind?: string }) => [{ documents: !!opts.documents, kind: opts.kind ?? null }],
    listWorkers: () => [],
    directory: () => ({ people: [{ name: 'Sam', slackUserId: 'U0ACMESAM' }], groups: [] }),
    peopleDirectory: (slack: Array<{ id: string; name: string; handle?: string }>) => buildPeopleDirectory({ seen: [{ name: 'Sam', slackUserId: 'U0ACMESAM' }], slack }),
    repoList: () => ({ ok: true, repos: [{ name: 'acme-repo', path: '/x' }], workspaces: [] }),
    teamPage: (c: OrgCaller) => ({ ok: true, team: { id: 't-product', name: 'Product', budgetUSDPerTask: 50, canChange: c === PAT, checkpoints: { askFirst: true, finalReview: true }, members: [{ name: 'Lena', role: 'Writes' }] } }),
  };
  const as = (who: OrgCaller) => ({ Authorization: `Bearer ${who === PAT ? 'ocli_pat' : 'ocli_riley'}`, 'Content-Type': 'application/json' });
  const call = async (who: OrgCaller, method: string, p: string, body?: unknown) =>
    (await fetch(`${base}${p}`, { method, headers: as(who), ...(body ? { body: JSON.stringify(body) } : {}) })).json() as Promise<Record<string, any>>;

  beforeAll(async () => {
    server = createControlPlane({
      org: org as never,
      processes,
      triggers: triggerSvc,
      slackPeople: async () => [{ id: 'U0ACMESAM', name: 'Sam', handle: 'sam' }, { id: 'U0ACMEHOLLY', name: 'Holly Ng', handle: 'holly' }],
      log: () => {},
      authenticate: (t) => (t === 'ocli_pat' ? PAT : t === 'ocli_riley' ? RILEY : null),
    });
    await listenControlPlane(server, { host: '127.0.0.1', port: 0 });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  describe('as a YAML file', () => {
    // Named to sort last: other tests here read the first process listed.
    const FILE = 'name: Zed from a file\naccess: everyone\nstages:\n  - name: Write\n    team: Product\n  - name: Decide\n    decide: [Sam]\n    send_back_to: Write\n';

    it('reads one without saving anything, and flags what it can’t match', async () => {
      const before = state.processes.length;
      const read = await call(PAT, 'POST', '/api/processes/from-yaml', { yaml: `${FILE}  - name: Extra\n    team: Nobody\n` });
      expect(read).toMatchObject({ ok: true, draft: { name: 'Zed from a file', stages: [{ kind: 'team', teamId: 't-product' }, { kind: 'people', approvers: [{ name: 'Sam', slackUserId: 'U0ACMESAM' }] }, { name: 'Extra' }] } });
      expect(read.notes.join(' ')).toContain('no team called Nobody');
      expect(state.processes).toHaveLength(before);
      expect(await call(PAT, 'POST', '/api/processes/from-yaml', { yaml: 'name: [' })).toMatchObject({ ok: false, error: expect.stringContaining('valid YAML') });
    });

    it('saves what it read, comes back out the same, and keeps stage ids on the way back in', async () => {
      const read = await call(PAT, 'POST', '/api/processes/from-yaml', { yaml: FILE });
      const made = await call(PAT, 'POST', '/api/processes', read.draft);
      expect(made).toMatchObject({ ok: true, process: { name: 'Zed from a file', access: { who: 'everyone' } } });
      const out = await call(PAT, 'GET', `/api/processes/${made.process.id}/yaml`);
      expect(out.yaml).toContain('team: Product');
      expect(out.yaml).toContain('send_back_to: Write');
      expect(out.yaml).not.toContain('t-product');
      const back = await call(PAT, 'POST', '/api/processes/from-yaml', { yaml: out.yaml, processId: made.process.id });
      expect(back.draft.stages.map((s: { id: string }) => s.id)).toEqual(made.process.stages.map((s: { id: string }) => s.id));
    });

    it('lets anyone in Slack be picked, once each, without joining first', async () => {
      const dir = await call(PAT, 'GET', '/api/directory');
      expect(dir.people).toEqual([{ id: 'U0ACMEHOLLY', name: 'Holly Ng', slackUserId: 'U0ACMEHOLLY', handle: 'holly' }, { id: 'U0ACMESAM', name: 'Sam', slackUserId: 'U0ACMESAM', handle: 'sam' }]);
      const read = await call(PAT, 'POST', '/api/processes/from-yaml', { yaml: 'name: Zed led\naccess: { who: people, people: [Holly Ng] }\nstages:\n  - name: A\n    team: Product\n    lead: Holly Ng\n  - name: B\n    decide: [holly]\n' });
      expect(read.notes).toEqual([]);
      expect(read.draft.stages[0].owner).toEqual({ name: 'Holly Ng', slackUserId: 'U0ACMEHOLLY' });
      expect(read.draft.stages[1].approvers).toEqual([{ name: 'Holly Ng', slackUserId: 'U0ACMEHOLLY' }]);
      expect(read.draft.access).toMatchObject({ who: 'people', people: [{ slackUserId: 'U0ACMEHOLLY' }] });
    });

    it('passes the spend, stop and Library routes what was asked', async () => {
      expect(await call(PAT, 'GET', '/api/spend?all=1')).toEqual({ ok: true, who: 'Pat', all: true });
      expect(await call(PAT, 'GET', '/api/spend')).toEqual({ ok: true, who: 'Pat', all: false });
      expect(await call(PAT, 'POST', '/api/team-tasks/t%201/stop-all', {})).toEqual({ ok: true, who: 'Pat', id: 't 1' });
      expect(await call(PAT, 'GET', '/api/library?documents=1')).toEqual([{ documents: true, kind: null }]);
      expect(await call(PAT, 'GET', '/api/library')).toEqual([{ documents: false, kind: null }]);
      expect(await call(PAT, 'GET', '/api/library?kind=document')).toEqual([{ documents: false, kind: 'document' }]);
    });

    it('says what a file needs that isn’t on this server', async () => {
      const read = await call(PAT, 'POST', '/api/processes/from-yaml', { yaml: 'name: Zed new env\ncode_in: gone-repo\nstages:\n  - name: A\n    team: Gone Team\n  - name: B\n    worker: Gone Worker\n' });
      expect(read.missing).toEqual({ teams: ['Gone Team'], workers: ['Gone Worker'], people: [], places: ['gone-repo'] });
      // It can't be saved like that.
      expect(await call(PAT, 'POST', '/api/processes', read.draft)).toMatchObject({ ok: false, error: expect.stringContaining('Pick the team') });
    });

    it('does a team’s file the same way, for whoever can change the team', async () => {
      const out = await call(PAT, 'GET', '/api/teams/t-product/yaml');
      expect(out.yaml).toContain('worker: Lena');
      expect(await call(RILEY, 'GET', '/api/teams/t-product/yaml')).toMatchObject({ ok: false });
      const read = await call(PAT, 'POST', '/api/teams/from-yaml', { yaml: 'name: New\nmembers:\n  - worker: Ghost\n' });
      expect(read).toMatchObject({ ok: true, draft: { name: 'New', members: [] }, missing: { workers: ['Ghost'] } });
    });

    it('is only for whoever can change the process', async () => {
      const read = await call(PAT, 'POST', '/api/processes/from-yaml', { yaml: FILE.replace('Zed from a file', 'Zed not for Riley') });
      const made = await call(PAT, 'POST', '/api/processes', read.draft);
      expect(await call(RILEY, 'GET', `/api/processes/${made.process.id}/yaml`)).toMatchObject({ ok: false });
      expect(await call(RILEY, 'POST', '/api/processes/from-yaml', { yaml: FILE, processId: made.process.id })).toMatchObject({ ok: false });
      // A file can't make anyone a process's owner on their own say-so.
      const forged = await call(RILEY, 'POST', '/api/processes', { ...read.draft, name: 'Forged', owner: { name: 'Sam', slackUserId: 'U0ACMESAM' } });
      expect(forged.ok).toBe(false);
    });
  });

  it('makes a process, takes an item in, and lets the owner but not others change it', async () => {
    const made = await call(PAT, 'POST', '/api/processes', { access: { who: 'everyone' },
      name: 'Idea to launch',
      stages: [
        { id: 'prfaq', name: 'PRFAQ', kind: 'team', teamId: 't-product' },
        { id: 'ok', name: 'Validate', kind: 'people', approvers: [{ name: 'Sam', slackUserId: 'U0ACMESAM' }, { name: '' }] },
      ],
    });
    expect(made).toMatchObject({ ok: true, process: { name: 'Idea to launch', owner: { name: 'Pat' } } });
    const id = made.process.id as string;
    expect(made.process.stages[1].approvers).toEqual([{ name: 'Sam', slackUserId: 'U0ACMESAM' }]);

    const item = await call(RILEY, 'POST', `/api/processes/${id}/items`, { brief: 'CSV export for reports' });
    expect(item).toMatchObject({ ok: true, item: { title: 'CSV export for reports', initiator: { name: 'Riley' } } });
    expect(briefs.at(-1)).toContain('CSV export for reports');

    const seen = await call(RILEY, 'GET', `/api/processes/${id}`);
    expect(seen.process.canSteer).toBe(false);
    expect(seen.items[0]).toMatchObject({ stageName: 'PRFAQ', canDecide: false });
    expect(await call(RILEY, 'POST', `/api/processes/${id}`, { name: 'Mine', stages: made.process.stages })).toMatchObject({ ok: false });
    expect(await call(RILEY, 'POST', `/api/process-items/${item.item.id}/act`, { action: 'move', stageIndex: 1 })).toMatchObject({ ok: false });
    expect(await call(PAT, 'POST', `/api/process-items/${item.item.id}/act`, { action: 'move', stageIndex: 1 })).toMatchObject({ ok: true, item: { stageIndex: 1 } });
    expect(await call(PAT, 'POST', `/api/process-items/${item.item.id}/act`, { action: 'explode' })).toMatchObject({ ok: false, error: 'Unknown action.' });
  });

  it('takes work in from a channel through a trigger that hands it to the process', async () => {
    const id = (await call(PAT, 'GET', '/api/processes')).processes[0].id as string;
    expect(await call(RILEY, 'POST', `/api/processes/${id}/intake`, { kind: 'slack', channel: 'C0ACMEIDEAS' })).toMatchObject({ ok: false });
    const added = await call(PAT, 'POST', `/api/processes/${id}/intake`, { kind: 'slack', channel: 'C0ACMEIDEAS' });
    expect(added.intake).toMatchObject([{ kind: 'slack', channel: 'C0ACMEIDEAS' }]);
    const hook = await call(PAT, 'POST', `/api/processes/${id}/intake`, { kind: 'webhook' });
    expect(hook.webhookPath).toMatch(/^\/hooks\/[\w-]+\/[\w-]+$/);

    const before = state.items.length;
    triggerSvc.fire(triggers[0], { id: 'm1', title: 'Dark mode please', data: { text: 'Dark mode please, it hurts at night' } });
    expect(state.items.length).toBe(before + 1);
    expect(state.items.at(-1)).toMatchObject({ title: 'Dark mode please', source: 'trigger' });
    expect(deliverables.at(-1)).toMatchObject({ status: 'delivered', deliveredTo: ['Idea to launch'] });

    const removed = await call(PAT, 'POST', `/api/process-intake/${triggers[0].id}/remove`, {});
    expect(removed.intake).toHaveLength(1);
  });

  it('publishes from a desktop by its local team ids, and says which teams to publish first', async () => {
    const stages = [{ id: 'a', name: 'PRFAQ', kind: 'team', localTeamId: 'desk-team-1', teamName: 'Product' }];
    expect(await call(PAT, 'POST', '/api/publish/process', { localId: 'desk-p1', name: 'From my desk', stages: [...stages, { id: 'b', name: 'Build', kind: 'team', localTeamId: 'desk-team-9', teamName: 'Builders' }] })).toMatchObject({
      ok: false,
      error: expect.stringContaining('Publish Builders to your org first'),
    });
    const first = await call(PAT, 'POST', '/api/publish/process', { localId: 'desk-p1', name: 'From my desk', stages });
    expect(first).toMatchObject({ ok: true, updated: false, process: { stages: [{ teamId: 't-product' }] } });
    const again = await call(PAT, 'POST', '/api/publish/process', { localId: 'desk-p1', name: 'From my desk, v2', stages });
    expect(again).toMatchObject({ ok: true, updated: true, process: { id: first.process.id, name: 'From my desk, v2' } });
  });
  it('adds a quarterly schedule and a watch on a tool as ways in', async () => {
    const id = (await call(PAT, 'GET', '/api/processes')).processes[0].id as string;
    const sched = await call(PAT, 'POST', `/api/processes/${id}/schedules`, { cadence: { kind: 'cron', expr: '0 9 1 1,4,7,10 *' }, title: 'Quarterly roadmap', brief: 'Plan next quarter' });
    expect(sched).toMatchObject({ ok: true, schedule: { title: 'Quarterly roadmap' } });
    expect(await call(PAT, 'POST', `/api/processes/${id}/schedules`, { cadence: { kind: 'cron', expr: 'not cron' }, title: 'X', brief: 'Y here' })).toMatchObject({ ok: false });
    const seen = await call(PAT, 'GET', `/api/processes/${id}`);
    expect(seen.schedules[0].when).toBe('On the first day of each quarter at 09:00');
    const watched = await call(PAT, 'POST', `/api/processes/${id}/intake`, { kind: 'watch', watch: { server: 'tracker', tool: 'search', args: { q: 'type = Bug' }, everyMinutes: 15 } });
    expect(watched.intake.find((t: { kind: string }) => t.kind === 'watch')).toMatchObject({ watch: { server: 'tracker', tool: 'search', everyMinutes: 15 } });
  });
  it('lists everything in flight for the Inbox: worker runs and process items, with decisions marked', async () => {
    const res = await call(RILEY, 'GET', '/api/inflight');
    expect(res.items.find((x: { id: string }) => x.id === 'r1')).toMatchObject({ kind: 'worker', title: 'Weekly site audit', who: 'Owen', total: 3, at: 1, now: 'Step 2 of 3 · crawl pages', needsYou: false });
    const proc = res.items.filter((x: { kind: string }) => x.kind === 'process');
    expect(proc.length).toBeGreaterThan(0);
    expect(proc[0]).toMatchObject({ who: 'Idea to launch', needsYou: false });
  });
  it('counts a worker working out an answer as in flight, as the bar does, and no run twice', async () => {
    const res = await call(RILEY, 'GET', '/api/inflight');
    expect(res.items.find((x: { id: string }) => x.id === 'deciding:w-tri')).toMatchObject({ kind: 'worker', who: 'Triage', title: 'Working out how to answer', now: 'Deciding · a question', needsYou: false });
    expect(res.items.filter((x: { title: string }) => x.title === 'Weekly site audit')).toHaveLength(1);
  });
});

describe('/idea', () => {
  const procs = [{ id: 'p1', name: 'Idea to launch' }, { id: 'p2', name: 'Bugs' }];
  it('takes a process name before a colon, or the only process there is', () => {
    expect(parseIdea('Idea to launch: CSV export', procs)).toEqual({ processId: 'p1', brief: 'CSV export' });
    expect(parseIdea('CSV export', [procs[0]])).toEqual({ processId: 'p1', brief: 'CSV export' });
    expect(parseIdea('note: CSV export', [procs[0]])).toEqual({ processId: 'p1', brief: 'note: CSV export' });
    expect(parseIdea('CSV export', procs)).toMatchObject({ error: expect.stringContaining('Which process?') });
    expect(parseIdea('', procs)).toBeNull();
  });

  it('takes a short name as the first word, with or without a colon', () => {
    const short = [{ id: 'p1', name: 'Launch review board', shortName: 'lrb' }, { id: 'p2', name: 'Bugs' }];
    expect(parseIdea('lrb let customers export CSV', short)).toEqual({ processId: 'p1', brief: 'let customers export CSV' });
    expect(parseIdea('LRB: CSV export', short)).toEqual({ processId: 'p1', brief: 'CSV export' });
    expect(parseIdea('Bugs: CSV export fails', short)).toEqual({ processId: 'p2', brief: 'CSV export fails' });
    expect(parseIdea('CSV export', short)).toMatchObject({ error: expect.stringContaining('`/idea lrb …`') });
  });
});
