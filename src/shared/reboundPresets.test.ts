import { describe, expect, it } from 'vitest';
import { isAllGoodReviewerResponse } from './reboundPresets';

describe('isAllGoodReviewerResponse', () => {
  it('matches the exact persona phrase, case-insensitively, ignoring trailing punctuation', () => {
    expect(isAllGoodReviewerResponse('Looks fine.', 'critic')).toBe(true);
    expect(isAllGoodReviewerResponse('looks fine', 'critic')).toBe(true);
    expect(isAllGoodReviewerResponse('LOOKS FINE!', 'critic')).toBe(true);
    expect(isAllGoodReviewerResponse('Looks complete.', 'half-finished')).toBe(true);
    expect(isAllGoodReviewerResponse('No security issues found.', 'security')).toBe(true);
    expect(isAllGoodReviewerResponse('Matches the ask.', 'skeptical-user')).toBe(true);
  });

  it('treats short responses that lead with the phrase as still no-feedback', () => {
    // "Looks fine." with brief restatement is just elaboration, not feedback.
    expect(isAllGoodReviewerResponse('Looks fine. Implementation is straightforward.', 'critic')).toBe(true);
  });

  it('returns false for substantive last-line responses that happen to include the phrase elsewhere', () => {
    // A long response with real feedback as the LAST line is genuine feedback.
    const long =
      'Looks fine on the surface, but there is a subtle race condition in the locking code on line 42 that needs attention before merging.';
    expect(isAllGoodReviewerResponse(long, 'critic')).toBe(false);
  });

  it('detects all-good when the verdict is the FINAL line of a structured response', () => {
    // The new persona prompts ask for "list checks then verdict on its own
    // line." Make sure the all-good check still fires when the verdict
    // arrives at the bottom of a multi-line response.
    const structured =
      '- Stubs / TODOs: none\n- Return paths: covered\n- Refactor consistency: yes\n\nLooks complete.';
    expect(isAllGoodReviewerResponse(structured, 'half-finished')).toBe(true);
  });

  it('strips common verdict prefixes (verdict:/conclusion:) before matching', () => {
    expect(isAllGoodReviewerResponse('1. Checked stubs\n2. Checked TODOs\n\nVerdict: Looks complete.', 'half-finished')).toBe(true);
    expect(isAllGoodReviewerResponse('Conclusion: Looks fine.', 'critic')).toBe(true);
  });

  it("returns false for the wrong persona's phrase", () => {
    // "Looks complete" is half-finished's phrase, not critic's.
    expect(isAllGoodReviewerResponse('Looks complete.', 'critic')).toBe(false);
    expect(isAllGoodReviewerResponse('Looks fine.', 'security')).toBe(false);
  });

  it('returns false when no persona is set (e.g. independent preset)', () => {
    expect(isAllGoodReviewerResponse('Looks fine.', null)).toBe(false);
    expect(isAllGoodReviewerResponse('Looks fine.', undefined)).toBe(false);
  });

  it('returns false for genuine feedback', () => {
    expect(isAllGoodReviewerResponse('Missing null check on line 12.', 'critic')).toBe(false);
    expect(
      isAllGoodReviewerResponse(
        'Found SQL injection in buildQuery — user input is concatenated directly.',
        'security',
      ),
    ).toBe(false);
  });
});
