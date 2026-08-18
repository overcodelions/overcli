// The Workers tab's navigator — a shift board.
//
// Its job is not to describe workers, it is to allocate attention: who needs
// you, who is working, and what each one did last. Three decisions follow from
// that, and each removes something the previous version showed:
//
//   1. TRUST IS A SHAPE, NOT A WORD. Every row used to carry "probation" /
//      "trusted" / "autonomous" in its own tint, so six workers put six
//      coloured words next to the six names they were supposed to annotate.
//      It now rides on the avatar's ring — dashed, solid, doubled — leaving
//      colour free to say WHO. The tooltip and Settings still say it in words.
//   2. THE REVIEW COUNT IS THE ONLY LOUD THING. It used to be a clause in the
//      middle of "2 running · 3 need review · 11 done", at 9px, in the same
//      grey as everything else — the one number that requires a human, hidden
//      in a list. It is now a filled pill, and the only saturated element in
//      the column, so the eye lands on it before reading a word.
//   3. IDLE WORKERS SAY NOTHING. "no work yet" on four of six rows is not
//      status, it is noise. An absent line is the correct rendering of nothing
//      happening.
//
// The nested work under each worker drops its `errand` / `shift` tag column
// too: an errand is what YOU said, so it renders as your words; a shift is
// what the worker did on its own, so it is dimmer and numbered. The shape of
// the line carries the distinction the tag used to spell out.

import { useMemo } from "react";

import { useFlowsStore } from "../../flowsStore";
import { FlowRunRow, runIsLive } from "../flows/FlowRunSidebarRow";
import { useOrchestratorStore } from "../../orchestratorStore";
import { useRunningMap } from "../../runnersStore";
import { useStore } from "../../store";
import { newWorkerDraft, useWorkersStore } from "../../workersStore";
import { sortRoster, type Worker } from "@shared/flows/worker";
import type { TreasuryAllocation } from "@shared/flows/treasury";
import { WorkerAvatar } from "./WorkerAvatar";
import { TRUST_LABEL } from "./WorkerRowParts";
import {
  describeActivity,
  deskMatchesQuery,
  relativeTime,
  summarizeDesk,
  workerActivity,
  sidebarActivity,
  sidebarShifts,
  workerDeskOrchestrations,
  workerDeskRuns,
  workerRunsForSidebar,
  type WorkerActivity,
} from "./workerDeskSelectors";

/// How many of TODAY's errands hang under a worker's row. Four: a busy morning
/// is visible without one worker pushing the rest of the roster off screen.
const NESTED_ERRANDS = 4;
/// And how many of its shifts — see sidebarShifts, which keeps the newest plus
/// whatever still owes you a decision. The cap is only a backstop for a worker
/// holding an implausible pile of unreviewed shifts.
const NESTED_SHIFTS = 4;
/// How deep we look for those turns before the day filter runs.
const ACTIVITY_SCAN = 40;
/// And how many of its RUNS. A worker's runs are kept out of every project's
/// Flows group, so this is their only home in the sidebar — but a worker on an
/// hourly cadence would otherwise bury the roster under its own history.
const NESTED_RUNS = 4;

export function WorkersSidebar({
  query,
  collapsed,
  onToggleCollapsed,
}: {
  query: string;
  // Expanded unless the user says otherwise — the same model the project rows
  // use. Tracking only what was CLOSED means a worker hired tomorrow arrives
  // open, rather than inheriting a default nobody chose. The set lives in the
  // Sidebar because the collapse-all button up in the search row folds this
  // roster too, and two copies of that state meant the button did nothing.
  collapsed: Set<string>;
  onToggleCollapsed: (id: string) => void;
}) {
  const workers = useWorkersStore((s) => s.workers);
  const selectedWorkerId = useWorkersStore((s) => s.selectedWorkerId);
  const selectWorker = useWorkersStore((s) => s.selectWorker);
  const view = useWorkersStore((s) => s.view);
  const showCalendar = useWorkersStore((s) => s.showCalendar);
  const showFunds = useWorkersStore((s) => s.showFunds);
  const allocation = useWorkersStore((s) => s.allocation);
  const openEditor = useWorkersStore((s) => s.openEditor);
  const runs = useFlowsStore((s) => s.runs);
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);

  // Search matches a worker's own runs too, not just its name — you look for a
  // worker by what it did at least as often as by what it is called.
  const roster = useMemo(
    () =>
      sortRoster(
        Object.values(workers).filter((w) =>
          deskMatchesQuery(w, workerDeskRuns(runs, w.id), query),
        ),
      ),
    [workers, query, runs],
  );
  const hirePath = workspaces[0]?.rootPath ?? projects[0]?.path ?? "";

  return (
    <>
      {/* Above the roster, not in it: the calendar is about every worker at
          once, so it is not one of the names it sits over. */}
      <button
        onClick={showCalendar}
        title="When every worker's shifts fall, this week"
        className={
          "sidebar-row mb-1 mt-1 flex w-full items-center gap-2 rounded px-2 py-1 text-left " +
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

      <div className="mt-1 flex items-center gap-1.5 px-2">
        <span className="text-[10px] uppercase tracking-wider text-ink-faint">
          Workers
        </span>
        {/* Hiring belongs on the roster, not only in the pane header — this is
            the list you look at when you notice nobody covers something. */}
        {hirePath !== "" && (
          <button
            onClick={() => openEditor(newWorkerDraft(hirePath))}
            title="Hire a worker"
            aria-label="Hire a worker"
            className="ml-auto rounded px-1 text-[11px] leading-none text-ink-faint hover:bg-card-strong hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
          >
            +
          </button>
        )}
      </div>

      {roster.length === 0 ? (
        <div className="px-2 py-1 text-[10px] text-ink-faint">
          {query ? "No matching workers" : "Nobody works here yet"}
        </div>
      ) : (
        roster.map((worker, index) => (
          <RosterRow
            key={worker.id}
            worker={worker}
            query={query}
            selected={view === "worker" && worker.id === selectedWorkerId}
            onSelect={() => selectWorker(worker.id)}
            canMoveUp={index > 0}
            canMoveDown={index < roster.length - 1}
            // A search is a request to SEE things; honouring a collapse while
            // one is running would hide the row that matched it.
            expanded={query !== "" || !collapsed.has(worker.id)}
            onToggleExpanded={() => onToggleCollapsed(worker.id)}
          />
        ))
      )}
    </>
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
  expanded,
  onToggleExpanded,
}: {
  worker: Worker;
  query: string;
  selected: boolean;
  onSelect: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const runs = useFlowsStore((s) => s.runs);
  const orchestrations = useOrchestratorStore((s) => s.orchestrations);
  const runners = useRunningMap();
  const shift = useWorkersStore((s) => s.shiftProgress[worker.id]);
  const openWorkerActivity = useWorkersStore((s) => s.openWorkerActivity);
  const moveWorker = useWorkersStore((s) => s.moveWorker);

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
  // Today's turns, uncapped here on purpose: errands and shifts thin out by
  // different rules below, and a shared cap let an hourly clock spend the whole
  // budget before the errand you sent got a row.
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
  const todaysErrands = useMemo(
    () => recent.filter((item) => item.task === "errand"),
    [recent],
  );
  const errands = useMemo(
    () => todaysErrands.slice(0, NESTED_ERRANDS),
    [todaysErrands],
  );
  const todaysShifts = useMemo(
    () => recent.filter((item) => item.task === "shift"),
    [recent],
  );
  const shifts = useMemo(
    () => sidebarShifts(todaysShifts, NESTED_SHIFTS),
    [todaysShifts],
  );
  const openTurn = (orchestrationId: string, at: number) =>
    openWorkerActivity(worker.id, orchestrationId, at);
  const activeRunId = useFlowsStore((s) => s.activeRunId);
  const myRuns = useMemo(
    () =>
      workerRunsForSidebar(runs, worker.id, query, NESTED_RUNS, activeRunId),
    [runs, worker.id, query, activeRunId],
  );
  const hidden = errands.length + shifts.length + myRuns.length;

  // Only what is true RIGHT NOW. Totals are history and live in Stats; putting
  // "11 done" here made an idle worker look busy.
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
    <div className="group/row relative mt-0.5">
      <button
        onClick={onSelect}
        className={
          "sidebar-row flex w-full items-center gap-2 rounded px-2 py-1 text-left " +
          "hover:bg-card-strong hover:text-ink hover:border-card " +
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 " +
          (selected ? "sidebar-row-selected text-ink" : "text-ink-muted")
        }
        title={`${worker.name} · ${TRUST_LABEL[worker.trust].text}${
          summary.needReview > 0
            ? ` · ${summary.needReview} waiting for your review`
            : ""
        }`}
      >
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            // Collapsing is not selecting: a roster you have to open in order
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
        <WorkerAvatar worker={worker} live={summary.live} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] leading-tight">
            {worker.name}
          </span>
          {status && (
            <span className="block truncate text-[10px] leading-4 text-ink-faint">
              {status}
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
          {!expanded && hidden > 0 && (
            <span className="shrink-0 text-[10px] tabular-nums text-ink-faint">
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
          onClick={() => void moveWorker(worker.id, -1)}
        />
        <MoveButton
          label="Move down — funded after the workers above it"
          glyph="▼"
          disabled={!canMoveDown}
          onClick={() => void moveWorker(worker.id, 1)}
        />
      </div>

      {/* A rail, so the work reads as belonging to the worker above it rather
          than floating between two of them — and inside it, the three things a
          worker has: what YOU asked for, what it did on its own, and the runs
          either of those launched. Each group is named, because "Shift 2" and
          "can you run the tests" sitting in one unlabelled list made the
          reader do the sorting. Empty groups render nothing. */}
      {expanded &&
        (sending?.length ||
          errands.length > 0 ||
          shifts.length > 0 ||
          myRuns.length > 0) && (
          <div className="ml-[13px] border-l border-card pl-2">
            {(sending?.length || errands.length > 0) && (
              <GroupLabel
                text="Errands"
                hidden={todaysErrands.length - errands.length}
              />
            )}
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
            {errands.map((item) => (
              <TurnRow
                key={item.orchestration.id}
                item={item}
                onOpen={openTurn}
              />
            ))}

            {/* The count says what was folded away, because a group that quietly
              drops eleven shifts reads as a worker that only ran one. */}
            {shifts.length > 0 && (
              <GroupLabel
                text="Shifts"
                hidden={todaysShifts.length - shifts.length}
              />
            )}
            {shifts.map((item) => (
              <TurnRow
                key={item.orchestration.id}
                item={item}
                onOpen={openTurn}
              />
            ))}

            {/* The worker's runs, exactly as a project lists its flows. A worker IS
          the container these runs belong to — that is why they are filtered
          out of every project's group — so this is where their state (live,
          paused, failed) has to be visible without opening anything. */}
            {myRuns.length > 0 && <GroupLabel text="Flows" />}
            {myRuns.map((run) => (
              <FlowRunRow
                key={run.id}
                run={run}
                selected={run.id === activeRunId}
                isLive={runIsLive(run, runners)}
              />
            ))}
          </div>
        )}
    </div>
  );
}

/// The same 20px tile a flow run gets, so the three groups under a worker line
/// their text up instead of stepping in and out. The glyphs say WHOSE the work
/// is: an errand is speech — you asked for it — and a shift is a clock, the
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

function GroupLabel({ text, hidden = 0 }: { text: string; hidden?: number }) {
  return (
    <div className="px-1.5 pt-1 text-[10px] uppercase tracking-wider text-ink-faint">
      {text}
      {hidden > 0 && (
        <span className="normal-case tracking-normal"> · {hidden} more</span>
      )}
    </div>
  );
}

/// One turn under a worker. Clicking it opens THAT turn on the desk — on its
/// own day, expanded — rather than dropping you on the worker to search again.
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
      title={`${item.title} · ${describeActivity(item)} · ${relativeTime(item.at)}`}
    >
      <TurnIcon task={item.task} />
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
