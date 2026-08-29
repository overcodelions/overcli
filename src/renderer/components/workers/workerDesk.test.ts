import { describe, expect, it } from 'vitest';

import type { Orchestration } from '@shared/flows/orchestration';
import type { FlowRun } from '@shared/flows/schema';
import type { Worker } from '@shared/flows/worker';
import {
  activityOnDay,
  carriedOverTurns,
  conversationActivity,
  deskTimeline,
  adjacentDeskDay,
  anyDeskLive,
  resolveWorkerFilePath,
  deskDayLabel,
  deskDays,
  initialDeskDay,
  startOfDay,
  describeActivity,
  recentWorkerActivity,
  relativeTime,
  fileDate,
  groupIntoJobs,
  groupWorkerFiles,
  workerFileLabel,
  runDeliverable,
  toWorkerActivity,
  workerActivity,
  orchestrationForRun,
  orchestrationTask,
  deskMatchesQuery,
  summarizeDesk,
  workerDeskOrchestrations,
  workerDeskRuns,
  type WorkerActivity,
  sidebarActivity,
  sidebarShifts,
  workersForPath,
  workerAutoRenderTarget,
  shiftActivity,
  workerRenderableOutputs,
} from './workerDeskSelectors';

function worker(id = 'worker-1', overrides: Partial<Worker> = {}): Worker {
  return {
    id,
    name: id === 'worker-1' ? 'Spec Hygiene' : 'Docs Gardener',
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
    ...overrides,
  };
}

// `Record<string, unknown>` rather than `Partial<FlowRun>`: these cases only
// care about a run's `state.kind`, and `Partial<FlowRun>` would demand every
// companion field of each state variant (currentStepId, watch, success, …).
function run(id: string, overrides: Record<string, unknown> = {}): FlowRun {
  return {
    id,
    flowId: 'flow',
    flowSnapshot: { id: 'flow', name: 'Maintenance', steps: [], participants: [] },
    projectPath: '/member-repo',
    sourceProjectPath: '/workspace',
    userPrompt: 'Fix flaky CI spec',
    conversationIds: {},
    artifacts: {},
    state: { kind: 'done' },
    createdAt: 1,
    attempts: [],
    ...overrides,
  } as unknown as FlowRun;
}

function batch(
  id: string,
  workerId = 'worker-1',
  statuses: Array<string> = ['proposed'],
  extra: {
    task?: 'shift' | 'errand';
    title?: string;
    reply?: string;
    from?: { workerId: string; workerName: string };
    intent?: 'chat' | 'work';
  } = {},
): Orchestration {
  return {
    id,
    title: extra.title ?? `[Shift ${id}] Spec Hygiene`,
    projectPath: '/workspace',
    maxConcurrent: 1,
    origin: {
      kind: 'worker',
      workerId,
      workerName: 'Spec Hygiene',
      task: extra.task,
      ...(extra.intent ? { intent: extra.intent } : {}),
      ...(extra.from ? { from: extra.from } : {}),
    },
    ...(extra.reply ? { producer: { prompt: 'p', reply: extra.reply } } : {}),
    createdAt: Number(id.replace(/\D/g, '')) || 1,
    items: statuses.map((status, index) => ({
      candidate: { id: `${id}-${index}`, title: `Candidate ${index}`, prompt: 'p' },
      flowId: 'flow',
      status: status as any,
    })),
  };
}

describe('worker desk selectors', () => {
  it('claims worker runs by identity and sorts them newest first', () => {
    const runs = {
      old: run('old', { workerId: 'worker-1', createdAt: 1 }),
      new: run('new', { workerId: 'worker-1', createdAt: 2, projectPath: '/another-member' }),
      other: run('other', { workerId: 'worker-2', createdAt: 3 }),
    };
    expect(workerDeskRuns(runs, 'worker-1').map((item) => item.id)).toEqual(['new', 'old']);
  });

  it('selects a worker’s batches and splits awaiting proposals', () => {
    const batches = {
      older: batch('1'),
      latest: batch('2', 'worker-1', ['proposed', 'queued']),
      other: batch('3', 'worker-2'),
    };
    const result = workerDeskOrchestrations(batches, 'worker-1');
    expect(result.mine.map((item) => item.id)).toEqual(['2', '1']);
    expect(result.awaiting.map((item) => item.id)).toEqual(['2', '1']);
  });

  it('summarizes live work, proposal review, and completed work', () => {
    const runs = [
      run('running', { state: { kind: 'running' } }),
      run('paused', { state: { kind: 'paused' } }),
      run('watching', { state: { kind: 'watching' } }),
      run('done', { state: { kind: 'done' } }),
    ];
    expect(summarizeDesk(runs, [batch('1', 'worker-1', ['proposed', 'proposed'])], {}, false)).toEqual({
      running: 3,
      needReview: 2,
      done: 1,
      live: true,
    });
    expect(summarizeDesk([], [], {}, true).live).toBe(true);
  });

  it('formats desk summaries and search matches', () => {
    const w = worker();
    expect(deskMatchesQuery(w, [run('r')], 'spec hygiene')).toBe(true);
    expect(deskMatchesQuery(w, [run('r')], 'flaky')).toBe(true);
    expect(deskMatchesQuery(w, [], '')).toBe(true);
  });

  it('finds workers where hired and reports group liveness', () => {
    const first = worker();
    const second = worker('worker-2', { projectPath: '/project' });
    expect(workersForPath({ [first.id]: first, [second.id]: second }, '/workspace')).toEqual([first]);
    expect(
      anyDeskLive([first, second], { r: run('r', { workerId: 'worker-2', state: { kind: 'running' } }) }, {}, {}, {}),
    ).toBe(true);
    expect(anyDeskLive([first], {}, {}, {}, { 'worker-1': {} })).toBe(true);
    expect(anyDeskLive([first], {}, {}, {}, {})).toBe(false);
  });
});

describe('worker activity', () => {
  it('reads task off the origin and treats pre-errand batches as shifts', () => {
    expect(toWorkerActivity(batch('1', 'worker-1', [], { task: 'errand' })).task).toBe('errand');
    // Batches written before errands existed carry no `task`.
    expect(toWorkerActivity(batch('2')).task).toBe('shift');
  });

  it('maps legacy errands to work and filters conversation and shifts', () => {
    const legacy = toWorkerActivity(batch('1', 'worker-1', [], { task: 'errand' }));
    const chat = toWorkerActivity(batch('2', 'worker-1', [], { task: 'errand', intent: 'chat' }));
    const work = toWorkerActivity(batch('3', 'worker-1', [], { task: 'errand', intent: 'work' }));
    const shift = toWorkerActivity(batch('4'));
    expect(legacy.intent).toBe('work');
    expect([chat.intent, work.intent]).toEqual(['chat', 'work']);
    expect(conversationActivity([shift, chat, work])).toEqual([chat, work]);
    expect(shiftActivity([shift, chat, work])).toEqual([shift]);
  });

  /// The bubble reads as the user's own words. For an errand a colleague sent,
  /// they are not — so the desk needs to know whose they are.
  it('names the colleague that sent an errand, and nobody when you sent it', () => {
    expect(
      toWorkerActivity(
        batch('1', 'worker-1', [], {
          task: 'errand',
          from: { workerId: 'chief', workerName: 'Chief of Staff' },
        }),
      ).from,
    ).toBe('Chief of Staff');
    expect(toWorkerActivity(batch('2', 'worker-1', [], { task: 'errand' })).from).toBeUndefined();
    // A shift is nobody's message, however it was stamped.
    expect(
      toWorkerActivity(
        batch('3', 'worker-1', [], { from: { workerId: 'chief', workerName: 'Chief of Staff' } }),
      ).from,
    ).toBeUndefined();
  });

  it('keeps handoff markup out of the prose the desk renders', () => {
    expect(
      toWorkerActivity(
        batch('1', 'worker-1', [], {
          task: 'errand',
          reply: 'Nothing for me.\n<handoff to="Triage">Split RED-6814.</handoff>',
        }),
      ).reply,
    ).toBe('Nothing for me.');
  });

  it('strips the ledger prefix and the candidates payload', () => {
    const activity = toWorkerActivity(
      batch('1', 'worker-1', [], {
        task: 'errand',
        title: '[Errand] Repair the flaky spec',
        reply: 'Not my job.\n<candidates>[]</candidates>',
      }),
    );
    expect(activity.title).toBe('Repair the flaky spec');
    expect(activity.reply).toBe('Not my job.');
    expect(activity.launchedNothing).toBe(true);
  });

  it('counts item statuses and describes them', () => {
    const activity = toWorkerActivity(
      batch('1', 'worker-1', ['proposed', 'running', 'done', 'failed']),
    );
    expect(activity).toMatchObject({ proposed: 1, running: 1, done: 1, failed: 1 });
    expect(describeActivity(activity)).toBe('1 need review · 1 running · 1 done · 1 failed');
    expect(describeActivity(toWorkerActivity(batch('2', 'worker-1', [])))).toBe('nothing launched');
  });

  it('merges shifts and errands newest first, bounded', () => {
    const batches = {
      a: batch('1'),
      b: batch('2', 'worker-1', ['queued'], { task: 'errand' }),
      c: batch('3'),
    };
    expect(workerActivity(batches, 'worker-1').map((item) => item.orchestration.id)).toEqual([
      '3',
      '2',
      '1',
    ]);
    expect(workerActivity(batches, 'worker-1', 2)).toHaveLength(2);
  });

  it('merges every worker for the sidebar and drops fired workers', () => {
    const batches = { a: batch('1', 'worker-1'), b: batch('2', 'worker-2') };
    const roster = { 'worker-1': worker('worker-1') };
    const recent = recentWorkerActivity(batches, roster);
    // worker-2 was fired; its batch survives on disk but has no row to open.
    expect(recent.map((item) => item.workerId)).toEqual(['worker-1']);
    expect(recent[0].workerName).toBe('Spec Hygiene');
  });

  it('formats relative time against an injected clock', () => {
    const now = 10_000_000;
    expect(relativeTime(now, now)).toBe('just now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5m ago');
    expect(relativeTime(now - 3 * 60 * 60_000, now)).toBe('3h ago');
    expect(relativeTime(now - 2 * 24 * 60 * 60_000, now)).toBe('2d ago');
  });
});

describe('errand thread', () => {
  it('titles a shift by its number and an errand by what was typed', () => {
    // A shift's ledger title is "[Shift 3] <worker>", so stripping the prefix
    // used to leave the worker's name — every shift row read identically.
    expect(toWorkerActivity(batch('3', 'worker-1', [], { title: '[Shift 3] Warden' })).title).toBe(
      'Shift 3',
    );
    const errand = batch('4', 'worker-1', [], {
      task: 'errand',
      title: '[Errand] fallback title',
    });
    (errand.origin as any).errand = 'why did CI get slower\nsecond line';
    expect(toWorkerActivity(errand).title).toBe('why did CI get slower');
  });

});

describe('legacy errand detection', () => {
  it('reads the task off a pre-`task` batch title instead of assuming shift', () => {
    // The regression the user hit: errands sent before `origin.task` existed
    // rendered as "shift · Shift" and vanished from the thread entirely.
    const legacy = batch('1', 'worker-1', [], { title: '[Errand] what was my most recent email' });
    delete (legacy.origin as any).task;
    expect(orchestrationTask(legacy)).toBe('errand');
    expect(toWorkerActivity(legacy).title).toBe('what was my most recent email');
    expect(toWorkerActivity(legacy).ask).toBe('what was my most recent email');

    const shift = batch('2', 'worker-1', [], { title: '[Shift 2] Warden' });
    delete (shift.origin as any).task;
    expect(orchestrationTask(shift)).toBe('shift');
  });
});

describe('errand deliverable', () => {
  function withArtifacts(steps: string[], artifacts: Record<string, unknown>): FlowRun {
    return run('r', {
      flowSnapshot: { id: 'f', name: 'F', participants: [], steps: steps.map((o, i) => ({ id: `s${i}`, output: o })) },
      artifacts,
    });
  }

  it('takes the last step that actually produced something', () => {
    // The flow author's last declared output is the deliverable — not merely
    // the newest write, which on a rebound step can be an earlier artifact.
    const r = withArtifacts(['raw.md', 'report.md'], {
      'raw.md': { name: 'raw.md', kind: 'markdown', body: 'raw', producedAt: 99 },
      'report.md': { name: 'report.md', kind: 'markdown', body: 'the answer', producedAt: 2 },
    });
    expect(runDeliverable(r)?.name).toBe('report.md');
  });

  it('falls back down the steps when the last one never ran', () => {
    const r = withArtifacts(['raw.md', 'report.md'], {
      'raw.md': { name: 'raw.md', kind: 'markdown', body: 'raw', producedAt: 1 },
    });
    expect(runDeliverable(r)?.name).toBe('raw.md');
  });

  it('returns null when the run produced nothing', () => {
    expect(runDeliverable(withArtifacts(['report.md'], {}))).toBeNull();
  });
});

describe('worker files', () => {
  const files = [
    { name: '2026-08-16-1031-errand-why-is-ci-slow.md', path: `/root/2026-08-16-1031-errand-why-is-ci-slow.md`, bytes: 10, modifiedAt: 5 },
    { name: '2026-08-16-0645-shift-3-missing-coverage.md', path: `/root/2026-08-16-0645-shift-3-missing-coverage.md`, bytes: 10, modifiedAt: 9 },
    { name: 'baseline.json', path: `/root/baseline.json`, bytes: 10, modifiedAt: 7 },
    // Written before the date prefix existed — must still group correctly.
    { name: 'errand-run-the-tests-summary.md', path: `/root/errand-run-the-tests-summary.md`, bytes: 10, modifiedAt: 1 },
  ];

  const names = (group: { jobs: Array<{ files: Array<{ name: string }> }> }) =>
    group.jobs.flatMap((job) => job.files.map((f) => f.name));

  it('splits deliverables from the worker’s own notes, newest first', () => {
    const groups = groupWorkerFiles(files);
    expect(groups.map((g) => g.key)).toEqual(['errand', 'shift', 'notes']);
    // Within a group, most recent first — not the order the directory listed.
    expect(names(groups[0])).toEqual([
      '2026-08-16-1031-errand-why-is-ci-slow.md',
      'errand-run-the-tests-summary.md',
    ]);
    expect(names(groups[2])).toEqual(['baseline.json']);
  });

  it('drops groups with nothing in them', () => {
    expect(groupWorkerFiles([files[2]]).map((g) => g.key)).toEqual(['notes']);
    expect(groupWorkerFiles([])).toEqual([]);
  });

  it('searches across every group', () => {
    const groups = groupWorkerFiles(files, 'TESTS');
    expect(groups).toHaveLength(1);
    expect(names(groups[0])).toEqual(['errand-run-the-tests-summary.md']);
  });
});

describe('groupIntoJobs', () => {
  const folderFiles = [
    { name: '2026-08-16-1431-errand-coverage/report.md', path: '/r/a/report.md', bytes: 9, modifiedAt: 20 },
    { name: '2026-08-16-1431-errand-coverage/raw_test_output.md', path: '/r/a/raw.md', bytes: 10, modifiedAt: 22 },
    { name: '2026-08-16-1431-errand-coverage/verification.md', path: '/r/a/ver.md', bytes: 5, modifiedAt: 21 },
    { name: '2026-08-15-0900-errand-why-slow.md', path: '/r/b.md', bytes: 4, modifiedAt: 30 },
  ];

  it('folds a run’s directory into one job', () => {
    const jobs = groupIntoJobs(folderFiles);
    const folder = jobs.find((j) => j.folder);
    expect(folder?.files).toHaveLength(3);
    // Inside a job, name order — a report and the raw output it cites read as
    // a set, and recency between siblings written in the same second is noise.
    expect(folder?.files.map((f) => f.name.split('/')[1])).toEqual([
      'raw_test_output.md',
      'report.md',
      'verification.md',
    ]);
  });

  it('dates a job by its newest file', () => {
    const folder = groupIntoJobs(folderFiles).find((j) => j.folder);
    expect(folder?.at).toBe(22);
  });

  it('leaves a single-file run loose rather than in a folder of one', () => {
    const loose = groupIntoJobs(folderFiles).find((j) => !j.folder);
    expect(loose?.folder).toBe(false);
    expect(loose?.files).toHaveLength(1);
  });

  it('orders jobs newest first across both shapes', () => {
    expect(groupIntoJobs(folderFiles).map((j) => j.at)).toEqual([30, 22]);
  });

  it('labels a job by its folder, without the date or kind word', () => {
    const folder = groupIntoJobs(folderFiles).find((j) => j.folder);
    expect(folder?.label).toBe('coverage');
  });
});

describe('worker file names', () => {
  it('strips the date and kind for display but keeps a findable filename', () => {
    expect(workerFileLabel('2026-08-16-0645-shift-3-missing-coverage.md')).toBe(
      '3-missing-coverage.md',
    );
    expect(workerFileLabel('2026-08-16-1031-errand-why-is-ci-slow.md')).toBe('why-is-ci-slow.md');
    // Legacy names have no date to strip.
    expect(workerFileLabel('errand-run-the-tests.md')).toBe('run-the-tests.md');
  });

  it('shows an absolute date, dropping the year only within this one', () => {
    const now = new Date(2026, 7, 16, 12, 0).getTime();
    expect(fileDate(new Date(2026, 7, 16, 6, 45).getTime(), now)).toBe('Aug 16, 06:45');
    expect(fileDate(new Date(2025, 10, 2, 9, 5).getTime(), now)).toBe('Nov 2 2025');
  });
});

describe('the desk’s day', () => {
  const MON = new Date(2026, 7, 17, 9, 0).getTime();
  const MON_LATER = new Date(2026, 7, 17, 16, 30).getTime();
  const SUN = new Date(2026, 7, 16, 11, 0).getTime();
  const THU = new Date(2026, 7, 13, 11, 0).getTime();

  const items = [{ at: MON }, { at: MON_LATER }, { at: SUN }, { at: THU }];

  it('lists only days with work, newest first', () => {
    expect(deskDays(items)).toEqual([
      { at: startOfDay(MON), count: 2 },
      { at: startOfDay(SUN), count: 1 },
      { at: startOfDay(THU), count: 1 },
    ]);
  });

  it('takes one day’s turns', () => {
    expect(activityOnDay(items, startOfDay(MON))).toEqual([{ at: MON }, { at: MON_LATER }]);
  });

  it('reads down like a chat, whatever order the ledger arrived in', () => {
    // How the store actually holds them: hydrated newest-first on load, then
    // whatever landed this session spread onto the end as it happened. Reversing
    // that put the turn you had just sent above everything else.
    const store = [{ at: MON_LATER }, { at: SUN }, { at: THU }, { at: MON }];
    expect(deskTimeline(store, startOfDay(MON))).toEqual([{ at: MON }, { at: MON_LATER }]);
  });

  it('steps back to the previous day that had work, skipping the silence', () => {
    const days = deskDays(items);
    // Sunday → Thursday: Fri and Sat had nothing, and stepping through empty
    // days one at a time is not navigation.
    expect(adjacentDeskDay(days, startOfDay(SUN), -1)).toBe(startOfDay(THU));
  });

  it('steps forward to the nearest later day, not the newest', () => {
    const days = deskDays(items);
    expect(adjacentDeskDay(days, startOfDay(THU), 1)).toBe(startOfDay(SUN));
  });

  it('returns null at either end, which is what disables the arrow', () => {
    const days = deskDays(items);
    expect(adjacentDeskDay(days, startOfDay(THU), -1)).toBeNull();
    expect(adjacentDeskDay(days, startOfDay(MON), 1)).toBeNull();
  });

  it('walks back from a day with no work of its own', () => {
    const days = deskDays(items);
    const friday = startOfDay(new Date(2026, 7, 14, 12, 0).getTime());
    expect(adjacentDeskDay(days, friday, -1)).toBe(startOfDay(THU));
  });

  it('opens on today, whatever the worker last did', () => {
    expect(initialDeskDay(MON)).toBe(startOfDay(MON));
  });

  it('names the near days in words and the rest by date', () => {
    const dayMs = 24 * 60 * 60_000;
    expect(deskDayLabel(startOfDay(MON), MON)).toBe('Today');
    expect(deskDayLabel(startOfDay(MON - dayMs), MON)).toBe('Yesterday');
    expect(deskDayLabel(startOfDay(THU), MON)).toMatch(/Aug 13/);
  });
});

describe('orchestrationForRun', () => {
  const batch = {
    id: 'o1',
    title: '[Shift 2] Innovator',
    createdAt: 5,
    items: [
      { candidate: { id: 'c1', title: 'a' }, status: 'done', runId: 'run-a' },
      { candidate: { id: 'c2', title: 'b' }, status: 'failed', runId: 'run-b' },
    ],
  } as unknown as Orchestration;

  it('finds the batch a run belongs to', () => {
    expect(orchestrationForRun({ o1: batch }, 'run-b')?.id).toBe('o1');
  });

  it('returns null for a run no batch owns', () => {
    expect(orchestrationForRun({ o1: batch }, 'run-z')).toBeNull();
  });
});

describe('sidebarActivity', () => {
  const NOW = new Date(2026, 7, 17, 15, 0).getTime();
  const at = (t: number) => ({ at: t } as unknown as WorkerActivity);
  const todayEarly = new Date(2026, 7, 17, 9, 0).getTime();
  const todayLate = new Date(2026, 7, 17, 14, 0).getTime();
  const yesterday = new Date(2026, 7, 16, 14, 0).getTime();

  it('shows today’s turns, newest first, capped', () => {
    const items = [at(todayLate), at(todayEarly), at(yesterday)];
    expect(sidebarActivity(items, NOW, 4).map((i) => i.at)).toEqual([todayLate, todayEarly]);
    expect(sidebarActivity(items, NOW, 1).map((i) => i.at)).toEqual([todayLate]);
  });

  it('keeps one stale line when nothing happened today', () => {
    // A worker that worked yesterday must not read like one that has never
    // worked at all — the sidebar's job includes "what did each one do last".
    expect(sidebarActivity([at(yesterday)], NOW, 4).map((i) => i.at)).toEqual([yesterday]);
  });

  it('shows nothing for a worker that has never worked', () => {
    expect(sidebarActivity([], NOW, 4)).toEqual([]);
  });
});

describe('carriedOverTurns', () => {
  const TODAY = startOfDay(new Date(2026, 7, 17, 15, 0).getTime());
  const YESTERDAY = startOfDay(new Date(2026, 7, 16, 6, 0).getTime());
  const turn = (id: string, at: number, proposed: number) =>
    ({ orchestration: { id }, at, proposed } as unknown as WorkerActivity);
  const ids = (items: WorkerActivity[]) => items.map((i) => i.orchestration.id);

  it('carries an unanswered proposal forward onto today', () => {
    // The case this exists for: a clean desk this morning, and yesterday's
    // three parked candidates reachable only by guessing to press ‹.
    const items = [turn('yday', YESTERDAY + 3_600_000, 3)];
    expect(ids(carriedOverTurns(items, TODAY))).toEqual(['yday']);
  });

  it('leaves today’s own turns alone — they are already on the desk', () => {
    const items = [turn('today', TODAY + 3_600_000, 2)];
    expect(carriedOverTurns(items, TODAY)).toEqual([]);
  });

  it('ignores turns that owe you nothing', () => {
    const items = [turn('done', YESTERDAY + 3_600_000, 0)];
    expect(carriedOverTurns(items, TODAY)).toEqual([]);
  });

  it('is relative to the shown day, not to today', () => {
    // Stepping back to yesterday must not re-offer you the turn sitting in
    // the middle of the screen.
    const items = [
      turn('yday', YESTERDAY + 3_600_000, 1),
      turn('thu', startOfDay(new Date(2026, 7, 13, 11, 0).getTime()), 2),
    ];
    expect(ids(carriedOverTurns(items, YESTERDAY))).toEqual(['thu']);
  });

  it('is newest first, so the tray names the one you might still recognise', () => {
    const items = [
      turn('thu', startOfDay(new Date(2026, 7, 13, 11, 0).getTime()), 1),
      turn('yday', YESTERDAY + 3_600_000, 1),
    ];
    expect(ids(carriedOverTurns(items, TODAY))).toEqual(['yday', 'thu']);
  });
});

describe('sidebarShifts', () => {
  // Newest first, the order the sidebar hands them over in.
  const shift = (id: string, proposed = 0, running = 0) =>
    ({ orchestration: { id }, proposed, running } as unknown as WorkerActivity);
  const ids = (items: WorkerActivity[]) => items.map((i) => i.orchestration.id);

  it('keeps only the newest when every shift came up empty', () => {
    // The case that motivated this: a clock firing hourly, finding nothing,
    // and spending four rows to say so.
    const shifts = [shift('s8'), shift('s7'), shift('s6'), shift('s5')];
    expect(ids(sidebarShifts(shifts, 4))).toEqual(['s8']);
  });

  it('keeps older shifts that still owe you a decision', () => {
    const shifts = [shift('s8'), shift('s7', 3), shift('s6'), shift('s5', 0, 1)];
    expect(ids(sidebarShifts(shifts, 4))).toEqual(['s8', 's7', 's5']);
  });

  it('keeps the newest shift even when it launched nothing', () => {
    // "When did this one last wake up" is a question the roster answers even
    // when the answer is "and it found nothing".
    expect(ids(sidebarShifts([shift('s8'), shift('s7', 2)], 4))).toEqual([
      's8',
      's7',
    ]);
  });

  it('caps an implausible pile of unreviewed shifts', () => {
    const shifts = ['a', 'b', 'c', 'd', 'e'].map((id) => shift(id, 1));
    expect(ids(sidebarShifts(shifts, 4))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('shows nothing for a worker with no shifts today', () => {
    expect(sidebarShifts([], 4)).toEqual([]);
  });
});

describe('what an errand is called', () => {
  const batch = (reply: string, errand = 'can you give me a report of the coverage') =>
    ({
      id: 'o1',
      title: `[Errand] ${errand}`,
      createdAt: 1,
      items: [],
      producer: { reply },
      origin: { kind: 'worker', workerId: 'w1', workerName: 'W', task: 'errand', errand },
    }) as unknown as Orchestration;

  it('uses the worker’s own subject as the label', () => {
    const activity = toWorkerActivity(batch('<subject>Report coverage</subject>\n\nHere you go.'));
    expect(activity.title).toBe('Report coverage');
  });

  it('keeps your words as the message, whatever the worker called it', () => {
    const activity = toWorkerActivity(batch('<subject>Report coverage</subject>\n\nHere.'));
    expect(activity.ask).toBe('can you give me a report of the coverage');
  });

  it('falls back to what you typed when the worker named nothing', () => {
    // Every errand that predates the subject block lands here.
    expect(toWorkerActivity(batch('Here you go.')).title).toBe(
      'can you give me a report of the coverage',
    );
  });

  it('keeps the subject out of the prose', () => {
    expect(toWorkerActivity(batch('<subject>Report coverage</subject>\n\nHere.')).reply).toBe(
      'Here.',
    );
  });

  it('leaves a shift’s numbering alone and gives it no ask', () => {
    const shift = {
      id: 'o2',
      title: '[Shift 4] Warden',
      createdAt: 1,
      items: [],
      origin: { kind: 'worker', workerId: 'w1', workerName: 'W', task: 'shift' },
    } as unknown as Orchestration;
    const activity = toWorkerActivity(shift);
    expect(activity.title).toBe('Shift 4');
    expect(activity.ask).toBe('');
  });
});

describe('what a worker renders when you open it', () => {
  // Three mornings of the same daily job, each filed into its own folder,
  // plus the notes the worker keeps for itself.
  const files = [
    { name: '2026-08-17-0630-shift-3-morning-brief/dashboard.html', path: '/w/3/dashboard.html', bytes: 25_000, modifiedAt: 300 },
    { name: '2026-08-17-0630-shift-3-morning-brief/brief.md', path: '/w/3/brief.md', bytes: 5_000, modifiedAt: 299 },
    { name: '2026-08-16-1749-shift-2-morning-brief/dashboard.html', path: '/w/2/dashboard.html', bytes: 24_000, modifiedAt: 200 },
    { name: '2026-08-16-1749-shift-2-morning-brief/review.md', path: '/w/2/review.md', bytes: 7_000, modifiedAt: 199 },
    { name: 'baseline.json', path: '/w/baseline.json', bytes: 100, modifiedAt: 250 },
  ];

  it('lists each output once, not once per run that produced it', () => {
    expect(workerRenderableOutputs(files).map((f) => f.path)).toEqual(['/w/3/dashboard.html']);
  });

  it('opens the newest report by default', () => {
    expect(workerAutoRenderTarget(files, undefined)?.path).toBe('/w/3/dashboard.html');
    expect(workerAutoRenderTarget(files, 'newest')?.path).toBe('/w/3/dashboard.html');
  });

  it('opens nothing when the worker is set to off', () => {
    expect(workerAutoRenderTarget(files, 'off')).toBeNull();
  });

  it('never picks a markdown artifact — every job has several', () => {
    const proseOnly = files.filter((f) => f.name.endsWith('.md') || f.name.endsWith('.json'));
    expect(workerRenderableOutputs(proseOnly)).toEqual([]);
    expect(workerAutoRenderTarget(proseOnly, undefined)).toBeNull();
  });

  it('follows a pinned name to its newest copy, across job folders', () => {
    const withChart = [
      ...files,
      { name: '2026-08-16-1749-shift-2-morning-brief/chart.tsx', path: '/w/2/chart.tsx', bytes: 900, modifiedAt: 198 },
    ];
    expect(workerAutoRenderTarget(withChart, 'chart.tsx')?.path).toBe('/w/2/chart.tsx');
    expect(workerAutoRenderTarget(withChart, 'dashboard.html')?.path).toBe('/w/3/dashboard.html');
  });

  it('opens nothing rather than something else when the pinned output is gone', () => {
    // Substituting the newest report here would render a page the user never
    // asked for and label it as the thing they pinned.
    expect(workerAutoRenderTarget(files, 'chart.tsx')).toBeNull();
  });

  it('has nothing to open for a worker that only ever writes prose', () => {
    expect(workerAutoRenderTarget([], undefined)).toBeNull();
  });
});

describe('resolveWorkerFilePath', () => {
  const files = [
    { name: 'design.md', path: '/wf/worker-1/design.md', bytes: 1, modifiedAt: 1 },
    { name: 'baseline.md', path: '/wf/worker-1/notes/baseline.md', bytes: 1, modifiedAt: 1 },
  ];

  it('resolves a bare filename against the worker own directory', () => {
    // What a worker actually writes: it saved the thing, and it calls it by
    // the name it gave it. Opened as a project-relative path it is nowhere,
    // which is why clicking it did nothing at all.
    expect(resolveWorkerFilePath('design.md', files)).toBe('/wf/worker-1/design.md');
  });

  it('resolves a name carrying enough folder to be unambiguous', () => {
    expect(resolveWorkerFilePath('notes/baseline.md', files)).toBe('/wf/worker-1/notes/baseline.md');
  });

  it('keeps a line suffix so the reference still points at the line', () => {
    expect(resolveWorkerFilePath('design.md:42', files)).toBe('/wf/worker-1/design.md:42');
    expect(resolveWorkerFilePath('design.md:10-20', files)).toBe('/wf/worker-1/design.md:10-20');
  });

  it('leaves an absolute path alone', () => {
    expect(resolveWorkerFilePath('/etc/hosts', files)).toBe('/etc/hosts');
  });

  it('declines a path that is not one of its files, so the repo still resolves', () => {
    // A worker citing `src/main.ts` means the project, and that reference has
    // to keep working — the caller falls back to opening it as given.
    expect(resolveWorkerFilePath('src/main.ts', files)).toBeNull();
    expect(resolveWorkerFilePath('', files)).toBeNull();
  });
});
