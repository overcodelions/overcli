import { describe, expect, it } from 'vitest';
import {
  computeWorkerScorecard,
  demotedTrust,
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
  parseHandoffs,
  resolveHandoffTarget,
  rosterLine,
  stripHandoffs,
  WORKER_ROSTER_LINE_MAX,
  WORKER_TAGLINE_MAX,
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
      '<handoff to="Triage">RED-6814 bundles six issues. Split it.</handoff>',
      "<handoff to='Warden'>Check the release.</handoff>",
    ].join('\n');
    expect(parseHandoffs(reply)).toEqual([
      { to: 'Triage', instruction: 'RED-6814 bundles six issues. Split it.' },
      { to: 'Warden', instruction: 'Check the release.' },
    ]);
    expect(stripHandoffs(reply)).toBe('I found two things that are not mine.');
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
