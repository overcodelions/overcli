import { describe, expect, it, vi } from 'vitest';
import type { Worker } from '../../shared/flows/worker';
import { DEFAULT_ORG_POLICY, type OrgCaller } from '../../shared/org/policy';
import { OrgService } from './orgService';
import type { Destination, WorkerTrigger } from './triggers';

const PAT = 'U0ACMEPAT';
const pat: OrgCaller = { slackUserId: PAT, name: 'Pat', admin: false };
const sam: OrgCaller = { slackUserId: 'U0ACMESAM', name: 'Sam', admin: false };
const service: OrgCaller = { name: 'ci-token', admin: true };

const triage: Worker = {
  id: 'triage',
  name: 'Triage',
  jobDescription: 'Watches the ticket queue.',
  projectPath: '/data/Workers',
  cadence: null,
  trust: 'probation',
  caps: { maxItemsPerShift: 1, runIn: 'worktree', allowExternalActions: false } as Worker['caps'],
  budgetUSDPerMonth: 20,
  heartbeatModel: 'sonnet',
  flowIds: [],
  enabled: true,
  createdAt: 0,
  manager: { name: 'Pat', slackUserId: PAT },
};

/// A trigger service that keeps what it's given, so a test can see what the
/// org layer handed it.
function fakeTriggers(start: WorkerTrigger[] = []) {
  const all = [...start];
  const tracked: Array<{ id: string; item: string; on: boolean }> = [];
  const follows: Array<{ id: string; item: string; user: string; on: boolean }> = [];
  return {
    all,
    tracked,
    follows,
    svc: {
      list: (workerId?: string) => all.filter((t) => !workerId || t.workerId === workerId),
      get: (id: string) => all.find((t) => t.id === id),
      create: (input: Omit<WorkerTrigger, 'id'>) => {
        const trigger = { ...input, id: `t${all.length + 1}` } as WorkerTrigger;
        all.push(trigger);
        return { ok: true, trigger };
      },
      update: (id: string, patch: Partial<WorkerTrigger>) => {
        const t = all.find((x) => x.id === id)!;
        Object.assign(t, patch);
        return { ok: true, trigger: t };
      },
      track: (id: string, item: string, on: boolean) => {
        tracked.push({ id, item, on });
        return { ok: true, tracked: on ? [item] : [] };
      },
      follow: (id: string, item: string, user: string, on: boolean) => {
        follows.push({ id, item, user, on });
        const t = all.find((x) => x.id === id)!;
        const now = new Set(t.followers?.[item] ?? []);
        if (on) now.add(user);
        else now.delete(user);
        t.followers = { ...t.followers, [item]: [...now] };
        return { ok: true, followers: now.size };
      },
      deliverables: () => [],
    },
  };
}

function harness(triggers = fakeTriggers(), extra: Partial<ConstructorParameters<typeof OrgService>[0]> = {}, others: Worker[] = []) {
  const audit: string[] = [];
  const svc = new OrgService({
    workers: {
      roster: () => [triage, ...others],
      get: (id) => (id === triage.id ? triage : null),
      save: (w) => ({ ok: true, worker: w }),
      setEnabled: () => ({ ok: true }),
      remove: () => ({ ok: true }),
      runErrand: async () => ({ ok: false, error: 'no' }),
      journalFor: () => [],
      spentThisMonth: () => new Map(),
      workerNames: () => [triage.name],
    },
    runs: { listRuns: () => [], getRun: () => null, steerRun: () => ({ ok: true }), resumeRun: () => ({ ok: true }) },
    rejectRun: () => ({ ok: true }),
    policy: () => ({ ...DEFAULT_ORG_POLICY, hirers: '*' }),
    draft: async () => ({ ok: false, error: 'no' }),
    saveHire: () => ({ ok: false, error: 'no' }),
    hires: { list: () => [], save: () => {} },
    triggers: () => triggers.svc as never,
    audit: { append: (e) => audit.push(e.what), recent: () => [], all: () => [] },
    now: () => 0,
    ...extra,
  });
  return { svc, triggers, audit };
}

const dm = (slackUserId: string): Destination => ({ kind: 'dm', slackUserId });

describe('a DM a trigger sends', () => {
  it('goes to the person setting it up, never someone they name', () => {
    const h = harness();
    const res = h.svc.createTrigger(pat, 'Triage', { name: 'Queue', kind: 'webhook', instructions: '', deliver: [dm('U0SOMEONE'), dm(PAT)], maxPerDay: 5 });
    expect(res.ok).toBe(true);
    expect(h.triggers.all[0].deliver).toEqual([dm(PAT)]);
  });

  it('keeps a DM that was already there for someone else when the trigger changes', () => {
    const h = harness(fakeTriggers([{ id: 't1', workerId: 'triage', name: 'Queue', kind: 'webhook', instructions: '', deliver: [dm('U0SAM')], maxPerDay: 5, enabled: true, createdBy: 'Sam' } as WorkerTrigger]));
    const res = h.svc.updateTrigger(pat, 't1', { deliver: [dm('U0SAM'), dm('U0OTHER')] });
    expect(res.ok).toBe(true);
    expect(h.triggers.all[0].deliver).toEqual([dm('U0SAM'), dm(PAT)]);
  });

  it('needs a linked Slack account to DM at all', () => {
    const h = harness();
    const res = h.svc.createTrigger(service, 'Triage', { name: 'Queue', kind: 'webhook', instructions: '', deliver: [dm(PAT)], maxPerDay: 5 });
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('Slack account linked') });
    expect(h.triggers.all).toHaveLength(0);
  });
});

describe('tracking an item', () => {
  const watch = { id: 't1', workerId: 'triage', name: 'Ticket moves', kind: 'watch', instructions: '', deliver: [], maxPerDay: 5, enabled: true, createdBy: 'Pat', watch: { changes: { field: 'status' }, tracked: [] } } as unknown as WorkerTrigger;

  it('is for the worker’s manager only', () => {
    const h = harness(fakeTriggers([structuredClone(watch)]));
    expect(h.svc.trackItem(sam, 'Triage', 'ACME-412', true).ok).toBe(false);
    expect(h.triggers.tracked).toEqual([]);
    expect(h.svc.trackItem(pat, 'Triage', 'ACME-412', true)).toEqual({ ok: true, worker: 'Triage', trigger: 'Ticket moves', tracked: 1 });
    expect(h.svc.trackItem(pat, 'Triage', 'ACME-412', false)).toMatchObject({ ok: true, tracked: 0 });
    expect(h.triggers.tracked).toEqual([{ id: 't1', item: 'ACME-412', on: true }, { id: 't1', item: 'ACME-412', on: false }]);
    expect(h.audit).toEqual(["Tracking ACME-412 on Triage's Ticket moves.", "Stopped tracking ACME-412 on Triage's Ticket moves."]);
  });

  it('says how to set up a list when the worker has none', () => {
    const h = harness();
    expect(h.svc.trackItem(pat, 'Triage', 'ACME-412', true)).toMatchObject({ ok: false, error: expect.stringContaining('has no list to track yet') });
  });
});

describe('following a ticket', () => {
  const changes = (id: string, tracked: string[]) =>
    ({ id, workerId: 'triage', name: `Moves ${id}`, kind: 'watch', instructions: '', deliver: [], maxPerDay: 5, enabled: true, createdBy: 'Pat', watch: { server: 'jira', tool: 'search', args: {}, everyMinutes: 15, changes: 'fields.status.name', tracked } }) as unknown as WorkerTrigger;

  it('puts the caller on the watch already following that project', () => {
    const h = harness(fakeTriggers([changes('t1', ['BETA-1']), changes('t2', ['ACME-9'])]));
    expect(h.svc.followItem(pat, 'ACME-412', true)).toEqual({ ok: true, worker: 'Triage', trigger: 'Moves t2', everyMinutes: 15 });
    expect(h.triggers.follows).toEqual([{ id: 't2', item: 'ACME-412', user: PAT, on: true }]);
    expect(h.svc.followItem(pat, 'ACME-412', false)).toMatchObject({ ok: true });
    expect(h.svc.followItem(pat, 'ACME-412', false)).toMatchObject({ ok: false, error: "You weren't following ACME-412." });
  });

  it('says plainly when nobody watches tickets yet', () => {
    const h = harness();
    expect(h.svc.followItem(pat, 'ACME-412', true)).toMatchObject({ ok: false, error: expect.stringContaining('Nobody watches tickets for changes yet') });
  });
});

describe('what is being watched', () => {
  const changes = (id: string, tracked: string[], followers: Record<string, string[]> = {}) =>
    ({ id, workerId: 'triage', name: `Moves ${id}`, kind: 'watch', instructions: '', deliver: [], maxPerDay: 5, enabled: true, createdBy: 'Pat', followers, states: { 'ACME-2': 'In review' }, watch: { server: 'jira', tool: 'search', args: {}, everyMinutes: 15, changes: 'fields.status.name', tracked } }) as unknown as WorkerTrigger;

  it('lists every tracked ticket in order, who follows it, and what the caller follows', () => {
    const h = harness(fakeTriggers([changes('t1', ['ACME-10', 'ACME-2'], { 'ACME-2': [PAT, 'U0ACMESAM'] })]));
    const res = h.svc.watching(pat);
    if (!res.ok) throw new Error(res.error);
    expect(res.total).toBe(2);
    expect(res.rows.map((r) => r.item)).toEqual(['ACME-2', 'ACME-10']);
    expect(res.rows[0]).toMatchObject({ status: 'In review', worker: 'Triage', trigger: 'Moves t1', followers: 2, youFollow: true });
    expect(res.rows[0].followerNames).toHaveLength(2);
    expect(res.mine.map((r) => r.item)).toEqual(['ACME-2']);
    expect(h.svc.watching(pat, { q: 'review' })).toMatchObject({ ok: true, total: 1 });
    expect(h.svc.watching(pat, { offset: 1, limit: 1 })).toMatchObject({ ok: true, total: 2, rows: [{ item: 'ACME-10' }] });
  });

  it('shows follower counts on the trigger, with names for whoever manages the worker', () => {
    const h = harness(fakeTriggers([changes('t1', ['ACME-2'], { 'ACME-2': [PAT, 'U0ACMESAM'] })]));
    const res = h.svc.triggers(pat, 'Triage');
    if (!res.ok) throw new Error(res.error);
    expect(res.triggers[0].following?.['ACME-2']).toMatchObject({ count: 2, names: expect.any(Array) });
    expect('followers' in res.triggers[0]).toBe(false);
  });
});

describe('following a ticket nothing watches yet', () => {
  it('follows on a watch already tracking its project, with no setup', async () => {
    const t = { id: 't1', workerId: 'triage', name: 'Moves', kind: 'watch', instructions: '', deliver: [], maxPerDay: 5, enabled: true, createdBy: 'Pat', watch: { server: 'jira', tool: 'search', args: {}, everyMinutes: 15, changes: 'fields.status.name', tracked: ['ACME-9'] } } as unknown as WorkerTrigger;
    const h = harness(fakeTriggers([t]));
    const said: string[] = [];
    expect(await h.svc.followOrSetUp(pat, 'ACME-412', true, { say: (x) => said.push(x) })).toMatchObject({ ok: true, trigger: 'Moves' });
    expect(said).toEqual([]);
  });

  it('asks the worker on the thread to set one up, and says plainly when it can not', async () => {
    const h = harness();
    const said: string[] = [];
    const res = await h.svc.followOrSetUp(pat, 'ACME-412', true, { workerId: triage.id, say: (x) => said.push(x) });
    // No look-up runs on this server: said plainly, before promising anything.
    expect(said).toEqual([]);
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining("Couldn't set up a watch for ACME-412 with Triage: this server can't run a look-up") });
    // Sam can't see Triage at all, so has no worker to set one up on.
    expect(await h.svc.followOrSetUp(sam, 'ACME-412', true, { workerId: triage.id })).toMatchObject({ ok: false, error: 'Nothing watches ACME tickets yet, and none of your workers can be set up to. A manager can give a worker a change watch on its Triggers tab.' });
  });
});

describe('whether a tool\'s keys sign in', () => {
  it('tries new keys on save, says so, and tells the worker\'s runs when they are refused', async () => {
    const roster = [{ ...triage, mcpServers: ['tracker'] }];
    let ok = false;
    const h = harness(fakeTriggers(), {
      workers: { roster: () => roster, get: (id: string) => roster.find((w) => w.id === id) ?? null, save: (w: Worker) => ({ ok: true, worker: w }), setEnabled: () => ({ ok: true }), remove: () => ({ ok: true }), runErrand: async () => ({ ok: false, error: 'no' }), journalFor: () => [], spentThisMonth: () => new Map(), workerNames: () => ['Triage'] } as never,
      policy: () => ({ ...DEFAULT_ORG_POLICY, hirers: '*', admins: ['U0ADMIN'] }),
      tools: {
        list: () => ({ tools: [], missing: [] }),
        install: () => ({ ok: true }),
        uninstall: () => ({ ok: true }),
        update: () => ({ ok: true, changed: ['TRACKER_TOKEN'] }),
        check: async () => ({ tracker: 'connected' }),
        login: async () => (ok ? { state: 'ok', as: 'Pat on Tracker', at: 1 } : { state: 'rejected', reason: 'Tracker didn’t accept TRACKER_TOKEN (401).', at: 1 }),
      },
    });
    const admin = { name: 'Ada', slackUserId: 'U0ADMIN', admin: true };
    expect(await h.svc.checkTools(admin)).toMatchObject({ ok: true });
    expect(h.svc.toolProblemsFor('triage')).toEqual(['tracker: its sign-in is refused, so what it reads comes back empty or fails. Tracker didn’t accept TRACKER_TOKEN (401).']);
    ok = true;
    expect(await h.svc.updateToolSettings(admin, 'tracker', { TRACKER_TOKEN: 'new' })).toMatchObject({ ok: true, login: { state: 'ok', as: 'Pat on Tracker' } });
    expect(h.svc.toolProblemsFor('triage')).toEqual([]);
  });
});

describe('a trigger starting work on its own', () => {
  const fire = (trust: Worker['trust'], starts: boolean) => {
    const seen: Array<{ text: string; untrusted?: boolean; mayLaunch?: boolean }> = [];
    const w = { ...triage, trust };
    const h = harness(fakeTriggers(), {
      workers: {
        roster: () => [w],
        get: (id: string) => (id === w.id ? w : null),
        save: (x: Worker) => ({ ok: true, worker: x }),
        setEnabled: () => ({ ok: true }),
        remove: () => ({ ok: true }),
        runErrand: async (_id: string, text: string, _a: unknown, _c: unknown, untrusted?: boolean, mayLaunch?: boolean) => {
          seen.push({ text, untrusted, mayLaunch });
          return { ok: false, error: 'no' };
        },
        journalFor: () => [],
        spentThisMonth: () => new Map(),
        workerNames: () => [w.name],
      } as never,
    });
    h.svc.startAsk(service, 'triage', 'Fix ACME-9', 'trigger', undefined, undefined, undefined, undefined, false, starts);
    return seen[0];
  };

  it('launches as its manager would when the worker is autonomous and the trigger opted in', () => {
    const got = fire('autonomous', true);
    expect(got).toMatchObject({ untrusted: true, mayLaunch: true });
    expect(got.text).toContain('lets start on its own');
  });

  it('launches for an autonomous worker even when the trigger did not opt in', () => {
    const got = fire('autonomous', false);
    expect(got).toMatchObject({ untrusted: true, mayLaunch: true });
    expect(got.text).toContain('lets start on its own');
  });

  it('still proposes for a worker that is not autonomous, opted in or not', () => {
    expect(fire('trusted', true).mayLaunch).toBe(false);
    expect(fire('probation', true).mayLaunch).toBe(false);
  });
});

describe('a Slack trigger where something else already listens', () => {
  const northwind: Worker = { ...triage, id: 'northwind', name: 'Northwind', slackHomeChannels: ['C0ACMEQS'] };
  const msgTrigger = (o: Partial<WorkerTrigger>): WorkerTrigger =>
    ({ id: 't9', workerId: 'northwind', name: 'Northwind watches', kind: 'slack', instructions: 'Answer what you can.', deliver: [{ kind: 'thread' }], maxPerDay: 50, enabled: true, createdBy: 'Sam', slack: { channel: 'C0ACMEQS', on: 'message' }, ...o }) as WorkerTrigger;
  const input = (channel: string, on: 'message' | 'reaction' = 'message', reaction?: string) =>
    ({ name: 'Questions', kind: 'slack' as const, instructions: 'Answer product questions.', deliver: [{ kind: 'thread' as const }], maxPerDay: 50, slack: { channel, on, ...(reaction ? { reaction } : {}) } });

  it('says when another worker already answers each new message there, and saves anyway', () => {
    const h = harness(fakeTriggers([msgTrigger({})]), {}, [northwind]);
    const res = h.svc.createTrigger(pat, 'Triage', input('C0ACMEQS'));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.notes).toEqual([expect.stringContaining('Northwind already has a trigger on each new message'), expect.stringContaining('Northwind’s home')]);
    expect(h.triggers.all).toHaveLength(2);
  });

  it('never names a private worker the caller can’t see, nor its trigger', () => {
    const hidden: Worker = { ...northwind, manager: { name: 'Sam', slackUserId: sam.slackUserId! } };
    const h = harness(fakeTriggers([msgTrigger({})]), {}, [hidden]);
    const res = h.svc.createTrigger(pat, 'Triage', input('C0ACMEQS'));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.notes).toEqual([expect.stringContaining('Another worker already has a trigger'), expect.stringContaining('another worker’s home')]);
    expect(res.notes!.join(' ')).not.toMatch(/Northwind/);
  });

  it('says nothing about the worker’s own home channel, a paused trigger, or a different emoji', () => {
    const own = { ...triage, slackHomeChannels: ['C0ACMEQS'] };
    const h = harness(fakeTriggers([msgTrigger({ enabled: false }), msgTrigger({ id: 't8', slack: { channel: 'C0ACMEQS', on: 'reaction', reaction: 'bug' } })]), {}, [own]);
    const res = h.svc.createTrigger(pat, 'Triage', input('C0ACMEQS'));
    expect(res.ok && res.notes).toBeFalsy();
    const r2 = h.svc.createTrigger(pat, 'Triage', input('C0ACMEQS', 'reaction', 'eyes'));
    expect(r2.ok && r2.notes).toBeFalsy();
  });

  it('says it again when a trigger is moved onto a busy channel', () => {
    const h = harness(fakeTriggers([msgTrigger({}), msgTrigger({ id: 't1', workerId: 'triage', name: 'Mine', slack: { channel: 'C0ACMEOTHER', on: 'message' } })]), {}, [northwind]);
    const res = h.svc.updateTrigger(pat, 't1', { slack: { channel: 'C0ACMEQS', on: 'message' } });
    expect(res.ok && res.notes).toHaveLength(2);
    expect(h.svc.updateTrigger(pat, 't1', { name: 'Renamed' })).not.toHaveProperty('notes');
  });
});

describe('drafting a trigger', () => {
  const answer = (said: string) => ({ done: true, files: [], items: [{ status: 'done', said }] });
  const search = '{"tool": "mcp__acme_tracker__searchIssues", "args": {"jql": "project = ACME"}, "name": "New ACME bugs", "means": "Open bugs in ACME."}';

  function setUp(said: string, opts: { canCall?: boolean; scope?: { mode: 'only'; calls: string[] }; json?: unknown } = {}) {
    const h = harness();
    const probe = vi.fn(async () => ({ ok: true, text: 'x', json: opts.json ?? { issues: [{ key: 'ACME-1', fields: { summary: 'Export fails' } }] } }));
    Object.assign(h.triggers.svc, { canCall: () => opts.canCall ?? true, probe });
    const lookup = vi.fn(async () => ({ ok: true, orchestrationId: 'run1' }));
    (h.svc as unknown as { deps: { workers: { lookup: unknown } } }).deps.workers.lookup = lookup;
    vi.spyOn(h.svc, 'listWorkers').mockReturnValue([{ id: 'triage', name: 'Triage', tools: [{ name: 'acme tracker', ok: true, ...(opts.scope ? { scope: opts.scope } : {}) }] }] as never);
    vi.spyOn(h.svc, 'errandProgress').mockReturnValue(answer(said) as never);
    return { ...h, probe, lookup };
  }
  const started = (h: ReturnType<typeof setUp>, who = pat, text = 'new bugs in acme') => {
    const res = h.svc.startTriggerDraft(who, 'Triage', text);
    if (!res.ok) throw new Error(res.error);
    return res.draftId;
  };
  const finished = async (h: ReturnType<typeof setUp>, id: string) => {
    await vi.waitFor(() => {
      const r = h.svc.triggerDraft(pat, id);
      expect(r.ok === false || r.done).toBe(true);
    });
    return h.svc.triggerDraft(pat, id);
  };

  it('tries the search for real and hands it back without saving anything', async () => {
    const h = setUp(search);
    const res = await finished(h, started(h));
    expect(res).toMatchObject({
      ok: true,
      done: true,
      draft: { server: 'acme tracker', tool: 'searchIssues', args: { jql: 'project = ACME' }, name: 'New ACME bugs', means: 'Open bugs in ACME.', listed: true, items: [{ id: 'ACME-1', title: 'ACME-1: Export fails' }] },
    });
    expect(h.probe).toHaveBeenCalledWith('acme tracker', 'searchIssues', { jql: 'project = ACME' });
    expect(h.triggers.all).toHaveLength(0);
    expect(h.audit).toEqual(['Asked Triage to draft a trigger.']);
  });

  it('never runs a call that could change something, whatever the worker says', async () => {
    const h = setUp('{"tool": "mcp__acme_tracker__deleteIssue", "args": {"key": "ACME-1"}}');
    expect(await finished(h, started(h))).toMatchObject({ ok: false, error: expect.stringContaining('deleteIssue') });
    expect(h.probe).not.toHaveBeenCalled();
  });

  it("never runs a read outside the worker's scope", async () => {
    const h = setUp(search, { scope: { mode: 'only', calls: ['getIssue'] } });
    expect(await finished(h, started(h))).toMatchObject({ ok: false, error: expect.stringContaining('searchIssues') });
    expect(h.probe).not.toHaveBeenCalled();
  });

  it("won't run a tool the worker wasn't offered", async () => {
    const h = setUp('{"tool": "mcp__other_tool__searchThings", "args": {}}');
    expect(await finished(h, started(h))).toMatchObject({ ok: false, error: expect.stringContaining('other_tool') });
    expect(h.probe).not.toHaveBeenCalled();
  });

  it('says when an answer has no list to tell new items apart', async () => {
    const h = setUp(search, { json: { summary: 'all quiet' } });
    expect(await finished(h, started(h))).toMatchObject({ ok: true, draft: { listed: false } });
  });

  it('says what to do when the tool only works inside runs, without spending a run', () => {
    const h = setUp(search, { canCall: false });
    expect(h.svc.startTriggerDraft(pat, 'Triage', 'new bugs')).toMatchObject({ ok: false, error: expect.stringContaining('Setup → Tools') });
    expect(h.lookup).not.toHaveBeenCalled();
  });

  it('wants a description, and only from a manager', () => {
    const h = setUp(search);
    expect(h.svc.startTriggerDraft(pat, 'Triage', '  ')).toMatchObject({ ok: false, error: expect.stringContaining('catch') });
    expect(h.svc.startTriggerDraft(pat, 'Triage', 'x'.repeat(1001))).toMatchObject({ ok: false, error: expect.stringContaining('1000') });
    expect(h.svc.startTriggerDraft(sam, 'Triage', 'new bugs').ok).toBe(false);
    expect(h.lookup).not.toHaveBeenCalled();
  });

  it('shows a draft only to whoever asked for it', async () => {
    const h = setUp(search);
    const id = started(h);
    await finished(h, id);
    expect(h.svc.triggerDraft(sam, id)).toMatchObject({ ok: false, error: expect.stringContaining('gone') });
  });

  it('runs one at a time per person and worker', async () => {
    const h = setUp(search);
    let finish = (_: unknown) => {};
    h.lookup.mockReturnValue(new Promise((r) => { finish = r; }) as never);
    const id = started(h);
    expect(h.svc.startTriggerDraft(pat, 'Triage', 'new bugs in acme')).toEqual({ ok: true, draftId: id });
    expect(h.svc.startTriggerDraft(pat, 'Triage', 'something else')).toMatchObject({ ok: false, error: expect.stringContaining('still working') });
    expect(h.lookup).toHaveBeenCalledTimes(1);
    finish({ ok: false, error: 'no' });
    await finished(h, id);
    expect(h.svc.startTriggerDraft(pat, 'Triage', 'something else').ok).toBe(true);
  });
});

describe('a team task in a Slack channel thread', () => {
  const slackThread = { channel: 'C0ACME', threadTs: '100.1' };
  const task = (over: Record<string, unknown> = {}) => ({ id: 'task-1', teamId: 'tm', teamName: 'Pricing', brief: 'Review pricing', status: 'questions', createdAt: 1, requestedBy: { name: 'Pat', slackUserId: PAT }, slackThread, ...over });

  function setUp(t: ReturnType<typeof task>) {
    const answer = vi.fn(() => ({ ok: true }));
    const roomAsk = vi.fn((): { ok: true; queued?: boolean } | { ok: false; error: string } => ({ ok: true }));
    const comment = vi.fn((): { ok: true; comment: { outcome: string } } | { ok: false; error: string } => ({ ok: true, comment: { outcome: 'queued' } }));
    const h = harness(fakeTriggers(), { teams: { list: () => ({ teams: [], tasks: [t] }), answer, roomAsk, comment } as never });
    return { ...h, answer, roomAsk, comment };
  }

  it('takes anyone’s answers there, naming them when they didn’t ask for it', () => {
    const h = setUp(task());
    expect(h.svc.answerTeamFromThread(pat, 'task-1', slackThread, ['US'])).toEqual({ ok: true, answered: true });
    expect(h.answer).toHaveBeenLastCalledWith('task-1', ['US']);
    expect(h.svc.answerTeamFromThread(sam, 'task-1', slackThread, ['UK'])).toEqual({ ok: true, answered: true });
    expect(h.answer).toHaveBeenLastCalledWith('task-1', ['Sam: UK']);
  });

  it('only takes answers in its own thread, while it’s asking', () => {
    const elsewhere = setUp(task());
    expect(elsewhere.svc.answerTeamFromThread(sam, 'task-1', { channel: 'C0ACME', threadTs: '999.9' }, ['UK'])).toEqual({ ok: true, answered: false });
    const movedOn = setUp(task({ status: 'proposed' }));
    expect(movedOn.svc.answerTeamFromThread(sam, 'task-1', slackThread, ['UK'])).toEqual({ ok: true, answered: false });
    const private_ = setUp(task({ slackThread: undefined }));
    expect(private_.svc.answerTeamFromThread(sam, 'task-1', slackThread, ['UK'])).toEqual({ ok: true, answered: false });
    expect(elsewhere.answer).not.toHaveBeenCalled();
    expect(movedOn.answer).not.toHaveBeenCalled();
    expect(private_.answer).not.toHaveBeenCalled();
  });

  it('never lets answering in the thread approve anything: the plan stays with who asked', () => {
    const h = setUp(task({ status: 'proposed' }));
    expect(h.svc.decideTeamTask(sam, 'task-1', { kind: 'approve' })).toMatchObject({ ok: false, error: expect.stringContaining('Only the person who asked') });
  });

  it('lets anyone talk to the team once it’s delivered, but only the person who asked can start work', () => {
    const h = setUp(task({ status: 'done' }));
    expect(h.svc.talkInTeamThread(sam, slackThread, 'What about UK?')).toEqual({ ok: true, heard: true });
    expect(h.roomAsk).toHaveBeenLastCalledWith('task-1', 'Sam: What about UK?', [], { feedback: true });
    expect(h.svc.talkInTeamThread(pat, slackThread, 'And Team?')).toEqual({ ok: true, heard: true });
    expect(h.roomAsk).toHaveBeenLastCalledWith('task-1', 'And Team?', [], {});
    expect(h.comment).not.toHaveBeenCalled();
    expect(h.svc.talkInTeamThread(sam, { channel: 'C0ACME', threadTs: '999.9' }, 'Hello')).toEqual({ ok: true, heard: false });
  });

  it('takes a reply as feedback while the team works, saying who it’s from', () => {
    const h = setUp(task({ status: 'running' }));
    h.roomAsk.mockReturnValue({ ok: false, error: 'The team is still working on this task.' });
    expect(h.svc.talkInTeamThread(sam, slackThread, 'Customers care most about the UK.')).toEqual({ ok: true, heard: true, noted: true });
    expect(h.comment).toHaveBeenLastCalledWith('task-1', { text: expect.stringMatching(/^Feedback from Sam, .*didn't ask for this task: Customers care most about the UK\.$/) });
    expect(h.svc.talkInTeamThread(pat, slackThread, 'Good point, cover the UK.')).toEqual({ ok: true, heard: true, noted: true });
    expect(h.comment).toHaveBeenLastCalledWith('task-1', { text: 'Good point, cover the UK.' });
    expect(h.audit).toContain('Gave feedback to Pricing in the Slack thread of "Review pricing".');
  });

  it('plans again with feedback on a plan waiting for its OK, which still waits on who asked', () => {
    const h = setUp(task({ status: 'proposed' }));
    h.roomAsk.mockReturnValue({ ok: false, error: 'The team is still working on this task.' });
    h.comment.mockReturnValue({ ok: true, comment: { outcome: 'replanned' } });
    expect(h.svc.talkInTeamThread(sam, slackThread, 'Add the UK.')).toEqual({ ok: true, heard: true, noted: true, replanned: true });
    expect(h.svc.decideTeamTask(sam, 'task-1', { kind: 'approve' }).ok).toBe(false);
  });

  describe('stopping a team’s work', () => {
    function withQueue() {
      const calls: string[] = [];
      const tasks = [task({ status: 'running' }), task({ id: 'task-2', status: 'queued' }), task({ id: 'task-3', status: 'queued', requestedBy: { name: 'Sam', slackUserId: 'U0ACMESAM' } }), task({ id: 'task-4', teamId: 'other', status: 'queued' })];
      const h = harness(fakeTriggers(), {
        teams: { list: () => ({ teams: [], tasks }), cancel: (id: string) => { calls.push(id); return { ok: true }; } } as never,
      });
      return { ...h, calls };
    }

    it('clears the queue first, so nothing starts in between, and only what the caller may stop', () => {
      const h = withQueue();
      expect(h.svc.stopTeamWork(pat, 'task-1')).toEqual({ ok: true, stopped: 2 });
      expect(h.calls).toEqual(['task-2', 'task-1']);
    });

    it('stops everything queued for an admin', () => {
      const h = withQueue();
      expect(h.svc.stopTeamWork(service, 'task-1')).toEqual({ ok: true, stopped: 3 });
      expect(h.calls).toEqual(['task-2', 'task-3', 'task-1']);
    });

    it('is for whoever asked, or an admin', () => {
      const h = withQueue();
      expect(h.svc.stopTeamWork(sam, 'task-1')).toMatchObject({ ok: false, error: expect.stringContaining('Only the person who asked') });
      expect(h.calls).toEqual([]);
    });
  });

  it('takes nothing once the task is over and the team can’t talk', () => {
    const h = setUp(task({ status: 'cancelled' }));
    h.roomAsk.mockReturnValue({ ok: false, error: 'The team is still working on this task.' });
    expect(h.svc.talkInTeamThread(sam, slackThread, 'Too late?')).toEqual({ ok: true, heard: false });
    expect(h.comment).not.toHaveBeenCalled();
  });
});

describe('the documents teams delivered, in the Library', () => {
  const team = { id: 'tm', name: 'Council', budgetUSDPerTask: 40, members: [{ workerId: 'triage', role: 'scores' }], checkpoints: {}, createdAt: 0 };
  const task = (id: string, over: Record<string, unknown>) => ({ id, teamId: 'tm', teamName: 'Council', brief: id, status: 'done', createdAt: 1, updatedAt: 1, finishedAt: 1, stages: [], stageIndex: 0, spentUSD: 0, budgetUSD: 40, files: [], ...over });
  const tasks = [
    task('real', { title: 'Offline mode', pack: { summary: 'Done.', files: ['pack/brief-offline.md', 'pack/PRFAQ.md'] } }),
    task('held', { status: 'review', pack: { summary: 'Done.', files: ['pack/held.md'] } }),
    task('reply', { answered: true, pack: { summary: 'Hi.', files: ['pack/answer.md'] } }),
    task('learn', { kind: 'learn', pack: { summary: 'Notes.', files: ['pack/TEAM_KNOWLEDGE.md'] } }),
    task('stopped', { status: 'cancelled', pack: { summary: 'Part.', files: ['pack/part.md'] } }),
  ];
  const setUp = () => harness(fakeTriggers(), { teams: { list: () => ({ teams: [team], tasks }), readFile: (_t: string, name: string) => ({ ok: true, body: `# ${name}` }) } as never });
  const docs = (h: ReturnType<typeof setUp>, who = pat) => h.svc.library(who, { documents: true }).filter((x) => x.kind === 'document');

  it('lists each delivered file, and not a reply, a learning pass or stopped work', () => {
    expect(docs(setUp()).map((d) => d.title).sort()).toEqual(['PRFAQ.md', 'brief-offline.md', 'held.md']);
  });

  it('leaves them out for everything else that reads the Library', () => {
    expect(setUp().svc.library(pat).some((x) => x.kind === 'document')).toBe(false);
  });

  it('finds one by its file name, and reads it when it’s opened', () => {
    const h = setUp();
    const hit = h.svc.library(pat, { documents: true, query: 'brief-offline' }).filter((x) => x.kind === 'document');
    expect(hit).toHaveLength(1);
    expect(hit[0].body).toBeUndefined();
    expect(h.svc.libraryItem(pat, hit[0].id)).toMatchObject({ ok: true, item: { body: '# pack/brief-offline.md', source: { taskId: 'real', file: 'pack/brief-offline.md' } } });
  });

  it('marks a reply and a learning pass, so Team tasks can leave them out', () => {
    const byId = new Map(setUp().svc.library(pat).map((x) => [x.id, x]));
    expect(byId.get('task:reply')?.answered).toBe(true);
    expect(byId.get('task:learn')?.learning).toBe(true);
    expect(byId.get('task:real')?.answered).toBeUndefined();
  });

  it('shows nothing to someone who can’t see the team', () => {
    const h = setUp();
    expect(docs(h, sam)).toEqual([]);
    expect(h.svc.libraryItem(sam, 'document:real:pack/brief-offline.md').ok).toBe(false);
  });
});
