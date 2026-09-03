import { describe, expect, it } from 'vitest';
import { BATCHING_DIRECTIVE } from '@shared/turbo';
import { visibleUserPrompt } from './visibleUserPrompt';

describe('visibleUserPrompt', () => {
  it('leaves ordinary user text unchanged', () => {
    expect(visibleUserPrompt('hello\nworld')).toBe('hello\nworld');
  });

  it('hides the injected batching directive when it trails the prompt', () => {
    expect(visibleUserPrompt(`Do the work\n\n---\n\n${BATCHING_DIRECTIVE}`)).toBe('Do the work');
  });

  // Conversations recorded before the directive moved to the end still have
  // it in front, and their bubbles must keep rendering clean.
  it('hides the injected batching directive when it leads the prompt', () => {
    expect(visibleUserPrompt(`${BATCHING_DIRECTIVE}\n\nDo the work`)).toBe('Do the work');
  });

  it('hides attachment paths and retains friendly labels', () => {
    const prompt =
      '<image name=[Image #1] path="/private/a.png"></image>' +
      '<image name=[Chart] path="/private/b.png"></image>' +
      `Review these\n\n---\n\n${BATCHING_DIRECTIVE}`;
    expect(visibleUserPrompt(prompt)).toBe('Attached: Image #1\nAttached: Chart\nReview these');
    expect(visibleUserPrompt(prompt, true)).toBe('Review these');
  });
});
