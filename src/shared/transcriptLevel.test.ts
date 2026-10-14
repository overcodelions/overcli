import { describe, expect, it } from 'vitest';
import { conversationTranscriptLevel, defaultTranscriptLevel, offerSummaryHint } from './transcriptLevel';

describe('defaultTranscriptLevel', () => {
  it('keeps what the old toggle showed for settings saved before levels', () => {
    expect(defaultTranscriptLevel({ defaultShowToolActivity: false })).toBe('quiet');
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

describe('offerSummaryHint', () => {
  const fresh = { defaultShowToolActivity: false };

  it('offers Summary to someone who never chose a level', () => {
    expect(offerSummaryHint(fresh, {})).toBe(true);
  });

  it('stays out of the way once anyone chose, or closed it', () => {
    expect(offerSummaryHint({ ...fresh, transcriptHintDismissed: true }, {})).toBe(false);
    expect(offerSummaryHint({ ...fresh, defaultTranscriptLevel: 'quiet' }, {})).toBe(false);
    expect(offerSummaryHint(fresh, { transcriptLevel: 'quiet' })).toBe(false);
    expect(offerSummaryHint({ defaultShowToolActivity: true }, {})).toBe(false);
  });
});
