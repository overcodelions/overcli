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
//      a speech bubble, a shift names itself ("Shift 12") behind a clock —
//      and above them, the runs that are BLOCKED. Those used to be left to
//      the desk on the grounds that "Needs you" already lists them, but the
//      group lists the WORKER: an amber dot saying "2 flows paused" costs a
//      click into the desk and a scan down the chat before you learn which
//      ticket stopped and where. A blocked run names itself and its step, and
//      opens the run rather than the desk. An opened worker adds what is
//      running and what landed in the last hour — a job that finished while
//      you were elsewhere should not need a click to find — and the rest of a
//      run's life is still the desk's business.
//   5. IDLE WORKERS SAY NOTHING. "no work yet" on four of six rows is not
//      status, it is noise. An absent line is the correct rendering of nothing
//      happening — and the workers that did nothing at all fold into a single
//      row with their faces stacked on it, because four quiet workers are one
//      fact, not four. The project a worker was hired into follows the same
//      rule from the other side: it is drawn only when the crew spans more
//      than one, since the same word under every name annotates nothing. When
//      it IS drawn it LEADS the second line, a tone brighter than the status
//      behind it — it is scanned, not read, so it holds one position and
//      survives truncation. It is not tinted: colour here means STATE (violet
//      waiting, amber stopped, emerald running), and an identity wearing a
//      state's hue is a misread, not a decoration. The search box matches it
//      too, which is how you narrow nineteen workers to one crew without a
//      filter to forget you left on.
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
import { useTickingNow } from "../../hooks";
import { useStore } from "../../store";
import { newWorkerDraft, useWorkersStore } from "../../workersStore";
import {
  moveWithinGroup,
  sortRoster,
  workerTagline,
  type Worker,
} from "@shared/flows/worker";
import type { TreasuryAllocation } from "@shared/flows/treasury";
import { useWorkerBoard, ACTIVITY_SCAN } from "./useWorkerBoard";
import { WorkerAvatar } from "./WorkerAvatar";
import { TRUST_LABEL } from "./WorkerRowParts";
import {
  describeActivity,
  relativeTime,
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
  dayProgress,
  boardReasons,
  dayTicks,
  type BoardEntry,
  type DayTick,
} from "./workerBoard";
import { buildWorkQueue } from "./workQueue";
import { searchWork } from "./workSearch";
import {
  pauseReasonLabel,
  railRuns,
  railStepPosition,
} from "./deskRunRail";
import { FlowMonogram } from "../flows/FlowMonogram";
import { flowRunActivityAt, flowRunTitle, type FlowRun } from "@shared/flows/schema";

/// How many turns hang under an open worker, errands and shifts together. Five:
/// a busy morning is visible without one worker pushing the rest of the roster
/// off screen; the desk has the whole day.
const NESTED_TURNS = 5;
/// Backstop for the shift-thinning rule — see sidebarShifts, which keeps the
/// newest plus whatever still owes you a decision. Only a worker holding an
/// implausible pile of unreviewed shifts hits this.
const NESTED_SHIFTS = 4;

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
  const showFunds = useWorkersStore((s) => s.showFunds);
  const runs = useFlowsStore((s) => s.runs);
  // Same reason as the pane: a run answering a post-completion turn is live
  // work, and only the participant's runner knows it.
  const runners = useRunningMap();
  const runsLoaded = useFlowsStore((s) => s.runsLoaded);
  const orchestrations = useOrchestratorStore((s) => s.orchestrations);
  const projects = useStore((s) => s.projects);

  // The worker you are reading is never folded: selecting one records it as
  // open, and the record persists, so the roster reopens the way you left it.
  // Folding it back by hand still works — this only ADDS, and is idempotent
  // because it fires on every render the selection is visible.
  useEffect(() => {
    if (view === "worker" && selectedWorkerId) onExpand(selectedWorkerId);
  }, [view, selectedWorkerId, onExpand]);

  // Everything this column draws, reduced once. It used to be a `useMemo`
  // right here, which was right while the sidebar was the only surface that
  // drew a roster; the crew grid on the Today page draws the same workers
  // from the same stores, so the reduction moved to a hook they share.
  // `roster` is the query already applied — search matches a worker's own
  // runs and its project name too, not just what it is called.
  // The day strips and "today" need a clock that moves on its own — the
  // stores can sit still across midnight.
  const now = useTickingNow(30_000);
  const board = useWorkerBoard(query, now);
  const { roster } = board;

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
      buildWorkQueue(orchestrations, runs, workers, shiftProgress, now, runsLoaded, runners)
        .running.length,
    [orchestrations, runs, workers, shiftProgress, now, runsLoaded, runners],
  );
  return (
    <>
      {/* Two destinations, one strip — the day-to-day views. Shifts, Funds
          and Report are occasional, and live at the foot of the sidebar
          instead (WorkersSidebarFooter), in the slot the project actions leave
          free on this tab, beside the one create action: hiring.

          Previously: five destinations, one strip. Each keeps its label — the labels cost
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
        style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}
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

      {query ? (
        // A search is a request to SEE things. Sorting the results into five
        // attention groups would answer a question you did not ask and scatter
        // three matches across three captions, so a query flattens the board —
        // and it searches the WORK as well as the workers, since "where is the
        // thing it found" is the question people actually bring to this box.
        <>
          {roster.length > 0 && <SidebarCaption label="Workers" />}
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
          <WorkResults query={query} />
        </>
      ) : roster.length === 0 ? (
        <div className="px-2 py-1 text-[10px] text-ink-faint">Nobody works here yet</div>
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
          {/* Only the open worker draws a day strip now, so the legend is
              only worth its line while one is open. */}
          {view === "worker" && selectedWorkerId && board.groups.today.length + board.groups.running.length > 0 && (
            <TickLegend />
          )}
        </>
      )}

    </>
  );
}

/// The work a search matched, newest first — each row the job's result (the
/// worker's headline when it gave one), who did it and when. Opens the run.
function WorkResults({ query }: { query: string }) {
  const orchestrations = useOrchestratorStore((s) => s.orchestrations);
  const runs = useFlowsStore((s) => s.runs);
  const selectWorker = useWorkersStore((s) => s.selectWorker);
  const openWorkerActivity = useWorkersStore((s) => s.openWorkerActivity);
  const setActiveRun = useFlowsStore((s) => s.setActiveRun);
  const matches = useMemo(() => searchWork(orchestrations, runs, query), [orchestrations, runs, query]);
  const today = new Date().toDateString();
  const when = (at: number) =>
    new Date(at).toDateString() === today
      ? new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      : new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return (
    <>
      <SidebarCaption label="Work" count={matches.length} />
      {matches.length === 0 ? (
        <div className="px-2 py-1 text-[10px] text-ink-faint">No work matches “{query}”.</div>
      ) : (
        matches.map((m) => (
          <button
            key={m.key}
            onClick={() => {
              selectWorker(m.workerId);
              if (m.runId && runs[m.runId]) setActiveRun(m.runId);
              else openWorkerActivity(m.workerId, m.orchestrationId, m.at);
            }}
            className="mt-0.5 flex w-full flex-col gap-0.5 rounded px-2 py-1.5 text-left hover:bg-card-strong focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
          >
            <span className="line-clamp-2 text-[12px] leading-snug text-ink">{m.headline ?? m.title}</span>
            <span className="truncate text-[10.5px] text-ink-faint">
              {m.workerName} · {when(m.at)}
              {m.status === 'failed' ? ' · failed' : m.status === 'cancelled' ? ' · not run' : ''}
            </span>
          </button>
        ))
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
/// The foot of the sidebar on the Workers tab. Open folder / New / New
/// workspace are about projects and mean nothing here; the two occasional
/// whole-crew views take their place, which leaves the tab strip at the top
/// to the three you use every day.
export function WorkersSidebarFooter() {
  const view = useWorkersStore((s) => s.view);
  const showCalendar = useWorkersStore((s) => s.showCalendar);
  const showFunds = useWorkersStore((s) => s.showFunds);
  const openHire = useWorkersStore((s) => s.openHire);
  const openEditor = useWorkersStore((s) => s.openEditor);
  const importFromFile = useWorkersStore((s) => s.importFromFile);
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const hirePath = workspaces[0]?.rootPath ?? projects[0]?.path ?? "";
  const [hireMenuOpen, setHireMenuOpen] = useState(false);
  const hireEveryday = projects.find((project) => project.path === hirePath)?.everyday;
  const showReport = useWorkersStore((s) => s.showReport);
  const allocation = useWorkersStore((s) => s.allocation);
  const starved = allocation ? starvedCount(allocation) : 0;
  const row = (active: boolean) =>
    "flex items-center gap-2 text-xs py-1 px-2 rounded text-left " +
    (active ? "sidebar-row-selected text-ink" : "text-ink-muted hover:text-ink hover:bg-card-strong");
  return (
    <>
      {/* The tab's one create action, where every other tab keeps its own
          (Open folder, New): at the foot of the sidebar. */}
      {hirePath !== "" && (
        <div className="relative">
          <button
            onClick={() => setHireMenuOpen((open) => !open)}
            title="Add a worker"
            aria-haspopup="menu"
            aria-expanded={hireMenuOpen}
            className="w-full rounded py-1 px-2 text-left text-xs text-ink-muted hover:bg-card-strong hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
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
      <button
        onClick={showCalendar}
        aria-current={view === "calendar" ? "page" : undefined}
        title="When every worker's shifts fall, this week"
        className={row(view === "calendar")}
      >
        <CalendarIcon />
        <span>Shifts</span>
      </button>
      {/* Funds only once a pool exists — same rule the tab strip had. */}
      {allocation && (
        <button
          onClick={showFunds}
          aria-current={view === "funds" ? "page" : undefined}
          title={`$${allocation.spentUSD.toFixed(2)} of $${allocation.poolUSD.toFixed(0)} spent this month`}
          className={row(view === "funds")}
        >
          <PotIcon />
          <span>Funds</span>
          {starved > 0 && (
            <span
              className="h-1.5 w-1.5 rounded-full bg-amber-400"
              title={`${starved} worker(s) unfunded`}
            />
          )}
          <span className="ml-auto flex items-center gap-1.5 text-[10px] text-ink-faint tabular-nums">
            ${allocation.spentUSD.toFixed(0)} / ${allocation.poolUSD.toFixed(0)}
            <span aria-hidden className="relative block h-1 w-10 overflow-hidden rounded-full bg-card-strong">
              <span
                className="absolute inset-y-0 left-0 rounded-full bg-accent/70"
                style={{
                  width: `${allocation.poolUSD > 0 ? Math.min(100, (allocation.spentUSD / allocation.poolUSD) * 100) : 0}%`,
                }}
              />
            </span>
          </span>
        </button>
      )}
      <button
        onClick={showReport}
        aria-current={view === "report" ? "page" : undefined}
        title="Shifts, outcomes, tokens and time across the roster"
        className={row(view === "report")}
      >
        <ReportIcon />
        <span>Report</span>
      </button>
    </>
  );
}

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
function DayStrip({ ticks, name, now }: { ticks: DayTick[]; name: string; now: number }) {
  const progress = dayProgress(now);
  return (
    <span
      title={
        ticks.length === 0
          ? `${name} — nothing today`
          : `${name} — ${ticks.length} today`
      }
      className="relative block h-3 w-[60px] shrink-0 overflow-hidden rounded-[2px] border border-card bg-card-strong"
    >
      {/* The rest of the day, drawn as a thing that has not happened rather
          than as room the worker failed to fill. Under the ticks, never over
          them: a tick at 23:00 on a worker that is mid-turn is still a tick. */}
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
          ["shift", "shift \u00b7 it decided"],
          ["errand", "errand \u00b7 you asked"],
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
  const shift = useWorkersStore((s) => s.shiftProgress[worker.id]);
  const openWorkerActivity = useWorkersStore((s) => s.openWorkerActivity);
  // The roster is WHO, and a name with its state beside it says who. Every row
  // but the open worker draws as one line: its runs and turns are the Today
  // page's to show (a paused run is a card there, with its buttons), and
  // drawing them here as well put every fact on screen twice. The worker you
  // have open keeps its full detail — that is where its history is read.
  const oneLine = !selected && !compact;

  const recent = useMemo(
    () =>
      sidebarActivity(
        entry.recent,
        now,
        ACTIVITY_SCAN,
      ),
    [entry.recent, now],
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
  // Blocked runs whether or not the worker is open; what is running only once
  // it is. A bench row has neither — that is what being benched means.
  const rail = useMemo(
    () => (compact ? [] : railRuns(entry.runs, expanded, now)),
    [entry.runs, expanded, compact, now],
  );
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
          title={`${worker.name}${tagline ? ` — ${tagline}` : ""} · ${
            TRUST_LABEL[worker.trust].text
          }${entry.home ? ` · ${entry.home}` : ""}${reasons ? ` · ${reasons}` : ""}`}
        >
          {compact || oneLine ? (
            // Spacer, so a face lines up with the faces above it.
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
            {/* One second line: the project first, then `boardLine` — what is
                perishable, then the last turn's outcome, then the tagline as a
                floor.

                The project leads because it is the one thing on the row you
                SCAN for rather than read: finding every acme worker among
                nineteen means the label holds the same place on every row and
                survives truncation, which the status text does not need to.

                It separates by TONE, not by colour or a dot. Colour on this
                board is spoken for — violet is waiting on you, amber is
                stopped, emerald is running — so tinting an identity in those
                same hues would have a project called Ledger reading as a
                worker that is paused. One step of brightness does the same job
                and spends nothing. The label also carries its own width cap:
                sharing one `truncate` with the status let a long project name
                eat the thing the row is actually reporting. */}
            {!compact && !oneLine && (entry.home || line) && (
              <span className="flex items-baseline gap-1 text-[10px] font-normal leading-4">
                {entry.home && (
                  <span className="max-w-[45%] shrink-0 truncate text-ink-muted">
                    {entry.home}
                  </span>
                )}
                {line && <span className="min-w-0 truncate text-ink-faint">{line}</span>}
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
            {/* One line's worth of state, where the second line used to be. */}
            {oneLine && line && (
              <span className="max-w-[96px] truncate text-[10.5px] text-ink-faint">{line}</span>
            )}
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
            {!compact && !oneLine && !query && (
              <span className="shrink-0 transition-opacity duration-150 group-hover/row:opacity-0">
                <DayStrip ticks={ticks} name={worker.name} now={now} />
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
          than floating between two of them. Runs first and turns under them:
          a stopped run is the only thing here that is waiting on YOU, and a
          list you read top-down should put the decision above the history. */}
      {!compact && !oneLine && (rail.length > 0 || (expanded && (sending?.length || turns.length > 0))) && (
        <div className="ml-[13px] border-l border-card pl-2">
          {/* Drawn folded as well as open. The disclosure hides what a worker
              HAS DONE — and a run holding a Continue button is not history,
              it is the reason this row is in "Needs you" at all. */}
          {rail.map((run) => (
            <RunRow key={run.id} run={run} />
          ))}
          {/* The errand you just sent, before any batch exists to represent it
              — the planning turn can take minutes, and a sidebar that shows
              nothing until it finishes reads as a message that went nowhere. */}
          {expanded && sending?.map((pending) => (
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
          {expanded && turns.map((item) => (
            <TurnRow
              key={item.orchestration.id}
              item={item}
              onOpen={openTurn}
            />
          ))}
          {/* The count says what was thinned away, because a rail that quietly
              drops four errands reads as a worker that only ran one. Clicking
              it opens the desk, which shows the whole day. */}
          {expanded && overflow > 0 && (
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

/// One run under a worker: what it is, where it stopped, and a click that
/// lands ON the run rather than on the desk that contains it.
///
/// The step is the payload. "paused" on a nine-step flow says only that
/// something is wrong; "ship 9/9" says the work is done and one approval
/// stands between you and the push — a different decision, made from the
/// roster instead of after two clicks and a scroll.
function RunRow({ run }: { run: FlowRun }) {
  const activeRunId = useFlowsStore((s) => s.activeRunId);
  const setActiveRun = useFlowsStore((s) => s.setActiveRun);
  const selectWorker = useWorkersStore((s) => s.selectWorker);
  const setDetailMode = useStore((s) => s.setDetailMode);
  const detailMode = useStore((s) => s.detailMode);
  const paused = run.state.kind === "paused";
  const at = railStepPosition(run);
  const reason = pauseReasonLabel(run);
  // A finished run has no step to name, so it says WHEN instead — the one
  // thing you want from a row that is only here because it landed recently.
  const finishedAt = at ? null : flowRunActivityAt(run);
  const failed = run.state.kind === "aborted" || (run.state.kind === "done" && !run.state.success);
  // Selected only while you are actually looking at the pane this row opens
  // — a highlight that survives a trip to Chat is claiming a selection the
  // screen isn't showing.
  const selected = activeRunId === run.id && detailMode === "workers";
  const open = () => {
    // Order matters, and for the same reason it does in FlowRunSidebarRow:
    // selecting a worker clears the active run, so pointing at the run has
    // to come second.
    if (run.workerId) {
      selectWorker(run.workerId);
      setDetailMode("workers");
    }
    setActiveRun(run.id);
  };
  return (
    <button
      onClick={open}
      className={
        "group mt-0.5 flex w-full items-center gap-2 rounded px-2 py-1 text-left " +
        "text-xs focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 " +
        (selected
          ? "sidebar-row sidebar-row-selected text-ink"
          : "hover:bg-card-strong")
      }
      title={`${flowRunTitle(run)} — ${run.flowSnapshot.name}${
        at
          ? ` · ${paused ? "waiting at" : "running"} ${at.step} (step ${at.position} of ${at.total})`
          : ` · ${failed ? "stopped" : "finished"} ${relativeTime(finishedAt ?? run.createdAt)}`
      }${reason ? ` · ${reason}` : ""} — opens the run`}
    >
      <FlowMonogram
        name={run.flowSnapshot.name}
        size="sm"
        live={run.state.kind === "running"}
      />
      <span className="min-w-0 flex-1 truncate text-ink-muted group-hover:text-ink">
        {flowRunTitle(run)}
      </span>
      {/* Amber for stopped, the same amber the worker row's dot and the Funds
          tab wear: this needs a person. A running step is just information,
          so it stays quiet. */}
      {at ? (
        <span
          className={
            "shrink-0 truncate text-[10px] tabular-nums " +
            (paused ? "text-amber-500 dark:text-amber-300" : "text-ink-faint")
          }
          title={`${paused ? "Waiting at" : "Current step"} ${at.step} · step ${at.position} of ${at.total}`}
        >
          {at.step} {at.position}/{at.total}
        </span>
      ) : (
        <span
          className="shrink-0 text-[10px] tabular-nums text-ink-faint"
          title={`${failed ? "Stopped" : "Finished"} ${relativeTime(finishedAt ?? run.createdAt)}`}
        >
          {failed ? "✗" : "✓"} {relativeTime(finishedAt ?? run.createdAt)}
        </span>
      )}
    </button>
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
