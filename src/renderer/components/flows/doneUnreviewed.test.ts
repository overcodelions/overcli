import { describe, expect, it } from 'vitest';

import { doneWithUnreviewedChanges } from './FlowRunSidebarRow';

/// The predicate behind the sidebar's amber "finished with unreviewed
/// changes" checkmark. StateBadge renders the dot iff this is true, so
/// asserting it is asserting the badge — see the note in
/// `pausedStepFailure.test.ts` for why renderer logic is tested as a pure
/// function rather than through a DOM render.
describe('doneWithUnreviewedChanges', () => {
  it('flags a finished run that left uncommitted work behind', () => {
    expect(doneWithUnreviewedChanges('done', false, true)).toBe(true);
  });

  it('does not flag a finished run with a clean worktree', () => {
    expect(doneWithUnreviewedChanges('done', false, false)).toBe(false);
  });

  it('does not flag a done run that is still live', () => {
    // StateBadge intercepts a live `done` run with the spinner before it
    // ever reaches the done branch, so flagging here would be a badge the
    // user can never see — and a run you're still chatting with hasn't
    // been abandoned.
    expect(doneWithUnreviewedChanges('done', true, true)).toBe(false);
  });

  it('does not flag runs in any other state', () => {
    for (const state of ['running', 'paused', 'aborted', 'watching', 'archived'] as const) {
      expect(doneWithUnreviewedChanges(state, false, true)).toBe(false);
    }
  });
});
