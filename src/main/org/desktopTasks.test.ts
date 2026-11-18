// A worker hands its manager's desktop a task: only when allowed, only to
// its manager, and what comes back reaches the worker in the same thread.

import { describe, expect, it } from 'vitest';
import type { FlowRun } from '../../shared/flows/schema';
import type { Worker } from '../../shared/flows/worker';
import { DEFAULT_ORG_POLICY, type OrgCaller } from '../../shared/org/policy';
import { OrgService, type OrgServiceDeps } from './orgService';
import { DESKTOP_CLAIM_TTL_MS, DESKTOP_TASK_TTL_MS, MAX_OPEN_DESKTOP_TASKS, tidyDesktopTasks, type DesktopTask } from './desktopTasks';
import type { AskRecord } from './orgStores';

const PAT = 'U0ACMEPAT';
const pat: OrgCaller = { slackUserId: PAT, name: 'Pat', admin: false };
const sam: OrgCaller = { slackUserId: 'U0ACMESAM', name: 'Sam', admin: false };
let now = Date.UTC(2026, 10, 16, 12);

function setup(allowed = true, origin: 'manager' | 'trigger' | 'other' | 'schedule' | 'nameOnly' = 'manager') {
  const roster: Worker[] = [{
    id: 'robin', name: 'Robin', jobDescription: 'Checks the acme partner portal.', projectPath: '/p', cadence: null, trust: 'trusted',
    caps: { maxItemsPerShift: 1, runIn: 'worktree', allowExternalActions: false, ...(allowed ? { desktopHandOff: true } : {}) } as Worker['caps'],
    budgetUSDPerMonth: 20, heartbeatModel: 'sonnet', flowIds: ['f'], enabled: true, createdAt: 0, manager: { name: 'Pat', slackUserId: PAT }, visibility: 'org',
  } as Worker];
  const runs = [{ id: 'r1', workerId: 'robin', workerName: 'Robin', ...(origin === 'schedule' ? {} : { parentOrchestrationId: 'o1' }), flowSnapshot: { name: 'Check', steps: [] }, state: { kind: 'running', currentStepId: 's' }, attempts: [], artifacts: {}, createdAt: now } as unknown as FlowRun];
  let tasks: DesktopTask[] = [];
  // The question the run came from.
  let asks: AskRecord[] =
    origin === 'schedule'
      ? []
      : [{
          id: 'a0', workerId: 'robin', workerName: 'Robin', at: now - 1000, status: 'answered', orchestrationId: 'o1', text: 'Check the portal',
          ...(origin === 'manager' ? { by: 'Pat', slackUserId: PAT, via: 'slack' } : origin === 'nameOnly' ? { by: 'Pat', via: 'console' } : origin === 'trigger' ? { by: 'Product Q&A', via: 'trigger' } : { by: 'Sam', slackUserId: 'U0ACMESAM', via: 'slack', untrusted: true }),
        } as AskRecord];
  const deps: OrgServiceDeps = {
    workers: {
      roster: () => roster, get: (id) => roster.find((w) => w.id === id) ?? null, save: (w) => ({ ok: true, worker: w }), setEnabled: () => ({ ok: true }), remove: () => ({ ok: true }),
      runErrand: async () => ({ ok: false, error: 'not in this test' }), journalFor: () => [], spentThisMonth: () => new Map(), workerNames: () => roster.map((w) => w.name),
    },
    runs: { listRuns: () => runs, getRun: (id) => runs.find((r) => r.id === id) ?? null, steerRun: () => ({ ok: true }), resumeRun: () => ({ ok: true }) },
    rejectRun: () => ({ ok: true }), policy: () => ({ ...DEFAULT_ORG_POLICY }), draft: async () => ({ ok: false, error: 'no' }), saveHire: () => ({ ok: false, error: 'no' }),
    hires: { list: () => [], save: () => {} },
    asks: { list: () => asks, save: (a) => (asks = a) },
    desktopTasks: { load: () => ({ tasks }), save: (v) => (tasks = v.tasks) },
    runIdForConversation: (id) => (id === 'conv-1' ? 'r1' : undefined),
    now: () => now,
  };
  let saves = 0;
  const store = deps.desktopTasks!;
  deps.desktopTasks = { load: store.load, save: (v) => (saves++, store.save(v)) };
  return { org: new OrgService(deps), tasks: () => tasks, asks: () => asks, roster, saves: () => saves };
}

describe('handing work to a desktop', () => {
  it('queues the task for the manager’s desktop, and tells the worker not to wait', () => {
    const { org, tasks } = setup();
    const res = org.handOffToDesktop({ conversationId: 'conv-1', task: 'Check the acme partner portal shows the new tier', kind: 'browser' });
    expect(res).toMatchObject({ ok: true, message: expect.stringContaining('Pat’s overcli') });
    expect(tasks()).toEqual([expect.objectContaining({ workerName: 'Robin', forSlackUserId: PAT, kind: 'browser', status: 'waiting', thread: 'run:r1' })]);
    expect(org.desktopTasks(pat)).toMatchObject({ ok: true, tasks: [expect.objectContaining({ task: 'Check the acme partner portal shows the new tier' })] });
    expect(org.desktopTasks(sam)).toEqual({ ok: true, tasks: [] });
  });

  it('refuses a worker its manager hasn’t allowed, a run that isn’t a worker’s, and too many at once', () => {
    expect(setup(false).org.handOffToDesktop({ conversationId: 'conv-1', task: 'x' })).toMatchObject({ ok: false, error: expect.stringContaining('isn’t allowed') });
    const { org } = setup();
    expect(org.handOffToDesktop({ conversationId: 'conv-x', task: 'x' })).toMatchObject({ ok: false });
    for (let i = 0; i < MAX_OPEN_DESKTOP_TASKS; i++) expect(org.handOffToDesktop({ conversationId: 'conv-1', task: `task ${i}` }).ok).toBe(true);
    expect(org.handOffToDesktop({ conversationId: 'conv-1', task: 'one more' })).toMatchObject({ ok: false, error: expect.stringContaining('already has') });
  });

  it('lets only that manager claim, decline or finish it, and hands the result back in the thread', () => {
    const { org, tasks, asks } = setup();
    const { taskId } = org.handOffToDesktop({ conversationId: 'conv-1', task: 'Check the portal' }) as { taskId: string };
    expect(org.claimDesktopTask(sam, taskId)).toMatchObject({ ok: false });
    expect(org.claimDesktopTask(pat, taskId)).toMatchObject({ ok: true, task: { status: 'claimed' } });
    expect(org.finishDesktopTask(pat, taskId, '')).toMatchObject({ ok: false });
    expect(org.finishDesktopTask(pat, taskId, 'The new tier shows, priced at $40.')).toMatchObject({ ok: true, task: { status: 'done' } });
    expect(tasks()[0].result).toBe('The new tier shows, priced at $40.');
    const reply = asks().find((a) => a.replyTo === 'run:r1')!;
    expect(reply).toMatchObject({ workerId: 'robin', by: 'Pat' });
    expect(reply.prompt).toContain('The new tier shows, priced at $40.');
    expect(org.declineDesktopTask(pat, taskId, 'late')).toMatchObject({ ok: false, error: expect.stringContaining('already done') });
  });

  it('tells the worker why when the manager declines', () => {
    const { org, asks } = setup();
    const { taskId } = org.handOffToDesktop({ conversationId: 'conv-1', task: 'Check the portal' }) as { taskId: string };
    expect(org.declineDesktopTask(pat, taskId, 'I’m not signed in there')).toMatchObject({ ok: true, task: { status: 'declined', why: 'I’m not signed in there' } });
    expect(asks().find((a) => a.replyTo === 'run:r1')!.prompt).toContain('I’m not signed in there');
  });

  it('only takes work its manager asked for: not a trigger’s, someone else’s or its own schedule’s', () => {
    expect(setup(true, 'trigger').org.handOffToDesktop({ conversationId: 'conv-1', task: 'x' })).toMatchObject({ ok: false, error: expect.stringContaining('a trigger or a Slack message') });
    expect(setup(true, 'other').org.handOffToDesktop({ conversationId: 'conv-1', task: 'x' })).toMatchObject({ ok: false, error: expect.stringContaining('Sam, not Pat') });
    expect(setup(true, 'schedule').org.handOffToDesktop({ conversationId: 'conv-1', task: 'x' })).toMatchObject({ ok: false, error: expect.stringContaining('your own schedule') });
    expect(setup(true, 'other').tasks()).toEqual([]);
  });

  it('lapses what nobody picked up within a day', () => {
    const t = { id: 't', workerId: 'w', workerName: 'W', forSlackUserId: PAT, forName: 'Pat', task: 'x', kind: 'other', at: now, status: 'waiting' } as DesktopTask;
    expect(tidyDesktopTasks([t], now + DESKTOP_TASK_TTL_MS + 1)[0].status).toBe('expired');
    expect(tidyDesktopTasks([t], now + 1000)[0].status).toBe('waiting');
  });

  it('lapses one allowed but never finished, so it stops holding one of the worker’s places', () => {
    const t = { id: 't', workerId: 'w', workerName: 'W', forSlackUserId: PAT, forName: 'Pat', task: 'x', kind: 'other', at: now, status: 'claimed', claimedAt: now + 1000 } as DesktopTask;
    expect(tidyDesktopTasks([t], now + 1000 + DESKTOP_CLAIM_TTL_MS + 1)[0].status).toBe('expired');
    expect(tidyDesktopTasks([t], now + DESKTOP_TASK_TTL_MS * 2)[0].status).toBe('claimed');
    const { org } = setup();
    for (let i = 0; i < MAX_OPEN_DESKTOP_TASKS; i++) {
      const { taskId } = org.handOffToDesktop({ conversationId: 'conv-1', task: `task ${i}` }) as { taskId: string };
      expect(org.claimDesktopTask(pat, taskId).ok).toBe(true);
    }
    expect(org.handOffToDesktop({ conversationId: 'conv-1', task: 'one more' }).ok).toBe(false);
    const was = now;
    now += DESKTOP_CLAIM_TTL_MS + 1;
    try {
      expect(org.handOffToDesktop({ conversationId: 'conv-1', task: 'one more' }).ok).toBe(true);
    } finally {
      now = was;
    }
  });

  it('keeps the task open, result unlost, when the worker can’t take it back', () => {
    const { org, tasks, roster } = setup();
    const { taskId } = org.handOffToDesktop({ conversationId: 'conv-1', task: 'Check the portal' }) as { taskId: string };
    org.claimDesktopTask(pat, taskId);
    roster[0].enabled = false;
    expect(org.finishDesktopTask(pat, taskId, 'Priced at $40.')).toMatchObject({ ok: false, error: expect.stringMatching(/paused.*still open/) });
    expect(tasks()[0].status).toBe('claimed');
    expect(org.desktopTasks(pat)).toMatchObject({ ok: true, tasks: [expect.objectContaining({ id: taskId })] });
    roster[0].enabled = true;
    expect(org.finishDesktopTask(pat, taskId, 'Priced at $40.')).toMatchObject({ ok: true, task: { status: 'done', result: 'Priced at $40.' } });
  });

  it('a refresh with nothing lapsed writes nothing', () => {
    const { org, saves } = setup();
    org.handOffToDesktop({ conversationId: 'conv-1', task: 'Check the portal' });
    const before = saves();
    org.desktopTasks(pat);
    org.desktopTasks(pat);
    expect(saves()).toBe(before);
  });

  it('won’t take an ask that has only the manager’s name, not their Slack id', () => {
    const { org, tasks } = setup(true, 'nameOnly');
    expect(org.handOffToDesktop({ conversationId: 'conv-1', task: 'x' })).toMatchObject({ ok: false, error: expect.stringContaining('isn’t signed in as Pat') });
    expect(tasks()).toEqual([]);
  });
});
