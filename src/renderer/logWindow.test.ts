import { describe, expect, it } from 'vitest';
import { firstLine, windowStart } from './logWindow';
import type { LogItem } from './stackFrames';

const rows = (n: number): LogItem[] => Array.from({ length: n }, (_, index) => ({ kind: 'line', index }));

describe('windowStart', () => {
  it('draws the newest rows while following', () => {
    expect(windowStart(rows(5000), null, 1500)).toBe(3500);
  });

  it('draws everything when the log is shorter than a window', () => {
    expect(windowStart(rows(200), null, 1500)).toBe(0);
    expect(windowStart(rows(200), 50, 1500)).toBe(0);
  });

  it('holds its place while new lines arrive below it', () => {
    // The reader scrolled up with the window starting at line 3500; a thousand
    // more lines arriving must not slide what they are reading away.
    expect(windowStart(rows(5000), 3500, 1500)).toBe(3500);
    expect(windowStart(rows(6000), 3500, 1500)).toBe(3500);
  });

  it('finds the anchor among folded traces', () => {
    const items: LogItem[] = [
      { kind: 'line', index: 0 },
      { kind: 'frames', indices: [1, 2, 3, 4] },
      { kind: 'line', index: 5 },
      { kind: 'line', index: 6 },
    ];
    expect(windowStart(items, 3, 1)).toBe(2);
    expect(windowStart(items, 1, 1)).toBe(1);
    expect(firstLine(items[1])).toBe(1);
  });

  it('falls back to the tail when the anchor is past the end', () => {
    // Cleared output: the old anchor points at lines that no longer exist.
    expect(windowStart(rows(100), 9000, 50)).toBe(50);
  });
});
