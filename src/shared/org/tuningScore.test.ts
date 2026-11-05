import { describe, expect, it } from 'vitest';
import { MIN_RUNS, aroundChange, impactLine, judge, runStats, scoreRuns, watchReasons, type RunResult, type ScoredRun } from './tuningScore';

const run = (at: number, result: RunResult = 'good', minutes = 5, over: Partial<ScoredRun> = {}): ScoredRun => ({ id: `r${at}`, number: at, at, title: 'x', result, minutes, working: minutes, waiting: 0, steps: [], ...over });
const runs = (count: number, from: number, result: RunResult = 'good', minutes = 5) => Array.from({ length: count }, (_, i) => run(from + i, result, minutes));
const stats = (cleanPct: number, medianMinutes: number) => ({ runs: 5, cleanPct, medianMinutes, medianWaiting: 0, refusedRuns: 0 });

describe('counting runs', () => {
  it('leaves out what’s still running, and takes the middle time', () => {
    expect(runStats([run(1, 'good', 2), run(2, 'rough', 10), run(3, 'failed', 4), run(4, 'running', 99)])).toEqual({ runs: 3, cleanPct: 33, medianMinutes: 4, medianWaiting: 0, refusedRuns: 0 });
    expect(runStats([])).toEqual({ runs: 0, cleanPct: 0, medianMinutes: 0, medianWaiting: 0, refusedRuns: 0 });
  });
});

describe('better or worse', () => {
  it('goes by whether runs went cleanly, then by time', () => {
    expect(judge(stats(50, 5), stats(80, 5))).toBe('better');
    expect(judge(stats(80, 5), stats(50, 5))).toBe('worse');
    expect(judge(stats(80, 10), stats(80, 5))).toBe('better');
    expect(judge(stats(80, 5), stats(80, 10))).toBe('worse');
    expect(judge(stats(80, 5), stats(85, 5.2))).toBe('same');
  });

  it('never calls failing fast an improvement', () => {
    expect(judge(stats(80, 30), stats(40, 1))).toBe('worse');
  });

  it('copes with runs that took no time', () => {
    expect(judge(stats(80, 0), stats(80, 5))).toBe('same');
  });
});

describe('what a change did, in a line', () => {
  it('says what happened to refused tools, waiting and time', () => {
    const before = { runs: 10, cleanPct: 40, medianMinutes: 5, medianWaiting: 25, refusedRuns: 3 };
    const after = { runs: 5, cleanPct: 100, medianMinutes: 3, medianWaiting: 2, refusedRuns: 0 };
    expect(impactLine(before, after)).toBe('Since this change: 0 of 5 runs had tools refused (was 3 of 10); waiting down from 25 min to 2 min; a typical run takes 3 min (was 5 min); 100% ran clean (was 40%).');
  });

  it('says waiting only when it moved, either way', () => {
    const base = { runs: 5, cleanPct: 100, medianMinutes: 3, medianWaiting: 0, refusedRuns: 0 };
    expect(impactLine(base, base)).not.toContain('waiting');
    expect(impactLine(base, { ...base, medianWaiting: 4 })).toContain('waiting up from 0 min to 4 min');
  });

  it('counts runs with a tool refused, not the refusals', () => {
    expect(runStats([run(1, 'rough', 5, { refused: 3 }), run(2)]).refusedRuns).toBe(1);
  });
});

describe('what makes overgo look by itself', () => {
  const refused = () => run(1, 'rough', 5, { refused: 1 });
  it('takes repeated trouble, not one bad run', () => {
    expect(watchReasons([refused(), refused(), run(2)], 1)).toEqual([]);
    expect(watchReasons([refused(), refused(), refused()], 0)).toEqual(['3 of its last 3 runs had tools refused']);
    expect(watchReasons([run(1, 'failed'), run(2, 'failed')], 0)).toEqual(['2 of its last 2 runs failed']);
    expect(watchReasons([], 2)).toEqual(['2 pieces of its work were marked not useful']);
  });

  it('counts a long wait only when it was most of the run', () => {
    const waited = () => run(1, 'good', 20, { working: 4, waiting: 16 });
    expect(watchReasons([waited(), waited(), waited()], 0)).toEqual(['3 of its last 3 runs spent most of their time waiting']);
    const busy = () => run(1, 'good', 30, { working: 20, waiting: 10 });
    expect(watchReasons([busy(), busy(), busy()], 0)).toEqual([]);
  });

  it('leaves out what’s still running', () => {
    expect(watchReasons([run(1, 'running', 5, { refused: 2 }), refused(), refused()], 0)).toEqual([]);
  });
});

describe('around a change', () => {
  it('waits for enough runs either side', () => {
    expect(aroundChange(runs(2, 1), 100).kind).toBe('early');
    expect(aroundChange([...runs(5, 1), run(200)], 100)).toMatchObject({ kind: 'waiting', needs: MIN_RUNS - 1 });
  });

  it('compares the runs before it with those after', () => {
    const r = aroundChange([...runs(5, 1, 'rough', 20), ...runs(5, 200, 'good', 3)], 100);
    expect(r).toMatchObject({ kind: 'better', before: { cleanPct: 0, medianMinutes: 20 }, after: { cleanPct: 100, medianMinutes: 3 } });
  });
});

describe('the scoreboard', () => {
  it('judges around its latest change when it has one', () => {
    const s = scoreRuns([...runs(5, 1, 'rough'), ...runs(5, 200)], [{ at: 50, title: 'old' }, { at: 100, title: 'new' }]);
    expect(s.verdict).toMatchObject({ basis: 'change', kind: 'better' });
  });

  it('else compares recent runs with earlier ones', () => {
    expect(scoreRuns([...runs(5, 1, 'failed'), ...runs(10, 100)]).verdict).toMatchObject({ basis: 'recent', kind: 'better' });
  });

  it('says it’s early with too few runs to go on', () => {
    expect(scoreRuns(runs(2, 1)).verdict).toMatchObject({ kind: 'early', needs: 4 });
    expect(scoreRuns([]).verdict.kind).toBe('early');
  });

  it('says where the time goes, biggest first', () => {
    const steps = [{ id: 'read', minutes: 1 }, { id: 'test', minutes: 4 }];
    expect(scoreRuns([run(1, 'good', 5, { steps }), run(2, 'good', 7, { steps: [{ id: 'test', minutes: 6 }] })]).steps).toEqual([{ id: 'test', minutes: 5 }, { id: 'read', minutes: 1 }]);
  });
});
