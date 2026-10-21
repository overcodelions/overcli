import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FlowRun } from '../../shared/flows/schema';
import type { Orchestration } from '../../shared/flows/orchestration';
import type { Worker, WorkerJournalEntry } from '../../shared/flows/worker';
import { DEFAULT_ORG_POLICY, type OrgCaller } from '../../shared/org/policy';
import { OrgService, type LibraryItem, type OrgServiceDeps } from './orgService';
import type { AskRecord } from './orgStores';
import type { Deliverable } from './triggers';

const PAT = 'U0ACMEPAT';
const SAM = 'U0ACMESAM';
const pat: OrgCaller = { slackUserId: PAT, name: 'Pat', admin: false };
const sam: OrgCaller = { slackUserId: SAM, name: 'Sam', admin: false };
const DAY = 86_400_000;
const NOW = new Date(2026, 8, 10, 12).getTime();

function worker(id: string, over: Partial<Worker> = {}): Worker {
  return {
    id,
    name: id[0].toUpperCase() + id.slice(1),
    jobDescription: 'Watches acme competitor sites and reports changes each week.',
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

function flowRun(id: string, workerId: string, createdAt: number, over: Record<string, unknown> = {}): FlowRun {
  return {
    id,
    workerId,
    workerName: workerId,
    title: `Run ${id}`,
    flowSnapshot: { name: 'Weekly scan', steps: [] },
    state: { kind: 'done', success: true },
    attempts: [{ stepId: 's', startedAt: createdAt, endedAt: createdAt + 120_000, outcome: 'success' }],
    artifacts: {},
    createdAt,
    ...over,
  } as unknown as FlowRun;
}

function batch(id: string, workerId: string, origin: Record<string, unknown>): Orchestration {
  return { id, title: id, projectPath: '/repo', maxConcurrent: 1, items: [], createdAt: NOW - 3 * DAY, origin: { kind: 'worker', workerId, workerName: workerId, ...origin } } as unknown as Orchestration;
}

function shift(workerId: string, id: string, orchestrationId: string, manual = false): WorkerJournalEntry {
  return { id, workerId, kind: 'shift', at: NOW - 3 * DAY, title: '', orchestrationId, ...(manual ? { manual: true } : {}) } as WorkerJournalEntry;
}

function answered(id: string, workerId: string, by: OrgCaller, text: string, over: Partial<AskRecord> = {}): AskRecord {
  return { id, workerId, workerName: workerId, by: by.name, ...(by.slackUserId ? { slackUserId: by.slackUserId } : {}), text, at: NOW - DAY, doneAt: NOW - DAY + 60_000, status: 'answered', reply: `Reply to ${id}`, via: 'console', ...over };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function taskFolder(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-library-task-'));
  dirs.push(root);
  for (const [name, body] of [
    ['brief.md', 'Rank the Acme roadmap.'],
    ['plan.md', '# Plan'],
    ['pieces/triage.md', '# Scores'],
    ['pack/final.md', '# Final ranking'],
    ['pack/scores.csv', 'item,score\n'],
  ]) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), body);
  }
  return root;
}

function harness(opts: { teamOrgMember?: boolean } = {}) {
  const roster = [
    worker('ana', { manager: { name: 'Pat', slackUserId: PAT }, visibility: 'org' }),
    worker('cal', { manager: { name: 'Sam', slackUserId: SAM } }),
    worker('triage', { manager: { name: 'Pat', slackUserId: PAT } }),
  ];
  if (opts.teamOrgMember) roster[2].visibility = 'org';
  const runs = [
    flowRun('sched', 'ana', NOW - 3 * DAY, { parentOrchestrationId: 'b-sched' }),
    flowRun('now', 'ana', NOW - 3 * DAY + 1000, { parentOrchestrationId: 'b-now' }),
    flowRun('trig', 'ana', NOW - 3 * DAY + 2000, { parentOrchestrationId: 'b-trig' }),
    flowRun('asked', 'ana', NOW - 3 * DAY + 3000, { parentOrchestrationId: 'b-errand' }),
    flowRun('loose', 'ana', NOW - 3 * DAY + 4000),
    flowRun('solo', 'triage', NOW - 3 * DAY + 5000, { parentOrchestrationId: 'b-solo' }),
    // Pieces of the team task: one says so on the run, one only in the task.
    flowRun('piece', 'triage', NOW - 2 * DAY, { team: { teamId: 'team-1', teamName: 'Roadmap Council', taskId: 'task-1' } }),
    flowRun('piece2', 'triage', NOW - 2 * DAY + 1000),
    flowRun('mine', 'cal', NOW - 3 * DAY),
  ];
  const batches = [
    batch('b-sched', 'ana', { task: 'shift' }),
    batch('b-now', 'ana', { task: 'shift' }),
    batch('b-errand', 'ana', { task: 'errand', errand: 'Check pricing' }),
    batch('b-solo', 'triage', { task: 'shift' }),
  ];
  const journal: Record<string, WorkerJournalEntry[]> = {
    ana: [shift('ana', 's1', 'b-sched'), shift('ana', 's2', 'b-now', true)],
    triage: [shift('triage', 's3', 'b-solo')],
  };
  const asks: AskRecord[] = [
    answered('a-trig', 'ana', { name: 'Ticket watch', admin: true }, 'New ticket 42', { via: 'trigger', orchestrationId: 'b-trig' }),
    answered('a-pat', 'ana', pat, 'What changed on the acme pricing page this week? '.repeat(4).trim(), { via: 'slack' }),
    answered('a-cal', 'cal', sam, 'How is the acme blog doing?'),
    { ...answered('a-working', 'ana', pat, 'Still thinking'), status: 'working', reply: undefined },
  ];
  const deliverables: Deliverable[] = [
    {
      id: 'd1',
      workerId: 'ana',
      workerName: 'Ana',
      at: NOW - DAY,
      doneAt: NOW - DAY + 120_000,
      status: 'delivered',
      title: 'Ticket 42 triaged',
      source: { kind: 'webhook', triggerId: 't1', triggerName: 'Ticket watch' },
      result: 'Done',
      links: [],
      deliveredTo: [],
      askId: 'a-trig',
    },
  ];
  const folder = taskFolder();
  const task = {
    id: 'task-1',
    teamId: 'team-1',
    teamName: 'Roadmap Council',
    brief: 'Rank the roadmap',
    title: 'Q3 roadmap ranking',
    status: 'done',
    createdAt: NOW - 3 * DAY,
    updatedAt: NOW - DAY / 2,
    finishedAt: NOW - DAY / 2,
    stageIndex: 1,
    spentUSD: 1,
    budgetUSD: 40,
    folder,
    files: [
      { name: 'brief.md', author: 'You', at: 1 },
      { name: 'plan.md', author: 'Coordinator', stage: 0, at: 2 },
      { name: 'pieces/triage.md', author: 'Triage', stage: 1, at: 3 },
      { name: 'pack/final.md', author: 'Coordinator', stage: 2, at: 4 },
      { name: 'pack/scores.csv', author: 'Triage', stage: 2, at: 5 },
    ],
    stages: [
      { kind: 'draft', title: 'Plan it', status: 'done', file: 'plan.md', assignments: [] },
      {
        kind: 'contribute',
        title: 'Score it',
        status: 'done',
        assignments: [
          { workerId: 'triage', workerName: 'Triage', ask: 'Score it.', status: 'done', runId: 'piece', file: 'pieces/triage.md' },
          { workerId: 'triage', workerName: 'Triage', ask: 'Score the rest.', status: 'done', runId: 'piece2' },
        ],
      },
      { kind: 'synthesize', title: 'Write it up', status: 'done', assignments: [] },
    ],
    pack: { summary: 'Search first, then billing.', files: ['pack/final.md', 'pack/scores.csv'] },
  };
  const running = { ...task, id: 'task-2', title: 'Still going', status: 'running', pack: undefined, folder: undefined, stages: [] };
  const deps: OrgServiceDeps = {
    workers: {
      roster: () => roster,
      get: (id) => roster.find((w) => w.id === id) ?? null,
      save: (w) => ({ ok: true, worker: w }),
      setEnabled: () => ({ ok: true }),
      remove: () => ({ ok: true }),
      runErrand: async () => ({ ok: false, error: 'no' }),
      journalFor: (id) => journal[id] ?? [],
      spentThisMonth: () => new Map(),
      workerNames: () => roster.map((w) => w.name),
    },
    runs: { listRuns: () => runs, getRun: (id) => runs.find((r) => r.id === id) ?? null, steerRun: () => ({ ok: true }), resumeRun: () => ({ ok: true }) },
    rejectRun: () => ({ ok: true }),
    policy: () => ({ ...DEFAULT_ORG_POLICY }),
    draft: async () => ({ ok: false, error: 'not in this test' }),
    saveHire: () => ({ ok: false, error: 'not in this test' }),
    hires: { list: () => [], save: () => {} },
    batches: { list: () => batches, approve: async () => ({ ok: true, queued: 0 }), reject: () => ({ ok: true }) },
    asks: { list: () => asks, save: () => {} },
    triggers: () => ({ deliverables: () => deliverables }) as never,
    teams: {
      list: () =>
        ({
          teams: [{ id: 'team-1', name: 'Roadmap Council', budgetUSDPerTask: 40, members: [{ workerId: 'triage', role: 'scores' }], createdAt: 0 }],
          tasks: [task, running],
        }) as never,
      brief: () => ({ ok: false, error: 'no' }),
      answer: () => ({ ok: true }),
      approve: () => ({ ok: true }),
      revise: () => ({ ok: true }),
      continueTask: () => ({ ok: true }),
      cancel: () => ({ ok: true }),
    },
    now: () => NOW,
  };
  return new OrgService(deps);
}

const byId = (items: LibraryItem[]) => new Map(items.map((x) => [x.id, x]));

describe('Library origins', () => {
  it('says how each run started: its schedule, Run now, a trigger, a question, or nothing on record', () => {
    const lib = byId(harness().library(pat));
    expect(lib.get('run:sched')?.origin).toEqual({ kind: 'run', runId: 'sched', workerId: 'ana', workerName: 'Ana', how: 'schedule', flowName: 'Weekly scan' });
    expect(lib.get('run:now')?.origin).toMatchObject({ kind: 'run', how: 'runNow' });
    expect(lib.get('run:trig')?.origin).toMatchObject({ kind: 'run', how: 'trigger', triggerName: 'Ticket watch' });
    expect(lib.get('run:asked')?.origin).toMatchObject({ kind: 'run', how: 'asked' });
    expect(lib.get('run:loose')?.origin).toMatchObject({ kind: 'run', how: 'other' });
  });

  it('says which trigger delivered an event', () => {
    const d1 = byId(harness().library(pat)).get('d1');
    expect(d1).toMatchObject({ kind: 'event', origin: { kind: 'event', triggerId: 't1', triggerName: 'Ticket watch', workerId: 'ana', workerName: 'Ana' } });
  });
});

describe('answered errands in the Library', () => {
  it('lists the answers the caller may see, with the question and where it was asked', () => {
    const svc = harness();
    const answers = svc.library(pat, { kind: 'answer' });
    // A trigger's answer is its event; a working one is not done; Cal's is Sam's.
    expect(answers.map((x) => x.id)).toEqual(['ask:a-pat']);
    const a = answers[0];
    expect(a).toMatchObject({
      kind: 'answer',
      workerId: 'ana',
      status: 'delivered',
      body: 'Reply to a-pat',
      at: NOW - DAY + 60_000,
      origin: { kind: 'errand', askId: 'a-pat', workerId: 'ana', workerName: 'Ana', askedBy: 'Pat', via: 'slack' },
      visibility: 'private',
    });
    expect(a.title.length).toBeLessThanOrEqual(120);
    expect(a.title.endsWith('…')).toBe(true);
    expect(a.rating).toBeUndefined();
    expect(svc.library(sam, { kind: 'answer' }).map((x) => x.id)).toEqual(['ask:a-cal']);
    const full = svc.libraryItem(pat, 'ask:a-pat');
    expect(full.ok && full.item.body).toBe('Reply to a-pat');
    expect(svc.libraryItem(sam, 'ask:a-pat').ok).toBe(false);
  });
});

describe('a team task in the Library', () => {
  it('is one entry with its pack and working files, and its piece runs are folded in', () => {
    const svc = harness();
    const lib = svc.library(pat);
    const tasks = lib.filter((x) => x.kind === 'task');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: 'task:task-1',
      title: 'Q3 roadmap ranking',
      body: 'Search first, then billing.',
      status: 'delivered',
      at: NOW - DAY / 2,
      workerName: 'Roadmap Council',
      origin: { kind: 'task', teamId: 'team-1', teamName: 'Roadmap Council', taskId: 'task-1', taskTitle: 'Q3 roadmap ranking' },
      pack: {
        files: [
          { name: 'pack/final.md', writtenBy: null },
          { name: 'pack/scores.csv', writtenBy: 'Triage' },
        ],
      },
      workingFiles: 3,
      visibility: 'team',
      visibleTo: 'Roadmap Council’s managers',
    });
    const ids = lib.map((x) => x.id);
    expect(ids).not.toContain('run:piece');
    expect(ids).not.toContain('run:piece2');
    expect(ids).toContain('run:solo');
    const full = svc.libraryItem(pat, 'task:task-1');
    expect(full.ok && full.item.body).toBe('Search first, then billing.');
    // Sam sees no one on the team.
    expect(svc.library(sam).some((x) => x.kind === 'task')).toBe(false);
  });

  it('keeps a kept file with the stage it came from', () => {
    const svc = harness();
    expect(svc.keepTeamFiles(pat, 'task-1', ['pieces/triage.md'])).toEqual({ ok: true, kept: 1 });
    const file = svc.library(pat, { kind: 'file' })[0];
    expect(file.origin).toEqual({ kind: 'task', teamId: 'team-1', teamName: 'Roadmap Council', taskId: 'task-1', taskTitle: 'Q3 roadmap ranking', stage: { index: 2, title: 'Score it' } });
    expect(file).toMatchObject({ visibility: 'team', visibleTo: 'Roadmap Council’s managers' });
  });
});

describe('who can see each Library item', () => {
  it('follows the worker’s setting, and a team open to everyone', () => {
    const lib = byId(harness().library(pat));
    expect(lib.get('run:sched')).toMatchObject({ visibility: 'org', visibleTo: 'Everyone' });
    expect(lib.get('run:solo')).toMatchObject({ visibility: 'private', visibleTo: 'Only its manager' });
    expect(byId(harness({ teamOrgMember: true }).library(sam)).get('task:task-1')).toMatchObject({ visibility: 'org', visibleTo: 'Everyone' });
  });

  it('still shows each caller only what they may see, and filters by visibility', () => {
    const svc = harness();
    const samIds = svc.library(sam).map((x) => x.id);
    expect(samIds).toContain('run:sched');
    expect(samIds).toContain('run:mine');
    expect(samIds).not.toContain('run:solo');
    expect(svc.library(pat).map((x) => x.id)).not.toContain('run:mine');
    expect(svc.library(pat, { visibility: 'org' }).every((x) => x.visibility === 'org')).toBe(true);
    expect(svc.library(pat, { visibility: 'org' }).map((x) => x.id)).toContain('d1');
  });
});
