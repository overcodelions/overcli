import { describe, expect, it } from 'vitest';
import type { FlowRun } from '../flows/schema';
import { answerOptions, movedOnFrom, projectMonthEnd, stalledRuns, trustReadiness, workerState } from './insights';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 9, 20, 12).getTime();
const done = (n: number, from = 20) =>
  Array.from({ length: n }, (_, i) => ({ kind: 'completed' as const, at: NOW - (from - i) * DAY / 2 }));

describe('trustReadiness', () => {
  it('suggests trusted after ten clean runs on probation', () => {
    expect(trustReadiness({ trust: 'probation' }, done(10), NOW)).toMatchObject({ readyFor: 'trusted', clean: 10 });
  });

  it('resets the run of form on a failure', () => {
    const journal = [...done(8, 30), { kind: 'failed' as const, at: NOW - 3 * DAY }, ...done(3, 4)];
    const r = trustReadiness({ trust: 'probation' }, journal, NOW);
    expect(r.readyFor).toBeUndefined();
    expect(r.clean).toBe(3);
  });

  it('ignores runs older than the window', () => {
    const old = Array.from({ length: 12 }, (_, i) => ({ kind: 'completed' as const, at: NOW - (40 + i) * DAY }));
    expect(trustReadiness({ trust: 'probation' }, old, NOW).readyFor).toBeUndefined();
  });

  it('never counts runs it brought from another server', () => {
    const brought = done(12).map((e) => ({ ...e, imported: true }));
    expect(trustReadiness({ trust: 'probation' }, brought, NOW)).toMatchObject({ clean: 0 });
  });

  it('has nothing to suggest for an autonomous worker', () => {
    expect(trustReadiness({ trust: 'autonomous' }, done(50), NOW).readyFor).toBeUndefined();
  });
});

describe('projectMonthEnd', () => {
  it('scales spend so far to the whole month', () => {
    // Nine days gone by midnight on the 10th.
    expect(Math.round(projectMonthEnd(31, new Date(2026, 9, 10, 0)))).toBe(107);
  });

  it('counts the first day as one day, not zero or one and a half', () => {
    expect(Math.round(projectMonthEnd(10, new Date(2026, 9, 1, 12)))).toBe(310);
  });
});

describe('workerState', () => {
  const run = (state: FlowRun['state']) => ({ workerId: 'w', state }) as FlowRun;
  it('puts waiting on a person above working', () => {
    expect(
      workerState({ id: 'w', enabled: true }, [
        run({ kind: 'running', currentStepId: 's' }),
        run({ kind: 'paused', nextStepId: 's', reason: 'needsInput' }),
      ]),
    ).toBe('waiting');
  });
  it('reads paused, stuck and idle', () => {
    expect(workerState({ id: 'w', enabled: false }, [])).toBe('paused');
    expect(workerState({ id: 'w', enabled: true }, [run({ kind: 'paused', nextStepId: 's', reason: 'failure' })])).toBe('stuck');
    expect(workerState({ id: 'w', enabled: true }, [run({ kind: 'done', success: true })])).toBe('idle');
  });

  it('is stuck on a stalled run only until a later run finishes well', () => {
    const at = (createdAt: number, state: FlowRun['state']) => ({ workerId: 'w', createdAt, state }) as FlowRun;
    const failure = { kind: 'paused', nextStepId: 's', reason: 'failure' } as FlowRun['state'];
    const stalled = at(10, failure);
    const me = { id: 'w', enabled: true };
    expect(workerState(me, [stalled, at(20, { kind: 'done', success: false } as FlowRun['state'])])).toBe('stuck');
    expect(workerState(me, [stalled, at(5, { kind: 'done', success: true } as FlowRun['state'])])).toBe('stuck');
    expect(workerState(me, [stalled, at(20, { kind: 'done', success: true } as FlowRun['state'])])).toBe('idle');
    // A newer stall after the good run: stuck again.
    expect(workerState(me, [stalled, at(20, { kind: 'done', success: true } as FlowRun['state']), at(30, failure)])).toBe('stuck');
    expect(movedOnFrom(stalled, [stalled, at(20, { kind: 'done', success: true } as FlowRun['state'])])).toBe(true);
    expect(stalledRuns([stalled, at(50, failure), at(30, { kind: 'running', currentStepId: 's' })]).map((r) => r.createdAt)).toEqual([50, 10]);
  });
});

describe('answerOptions', () => {
  it('offers both sides of a plain either-or', () => {
    expect(answerOptions('Acme dropped Team to $39. Should I call this a price cut or a repackaging?')).toEqual([
      'Price cut',
      'Repackaging',
    ]);
    expect(answerOptions('Blank or Unknown?')).toEqual(['Blank', 'Unknown']);
  });
  it('offers nothing for an open question', () => {
    expect(answerOptions('Which segment counts as enterprise?')).toEqual([]);
    expect(answerOptions('Done.')).toEqual([]);
  });
});
