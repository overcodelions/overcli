// When to re-ask the main process which finished runs still hold unreviewed
// work (`flows:listUnreviewedRuns`).
//
// The answer changes in two moments: when you come back from reviewing
// somewhere else (window focus), and when a run finishes. The second is the
// one the title bar's "to review" nag exists for — a worker's shift that ends
// while you sit here watching — so waiting for the next alt-tab would leave it
// silent exactly then.
//
// Each check costs a `git status` per finished run's worktree, and a workspace
// run forks one per member, so on a real install a check can take seconds.
// Two guards keep that cheap: never two checks at once, and a quiet gap
// between them. A run that finishes while a guard turns the check away is not
// dropped: one trailing check is parked for when the gap is over.

import type { FlowRun } from '@shared/flows/schema';

/// True when some run that existed before is `done` now and was not then. A
/// run seen for the first time doesn't count: hydration brings in hundreds of
/// finished runs at once, and the boot-time check already covers those.
export function anyRunJustFinished(
  runs: Record<string, Pick<FlowRun, 'state'>>,
  prev: Record<string, Pick<FlowRun, 'state'>>,
): boolean {
  if (runs === prev) return false;
  for (const [id, run] of Object.entries(runs)) {
    const before = prev[id];
    if (run.state.kind === 'done' && before && before.state.kind !== 'done') return true;
  }
  return false;
}

export interface UnreviewedRefresher {
  /// Start a check unless a guard says no. True when one started.
  refresh(): boolean;
  /// Like `refresh`, but a check turned away is retried after the gap
  /// rather than lost. Any number of calls park at most one retry.
  refreshSoon(): void;
  dispose(): void;
}

export function createUnreviewedRefresher(opts: {
  scan: () => Promise<string[]>;
  apply: (ids: string[]) => void;
  gapMs: number;
}): UnreviewedRefresher {
  let last = 0;
  // A scan already running is the stronger guard of the two. The time
  // throttle assumes a scan is over long before the next focus; on an
  // install with hundreds of worktrees one takes many seconds, so
  // alt-tabbing during it used to stack a second full round of `git`
  // subprocesses on top of the first — each one making the other slower.
  let inFlight = false;
  let trailing: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const refresh = (): boolean => {
    const now = Date.now();
    if (disposed || inFlight || now - last < opts.gapMs) return false;
    last = now;
    inFlight = true;
    void opts
      .scan()
      .then((ids) => {
        if (!disposed) opts.apply(ids);
      })
      .catch(() => {})
      .finally(() => {
        inFlight = false;
        // Stamp the END, not the start: the gap is meant to keep scans
        // apart, and measuring from the start lets a slow one be followed
        // immediately by the next.
        last = Date.now();
      });
    return true;
  };

  const refreshSoon = (): void => {
    if (refresh() || trailing) return;
    const retry = () => {
      trailing = null;
      // Still turned away (a slow scan outlived the wait): try again rather
      // than lose the finish.
      if (!refresh() && !disposed) trailing = setTimeout(retry, opts.gapMs);
    };
    trailing = setTimeout(retry, opts.gapMs);
  };

  return {
    refresh,
    refreshSoon,
    dispose() {
      disposed = true;
      if (trailing) clearTimeout(trailing);
      trailing = null;
    },
  };
}
