// Unit tests for the parts of the flow runtime that don't require a real
// RunnerManager (which would need an Electron app context). The full
// orchestration is exercised manually by running a flow end-to-end.

import { describe, expect, it } from 'vitest';

import {
  detectArtifactKind,
  extractOutput,
  isGatingReviewerRole,
  isReviewApproved,
} from './runtime';

describe('extractOutput', () => {
  it('extracts a clean block', () => {
    const text = `chatter before
<output name="plan.md">
# Goal
ship the thing
</output>
chatter after`;
    expect(extractOutput(text, 'plan.md')).toBe('# Goal\nship the thing');
  });

  it('returns null when the block is missing', () => {
    expect(extractOutput('no output here', 'plan.md')).toBeNull();
  });

  it('returns null when the block has the wrong name', () => {
    expect(extractOutput('<output name="other.md">x</output>', 'plan.md')).toBeNull();
  });

  it('matches single-quoted name attribute', () => {
    expect(extractOutput("<output name='diff'>+ hello\n</output>", 'diff')).toBe('+ hello');
  });

  it('matches unquoted name attribute', () => {
    expect(extractOutput('<output name=diff>+ a</output>', 'diff')).toBe('+ a');
  });

  it('handles names with dots and dashes', () => {
    expect(
      extractOutput('<output name="review-2.md">ok</output>', 'review-2.md'),
    ).toBe('ok');
  });

  it('concatenates sibling blocks with the same name', () => {
    // The previous implementation returned only the FIRST match, but
    // smaller models (gpt-5.4-mini, gemma) routinely emit one
    // <output> block per file they touched. Concatenating recovers
    // the full deliverable instead of silently dropping later blocks.
    const text = `<output name="plan.md">first</output><output name="plan.md">second</output>`;
    expect(extractOutput(text, 'plan.md')).toBe('first\nsecond');
  });

  it('strips nested <output> tags from inside the body', () => {
    // Models occasionally interpret the marker as a section heading
    // and nest more <output …> tags inside the artifact. Those leftover
    // tags should be cleaned out so the body is usable downstream.
    const text =
      '<output name="diff">\nAdded foo\n<output name="diff">\nAdded bar\n</output>';
    expect(extractOutput(text, 'diff')).toBe('Added foo\n\nAdded bar');
  });

  it('is case-insensitive on the tag', () => {
    expect(extractOutput('<OUTPUT name="x">y</OUTPUT>', 'x')).toBe('y');
  });
});

describe('detectArtifactKind', () => {
  it('detects markdown names', () => {
    expect(detectArtifactKind('plan.md')).toBe('markdown');
    expect(detectArtifactKind('notes.markdown')).toBe('markdown');
  });

  it('detects diff names', () => {
    expect(detectArtifactKind('diff')).toBe('diff');
    expect(detectArtifactKind('changes.diff')).toBe('diff');
    expect(detectArtifactKind('fix.patch')).toBe('diff');
  });

  it('detects url names', () => {
    expect(detectArtifactKind('pr_url')).toBe('url');
    expect(detectArtifactKind('releaseUrl')).toBe('url');
  });

  it('falls back to text', () => {
    expect(detectArtifactKind('notes.txt')).toBe('text');
  });

  it('is case-insensitive', () => {
    expect(detectArtifactKind('PLAN.MD')).toBe('markdown');
    expect(detectArtifactKind('FIX.PATCH')).toBe('diff');
  });
});

describe('isGatingReviewerRole', () => {
  it('is true for reviewer-family roles', () => {
    for (const role of [
      'reviewer',
      'plan-reviewer',
      'code-reviewer',
      'security-reviewer',
      'adversarial-reviewer',
    ] as const) {
      expect(isGatingReviewerRole(role)).toBe(true);
    }
  });

  it('is false for non-reviewer roles', () => {
    for (const role of [
      'planner',
      'implementer',
      'test-writer',
      'shipper',
      'custom',
    ] as const) {
      expect(isGatingReviewerRole(role)).toBe(false);
    }
  });
});

describe('isReviewApproved', () => {
  it('approves on a bare APPROVED line', () => {
    expect(isReviewApproved('APPROVED\nLooks correct.')).toBe(true);
    expect(isReviewApproved('Verified the diff.\nAPPROVED — ships clean.')).toBe(true);
  });

  it('approves through markdown decoration', () => {
    expect(isReviewApproved('**APPROVED**\nrationale')).toBe(true);
    expect(isReviewApproved('- APPROVED')).toBe(true);
    expect(isReviewApproved('## APPROVED')).toBe(true);
  });

  it('is case-insensitive on the verdict word', () => {
    expect(isReviewApproved('approved')).toBe(true);
  });

  it('does NOT approve an explicit rejection', () => {
    expect(isReviewApproved('Status: REJECTED\nThe diff does not implement the plan.')).toBe(
      false,
    );
  });

  it('does NOT approve when no verdict line is present', () => {
    expect(isReviewApproved('Here are some problems:\n- missing edge case')).toBe(false);
  });

  it('does NOT approve "NOT APPROVED"', () => {
    expect(isReviewApproved('NOT APPROVED — needs work')).toBe(false);
    expect(isReviewApproved('This is not approved yet.')).toBe(false);
  });
});
