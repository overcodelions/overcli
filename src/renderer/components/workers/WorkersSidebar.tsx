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
//   2. THE ROSTER IS A BOARD, NOT A LIST. A worker's position says what it is
//      to you right now — waiting on you, running, worked today, quiet — and
//      it appears in exactly ONE of those (see `workerBoard`). The earlier
//      "Needs you" block was a summary drawn ABOVE the same rows it
//      summarized, which spent two rows saying one thing; now the group is
//      the row's home and it carries every signal the worker has.
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
//      happening — and the workers that did nothing at all fold into a single
//      row with their faces stacked on it, because four quiet workers are one
//      fact, not four.
//   6. THE WHOLE-CREW VIEWS ARE A HEADER, NOT A LIST. Today, the queue, the
//      calendar, the pot and the report are five destinations, and drawn as
//      five full rows they spent ~160px above the roster — the thing the tab
//      exists for — on navigation you use once a session. They are now one
//      strip of five labelled glyphs, and the roster starts where they used
//      to end.
//   7. EACH ROW CARRIES TODAY. The turns a worker ran today sit on a
//      day-wide rule at the row's right edge, hour-aligned (see `dayTicks`),
//      so "what did each one do today" is a scan down one column rather than
//      thirteen disclosures. The rows lost their trailing "45m ago" to it:
//      a tick's POSITION is when it happened, and the age was the same fact
//      spelled a second way.

import { useCallback, useEffect, useMemo, useState } from "react";

import { useFlowsStore } from "../../flowsStore";
import { useOrchestratorStore } from "../../orchestratorStore";
import { useRunningMap } from "../../runnersStore";
import { useStore } from "../../store";
import { newWorkerDraft, useWorkersStore } from "../../workersStore";
import {
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
  startOfDay,
  workerDeskOrchestrations,
  workerDeskRuns,
  type WorkerActivity,
} from "./workerDeskSelectors";
import {
  DAY_MARKS,
  boardLine,
  boardReasons,
  dayTicks,
  groupBoard,
  type BoardEntry,
  type DayTick,
} from "./workerBoard";
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

  // Everything the board needs, reduced once per worker. Built here because
  // this is the component that owns the stores; every decision made FROM it
  // lives in `workerBoard`, where it can be tested without a renderer.
  //
  // `now` is read once per pass rather than per row, so thirteen strips are
  // all drawn against the same midnight — otherwise a row rendered either
  // side of it would silently use a different day.
  const board = useMemo(() => {
    const now = Date.now();
    const starved = new Set(
      (allocation?.byWorker ?? [])
        .filter((f) => f.blocked === "pool")
        .map((f) => f.workerId),
    );
    const entries: BoardEntry[] = roster.map((worker) => {
      const awaiting = workerDeskOrchestrations(orchestrations, worker.id)
        .awaiting;
      const review = awaiting.reduce(
        (count, o) =>
          count + o.items.filter((item) => item.status === "proposed").length,
        0,
      );
      const claimed = workerDeskRuns(runs, worker.id);
      const pausedRuns = claimed.filter((run) => run.state.kind === "paused");
      const summary = summarizeDesk(
        claimed,
        awaiting,
        runners,
        !!shiftProgress[worker.id],
      );
      const recent = workerActivity(orchestrations, worker.id, ACTIVITY_SCAN);
      const today = recent.filter(
        (item) => startOfDay(item.at) === startOfDay(now),
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
        pausedRuns: pausedRuns.length,
        starved: starved.has(worker.id),
        live: summary.live,
        today,
        newest: recent[0] ?? null,
        target: focusOn
          ? { orchestrationId: focusOn.id, at: focusOn.createdAt }
          : null,
      };
    });
    return { now, groups: groupBoard(entries), entries };
  }, [roster, orchestrations, runs, runners, shiftProgress, allocation]);

  // The quiet workers and the bench each fold to a single row. Local rather
  // than in the Sidebar's persisted set, which holds worker ids: these are two
  // group folds, not a worker's, and they are a peek — closed is the state you
  // want back on the next launch.
  const [quietOpen, setQuietOpen] = useState(false);
  const [benchOpen, setBenchOpen] = useState(false);

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
      {/* Five destinations, one strip. Each keeps its label — the labels cost
          about 14px of height against the ~110px the strip gives back, and an
          unlabelled glyph strip would trade the roster's problem for a
          discovery one.

          At the 200px minimum sidebar width a column is ~35px, which is one
          character short for "Report"; it truncates there and reads cleanly
          from ~215px up, the default being 260px. Widening the tab by
          dropping a destination would cost more than the clipped glyph. */}
      <div
        // Column count follows the tabs actually drawn: Funds is absent until
        // a pool exists, and a fixed five-column grid left the four remaining
        // tabs bunched against a dead column.
        className="mx-1.5 mb-1 mt-1 grid gap-0.5 rounded-md border border-card bg-card p-0.5"
        style={{
          gridTemplateColumns: `repeat(${allocation ? 5 : 4}, minmax(0, 1fr))`,
        }}
      >
        <HeaderTab
          label="Today"
          title="Where the crew is right now, and what it has done today"
          active={view === "today"}
          onClick={showToday}
          // The one live thing in this column: the crew is working, without
          // saying how much — that is the pane's job.
          badge={queueRunning > 0 ? "accent" : null}
          badgeTitle={`${queueRunning} job(s) running`}
        >
          <TodayIcon />
        </HeaderTab>
        <HeaderTab
          label="Queue"
          title="Every job the crew has run — filter it, find it, act on it"
          active={view === "queue"}
          onClick={showQueue}
        >
          <QueueIcon />
        </HeaderTab>
        <HeaderTab
          label="Shifts"
          title="When every worker's shifts fall, this week"
          active={view === "calendar"}
          onClick={showCalendar}
        >
          <CalendarIcon />
        </HeaderTab>
        {allocation && (
          <HeaderTab
            label="Funds"
            title={`$${allocation.spentUSD.toFixed(2)} of $${allocation.poolUSD.toFixed(0)} spent this month`}
            active={view === "funds"}
            onClick={showFunds}
            badge={starvedCount(allocation) > 0 ? "amber" : null}
            badgeTitle={`${starvedCount(allocation)} worker(s) unfunded`}
            // The bar is the sidebar's whole report on the pot; the numbers
            // live on the pane it opens.
            meter={
              allocation.poolUSD > 0
                ? Math.min(100, (allocation.spentUSD / allocation.poolUSD) * 100)
                : 0
            }
          >
            <PotIcon />
          </HeaderTab>
        )}
        <HeaderTab
          label="Report"
          title="Shifts, outcomes, tokens and time across the roster"
          active={view === "report"}
          onClick={showReport}
        >
          <ReportIcon />
        </HeaderTab>
      </div>

      {/* One ruler for every strip below it, drawn once. Without it the ticks
          are a decoration; with it they are a time. */}
      {roster.length > 0 && !query && (
        <div className="flex items-center gap-2 px-2 pb-1 pt-0.5">
          <span className="flex-1 truncate text-[9px] text-ink-faint">
            {dayLabel(board.now)}
          </span>
          <span
            aria-hidden
            className="relative block h-2.5 w-[60px] shrink-0 text-[9px] leading-none text-ink-faint"
          >
            {DAY_MARKS.map((mark) => (
              <span
                key={mark.label}
                className="absolute top-0 -translate-x-1/2"
                style={{ left: `${mark.pos * 100}%` }}
              >
                {mark.label}
              </span>
            ))}
          </span>
        </div>
      )}

      {roster.length === 0 ? (
        <div className="px-2 py-1 text-[10px] text-ink-faint">
          {query ? "No matching workers" : "Nobody works here yet"}
        </div>
      ) : query ? (
        // A search is a request to SEE things. Sorting the results into five
        // attention groups would answer a question you did not ask and scatter
        // three matches across three captions, so a query flattens the board.
        <>
          <SidebarCaption label="Search results" />
          {board.entries.map((entry, index) => (
            <RosterRow
              key={entry.worker.id}
              entry={entry}
              now={board.now}
              query={query}
              selected={
                view === "worker" && entry.worker.id === selectedWorkerId
              }
              onSelect={() => selectWorker(entry.worker.id)}
              canMoveUp={index > 0}
              canMoveDown={index < board.entries.length - 1}
              onMove={(direction) =>
                moveInGroup(
                  board.entries.map((e) => e.worker),
                  entry.worker.id,
                  direction,
                )
              }
              expanded
              onToggleExpanded={() => onToggleExpanded(entry.worker.id)}
            />
          ))}
        </>
      ) : (
        <>
          <BoardGroup
            caption="Needs you"
            // The only caption that is allowed to be loud, and it is the same
            // violet the pills on its rows are wearing.
            tone="text-violet-400"
            entries={board.groups.needsYou}
            board={board}
            selectedWorkerId={view === "worker" ? selectedWorkerId : null}
            expandedSet={expanded}
            onToggleExpanded={onToggleExpanded}
            onMove={moveInGroup}
            onSelect={(entry) => {
              if (entry.target) {
                openWorkerActivity(
                  entry.worker.id,
                  entry.target.orchestrationId,
                  entry.target.at,
                );
              } else if (entry.starved) {
                // Nothing to review and nothing paused — the row is here
                // because the pay queue ran dry, and the fix (re-order,
                // re-fund) lives on the Funds pane, not the desk.
                showFunds();
              } else {
                selectWorker(entry.worker.id);
              }
            }}
          />
          <BoardGroup
            caption="Running now"
            tone="text-emerald-400"
            entries={board.groups.running}
            board={board}
            selectedWorkerId={view === "worker" ? selectedWorkerId : null}
            expandedSet={expanded}
            onToggleExpanded={onToggleExpanded}
            onMove={moveInGroup}
            onSelect={(entry) => selectWorker(entry.worker.id)}
          />
          <BoardGroup
            caption="Worked today"
            entries={board.groups.today}
            board={board}
            selectedWorkerId={view === "worker" ? selectedWorkerId : null}
            expandedSet={expanded}
            onToggleExpanded={onToggleExpanded}
            onMove={moveInGroup}
            onSelect={(entry) => selectWorker(entry.worker.id)}
          />

          {/* Four quiet workers are one fact, not four rows. The faces are on
              the fold so it still says WHO is quiet, and opening it gives the
              ordinary rows back. */}
          <FoldedGroup
            open={quietOpen}
            onToggle={() => setQuietOpen((o) => !o)}
            entries={board.groups.quiet}
            label={(n) => `${n} quiet`}
            detail="nothing today"
          >
            {board.groups.quiet.map((entry, index) => (
              <RosterRow
                key={entry.worker.id}
                entry={entry}
                now={board.now}
                query=""
                selected={
                  view === "worker" && entry.worker.id === selectedWorkerId
                }
                onSelect={() => selectWorker(entry.worker.id)}
                canMoveUp={index > 0}
                canMoveDown={index < board.groups.quiet.length - 1}
                onMove={(direction) =>
                  moveInGroup(
                    board.groups.quiet.map((e) => e.worker),
                    entry.worker.id,
                    direction,
                  )
                }
                expanded={expanded.has(entry.worker.id)}
                onToggleExpanded={() => onToggleExpanded(entry.worker.id)}
              />
            ))}
          </FoldedGroup>

          {/* The bench. Paused workers are still yours — you rename them,
              re-enable them, read what they filed — but they do nothing today,
              so they fold the same way and their rows stay one line. */}
          <FoldedGroup
            open={benchOpen}
            onToggle={() => setBenchOpen((o) => !o)}
            entries={board.groups.bench}
            label={(n) => (n === 1 ? "1 on the bench" : `${n} on the bench`)}
          >
            {board.groups.bench.map((entry, index) => (
              <RosterRow
                key={entry.worker.id}
                entry={entry}
                now={board.now}
                query=""
                selected={
                  view === "worker" && entry.worker.id === selectedWorkerId
                }
                onSelect={() => selectWorker(entry.worker.id)}
                canMoveUp={index > 0}
                canMoveDown={index < board.groups.bench.length - 1}
                onMove={(direction) =>
                  moveInGroup(
                    board.groups.bench.map((e) => e.worker),
                    entry.worker.id,
                    direction,
                  )
                }
                expanded={false}
                onToggleExpanded={() => onToggleExpanded(entry.worker.id)}
                compact
              />
            ))}
          </FoldedGroup>

          {/* What the ticks mean, once, at the bottom — where a legend belongs
              when the thing it explains is already legible as "something
              happened here" without it. */}
          {board.groups.today.length + board.groups.running.length > 0 && (
            <TickLegend />
          )}
        </>
      )}

      {/* Hiring belongs on the roster, not only in the pane header — this is
          the list you look at when you notice nobody covers something. It sits
          at the BOTTOM now: the top of this column is spoken for by the
          workers that need you, and "add another" is the least urgent thing
          the tab can offer. */}
      {hirePath !== "" && (
        <div className="relative mt-2 px-2">
          <button
            onClick={() => setHireMenuOpen((open) => !open)}
            title="Add a worker"
            aria-haspopup="menu"
            aria-expanded={hireMenuOpen}
            className="rounded px-1 py-0.5 text-[10px] leading-none text-ink-faint hover:bg-card-strong hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
          >
            + Hire a worker
          </button>
          {hireMenuOpen && (
            <div
              role="menu"
              className="absolute bottom-full left-2 z-40 mb-1 w-36 overflow-hidden rounded-md border border-card-strong bg-surface-elevated py-1 shadow-xl"
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
    </>
  );
}

/// One destination in the header strip.
///
/// Icon over an 8px label, because the label is what makes a five-glyph strip
/// navigable to someone who has not memorised the glyphs — and it costs about
/// ten pixels against the hundred-odd the strip reclaims from five full rows.
/// The badge is the strip's only live channel: a dot in the corner, the same
/// accent for "the crew is working" and the same amber for "the pot ran dry"
/// that the rows below use.
function HeaderTab({
  label,
  title,
  active,
  onClick,
  badge = null,
  badgeTitle,
  meter,
  children,
}: {
  label: string;
  title: string;
  active: boolean;
  onClick: () => void;
  badge?: "accent" | "amber" | null;
  badgeTitle?: string;
  /// Percent full, for the one tab that has an amount in it.
  meter?: number;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-current={active ? "page" : undefined}
      className={
        // No horizontal padding: at the 200px minimum width a column is only
        // ~35px, and the label needs all of it. The gap between tabs is what
        // separates them, so the padding was buying nothing.
        "relative flex flex-col items-center gap-1 rounded py-1 " +
        "focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 " +
        (active
          ? "sidebar-row-selected text-ink"
          : "text-ink-muted hover:bg-card-strong hover:text-ink")
      }
    >
      {children}
      {/* 10px, which is this app's floor for text a person actually reads —
          every caption and second line in the sidebar is 10px. The first cut
          of this strip used 8px to save two pixels of height and made the
          most-read labels in the tab the smallest type in the product. */}
      <span className="max-w-full truncate text-[10px] leading-none tracking-tight">
        {label}
      </span>
      {meter !== undefined && (
        <span
          aria-hidden
          className="block h-0.5 w-6 shrink-0 overflow-hidden rounded-full bg-card-strong"
        >
          <span
            className="block h-full bg-accent"
            style={{ width: `${meter}%` }}
          />
        </span>
      )}
      {badge && (
        <span
          aria-hidden
          title={badgeTitle}
          className={
            "absolute right-1 top-1 h-1.5 w-1.5 rounded-full " +
            (badge === "accent" ? "animate-pulse bg-accent" : "bg-amber-500")
          }
        />
      )}
    </button>
  );
}

function SidebarCaption({
  label,
  tone = "text-ink-faint",
  count,
}: {
  label: string;
  tone?: string;
  count?: number;
}) {
  return (
    <div
      className={
        "mt-2 px-2 text-[10px] uppercase tracking-wider " + tone
      }
    >
      {label}
      {count !== undefined && ` · ${count}`}
    </div>
  );
}

/// One attention group: a caption and its rows, or nothing at all.
///
/// An empty group renders as no group — a caption over zero rows is structure
/// describing itself, and "Needs you · 0" is a worse way of saying that
/// nobody does than saying nothing.
function BoardGroup({
  caption,
  tone,
  entries,
  board,
  selectedWorkerId,
  expandedSet,
  onToggleExpanded,
  onMove,
  onSelect,
}: {
  caption: string;
  tone?: string;
  entries: BoardEntry[];
  board: { now: number };
  selectedWorkerId: string | null;
  expandedSet: Set<string>;
  onToggleExpanded: (id: string) => void;
  onMove: (group: Worker[], id: string, direction: -1 | 1) => void;
  onSelect: (entry: BoardEntry) => void;
}) {
  if (entries.length === 0) return null;
  const group = entries.map((entry) => entry.worker);
  return (
    <>
      <SidebarCaption label={caption} tone={tone} count={entries.length} />
      {entries.map((entry, index) => (
        <RosterRow
          key={entry.worker.id}
          entry={entry}
          now={board.now}
          query=""
          selected={entry.worker.id === selectedWorkerId}
          onSelect={() => onSelect(entry)}
          canMoveUp={index > 0}
          canMoveDown={index < entries.length - 1}
          onMove={(direction) => onMove(group, entry.worker.id, direction)}
          expanded={expandedSet.has(entry.worker.id)}
          onToggleExpanded={() => onToggleExpanded(entry.worker.id)}
        />
      ))}
    </>
  );
}

/// A group that costs one row until you want it.
///
/// The quiet workers and the bench are both answers to "and the rest?", and
/// the honest size of that answer is one line. The faces ride on the fold so
/// it still says WHO — a count alone would make you open it to find out
/// whether the worker you are looking for is in there.
function FoldedGroup({
  open,
  onToggle,
  entries,
  label,
  detail,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  entries: BoardEntry[];
  label: (count: number) => string;
  detail?: string;
  children: React.ReactNode;
}) {
  if (entries.length === 0) return null;
  const text = label(entries.length);
  return (
    <>
      <button
        onClick={onToggle}
        aria-expanded={open}
        title={`${text} — ${entries.map((e) => e.worker.name).join(", ")}`}
        className={
          "sidebar-row mt-2 flex w-full items-center gap-2 rounded px-2 py-1 text-left " +
          "text-ink-muted hover:bg-card-strong hover:text-ink hover:border-card " +
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
        }
      >
        <span
          aria-hidden
          className={
            "shrink-0 text-[8px] leading-none text-ink-faint transition-transform " +
            (open ? "rotate-90" : "")
          }
        >
          ▸
        </span>
        {/* Overlapped, so four faces cost the width of about two and a half.
            Hidden while the group is open — the rows below are showing the
            same faces at that point, and a stack repeating them is noise. */}
        {!open && (
          <span aria-hidden className="flex shrink-0 items-center">
            {entries.slice(0, FOLD_FACES).map((entry, i) => (
              <span
                key={entry.worker.id}
                className={i === 0 ? "" : "-ml-1.5"}
                style={{ zIndex: FOLD_FACES - i }}
              >
                <WorkerAvatar worker={entry.worker} live={false} />
              </span>
            ))}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] leading-tight">
            {text}
          </span>
          {detail && !open && (
            <span className="block truncate text-[10px] leading-4 text-ink-faint">
              {detail}
            </span>
          )}
        </span>
      </button>
      {open && children}
    </>
  );
}

/// How many faces ride on a fold before the stack stops being readable.
const FOLD_FACES = 4;

/// A worker's day, hour-aligned, at the row's right edge.
///
/// The rule is the whole local day and the ticks are absolutely placed on it,
/// so every strip in the column shares one timeline: two workers that ran at
/// the same hour have their marks in the same place, and the shape of the
/// crew's day is readable straight down the column. A worker that did nothing
/// draws an empty rule rather than nothing at all — the emptiness IS the
/// answer, and a missing strip would just look like a layout bug.
function DayStrip({ ticks, name }: { ticks: DayTick[]; name: string }) {
  return (
    <span
      title={
        ticks.length === 0
          ? `${name} — nothing today`
          : `${name} — ${ticks.length} today`
      }
      className="relative block h-3 w-[60px] shrink-0 overflow-hidden rounded-[2px] border border-card bg-card-strong"
    >
      {ticks.map((tick) => (
        <span
          key={tick.id}
          aria-hidden
          className={
            "absolute w-[3px] rounded-[1px] " +
            TICK_TINT[tick.kind] +
            " " +
            TICK_INSET[tick.kind]
          }
          style={{
            // Inset so a tick at midnight or at 23:59 is still fully drawn
            // inside the rule rather than half-clipped by its own edge.
            left: `calc(${(tick.pos * 100).toFixed(2)}% - ${(tick.pos * 3).toFixed(2)}px)`,
          }}
        />
      ))}
    </span>
  );
}

/// A tick's colour is what it wants from you, not who ran it — the avatar two
/// columns left already said who.
const TICK_TINT: Record<DayTick["kind"], string> = {
  running: "bg-emerald-400",
  review: "bg-violet-500",
  errand: "bg-accent",
  // Not ink-faint. A shift is the least URGENT mark but by far the most
  // common one, and at 3px on a tinted rule the faint grey read as smudge —
  // which made "did this worker do anything today" the one question the
  // strip answered worst.
  shift: "bg-ink-muted",
};

/// Height is a second, coarser ladder than colour, so the strip survives being
/// read by someone who cannot tell violet from green: what is still live or
/// still owed to you stands full height, and what is merely a record of
/// something that happened is inset. Two steps, not four — the first cut gave
/// each kind its own height and the shortest one was also the commonest, so
/// the ordinary case was the hardest to see. Kept apart from the tint because
/// the legend wants one and not the other.
const TICK_INSET: Record<DayTick["kind"], string> = {
  running: "inset-y-0",
  review: "inset-y-0",
  errand: "inset-y-px",
  shift: "inset-y-px",
};

function TickLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 px-2 pt-3 text-[9px] text-ink-faint">
      {(
        [
          ["shift", "shift"],
          ["errand", "errand"],
          ["review", "to review"],
          ["running", "running"],
        ] as Array<[DayTick["kind"], string]>
      ).map(([kind, label]) => (
        <span key={kind} className="flex items-center gap-1">
          <span
            aria-hidden
            className={"block h-2 w-[3px] rounded-[1px] " + TICK_TINT[kind]}
          />
          {label}
        </span>
      ))}
    </div>
  );
}

/// The date the strips above are showing, in the shortest form that is still
/// unambiguous. It exists because a column of ticks with no date on it is a
/// chart with no axis label.
function dayLabel(now: number): string {
  return new Date(now).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
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

/// Bars on a baseline — outcomes measured, which is what the report is.
///
/// It used to borrow the calendar leaf. That was survivable while the two
/// rows were a screen apart with their labels on; side by side in the header
/// strip, two identical glyphs is just a bug you can see.
function ReportIcon() {
  return (
    <svg
      viewBox="0 0 14 14"
      aria-hidden
      className="h-3.5 w-3.5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
    >
      <path d="M1.8 12.2h10.4" />
      <path d="M3.6 12.2V6.4M7 12.2V2.6M10.4 12.2V8.6" />
    </svg>
  );
}

function RosterRow({
  entry,
  now,
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
  /// Everything the board already reduced for this worker — the row does not
  /// re-derive counts the parent computed for the grouping.
  entry: BoardEntry;
  /// The board's single "now", so every strip in the column is drawn against
  /// the same midnight.
  now: number;
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
  const { worker } = entry;
  const orchestrations = useOrchestratorStore((s) => s.orchestrations);
  const shift = useWorkersStore((s) => s.shiftProgress[worker.id]);
  const openWorkerActivity = useWorkersStore((s) => s.openWorkerActivity);

  const recent = useMemo(
    () =>
      sidebarActivity(
        workerActivity(orchestrations, worker.id, ACTIVITY_SCAN),
        now,
        ACTIVITY_SCAN,
      ),
    [orchestrations, worker.id, now],
  );
  // The strip reads off the board's own day slice, not off `recent` — which
  // falls back to yesterday's last turn when today is empty, and a yesterday
  // turn drawn on a today rule would be a lie in the one place this column
  // promises a time.
  const ticks = useMemo(() => dayTicks(entry.today, now), [entry.today, now]);
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
  const openTurn = (orchestrationId: string, at: number) =>
    openWorkerActivity(worker.id, orchestrationId, at);

  // Only what is true RIGHT NOW. Totals are history and live in Stats; putting
  // "11 done" here made an idle worker look busy.
  const tagline = workerTagline(worker);
  const status = !worker.enabled
    ? null // The bench caption already said it; repeating it under every name
    : shift
      ? shift.task === "errand"
        ? "on your errand"
        : "working a shift"
      : entry.live
        ? "running"
        : null;
  const line = boardLine(entry, status, tagline);
  const reasons = boardReasons(entry);

  return (
    <div className={"group/row " + (compact ? "mt-0.5" : "mt-1")}>
      {/* The button and its move controls share a positioning context of
          their own. They used to share the ROW's, which also contains the
          expanded turn rail — so centring the arrows on it dropped them
          into the middle of a worker's child rows rather than onto the
          worker. */}
      <div className="relative">
        <button
          onClick={onSelect}
          className={
            "sidebar-row flex w-full items-center gap-2 rounded px-2 text-left " +
            (compact ? "py-0.5 " : "py-1 ") +
            "hover:bg-card-strong hover:text-ink hover:border-card " +
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 " +
            (selected ? "sidebar-row-selected text-ink" : "text-ink-muted")
          }
          title={`${worker.name}${tagline ? ` — ${tagline}` : ""} · ${TRUST_LABEL[worker.trust].text}${
            reasons ? ` · ${reasons}` : ""
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
          <WorkerAvatar worker={worker} live={entry.live} />
          <span className="min-w-0 flex-1">
            {/* The name carries weight the child rows don't — in a folded roster
                the names ARE the list, and in an open one the eye needs to find
                where one worker ends and the next begins without counting
                indents. */}
            <span className="block truncate text-[13px] font-medium leading-tight">
              {worker.name}
            </span>
            {/* One second line, chosen by `boardLine`: what is perishable
                first, then the last turn's outcome, then the tagline as a
                floor. */}
            {!compact && line && (
              <span className="block truncate text-[10px] font-normal leading-4 text-ink-faint">
                {line}
              </span>
            )}
          </span>
          {/* The move controls sit absolutely at the row's right edge and only
              appear on hover, OVER the strip rather than beside it.

              The strip used to slide 34px left to make room. That is fine for
              a badge and wrong for a TIMELINE: a tick's position is a time, so
              shifting one row's strip put its 9am half an inch from every
              other row's 9am — breaking the one property the column exists
              for, at exactly the moment you were looking at that row. It fades
              instead; you cannot read a day and re-order the crew in the same
              gesture, so showing one at a time costs nothing. */}
          <span className="flex shrink-0 items-center gap-1.5">
            {entry.review > 0 && (
              <span
                className="shrink-0 rounded-full bg-violet-500 px-1.5 text-[10px] font-medium leading-4 text-white"
                title={`${entry.review} waiting for your review`}
              >
                {entry.review}
              </span>
            )}
            {/* The same amber the Funds tab wears, for the same reason: this
                worker is stopped and only a person can start it again. */}
            {(entry.pausedRuns > 0 || entry.starved) && (
              <span
                aria-hidden
                title={entry.starved ? "unfunded" : "a flow is paused"}
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
              />
            )}
            {/* A bench row has no day to draw — that is what being benched
                means — and a query flattens the board, where a per-row day
                would be answering a question nobody asked. */}
            {!compact && !query && (
              <span className="shrink-0 transition-opacity duration-150 group-hover/row:opacity-0">
                <DayStrip ticks={ticks} name={worker.name} />
              </span>
            )}
          </span>
        </button>

        {/* Arranging the roster is a rare act, so it hides until you are on the
            row — the same treatment the project rows give their own controls.
            Absolutely positioned, and centred on the BUTTON rather than the
            whole row, so revealing it neither reflows the name nor lands the
            arrows among a worker's child turns. */}
        <div className="absolute right-1 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 group-hover/row:flex">
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
