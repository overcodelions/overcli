// The processes Today reads: every process with something live on it, as
// its board. Polled only while Today is on screen, on the Processes view's
// own cadence; the rail's Today badge reads what the last poll found.

import { useEffect } from 'react';
import { create } from 'zustand';

import { useTeamsStore } from '../../teamsStore';
import type { ProcessBoardData } from './todayBoard';

/// The Processes view asks main again this often; Today keeps the same pace.
export const PROCESS_POLL_MS = 10_000;

interface TodayProcessesState {
  boards: ProcessBoardData[];
  /// Asks main and keeps what came back. A process that fails to load
  /// keeps its last board rather than vanishing for one poll.
  load(): Promise<void>;
  clear(): void;
}

let inFlight = false;

export const useTodayProcesses = create<TodayProcessesState>((set, get) => ({
  boards: [],
  async load() {
    if (inFlight) return;
    inFlight = true;
    try {
      const list = await window.overcli.invoke('processes:list');
      // Only a process with live items can need you or be in flight: the
      // list says which, so the rest cost nothing.
      const live = list.filter((p) => !p.archived && p.active > 0);
      const prev = new Map(get().boards.map((b) => [b.process.id, b]));
      const boards = await Promise.all(
        live.map(async (p): Promise<ProcessBoardData | null> => {
          const res = await window.overcli.invoke('processes:get', { id: p.id }).catch(() => null);
          if (res && res.ok) return { process: res.process, items: res.items };
          return prev.get(p.id) ?? null;
        }),
      );
      set({ boards: boards.filter((b): b is ProcessBoardData => !!b) });
    } catch {
      // Main not ready, or processes not set up: nothing to show.
    } finally {
      inFlight = false;
    }
  },
  clear() {
    if (get().boards.length) set({ boards: [] });
  },
}));

/// Keep the process boards fresh while the caller is mounted: now, every
/// PROCESS_POLL_MS, and when a team task changes (a stage finishing moves
/// its item on). Off clears them, so a lab turned off leaves no stale rows.
export function usePollTodayProcesses(enabled: boolean): void {
  const tasks = useTeamsStore((s) => s.tasks);
  useEffect(() => {
    if (!enabled) {
      useTodayProcesses.getState().clear();
      return;
    }
    void useTodayProcesses.getState().load();
  }, [enabled, tasks]);
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => void useTodayProcesses.getState().load(), PROCESS_POLL_MS);
    return () => clearInterval(t);
  }, [enabled]);
}
