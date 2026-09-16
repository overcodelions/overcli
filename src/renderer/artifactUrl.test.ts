import { describe, it, expect } from 'vitest';
import { artifactActionLabel, artifactHeadline, artifactUrl, firstArtifactUrl } from './components/ToolUseCard';

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

describe('artifactUrl', () => {
  const ok = (content: string) => ({ content, isError: false }) as any;
  const failed = (content: string) => ({ content, isError: true }) as any;
  const PAGE = 'https://claude.ai/code/artifact/65ad106b-c743-4c77-9e59-f3cc0379c8c5';

  it('prefers the URL the publish announced', () => {
    expect(artifactUrl({ file_path: 'x.html' }, ok(`Published: ${PAGE}`))).toBe(PAGE);
  });

  it('falls back to the URL the call was given, so a read still links out', () => {
    expect(artifactUrl({ action: 'read', url: PAGE }, ok('Read 12kb of HTML.'))).toBe(PAGE);
  });

  it('still links out while the call is in flight, and after it fails', () => {
    expect(artifactUrl({ action: 'open', url: PAGE }, undefined)).toBe(PAGE);
    expect(artifactUrl({ url: PAGE }, failed('Conflict: a newer version exists'))).toBe(PAGE);
  });

  it('drops the link once the page is deleted', () => {
    expect(artifactUrl({ action: 'delete', url: PAGE }, ok('Deleted.'))).toBeNull();
    // A failed delete leaves the page up, so the link is still good.
    expect(artifactUrl({ action: 'delete', url: PAGE }, failed('Not found'))).toBe(PAGE);
  });

  it('ignores a url input that is not an artifact', () => {
    expect(artifactUrl({ action: 'read', url: 'https://example.com/page' }, ok('ok'))).toBeNull();
    expect(artifactUrl({ action: 'list' }, ok('3 artifacts'))).toBeNull();
  });
});

describe('artifactActionLabel', () => {
  it('names every action but the default one', () => {
    expect(artifactActionLabel('read')).toBe('read');
    expect(artifactActionLabel('  QUICKSTART ')).toBe('quickstart');
  });

  it('stays quiet for publish, which is the card\'s default shape', () => {
    expect(artifactActionLabel('publish')).toBe('');
    expect(artifactActionLabel(undefined)).toBe('');
  });

  it('paints nothing for a value it does not recognise', () => {
    expect(artifactActionLabel('rm -rf')).toBe('');
    expect(artifactActionLabel(7)).toBe('');
  });
});
