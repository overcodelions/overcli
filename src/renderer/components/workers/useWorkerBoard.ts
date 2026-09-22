// The board, built once and read by everyone who draws it.
//
// This used to live inside `WorkersSidebar` as a `useMemo`, which was right
// while the sidebar was the only thing that drew a roster. It is not any
// more: the crew grid on the Today page draws the same workers from the same
// stores, and two reductions over one dataset are two answers — the exact
// bargain `todaySpine` refused when it chose to read the queue the queue page
// reads. So the reduction moved here and both surfaces call it.
//
// Every DECISION made from the result still lives in `workerBoard`, where it
// is pure and testable. This file only gathers.

import { useMemo } from 'react';

import { useFlowsStore } from '../../flowsStore';
import { useOrchestratorStore } from '../../orchestratorStore';
import { useRunningMap } from '../../runnersStore';
import { useStore } from '../../store';
import { useWorkersStore } from '../../workersStore';
import { groupBoard, type BoardEntry, type BoardGroups } from './workerBoard';
import {
  deskMatchesQuery,
  indexedWorkerActivity,
  indexWorkerHistory,
  orchestrationForRun,
  startOfDay,
  summarizeDesk,
  workerHomeName,
} from './workerDeskSelectors';
import { isOrchestrationAwaitingApproval } from '@shared/flows/orchestration';
import { sortRoster, type Worker } from '@shared/flows/worker';

/// How far back a row's activity list reaches. Bounded because a worker with
/// four hundred turns must not make the roster walk all of them to answer
/// "did it do anything today".
export const ACTIVITY_SCAN = 40;

export interface WorkerBoard {
  /// Read ONCE per pass, not per row, so every strip on the page is drawn
  /// against the same midnight. A row rendered either side of it would
  /// otherwise silently use a different day.
  now: number;
  groups: BoardGroups;
  entries: BoardEntry[];
  /// The roster the entries were built from, in funding order, after the
  /// query filter.
  roster: Worker[];
  /// What each worker's project or workspace is called.
  homeByWorkerId: Record<string, string>;
  /// Whether the home is worth drawing at all — see `showHome` below.
  showHome: boolean;
}

export function useWorkerBoard(query = ''): WorkerBoard {
  const workers = useWorkersStore((s) => s.workers);
  const shiftProgress = useWorkersStore((s) => s.shiftProgress);
  const allocation = useWorkersStore((s) => s.allocation);
  const runs = useFlowsStore((s) => s.runs);
  const orchestrations = useOrchestratorStore((s) => s.orchestrations);
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const runners = useRunningMap();

  const homeByWorkerId = useMemo(() => {
    const out: Record<string, string> = {};
    for (const worker of Object.values(workers)) {
      out[worker.id] = workerHomeName(worker, projects, workspaces);
    }
    return out;
  }, [workers, projects, workspaces]);

  const workerHistory = useMemo(
    () => indexWorkerHistory(runs, orchestrations),
    [runs, orchestrations],
  );

  // Only worth drawing when the crew spans more than one home. On a
  // single-project board the label annotates nothing — it would be the same
  // word under every name.
  const showHome = useMemo(
    () => new Set(Object.values(homeByWorkerId).filter(Boolean)).size > 1,
    [homeByWorkerId],
  );

  // Search matches a worker's own runs too, not just its name — you look for
  // a worker by what it did at least as often as by what it is called.
  const roster = useMemo(
    () =>
      sortRoster(
        Object.values(workers).filter((w) =>
          query
            ? deskMatchesQuery(w, workerHistory.runs[w.id] ?? [], query, homeByWorkerId[w.id])
            : true,
        ),
      ),
    [workers, query, workerHistory, homeByWorkerId],
  );

  return useMemo(() => {
    const now = Date.now();
    const starved = new Set(
      (allocation?.byWorker ?? [])
        .filter((f) => f.blocked === 'pool')
        .map((f) => f.workerId),
    );
    const entries: BoardEntry[] = roster.map((worker) => {
      const mine = workerHistory.orchestrations[worker.id] ?? [];
      const awaiting = mine.filter(isOrchestrationAwaitingApproval);
      const review = awaiting.reduce(
        (count, o) => count + o.items.filter((item) => item.status === 'proposed').length,
        0,
      );
      const claimed = workerHistory.runs[worker.id] ?? [];
      const pausedRuns = claimed.filter((run) => run.state.kind === 'paused');
      const summary = summarizeDesk(claimed, awaiting, runners, !!shiftProgress[worker.id]);
      const recent = indexedWorkerActivity(mine, ACTIVITY_SCAN);
      const today = recent.filter((item) => startOfDay(item.at) === startOfDay(now));
      // Where the click LANDS: the turn holding the decision, not the worker.
      const focusOn =
        awaiting[0] ??
        (pausedRuns[0] ? orchestrationForRun(orchestrations, pausedRuns[0].id) : null);
      return {
        worker,
        review,
        pausedRuns: pausedRuns.length,
        home: showHome ? homeByWorkerId[worker.id] ?? '' : '',
        runs: claimed,
        starved: starved.has(worker.id),
        live: summary.live,
        today,
        recent,
        newest: recent[0] ?? null,
        target: focusOn ? { orchestrationId: focusOn.id, at: focusOn.createdAt } : null,
      };
    });
    return {
      now,
      groups: groupBoard(entries),
      entries,
      roster,
      homeByWorkerId,
      showHome,
    };
  }, [
    roster,
    workerHistory,
    runners,
    shiftProgress,
    allocation,
    homeByWorkerId,
    showHome,
    orchestrations,
  ]);
}
