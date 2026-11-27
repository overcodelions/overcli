import { describe, expect, it } from 'vitest';
import { ciOf } from './workThreads';

const note = (...lines: string[]) => ['# CI on feature/ACME-1-fix (acme-web)', '', ...lines].join('\n');

describe('the CI verdict on a run, from the watcher’s note', () => {
  it('reads a build handed to the manager, with the checks that failed', () => {
    expect(ciOf(note("Still failing: the fix added no new commit. Handed to its manager.", '', '- FAILED: Pipeline - pullrequests (https://example.com/acme/acme-web/pipelines/results/35)')))
      .toEqual({ state: 'failed', note: 'Still failing: the fix added no new commit. Handed to its manager.', failing: [{ name: 'Pipeline - pullrequests', url: 'https://example.com/acme/acme-web/pipelines/results/35' }], checks: 1 });
  });

  it('reads a pass, one being fixed, and one nobody could judge', () => {
    expect(ciOf(note('Passed.', '', '- passed: Build'))?.state).toBe('passed');
    expect(ciOf(note('Failed, but the branch has since moved on to abc1234567, and CI is green there. Nothing for Ada to fix.'))?.state).toBe('passed');
    expect(ciOf(note('Sent back to Ada to fix (round 1 of 3).', '', '- FAILED: Unit tests'))?.state).toBe('fixing');
    expect(ciOf(note('No CI reported on this commit within 30 minutes, so overcli stopped watching.'))?.state).toBe('unknown');
    expect(ciOf('# CI on x (y)\n')).toBeUndefined();
  });
});
