import { describe, expect, it } from 'vitest';
import { fenceStrayDiffs } from './diffFencing';

const DIFF = [
  'diff --git a/src/main/flows/runtime.ts b/src/main/flows/runtime.ts',
  'index 302c1f5..a628e58 100644',
  '--- a/src/main/flows/runtime.ts',
  '+++ b/src/main/flows/runtime.ts',
  '@@ -22,9 +22,9 @@ // runner pipeline drives.',
  " import { randomUUID } from 'node:crypto';",
  "-import { copyFileSync, existsSync, rmSync } from 'node:fs';",
  "+import { copyFileSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs';",
];

describe('fenceStrayDiffs', () => {
  it('fences a bare git diff that follows prose', () => {
    const out = fenceStrayDiffs(['No test files were touched, per the plan.', ...DIFF].join('\n'));
    expect(out).toBe(
      [
        'No test files were touched, per the plan.',
        '',
        '```diff',
        ...DIFF,
        '```',
      ].join('\n'),
    );
  });

  it('fences a bare hunk with no file header', () => {
    const src = ['@@ -1,3 +1,3 @@', ' a', '-b', '+c'].join('\n');
    expect(fenceStrayDiffs(src)).toBe(['```diff', '@@ -1,3 +1,3 @@', ' a', '-b', '+c', '```'].join('\n'));
  });

  it('keeps prose that follows the diff outside the fence', () => {
    const out = fenceStrayDiffs([...DIFF, '', 'That is the whole change.'].join('\n'));
    expect(out.endsWith(['```', '', 'That is the whole change.'].join('\n'))).toBe(true);
  });

  it('leaves an already fenced diff untouched', () => {
    const src = ['```diff', ...DIFF, '```'].join('\n');
    expect(fenceStrayDiffs(src)).toBe(src);
  });

  it('leaves ordinary markdown lists and rules alone', () => {
    const src = ['- one', '- two', '+ three', '', '---', '', 'after'].join('\n');
    expect(fenceStrayDiffs(src)).toBe(src);
  });

  it('is idempotent', () => {
    const once = fenceStrayDiffs(['intro', ...DIFF].join('\n'));
    expect(fenceStrayDiffs(once)).toBe(once);
  });
});
