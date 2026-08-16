import { describe, expect, it } from 'vitest';
import {
  computeWorkerScorecard,
  demotedTrust,
  describeWorker,
  moveInRoster,
  parseWorkerContract,
  parseWorkerSubject,
  sortRoster,
  rejectionStreak,
  stripWorkerSubject,
  WORKER_SUBJECT_MAX,
  validateWorker,
  workerAutoApproveCap,
  type Worker,
  type WorkerJournalEntry,
} from './worker';

function makeWorker(overrides: Partial<Worker> = {}): Worker {
  return {
    id: 'worker-1',
    name: 'Scout',
    jobDescription: 'Review incoming work and prioritize useful maintenance.',
    projectPath: '/tmp/project',
    cadence: { kind: 'daily', time: '09:00' },
    trust: 'autonomous',
    caps: { maxItemsPerShift: 3, runIn: 'worktree' },
    budgetUSDPerMonth: 10,
    heartbeatModel: 'gpt-5',
    flowIds: ['flow-1'],
    enabled: true,
    createdAt: 1,
    ...overrides,
  };
}

describe('worker', () => {
  it('accepts a valid worker', () => {
    expect(validateWorker(makeWorker())).toBeNull();
  });

  it('requires a name', () => {
    expect(validateWorker(makeWorker({ name: '' }))).toBe('Give the worker a name.');
  });

  it('requires a sufficiently detailed job description', () => {
    expect(validateWorker(makeWorker({ jobDescription: 'too short' }))).toBe(
      'A job description needs at least 20 characters — the worker plans its own shifts from it.',
    );
  });

  it('caps items per shift', () => {
    expect(validateWorker(makeWorker({ caps: { maxItemsPerShift: 6, runIn: 'worktree' } }))).toBe(
      'A shift is capped at 5 items.',
    );
  });

  it('only lets autonomous workers run in the working copy', () => {
    expect(validateWorker(makeWorker({ trust: 'probation', caps: { maxItemsPerShift: 3, runIn: 'cwd' } }))).toBe(
      'Only an autonomous worker may run in the working copy.',
    );
  });

  it('requires selected days when days are supplied', () => {
    expect(validateWorker(makeWorker({ cadence: { kind: 'daily', time: '09:00', days: [] } }))).toBe(
      'Pick at least one day, or leave every day selected.',
    );
  });

  it('limits interval cadence frequency', () => {
    expect(validateWorker(makeWorker({ cadence: { kind: 'interval', everyMinutes: 5 } }))).toBe(
      'A worker shift can be no more often than every 15 minutes.',
    );
  });

  it('requires a 24-hour daily time', () => {
    expect(validateWorker(makeWorker({ cadence: { kind: 'daily', time: '9am' } }))).toBe(
      'Time must look like 09:30.',
    );
  });

  it('caps unattended launches by trust level', () => {
    expect(workerAutoApproveCap({ trust: 'probation', caps: { maxItemsPerShift: 5, runIn: 'worktree' } })).toBe(0);
    expect(workerAutoApproveCap({ trust: 'trusted', caps: { maxItemsPerShift: 5, runIn: 'worktree' } })).toBe(2);
    expect(workerAutoApproveCap({ trust: 'autonomous', caps: { maxItemsPerShift: 5, runIn: 'worktree' } })).toBe(5);
  });

  it('describes a worker', () => {
    expect(
      describeWorker(
        makeWorker({
          name: 'Scout',
          trust: 'probation',
          caps: { maxItemsPerShift: 3, runIn: 'worktree' },
        }),
      ),
    ).toBe('Scout — probation, 3 items/shift');
  });

  it('accepts a single-digit hour, same as the scheduler will execute', () => {
    expect(validateWorker(makeWorker({ cadence: { kind: 'daily', time: '9:30' } }))).toBeNull();
  });

  it('rejects a fractional items-per-shift cap', () => {
    expect(
      validateWorker(makeWorker({ caps: { maxItemsPerShift: 2.5, runIn: 'worktree' } })),
    ).toBe('A shift must allow at least one item.');
  });

  it('rejects an interval longer than its active window', () => {
    expect(
      validateWorker(
        makeWorker({
          cadence: {
            kind: 'interval',
            everyMinutes: 480,
            window: { start: '09:00', end: '10:00' },
          },
        }),
      ),
    ).toBe('That interval is longer than the 60-minute window, so it would only fire once a day.');
  });
});

describe('trust ladder helpers', () => {
  it('demotes one step with probation as the floor', () => {
    expect(demotedTrust('autonomous')).toBe('trusted');
    expect(demotedTrust('trusted')).toBe('probation');
    expect(demotedTrust('probation')).toBe('probation');
  });

  it('counts the leading rejection streak among explicit verdicts only', () => {
    const e = (kind: WorkerJournalEntry['kind']) => ({ kind });
    expect(rejectionStreak([])).toBe(0);
    expect(rejectionStreak([e('rejected'), e('shift'), e('rejected'), e('approved'), e('rejected')])).toBe(2);
    expect(rejectionStreak([e('approved'), e('rejected')])).toBe(0);
    expect(rejectionStreak([e('proposed'), e('completed'), e('rejected')])).toBe(1);
    // A demotion spends the streak — older rejections don't count again.
    expect(rejectionStreak([e('rejected'), e('demoted'), e('rejected'), e('rejected')])).toBe(1);
    // An errand records a request, not a verdict, so it does not reset the
    // rejection streak that drives trust demotion.
    expect(rejectionStreak([e('rejected'), e('errand'), e('rejected')])).toBe(2);
  });

  it('keeps errand entries out of worker scorecard totals', () => {
    const card = computeWorkerScorecard([{ kind: 'errand' }], 0);
    expect(card).toMatchObject({
      proposed: 0,
      approved: 0,
      rejected: 0,
      completed: 0,
      failed: 0,
      rejectionStreak: 0,
    });
  });

  it('computes a scorecard from journal entries and spend', () => {
    const e = (kind: WorkerJournalEntry['kind']) => ({ kind });
    // Newest first: the latest verdict is a rejection, then an older approval.
    const card = computeWorkerScorecard(
      [e('proposed'), e('rejected'), e('proposed'), e('approved'), e('completed'), e('failed')],
      4,
    );
    expect(card).toMatchObject({
      proposed: 2,
      approved: 1,
      rejected: 1,
      completed: 1,
      failed: 1,
      spentThisMonthUSD: 4,
      costPerCompletedUSD: 4,
      rejectionStreak: 1,
    });
    expect(computeWorkerScorecard([], 0).costPerCompletedUSD).toBeNull();
  });
});

describe('parseWorkerContract', () => {
  const opts = { knownFlowIds: ['fix-it'], defaultHeartbeatModel: 'cheap-model' };

  it('parses a well-formed contract block', () => {
    const reply = [
      'Here is my read on the job.',
      '<worker>',
      JSON.stringify({
        name: 'Scout',
        jobDescription: 'Find valuable maintenance work each morning and propose it.',
        cadence: { kind: 'daily', time: '07:30', days: [1, 2, 3, 4, 5] },
        maxItemsPerShift: 2,
        budgetUSDPerMonth: 15,
        heartbeatModel: 'tiny-model',
        flowId: 'fix-it',
      }),
      '</worker>',
    ].join('\n');
    expect(parseWorkerContract(reply, opts)).toEqual({
      name: 'Scout',
      jobDescription: 'Find valuable maintenance work each morning and propose it.',
      cadence: { kind: 'daily', time: '07:30', days: [1, 2, 3, 4, 5] },
      maxItemsPerShift: 2,
      budgetUSDPerMonth: 15,
      heartbeatModel: 'tiny-model',
      flowId: 'fix-it',
      flowRequest: undefined,
    });
  });

  it('clamps out-of-range numbers and drops unknown flow ids', () => {
    const reply = `<worker>${JSON.stringify({
      name: 'Maximalist',
      jobDescription: 'Do everything, constantly, at any cost.',
      cadence: { kind: 'interval', everyMinutes: 1 },
      maxItemsPerShift: 50,
      budgetUSDPerMonth: -3,
      flowId: 'not-a-real-flow',
    })}</worker>`;
    const contract = parseWorkerContract(reply, opts)!;
    expect(contract.maxItemsPerShift).toBe(5);
    expect(contract.budgetUSDPerMonth).toBe(10);
    expect(contract.heartbeatModel).toBe('cheap-model');
    expect(contract.flowId).toBeUndefined();
    expect(contract.cadence).toEqual({ kind: 'interval', everyMinutes: 15, days: undefined, window: undefined });
  });

  it('falls back to the default cadence when the block omits or mangles it', () => {
    const reply = `<worker>${JSON.stringify({
      name: 'Vague',
      jobDescription: 'A job with no schedule in mind.',
      cadence: { kind: 'hourly' },
    })}</worker>`;
    expect(parseWorkerContract(reply, opts)!.cadence).toEqual({
      kind: 'daily',
      time: '09:00',
      days: [1, 2, 3, 4, 5],
    });
  });

  it('returns null when nothing parseable exists', () => {
    expect(parseWorkerContract('no block here at all', opts)).toBeNull();
    expect(parseWorkerContract('<worker>{not json}</worker>', opts)).toBeNull();
  });

  it('keeps a known project suggestion and drops a hallucinated one', () => {
    const block = (projectPath: string) =>
      `<worker>${JSON.stringify({
        name: 'Scout',
        jobDescription: 'Watch the unifyr workspace for drift and propose fixes.',
        projectPath,
      })}</worker>`;
    const withProjects = { ...opts, knownProjectPaths: ['/repos/unifyr'] };
    expect(parseWorkerContract(block('/repos/unifyr'), withProjects)!.projectPath).toBe(
      '/repos/unifyr',
    );
    expect(
      parseWorkerContract(block('/made/up/path'), withProjects)!.projectPath,
    ).toBeUndefined();
    // Without a known list, every suggestion is dropped rather than trusted.
    expect(parseWorkerContract(block('/repos/unifyr'), opts)!.projectPath).toBeUndefined();
  });
});

describe('parseWorkerSubject', () => {
  it('takes the worker’s own name for the errand', () => {
    expect(parseWorkerSubject('<subject>Report ZiftProcessor test coverage</subject>\n\nHere…')).toBe(
      'Report ZiftProcessor test coverage',
    );
  });

  it('is absent when the worker did not name it', () => {
    expect(parseWorkerSubject('I had a look and here is what I found.')).toBeNull();
    expect(parseWorkerSubject('<subject>   </subject>')).toBeNull();
  });

  it('takes one line only, and drops quoting the model adds', () => {
    expect(parseWorkerSubject('<subject>"Run the suite"\nand more</subject>')).toBe(
      'Run the suite',
    );
  });

  it('truncates a subject that is a sentence rather than a title', () => {
    const long = 'x'.repeat(WORKER_SUBJECT_MAX + 20);
    const parsed = parseWorkerSubject(`<subject>${long}</subject>`);
    expect(parsed).toHaveLength(WORKER_SUBJECT_MAX);
    expect(parsed?.endsWith('…')).toBe(true);
  });

  it('strips the block from the prose, since the label renders separately', () => {
    expect(stripWorkerSubject('<subject>A title</subject>\n\nThe answer.')).toBe('The answer.');
  });
});

describe('sortRoster', () => {
  const w = (id: string, createdAt: number, order?: number) =>
    ({ id, createdAt, order }) as unknown as Worker;

  it('reads arranged workers first, then the rest newest-hired first', () => {
    const roster = [w('new', 30), w('chief', 10, 0), w('old', 20)];
    expect(sortRoster(roster).map((x) => x.id)).toEqual(['chief', 'new', 'old']);
  });

  it('leaves an unarranged roster in hire order', () => {
    expect(sortRoster([w('a', 1), w('b', 3), w('c', 2)]).map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('moveInRoster', () => {
  const w = (id: string, createdAt: number, order?: number) =>
    ({ id, createdAt, order }) as unknown as Worker;
  const roster = [w('a', 30), w('b', 20), w('c', 10)];

  it('swaps a worker with the one above it', () => {
    expect(moveInRoster(roster, 'b', -1)).toEqual(['b', 'a', 'c']);
  });

  it('swaps a worker with the one below it', () => {
    expect(moveInRoster(roster, 'a', 1)).toEqual(['b', 'a', 'c']);
  });

  it('refuses to move off either end', () => {
    expect(moveInRoster(roster, 'a', -1)).toEqual(['a', 'b', 'c']);
    expect(moveInRoster(roster, 'c', 1)).toEqual(['a', 'b', 'c']);
  });

  it('returns every id, so the saved order is explicit rather than a delta', () => {
    // Otherwise the next hire would land wherever hire-date sorting put it,
    // silently jumping a queue the user arranged by hand.
    expect(moveInRoster(roster, 'c', -1)).toHaveLength(3);
  });

  it('is a no-op for an id that is not on the roster', () => {
    expect(moveInRoster(roster, 'gone', -1)).toEqual(['a', 'b', 'c']);
  });
});
