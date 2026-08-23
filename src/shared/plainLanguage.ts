/// Non-engineer vocabulary for the changes bar. Keys mirror the git
/// `CommitState` union; the union is redeclared here rather than imported
/// from the renderer so shared/ never depends on renderer/.
export type PlainCommitState = 'committed' | 'uncommitted' | 'both';

/// Deliberately about HISTORY, not saving. Everyday projects auto-save, so
/// "saved" already means "on disk" everywhere else in the app — using it here
/// for "committed" put two different meanings of the word on one screen and
/// told the user a file they were looking at was "not saved yet".
export const PLAIN: Record<PlainCommitState, { label: string; title: string }> = {
  committed: { label: 'in history', title: 'Captured in this project’s history' },
  uncommitted: { label: 'new change', title: 'On disk, but not captured in the history yet' },
  both: { label: 'in history · edited', title: 'Captured in the history, with newer edits on top' },
};
