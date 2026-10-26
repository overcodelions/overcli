import { describe, expect, it } from 'vitest';
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

function harness(triggers = fakeTriggers(), extra: Partial<ConstructorParameters<typeof OrgService>[0]> = {}) {
  const audit: string[] = [];
  const svc = new OrgService({
    workers: {
      roster: () => [triage],
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
