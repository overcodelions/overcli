import { describe as group, expect, it } from 'vitest';
import { describe, pullRequestsIn } from './landBranches';

group('pull requests read back from a landing note', () => {
  it('finds every pull request describe() writes, and nothing else', () => {
    const note = describe([
      { repo: 'acme-api', branch: 'overcli/ACME-1-fix-abc123', url: 'https://github.com/acme/acme-api/pull/41', pr: 'open' },
      { repo: 'acme-web', branch: 'overcli/ACME-1-fix-abc123', url: 'https://github.com/acme/acme-web/pull/7', pr: 'draft' },
      { repo: 'acme-jobs', branch: 'overcli/ACME-2-x', url: 'https://bitbucket.org/acme/acme-jobs/pull-requests/3', pr: 'open', updated: true },
      { repo: 'acme-docs', branch: 'overcli/ACME-3-y', url: 'https://github.com/acme/acme-docs/pull/2', existed: true },
      { repo: 'acme-cli', branch: 'overcli/ACME-4-z', url: 'https://github.com/acme/acme-cli/compare/main...overcli/ACME-4-z?expand=1', prError: 'no token' },
      { repo: 'acme-ops', skipped: 'the tests failed' },
      { repo: 'acme-misc', skipped: 'no changes' },
    ]);
    expect(pullRequestsIn(note)).toEqual([
      { repo: 'acme-api', url: 'https://github.com/acme/acme-api/pull/41', branch: 'overcli/ACME-1-fix-abc123', state: 'open' },
      { repo: 'acme-web', url: 'https://github.com/acme/acme-web/pull/7', branch: 'overcli/ACME-1-fix-abc123', state: 'draft' },
      { repo: 'acme-jobs', url: 'https://bitbucket.org/acme/acme-jobs/pull-requests/3', branch: 'overcli/ACME-2-x', state: 'updated' },
      { repo: 'acme-docs', url: 'https://github.com/acme/acme-docs/pull/2', branch: 'overcli/ACME-3-y', state: 'existing' },
      { repo: 'acme-cli', url: 'https://github.com/acme/acme-cli/compare/main...overcli/ACME-4-z?expand=1', branch: 'overcli/ACME-4-z', state: 'unopened' },
    ]);
  });

  it('finds none when nothing was pushed', () => {
    expect(pullRequestsIn(describe([{ repo: 'acme-api', skipped: 'no changes' }]))).toEqual([]);
  });
});
