// Auto-tidy: the rules that decide which finished worktrees have earned
// their exit.
//
// Cleaning up by hand is the symptom, not the cure. A worker running nightly
// makes a worktree a night whether or not anyone clears them, so the only
// way the Cleanup list stays short is for finished work to retire on a rule.
// These are those rules, kept pure so both the settings pane (which previews
// what they would catch) and the cleanup sheet (which applies them as a
// selection) read the same answer.
//
// What no rule here can do is delete something that holds work: `retirable`
// only ever looks at entries the scan proved `reclaimable`. A rule that could
// discard uncommitted changes on a timer is not a convenience.

import type { WorktreeSweepEntry } from './types';

export interface CleanupRules {
  /// Retire a finished, merged, clean worktree once it is this many days
  /// old. 0 means never — the rules are off.
  retireAfterDays: number;
  /// Recent shifts stay reopenable however old they get: the newest N per
  /// producer are held back from every rule below.
  keepPerProducer: number;
  /// Warn on a producer's desk once it is holding this many worktrees.
  /// 0 means never warn.
  warnAtCount: number;
}

export const DEFAULT_CLEANUP_RULES: CleanupRules = {
  retireAfterDays: 7,
  keepPerProducer: 3,
  warnAtCount: 25,
};

export const RETIRE_DAY_CHOICES = [0, 1, 7, 30] as const;
export const KEEP_CHOICES = [1, 3, 5, 10] as const;
export const WARN_CHOICES = [10, 25, 50, 0] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/// Which entries the rules would retire, given a grouping key per entry (the
/// cleanup module's `groupKeyFor` supplies it, so producer identity is
/// defined in exactly one place).
///
/// Order of operations matters: hold back the newest N per producer FIRST,
/// then age what's left. Doing it the other way round would let a busy day
/// push a worker's only three recent shifts past the age threshold together.
export function retirable(
  entries: WorktreeSweepEntry[],
  rules: CleanupRules,
  keyOf: (entry: WorktreeSweepEntry) => string,
  ageOf: (entry: WorktreeSweepEntry) => number,
  now: number,
): WorktreeSweepEntry[] {
  if (rules.retireAfterDays <= 0) return [];
  const cutoff = now - rules.retireAfterDays * DAY_MS;
  const byProducer = new Map<string, WorktreeSweepEntry[]>();
  for (const entry of entries) {
    // Only what the scan proved safe. `has-work` is never retired on a
    // timer, however old it is.
    if (entry.bucket !== 'reclaimable') continue;
    const key = keyOf(entry);
    const list = byProducer.get(key);
    if (list) list.push(entry);
    else byProducer.set(key, [entry]);
  }

  const out: WorktreeSweepEntry[] = [];
  for (const list of byProducer.values()) {
    const ordered = [...list].sort((a, b) => ageOf(b) - ageOf(a));
    for (const entry of ordered.slice(Math.max(0, rules.keepPerProducer))) {
      const at = ageOf(entry);
      // An undated entry is never retired automatically. We can't say how old
      // it is, and "we couldn't tell" is not grounds for deleting something.
      if (at === 0 || at >= cutoff) continue;
      out.push(entry);
    }
  }
  return out;
}

/// Producers holding more than the warn threshold, worst first. Counts every
/// worktree the producer holds — the complaint is the pile, not the part of
/// it that happens to be clearable.
export function runawayProducers(
  groups: Array<{ key: string; name: string; entries: unknown[]; safe: unknown[]; totalKb: number }>,
  rules: CleanupRules,
): Array<{ key: string; name: string; count: number; safeCount: number; totalKb: number }> {
  if (rules.warnAtCount <= 0) return [];
  return groups
    .filter((g) => g.entries.length >= rules.warnAtCount)
    .map((g) => ({
      key: g.key,
      name: g.name,
      count: g.entries.length,
      safeCount: g.safe.length,
      totalKb: g.totalKb,
    }))
    .sort((a, b) => b.count - a.count);
}

export function describeRules(rules: CleanupRules): string {
  if (rules.retireAfterDays <= 0) return 'Auto-tidy is off — nothing retires on its own.';
  const age =
    rules.retireAfterDays === 1 ? 'a day old' : `${rules.retireAfterDays} days old`;
  return `Finished, merged worktrees retire once they are ${age}, keeping the newest ${rules.keepPerProducer} per worker or flow.`;
}
