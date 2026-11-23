import { describe, expect, it } from 'vitest';
import { sanitizeConversationTabs } from './store';

describe('sanitizeConversationTabs', () => {
  it('keeps ids in order without junk or duplicates', () => {
    expect(sanitizeConversationTabs({ ids: ['a', 3, '', 'b', 'a'], splitId: 'b' })).toEqual({
      ids: ['a', 'b'],
      splitId: 'b',
    });
  });

  it('caps the strip', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `c${i}`);
    expect(sanitizeConversationTabs({ ids })!.ids).toHaveLength(12);
  });

  it('drops an empty or malformed value', () => {
    expect(sanitizeConversationTabs(undefined)).toBeUndefined();
    expect(sanitizeConversationTabs({ ids: [] })).toBeUndefined();
    expect(sanitizeConversationTabs({ ids: 'a', splitId: 7 })).toBeUndefined();
  });
});
