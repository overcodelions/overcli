import { describe, it, expect } from 'vitest';
import { artifactHeadline, firstArtifactUrl } from './components/ToolUseCard';

describe('firstArtifactUrl', () => {
  it('finds the published page URL in a result body', () => {
    expect(
      firstArtifactUrl('Published: https://claude.ai/code/artifact/65ad106b-c743-4c77-9e59-f3cc0379c8c5'),
    ).toBe('https://claude.ai/code/artifact/65ad106b-c743-4c77-9e59-f3cc0379c8c5');
  });

  it('ignores claude.ai links that are not artifacts', () => {
    expect(firstArtifactUrl('see https://claude.ai/code/session/abc for details')).toBeNull();
  });

  it('returns null when there is no URL', () => {
    expect(firstArtifactUrl('done')).toBeNull();
    expect(firstArtifactUrl('')).toBeNull();
  });
});

describe('artifactHeadline', () => {
  it('prefers an explicit title when the tool input carries one', () => {
    expect(artifactHeadline('Overcli Usage Report', '/tmp/scratch/some-file.html')).toBe(
      'Overcli Usage Report',
    );
    expect(artifactHeadline('  Padded Title  ', '/tmp/x.html')).toBe('Padded Title');
  });

  it('falls back to the filename when title is absent', () => {
    expect(artifactHeadline(undefined, '/tmp/scratch/overcli-usage-report.html')).toBe(
      'Overcli usage report',
    );
    expect(artifactHeadline('', '/tmp/scratch/pricing-page.html')).toBe('Pricing page');
  });

  it('humanizes hyphens and underscores, and drops the whole extension run', () => {
    expect(artifactHeadline(null, '/a/b/q3_board_review.dc.html')).toBe('Q3 board review');
    expect(artifactHeadline(undefined, 'onboarding_flow-v2.html')).toBe('Onboarding flow v2');
    expect(artifactHeadline(undefined, 'C:\\Users\\x\\launch-plan.html')).toBe('Launch plan');
  });

  it('returns an empty headline when there is no title and no path', () => {
    expect(artifactHeadline(undefined, '')).toBe('');
    expect(artifactHeadline(null, '.html')).toBe('');
  });
});
