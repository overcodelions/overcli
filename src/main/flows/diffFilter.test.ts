import { describe, expect, it } from 'vitest';

import { filterNoiseFromDiff, isNoisyPath } from './diffFilter';

describe('isNoisyPath', () => {
  it('detects lockfiles by basename at any depth', () => {
    expect(isNoisyPath('package-lock.json')).toBe(true);
    expect(isNoisyPath('apps/web/package-lock.json')).toBe(true);
    expect(isNoisyPath('pnpm-lock.yaml')).toBe(true);
    expect(isNoisyPath('Cargo.lock')).toBe(true);
    expect(isNoisyPath('go.sum')).toBe(true);
  });

  it('detects minified outputs', () => {
    expect(isNoisyPath('dist/app.min.js')).toBe(true);
    expect(isNoisyPath('public/style.min.css')).toBe(true);
  });

  it('does not flag normal source files', () => {
    expect(isNoisyPath('src/main/index.ts')).toBe(false);
    expect(isNoisyPath('package.json')).toBe(false); // package.json itself is signal
    expect(isNoisyPath('README.md')).toBe(false);
  });
});

describe('filterNoiseFromDiff', () => {
  it('drops lockfile hunks and keeps source hunks', () => {
    const diff = [
      'diff --git a/package-lock.json b/package-lock.json',
      'index 111..222 100644',
      '--- a/package-lock.json',
      '+++ b/package-lock.json',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/src/foo.ts b/src/foo.ts',
      'index aaa..bbb 100644',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1 +1 @@',
      '-let x = 1',
      '+let x = 2',
    ].join('\n');

    const result = filterNoiseFromDiff(diff);
    expect(result.filtered).toEqual(['package-lock.json']);
    expect(result.diff).toContain('src/foo.ts');
    expect(result.diff).not.toContain('"version": "old"'); // sanity
    expect(result.diff).not.toMatch(/^@@ -1 \+1 @@\n-old\n\+new/m);
    expect(result.diff).toContain('filtered 1 noisy file');
  });

  it('returns the original diff unchanged when no noisy paths are present', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n');
    const result = filterNoiseFromDiff(diff);
    expect(result.filtered).toEqual([]);
    expect(result.diff).toBe(diff);
  });

  it('drops multiple lockfiles and lists them in the summary', () => {
    const diff = [
      'diff --git a/package-lock.json b/package-lock.json',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/src/keep.ts b/src/keep.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n');
    const result = filterNoiseFromDiff(diff);
    expect(result.filtered).toContain('package-lock.json');
    expect(result.filtered).toContain('pnpm-lock.yaml');
    expect(result.diff).toContain('src/keep.ts');
    expect(result.diff).toContain('Dropped: package-lock.json, pnpm-lock.yaml');
  });

  it('handles empty input', () => {
    expect(filterNoiseFromDiff('')).toEqual({ diff: '', filtered: [] });
  });
});
