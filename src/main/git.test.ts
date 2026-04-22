import { describe, expect, it } from 'vitest';
import { firstCompareURL } from './git';

describe('firstCompareURL', () => {
  it('pulls the create-PR URL from a github push transcript', () => {
    const output = [
      'Counting objects: 5, done.',
      'Writing objects: 100% (5/5), done.',
      'remote: ',
      'remote: Create a pull request for \'feature/x\' on GitHub by visiting:',
      'remote:      https://github.com/foo/bar/pull/new/feature/x',
      'remote: ',
      'To github.com:foo/bar.git',
      ' * [new branch]      feature/x -> feature/x',
    ].join('\n');
    expect(firstCompareURL(output)).toBe('https://github.com/foo/bar/pull/new/feature/x');
  });

  it('pulls the GitLab merge-request URL', () => {
    const output = [
      'remote: ',
      'remote: To create a merge request for feat, visit:',
      'remote:   https://gitlab.com/foo/bar/-/merge_requests/new?merge_request%5Bsource_branch%5D=feat',
    ].join('\n');
    expect(firstCompareURL(output)).toBe(
      'https://gitlab.com/foo/bar/-/merge_requests/new?merge_request%5Bsource_branch%5D=feat',
    );
  });

  it('ignores non-remote URLs (e.g. a URL in an SSH banner or plain stderr)', () => {
    const output = [
      'Welcome to Bitbucket — see https://bitbucket.org/status',
      'To github.com:foo/bar.git',
      ' * [new branch]      main -> main',
    ].join('\n');
    expect(firstCompareURL(output)).toBeUndefined();
  });

  it('picks the first remote-prefixed URL when several are present', () => {
    const output = [
      'remote: Visit https://example.com/first to review',
      'remote: Or https://example.com/second',
    ].join('\n');
    expect(firstCompareURL(output)).toBe('https://example.com/first');
  });

  it('returns undefined when no URLs are present', () => {
    expect(firstCompareURL('nothing to see here\nstill nothing\n')).toBeUndefined();
    expect(firstCompareURL('')).toBeUndefined();
  });
});
