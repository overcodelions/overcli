// Pure half of Today's "Not merged" section — kept out of the component so it
// can be unit-tested under the node test environment (see
// doneUnreviewed.test.ts for the same split).

import type { StrandedLanding } from '../../../shared/flows/landingAudit';

/// The rows one inbox shows, in the order worth working through: work that
/// still merges first (it can land today), then work that needs a rebuild,
/// newest first within each.
export function notMergedRows(stranded: StrandedLanding[], workerId: string | null): StrandedLanding[] {
  const rank = (s: StrandedLanding) => (s.landability === 'clean' ? 0 : s.landability === 'conflicts' ? 1 : 2);
  return stranded
    .filter((s) => !workerId || s.workerId === workerId)
    .slice()
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
