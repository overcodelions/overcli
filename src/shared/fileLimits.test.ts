import { describe, expect, it } from 'vitest';
import { MAX_LLM_ATTACHMENT_BYTES, tooLargeReason } from './fileLimits';

const MB = 1024 * 1024;

describe('tooLargeReason', () => {
  it('never shows a rejected size equal to the cap', () => {
    expect(tooLargeReason('deck.pdf', MAX_LLM_ATTACHMENT_BYTES + 1, MAX_LLM_ATTACHMENT_BYTES)).toBe(
      'deck.pdf is 26 MB; max is 25 MB.',
    );
    expect(tooLargeReason('deck.pdf', 25.4 * MB, MAX_LLM_ATTACHMENT_BYTES)).toBe(
      'deck.pdf is 26 MB; max is 25 MB.',
    );
  });

  it('rounds a fractional cap down', () => {
    expect(tooLargeReason('a.bin', 11 * MB, 10.5 * MB)).toBe('a.bin is 11 MB; max is 10 MB.');
  });

  it('names an unnamed file', () => {
    expect(tooLargeReason('', 30 * MB, MAX_LLM_ATTACHMENT_BYTES)).toBe('file is 30 MB; max is 25 MB.');
  });
});
