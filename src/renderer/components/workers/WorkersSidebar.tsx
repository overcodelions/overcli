// The Workers tab's navigator — a shift board.
//
// Its job is not to describe workers, it is to allocate attention: who needs
// you, who is working, and what each one did last. Five decisions follow from
// that, and each removes something an earlier version showed:
//
//   1. TRUST IS A SHAPE, NOT A WORD. Every row used to carry "probation" /
//      "trusted" / "autonomous" in its own tint, so six workers put six
//      coloured words next to the six names they were supposed to annotate.
//      It now rides on the avatar's ring — dashed, solid, doubled — leaving
//      colour free to say WHO. The tooltip and Settings still say it in words.
//   2. WHAT NEEDS YOU COMES FIRST. The review pill was already the only loud
//      thing in the column, but finding it still meant scanning the whole
//      roster for violet. The "Needs you" block at the top lists exactly the
//      workers that cannot proceed without a person — work proposed, a run
//      paused, a pay queue run dry — and is absent when nobody does.
//   3. THE ROSTER FOLDS BY DEFAULT. Ten workers pre-expanded into sixty rows
//      buried the one act this list exists for: picking a worker. A folded
//      row is a name, a status, and a count; opening it is one click, the
//      selection opens it for you, and the openings persist across launches.
//   4. ONE LIST UNDER A WORKER, NOT THREE. "Errands" / "Shifts" / "Flows"
//      captions repeated per worker were structure describing itself. Turns
//      now sit in a single newest-first list — an errand is your words behind
//      a speech bubble, a shift names itself ("Shift 12") behind a clock — and
//      a turn's flows live where the turn does, on the desk. The runs that
//      still need a person are precisely the ones "Needs you" already lists.
//   5. IDLE WORKERS SAY NOTHING. "no work yet" on four of six rows is not
//      status, it is noise. An absent line is the correct rendering of nothing
//      happening.

import { useCallback, useEffect, useMemo, useState } from "react";

import { useFlowsStore } from "../../flowsStore";
import { useOrchestratorStore } from "../../orchestratorStore";
import { useRunningMap } from "../../runnersStore";
import { useStore } from "../../store";
import { newWorkerDraft, useWorkersStore } from "../../workersStore";
import {
  benchRoster,
  moveWithinGroup,
  sortRoster,
  workerTagline,
  type Worker,
} from "@shared/flows/worker";
import type { TreasuryAllocation } from "@shared/flows/treasury";
import { WorkerAvatar } from "./WorkerAvatar";
import { TRUST_LABEL } from "./WorkerRowParts";
import {
  describeActivity,
  deskMatchesQuery,
  orchestrationForRun,
  relativeTime,
  summarizeDesk,
  workerActivity,
  sidebarActivity,
  sidebarShifts,
  workerDeskOrchestrations,
  workerDeskRuns,
  type WorkerActivity,
} from "./workerDeskSelectors";
import { buildWorkQueue } from "./workQueue";

/// How many turns hang under an open worker, errands and shifts together. Five:
/// a busy morning is visible without one worker pushing the rest of the roster
/// off screen; the desk has the whole day.
const NESTED_TURNS = 5;
/// Backstop for the shift-thinning rule — see sidebarShifts, which keeps the
/// newest plus whatever still owes you a decision. Only a worker holding an
/// implausible pile of unreviewed shifts hits this.
const NESTED_SHIFTS = 4;
/// How deep we look for those turns before the day filter runs.
const ACTIVITY_SCAN = 40;

export function WorkersSidebar({
  query,
  expanded,
  onToggleExpanded,
  onExpand,
}: {
  query: string;
  // Folded unless the user opened it — the OPPOSITE of the project tree's
  // model. A project group is a container you file into and default-open pays
  // for itself; a roster is a list of names you pick from, and ten workers
  // arriving pre-exploded buried the picking. The set lives in the Sidebar,
  // persisted there, because the collapse-all button up in the search row
  // folds this roster too.
  expanded: Set<string>;
  onToggleExpanded: (id: string) => void;
  // Selecting a worker opens it — see the effect below.
  onExpand: (id: string) => void;
}) {
  const workers = useWorkersStore((s) => s.workers);
  const shiftProgress = useWorkersStore((s) => s.shiftProgress);
  const selectedWorkerId = useWorkersStore((s) => s.selectedWorkerId);
  const selectWorker = useWorkersStore((s) => s.selectWorker);
  const openWorkerActivity = useWorkersStore((s) => s.openWorkerActivity);
  const view = useWorkersStore((s) => s.view);
  const showToday = useWorkersStore((s) => s.showToday);
  const showQueue = useWorkersStore((s) => s.showQueue);
  const showCalendar = useWorkersStore((s) => s.showCalendar);
  const showFunds = useWorkersStore((s) => s.showFunds);
  const showReport = useWorkersStore((s) => s.showReport);
  const allocation = useWorkersStore((s) => s.allocation);
  const openEditor = useWorkersStore((s) => s.openEditor);
  const openHire = useWorkersStore((s) => s.openHire);
  const importFromFile = useWorkersStore((s) => s.importFromFile);
  const runs = useFlowsStore((s) => s.runs);
  // Same reason as the pane: a run answering a post-completion turn is live
  // work, and only the participant's runner knows it.
  const runners = useRunningMap();
  const runsLoaded = useFlowsStore((s) => s.runsLoaded);
  const orchestrations = useOrchestratorStore((s) => s.orchestrations);
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);

  // The worker you are reading is never folded: selecting one records it as
  // open, and the record persists, so the roster reopens the way you left it.
  // Folding it back by hand still works — this only ADDS, and is idempotent
  // because it fires on every render the selection is visible.
  useEffect(() => {
    if (view === "worker" && selectedWorkerId) onExpand(selectedWorkerId);
  }, [view, selectedWorkerId, onExpand]);

  // Search matches a worker's own runs too, not just its name — you look for a
  // worker by what it did at least as often as by what it is called.
  const roster = useMemo(
    () =>
      sortRoster(
        Object.values(workers).filter((w) =>
          query ? deskMatchesQuery(w, workerDeskRuns(runs, w.id), query) : true,
        ),
      ),
    [workers, query, runs],
  );
  // Paused workers sink to a bench below the ones that run. `roster` stays
  // the whole list — the empty state and the "needs you" block are about
  // every worker you have, benched or not.
  const { active, benched } = useMemo(() => benchRoster(roster), [roster]);
  const dropWorker = useWorkersStore((s) => s.dropWorker);
  // A nudge moves the worker within the group it is DRAWN in. Resolved
  // against the full roster (not the search-filtered one) so ordering while a
  // query is active can't reshuffle the workers the query hid.
  const moveInGroup = useCallback(
    (group: Worker[], id: string, direction: -1 | 1) => {
      const all = sortRoster(Object.values(workers));
      const insertBefore = moveWithinGroup(all, group, id, direction);
      if (insertBefore !== null) void dropWorker(id, insertBefore);
    },
    [workers, dropWorker],
  );
  const hirePath = workspaces[0]?.rootPath ?? projects[0]?.path ?? "";
  const [hireMenuOpen, setHireMenuOpen] = useState(false);
  const hireEveryday = projects.find((project) => project.path === hirePath)?.everyday;

  // The attention block: exactly the workers that cannot proceed without a
  // person. Proposed work waiting on approval, a run paused mid-flight, a pay
  // queue that ran dry above them. Computed over the (search-filtered) roster
  // so a query narrows this too, and absent entirely when nobody needs you —
  // an empty inbox renders as no inbox.
  const needsYou = useMemo(() => {
    const starved = new Set(
      (allocation?.byWorker ?? [])
        .filter((f) => f.blocked === "pool")
        .map((f) => f.workerId),
    );
    return roster
      .map((worker) => {
        const awaiting = workerDeskOrchestrations(
          orchestrations,
          worker.id,
        ).awaiting;
        const review = awaiting.reduce(
          (count, o) =>
            count + o.items.filter((item) => item.status === "proposed").length,
          0,
        );
        const pausedRuns = workerDeskRuns(runs, worker.id).filter(
          (run) => run.state.kind === "paused",
        );
        // Where the click LANDS: the turn holding the decision, not the
        // worker. Selecting the worker opens the desk on today, and the
        // thing that needs you may be a turn from Tuesday — a "needs you"
        // row that lands on a clean desk is a door painted on a wall.
        // Proposed work outranks a paused run, the newest of either stands
        // for the rest, and the desk shows that turn's whole day anyway.
        const focusOn =
          awaiting[0] ??
          (pausedRuns[0]
            ? orchestrationForRun(orchestrations, pausedRuns[0].id)
            : null);
        return {
          worker,
          review,
          paused: pausedRuns.length,
          starved: starved.has(worker.id),
          target: focusOn
            ? { orchestrationId: focusOn.id, at: focusOn.createdAt }
            : null,
        };
      })
      .filter((entry) => entry.review > 0 || entry.paused > 0 || entry.starved);
  }, [roster, orchestrations, runs, allocation]);

  // Only the count, not the queue itself: the pane draws the rows, and the
  // sidebar has room for one bit of it.
  const queueRunning = useMemo(
    () =>
      buildWorkQueue(orchestrations, runs, workers, shiftProgress, Date.now(), runsLoaded, runners)
        .running.length,
    [orchestrations, runs, workers, shiftProgress, runsLoaded, runners],
  );

  return (
    <>
      {needsYou.length > 0 && (
        <>
          <div className="mt-1 px-2 text-[10px] uppercase tracking-wider text-ink-faint">
            Needs you
          </div>
          {needsYou.map((entry) => (
            <NeedsYouRow
              key={entry.worker.id}
              entry={entry}
              onSelect={() => {
                if (entry.target) {
                  openWorkerActivity(
                    entry.worker.id,
                    entry.target.orchestrationId,
                    entry.target.at,
                  );
                } else if (entry.starved) {
                  // Nothing to review and nothing paused — the row exists
                  // because the pay queue ran dry, and the fix (re-order,
                  // re-fund) lives on the Funds pane, not the desk.
                  showFunds();
                } else {
                  selectWorker(entry.worker.id);
                }
              }}
            />
          ))}
        </>
      )}

      {/* The tab's landing page: one day, every worker, in the order it
          happened. The dot is the only live thing in this column — it says
          the crew is working without saying how much, which is the pane's
          job — and it lives HERE rather than on the queue below because this
          is the screen it would send you to. */}
      <button
        onClick={showToday}
        title="Where the crew is right now, and what it has done today"
        className={
          "sidebar-row mb-1 mt-1 flex w-full items-center gap-2 rounded px-2 py-1 text-left " +
          "hover:bg-card-strong hover:text-ink hover:border-card " +
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 " +
          (view === "today"
            ? "sidebar-row-selected text-ink"
            : "text-ink-muted")
        }
      >
        <TodayIcon />
        <span className="truncate text-[13px] leading-tight">Today</span>
        {queueRunning > 0 && (
          <span
            aria-hidden
            title={`${queueRunning} job(s) running`}
            className="ml-auto h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent"
          />
        )}
      </button>

      {/* Under Today, because it answers the same question with the day taken
          off: any job the crew has ever run, found by searching rather than
          by scrolling to the hour it happened. */}
      <button
        onClick={showQueue}
        title="Every job the crew has run — filter it, find it, act on it"
        className={
          "sidebar-row mb-1 mt-1 flex w-full items-center gap-2 rounded px-2 py-1 text-left " +
          "hover:bg-card-strong hover:text-ink hover:border-card " +
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 " +
          (view === "queue"
            ? "sidebar-row-selected text-ink"
            : "text-ink-muted")
        }
      >
        <QueueIcon />
        <span className="truncate text-[13px] leading-tight">Work queue</span>
      </button>

      {/* Above the roster, not in it: the calendar is about every worker at
          once, so it is not one of the names it sits over. */}
      <button
        onClick={showCalendar}
        title="When every worker's shifts fall, this week"
        className={
          "sidebar-row mb-1 flex w-full items-center gap-2 rounded px-2 py-1 text-left " +
          "hover:bg-card-strong hover:text-ink hover:border-card " +
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 " +
          (view === "calendar"
            ? "sidebar-row-selected text-ink"
            : "text-ink-muted")
        }
      >
        <CalendarIcon />
        <span className="truncate text-[13px] leading-tight">
          Shift calendar
        </span>
      </button>

      {/* Under the calendar, above the names: the pot the whole roster draws
          from. It sits here because the roster below it IS the funding queue —
          the money and the order it is paid in should not be two screens
          apart. The bar is the sidebar's whole report; the numbers live on the
          pane it opens. */}
      {allocation && (
        <button
          onClick={showFunds}
          title={`$${allocation.spentUSD.toFixed(2)} of $${allocation.poolUSD.toFixed(0)} spent this month`}
          className={
            "sidebar-row mb-1 flex w-full items-center gap-2 rounded px-2 py-1 text-left " +
            "hover:bg-card-strong hover:text-ink hover:border-card " +
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 " +
            (view === "funds"
              ? "sidebar-row-selected text-ink"
              : "text-ink-muted")
          }
        >
          <PotIcon />
          <span className="truncate text-[13px] leading-tight">Funds</span>
          <span className="ml-auto flex items-center gap-1.5">
            {starvedCount(allocation) > 0 && (
              <span
                aria-hidden
                title={`${starvedCount(allocation)} worker(s) unfunded`}
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
              />
            )}
            <span className="h-1 w-10 shrink-0 overflow-hidden rounded-full bg-card-strong">
              <span
                className="block h-full bg-accent"
                style={{
                  width: `${Math.min(100, allocation.poolUSD > 0 ? (allocation.spentUSD / allocation.poolUSD) * 100 : 0)}%`,
                }}
              />
            </span>
          </span>
        </button>
      )}

      <button
        onClick={showReport}
        title="Shifts, outcomes, tokens and time across the roster"
        className={
          "sidebar-row mb-1 flex w-full items-center gap-2 rounded px-2 py-1 text-left " +
          "hover:bg-card-strong hover:text-ink hover:border-card " +
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 " +
          (view === "report"
            ? "sidebar-row-selected text-ink"
            : "text-ink-muted")
        }
      >
        <CalendarIcon />
        <span className="truncate text-[13px] leading-tight">Report</span>
      </button>

      <div className="mt-1 flex items-center gap-1.5 px-2">
        <span className="text-[10px] uppercase tracking-wider text-ink-faint">
          Workers
        </span>
        {/* Hiring belongs on the roster, not only in the pane header — this is
            the list you look at when you notice nobody covers something. */}
        {hirePath !== "" && (
          <div className="relative ml-auto">
            <button
              onClick={() => setHireMenuOpen((open) => !open)}
              title="Add a worker"
              aria-label="Add a worker"
              aria-haspopup="menu"
              aria-expanded={hireMenuOpen}
              className="rounded px-1 text-[11px] leading-none text-ink-faint hover:bg-card-strong hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
            >
              +
            </button>
            {hireMenuOpen && (
              <div
                role="menu"
                className="absolute right-0 top-full z-40 mt-1 w-36 overflow-hidden rounded-md border border-card-strong bg-surface-elevated py-1 shadow-xl"
              >
                <button
                  role="menuitem"
                  onClick={() => {
                    setHireMenuOpen(false);
                    openHire(hirePath);
                  }}
                  className="w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-card-strong"
                >
                  ✨ Hire with AI
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setHireMenuOpen(false);
                    openEditor(newWorkerDraft(hirePath, hireEveryday));
                  }}
                  className="w-full px-3 py-1.5 text-left text-xs text-ink-muted hover:bg-card-strong hover:text-ink"
                >
                  Add by hand
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setHireMenuOpen(false);
                    void importFromFile({
                      projectPath: hirePath,
                      projectPaths: projects.map((project) => project.path),
                    });
                  }}
                  className="w-full px-3 py-1.5 text-left text-xs text-ink-muted hover:bg-card-strong hover:text-ink"
                >
                  Import…
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {roster.length === 0 ? (
        <div className="px-2 py-1 text-[10px] text-ink-faint">
          {query ? "No matching workers" : "Nobody works here yet"}
        </div>
      ) : (
        <>
          {active.map((worker, index) => (
            <RosterRow
              key={worker.id}
              worker={worker}
              query={query}
              selected={view === "worker" && worker.id === selectedWorkerId}
              onSelect={() => selectWorker(worker.id)}
              canMoveUp={index > 0}
              canMoveDown={index < active.length - 1}
              onMove={(direction) => moveInGroup(active, worker.id, direction)}
              // A search is a request to SEE things; honouring a fold while one
              // is running would hide the row that matched it.
              expanded={query !== "" || expanded.has(worker.id)}
              onToggleExpanded={() => onToggleExpanded(worker.id)}
            />
          ))}
          {/* The bench. Paused workers are still yours — you rename them,
              re-enable them, read what they filed — but they do nothing
              today, and interleaved with the ones working they made the
              roster read as "here are your workers" when half of them
              weren't. The move arrows are bounded WITHIN each group, so
              nudging the last active worker down doesn't silently walk it
              onto the bench. */}
          {benched.length > 0 && (
            <div className="mt-2 px-2 text-[10px] uppercase tracking-wider text-ink-faint">
              Bench
            </div>
          )}
          {benched.map((worker, index) => (
            <RosterRow
              key={worker.id}
              worker={worker}
              query={query}
              selected={view === "worker" && worker.id === selectedWorkerId}
              onSelect={() => selectWorker(worker.id)}
              canMoveUp={index > 0}
              canMoveDown={index < benched.length - 1}
              onMove={(direction) => moveInGroup(benched, worker.id, direction)}
              // Nothing to unfold, so the fold state is not consulted.
              expanded={false}
              onToggleExpanded={() => onToggleExpanded(worker.id)}
              compact
            />
          ))}
        </>
      )}
    </>
  );
}

interface NeedsYouEntry {
  worker: Worker;
  review: number;
  paused: number;
  starved: boolean;
  /// The turn to open the desk ON — the one holding the decision. Null only
  /// when the row exists for funding alone, or a paused run's batch cannot
  /// be found.
  target: { orchestrationId: string; at: number } | null;
}

/// One worker that is waiting on a person, and why, in words. Clicking it
/// lands ON the decision: the desk opened at the waiting turn (whatever day
/// it happened), or the Funds pane for a worker that is merely unfunded —
/// the block's promise is one click to the thing needing you, not one click
/// to somewhere it might be. The violet pill repeats the count from the
/// roster row it summarizes; the amber dot is the same one the Funds row
/// uses for a starved pool.
function NeedsYouRow({
  entry,
  onSelect,
}: {
  entry: NeedsYouEntry;
  onSelect: () => void;
}) {
  const { worker, review, paused, starved } = entry;
  const reasons = [
    review > 0 && `${review} to review`,
    paused > 0 && (paused === 1 ? "a flow paused" : `${paused} flows paused`),
    starved && "unfunded",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <button
      onClick={onSelect}
      className={
        "sidebar-row mt-0.5 flex w-full items-center gap-2 rounded px-2 py-1 text-left " +
        "text-ink-muted hover:bg-card-strong hover:text-ink hover:border-card " +
        "focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
      }
      title={`${worker.name} · ${reasons}`}
    >
      <WorkerAvatar worker={worker} live={false} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] leading-tight">
          {worker.name}
        </span>
        <span className="block truncate text-[10px] leading-4 text-ink-faint">
          {reasons}
        </span>
      </span>
      {review > 0 && (
        <span
          className="shrink-0 rounded-full bg-violet-500 px-1.5 text-[10px] font-medium leading-4 text-white"
          title={`${review} waiting for your review`}
        >
          {review}
        </span>
      )}
      {(paused > 0 || starved) && (
        <span
          aria-hidden
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
        />
      )}
    </button>
  );
}

function starvedCount(allocation: TreasuryAllocation): number {
  return allocation.byWorker.filter((f) => f.blocked === "pool").length;
}

/// A pot, drawn as a pot: a rim wider than the body, and a level inside it.
/// The obvious glyph here was a dollar sign, which reads as "billing" — this
/// is a container with an amount in it, which is the actual idea.
function PotIcon() {
  return (
    <svg
      viewBox="0 0 14 14"
      aria-hidden
      className="h-3.5 w-3.5 shrink-0 text-ink-faint"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2.4 4.3h9.2l-1 6.4a1.4 1.4 0 0 1-1.4 1.2H4.8a1.4 1.4 0 0 1-1.4-1.2z" />
      <path d="M1.6 4.3h10.8" />
      <path d="M4 8.4h6" opacity="0.55" />
    </svg>
  );
}

/// A clock face with one hand, at the same 14-unit weight as its neighbours.
/// Deliberately not a calendar page — the calendar icon two rows down means
/// "which days", and this screen means "this day, by the hour".
function TodayIcon() {
  return (
    <svg
      viewBox="0 0 14 14"
      aria-hidden
      className="h-3.5 w-3.5 shrink-0 text-ink-faint"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
    >
      <circle cx="7" cy="7" r="5.2" />
      <path d="M7 4.1V7l2 1.5" />
    </svg>
  );
}

/// Three jobs stacked, the top one live. The dot on the first line is what
/// separates it from a plain list glyph — this column already has a list in
/// it, and the queue is the one that moves.
function QueueIcon() {
  return (
    <svg
      viewBox="0 0 14 14"
      aria-hidden
      className="h-3.5 w-3.5 shrink-0 text-ink-faint"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
    >
      <circle cx="2.6" cy="3.4" r="1.4" fill="currentColor" stroke="none" />
      <path d="M6 3.4h6.4M6 7h6.4M6 10.6h6.4M2.6 7h.01M2.6 10.6h.01" />
    </svg>
  );
}

/// A calendar leaf — two hangers, a head rule, one marked day. Drawn rather
/// than typed: the box-drawing glyph that stood here rendered as a grey square
/// at 10px and read as a bullet, not as a calendar.
function CalendarIcon() {
  return (
    <svg
      viewBox="0 0 14 14"
      aria-hidden
      className="h-3.5 w-3.5 shrink-0 text-ink-faint"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
    >
      <rect x="1.6" y="2.8" width="10.8" height="9.6" rx="1.6" />
      <path d="M1.6 5.6h10.8M4.6 1.6v2.2M9.4 1.6v2.2" />
      <rect
        x="4"
        y="7.6"
        width="2.4"
        height="2.2"
        rx="0.5"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}

function RosterRow({
  worker,
  query,
  selected,
  onSelect,
  canMoveUp,
  canMoveDown,
  onMove,
  expanded,
  onToggleExpanded,
  compact = false,
}: {
  worker: Worker;
  query: string;
  selected: boolean;
  onSelect: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  /// Supplied by the roster, because only IT knows which group this row is
  /// drawn in — see `moveWithinGroup`.
  onMove: (direction: -1 | 1) => void;
  expanded: boolean;
  onToggleExpanded: () => void;
  /// Bench rows. A paused worker has no work in flight, so the disclosure,
  /// the turn rail and the today-count below it are all affordances for
  /// something that isn't there — and "paused" under every name repeats the
  /// heading the group already carries. One line, name and face.
  compact?: boolean;
}) {
  const runs = useFlowsStore((s) => s.runs);
  const orchestrations = useOrchestratorStore((s) => s.orchestrations);
  const runners = useRunningMap();
  const shift = useWorkersStore((s) => s.shiftProgress[worker.id]);
  const openWorkerActivity = useWorkersStore((s) => s.openWorkerActivity);

  const claimedRuns = useMemo(
    () => workerDeskRuns(runs, worker.id),
    [runs, worker.id],
  );
  const batches = useMemo(
    () => workerDeskOrchestrations(orchestrations, worker.id),
    [orchestrations, worker.id],
  );
  const summary = useMemo(
    () => summarizeDesk(claimedRuns, batches.awaiting, runners, !!shift),
    [batches.awaiting, claimedRuns, runners, shift],
  );
  const recent = useMemo(
    () =>
      sidebarActivity(
        workerActivity(orchestrations, worker.id, ACTIVITY_SCAN),
        Date.now(),
        ACTIVITY_SCAN,
      ),
    [orchestrations, worker.id],
  );
  const sending = useWorkersStore((s) => s.errandSending[worker.id]);
  // One list, newest first. Every errand gets a row — each is a distinct
  // thing you asked for — while shifts thin by sidebarShifts' rule, because a
  // worker on an hourly cadence must not turn its corner of the roster into a
  // column of identical empty wake-ups. The two kinds tell themselves apart
  // without headings: a shift names itself ("Shift 12") behind a clock, an
  // errand is your own words behind a speech bubble.
  const turnsAll = useMemo(() => {
    const errands = recent.filter((item) => item.task === "errand");
    const shifts = sidebarShifts(
      recent.filter((item) => item.task === "shift"),
      NESTED_SHIFTS,
    );
    return [...errands, ...shifts].sort((a, b) => b.at - a.at);
  }, [recent]);
  const turns = turnsAll.slice(0, NESTED_TURNS);
  const overflow = turnsAll.length - turns.length;
  const hidden = turnsAll.length;
  const openTurn = (orchestrationId: string, at: number) =>
    openWorkerActivity(worker.id, orchestrationId, at);

  // Only what is true RIGHT NOW. Totals are history and live in Stats; putting
  // "11 done" here made an idle worker look busy.
  const tagline = workerTagline(worker);
  const status = !worker.enabled
    ? "paused"
    : shift
      ? shift.task === "errand"
        ? "on your errand"
        : "working a shift"
      : summary.running > 0
        ? `${summary.running} running`
        : null;

  return (
    <div className={"group/row relative " + (compact ? "mt-0.5" : "mt-1")}>
      <button
        onClick={onSelect}
        className={
          "sidebar-row flex w-full items-center gap-2 rounded px-2 text-left " +
          (compact ? "py-0.5 " : "py-1 ") +
          "hover:bg-card-strong hover:text-ink hover:border-card " +
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 " +
          (selected ? "sidebar-row-selected text-ink" : "text-ink-muted")
        }
        title={`${worker.name}${tagline ? ` — ${tagline}` : ''} · ${TRUST_LABEL[worker.trust].text}${
          summary.needReview > 0
            ? ` · ${summary.needReview} waiting for your review`
            : ""
        }`}
      >
        {compact ? (
          // Spacer, so a bench face lines up with the faces above it.
          <span aria-hidden className="w-[8px] shrink-0" />
        ) : (
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            // Folding is not selecting: a roster you have to open in order
            // to fold would defeat the point.
            e.stopPropagation();
            onToggleExpanded();
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.stopPropagation();
            e.preventDefault();
            onToggleExpanded();
          }}
          title={expanded ? `Collapse ${worker.name}` : `Expand ${worker.name}`}
          aria-label={
            expanded ? `Collapse ${worker.name}` : `Expand ${worker.name}`
          }
          className={
            "shrink-0 text-[8px] leading-none text-ink-faint transition-transform hover:text-ink " +
            (expanded ? "rotate-90" : "")
          }
        >
          ▸
        </span>
        )}
        <WorkerAvatar worker={worker} live={summary.live} />
        <span className="min-w-0 flex-1">
          {/* The name carries weight the child rows don't — in a folded roster
              the names ARE the list, and in an open one the eye needs to find
              where one worker ends and the next begins without counting
              indents. */}
          <span className="block truncate text-[13px] font-medium leading-tight">
            {worker.name}
          </span>
          {/* One second line, and what is happening beats what the worker is:
              a tagline is true all day, so it must not sit on top of "working
              a shift". Idle rows — most of the roster, most of the time — get
              the tagline, which is the only thing telling six personas apart
              at a glance. */}
          {!compact && (status || tagline) && (
            <span className="block truncate text-[10px] font-normal leading-4 text-ink-faint">
              {status ?? tagline}
            </span>
          )}
        </span>
        {/* The move controls sit absolutely at the row's right edge and only
            appear on hover; without this the count ends up underneath them. */}
        <span className="flex shrink-0 items-center gap-1.5 transition-[padding] duration-150 group-hover/row:pr-[34px]">
          {summary.needReview > 0 && (
            <span
              className="shrink-0 rounded-full bg-violet-500 px-1.5 text-[10px] font-medium leading-4 text-white"
              title={`${summary.needReview} waiting for your review`}
            >
              {summary.needReview}
            </span>
          )}
          {/* Folded away, the count of what is underneath is the only thing
              left saying this worker did anything today. */}
          {!compact && !expanded && hidden > 0 && (
            <span className="shrink-0 text-[10px] font-normal tabular-nums text-ink-faint">
              {hidden}
            </span>
          )}
        </span>
      </button>

      {/* Arranging the roster is a rare act, so it hides until you are on the
          row — the same treatment the project rows give their own controls.
          Absolutely positioned so revealing it can't reflow the name. */}
      <div className="absolute right-1 top-1 hidden items-center gap-0.5 group-hover/row:flex">
        {/* Position is priority and priority is funding, so these say what
            they cost rather than which way the row travels. */}
        <MoveButton
          label="Move up — funded before the workers below it"
          glyph="▲"
          disabled={!canMoveUp}
          onClick={() => onMove(-1)}
        />
        <MoveButton
          label="Move down — funded after the workers above it"
          glyph="▼"
          disabled={!canMoveDown}
          onClick={() => onMove(1)}
        />
      </div>

      {/* A rail, so the work reads as belonging to the worker above it rather
          than floating between two of them. Turns only: a turn's flows live
          where the turn does — click through to the desk — and the runs that
          still need a person are exactly the ones "Needs you" already lists,
          so putting a Flows group here listed the same work twice at the same
          level. */}
      {!compact && expanded && (sending?.length || turns.length > 0) && (
        <div className="ml-[13px] border-l border-card pl-2">
          {/* The errand you just sent, before any batch exists to represent it
              — the planning turn can take minutes, and a sidebar that shows
              nothing until it finishes reads as a message that went nowhere. */}
          {sending?.map((pending) => (
            <button
              key={pending.id}
              onClick={onSelect}
              className="group mt-0.5 flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-card-strong focus:outline-none"
              title={`${pending.text} — in flight`}
            >
              <TurnIcon task="errand" live />
              <span className="min-w-0 flex-1 truncate text-ink-muted">
                {pending.text}
              </span>
              <span className="shrink-0 text-[10px] text-ink-faint">…</span>
            </button>
          ))}
          {turns.map((item) => (
            <TurnRow
              key={item.orchestration.id}
              item={item}
              onOpen={openTurn}
            />
          ))}
          {/* The count says what was thinned away, because a rail that quietly
              drops four errands reads as a worker that only ran one. Clicking
              it opens the desk, which shows the whole day. */}
          {overflow > 0 && (
            <button
              onClick={onSelect}
              className="mt-0.5 w-full rounded px-2 py-0.5 text-left text-[10px] text-ink-faint hover:bg-card-strong hover:text-ink-muted focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
              title={`Open ${worker.name} — the desk shows the whole day`}
            >
              {overflow} more today
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/// The same 20px tile a flow run gets, so the turns under a worker line their
/// text up instead of stepping in and out. The glyphs say WHOSE the work is:
/// an errand is speech — you asked for it — and a shift is a clock, the
/// worker's own standing time.
function TurnIcon({
  task,
  live,
}: {
  task: "shift" | "errand";
  live?: boolean;
}) {
  const errand = task === "errand";
  return (
    <span
      aria-hidden
      title={errand ? "Errand" : "Shift"}
      className={
        "flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] " +
        (errand ? "bg-card-strong text-ink-muted" : "bg-card text-ink-faint") +
        (live ? " flow-monogram-live" : "")
      }
    >
      <svg
        viewBox="0 0 12 12"
        className="h-3 w-3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {errand ? (
          // A speech bubble with a tail: your words, handed over.
          <path d="M2 2.6h8a1 1 0 0 1 1 1v3.6a1 1 0 0 1-1 1H5.4L3 10.4V8.2H2a1 1 0 0 1-1-1V3.6a1 1 0 0 1 1-1Z" />
        ) : (
          // A clock: standing time the worker keeps on its own.
          <>
            <circle cx="6" cy="6" r="4.4" />
            <path d="M6 3.4V6l1.9 1.1" />
          </>
        )}
      </svg>
    </span>
  );
}

function MoveButton({
  label,
  glyph,
  disabled,
  onClick,
}: {
  label: string;
  glyph: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={(e) => {
        // The row underneath is a select; moving a worker is not selecting it.
        e.stopPropagation();
        if (!disabled) onClick();
      }}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="rounded bg-card px-1 text-[8px] leading-4 text-ink-faint hover:bg-card-strong hover:text-ink focus:outline-none disabled:opacity-25"
    >
      {glyph}
    </button>
  );
}

/// One turn under a worker. Clicking it opens THAT turn on the desk — on its
/// own day, expanded, with the flows it launched — rather than dropping you
/// on the worker to search again.
function TurnRow({
  item,
  onOpen,
}: {
  item: WorkerActivity;
  onOpen: (orchestrationId: string, at: number) => void;
}) {
  return (
    <button
      onClick={() => onOpen(item.orchestration.id, item.at)}
      className={
        "group mt-0.5 flex w-full items-center gap-2 rounded px-2 py-1 text-left " +
        "text-xs hover:bg-card-strong focus:outline-none " +
        "focus-visible:ring-1 focus-visible:ring-accent/50"
      }
      title={`${item.task === "errand" ? "Errand" : "Shift"} · ${item.title} · ${describeActivity(item)} · ${relativeTime(item.at)}`}
    >
      {/* The tile pulses while the turn still has flows in flight — with no
          Flows group underneath, this is the rail's only live signal. */}
      <TurnIcon task={item.task} live={item.running > 0} />
      <span
        className={
          "min-w-0 flex-1 truncate " +
          // An errand is something you said; it keeps your words in reading
          // ink. A shift is the worker's own doing — quieter.
          (item.task === "errand"
            ? "text-ink-muted group-hover:text-ink"
            : "text-ink-faint")
        }
      >
        {item.title}
      </span>
      {item.proposed > 0 && (
        <span
          className="shrink-0 rounded-full bg-violet-500 px-1 text-[9px] font-medium leading-4 text-white"
          title={`${item.proposed} waiting for your review`}
        >
          {item.proposed}
        </span>
      )}
      <span className="shrink-0 text-[10px] tabular-nums text-ink-faint">
        {relativeTime(item.at)}
      </span>
    </button>
  );
}
