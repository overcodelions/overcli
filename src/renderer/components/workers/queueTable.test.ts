import { describe, expect, it } from 'vitest';

import {
  NO_FILTERS,
  allRows,
  describeReach,
  matchesQuery,
  describeLive,
  describeState,
  moreBeyond,
  partitionLive,
  rangeFrom,
  stateCounts,
  stateOf,
  tableRows,
  workersInView,
  type QueueFilters,
} from './queueTable';

import type { QueueRow, WorkQueue } from './workQueue';

const NOON = new Date('2026-08-24T12:00:00').getTime();
const DAY = 86_400_000;
const HOUR = 3_600_000;

function row(key: string, over: Partial<QueueRow> = {}): QueueRow {
  return {
    key,
    workerId: 'w1',
    workerName: 'Triage',
    task: 'shift',
    status: 'done',
    title: key,
    steps: [],
    at: NOON - HOUR,
    ...over,
  } as QueueRow;
}

function queue(over: Partial<WorkQueue> = {}): WorkQueue {
  return { running: [], needsYou: [], finished: [], ...over };
}

const f = (over: Partial<QueueFilters> = {}): QueueFilters => ({ ...NO_FILTERS, ...over });

describe('stateOf', () => {
  it('collapses nine statuses onto the four a person filters by', () => {
    expect(stateOf('running')).toBe('running');
    expect(stateOf('responding')).toBe('running');
    expect(stateOf('queued')).toBe('running');
    expect(stateOf('planning')).toBe('running');
    expect(stateOf('paused')).toBe('needsYou');
    expect(stateOf('proposed')).toBe('needsYou');
    expect(stateOf('done')).toBe('done');
    expect(stateOf('quiet')).toBe('done');
    expect(stateOf('failed')).toBe('failed');
  });

  // Not a success, and "failed" is where you go looking for work that didn't
  // produce what it should have.
  it('files an orphan with the failures, not with the done', () => {
    expect(stateOf('orphaned')).toBe('failed');
  });
});

describe('allRows', () => {
  it('mixes live, waiting and finished into one list, newest first', () => {
    const q = queue({
      running: [row('live', { at: NOON - 2 * HOUR, status: 'running' })],
      needsYou: [row('ask', { at: NOON - HOUR, status: 'paused' })],
      finished: [row('old', { at: NOON - 3 * HOUR })],
    });
    expect(allRows(q).map((r) => r.key)).toEqual(['ask', 'live', 'old']);
  });
});

describe('rangeFrom', () => {
  it('reaches back whole days, from midnight', () => {
    const midnight = new Date('2026-08-24T00:00:00').getTime();
    expect(rangeFrom('today', NOON)).toBe(midnight);
    expect(rangeFrom('7d', NOON)).toBe(midnight - 6 * DAY);
    expect(rangeFrom('30d', NOON)).toBe(midnight - 29 * DAY);
    expect(rangeFrom('all', NOON)).toBe(0);
  });
});

describe('tableRows', () => {
  const q = queue({
    running: [row('live', { status: 'running', title: 'Reconcile partner groups' })],
    needsYou: [row('ask', { status: 'paused' })],
    finished: [
      row('today'),
      row('yesterday', { at: NOON - DAY, workerId: 'w2', workerName: 'Ahana' }),
      row('lastmonth', { at: NOON - 40 * DAY }),
    ],
  });

  it('defaults to today', () => {
    // Same stamp on all three, so the sort falls through to the key — the
    // tie-break `buildWorkQueue` already uses, kept so the order is stable.
    expect(tableRows(q, f(), NOON).map((r) => r.key)).toEqual(['ask', 'live', 'today']);
  });

  it('widens by range', () => {
    expect(tableRows(q, f({ range: '7d' }), NOON).map((r) => r.key)).toContain('yesterday');
    expect(tableRows(q, f({ range: '7d' }), NOON).map((r) => r.key)).not.toContain('lastmonth');
    expect(tableRows(q, f({ range: 'all' }), NOON).map((r) => r.key)).toContain('lastmonth');
  });

  it('narrows by state, worker and text at once', () => {
    expect(tableRows(q, f({ state: 'needsYou' }), NOON).map((r) => r.key)).toEqual(['ask']);
    expect(tableRows(q, f({ range: '7d', workerId: 'w2' }), NOON).map((r) => r.key)).toEqual(['yesterday']);
    expect(tableRows(q, f({ query: 'partner' }), NOON).map((r) => r.key)).toEqual(['live']);
  });
});

describe('matchesQuery', () => {
  it('searches what a person remembers: the job, the worker, the flow', () => {
    const r = row('k', { title: 'Fix the flaky spec', workerName: 'Cypress', flowName: 'Solve a ticket' });
    expect(matchesQuery(r, 'FLAKY')).toBe(true);
    expect(matchesQuery(r, 'cypress')).toBe(true);
    expect(matchesQuery(r, 'ticket')).toBe(true);
    expect(matchesQuery(r, '  ')).toBe(true);
    expect(matchesQuery(r, 'webhook')).toBe(false);
  });
});

describe('stateCounts', () => {
  // A pill answers "what would I get if I clicked this", so it must not be
  // counted through the state filter that is already on.
  it('ignores the state filter but obeys every other one', () => {
    const q = queue({
      running: [row('live', { status: 'running' })],
      finished: [row('a'), row('b', { status: 'failed' }), row('old', { at: NOON - 40 * DAY })],
    });
    expect(stateCounts(q, f({ state: 'failed' }), NOON)).toEqual({
      running: 1,
      needsYou: 0,
      done: 1,
      failed: 1,
    });
    expect(stateCounts(q, f({ workerId: 'nobody' }), NOON)).toEqual({
      running: 0,
      needsYou: 0,
      done: 0,
      failed: 0,
    });
  });
});

describe('workersInView', () => {
  it('offers only names that would actually filter to something, busiest first', () => {
    const q = queue({
      finished: [
        row('a', { workerId: 'w2', workerName: 'Ahana' }),
        row('b', { workerId: 'w2', workerName: 'Ahana' }),
        row('c'),
        row('gone', { at: NOON - 40 * DAY, workerId: 'w9', workerName: 'Sentry' }),
      ],
    });
    expect(workersInView(q, f(), NOON)).toEqual([
      { id: 'w2', name: 'Ahana', count: 2 },
      { id: 'w1', name: 'Triage', count: 1 },
    ]);
  });
});

// Reported from the running app: twelve jobs done and the page still "feels
// empty". Half of that was the torn row; the other half is a table that ends
// with no hint that the range, not the crew, is what stopped it.
// Reported from the running app: "when it's doing work I should see it
// clearly that it's doing stuff". Strict time order buried a job that started
// six hours ago six hours down the page — a stamp is not the same fact as a
// state.
// The original page opened with a sentence and I cut it, blaming it for the
// three metric tiles beside it repeating it. The tiles were the redundant
// half. A page that opens with a search field opens with chrome.
describe('describeState', () => {
  const c = (over: Partial<Record<string, number>> = {}) =>
    ({ running: 0, needsYou: 0, done: 0, failed: 0, ...over }) as Record<
      'running' | 'needsYou' | 'done' | 'failed',
      number
    >;

  it('says the state as one sentence', () => {
    expect(describeState(c({ done: 13 }), 'today')).toBe('Nothing running, and 13 finished today.');
    expect(describeState(c({ running: 1, needsYou: 1, done: 13 }), 'today')).toBe(
      '1 job running, 1 waiting on you, and 13 finished today.',
    );
  });

  // The middle clause only earns its place when something is actually blocked.
  it('drops the middle clause when nothing is waiting', () => {
    expect(describeState(c({ running: 2 }), 'today')).toBe(
      '2 jobs running, and nothing finished today.',
    );
  });

  it('counts a failure as finished — it is over either way', () => {
    expect(describeState(c({ done: 3, failed: 1 }), 'today')).toBe(
      'Nothing running, and 4 finished today.',
    );
  });

  it('names the reach it is talking about', () => {
    expect(describeState(c({ done: 40 }), '7d')).toBe(
      'Nothing running, and 40 finished in the last 7 days.',
    );
    expect(describeState(c({ done: 90 }), 'all')).toBe('Nothing running, and 90 finished in all.');
  });

  it('does not pretend a quiet stretch is three facts', () => {
    expect(describeState(c(), 'today')).toBe('Nothing has run today.');
    expect(describeState(c(), '30d')).toBe('Nothing has run in the last 30 days.');
  });
});

describe('partitionLive', () => {
  it('hoists what is happening and what is waiting, leaves the rest', () => {
    const rows = [
      row('done'),
      row('running', { status: 'running' }),
      row('paused', { status: 'paused' }),
      row('failed', { status: 'failed' }),
      row('answering', { status: 'responding' }),
    ];
    const { live, history } = partitionLive(rows);
    expect(live.map((r) => r.key)).toEqual(['running', 'paused', 'answering']);
    expect(history.map((r) => r.key)).toEqual(['done', 'failed']);
  });

  it('keeps the order it was handed, so the clock still decides within each', () => {
    const rows = [
      row('newer', { status: 'running', at: NOON }),
      row('older', { status: 'running', at: NOON - HOUR }),
    ];
    expect(partitionLive(rows).live.map((r) => r.key)).toEqual(['newer', 'older']);
  });
});

describe('describeLive', () => {
  // A decision outranks a job that is merely working.
  it('leads with the thing that is asking for something', () => {
    expect(describeLive([row('a', { status: 'running' })])).toBe('Working now');
    expect(describeLive([row('a', { status: 'running' }), row('b', { status: 'running' })])).toBe(
      '2 working now',
    );
    expect(describeLive([row('a', { status: 'paused' })])).toBe('Waiting on you');
    expect(describeLive([row('a', { status: 'paused' }), row('b', { status: 'running' })])).toBe(
      '1 waiting on you · 1 working',
    );
  });
});

describe('moreBeyond', () => {
  const q = queue({
    finished: [
      row('today'),
      row('yesterday', { at: NOON - DAY }),
      row('lastweek', { at: NOON - 8 * DAY }),
      row('lastmonth', { at: NOON - 40 * DAY }),
    ],
  });

  it('names what one more stop out would get you', () => {
    expect(moreBeyond(q, f(), NOON)).toEqual({ range: '7d', label: '7 days', count: 1 });
    expect(moreBeyond(q, f({ range: '7d' }), NOON)).toEqual({ range: '30d', label: '30 days', count: 1 });
  });

  it('says nothing when widening would change nothing', () => {
    expect(moreBeyond(queue({ finished: [row('today')] }), f(), NOON)).toBeNull();
  });

  it('has nowhere further to go from All', () => {
    expect(moreBeyond(q, f({ range: 'all' }), NOON)).toBeNull();
  });

  it('counts through the other filters, not around them', () => {
    // Widening the range must not smuggle in rows the worker filter excludes.
    expect(moreBeyond(q, f({ workerId: 'nobody' }), NOON)).toBeNull();
  });
});

describe('describeReach', () => {
  // A filtered list looks exactly like a crew that did nothing. This is the
  // page saying which it is.
  it('admits when it has hidden something', () => {
    expect(describeReach(3, f(), 11)).toBe('3 of 11 jobs today.');
    expect(describeReach(11, f(), 11)).toBe('11 jobs today.');
    expect(describeReach(0, f(), 0)).toBe('Nothing today.');
    expect(describeReach(4, f({ range: '7d' }), 9)).toBe('4 of 9 jobs in the last 7 days.');
    expect(describeReach(2, f({ range: 'all' }), 9)).toBe('2 of 9 jobs in everything still on disk.');
  });
});
