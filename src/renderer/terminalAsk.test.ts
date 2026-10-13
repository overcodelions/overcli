import { describe, expect, it } from 'vitest';
import { appendToDraft, recentOutput, terminalAskTarget } from './terminalAsk';

describe('recentOutput', () => {
  it('drops the empty rows below the prompt and trailing spaces', () => {
    expect(recentOutput(['$ npm test  ', 'FAIL acme.test.ts', '$ ', '', '   ', ''])).toBe(
      '$ npm test\nFAIL acme.test.ts\n$',
    );
  });

  it('keeps only the last lines', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    const out = recentOutput(lines, 3).split('\n');
    expect(out).toEqual(['line 197', 'line 198', 'line 199']);
  });

  it('is empty for a blank screen', () => {
    expect(recentOutput(['', '  '])).toBe('');
  });
});

describe('terminalAskTarget', () => {
  const projects = [
    { id: 'p1', path: '/work/acme' },
    { id: 'p2', path: '/work/acme/packages/api' },
  ];

  it('asks the conversation on screen', () => {
    expect(terminalAskTarget({ cwd: '/anywhere', conversationId: 'c1', projects })).toEqual({
      kind: 'conversation',
      conversationId: 'c1',
    });
  });

  it('otherwise opens one in the innermost project holding the shell', () => {
    expect(terminalAskTarget({ cwd: '/work/acme/packages/api/src', conversationId: null, projects })).toEqual({
      kind: 'project',
      projectId: 'p2',
    });
    expect(terminalAskTarget({ cwd: '/work/acme', conversationId: null, projects })).toEqual({
      kind: 'project',
      projectId: 'p1',
    });
  });

  it('has nowhere to go outside every project', () => {
    expect(terminalAskTarget({ cwd: '/Users/acme', conversationId: null, projects })).toBeNull();
  });
});

describe('appendToDraft', () => {
  it('adds below a half-written message instead of replacing it', () => {
    expect(appendToDraft('why does  \n', 'About this output')).toBe('why does\n\nAbout this output');
    expect(appendToDraft('', 'About this output')).toBe('About this output');
  });
});
