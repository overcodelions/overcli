import { describe, expect, it } from 'vitest';
import { findDiffMatches, resolveDefaultBranch } from './diff-utils';

describe('findDiffMatches', () => {
  const lines = [
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -1,3 +1,3 @@',
    '-import { Foo } from "./foo";',
    '+import { Bar } from "./bar";',
    ' const foo = new Foo(foo);',
  ];

  it('returns nothing for an empty query', () => {
    expect(findDiffMatches(lines, '')).toEqual([]);
  });

  it('matches case-insensitively across lines, in document order', () => {
    const hits = findDiffMatches(lines, 'foo');
    expect(hits).toEqual([
      // `Foo` and `./foo` on the removed line — the query is lowercase.
      { line: 3, start: 10, end: 13 },
      { line: 3, start: 24, end: 27 },
      { line: 5, start: 7, end: 10 },
      { line: 5, start: 17, end: 20 },
      { line: 5, start: 21, end: 24 },
    ]);
  });

  it('searches the raw line including the +/- sigil', () => {
    expect(findDiffMatches(lines, '-import')).toEqual([{ line: 3, start: 0, end: 7 }]);
    expect(findDiffMatches(lines, '+import')).toEqual([{ line: 4, start: 0, end: 7 }]);
  });

  it('does not return overlapping hits', () => {
    expect(findDiffMatches(['aaaa'], 'aa')).toEqual([
      { line: 0, start: 0, end: 2 },
      { line: 0, start: 2, end: 4 },
    ]);
  });
});

describe('resolveDefaultBranch', () => {
  // A fake repo: `origin` is origin/HEAD's short ref ('' = unset), `local`
  // the branches under refs/heads.
  function repo(origin: string, local: string[]) {
    return async (args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return origin ? { stdout: `${origin}\n`, exitCode: 0 } : { stdout: '', exitCode: 128 };
      }
      const ref = args[args.length - 1].replace('refs/heads/', '');
      return { stdout: '', exitCode: local.includes(ref) ? 0 : 1 };
    };
  }

  it("uses origin's default when it exists locally, never the current branch", async () => {
    expect(await resolveDefaultBranch(repo('origin/master', ['master', 'feature/x']))).toBe(
      'master',
    );
  });

  it('falls back to a local main or master when origin/HEAD is unset', async () => {
    expect(await resolveDefaultBranch(repo('', ['main']))).toBe('main');
    expect(await resolveDefaultBranch(repo('', ['master']))).toBe('master');
  });

  it("uses the remote ref when the default isn't checked out locally", async () => {
    expect(await resolveDefaultBranch(repo('origin/trunk', ['feature/x']))).toBe('origin/trunk');
  });

  it('gives up with no origin and no main/master', async () => {
    expect(await resolveDefaultBranch(repo('', ['feature/x']))).toBeNull();
  });
});
