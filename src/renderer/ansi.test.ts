import { describe, expect, it } from 'vitest';
import { collapseCarriageReturns, parseAnsi, stripAnsi } from './ansi';

/// Written as an escape rather than typed, so these tests stay readable.
const E = '';

describe('parseAnsi', () => {
  it('colours a run rather than printing the escape code', () => {
    // This exact line, printed as text, is what made the pane look nothing
    // like the terminal it came from.
    expect(parseAnsi(`${E}[36m[vite]${E}[39m ready`)).toEqual([
      { text: '[vite]', color: '#22d3ee' },
      { text: ' ready', color: undefined },
    ]);
  });

  it('resets everything on 0', () => {
    const segments = parseAnsi(`${E}[1m${E}[31mbad${E}[0mfine`);
    expect(segments[0]).toEqual({ text: 'bad', bold: true, color: '#f87171' });
    expect(segments[1]).toEqual({ text: 'fine' });
  });

  it('treats a bare [m as a reset', () => {
    expect(parseAnsi(`${E}[32mok${E}[mplain`)[1]).toEqual({ text: 'plain' });
  });

  it('handles several codes in one sequence', () => {
    expect(parseAnsi(`${E}[1;33mwarn`)[0]).toEqual({ text: 'warn', bold: true, color: '#fbbf24' });
  });

  it('consumes a 256-colour code without reading its arguments as more codes', () => {
    // `38;5;196` is ONE instruction. Read naively, the 5 and 196 become codes
    // of their own and the rest of the line silently loses its styling.
    expect(parseAnsi(`${E}[38;5;196mx${E}[1my`)[1]).toEqual({ text: 'y', bold: true });
  });

  it('drops cursor movement rather than half-rendering it', () => {
    expect(stripAnsi(`${E}[2K${E}[1Gbuilding`)).toBe('building');
  });

  it('returns one plain segment for a line with no escapes', () => {
    expect(parseAnsi('plain line')).toEqual([{ text: 'plain line' }]);
  });
});

describe('stripAnsi', () => {
  it('gives back what the terminal would have shown', () => {
    expect(stripAnsi(`${E}[33m[tsc]${E}[39m Found 0 errors.`)).toBe('[tsc] Found 0 errors.');
  });
});

describe('collapseCarriageReturns', () => {
  it('keeps only the last version of a rewritten line', () => {
    // A progress bar rewrites one line; only its final state was ever visible.
    expect(collapseCarriageReturns('10%\r50%\r100%')).toBe('100%');
  });

  it('leaves an ordinary line alone', () => {
    expect(collapseCarriageReturns('done')).toBe('done');
  });
});
