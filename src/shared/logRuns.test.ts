import { describe, expect, it } from 'vitest';

import { endLine, formatDuration, parseEnd, parseStart, runKeys, splitRuns, startLine } from './logRuns';

describe('run markers', () => {
  it('reads back what it writes', () => {
    const start = { time: '08:02:14', ref: 'feat/x', cwd: '/repos/api', command: './gradlew bootRun -Pa=b · c' };
    expect(parseStart(startLine(start))).toEqual(start);
    const end = { status: 'failed' as const, exitCode: 1, duration: '16s', error: 'Port 8088 · taken' };
    expect(parseEnd(endLine(end))).toEqual(end);
  });

  it('reads a start line written before it carried a time', () => {
    expect(parseStart('── start master · /repos/api · npm run dev ──')).toEqual({
      time: undefined,
      ref: 'master',
      cwd: '/repos/api',
      command: 'npm run dev',
    });
  });

  it('leaves other engine lines alone', () => {
    expect(parseStart('── code changed · src/Other.java · restarting ──')).toBeNull();
    expect(parseEnd('── rebound master → feat/x ──')).toBeNull();
    expect(parseEnd('── stopped ──')).toEqual({ status: 'stopped' });
  });

  it('formats durations the way people say them', () => {
    expect(formatDuration(16_400)).toBe('16s');
    expect(formatDuration(242_000)).toBe('4m 02s');
    expect(formatDuration(3_725_000)).toBe('1h 02m');
  });
});

describe('splitRuns', () => {
  it('cuts the log at each start and keeps how each ended', () => {
    const lines = [
      'left over from before',
      startLine({ time: '08:00:00', ref: 'master', cwd: '/r', command: 'run' }),
      'building',
      endLine({ status: 'failed', exitCode: 1 }),
      startLine({ time: '08:05:00', ref: 'master', cwd: '/r', command: 'run' }),
      'up',
    ];
    const runs = splitRuns(lines);
    expect(runs.map((r) => [r.from, r.to])).toEqual([
      [0, 1],
      [1, 4],
      [4, 6],
    ]);
    expect(runs[0].start).toBeNull();
    expect(runs[1].end).toEqual({ status: 'failed', exitCode: 1 });
    expect(runs[2].end).toBeNull();
  });

  it('is empty for an empty log', () => {
    expect(splitRuns([])).toEqual([]);
  });
});

describe('runKeys', () => {
  const a = startLine({ time: '08:00:00', ref: 'master', cwd: '/r', command: 'run' });
  const b = startLine({ time: '08:05:00', ref: 'master', cwd: '/r', command: 'run' });

  it('keeps naming a run the same once the front of the log is trimmed', () => {
    const lines = ['before', a, 'one', endLine({ status: 'failed' }), b, 'two'];
    const before = runKeys(lines, splitRuns(lines));
    const trimmed = lines.slice(2);
    const after = runKeys(trimmed, splitRuns(trimmed));
    // The second start's index moved from 4 to 2; its key did not.
    expect(after[after.length - 1]).toBe(before[before.length - 1]);
    // What is left of the first run lost its marker and is the head now.
    expect(after[0]).toBe('head');
  });

  it('tells two identical starts apart', () => {
    const lines = [a, 'one', a, 'two'];
    const keys = runKeys(lines, splitRuns(lines));
    expect(new Set(keys).size).toBe(2);
  });
});
