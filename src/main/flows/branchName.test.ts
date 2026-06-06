import { describe, expect, it } from 'vitest';

import { branchSlugFromPrompt } from './branchName';

describe('branchSlugFromPrompt', () => {
  it('uses an upper-case ticket key verbatim', () => {
    expect(branchSlugFromPrompt('please fix WOW-1234 the login bug', 'fix-bug')).toBe('WOW-1234');
    expect(branchSlugFromPrompt('ABC2-17 needs work', 'fix-bug')).toBe('ABC2-17');
  });

  it('treats a lower-case ticket key as prose, not a key', () => {
    expect(branchSlugFromPrompt('implement wow-1234 now', 'fix-bug')).toBe('implement-wow-1234-now');
  });

  it('prefers the ticket key even when other words come first', () => {
    expect(branchSlugFromPrompt('add a dark mode toggle for PROJ-9', 'theme')).toBe('PROJ-9');
  });

  it('ignores non-ticket hyphenated tokens', () => {
    expect(branchSlugFromPrompt('decode the utf-8 payload', 'decode')).toBe('decode-the-utf-8-payload');
  });

  it('falls back to a short kebab slug of the first words', () => {
    expect(branchSlugFromPrompt('Add a dark mode toggle to settings', 'theme')).toBe(
      'add-a-dark-mode-toggle-to',
    );
  });

  it('caps the slug at six words', () => {
    expect(branchSlugFromPrompt('one two three four five six seven eight', 'x')).toBe(
      'one-two-three-four-five-six',
    );
  });

  it('falls back to flow-<id> when the prompt has nothing usable', () => {
    expect(branchSlugFromPrompt('   ', 'my-flow')).toBe('flow-my-flow');
    expect(branchSlugFromPrompt('!!! ???', 'my-flow')).toBe('flow-my-flow');
  });
});
