// What a paused run is asking for, in three registers: the sentence that
// describes the stop, the verb on the button that ends it, and the hint that
// says what pressing it will actually do.
//
// One copy, because the desk and the work queue both offer the same two
// choices on the same run — a resume worded per reason, and a reject. Two
// tables would drift the first time either screen got a new pause kind, and
// the drift would read to the user as two different acts.

export type PauseReason =
  | 'preStep'
  | 'externalAction'
  | 'riskyStep'
  | 'needsInput'
  | 'failure'
  | 'interrupted';

/// The row's status line: why it stopped, not what you would do about it.
export const PAUSE_TEXT: Record<PauseReason, string> = {
  preStep: 'Stopped at a checkpoint',
  externalAction: 'Wants to act outside the repo',
  riskyStep: 'Step instructions look risky',
  needsInput: 'Asked you a question',
  failure: 'Stopped after a failure',
  interrupted: 'Interrupted when the app closed',
};

/// What a plain resume DOES depends on why the run stopped, so the button says
/// so rather than offering one word for three different acts. The escape hatch
/// on a failure pause — Override, accept this result and roll forward — stays
/// in the run pane, where the artifact it would accept is readable.
export const PAUSE_ACTION: Record<PauseReason, string> = {
  preStep: 'continue',
  externalAction: 'approve & run',
  riskyStep: 'review & run',
  needsInput: 'answer & resume',
  failure: 're-run step',
  interrupted: 'resume',
};

export const PAUSE_HINT: Record<PauseReason, string> = {
  preStep: 'Hand the prior step’s output to the next step and keep going',
  externalAction: 'Approve the external effect, then run this step',
  riskyStep: "The step's own prompt tripped the risk scan — read it, then run",
  needsInput: 'Open the run, read the Worker exchange, answer, and resume the step',
  failure: 'Run the failed step again. To accept its result instead, open the run and Override.',
  interrupted: 'The app closed mid-step — run that step again and roll forward',
};

/// Turning work down deletes a real run and a real worktree, so the warning
/// says the part that isn't obvious: the rejection is remembered.
export const REJECT_HINT =
  'Turn this work down — deletes the run and drops its worktree, and the rejection is journaled so it stays gone';
export const REJECT_CONFIRM =
  "Deletes the run and its worktree. The worker won't propose it again.";
