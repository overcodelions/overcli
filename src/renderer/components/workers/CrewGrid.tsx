// The crew, as a room you can see all of at once.
//
// The sidebar roster is a TRIAGE RAIL: it ranks by how much of your attention
// a worker is asking for, and it folds everything that is asking for none —
// which on a normal morning is most of them. Thirteen quiet workers and five
// benched ones collapse to two rows, and that is the right call for a 415px
// column whose top belongs to whatever went wrong. It does mean the roster
// you actually keep is invisible the moment it is behaving.
//
// So this is the other half, and it lives where there is room for it: the
// Today page, under the spine, in a pane that on a quiet day was otherwise
// nine hundred pixels of nothing. Three rules:
//
//   1. THE SEAT NEVER MOVES. The board regroups a worker every time its state
//      changes, so the roster never looks the same twice and you re-read it
//      from the top on every visit. Here position is funding order and
//      nothing else; state rides on the tile — the pill, the border, the
//      live face — so you can learn the room and then notice the one thing
//      that is different without reading a word.
//   2. EVERY TILE CAN BE SPOKEN TO. An errand was reachable only from the
//      bottom of a desk page, one click in, behind a roster that had folded
//      the worker away. Nothing on any surface said speech was possible. The
//      stub on every tile is the smallest honest fix: not a hover reveal —
//      a hover-only affordance is how this problem gets made — and not a new
//      idea either, just the desk's own composer, mounted where you already
//      are.
//   3. THE STARTERS DO THE TEACHING. An empty box asks you to invent the
//      genre before you know there is one. Two examples in the user's own
//      voice teach the whole feature at a glance, which is why they sit
//      under the box rather than inside a tooltip about it.

import { useEffect, useMemo, useState } from 'react';

import { useStore } from '../../store';
import { useWorkersStore } from '../../workersStore';
import { WorkerAvatar } from './WorkerAvatar';
import { WorkerErrandComposer } from './WorkerDesk';
import { useWorkerBoard } from './useWorkerBoard';
import {
  DAY_MARKS,
  boardLine,
  boardReasons,
  dayProgress,
  dayTicks,
  type BoardEntry,
  type DayTick,
} from './workerBoard';
import { workerErrandStarters, workerTagline } from '@shared/flows/worker';

/// A tick's colour is what it wants from you — the same ladder the sidebar
/// strip uses, because a mark must not mean two things in one app.
const TICK_TINT: Record<DayTick['kind'], string> = {
  running: 'bg-emerald-400',
  review: 'bg-violet-500',
  errand: 'bg-accent',
  shift: 'bg-ink-muted',
};

export function CrewGrid() {
  const board = useWorkerBoard();
  const selectWorker = useWorkersStore((s) => s.selectWorker);
  const shiftProgress = useWorkersStore((s) => s.shiftProgress);
  // Which tile is holding a composer. One at a time: two open boxes is two
  // drafts you have to remember, and the desk already keeps a per-worker
  // draft for the one you abandon.
  const [asking, setAsking] = useState<string | null>(null);

  const { active, bench } = useMemo(() => {
    const active: BoardEntry[] = [];
    const bench: BoardEntry[] = [];
    for (const entry of board.entries) (entry.worker.enabled ? active : bench).push(entry);
    return { active, bench };
  }, [board.entries]);

  // A composer left open on a worker that got paused or dropped would be a
  // box with nowhere to send.
  useEffect(() => {
    if (asking && !board.entries.some((e) => e.worker.id === asking && e.worker.enabled)) {
      setAsking(null);
    }
  }, [asking, board.entries]);

  if (board.entries.length === 0) return null;

  return (
    <section className="mt-10 border-t border-card pt-5">
      <div className="flex items-baseline gap-2">
        <h2 className="text-[13px] font-semibold text-ink">The crew</h2>
        <p className="text-[12px] text-ink-faint">
          Everyone you have hired, in funding order. Say something to any of them.
        </p>
      </div>

      <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(248px,1fr))] gap-3">
        {active.map((entry) => (
          <CrewTile
            key={entry.worker.id}
            entry={entry}
            now={board.now}
            asking={asking === entry.worker.id}
            onAsk={() => setAsking(entry.worker.id)}
            onClose={() => setAsking(null)}
            onOpen={() => selectWorker(entry.worker.id)}
            working={!!shiftProgress[entry.worker.id]}
          />
        ))}
      </div>

      {bench.length > 0 && <Bench entries={bench} onOpen={selectWorker} />}

      <Legend now={board.now} />
    </section>
  );
}

/// One worker: who, what it is doing, what it did today, and a way to speak
/// to it. In that order, because the first three are read and the fourth is
/// acted on.
function CrewTile({
  entry,
  now,
  asking,
  onAsk,
  onClose,
  onOpen,
  working,
}: {
  entry: BoardEntry;
  now: number;
  asking: boolean;
  onAsk: () => void;
  onClose: () => void;
  onOpen: () => void;
  working: boolean;
}) {
  const worker = entry.worker;
  const ticks = useMemo(() => dayTicks(entry.today, now), [entry.today, now]);
  const tagline = workerTagline(worker);
  const reasons = boardReasons(entry);
  const status = working ? 'working a shift' : entry.live ? 'running' : null;
  const line = boardLine(entry, status, tagline);
  const wants = entry.review > 0 || entry.pausedRuns > 0 || entry.starved;

  return (
    <div
      className={
        'flex flex-col gap-2 rounded-lg border p-3 transition-colors ' +
        (asking
          ? 'border-accent bg-card-strong'
          : wants
            ? 'border-amber-500/40 bg-card'
            : 'border-card bg-card hover:border-card-strong')
      }
    >
      {asking ? (
        <Asking worker={worker} onClose={onClose} />
      ) : (
        <>
          <div className="flex items-start gap-2">
            <button
              onClick={onOpen}
              className="flex min-w-0 flex-1 items-start gap-2 text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
              title={`Open ${worker.name}’s desk`}
            >
              <WorkerAvatar worker={worker} size="sm" live={entry.live} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-semibold text-ink">
                  {worker.name}
                </span>
                {/* The tagline is the floor, not the default: it is true all
                    day and says nothing about today, so it sits UNDER the
                    line that does. */}
                <span className="mt-px block truncate text-[10px] text-ink-faint">
                  {tagline}
                </span>
              </span>
            </button>
            {reasons && (
              <span className="shrink-0 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9px] text-amber-600 dark:text-amber-300">
                {reasons}
              </span>
            )}
          </div>

          <p className="min-h-[15px] text-[11px] leading-snug text-ink-muted">{line}</p>

          <DayRule ticks={ticks} now={now} name={worker.name} />

          {/* Persistent, never a hover reveal. This is the one line on the
              page whose whole job is to say that a worker is a thing you can
              talk to. */}
          <button
            onClick={onAsk}
            className="flex items-center gap-1.5 rounded border border-dashed border-card-strong bg-card px-2 py-1.5 text-left text-[10px] text-ink-faint hover:border-accent/60 hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
          >
            <ErrandGlyph />
            {/* The WHOLE name, clipped by the column rather than shortened to
                its first word. A worker called "Slack Question Fielder" came
                out as "Ask Slack…", which is not an abbreviation — it is a
                name that does not exist, and the one the worker answers to is
                the exact string a delegating colleague has to retype (see
                `resolveHandoffTarget`). Clipping is honest; inventing is not. */}
            <span className="truncate">Ask {worker.name}…</span>
          </button>
        </>
      )}
    </div>
  );
}

/// The tile with its composer out. It mounts the DESK's composer rather than
/// a textarea of its own: same @-mention lookup rooted at the worker's
/// project, same ArrowUp history, same paste and drop handling, same
/// per-worker draft — so a half-typed errand here is the same half-typed
/// errand the desk has when you walk over to it.
function Asking({
  worker,
  onClose,
}: {
  worker: BoardEntry['worker'];
  onClose: () => void;
}) {
  const setDraft = useStore((s) => s.setDraft);
  const draftKey = `worker-errand:${worker.id}`;
  const draft = useStore((s) => s.conversationDrafts[draftKey] ?? '');
  const starters = useMemo(() => workerErrandStarters(worker), [worker]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <WorkerAvatar worker={worker} size="xs" />
        <span className="min-w-0 flex-1 truncate text-[11px] text-ink-muted">
          Errand for <span className="font-semibold text-ink">{worker.name}</span>
        </span>
        <button
          onClick={onClose}
          className="shrink-0 text-[10px] text-ink-faint hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
          title="Close"
        >
          Close
        </button>
      </div>

      <WorkerErrandComposer worker={worker} />

      {/* Only while the box is empty. Once there are words in it the starters
          are a way to lose them. */}
      {draft.trim() === '' && (
        <div className="flex flex-wrap gap-1">
          {starters.map((starter) => (
            <button
              key={starter}
              onClick={() => setDraft(draftKey, starter)}
              className="max-w-full truncate rounded-full border border-card-strong bg-card px-2 py-0.5 text-[10px] text-ink-faint hover:border-accent/60 hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
              title={starter}
            >
              {starter}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/// The worker's day, hour-aligned. Wider than the sidebar's 60px rule, which
/// is the point: at full pane width an hour is worth real pixels, so a
/// morning's turns stop landing on top of each other.
function DayRule({ ticks, now, name }: { ticks: DayTick[]; now: number; name: string }) {
  const progress = dayProgress(now);
  return (
    <span
      title={ticks.length === 0 ? `${name} — nothing today` : `${name} — ${ticks.length} today`}
      className="relative block h-4 w-full overflow-hidden rounded-[2px] border border-card bg-card-strong"
    >
      {DAY_MARKS.map((mark) => (
        <span
          key={mark.label}
          aria-hidden
          className="absolute inset-y-0 w-px bg-card-strong"
          style={{ left: `${mark.pos * 100}%` }}
        />
      ))}
      <span
        aria-hidden
        className="absolute inset-y-0 right-0 bg-[color:var(--c-surface)]/45"
        style={{ left: `${(progress * 100).toFixed(2)}%` }}
      />
      <span
        aria-hidden
        className="absolute inset-y-0 w-px bg-accent/70"
        style={{ left: `${(progress * 100).toFixed(2)}%` }}
      />
      {ticks.map((tick) => (
        <span
          key={tick.id}
          aria-hidden
          title={tick.title}
          className={'absolute inset-y-px w-[3px] rounded-[1px] ' + TICK_TINT[tick.kind]}
          style={{ left: `calc(${(tick.pos * 100).toFixed(2)}% - ${(tick.pos * 3).toFixed(2)}px)` }}
        />
      ))}
    </span>
  );
}

/// The bench, as one row of faces. A benched worker holds no funds and keeps
/// no clock — but its desk is not the thing that was switched off, so the row
/// says so rather than leaving you to guess.
function Bench({
  entries,
  onOpen,
}: {
  entries: BoardEntry[];
  onOpen: (id: string) => void;
}) {
  return (
    <div className="mt-3 flex items-center gap-3 rounded-lg border border-dashed border-card px-3 py-2">
      <span className="shrink-0 text-[9px] uppercase tracking-[0.14em] text-ink-faint">
        Bench · {entries.length}
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap gap-x-3 gap-y-1">
        {entries.map((entry) => (
          <button
            key={entry.worker.id}
            onClick={() => onOpen(entry.worker.id)}
            className="flex items-center gap-1.5 text-[11px] text-ink-muted hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
          >
            <WorkerAvatar worker={entry.worker} size="xs" />
            <span className="truncate">{entry.worker.name}</span>
          </button>
        ))}
      </div>
      <span className="shrink-0 text-[10px] text-ink-faint">no clock, no cost</span>
    </div>
  );
}

function Legend({ now }: { now: number }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[9px] text-ink-faint">
      <span className="tabular-nums">
        {new Date(now).toLocaleDateString(undefined, {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
        })}
      </span>
      {(
        [
          ['shift', 'shift · it decided'],
          ['errand', 'errand · you asked'],
          ['review', 'to review'],
          ['running', 'running'],
        ] as Array<[DayTick['kind'], string]>
      ).map(([kind, label]) => (
        <span key={kind} className="flex items-center gap-1">
          <span aria-hidden className={'block h-2 w-[3px] rounded-[1px] ' + TICK_TINT[kind]} />
          {label}
        </span>
      ))}
      <span className="flex items-center gap-1">
        <span aria-hidden className="block h-2 w-2 rounded-[1px] bg-[color:var(--c-surface)]/45 ring-1 ring-inset ring-card-strong" />
        not yet today
      </span>
    </div>
  );
}

/// An errand is speech, and speech came from you.
function ErrandGlyph() {
  return (
    <svg
      viewBox="0 0 12 12"
      aria-hidden
      className="h-2.5 w-2.5 shrink-0 text-accent"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 2.6h8a1 1 0 0 1 1 1v3.6a1 1 0 0 1-1 1H5.4L3 10.4V8.2H2a1 1 0 0 1-1-1V3.6a1 1 0 0 1 1-1Z" />
    </svg>
  );
}
