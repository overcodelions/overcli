import { describe, expect, it } from 'vitest';
import { DEFAULT_ORG_POLICY, otherPeopleLimit, parseOrgPolicy } from './policy';
import { limitState, managerBudgets, paceFor, personSpendOn, usersByWorker } from './spendView';

describe('who a worker’s month went on', () => {
  const asks = [
    { workerId: 'w', orchestrationId: 'o-sam', by: 'Sam', slackUserId: 'U0SAM' },
    { workerId: 'w', orchestrationId: 'o-sam-2', by: 'Sam', slackUserId: 'U0SAM' },
    { workerId: 'w', orchestrationId: 'o-pat', by: 'Pat', slackUserId: 'U0PAT' },
    { workerId: 'w', by: 'Nobody started anything' },
  ];
  const runs = [
    { id: 'r1', workerId: 'w', costUSD: 5, parentOrchestrationId: 'o-sam' },
    { id: 'r2', workerId: 'w', costUSD: 7, parentOrchestrationId: 'o-sam-2' },
    { id: 'r3', workerId: 'w', costUSD: 20, parentOrchestrationId: 'o-pat' },
    { id: 'r4', workerId: 'w', costUSD: 3 },
    { id: 'r5', workerId: 'w', costUSD: 2, parentOrchestrationId: 'from-a-schedule' },
    { id: 'r6', workerId: 'w', costUSD: 4, parentOrchestrationId: 'team-batch' },
    { id: 'r7', workerId: 'x', costUSD: 1, parentOrchestrationId: 'team-batch' },
  ];
  const team = [{ runId: 'r6', teamName: 'Launch Team', by: 'Sam', slackUserId: 'U0SAM' }, { runId: 'r7', teamName: 'Launch Team' }];
  const users = usersByWorker(runs, asks, team);

  it('adds up each person’s asks, biggest first, and lists a team’s task apart', () => {
    expect(users.get('w')).toEqual([
      { label: 'Pat', by: 'Pat', slackUserId: 'U0PAT', spentUSD: 20 },
      { label: 'Sam', by: 'Sam', slackUserId: 'U0SAM', spentUSD: 12 },
      { label: 'Launch Team, for Sam', by: 'Sam', slackUserId: 'U0SAM', spentUSD: 4 },
    ]);
  });

  it('leaves out what it can’t trace, which is what’s left of the total', () => {
    const traced = users.get('w')!.reduce((s, u) => s + u.spentUSD, 0);
    expect(traced).toBe(36);
    expect(users.get('x')).toEqual([{ label: 'Launch Team, for someone', by: 'someone', spentUSD: 1 }]);
  });

  it('counts a person’s asks and team tasks together toward their limit', () => {
    expect(personSpendOn(users.get('w'), { name: 'Sam', slackUserId: 'U0SAM' })).toBe(16);
    expect(personSpendOn(users.get('w'), { name: 'Riley', slackUserId: 'U0RILEY' })).toBe(0);
    expect(personSpendOn(undefined, { name: 'Sam' })).toBe(0);
  });

  it('tells two people with one name apart by their Slack id', () => {
    const two = usersByWorker([{ id: 'a', workerId: 'w', costUSD: 1, parentOrchestrationId: 'x' }, { id: 'b', workerId: 'w', costUSD: 2, parentOrchestrationId: 'y' }],
      [{ workerId: 'w', orchestrationId: 'x', by: 'Sam', slackUserId: 'U1' }, { workerId: 'w', orchestrationId: 'y', by: 'Sam', slackUserId: 'U2' }], []);
    expect(two.get('w')).toHaveLength(2);
  });
});

describe('the limit on a worker that isn’t yours', () => {
  it('warns at the alert share and stops at the limit', () => {
    expect(limitState(79, 100, 80)).toBe('ok');
    expect(limitState(80, 100, 80)).toBe('warn');
    expect(limitState(99.99, 100, 80)).toBe('warn');
    expect(limitState(100, 100, 80)).toBe('stop');
    expect(limitState(150, 100, 80)).toBe('stop');
  });

  it('never warns when warnings are off, still stops, and has no say with no limit', () => {
    expect(limitState(99, 100, 0)).toBe('ok');
    expect(limitState(100, 100, 0)).toBe('stop');
    expect(limitState(1_000_000, null, 80)).toBe('ok');
  });

  it('is $100 until someone says otherwise, and 0 means none', () => {
    expect(otherPeopleLimit(DEFAULT_ORG_POLICY)).toBe(100);
    expect(otherPeopleLimit({ otherPeopleLimitUSD: 25 })).toBe(25);
    expect(otherPeopleLimit({ otherPeopleLimitUSD: 0 })).toBeNull();
    expect(parseOrgPolicy({ otherPeopleLimitUSD: 25 }).policy.otherPeopleLimitUSD).toBe(25);
    expect(parseOrgPolicy({ otherPeopleLimitUSD: 0 }).policy.otherPeopleLimitUSD).toBe(0);
    expect(otherPeopleLimit(parseOrgPolicy({}).policy)).toBe(100);
    expect(parseOrgPolicy({ otherPeopleLimitUSD: 'lots' }).warnings.length).toBeGreaterThan(0);
  });
});

describe('budgets by manager', () => {
  const rules = { allowanceFor: (id: string) => (id === 'U0SAM' ? 40 : 20), ownAllowance: (id: string) => id === 'U0SAM', isAdmin: (id: string) => id === 'U0PAT' };
  const now = new Date(2026, 3, 16).getTime();
  const rows = managerBudgets(
    [
      { id: 'a', manager: 'Sam', managerSlackUserId: 'U0SAM', capUSD: 30, spentUSD: 5 },
      { id: 'b', manager: 'Sam', managerSlackUserId: 'U0SAM', capUSD: 30, spentUSD: 10 },
      { id: 'c', manager: 'Riley', managerSlackUserId: 'U0RILEY', capUSD: 15, spentUSD: 1 },
      { id: 'd', manager: 'Pat', managerSlackUserId: 'U0PAT', capUSD: 500, spentUSD: 100 },
      { id: 'e', manager: 'Browser', capUSD: 50, spentUSD: 2 },
    ],
    rules,
    now,
  );

  it('groups workers by who answers for them, biggest first', () => {
    expect(rows.map((r) => [r.name, r.capsUSD, r.workerIds])).toEqual([['Pat', 500, ['d']], ['Sam', 60, ['a', 'b']], ['Browser', 50, ['e']], ['Riley', 15, ['c']]]);
    expect(rows[1].spentUSD).toBe(15);
    expect(rows[1].paceUSD).toBeCloseTo(30, 0);
  });

  it('flags a manager over their allowance, and shows whose is their own', () => {
    expect(rows[1]).toMatchObject({ allowanceUSD: 40, ownAllowance: true, over: true, exempt: false });
    expect(rows[3]).toMatchObject({ allowanceUSD: 20, ownAllowance: false, over: false });
  });

  it('holds neither an admin nor someone with no Slack id to an allowance', () => {
    expect(rows[0]).toMatchObject({ exempt: true, over: false });
    expect(rows[0].allowanceUSD).toBeUndefined();
    expect(rows[2]).toMatchObject({ exempt: true, over: false });
    expect(rows[2].slackUserId).toBeUndefined();
  });
});

describe('where the month ends at this rate', () => {
  it('projects from how far through the month it is', () => {
    expect(paceFor(50, new Date(2026, 3, 16).getTime())).toBeCloseTo(100, 0);
  });
  it('won’t guess in the first two days', () => {
    expect(paceFor(50, new Date(2026, 3, 2).getTime())).toBeNull();
  });
});
