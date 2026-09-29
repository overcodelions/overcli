import { describe, expect, it } from 'vitest';

import { levelOf, snippet } from './ServiceOutputSearch';

describe('levelOf', () => {
  it('reads the level a line was logged at', () => {
    expect(levelOf('06:40:19 ERROR HikariPool - refused')).toBe('error');
    expect(levelOf('java.lang.IllegalStateException: boom')).toBe('error');
    expect(levelOf('06:41:02 WARN slow call')).toBe('warn');
    expect(levelOf('06:41:02 INFO started')).toBeNull();
  });
});

describe('snippet', () => {
  it('splits the line around its first match, ignoring case', () => {
    expect(snippet('Connection REFUSED on :5432', 'refused')).toEqual({
      pre: 'Connection ',
      match: 'REFUSED',
      post: ' on :5432',
    });
  });

  it('keeps a short lead-in when the match is far along the line', () => {
    const line = `${'x'.repeat(60)} refused`;
    const cut = snippet(line, 'refused');
    expect(cut.pre.startsWith('…')).toBe(true);
    expect(cut.pre.length).toBe(31);
    expect(cut.match).toBe('refused');
  });
});
