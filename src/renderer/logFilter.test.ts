import { describe, expect, it } from 'vitest';
import { describeFilter, filterLog, highlightRuns, isProblem } from './logFilter';

const E = '';

const lines = [
  `${E}[36m[vite]${E}[39m ready in 616 ms`,
  '[vite] Local: http://localhost:5273/',
  '[electron] Error: Port 5273 is already in use',
  '[tsc] Found 0 errors. Watching for file changes.',
];

describe('filterLog', () => {
  it('returns everything when nothing is asked for', () => {
    expect(filterLog(lines)).toHaveLength(4);
  });

  it('searches the text the user can see, not the escape codes behind it', () => {
    // Nobody searches for `[36m`.
    expect(filterLog(lines, { query: 'vite' }).map((l) => l.index)).toEqual([0, 1]);
    expect(filterLog(lines, { query: '36m' })).toEqual([]);
  });

  it('ignores case', () => {
    expect(filterLog(lines, { query: 'PORT' }).map((l) => l.index)).toEqual([2]);
  });

  it('keeps the original index so counts and jumps stay honest', () => {
    expect(filterLog(lines, { query: 'already' })[0].index).toBe(2);
  });

  it('shows only problems when asked', () => {
    expect(filterLog(lines, { level: 'problems' }).map((l) => l.index)).toEqual([2]);
  });

  it('does not call a line reporting zero errors a problem', () => {
    // "Found 0 errors" is the commonest false positive in a watch build, and
    // it scrolls past every few seconds.
    const problems = filterLog(lines, { level: 'problems' });
    expect(problems.some((l) => l.text.includes('Found 0'))).toBe(false);
  });

  it('combines a search with the problem filter', () => {
    expect(filterLog(lines, { query: 'port', level: 'problems' })).toHaveLength(1);
    expect(filterLog(lines, { query: 'vite', level: 'problems' })).toEqual([]);
  });

  it('marks every occurrence in a line, not just the first', () => {
    // Highlighting one of two identical matches looks like a bug.
    expect(filterLog(['port 1 port 2'], { query: 'port' })[0].matches).toEqual([
      [0, 4],
      [7, 11],
    ]);
  });
});

describe('isProblem', () => {
  it('recognises how different runtimes spell trouble', () => {
    expect(isProblem('EADDRINUSE: address already in use')).toBe(true);
    // The JVM's spelling: the word never starts, so a leading word boundary
    // would miss every stack trace there is.
    expect(isProblem('java.lang.NullPointerException')).toBe(true);
    expect(isProblem('Compiled successfully')).toBe(false);
  });

  it('counts a build that found errors and ignores one that found none', () => {
    expect(isProblem('[tsc] Found 2 errors. Watching for file changes.')).toBe(true);
    expect(isProblem('[tsc] Found 0 errors. Watching for file changes.')).toBe(false);
    expect(isProblem('webpack compiled with no errors')).toBe(false);
  });
});

describe('highlightRuns', () => {
  it('splits a line into plain and matched runs', () => {
    expect(highlightRuns('a port b', [[2, 6]])).toEqual([
      { text: 'a ', match: false },
      { text: 'port', match: true },
      { text: ' b', match: false },
    ]);
  });

  it('returns one run when nothing matched', () => {
    expect(highlightRuns('plain', [])).toEqual([{ text: 'plain', match: false }]);
  });
});

describe('describeFilter', () => {
  it('says how much is hidden, so an empty view is not mistaken for silence', () => {
    expect(describeFilter(1204, 12)).toBe('12 of 1,204 lines');
    expect(describeFilter(50, 50)).toBeNull();
  });
});
