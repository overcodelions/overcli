import { describe, expect, it } from 'vitest';
import {
  hireAnswerText,
  parseHireQuestions,
  computeWorkerScorecard,
  demotedTrust,
  coerceCadence,
  describeCadence,
  describeWorker,
  moveInRoster,
  placeInRoster,
  parseWorkerContract,
  parseWorkerSubject,
  benchRoster,
  moveWithinGroup,
  sortRoster,
  rejectionStreak,
  stripWorkerSubject,
  WORKER_SUBJECT_MAX,
  validateWorker,
  workerAutoApproveCap,
  workerOrigin,
  canDelegate,
  delegationTargets,
  parseDirectRun,
  handoffNotBefore,
  parseHandoffs,
  resolveHandoffTarget,
  rosterLine,
  stripHandoffs,
  WORKER_ROSTER_LINE_MAX,
  WORKER_TAGLINE_MAX,
  workerErrandStarters,
  workerTagline,
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

  it('accepts a worker with no cadence at all — a desk, not a rota', () => {
    expect(validateWorker(makeWorker({ cadence: null }))).toBeNull();
  });

  it('still rejects an ABSENT cadence, which is a malformed record', () => {
    expect(validateWorker(makeWorker({ cadence: undefined }))).toBe('Pick when this worker works.');
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
      flows: [{ flowId: 'fix-it' }],
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
    expect(contract.flows).toEqual([]);
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

  it('keeps the errand starters the drafter wrote, cleaned and capped', () => {
    const reply = `<worker>${JSON.stringify({
      name: 'Scout',
      jobDescription: 'Watch the acme build for failures.',
      errandStarters: ['  what is\n  stuck? ', '', 42, 'recheck this morning', 'three', 'four'],
    })}</worker>`;
    expect(parseWorkerContract(reply, opts)!.errandStarters).toEqual([
      'what is stuck?',
      'recheck this morning',
      'three',
    ]);
  });

  it('leaves errand starters unset when none are usable', () => {
    const block = (errandStarters: unknown) =>
      `<worker>${JSON.stringify({ name: 'Scout', jobDescription: 'Job.', errandStarters })}</worker>`;
    expect(parseWorkerContract(block(['  ', '']), opts)!.errandStarters).toBeUndefined();
    expect(parseWorkerContract(block('what is stuck?'), opts)!.errandStarters).toBeUndefined();
    expect(parseWorkerContract(block(undefined), opts)!.errandStarters).toBeUndefined();
  });

  it('returns null when nothing parseable exists', () => {
    expect(parseWorkerContract('no block here at all', opts)).toBeNull();
    expect(parseWorkerContract('<worker>{not json}</worker>', opts)).toBeNull();
  });

  it('keeps a known project suggestion and drops a hallucinated one', () => {
    const block = (projectPath: string) =>
      `<worker>${JSON.stringify({
        name: 'Scout',
        jobDescription: 'Watch the acme workspace for drift and propose fixes.',
        projectPath,
      })}</worker>`;
    const withProjects = { ...opts, knownProjectPaths: ['/repos/acme'] };
    expect(parseWorkerContract(block('/repos/acme'), withProjects)!.projectPath).toBe(
      '/repos/acme',
    );
    expect(
      parseWorkerContract(block('/made/up/path'), withProjects)!.projectPath,
    ).toBeUndefined();
    // Without a known list, every suggestion is dropped rather than trusted.
    expect(parseWorkerContract(block('/repos/acme'), opts)!.projectPath).toBeUndefined();
  });
});

describe('parseWorkerSubject', () => {
  it('takes the worker’s own name for the errand', () => {
    expect(parseWorkerSubject('<subject>Report parser test coverage</subject>\n\nHere…')).toBe(
      'Report parser test coverage',
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

describe('benchRoster', () => {
  const w = (id: string, createdAt: number, enabled: boolean, order?: number) =>
    ({ id, createdAt, enabled, order }) as unknown as Worker;

  it('puts paused workers below the ones that run', () => {
    const roster = [w('idle', 40, false), w('runs', 30, true), w('also-idle', 20, false)];
    const { active, benched } = benchRoster(roster);
    expect(active.map((x) => x.id)).toEqual(['runs']);
    expect(benched.map((x) => x.id)).toEqual(['idle', 'also-idle']);
  });

  it('keeps the arranged order within each group', () => {
    // Pausing a worker must not lose the position you dragged it to: `first`
    // stays ahead of `second` on the bench.
    const roster = [w('second', 10, false, 1), w('active', 20, true, 2), w('first', 30, false, 0)];
    const { active, benched } = benchRoster(roster);
    expect(benched.map((x) => x.id)).toEqual(['first', 'second']);
    expect(active.map((x) => x.id)).toEqual(['active']);
  });

  it('handles an all-active and an all-benched roster', () => {
    expect(benchRoster([w('a', 1, true)]).benched).toEqual([]);
    expect(benchRoster([w('a', 1, false)]).active).toEqual([]);
  });
});

describe('moveWithinGroup', () => {
  const w = (id: string) => ({ id }) as unknown as Worker;
  // Displayed as active [a, c] and bench [b, d].
  const flat = [w('a'), w('b'), w('c'), w('d')];
  const active = [w('a'), w('c')];
  const bench = [w('b'), w('d')];

  it('trades with the neighbour in the SAME group, not the flat list', () => {
    // `d` up must land before `b` (its bench neighbour), not before `c`.
    expect(moveWithinGroup(flat, bench, 'd', -1)).toBe(1);
    // `a` down must land after `c`, skipping the benched `b` between them.
    expect(moveWithinGroup(flat, active, 'a', 1)).toBe(3);
  });

  it('returns null at either end of a group', () => {
    expect(moveWithinGroup(flat, bench, 'b', -1)).toBeNull();
    expect(moveWithinGroup(flat, bench, 'd', 1)).toBeNull();
  });

  it('returns null for a worker that is not in the group', () => {
    expect(moveWithinGroup(flat, bench, 'a', 1)).toBeNull();
  });
});

describe('placeInRoster', () => {
  const w = (id: string, createdAt: number, order?: number) =>
    ({ id, createdAt, order }) as unknown as Worker;
  // Hire dates descending, so the unarranged order is a, b, c, d.
  const roster = [w('a', 40), w('b', 30), w('c', 20), w('d', 10)];

  it('drops into the gap the indicator was drawn in, above and below', () => {
    expect(placeInRoster(roster, 'd', 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(placeInRoster(roster, 'a', 4)).toEqual(['b', 'c', 'd', 'a']);
  });

  it('resolves the gap against the list as it was drawn, not as it will be', () => {
    // Gap 3 is between c and d. Dragging `a` there must land it after c —
    // the naive splice (which forgets `a` leaves a hole above the gap) puts
    // it between b and c instead.
    expect(placeInRoster(roster, 'a', 3)).toEqual(['b', 'c', 'a', 'd']);
    // Dragging upward needs no correction: gap 1 is below a, above b.
    expect(placeInRoster(roster, 'c', 1)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('is a no-op for the gaps either side of the dragged row', () => {
    expect(placeInRoster(roster, 'b', 1)).toEqual(['a', 'b', 'c', 'd']);
    expect(placeInRoster(roster, 'b', 2)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('clamps a gap past either end and ignores an unknown id', () => {
    expect(placeInRoster(roster, 'b', 99)).toEqual(['a', 'c', 'd', 'b']);
    expect(placeInRoster(roster, 'b', -3)).toEqual(['b', 'a', 'c', 'd']);
    expect(placeInRoster(roster, 'nobody', 0)).toEqual(['a', 'b', 'c', 'd']);
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

describe('parseWorkerContract — heartbeat backend', () => {
  const opts = {
    knownFlowIds: ['fix-it'],
    defaultHeartbeatModel: 'gpt-5.6-luna',
    defaultHeartbeatBackend: 'codex' as const,
  };

  it('stamps the backend the hire actually ran on', () => {
    // The model never emits this — the caller knows which CLI it just ran, so
    // the pair is complete from the moment of hire.
    const c = parseWorkerContract(
      '<worker>{"name":"Scout","jobDescription":"Watch the release branch each morning."}</worker>',
      opts,
    );
    expect(c?.heartbeatBackend).toBe('codex');
    expect(c?.heartbeatModel).toBe('gpt-5.6-luna');
  });

  it('leaves it unset when the caller does not supply one', () => {
    const c = parseWorkerContract(
      '<worker>{"name":"Scout","jobDescription":"Watch the release branch each morning."}</worker>',
      { knownFlowIds: ['fix-it'], defaultHeartbeatModel: 'cheap-model' },
    );
    expect(c?.heartbeatBackend).toBeUndefined();
  });
});

describe('workerOrigin', () => {
  it('carries the external-action capability when the worker has it', () => {
    const w = makeWorker({ caps: { maxItemsPerShift: 1, runIn: 'worktree', allowExternalActions: true } });
    expect(workerOrigin(w, 'shift')).toEqual({
      kind: 'worker',
      workerId: 'worker-1',
      workerName: 'Scout',
      task: 'shift',
      allowExternalActions: true,
    });
  });

  it('omits the capability rather than stamping false, so older batches read the same', () => {
    const origin = workerOrigin(makeWorker(), 'shift');
    expect('allowExternalActions' in origin).toBe(false);
  });

  it('keeps the typed instruction on an errand, alongside the capability', () => {
    const w = makeWorker({ caps: { maxItemsPerShift: 1, runIn: 'cwd', allowExternalActions: true } });
    expect(workerOrigin(w, 'errand', 'post the digest')).toEqual({
      kind: 'worker',
      workerId: 'worker-1',
      workerName: 'Scout',
      task: 'errand',
      errand: 'post the digest',
      allowExternalActions: true,
    });
  });

  it('omits errand entirely when none was typed', () => {
    expect('errand' in workerOrigin(makeWorker(), 'errand')).toBe(false);
  });
});

describe('delegation', () => {
  it('needs the capability AND a trust level that acts unattended', () => {
    expect(canDelegate(makeWorker({ caps: { maxItemsPerShift: 3, runIn: 'worktree' } }))).toBe(
      false,
    );
    expect(
      canDelegate(
        makeWorker({ caps: { maxItemsPerShift: 3, runIn: 'worktree', canDelegate: true } }),
      ),
    ).toBe(true);
  });

  /// The laundering case, and the reason the trust half exists: a worker whose
  /// every proposal parks for approval must not be able to get work moving by
  /// handing it to a colleague who launches unattended.
  it('refuses a worker on probation even with the capability set', () => {
    expect(
      canDelegate(
        makeWorker({
          trust: 'probation',
          caps: { maxItemsPerShift: 3, runIn: 'worktree', canDelegate: true },
        }),
      ),
    ).toBe(false);
  });

  const delegator = (over: Partial<Worker> = {}) =>
    makeWorker({
      caps: { maxItemsPerShift: 3, runIn: 'worktree', canDelegate: true },
      ...over,
    });

  it('offers only enabled colleagues on the same project', () => {
    const targets = delegationTargets(delegator(), [
      makeWorker({ id: 'worker-1', name: 'Scout' }),
      makeWorker({ id: 'triage', name: 'Triage' }),
      makeWorker({ id: 'paused', name: 'Paused', enabled: false }),
      makeWorker({ id: 'elsewhere', name: 'Triage', projectPath: '/other' }),
    ]);
    expect(targets.map((t) => t.id)).toEqual(['triage']);
  });

  /// Two workspaces can each employ a "Triage". A name is all a handoff has to
  /// go on, so the off-project one must never be nameable in the first place.
  it('keeps a same-named worker on another project out of reach', () => {
    const targets = delegationTargets(delegator(), [
      makeWorker({ id: 'elsewhere', name: 'Triage', projectPath: '/other' }),
    ]);
    expect(targets).toEqual([]);
    expect(resolveHandoffTarget('Triage', targets)).toBeNull();
  });

  it('honours an explicit narrowing and ignores an empty one', () => {
    const roster = [
      makeWorker({ id: 'triage', name: 'Triage' }),
      makeWorker({ id: 'warden', name: 'Warden' }),
    ];
    expect(
      delegationTargets(delegator({ delegatesTo: ['warden'] }), roster).map((t) => t.id),
    ).toEqual(['warden']);
    expect(delegationTargets(delegator({ delegatesTo: [] }), roster).map((t) => t.id)).toEqual([
      'triage',
      'warden',
    ]);
  });

  /// A team is who you put on it. Picking by id is what makes reaching across
  /// projects safe: only the chosen colleagues are nameable.
  it('reaches a picked colleague on another project, and only picked ones', () => {
    const roster = [
      makeWorker({ id: 'elsewhere', name: 'Chief of Staff', projectPath: '/other' }),
      makeWorker({ id: 'stranger', name: 'Stranger', projectPath: '/other' }),
      makeWorker({ id: 'triage', name: 'Triage' }),
    ];
    expect(
      delegationTargets(delegator({ delegatesTo: ['elsewhere', 'triage'] }), roster)
        .map((t) => t.id)
        .sort(),
    ).toEqual(['elsewhere', 'triage']);
    expect(delegationTargets(delegator(), roster).map((t) => t.id)).toEqual(['triage']);
  });

  it('offers nothing to a worker that may not delegate', () => {
    expect(delegationTargets(makeWorker(), [makeWorker({ id: 'triage', name: 'Triage' })])).toEqual(
      [],
    );
  });

  it('matches a colleague name case- and space-insensitively', () => {
    const targets = [makeWorker({ id: 'triage', name: 'Triage' })];
    expect(resolveHandoffTarget('  triage ', targets)?.id).toBe('triage');
    expect(resolveHandoffTarget('Ticket Triage', targets)).toBeNull();
  });

  /// Sending real work to a coin flip is worse than reporting a clash the user
  /// can fix by renaming.
  it('refuses to guess between two colleagues sharing a name', () => {
    const targets = [
      makeWorker({ id: 'a', name: 'Triage' }),
      makeWorker({ id: 'b', name: 'Triage' }),
    ];
    expect(resolveHandoffTarget('Triage', targets)).toBeNull();
  });

  it('parses handoff blocks and strips them from the prose', () => {
    const reply = [
      'I found two things that are not mine.',
      '<handoff to="Triage">XYZ-6814 bundles six issues. Split it.</handoff>',
      "<handoff to='Warden'>Check the release.</handoff>",
    ].join('\n');
    expect(parseHandoffs(reply)).toEqual([
      { to: 'Triage', instruction: 'XYZ-6814 bundles six issues. Split it.' },
      { to: 'Warden', instruction: 'Check the release.' },
    ]);
    expect(stripHandoffs(reply)).toBe('I found two things that are not mine.');
  });

  it('reads the day a handoff should arrive, quoted or not', () => {
    expect(parseHandoffs('<handoff to="Chief of Staff" on="2026-10-13">Remind the team.</handoff>')).toEqual([
      { to: 'Chief of Staff', instruction: 'Remind the team.', on: '2026-10-13' },
    ]);
    expect(parseHandoffs('<handoff to=Ticket Triage on=2026-10-13>Split it.</handoff>')).toEqual([
      { to: 'Ticket Triage', instruction: 'Split it.', on: '2026-10-13' },
    ]);
    expect(parseHandoffs('<handoff to=Ticket Triage>Split it.</handoff>')).toEqual([
      { to: 'Ticket Triage', instruction: 'Split it.' },
    ]);
  });

  it('holds a dated handoff until 09:00 that day, and refuses what is not a day', () => {
    const now = new Date(2026, 8, 25, 14, 0).getTime();
    expect(handoffNotBefore(undefined, now)).toBeNull();
    expect(handoffNotBefore('2026-10-13', now)).toBe(new Date(2026, 9, 13, 9, 0).getTime());
    expect(handoffNotBefore('2026-10-13 16:30', now)).toBe(new Date(2026, 9, 13, 16, 30).getTime());
    // Already past: send it now rather than never.
    expect(handoffNotBefore('2026-09-01', now)).toBeNull();
    expect(handoffNotBefore('2026-02-31', now)).toBe('invalid');
    expect(handoffNotBefore('next week', now)).toBe('invalid');
    expect(handoffNotBefore('2031-01-01', now)).toBe('invalid');
  });

  it('ignores a handoff with no target or no instruction', () => {
    expect(parseHandoffs('<handoff to="">do a thing</handoff>')).toEqual([]);
    expect(parseHandoffs('<handoff to="Triage"></handoff>')).toEqual([]);
    expect(parseHandoffs('no blocks here')).toEqual([]);
  });

  /// "You are the Test Warden." names the worker without saying what it does,
  /// and a router given only that has nothing to route on.
  it('pulls in the next sentence when the opening one is a bare title', () => {
    const line = rosterLine({
      name: 'Triage',
      jobDescription:
        'You are the Ticket Triage Worker. Every weekday morning, find and solve the open tickets. Then file a report nobody asked for.',
    });
    expect(line).toContain('You are the Ticket Triage Worker.');
    expect(line).toContain('find and solve the open tickets');
  });

  it('bounds a roster line so a long job description cannot flood the prompt', () => {
    const line = rosterLine({ name: 'Verbose', jobDescription: 'x'.repeat(4000) });
    expect(line.length).toBeLessThanOrEqual('Verbose — '.length + WORKER_ROSTER_LINE_MAX);
  });

  it('stamps the sender onto a delegated errand and omits it otherwise', () => {
    const from = { workerId: 'boss', workerName: 'Chief of Staff' };
    expect(workerOrigin(makeWorker(), 'errand', 'do it', from).from).toEqual(from);
    expect('from' in workerOrigin(makeWorker(), 'errand', 'do it')).toBe(false);
  });
});

describe('workerTagline', () => {
  it('prefers the worker\'s own tagline', () => {
    expect(workerTagline(makeWorker({ tagline: 'the overcli innovator' }))).toBe(
      'the overcli innovator',
    );
  });

  it('derives one from the job description when the worker has none', () => {
    expect(
      workerTagline(
        makeWorker({
          jobDescription: 'You are the release warden. Each morning, check the tag pipeline.',
        }),
      ),
    ).toBe('release warden');
  });

  it('takes the persona half of a colon-introduced brief', () => {
    expect(
      workerTagline(
        makeWorker({
          jobDescription:
            "You're the Support Triage Worker: read new tickets each morning and reproduce what you can.",
        }),
      ),
    ).toBe('Support Triage Worker');
  });

  it('reads only the first line of a multi-line brief', () => {
    expect(
      workerTagline(makeWorker({ jobDescription: 'Watch CI for flakes\n\n- file each one' })),
    ).toBe('Watch CI for flakes');
  });

  it('clamps a long tagline on a word boundary', () => {
    const long = workerTagline(makeWorker({ tagline: 'a '.repeat(60) + 'end' }));
    expect(long.length).toBeLessThanOrEqual(WORKER_TAGLINE_MAX + 1);
    expect(long.endsWith('\u2026')).toBe(true);
    expect(long).not.toContain('  ');
  });

  it('says nothing when there is nothing to say', () => {
    expect(workerTagline({ jobDescription: '' })).toBe('');
    expect(workerTagline({ tagline: '   ', jobDescription: '  ' })).toBe('');
  });

  it('carries a tagline through a parsed hire contract', () => {
    const reply = `<worker>${JSON.stringify({
      name: 'Prometheus',
      tagline: 'the overcli innovator',
      jobDescription: 'Propose one capability a shift.',
    })}</worker>`;
    expect(parseWorkerContract(reply, { knownFlowIds: [], defaultHeartbeatModel: 'm' })?.tagline)
      .toBe('the overcli innovator');
  });
});


describe('on-demand cadence', () => {
  it('reads an explicit null or the on-demand marker as no clock', () => {
    expect(coerceCadence(null)).toBeNull();
    expect(coerceCadence('onDemand')).toBeNull();
    expect(coerceCadence({ kind: 'onDemand' })).toBeNull();
  });

  it('does NOT read a missing or mangled cadence as on demand', () => {
    // The difference that matters: a drafter that forgot to emit a cadence
    // must get the weekday-mornings default, not a silently unscheduled
    // worker somebody hired to run every morning.
    expect(coerceCadence(undefined)).toEqual({ kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] });
    expect(coerceCadence({ kind: 'hourly' })).toEqual({ kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] });
  });

  it('describes itself in words the roster can print', () => {
    expect(describeCadence(null)).toBe('On demand');
    expect(describeCadence({ kind: 'daily', time: '09:00' })).toBe('Every day at 9am');
  });
});

describe('validateWorker — event-driven cadence', () => {
  // A worker is staff with a shift pattern: `nextShiftAt`, the shift calendar
  // and `projectOccurrences` all assume a time axis. An `onFlowComplete`
  // cadence has no occurrence to project, so such a worker would simply never
  // wake and the calendar would silently draw nothing. Refuse it at save time
  // and point at the surface that does support chaining.
  it('refuses onFlowComplete and names the right surface', () => {
    expect(
      validateWorker(
        makeWorker({
          cadence: { kind: 'onFlowComplete', watchFlowId: 'scrape', onOutcome: 'success' },
        }),
      ),
    ).toBe('Workers run on a clock. To chain off another flow, use a Schedule.');
  });

  it('still accepts the two clock-based cadences and on-demand', () => {
    expect(validateWorker(makeWorker({ cadence: { kind: 'daily', time: '09:00' } }))).toBeNull();
    expect(
      validateWorker(makeWorker({ cadence: { kind: 'interval', everyMinutes: 120 } })),
    ).toBeNull();
    expect(validateWorker(makeWorker({ cadence: null }))).toBeNull();
  });
});

describe('cron cadence', () => {
  it('is a valid shift pattern when it parses', () => {
    expect(validateWorker(makeWorker({ cadence: { kind: 'cron', expr: '0 9 1,15 * *' } }))).toBeNull();
  });

  it('is refused with the parser reason when it does not', () => {
    expect(validateWorker(makeWorker({ cadence: { kind: 'cron', expr: '0 99 * * *' } }))).toContain(
      'hour',
    );
  });

  it('still respects the shift floor — a worker is not a per-minute poller', () => {
    expect(validateWorker(makeWorker({ cadence: { kind: 'cron', expr: '* * * * *' } }))).toContain(
      'no more often',
    );
  });

  it('uses a fixed clock to reject adjacent cron occurrences', () => {
    const worker = makeWorker({ cadence: { kind: 'cron', expr: '0,1 * * * *' } });
    for (const now of [new Date(2026, 2, 2, 0, 30).getTime(), new Date(2026, 2, 2, 0, 59).getTime()]) {
      expect(validateWorker(worker, now)).toContain('no more often');
    }
  });

  it('round-trips through coercion', () => {
    expect(coerceCadence({ kind: 'cron', expr: '0 9 * * 1-5' })).toEqual({
      kind: 'cron',
      expr: '0 9 * * 1-5',
    });
  });

  it('falls back to the default rather than firing on a guessed expression', () => {
    expect(coerceCadence({ kind: 'cron', expr: 'every monday please' })).toEqual({
      kind: 'daily',
      time: '09:00',
      days: [1, 2, 3, 4, 5],
    });
  });
});

describe('parseDirectRun', () => {
  it('takes the work from a /run line', () => {
    expect(parseDirectRun('/run LG Partner Club Thailand')).toBe('LG Partner Club Thailand');
    expect(parseDirectRun('  /RUN  review LG  ')).toBe('review LG');
    expect(parseDirectRun('/run\nreview LG')).toBe('review LG');
  });

  it('leaves ordinary messages alone', () => {
    expect(parseDirectRun('did you review the documents?')).toBeNull();
    expect(parseDirectRun('tell me how to /run this')).toBeNull();
  });

  it('is a whole word, not a prefix match', () => {
    // Otherwise "/running late" dispatches a flow run named "ning late".
    expect(parseDirectRun('/running late on the LG review')).toBeNull();
  });

  it('needs work to run', () => {
    expect(parseDirectRun('/run')).toBeNull();
    expect(parseDirectRun('/run   ')).toBeNull();
  });
});

describe('workerErrandStarters', () => {
  it('offers the worker its own starters when it has them', () => {
    const w = makeWorker({ errandStarters: ['what is stuck?', 'recheck this morning'] });
    expect(workerErrandStarters(w)).toEqual(['what is stuck?', 'recheck this morning']);
  });

  it('falls back rather than leaving a desk with no examples on it', () => {
    // Every worker hired before the field existed has none, and a bare box is
    // exactly the thing the starters exist to prevent.
    expect(workerErrandStarters(makeWorker()).length).toBeGreaterThan(0);
  });

  it('treats an empty or blank list as no starters at all', () => {
    expect(workerErrandStarters(makeWorker({ errandStarters: [] }))).toEqual(
      workerErrandStarters(makeWorker()),
    );
    expect(workerErrandStarters(makeWorker({ errandStarters: ['   ', ''] }))).toEqual(
      workerErrandStarters(makeWorker()),
    );
  });

  it('caps the list, because past three they stop being examples', () => {
    const w = makeWorker({ errandStarters: ['one', 'two', 'three', 'four', 'five'] });
    expect(workerErrandStarters(w)).toEqual(['one', 'two', 'three']);
  });

  it('collapses whitespace so a wrapped starter still fits on one chip', () => {
    const w = makeWorker({ errandStarters: ['  what   is\n  stuck? '] });
    expect(workerErrandStarters(w)).toEqual(['what is stuck?']);
  });
});

describe('parseHireQuestions', () => {
  it('reads the block and keeps the prose before it as the lead-in', () => {
    const parsed = parseHireQuestions(
      'Quick check.\n<questions>{"questions":[{"question":"Which repo?","options":["api","web"]}]}</questions>',
    );
    expect(parsed).toEqual({
      intro: 'Quick check.',
      questions: [{ question: 'Which repo?', options: ['api', 'web'] }],
    });
  });

  it('accepts a bare array of strings', () => {
    expect(parseHireQuestions('<questions>["Which repo?"]</questions>')?.questions).toEqual([
      { question: 'Which repo?' },
    ]);
  });

  it('caps questions and options, and drops empty ones', () => {
    const block = JSON.stringify({
      questions: [
        { question: '' },
        { question: 'A?', options: ['1', '2', '3', '4', '5', ''] },
        'B?',
        'C?',
        'D?',
      ],
    });
    const parsed = parseHireQuestions(`<questions>${block}</questions>`);
    expect(parsed?.questions.map((q) => q.question)).toEqual(['A?', 'B?', 'C?']);
    expect(parsed?.questions[0].options).toEqual(['1', '2', '3', '4']);
  });

  it('returns null for no block, bad JSON or no questions', () => {
    expect(parseHireQuestions('1. Which repo?')).toBeNull();
    expect(parseHireQuestions('<questions>{ nope }</questions>')).toBeNull();
    expect(parseHireQuestions('<questions>{"questions":[]}</questions>')).toBeNull();
  });
});

describe('hireAnswerText', () => {
  const qs = [{ question: 'Which repo?' }, { question: 'How often?' }];

  it('is empty when nothing was answered', () => {
    expect(hireAnswerText(qs, ['', '  '], '')).toBe('');
  });

  it('pairs answers with questions, marks skips and adds the extra note', () => {
    expect(hireAnswerText(qs, ['api'], 'keep it cheap')).toBe(
      'Which repo?\n→ api\n\nHow often?\n→ (skipped — pick a sensible default)\n\nAlso: keep it cheap',
    );
  });
});

describe('parseWorkerContract flows and servers', () => {
  const opts = {
    knownFlowIds: ['triage', 'digest'],
    defaultHeartbeatModel: 'cheap-model',
    knownMcpServers: ['Linear', 'slack'],
  };
  const parse = (body: Record<string, unknown>) =>
    parseWorkerContract(`<worker>${JSON.stringify({ name: 'Ada', jobDescription: 'Do it.', ...body })}</worker>`, opts)!;

  it('reads a flows list, dropping unknown ids, duplicates and empties, capped at three', () => {
    const c = parse({
      flows: [
        { flowId: 'triage', when: 'new tickets' },
        { flowId: 'triage' },
        { flowId: 'ghost' },
        {},
        { flowRequest: 'A weekly digest.', when: 'Fridays' },
        { flowId: 'digest' },
        { flowRequest: 'One too many.' },
      ],
    });
    expect(c.flows).toEqual([
      { flowId: 'triage', when: 'new tickets' },
      { flowRequest: 'A weekly digest.', when: 'Fridays' },
      { flowId: 'digest' },
    ]);
  });

  it('still reads the single flowId / flowRequest shape', () => {
    expect(parse({ flowRequest: 'Fix things.' }).flows).toEqual([{ flowRequest: 'Fix things.' }]);
    expect(parse({ flowId: 'digest' }).flows).toEqual([{ flowId: 'digest' }]);
  });

  it('keeps only known MCP servers, matched back to their configured spelling', () => {
    expect(parse({ mcpServers: ['linear', 'Gmail', 'SLACK', 'linear'] }).mcpServers).toEqual([
      'Linear',
      'slack',
    ]);
    expect(parse({ mcpServers: [] }).mcpServers).toEqual([]);
    expect(parse({}).mcpServers).toBeUndefined();
  });

  it('ignores mcpServers when the drafter was never shown a list', () => {
    const c = parseWorkerContract(
      `<worker>${JSON.stringify({ name: 'Ada', jobDescription: 'Do it.', mcpServers: ['Linear'] })}</worker>`,
      { knownFlowIds: [], defaultHeartbeatModel: 'cheap-model' },
    )!;
    expect(c.mcpServers).toBeUndefined();
  });
});

describe('parseWorkerContract wrap-up', () => {
  const opts = { knownFlowIds: ['triage', 'digest'], defaultHeartbeatModel: 'cheap-model' };
  const parse = (body: Record<string, unknown>) =>
    parseWorkerContract(`<worker>${JSON.stringify({ name: 'Ada', jobDescription: 'Do it.', ...body })}</worker>`, opts)!;

  it('reads a wrap-up as a request or an existing flow', () => {
    expect(parse({ flowId: 'triage', wrapUp: { flowRequest: 'Combine into one digest.' } }).wrapUp).toEqual({
      flowRequest: 'Combine into one digest.',
    });
    expect(parse({ flowId: 'triage', wrapUp: { flowId: 'digest' } }).wrapUp).toEqual({ flowId: 'digest' });
  });

  it('raises a one-item shift to two when there is a wrap-up to combine them', () => {
    expect(parse({ flowId: 'triage', maxItemsPerShift: 1, wrapUp: { flowId: 'digest' } }).maxItemsPerShift).toBe(2);
    expect(parse({ flowId: 'triage', maxItemsPerShift: 1 }).maxItemsPerShift).toBe(1);
  });

  it('drops a wrap-up that is also a route, or that names nothing usable', () => {
    expect(parse({ flowId: 'triage', wrapUp: { flowId: 'triage' } }).wrapUp).toBeUndefined();
    expect(parse({ flowId: 'triage', wrapUp: { flowId: 'ghost' } }).wrapUp).toBeUndefined();
    expect(parse({ flowId: 'triage' }).wrapUp).toBeUndefined();
  });
});

describe('validateWorker wrap-up', () => {
  it('refuses a wrap-up that is also a routing flow', () => {
    const base = {
      name: 'Ada',
      jobDescription: 'A job description long enough to pass.',
      projectPath: '/repo',
      heartbeatModel: 'cheap',
      budgetUSDPerMonth: 5,
      cadence: null,
      caps: { maxItemsPerShift: 2, runIn: 'worktree' as const },
      trust: 'probation' as const,
    };
    expect(validateWorker({ ...base, flowIds: ['a'], wrapUpFlowId: 'a' })).toMatch(/wrap-up/);
    expect(validateWorker({ ...base, flowIds: ['a'], wrapUpFlowId: 'b' })).toBeNull();
    expect(validateWorker({ ...base, flowIds: ['a'] })).toBeNull();
  });
});
