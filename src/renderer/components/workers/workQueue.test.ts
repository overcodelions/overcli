import { describe, expect, it } from 'vitest';

import type { Orchestration } from '@shared/flows/orchestration';
import type { FlowRun } from '@shared/flows/schema';
import type { Worker } from '@shared/flows/worker';

import {
  baseName,
  buildWorkQueue,
  describeQueue,
  groupByDay,
  pickDeliverable,
  stepTrack,
  FINISHED_LIMIT,
  type QueueRow,
} from './workQueue';

import type { WorkerFile } from './workerDeskSelectors';

function file(name: string): WorkerFile {
  return { name, path: `/root/${name}`, bytes: 10, modifiedAt: 1 } as WorkerFile;
}

const NOON = new Date('2026-08-24T12:00:00').getTime();
const HOUR = 3_600_000;

function worker(id: string, name = 'Spec Hygiene'): Worker {
  return {
    id,
    name,
    jobDescription: 'Keep project checks healthy and useful.',
    projectPath: '/workspace',
    cadence: { kind: 'daily', time: '09:00' },
    trust: 'probation',
    caps: { maxItemsPerShift: 3, runIn: 'worktree' },
    budgetUSDPerMonth: 10,
    heartbeatModel: 'model',
    flowIds: ['flow'],
    enabled: true,
    createdAt: 1,
  } as Worker;
}

function run(id: string, overrides: Record<string, unknown> = {}): FlowRun {
  return {
    id,
    flowId: 'flow',
    flowSnapshot: {
      id: 'flow',
      name: 'Fix and ship',
      steps: [
        { id: 'plan', participantId: 'p', role: 'planner', inputs: [], tools: [] },
        { id: 'implement', participantId: 'p', role: 'implementer', inputs: [], tools: [] },
        { id: 'review', participantId: 'p', role: 'reviewer', inputs: [], tools: [] },
      ],
      participants: [],
    },
    projectPath: '/workspace',
    userPrompt: 'Fix the flaky spec',
    conversationIds: {},
    artifacts: {},
    state: { kind: 'running', currentStepId: 'implement' },
    createdAt: 1,
    attempts: [{ stepId: 'plan', startedAt: 1, conversationId: 'c', outcome: 'success' }],
    ...overrides,
  } as unknown as FlowRun;
}

function batch(
  id: string,
  items: Array<{ status: string; runId?: string; at?: number; note?: string }>,
  extra: {
    workerId?: string;
    task?: 'shift' | 'errand';
    intent?: 'chat' | 'work';
    createdAt?: number;
    completedAt?: number;
  } = {},
): Orchestration {
  return {
    id,
    title: `[Shift 3] Spec Hygiene`,
    projectPath: '/workspace',
    maxConcurrent: 1,
    origin: {
      kind: 'worker',
      workerId: extra.workerId ?? 'w1',
      workerName: 'Spec Hygiene',
      task: extra.task,
      intent: extra.intent,
    },
    createdAt: extra.createdAt ?? NOON - HOUR,
    ...(extra.completedAt ? { completedAt: extra.completedAt } : {}),
    items: items.map((item, i) => ({
      candidate: { id: `${id}-${i}`, title: `Job ${i}`, prompt: 'p' },
      flowId: 'flow',
      status: item.status as never,
      ...(item.runId ? { runId: item.runId } : {}),
      ...(item.at ? { startedAt: item.at, finishedAt: item.at } : {}),
      ...(item.note ? { note: item.note } : {}),
    })),
  } as Orchestration;
}

const WORKERS = { w1: worker('w1'), w2: worker('w2', 'Docs Gardener') };

describe('buildWorkQueue', () => {
  it('sorts each item into the band that says what it is asking of you', () => {
    const q = buildWorkQueue(
      {
        b1: batch('b1', [
          { status: 'running', runId: 'r1' },
          { status: 'queued' },
          { status: 'proposed' },
          { status: 'paused', runId: 'r2' },
          { status: 'done' },
          { status: 'failed', note: 'step review failed' },
        ]),
      },
      { r1: run('r1'), r2: run('r2', { state: { kind: 'paused', nextStepId: 'review', reason: 'needsInput' } }) },
      WORKERS,
      {},
      NOON,
    );

    expect(q.running.map((r) => r.status).sort()).toEqual(['queued', 'running']);
    expect(q.needsYou.map((r) => r.status).sort()).toEqual(['paused', 'proposed']);
    expect(q.finished.map((r) => r.status).sort()).toEqual(['done', 'failed']);
  });

  it('drops cancelled items entirely — nothing ran, so nothing finished', () => {
    const q = buildWorkQueue({ b1: batch('b1', [{ status: 'cancelled' }]) }, {}, WORKERS, {}, NOON);
    expect([...q.running, ...q.needsYou, ...q.finished]).toEqual([]);
  });

  it('gives a batch that launched nothing one quiet row of its own', () => {
    const q = buildWorkQueue({ b1: batch('b1', []) }, {}, WORKERS, {}, NOON);
    expect(q.finished).toHaveLength(1);
    expect(q.finished[0].status).toBe('quiet');
    expect(q.finished[0].title).toContain('Shift 3');
  });

  it('rolls a day of answers from one worker into a single row', () => {
    const answer = (id: string, at: number, workerId = 'w1') =>
      batch(id, [], { workerId, task: 'errand', completedAt: at });
    const q = buildWorkQueue(
      {
        a1: answer('a1', NOON - HOUR),
        a2: answer('a2', NOON - 2 * HOUR),
        a3: answer('a3', NOON - 3 * HOUR),
        // A different worker's answer is a different line — the group's one
        // sentence has to be true of everyone inside it.
        a4: answer('a4', NOON - HOUR, 'w2'),
      },
      {},
      WORKERS,
      {},
      NOON,
    );

    const group = q.finished.find((r) => r.answers);
    expect(group).toMatchObject({ workerId: 'w1', title: '3 answers' });
    expect(group!.answers).toHaveLength(3);
    // Newest first inside the group, and the group sits where its newest
    // member sat.
    expect(group!.at).toBe(NOON - HOUR);
    expect(q.finished[0].key).toBe(group!.key);
    // The other worker's lone answer stays as it was.
    expect(q.finished.filter((r) => !r.answers)).toHaveLength(1);
    // Three answers are three things that finished, however they are drawn.
    expect(q.finishedToday).toBe(4);
  });

  it('counts an errand that launched nothing as an answer, whatever you meant by it', () => {
    // The old rule read the Ask/Create-work toggle, so a question you happened
    // to send as work sat on the page as its own row forever while the
    // identical question sent as a question folded away. The outcome is the
    // honest signal: nothing launched, so the worker answered you.
    const q = buildWorkQueue(
      {
        a1: batch('a1', [], { task: 'errand', completedAt: NOON - HOUR }),
        a2: batch('a2', [], { task: 'errand', completedAt: NOON - 2 * HOUR }),
        // Launched something, so it is work and keeps its own row.
        e1: batch('e1', [{ status: 'done' }], { task: 'errand', completedAt: NOON - HOUR }),
      },
      {},
      WORKERS,
      {},
      NOON,
    );

    expect(q.finished.find((r) => r.answers)?.answers).toHaveLength(2);
    expect(q.finished.filter((r) => !r.answers)).toHaveLength(1);
  });

  it('leaves a single answer alone — a group of one says less', () => {
    const q = buildWorkQueue(
      { a1: batch('a1', [], { task: 'errand', completedAt: NOON - HOUR }) },
      {},
      WORKERS,
      {},
      NOON,
    );
    expect(q.finished).toHaveLength(1);
    expect(q.finished[0].answers).toBeUndefined();
  });

  it('puts a worker still planning at the top of the running band', () => {
    const q = buildWorkQueue({}, {}, WORKERS, { w1: { tools: ['Read', 'Bash'], task: 'shift' } }, NOON);
    expect(q.running).toHaveLength(1);
    expect(q.running[0].status).toBe('planning');
    // The last tool it touched, so a long planning turn still shows movement.
    expect(q.running[0].note).toBe('Bash');
    expect(q.running[0].orchestrationId).toBeUndefined();
  });

  it('ignores planning progress for a worker that is no longer on the roster', () => {
    const q = buildWorkQueue({}, {}, WORKERS, { gone: { tools: [], task: 'shift' } }, NOON);
    expect(q.running).toEqual([]);
  });

  it('leaves a fired worker\'s batches out — every row has to be clickable', () => {
    const q = buildWorkQueue(
      { b1: batch('b1', [{ status: 'done' }], { workerId: 'fired' }) },
      {},
      WORKERS,
      {},
      NOON,
    );
    expect(q.finished).toEqual([]);
  });

  it('ignores batches nobody on the roster authored', () => {
    const scheduled = {
      ...batch('b1', [{ status: 'running' }]),
      origin: { kind: 'schedule', scheduleId: 's', scheduleName: 'Nightly' },
    } as Orchestration;
    expect(buildWorkQueue({ b1: scheduled }, {}, WORKERS, {}, NOON).running).toEqual([]);
  });

  it('caps the finished tail but counts the whole day', () => {
    const items = Array.from({ length: FINISHED_LIMIT + 4 }, (_, i) => ({
      status: 'done',
      at: NOON - i * 60_000,
    }));
    const q = buildWorkQueue({ b1: batch('b1', items) }, {}, WORKERS, {}, NOON);
    expect(q.finished).toHaveLength(FINISHED_LIMIT);
    expect(q.finishedToday).toBe(FINISHED_LIMIT + 4);
    // Newest first, so the cap drops the oldest rather than the freshest.
    expect(q.finished[0].at).toBe(NOON);
  });

  it('counts only what finished since midnight', () => {
    const q = buildWorkQueue(
      {
        b1: batch('b1', [{ status: 'done', at: NOON - HOUR }]),
        b2: batch('b2', [{ status: 'done', at: NOON - 30 * HOUR }], { createdAt: NOON - 30 * HOUR }),
      },
      {},
      WORKERS,
      {},
      NOON,
    );
    expect(q.finished).toHaveLength(2);
    expect(q.finishedToday).toBe(1);
  });

  it('carries the run\'s flow, step track and pause reason onto the row', () => {
    const q = buildWorkQueue(
      { b1: batch('b1', [{ status: 'paused', runId: 'r1' }]) },
      { r1: run('r1', { state: { kind: 'paused', nextStepId: 'review', reason: 'externalAction' } }) },
      WORKERS,
      {},
      NOON,
    );
    const row = q.needsYou[0];
    expect(row.flowName).toBe('Fix and ship');
    expect(row.pausedReason).toBe('externalAction');
    expect(row.steps.map((s) => s.state)).toEqual(['done', 'ahead', 'current']);
  });
});

describe('the run is the truth', () => {
  it('moves an item still claiming to be running when its run has finished', () => {
    const q = buildWorkQueue(
      { b1: batch('b1', [{ status: 'running', runId: 'r1' }]) },
      { r1: run('r1', { state: { kind: 'done', success: true } }) },
      WORKERS,
      {},
      NOON,
    );
    expect(q.running).toEqual([]);
    expect(q.finished.map((r) => r.status)).toEqual(['done']);
  });

  it('reads a run that ended badly as a failure, whatever the item says', () => {
    const q = buildWorkQueue(
      { b1: batch('b1', [{ status: 'running', runId: 'r1' }]) },
      { r1: run('r1', { state: { kind: 'aborted' } }) },
      WORKERS,
      {},
      NOON,
    );
    expect(q.finished.map((r) => r.status)).toEqual(['failed']);
  });

  it('dates an unsettled item from its run\'s last attempt, not its batch', () => {
    const ended = NOON - 2 * HOUR;
    const q = buildWorkQueue(
      { b1: batch('b1', [{ status: 'running', runId: 'r1' }], { createdAt: NOON - 40 * HOUR }) },
      {
        r1: run('r1', {
          state: { kind: 'done', success: true },
          attempts: [{ stepId: 'review', startedAt: 1, endedAt: ended, conversationId: 'c', outcome: 'success' }],
        }),
      },
      WORKERS,
      {},
      NOON,
    );
    expect(q.finished[0].at).toBe(ended);
    expect(q.finishedToday).toBe(1);
  });

  it('files a job whose run has vanished under finished, not under Needs you', () => {
    const q = buildWorkQueue(
      { b1: batch('b1', [{ status: 'paused', runId: 'gone' }]) },
      {},
      WORKERS,
      {},
      NOON,
    );
    // Nothing about it can be decided, and a band that asks for decisions is
    // worth what its weakest row is worth.
    expect(q.needsYou).toEqual([]);
    expect(q.finished.map((r) => r.status)).toEqual(['orphaned']);
    // No runId on the row: the pane navigates on it, and a run nobody holds
    // is what made the click do nothing.
    expect(q.finished[0].runId).toBeUndefined();
  });

  it('orphans nothing until the runs have actually loaded', () => {
    const q = buildWorkQueue(
      { b1: batch('b1', [{ status: 'paused', runId: 'gone' }]) },
      {},
      WORKERS,
      {},
      NOON,
      false,
    );
    expect(q.needsYou.map((r) => r.status)).toEqual(['paused']);
  });

  it('keeps a finished item finished even with its run gone', () => {
    const q = buildWorkQueue(
      { b1: batch('b1', [{ status: 'done', runId: 'gone', at: NOON - HOUR }]) },
      {},
      WORKERS,
      {},
      NOON,
    );
    expect(q.finished.map((r) => r.status)).toEqual(['done']);
  });
});

describe('the bench', () => {
  const BENCHED = { w1: { ...worker('w1'), enabled: false } as Worker };

  it('keeps a stood-down worker off the front page', () => {
    const q = buildWorkQueue(
      {
        b1: batch('b1', [
          { status: 'paused', runId: 'gone' },
          { status: 'done', at: NOON - HOUR },
        ]),
        b2: batch('b2', []),
      },
      {},
      BENCHED,
      {},
      NOON,
    );
    expect([...q.running, ...q.needsYou, ...q.finished]).toEqual([]);
  });

  it('still shows work that is genuinely still moving', () => {
    const q = buildWorkQueue(
      { b1: batch('b1', [{ status: 'running', runId: 'r1' }]) },
      { r1: run('r1') },
      BENCHED,
      {},
      NOON,
    );
    expect(q.running.map((r) => r.status)).toEqual(['running']);
  });
});

describe('stepTrack', () => {
  it('marks the running step and everything behind it', () => {
    expect(stepTrack(run('r1')).map((s) => `${s.id}:${s.state}`)).toEqual([
      'plan:done',
      'implement:current',
      'review:ahead',
    ]);
  });

  it('reads the LAST attempt, so a step re-run after a failure is done', () => {
    const r = run('r1', {
      state: { kind: 'done', success: true },
      attempts: [
        { stepId: 'plan', startedAt: 1, conversationId: 'c', outcome: 'error' },
        { stepId: 'plan', startedAt: 2, conversationId: 'c', outcome: 'success' },
      ],
    });
    expect(stepTrack(r)[0].state).toBe('done');
  });

  it('treats a question as a step still talking, not a step that failed', () => {
    const r = run('r1', {
      state: { kind: 'done', success: true },
      attempts: [{ stepId: 'plan', startedAt: 1, conversationId: 'c', outcome: 'question' }],
    });
    expect(stepTrack(r)[0].state).toBe('ahead');
  });
});

describe('describeQueue', () => {
  it('says the three numbers as one sentence', () => {
    const q = buildWorkQueue(
      {
        b1: batch('b1', [
          { status: 'running', runId: 'r1' },
          { status: 'proposed' },
          { status: 'done', at: NOON - HOUR },
        ]),
      },
      { r1: run('r1') },
      WORKERS,
      {},
      NOON,
    );
    expect(describeQueue(q)).toBe('1 job running, 1 waiting on you, and 1 finished today.');
  });

  it('drops the middle clause when nothing is blocked', () => {
    const q = buildWorkQueue({ b1: batch('b1', [{ status: 'running', runId: 'r1' }]) }, { r1: run('r1') }, WORKERS, {}, NOON);
    expect(describeQueue(q)).toBe('1 job running, and nothing finished yet today.');
  });

  it('says nothing at all when there is nothing to say', () => {
    expect(describeQueue(buildWorkQueue({}, {}, WORKERS, {}, NOON))).toBe('');
  });
});

describe('pickDeliverable', () => {
  it('prefers what a person can read over the notes it was built from', () => {
    const files = [
      file('2026-08-24-1200-shift-3-report/raw_test_output.md'),
      file('2026-08-24-1200-shift-3-report/sprint-status.html'),
      file('2026-08-24-1200-shift-3-report/receipt.txt'),
    ];
    expect(pickDeliverable(files)?.name).toContain('sprint-status.html');
  });

  it('falls back to the last file — the tail of the run is the conclusion', () => {
    const files = [file('job/notes.txt'), file('job/summary.txt')];
    expect(pickDeliverable(files)?.name).toBe('job/summary.txt');
  });

  it('has nothing to offer when the job filed nothing', () => {
    expect(pickDeliverable([])).toBeNull();
  });

  it('labels a file by its own name, not its job folder', () => {
    expect(baseName('2026-08-24-1200-shift-3-report/sprint-status.html')).toBe('sprint-status.html');
    expect(baseName('loose-note.md')).toBe('loose-note.md');
  });
});

describe('groupByDay', () => {
  const row = (key: string, at: number) => ({ key, at }) as unknown as QueueRow;

  it('cuts a newest-first tail into contiguous days', () => {
    const days = groupByDay(
      [
        row('a', NOON),
        row('b', NOON - 3 * HOUR),
        row('c', NOON - 20 * HOUR),
        row('d', NOON - 30 * HOUR),
        row('e', NOON - 3 * 24 * HOUR),
      ],
      NOON,
    );
    expect(days.map((d) => d.rows.map((r) => r.key))).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
  });

  it('names the two days a reader thinks in and dates the rest', () => {
    const days = groupByDay(
      [row('a', NOON), row('b', NOON - 24 * HOUR), row('c', NOON - 3 * 24 * HOUR)],
      NOON,
    );
    expect(days.map((d) => d.label)).toEqual(['Today', 'Yesterday', expect.stringContaining('Aug')]);
  });

  it('keys each group by local midnight, not by the row that opened it', () => {
    const [day] = groupByDay([row('a', NOON)], NOON);
    expect(day.at).toBe(new Date('2026-08-24T00:00:00').getTime());
  });
});
