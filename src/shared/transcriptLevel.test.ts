import { describe, expect, it } from 'vitest';
import { conversationTranscriptLevel, defaultTranscriptLevel } from './transcriptLevel';

describe('defaultTranscriptLevel', () => {
  it('moves settings saved before levels to Summary, or Detailed if the cards were on', () => {
    expect(defaultTranscriptLevel({ defaultShowToolActivity: false })).toBe('summary');
    expect(defaultTranscriptLevel({ defaultShowToolActivity: true })).toBe('detailed');
  });

  it('prefers the level once one is saved', () => {
    expect(defaultTranscriptLevel({ defaultShowToolActivity: true, defaultTranscriptLevel: 'summary' })).toBe('summary');
    expect(defaultTranscriptLevel({ defaultShowToolActivity: false, defaultTranscriptLevel: 'detailed' })).toBe('detailed');
  });
});

describe('conversationTranscriptLevel', () => {
  it("uses the conversation's pick over the default", () => {
    expect(conversationTranscriptLevel({ transcriptLevel: 'summary' }, 'quiet')).toBe('summary');
    expect(conversationTranscriptLevel({}, 'quiet')).toBe('quiet');
    expect(conversationTranscriptLevel(null, 'detailed')).toBe('detailed');
  });
});
