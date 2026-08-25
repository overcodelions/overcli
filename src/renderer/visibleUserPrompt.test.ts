import { describe, expect, it } from 'vitest';
import { BATCHING_DIRECTIVE } from '@shared/turbo';
import { visibleUserPrompt } from './visibleUserPrompt';

describe('visibleUserPrompt', () => {
  it('leaves ordinary user text unchanged', () => {
    expect(visibleUserPrompt('hello\nworld')).toBe('hello\nworld');
  });

  it('hides the injected batching directive', () => {
    expect(visibleUserPrompt(`${BATCHING_DIRECTIVE}\n\nDo the work`)).toBe('Do the work');
  });

  it('hides attachment paths and retains friendly labels', () => {
    const prompt =
      '<image name=[Image #1] path="/private/a.png"></image>' +
      '<image name=[Chart] path="/private/b.png"></image>' +
      `${BATCHING_DIRECTIVE}\n\nReview these`;
    expect(visibleUserPrompt(prompt)).toBe('Attached: Image #1\nAttached: Chart\nReview these');
    expect(visibleUserPrompt(prompt, true)).toBe('Review these');
  });
});
