// A quiet line that tells people an org server exists, at the moment one
// would help: a worker missed a shift because this Mac was asleep, or they
// are sharing a worker someone else might use.
//
// Never nags. One nudge a week at most, across all of them; each can be
// dismissed for good; and none show once this app is set up for an org.

import { useEffect, useState } from 'react';
import { useStore } from '../../store';

const KEY = 'overcli.orgNudges';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

interface NudgeState {
  dismissed: string[];
  shownId?: string;
  shownAt?: number;
}

function read(): NudgeState {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<NudgeState>;
    return { dismissed: Array.isArray(raw.dismissed) ? raw.dismissed : [], shownId: raw.shownId, shownAt: raw.shownAt };
  } catch {
    return { dismissed: [] };
  }
}

function write(state: NudgeState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Storage off: the nudge just shows again next time.
  }
}

/// Whether nudge `id` may show now: not dismissed, and either it's the one
/// already showing this week or no other has shown in the last week.
export function nudgeAllowed(state: NudgeState, id: string, now: number): boolean {
  if (state.dismissed.includes(id)) return false;
  if (!state.shownAt || now - state.shownAt > WEEK_MS) return true;
  return state.shownId === id;
}

export function OrgNudge({ id, children }: { id: string; children: React.ReactNode }) {
  const orgServerUrl = useStore((s) => s.settings.orgServerUrl);
  const openSheet = useStore((s) => s.openSheet);
  const [allowed] = useState(() => nudgeAllowed(read(), id, Date.now()));
  const [gone, setGone] = useState(false);
  const show = allowed && !gone && !orgServerUrl;
  useEffect(() => {
    if (!show) return;
    const state = read();
    if (state.shownId !== id || !state.shownAt || Date.now() - state.shownAt > WEEK_MS) write({ ...state, shownId: id, shownAt: Date.now() });
  }, [show, id]);
  if (!show) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-card-strong bg-card px-3 py-2 text-[12px] text-ink-muted">
      <span className="min-w-0 flex-1">{children}</span>
      <button onClick={() => openSheet({ type: 'settings', section: 'org' })} className="text-accent hover:underline">
        About org servers
      </button>
      <button
        onClick={() => {
          const state = read();
          write({ ...state, dismissed: [...new Set([...state.dismissed, id])] });
          setGone(true);
        }}
        className="text-ink-faint hover:text-ink"
      >
        Don’t show again
      </button>
    </div>
  );
}
