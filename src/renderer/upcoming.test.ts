import { describe, expect, it } from 'vitest';

import type { Orchestration } from '@shared/flows/orchestration';
import type { Schedule } from '@shared/flows/schedule';
import type { Worker } from '@shared/flows/worker';

import {
  SCHEDULE_LABELS,
  SHIFT_LABELS,
  automationStatus,
  awaitingApproval,
  headlineStatus,
  scheduleSubjects,
  upcomingAgenda,
  workerSubjects,
  type AutomationSide,
  type AutomationSubject,
} from './upcoming';

const NOW = new Date(2026, 7, 17, 9, 0, 0, 0).getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function subject(overrides: Partial<AutomationSubject> = {}): AutomationSubject {
  return {
    source: 'worker',
    id: 'w1',
    name: 'Fielder',
    enabled: true,
    nextAt: NOW + HOUR,
    running: false,
    cadence: 'Every day at 10:00',
    ...overrides,
  };
}

function makeWorker(overrides: Record<string, unknown> = {}): Worker {
  return {
    id: 'w1',
    name: 'Fielder',
    cadence: { kind: 'daily', time: '10:00' },
    enabled: true,
    ...overrides,
  } as unknown as Worker;
}

function makeSchedule(overrides: Record<string, unknown> = {}): Schedule {
  return {
    id: 's1',
    name: 'Morning triage',
    enabled: true,
    trigger: { kind: 'daily', time: '07:00' },
    ...overrides,
  } as unknown as Schedule;
}

function parked(origin: Orchestration['origin']): Orchestration {
  return {
    id: 'o1',
    title: 'batch',
    createdAt: NOW,
    origin,
    items: [{ candidate: { id: 'c1', title: 't' }, status: 'proposed' }],
  } as unknown as Orchestration;
}

describe('workerSubjects', () => {
  it('reads the next shift from the engine rather than re-deriving it', () => {
    const [s] = workerSubjects({ w1: makeWorker() }, { w1: NOW + 5 * MINUTE });
    expect(s.nextAt).toBe(NOW + 5 * MINUTE);
    expect(s.cadence).toBe('Every day at 10am');
  });

  it('counts a shift in progress as running', () => {
    const [s] = workerSubjects({ w1: makeWorker() }, {}, { w1: { task: 'shift' } });
    expect(s.running).toBe(true);
  });

  it('does not count an errand — you are already watching that one', () => {
    const [s] = workerSubjects({ w1: makeWorker() }, {}, { w1: { task: 'errand' } });
    expect(s.running).toBe(false);
  });
});

describe('scheduleSubjects', () => {
  it('counts a schedule with a run in flight as running', () => {
    const [s] = scheduleSubjects({ s1: makeSchedule({ activeRunId: 'r1' }) }, {});
    expect(s).toMatchObject({ source: 'schedule', running: true, nextAt: null });
  });
});

describe('awaitingApproval', () => {
  const orchestrations = {
    a: parked({ kind: 'worker', workerId: 'w1', workerName: 'Fielder' } as never),
    b: parked({ kind: 'schedule', scheduleId: 's1', scheduleName: 'Triage' } as never),
    c: parked(undefined),
  };

  it('counts only batches the named species produced', () => {
    expect(awaitingApproval(orchestrations, 'worker')).toBe(1);
    expect(awaitingApproval(orchestrations, 'schedule')).toBe(1);
  });

  it('ignores a batch you assembled yourself — that is not unattended work', () => {
    const mine = { c: orchestrations.c };
    expect(awaitingApproval(mine, 'worker') + awaitingApproval(mine, 'schedule')).toBe(0);
  });
});

describe('upcomingAgenda', () => {
  it('orders both species together, soonest first', () => {
    const agenda = upcomingAgenda([
      subject({ id: 'late', nextAt: NOW + 4 * HOUR }),
      subject({ source: 'schedule', id: 'soon', nextAt: NOW + MINUTE }),
      subject({ id: 'mid', nextAt: NOW + HOUR }),
    ]);
    expect(agenda.map((s) => s.id)).toEqual(['soon', 'mid', 'late']);
  });

  it('keeps an overdue occurrence — "due now" is the most urgent thing it says', () => {
    const agenda = upcomingAgenda([subject({ nextAt: NOW - HOUR })]);
    expect(agenda).toHaveLength(1);
  });

  it('drops paused subjects and ones with nowhere left to fire', () => {
    const agenda = upcomingAgenda([
      subject({ id: 'off', enabled: false }),
      subject({ id: 'never', nextAt: null }),
    ]);
    expect(agenda).toEqual([]);
  });

  it('stops at the limit', () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      subject({ id: `w${i}`, nextAt: NOW + i * HOUR }),
    );
    expect(upcomingAgenda(many, 3)).toHaveLength(3);
  });
});

describe('automationStatus', () => {
  it('renders nothing when nothing is armed', () => {
    expect(
      automationStatus({ subjects: [], waiting: 0, labels: SHIFT_LABELS, now: NOW }),
    ).toBeNull();
    expect(
      automationStatus({
        subjects: [subject({ enabled: false })],
        waiting: 0,
        labels: SHIFT_LABELS,
        now: NOW,
      }),
    ).toBeNull();
  });

  it('leads with the countdown when idle, and names its subject', () => {
    const status = automationStatus({
      subjects: [subject({ nextAt: NOW + 40 * MINUTE })],
      waiting: 0,
      labels: SHIFT_LABELS,
      now: NOW,
    });
    expect(status).toMatchObject({ tone: 'armed', label: 'Shift · in 40m' });
    expect(status?.title).toContain('1 worker armed');
    expect(status?.title).toContain('Fielder');
  });

  it('keeps the schedule chip reading exactly as it always has', () => {
    const status = automationStatus({
      subjects: scheduleSubjects({ s1: makeSchedule() }, { s1: NOW + 11 * HOUR }),
      waiting: 0,
      labels: SCHEDULE_LABELS,
      now: NOW,
    });
    expect(status?.label).toBe('Scheduled · in 11h');
  });

  it('lets a parked proposal outrank a run in flight', () => {
    const status = automationStatus({
      subjects: [subject({ running: true })],
      waiting: 2,
      labels: SHIFT_LABELS,
      now: NOW,
    });
    expect(status).toMatchObject({ tone: 'waiting', label: 'Shifts · 2 to approve' });
  });

  it('pluralises the noun with the count', () => {
    const one = automationStatus({
      subjects: [subject({ running: true })],
      waiting: 0,
      labels: SHIFT_LABELS,
      now: NOW,
    });
    const two = automationStatus({
      subjects: [subject({ running: true }), subject({ id: 'w2', running: true })],
      waiting: 0,
      labels: SHIFT_LABELS,
      now: NOW,
    });
    expect(one?.label).toBe('Shift · running');
    expect(two?.label).toBe('Shifts · 2 running');
  });

  it('still says it is armed when no next time is known', () => {
    const status = automationStatus({
      subjects: [subject({ nextAt: null })],
      waiting: 0,
      labels: SHIFT_LABELS,
      now: NOW,
    });
    expect(status).toMatchObject({ tone: 'armed', label: 'Shift' });
  });

  it('names its own species in the tooltip, whichever chip wins', () => {
    const shift = automationStatus({
      subjects: [subject()],
      waiting: 1,
      labels: SHIFT_LABELS,
      now: NOW,
    });
    const scheduled = automationStatus({
      subjects: [subject({ source: 'schedule' })],
      waiting: 1,
      labels: SCHEDULE_LABELS,
      now: NOW,
    });
    expect(shift?.title).toBe('A shift batch is waiting for you to approve it');
    expect(scheduled?.title).toBe('A scheduled batch is waiting for you to approve it');
  });

  it('counts units in the running tooltip', () => {
    const status = automationStatus({
      subjects: [subject({ running: true }), subject({ id: 'w2', running: true })],
      waiting: 0,
      labels: SHIFT_LABELS,
      now: NOW,
    });
    expect(status?.title).toBe('2 workers are running right now');
  });
});

describe('headlineStatus', () => {
  function shifts(overrides: Partial<AutomationSide> = {}): AutomationSide {
    return {
      source: 'worker',
      subjects: [subject()],
      waiting: 0,
      labels: SHIFT_LABELS,
      ...overrides,
    };
  }
  function scheduled(overrides: Partial<AutomationSide> = {}): AutomationSide {
    return {
      source: 'schedule',
      subjects: [subject({ source: 'schedule', id: 's1', name: 'Morning triage' })],
      waiting: 0,
      labels: SCHEDULE_LABELS,
      ...overrides,
    };
  }

  it('renders nothing when neither side is armed', () => {
    expect(
      headlineStatus(
        [shifts({ subjects: [] }), scheduled({ subjects: [] })],
        NOW,
      ),
    ).toBeNull();
  });

  it('names the side that fires first when both are just idling', () => {
    const status = headlineStatus(
      [
        shifts({ subjects: [subject({ nextAt: NOW + 11 * HOUR })] }),
        scheduled({
          subjects: [subject({ source: 'schedule', id: 's1', nextAt: NOW + 40 * MINUTE })],
        }),
      ],
      NOW,
    );
    expect(status).toMatchObject({ source: 'schedule', label: 'Scheduled · in 40m' });
  });

  it('lets an approval on one side outrank a countdown on the other', () => {
    const status = headlineStatus(
      [
        shifts({ waiting: 1 }),
        scheduled({
          subjects: [subject({ source: 'schedule', id: 's1', nextAt: NOW + MINUTE })],
        }),
      ],
      NOW,
    );
    expect(status).toMatchObject({ source: 'worker', tone: 'waiting' });
  });

  it('lets a run in flight outrank a countdown, but not an approval', () => {
    const running = headlineStatus(
      [shifts({ subjects: [subject({ running: true })] }), scheduled()],
      NOW,
    );
    expect(running).toMatchObject({ source: 'worker', tone: 'running' });

    const approval = headlineStatus(
      [shifts({ subjects: [subject({ running: true })] }), scheduled({ waiting: 1 })],
      NOW,
    );
    expect(approval).toMatchObject({ source: 'schedule', tone: 'waiting' });
  });

  it('takes the busier side when both are in the same state', () => {
    const status = headlineStatus([shifts({ waiting: 1 }), scheduled({ waiting: 4 })], NOW);
    expect(status).toMatchObject({ source: 'schedule', label: 'Scheduled · 4 to approve' });
  });

  it('keeps the side it could not name in the tooltip', () => {
    const status = headlineStatus(
      [
        shifts({ subjects: [subject({ nextAt: NOW + MINUTE })] }),
        scheduled({ subjects: [subject({ source: 'schedule', id: 's1', running: true })] }),
      ],
      NOW,
    );
    // The schedule is running, so it leads; the armed roster still gets said.
    expect(status?.source).toBe('schedule');
    expect(status?.title.split('\n')).toEqual([
      'A schedule is running right now',
      expect.stringContaining('Also: 1 worker armed'),
    ]);
  });

  it('falls to the roster when the two sides are indistinguishable', () => {
    const status = headlineStatus([shifts(), scheduled()], NOW);
    expect(status?.source).toBe('worker');
  });

  it('ignores a side with nothing armed rather than ranking it', () => {
    const status = headlineStatus([shifts({ subjects: [] }), scheduled()], NOW);
    expect(status).toMatchObject({ source: 'schedule' });
    expect(status?.title).not.toContain('Also:');
  });
});
