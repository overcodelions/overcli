// Keeps the renderer's per-conversation `isRunning` flags honest against
// the main process.
//
// The running indicator is edge-triggered: main emits `running: true` when
// a turn starts and `running: false` when it ends. Anything that eats the
// closing edge — an event dropped while the window reloads, or a state main
// itself abandoned — leaves the flag stuck on. That's not just a cosmetic
// spinner: `runIsLive` (FlowRunSidebarRow) ORs a run's participant
// conversations into the run's own liveness, so one stranded flag makes a
// finished flow run read as still working for the rest of the session.
//
// Main can't push a correction (it has nothing to correct — from its side
// the event was sent), so the renderer pulls: every tick we ask which
// conversations main considers busy and clear any local flag that isn't in
// that set. Main runs its own sweep for states it can't clear either
// (`RunnerManager.reconcileRunning`), so the snapshot is authoritative
// rather than just "what we last emitted".

import { useEffect } from 'react';
import { staleRunningIds, useRunnersStore } from './runnersStore';

/// Poll cadence. Slow on purpose — this is a repair path, not a source of
/// truth, and every real transition still arrives as an event.
export const RUNNING_RECONCILE_INTERVAL_MS = 30_000;

export function useRunningReconcile(): void {
  useEffect(() => {
    let cancelled = false;

    const reconcile = async () => {
      const runners = useRunnersStore.getState().runners;
      // Nothing claims to be running — skip the round trip entirely.
      if (!Object.values(runners).some((r) => r.isRunning)) return;
      let snapshot: { conversationId: string }[];
      try {
        snapshot = await window.overcli.invoke('runner:runningSnapshot');
      } catch {
        return; // main busy or shutting down; try again next tick
      }
      if (cancelled) return;
      const live = new Set(snapshot.map((s) => s.conversationId));
      const stale = staleRunningIds(useRunnersStore.getState().runners, live, Date.now());
      for (const id of stale) {
        useRunnersStore.getState().patchRunner(id, {
          isRunning: false,
          runningSince: null,
          activityLabel: undefined,
        });
      }
    };

    void reconcile();
    const timer = setInterval(() => void reconcile(), RUNNING_RECONCILE_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
}
