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
  return {
    all,
    tracked,
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
      deliverables: () => [],
    },
  };
}

function harness(triggers = fakeTriggers()) {
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
