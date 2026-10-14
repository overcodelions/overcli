// Pure half of Today's "Not merged" section — kept out of the component so it
// can be unit-tested under the node test environment (see
// doneUnreviewed.test.ts for the same split).

import type { StrandedLanding } from '../../../shared/flows/landingAudit';

/// The rows one inbox shows, in the order worth working through: work that
/// still merges first (it can land today), then work that needs a rebuild,
/// newest first within each.
///
/// The audit comes from the main process, which in dev can be older than this
/// renderer (Vite reloads the renderer; main runs until restarted). Fields
/// added since are filled in here, so a stale main shows fewer details instead
/// of taking the whole window down.
export function notMergedRows(stranded: StrandedLanding[], workerId: string | null): StrandedLanding[] {
  const rank = (s: StrandedLanding) => (s.landability === 'clean' ? 0 : s.landability === 'conflicts' ? 1 : 2);
  return stranded
    .filter((s) => !workerId || s.workerId === workerId)
    .map((s) => ({ ...s, conflictFiles: s.conflictFiles ?? [] }))
    .sort((a, b) => rank(a) - rank(b) || (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
}

export function landabilityLabel(s: StrandedLanding): { text: string; tone: 'clean' | 'conflicts' | 'unknown'; hint: string } {
  const behind =
    s.baseAdvance == null ? '' : ` ${s.baseBranch} has moved ${s.baseAdvance} commit${s.baseAdvance === 1 ? '' : 's'} since.`;
  if (s.landability === 'clean') {
    return { text: 'merges cleanly', tone: 'clean', hint: `Still merges into ${s.baseBranch} without conflicts.${behind}` };
  }
  if (s.landability === 'conflicts') {
    return { text: 'conflicts', tone: 'conflicts', hint: `No longer merges into ${s.baseBranch} cleanly — rebuild rather than merge.${behind}` };
  }
  return { text: 'not checked', tone: 'unknown', hint: `Could not test-merge (needs git 2.38+).${behind}` };
}

/// The errand a conflicting row hands back to the worker that produced it.
/// Written as a brief the worker can act on with no other context: which
/// commit, where it sits, what changed underneath it, and where the line is —
/// rebuild on a fresh branch and stop; merging into base stays a human call.
export function rebuildInstruction(s: StrandedLanding): string {
  const branch = s.branchName && s.branchResolves ? ` (branch \`${s.branchName}\`)` : '';
  const moved =
    s.baseAdvance == null ? '' : ` \`${s.baseBranch}\` has gained ${s.baseAdvance} commit${s.baseAdvance === 1 ? '' : 's'} since.`;
  const files =
    s.conflictFiles.length > 0 ? ` It conflicts in: ${s.conflictFiles.map((f) => `\`${f}\``).join(', ')}.` : '';
  return [
    `Your earlier shift work "${s.itemTitle}" — commit \`${s.headSha}\`${branch} in ${s.projectPath} — was never merged, and it no longer merges cleanly into \`${s.baseBranch}\`.${moved}${files}`,
    '',
    `Rebuild it on top of the current \`${s.baseBranch}\`: start a fresh branch from \`${s.baseBranch}\`, cherry-pick \`${s.headSha.slice(0, 12)}\` and resolve the conflicts (or re-implement the change if \`${s.baseBranch}\` has moved too far for a cherry-pick to make sense), run the relevant tests, and commit.`,
    '',
    `Do not merge into \`${s.baseBranch}\` and do not push — leave the rebuilt branch for review, and say in your reply which branch it is on and what conflicted.`,
  ].join('\n');
}

/// "a, b, +3 more" — enough to tell a one-file clash from a sprawling one.
export function conflictSummary(files: string[], shown = 3): string {
  if (files.length <= shown) return files.join(', ');
  return `${files.slice(0, shown).join(', ')}, +${files.length - shown} more`;
}
