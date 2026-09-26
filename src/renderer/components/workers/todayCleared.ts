// "I've read this" for the Today list.
//
// Today is an inbox, and an inbox you can never empty stops being read: by
// the afternoon it is fifteen results long whether you have looked at them or
// not. Clearing takes a finished item out of the list — only out of the list.
// The run, its files and the worker's journal are untouched, it waits in a
// "cleared" fold under its day, and it comes back on its own when something
// new happens to it (a reply, a revision), because that is news again.
//
// Kept in localStorage: it is a reading position on this machine, not data
// anyone else needs, and losing it costs a re-read rather than any work.

import { create } from 'zustand';

const KEY = 'workers.todayCleared';
/// Long enough to cover the week the list shows, short enough that the map
/// never grows without bound.
const KEEP_MS = 14 * 24 * 60 * 60 * 1000;

type ClearedMap = Record<string, number>;

function load(): ClearedMap {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as ClearedMap;
    const cutoff = Date.now() - KEEP_MS;
    return Object.fromEntries(Object.entries(parsed).filter(([, at]) => typeof at === 'number' && at > cutoff));
  } catch {
    return {};
  }
}

function save(map: ClearedMap): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // A reading position, not data: failing to keep it costs a re-read.
  }
}

interface ClearedState {
  cleared: ClearedMap;
  clear: (key: string, at?: number) => void;
  restore: (key: string) => void;
}

export const useTodayCleared = create<ClearedState>((set) => ({
  cleared: load(),
  clear: (key, at = Date.now()) =>
    set((s) => {
      const cleared = { ...s.cleared, [key]: at };
      save(cleared);
      return { cleared };
    }),
  restore: (key) =>
    set((s) => {
      if (!(key in s.cleared)) return s;
      const cleared = { ...s.cleared };
      delete cleared[key];
      save(cleared);
      return { cleared };
    }),
}));

/// Where a row stands. `back` is a row you cleared that has changed since —
/// it is in the list again, and says why.
export type ClearState = 'unread' | 'cleared' | 'back';

export function clearStateOf(cleared: ClearedMap, key: string, at: number): ClearState {
  const when = cleared[key];
  if (when === undefined) return 'unread';
  return at > when ? 'back' : 'cleared';
}
