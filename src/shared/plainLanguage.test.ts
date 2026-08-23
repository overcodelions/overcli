import { describe, expect, it } from 'vitest';
import { PLAIN, type PlainCommitState } from './plainLanguage';

describe('PLAIN', () => {
  const states: PlainCommitState[] = ['committed', 'uncommitted', 'both'];

  it('has a non-empty label and title for every state', () => {
    for (const state of states) {
      expect(PLAIN[state].label.trim()).not.toBe('');
      expect(PLAIN[state].title.trim()).not.toBe('');
    }
  });

  it('never uses the word "commit", the exact jargon this map exists to avoid', () => {
    for (const state of states) {
      expect(PLAIN[state].label.toLowerCase()).not.toContain('commit');
    }
  });

  // Everyday projects auto-save, so "saved" already means "on disk" in the
  // editor header. Reusing it for "committed" put two meanings of the word on
  // one screen and told the user a file in front of them was "not saved yet".
  it('does not say "saved", which now means on-disk elsewhere in the app', () => {
    for (const state of states) {
      expect(PLAIN[state].label.toLowerCase()).not.toContain('save');
    }
  });
});
