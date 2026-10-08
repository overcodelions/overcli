// The Workers tab's navigator — a rail of faces.
//
// It replaced a sidebar that sorted the roster into attention groups (needs
// you, running, worked today, quiet, bench). That board answered "who needs
// me" well, but it answered it by MOVING people: a worker finishing a run
// jumped from "Running now" to "Worked today", captions came and went, and the
// row you were reaching for was somewhere else by the time you clicked. The
// Today page already lists what needs you, with its buttons, so the navigator
// only has to be a stable place to pick a worker from. Four rules follow:
//
//   1. ORDER IS YOURS. The rail draws the roster in the order you set — drag a
//      face, or Alt+↑/↓ — and status never re-sorts it. Only the bench sits
//      apart, below a rule, because a paused worker is a different kind of
//      thing rather than a different moment.
//   2. STATUS IS A MARK, NOT A POSITION. The group a worker would have been
//      drawn under rides on its face instead (see `railMark`): a violet ring
//      is waiting on your decision, amber is stopped, a pulsing emerald ring is
//      running, a dot is "did something today", and a dimmed face is quiet.
//   3. THIN BY DEFAULT. Collapsed, the rail is faces only and the tooltip
//      carries the name and status line. Expanded, it adds them as text. The
//      width changes only when you toggle it, never because of what you click.
//   4. NOTHING FOLDS BY ITSELF. The old "9 quiet" and "on the bench" folds
//      opened and closed under the cursor as status changed; here every
//      worker keeps its own slot. What does group a big crew is fixed by who
//      a worker IS, never what it is doing: its project (a divider, and on
//      the expanded rail a header you can fold — it stays folded until you
//      open it), and for a hire that only works for a team, that team (it
//      sits under the team's row, not on the crew list).

import { useEffect, useMemo, useRef, useState } from "react";

import { useFlowsStore } from "../../flowsStore";
import { useOrchestratorStore } from "../../orchestratorStore";
import { useRunningMap } from "../../runnersStore";
import { useTickingNow } from "../../hooks";
import { useStore } from "../../store";
import { labOn } from "@shared/labs";
import { newWorkerDraft, useWorkersStore } from "../../workersStore";
import { moveWithinGroup, sortRoster, workerTagline } from "@shared/flows/worker";
import type { TreasuryAllocation } from "@shared/flows/treasury";
import { useWorkerBoard } from "./useWorkerBoard";
import { WorkerAvatar } from "./WorkerAvatar";
import { TRUST_LABEL } from "./WorkerRowParts";
import {
  boardLine,
  boardReasons,
  railDropIndex,
  railMark,
  type BoardEntry,
  type RailMark,
} from "./workerBoard";
import { buildWorkQueue } from "./workQueue";
import { PopMenu, type MenuItemDef } from "../SidebarPlaces";
import { fundingFor } from "@shared/flows/treasury";
import { searchWork } from "./workSearch";
import { awayLine, morningAfter, nextMondayMorning } from "./awayMode";
import { NewTeamButton, TeamRailSection } from "./teams/TeamRail";
import { useTeamsStore } from "../../teamsStore";
import { foldSummary, groupByProject, teamOnlyIds, type ProjectGroup } from "./workerBoard";
import { projectName, useProjectOptions } from "./teams/ProjectChoice";

export const RAIL_COLLAPSED_WIDTH = 64;
export const RAIL_EXPANDED_WIDTH = 212;

/// The ring each mark draws around a face. Colour here means STATE, the same
/// hues the rest of the tab uses: violet waiting, amber stopped, emerald
/// running. The gap between face and ring is the rail's own background, so
/// the ring reads as a halo rather than a thicker border on the avatar.
const MARK_RING: Partial<Record<RailMark, string>> = {
  waiting: "rgb(167 139 250)",
  stopped: "rgb(245 158 11)",
  running: "rgb(52 211 153)",
};

export function WorkersRail({
  expanded,
  onToggleExpanded,
}: {
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const workers = useWorkersStore((s) => s.workers);
  const shiftProgress = useWorkersStore((s) => s.shiftProgress);
  const selectedWorkerId = useWorkersStore((s) => s.selectedWorkerId);
  const showWorkerInbox = useWorkersStore((s) => s.showWorkerInbox);
  const inboxWorkerId = useWorkersStore((s) => s.inboxWorkerId);
  const dropWorker = useWorkersStore((s) => s.dropWorker);
  const view = useWorkersStore((s) => s.view);
  const showToday = useWorkersStore((s) => s.showToday);
  const showQueue = useWorkersStore((s) => s.showQueue);
  const runs = useFlowsStore((s) => s.runs);
  const runsLoaded = useFlowsStore((s) => s.runsLoaded);
  const runners = useRunningMap();
  const orchestrations = useOrchestratorStore((s) => s.orchestrations);
  // The Orchestrator lives here too, pinned above the crew: it is the general
  // worker — no persona, no schedule, runs whatever batch you hand it. While
  // it is open the rail stays, and nothing below it reads as selected.
  const detailMode = useStore((s) => s.detailMode);
  const onWorkers = detailMode === "workers";
  const labs = useStore((s) => s.settings.labs);
  const showOrchestrator = labOn(labs, "orchestrator") || detailMode === "orchestrator";

  // Search lives in the expanded rail only: a query needs somewhere to show
  // its results, and 64px is not it. Collapsing drops the query so the faces
  // never sit silently filtered.
  const [search, setSearch] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const focusSearch = useRef(false);
  useEffect(() => {
    if (!expanded) setSearch("");
    else if (focusSearch.current) {
      focusSearch.current = false;
      searchInput.current?.focus();
    }
  }, [expanded]);
  const query = search.trim().toLowerCase();

  const now = useTickingNow(30_000);
  const board = useWorkerBoard(query, now);
  // Debug's "nobody hired" preview renders the tab as if the roster were
  // empty; the rail follows it so the empty state can be looked at whole.
  const previewEmpty = useWorkersStore((s) => s.previewEmpty);
  const entries = previewEmpty ? [] : board.entries;
  // Hires that only work for a team are reached through it. A search finds
  // everyone, wherever they sit.
  const teams = useTeamsStore((s) => s.teams);
  const teamOnly = useMemo(
    () => (query ? new Set<string>() : teamOnlyIds(Object.values(workers), Object.values(teams))),
    [query, workers, teams],
  );
  const listed = entries.filter((entry) => !teamOnly.has(entry.worker.id));
  const active = listed.filter((entry) => entry.worker.enabled);
  const bench = listed.filter((entry) => !entry.worker.enabled);
  const projectOptions = useProjectOptions();
  const groups = groupByProject(active, (path) => projectName(projectOptions, path) ?? "Elsewhere");
  const [folded, setFolded] = useState<Record<string, boolean>>(readFolded);
  const toggleFold = (key: string) =>
    setFolded((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try {
        localStorage.setItem(FOLD_KEY, JSON.stringify(next));
      } catch {
        // best-effort
      }
      return next;
    });
  // Nobody hired, as opposed to nobody matching a search.
  const noCrew = previewEmpty || Object.keys(workers).length === 0;
  const needsYou = board.groups.needsYou.length;

  const queueRunning = useMemo(
    () =>
      buildWorkQueue(orchestrations, runs, workers, shiftProgress, now, runsLoaded, runners)
        .running.length,
    [orchestrations, runs, workers, shiftProgress, now, runsLoaded, runners],
  );

  // Drag state: which face is moving, and where the drop line is drawn.
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; after: boolean } | null>(null);
  const ordered = () => sortRoster(Object.values(workers));
  const drop = (targetId: string, after: boolean) => {
    const id = dragId;
    setDragId(null);
    setDropAt(null);
    if (!id || id === targetId) return;
    const insertBefore = railDropIndex(ordered(), targetId, after);
    if (insertBefore !== null) void dropWorker(id, insertBefore);
  };
  // Keyboard reorder moves within the section the face is drawn in, resolved
  // against the full roster — see `moveWithinGroup`.
  const nudge = (section: BoardEntry[], id: string, direction: -1 | 1) => {
    const insertBefore = moveWithinGroup(
      ordered(),
      section.map((entry) => entry.worker),
      id,
      direction,
    );
    if (insertBefore !== null) void dropWorker(id, insertBefore);
  };

  // A face opens the worker's INBOX — Today, narrowed to its work — so
  // clicking down the rail swaps the list and the reader and nothing else.
  // The desk (the worker itself) is one click on from the inbox's header, or
  // from the worker's name above anything it filed. A worker that needs you
  // lands on the decision without special-casing: the inbox opens the oldest
  // one first.
  const onScreen = (id: string) =>
    onWorkers &&
    ((view === "today" && inboxWorkerId === id) || (view === "worker" && selectedWorkerId === id));

  // A team holding the worker on screen shows its members, so that worker
  // is never hidden inside a closed team.
  const openTeamsFor = new Set(
    Object.values(teams)
      .filter((team) => team.members.some((m) => teamOnly.has(m.workerId) && onScreen(m.workerId)))
      .map((team) => team.id),
  );

  const face = (entry: BoardEntry, section: BoardEntry[]) => (
    <RailFace
      key={entry.worker.id}
      entry={entry}
      expanded={expanded}
      progress={shiftProgress[entry.worker.id]?.task}
      selected={onScreen(entry.worker.id)}
      onOpen={() => showWorkerInbox(entry.worker.id)}
      onNudge={(direction) => nudge(section, entry.worker.id, direction)}
      dragging={dragId === entry.worker.id}
      dropLine={dropAt?.id === entry.worker.id ? (dropAt.after ? "after" : "before") : null}
      onDragStart={() => setDragId(entry.worker.id)}
      onDragEnd={() => {
        setDragId(null);
        setDropAt(null);
      }}
      onDragOver={(after) => {
        if (dragId && dragId !== entry.worker.id) setDropAt({ id: entry.worker.id, after });
      }}
      onDrop={(after) => drop(entry.worker.id, after)}
    />
  );

  const toggle = (
    <RailButton
      label="Collapse"
      title={expanded ? "Collapse the rail" : "Show names"}
      expanded={expanded}
      active={false}
      onClick={onToggleExpanded}
      icon={<RailToggleIcon />}
      quiet
    />
  );

  // Nobody hired: Today, Queue, Shifts and Report all have nothing to show
  // (the pane is the hiring page whichever you pick), and search has nothing
  // to search. So the rail is only the empty chair, in the slot the first
  // face will take — and the navigation arrives with the first hire.
  const orchestratorButton = showOrchestrator && (
    <RailButton
      label="Orchestrator"
      detail={expanded ? "Runs any batch you hand it" : undefined}
      title="The general worker: hand it a list and a flow, and it runs them side by side"
      expanded={expanded}
      active={detailMode === "orchestrator"}
      onClick={() => useStore.getState().setDetailMode("orchestrator")}
      icon={<OrchestratorIcon />}
    />
  );

  // Every other control on the rail is a Workers view. From the Orchestrator,
  // a click on one of them has to come back to the Workers tab first — the
  // capture phase does that once here instead of in every handler.
  const leaveOrchestrator = (e: React.MouseEvent) => {
    if (detailMode !== "orchestrator") return;
    const target = e.target as HTMLElement;
    if (target.closest("[data-orchestrator-button]")) return;
    if (!target.closest("button, a")) return;
    useStore.getState().setDetailMode("workers");
  };

  if (noCrew) {
    return (
      <nav
        aria-label="Workers"
        onClickCapture={leaveOrchestrator}
        className="flex h-full flex-col border-r border-card bg-surface-muted py-2"
      >
        <div className="flex flex-col gap-0.5 px-2">
          {orchestratorButton && <div data-orchestrator-button>{orchestratorButton}</div>}
          <HireButton expanded={expanded} first />
        </div>
        <div className="flex-1" />
        <div className="flex flex-col gap-0.5 px-2">{toggle}</div>
      </nav>
    );
  }

  return (
    <nav
      aria-label="Workers"
      onClickCapture={leaveOrchestrator}
      className="flex h-full flex-col border-r border-card bg-surface-muted py-2"
    >
      <div className="flex flex-col gap-0.5 px-2">
        {orchestratorButton && (
          <>
            <div data-orchestrator-button>{orchestratorButton}</div>
            <div className="mx-1 my-1 h-px shrink-0 bg-card" />
          </>
        )}
        <RailButton
          label="Today"
          detail={needsYou > 0 ? `${needsYou} need${needsYou === 1 ? "s" : ""} you` : undefined}
          title="Where the crew is right now, and what it has done today"
          expanded={expanded}
          active={onWorkers && view === "today" && !inboxWorkerId}
          onClick={showToday}
          icon={<TodayIcon />}
          badge={
            needsYou > 0 ? (
              <span className="absolute -right-1 -top-1 min-w-[14px] rounded-full bg-violet-400 px-[3px] text-center text-[9px] font-bold leading-[14px] text-black">
                {needsYou}
              </span>
            ) : queueRunning > 0 ? (
              <span
                title={`${queueRunning} job(s) running`}
                className="absolute right-0 top-0 h-1.5 w-1.5 animate-pulse rounded-full bg-accent"
              />
            ) : null
          }
        />
        <RailButton
          label="Queue"
          title="Every job the crew has run — filter it, find it, act on it"
          expanded={expanded}
          active={onWorkers && view === "queue"}
          onClick={showQueue}
          icon={<QueueIcon />}
        />
        {expanded ? (
          <input
            ref={searchInput}
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && search) {
                e.stopPropagation();
                setSearch("");
              }
            }}
            placeholder="Search workers and work"
            aria-label="Search workers and their work"
            className="field mt-1 w-full min-w-0 px-2 py-1 text-xs"
          />
        ) : (
          <RailButton
            label="Search"
            title="Search workers and their work"
            expanded={false}
            active={false}
            onClick={() => {
              focusSearch.current = true;
              onToggleExpanded();
            }}
            icon={<SearchIcon />}
          />
        )}
      </div>

      <div className="mx-3 my-2 h-px shrink-0 bg-card" />

      {/* The narrow sidebar scrollbar (6px, thumb only on hover): the
          system's full-width track left a selected face's highlight barely
          wider than the face, its selection line touching the ring. */}
      <div
        className={
          "sidebar-scroll flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden " +
          (expanded ? "pl-2 pr-0.5" : "pl-1.5 pr-0")
        }
      >
        {entries.length === 0 ? (
          expanded && (
            <div className="px-2 py-1 text-[10px] text-ink-faint">
              No workers match “{search.trim()}”.
            </div>
          )
        ) : (
          <>
            {!query && (
              <TeamRailSection
                expanded={expanded}
                forceOpen={openTeamsFor}
                renderMembers={(team) =>
                  team.members
                    .map((m) => entries.find((e) => e.worker.id === m.workerId))
                    .filter((e): e is BoardEntry => !!e)
                    .map((e) => (
                      <TeamMemberRow
                        key={e.worker.id}
                        entry={e}
                        selected={onScreen(e.worker.id)}
                        onOpen={() => showWorkerInbox(e.worker.id)}
                      />
                    ))
                }
              />
            )}
            {groups.length > 1
              ? groups.map((group, i) => (
                  <ProjectSection
                    key={group.key}
                    group={group}
                    first={i === 0}
                    expanded={expanded}
                    // A folded group still shows the worker you have open.
                    folded={expanded && !!folded[group.key] && !query}
                    onToggle={() => toggleFold(group.key)}
                    face={(entry) => face(entry, group.entries)}
                    pinned={(entry) => onScreen(entry.worker.id)}
                  />
                ))
              : active.map((entry) => face(entry, active))}
            {bench.length > 0 && (
              <>
                <div className="mx-1 my-1.5 h-px shrink-0 bg-card" />
                {expanded && (
                  <div className="px-2 pb-0.5 text-[10px] uppercase tracking-wider text-ink-faint">
                    Bench
                  </div>
                )}
                {bench.map((entry) => face(entry, bench))}
              </>
            )}
          </>
        )}
        {expanded && query && <WorkResults query={query} />}
      </div>

      <div className={"mt-2 flex flex-col gap-0.5 " + (expanded ? "px-2" : "px-1")}>
        <HireButton expanded={expanded} />
        <NewTeamButton expanded={expanded} />
        <div className="mx-1 my-1.5 h-px bg-card" />
        <RailFooter expanded={expanded} onToggleExpanded={onToggleExpanded} />
      </div>
    </nav>
  );
}

/// Which project groups are folded on the expanded rail, by project path.
const FOLD_KEY = "overcli.railProjectsFolded";

function readFolded(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(FOLD_KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}

const FOLD_TONE = { waiting: "text-violet-400", stopped: "text-amber-400", running: "text-emerald-400" } as const;

/// One project's workers. Collapsed, a rule between groups (its name in the
/// tooltip). Expanded, a header that folds — by your click only — and, when
/// folded, says what the hidden faces need: "1 needs you · 2 working".
function ProjectSection({
  group,
  first,
  expanded,
  folded,
  onToggle,
  face,
  pinned,
}: {
  group: ProjectGroup;
  first: boolean;
  expanded: boolean;
  folded: boolean;
  onToggle: () => void;
  face: (entry: BoardEntry) => React.ReactNode;
  pinned: (entry: BoardEntry) => boolean;
}) {
  const summary = folded ? foldSummary(group.entries) : [];
  const shown = folded ? group.entries.filter(pinned) : group.entries;
  return (
    <>
      {expanded ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!folded}
          className={
            "flex w-full items-center gap-1.5 rounded px-2 pb-0.5 text-left text-[10px] uppercase tracking-wider text-ink-faint hover:text-ink-muted " +
            (first ? "pt-0.5" : "pt-2")
          }
        >
          <svg width="8" height="8" viewBox="0 0 16 16" aria-hidden className={"shrink-0 transition-transform " + (folded ? "" : "rotate-90")}>
            <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <span className="truncate">{group.label}</span>
          <span className="shrink-0">· {group.entries.length}</span>
          {summary.length > 0 && (
            <span className="ml-auto flex shrink-0 gap-1.5 normal-case tracking-normal">
              {summary.map((s) => (
                <span key={s.tone} className={FOLD_TONE[s.tone]}>
                  {s.text}
                </span>
              ))}
            </span>
          )}
        </button>
      ) : (
        !first && <div title={group.label} className="mx-2 my-1 h-px shrink-0 bg-card" />
      )}
      {shown.map((entry) => face(entry))}
    </>
  );
}

/// A team member under its team on the expanded rail: smaller than a crew
/// row, since the team is what you work with and they are who is on it.
function TeamMemberRow({ entry, selected, onOpen }: { entry: BoardEntry; selected: boolean; onOpen: () => void }) {
  const { worker } = entry;
  const mark = railMark(entry);
  const note =
    mark === "waiting" ? "needs you" : mark === "stopped" ? "stopped" : mark === "running" ? "working" : !worker.enabled ? "paused" : "";
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${worker.name}${note ? ` · ${note}` : ""}`}
      aria-current={selected ? "page" : undefined}
      className={
        "sidebar-row flex w-full items-center gap-2 rounded-md border border-transparent px-1.5 py-1 text-left " +
        (selected ? "sidebar-row-selected text-ink" : "text-ink-muted hover:bg-card-strong hover:text-ink")
      }
    >
      <WorkerAvatar worker={worker} size="xs" live={mark === "running"} untitled />
      <span className="min-w-0 flex-1 truncate text-[11.5px]">{worker.name}</span>
      {note && (
        <span className={"shrink-0 text-[10px] " + (mark in FOLD_TONE ? FOLD_TONE[mark as keyof typeof FOLD_TONE] : "text-ink-faint")}>
          {note}
        </span>
      )}
    </button>
  );
}

/// One worker's slot. The face is the button; its ring, dot and dimming are
/// the status (see `railMark`), and the tooltip says the same in words, since
/// a collapsed rail has nowhere else to put them.
function RailFace({
  entry,
  expanded,
  progress,
  selected,
  onOpen,
  onNudge,
  dragging,
  dropLine,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  entry: BoardEntry;
  expanded: boolean;
  progress: "shift" | "errand" | undefined;
  selected: boolean;
  onOpen: () => void;
  onNudge: (direction: -1 | 1) => void;
  dragging: boolean;
  dropLine: "before" | "after" | null;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: (after: boolean) => void;
  onDrop: (after: boolean) => void;
}) {
  const { worker } = entry;
  const menu = useFaceMenu(worker.id, worker.enabled, progress);
  const mark = railMark(entry);
  const ring = MARK_RING[mark];
  const status = !worker.enabled
    ? "on the bench"
    : progress
      ? progress === "errand"
        ? "on your errand"
        : "working a shift"
      : entry.live
        ? "running"
        : null;
  const tagline = workerTagline(worker);
  const line = boardLine(entry, status, tagline);
  const reasons = boardReasons(entry);
  const tooltip = [
    worker.name,
    line,
    TRUST_LABEL[worker.trust].text,
    entry.home,
    "drag or Alt+↑/↓ to reorder",
  ]
    .filter(Boolean)
    .join(" · ");
  const lineTone =
    mark === "waiting"
      ? "text-violet-400"
      : mark === "stopped"
        ? "text-amber-400"
        : mark === "running"
          ? "text-emerald-400"
          : "text-ink-faint";
  const isAfter = (e: React.DragEvent) => {
    const box = e.currentTarget.getBoundingClientRect();
    return e.clientY > box.top + box.height / 2;
  };

  return (
    <div className="relative">
      {dropLine && (
        <span
          aria-hidden
          className={
            "pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-accent " +
            (dropLine === "before" ? "-top-px" : "-bottom-px")
          }
        />
      )}
      <button
        type="button"
        draggable
        ref={menu.anchor}
        onClick={onOpen}
        onContextMenu={menu.open}
        onKeyDown={(e) => {
          if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
            e.preventDefault();
            onNudge(e.key === "ArrowUp" ? -1 : 1);
          }
        }}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", worker.id);
          onDragStart();
        }}
        onDragEnd={onDragEnd}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          onDragOver(isAfter(e));
        }}
        onDrop={(e) => {
          e.preventDefault();
          onDrop(isAfter(e));
        }}
        title={tooltip}
        aria-label={`${worker.name}${line ? ` — ${line}` : ""}${reasons && !line?.includes(reasons) ? ` · ${reasons}` : ""}`}
        aria-current={selected ? "page" : undefined}
        className={
          "sidebar-row flex min-h-[44px] w-full items-center gap-2.5 rounded-md border border-transparent py-1.5 text-left " +
          (expanded ? "px-2 " : "justify-center px-0 ") +
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 " +
          (selected
            ? "sidebar-row-selected text-ink"
            : "text-ink-muted hover:bg-card-strong hover:text-ink") +
          (dragging ? " opacity-40" : "")
        }
      >
        <span
          className={
            "relative flex shrink-0 rounded-full " +
            (mark === "quiet" ? "opacity-60 " : mark === "bench" ? "opacity-70 " : "")
          }
          style={
            ring
              ? { boxShadow: `0 0 0 2px var(--c-surface-muted), 0 0 0 3.5px ${ring}` }
              : undefined
          }
        >
          <WorkerAvatar worker={worker} size="md" live={mark === "running"} untitled />
          {mark === "today" && (
            <span
              aria-hidden
              className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[color:var(--c-surface-muted)] bg-accent"
            />
          )}
        </span>
        {expanded && (
          <span className="flex min-w-0 flex-1 flex-col">
            <span
              className={
                "truncate text-[12.5px] font-medium " +
                (worker.enabled ? "" : "text-ink-faint")
              }
            >
              {worker.name}
            </span>
            {line && <span className={"truncate text-[10.5px] " + lineTone}>{line}</span>}
          </span>
        )}
      </button>
      {menu.at && (
        <PopMenu
          anchor={menu.anchor}
          at={menu.at}
          heading={worker.name}
          headingDetail={tagline || undefined}
          items={menu.items}
          width={240}
          onClose={menu.close}
        />
      )}
    </div>
  );
}

/// A face's right-click menu: the desk, its settings, and the two things you
/// most often go to settings FOR — a shift now, or a pause — without opening
/// either. Firing and promoting stay on Settings, next to their rules.
function useFaceMenu(
  workerId: string,
  enabled: boolean,
  progress: "shift" | "errand" | undefined,
) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const openWorkerDesk = useWorkersStore((s) => s.openWorkerDesk);
  const openWorkerSettings = useWorkersStore((s) => s.openWorkerSettings);
  const workShiftNow = useWorkersStore((s) => s.workShiftNow);
  const setEnabled = useWorkersStore((s) => s.setEnabled);
  const starting = useWorkersStore((s) => !!s.shiftStarting[workerId]);
  const allocation = useWorkersStore((s) => s.allocation);
  const funding = fundingFor(allocation, workerId);
  // Same gate as the desk's "Run shift now": the engine refuses an unfunded
  // shift after the click, into an error nothing here draws.
  const shiftHint = progress === "shift" || starting
    ? "running"
    : !enabled || funding?.blocked === "paused"
      ? "paused"
      : allocation && funding && !funding.funded
        ? "out of budget"
        : undefined;
  const items: MenuItemDef[] = [
    { label: "Open desk", onSelect: () => openWorkerDesk(workerId) },
    { label: "Settings…", onSelect: () => openWorkerSettings(workerId) },
    { divider: true, label: "", onSelect: () => {} },
    {
      label: "Run shift now",
      hint: shiftHint,
      disabled: !!shiftHint,
      onSelect: () => void workShiftNow(workerId),
    },
    enabled
      ? { label: "Pause", hint: "no shifts, no funding", onSelect: () => void setEnabled(workerId, false) }
      : { label: "Put back on the clock", onSelect: () => void setEnabled(workerId, true) },
  ];
  return {
    anchor,
    at,
    items,
    open: (e: React.MouseEvent) => {
      e.preventDefault();
      setAt({ x: e.clientX, y: e.clientY });
    },
    close: () => setAt(null),
  };
}

/// An icon that grows a label when the rail is expanded.
function RailButton({
  label,
  detail,
  title,
  expanded,
  active,
  onClick,
  icon,
  badge,
  quiet = false,
}: {
  label: string;
  detail?: string;
  title: string;
  expanded: boolean;
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  badge?: React.ReactNode;
  quiet?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={expanded ? undefined : label}
      aria-current={active ? "page" : undefined}
      className={
        "flex min-h-[36px] w-full items-center gap-2.5 rounded-md border border-transparent py-1 text-left " +
        (expanded ? "px-2 " : "justify-center px-0 ") +
        "focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 " +
        (active
          ? "sidebar-row-selected text-ink"
          : (quiet ? "text-ink-faint" : "text-ink-muted") + " hover:bg-card-strong hover:text-ink")
      }
    >
      <span className="relative flex h-8 w-8 shrink-0 items-center justify-center">
        {icon}
        {badge}
      </span>
      {expanded && (
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-xs">{label}</span>
          {detail && <span className="truncate text-[10.5px] text-violet-400">{detail}</span>}
        </span>
      )}
    </button>
  );
}

/// The tab's one create action, always the rail's last slot above the
/// occasional views — a dashed empty face, the chair you haven't filled yet.
/// `first` is the empty rail's version: it sits at the top, where the first
/// face will go, so its menu opens downward.
function HireButton({ expanded, first = false }: { expanded: boolean; first?: boolean }) {
  const openHire = useWorkersStore((s) => s.openHire);
  const openEditor = useWorkersStore((s) => s.openEditor);
  const openTeamEditor = useWorkersStore((s) => s.openTeamEditor);
  const crewSize = useWorkersStore((s) => Object.keys(s.workers).length);
  const importFromFile = useWorkersStore((s) => s.importFromFile);
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const hirePath = workspaces[0]?.rootPath ?? projects[0]?.path ?? "";
  const hireEveryday = projects.find((project) => project.path === hirePath)?.everyday;
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menuOpen]);
  // A worker is hired onto a project, so with none there is nothing to
  // hire into. The chair stays, greyed, and says why — aria-disabled rather
  // than disabled, because a disabled button shows no tooltip.
  const blocked = hirePath === "";
  const label = first ? "Hire your first worker" : "Hire a worker";
  const item = "w-full px-3 py-1.5 text-left text-xs hover:bg-card-strong";
  return (
    <div ref={menu} className="relative">
      <button
        type="button"
        onClick={() => {
          if (!blocked) setMenuOpen((o) => !o);
        }}
        title={blocked ? "Add a project or workspace first — a worker is hired onto one" : label}
        aria-label={expanded ? undefined : label}
        aria-disabled={blocked || undefined}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        className={
          "flex min-h-[44px] w-full items-center gap-2.5 rounded-md py-1.5 text-left " +
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 " +
          (blocked
            ? "cursor-not-allowed text-ink-faint opacity-50 "
            : "text-ink-muted hover:bg-card-strong hover:text-ink ") +
          (expanded ? "px-2" : "justify-center px-0")
        }
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-[1.5px] border-dashed border-card-strong">
          <svg viewBox="0 0 14 14" aria-hidden className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M7 2.5v9M2.5 7h9" />
          </svg>
        </span>
        {expanded && <span className="text-xs">{label}</span>}
      </button>
      {menuOpen && (
        <div
          role="menu"
          className={
            "absolute left-full z-40 ml-2 w-40 " + (first ? "top-0 " : "bottom-0 ") +
            "overflow-hidden rounded-md border border-card-strong bg-surface-elevated py-1 shadow-xl"
          }
        >
          <button
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              openHire(hirePath);
            }}
            className={item + " text-ink"}
          >
            ✨ Hire with AI
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              openEditor(newWorkerDraft(hirePath, hireEveryday));
            }}
            className={item + " text-ink-muted hover:text-ink"}
          >
            Add by hand
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              void importFromFile({
                projectPath: hirePath,
                projectPaths: projects.map((project) => project.path),
              });
            }}
            className={item + " text-ink-muted hover:text-ink"}
          >
            Import…
          </button>
          {/* A team can hire its own members, so it needs nobody hired first. */}
          {crewSize >= 1 && (
            <>
              <div className="my-1 h-px bg-card" />
              <button
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  openTeamEditor(null);
                }}
                className={item + " text-ink-muted hover:text-ink"}
              >
                New team…
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/// The occasional whole-crew views, as one row of icons (a 2-up grid on the
/// collapsed rail) rather than a labelled row each: they are places you
/// check, not the crew, and five full rows of them pushed the crew off the
/// rail. Funds is also a meter across the top, so spend is visible without
/// a number on screen; Away is a strip of its own only while you are away,
/// the one time it matters.
function RailFooter({ expanded, onToggleExpanded }: { expanded: boolean; onToggleExpanded: () => void }) {
  const onWorkers = useStore((s) => s.detailMode === "workers");
  const storeView = useWorkersStore((s) => s.view);
  const view = onWorkers ? storeView : null;
  const showCalendar = useWorkersStore((s) => s.showCalendar);
  const showFunds = useWorkersStore((s) => s.showFunds);
  const showReport = useWorkersStore((s) => s.showReport);
  const allocation = useWorkersStore((s) => s.allocation);
  const away = useWorkersStore((s) => s.away);
  const starved = allocation ? starvedCount(allocation) : 0;
  const fundsTitle = allocation
    ? `Funds · $${allocation.spentUSD.toFixed(2)} of $${allocation.poolUSD.toFixed(0)} spent this month${
        starved > 0 ? ` · ${starved} worker(s) unfunded` : ""
      }`
    : "";
  return (
    <div className="flex flex-col gap-1.5">
      {allocation && (
        <FundsMeter
          spent={allocation.spentUSD}
          pool={allocation.poolUSD}
          expanded={expanded}
          title={fundsTitle}
          onClick={showFunds}
        />
      )}
      {away && <AwayButton expanded={expanded} variant="strip" />}
      <div className={expanded ? "flex items-center gap-0.5" : "grid grid-cols-2 justify-items-center gap-0.5"}>
        {!away && <AwayButton expanded={expanded} variant="icon" />}
        <FooterIcon
          label="Shifts"
          title="Shifts · when every worker's shifts fall, this week"
          active={view === "calendar"}
          onClick={showCalendar}
          icon={<CalendarIcon />}
        />
        {allocation && (
          <FooterIcon
            label="Funds"
            title={fundsTitle}
            active={view === "funds"}
            onClick={showFunds}
            icon={<PotIcon />}
            badge={starved > 0 ? <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-amber-400" /> : null}
          />
        )}
        <FooterIcon
          label="Report"
          title="Report · shifts, outcomes, tokens and time across the roster"
          active={view === "report"}
          onClick={showReport}
          icon={<ReportIcon />}
        />
        <FooterIcon
          label={expanded ? "Collapse the rail" : "Show names"}
          title={expanded ? "Collapse the rail" : "Show names"}
          active={false}
          onClick={onToggleExpanded}
          icon={<RailToggleIcon />}
          className={expanded ? "ml-auto" : ""}
        />
      </div>
    </div>
  );
}

function FooterIcon({
  label,
  title,
  active,
  onClick,
  icon,
  badge,
  className = "",
}: {
  label: string;
  title: string;
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  badge?: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className={
        "relative flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md border border-transparent " +
        "focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 " +
        (active ? "sidebar-row-selected text-ink " : "text-ink-faint hover:bg-card-strong hover:text-ink ") +
        className
      }
    >
      {icon}
      {badge}
    </button>
  );
}

/// This month's spend against the pool, as a bar: quiet while there is room,
/// amber near the end, red past it. The figure is in the tooltip, and the
/// expanded rail adds it as text.
function FundsMeter({
  spent,
  pool,
  expanded,
  title,
  onClick,
}: {
  spent: number;
  pool: number;
  expanded: boolean;
  title: string;
  onClick: () => void;
}) {
  const share = pool > 0 ? spent / pool : spent > 0 ? 1 : 0;
  const fill = share >= 1 ? "bg-red-500" : share >= 0.8 ? "bg-amber-400" : "bg-emerald-500/70";
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="group flex w-full items-center gap-2 rounded px-1.5 py-1 hover:bg-card-strong"
    >
      <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-card-strong">
        <span className={"block h-full rounded-full " + fill} style={{ width: `${Math.min(100, Math.max(share > 0 ? 3 : 0, share * 100))}%` }} />
      </span>
      {expanded && (
        <span className="shrink-0 text-[10px] tabular-nums text-ink-faint group-hover:text-ink-muted">
          ${spent.toFixed(0)} / ${pool.toFixed(0)}
        </span>
      )}
    </button>
  );
}

/// Away mode: the whole crew off duty while you are. One switch rather than
/// pausing each worker, so coming back restores the roster exactly as you
/// left it. The menu offers the returns people actually mean; any other date
/// is picked on the banner the Workers pane shows while you are away.
function AwayButton({ expanded, variant }: { expanded: boolean; variant: "icon" | "strip" }) {
  const away = useWorkersStore((s) => s.away);
  const goAway = useWorkersStore((s) => s.goAway);
  const comeBack = useWorkersStore((s) => s.comeBack);
  const now = useTickingNow(60_000);
  const anchor = useRef<HTMLDivElement>(null);
  // Opened beside the rail rather than below it — the rail is too narrow to
  // hold a menu, and the footer is too near the bottom to open downward.
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const returns: MenuItemDef[] = [
    { label: "Until I'm back", hint: "Come back by hand", onSelect: () => void goAway() },
    { label: "Back tomorrow morning", onSelect: () => void goAway(morningAfter(Date.now(), 1)) },
    { label: "Back Monday morning", onSelect: () => void goAway(nextMondayMorning(Date.now())) },
    { label: "Back in a week", onSelect: () => void goAway(morningAfter(Date.now(), 7)) },
  ];
  const items: MenuItemDef[] = away
    ? [
        { label: "I'm back", hint: "Shifts restart from now", onSelect: () => void comeBack() },
        { label: "Change return", divider: true, onSelect: () => {} },
        ...returns,
      ]
    : returns;
  const openMenu = () => {
    if (at) return setAt(null);
    const r = anchor.current?.getBoundingClientRect();
    if (r) setAt({ x: r.right + 6, y: r.top });
  };
  return (
    <div ref={anchor} className={variant === "strip" ? "w-full" : ""}>
      {variant === "strip" && away ? (
        // While you are away it says so, with the way back one click on.
        <button
          type="button"
          onClick={openMenu}
          title={`${awayLine(away, now)} — no shifts start and handoffs wait`}
          aria-label={awayLine(away, now)}
          className={
            "flex w-full items-center gap-2 rounded-md border border-amber-400/40 bg-amber-400/10 py-1.5 text-left text-amber-500 hover:bg-amber-400/15 " +
            (expanded ? "px-2" : "justify-center px-0")
          }
        >
          <MoonIcon />
          {expanded && (
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[11.5px] font-medium">{awayLine(away, now)}</span>
              <span className="text-[10px] text-ink-faint">Click to come back</span>
            </span>
          )}
        </button>
      ) : (
        <FooterIcon
          label="Go away"
          title="Go away · take the whole crew off duty — no shifts start while you're offline"
          active={false}
          onClick={openMenu}
          icon={<MoonIcon />}
        />
      )}
      {at && (
        <PopMenu
          anchor={anchor}
          at={at}
          heading={away ? awayLine(away, now) : "Go away"}
          headingDetail={
            away
              ? "No shifts start and handoffs wait until you're back."
              : "No shifts start and handoffs wait. Running work finishes; anything you start by hand still runs."
          }
          items={items}
          width={260}
          onClose={() => setAt(null)}
        />
      )}
    </div>
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
      ? new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
      : new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return (
    <>
      <div className="mt-2 px-2 text-[10px] uppercase tracking-wider text-ink-faint">
        Work · {matches.length}
      </div>
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
              {m.status === "failed" ? " · failed" : m.status === "cancelled" ? " · not run" : ""}
            </span>
          </button>
        ))
      )}
    </>
  );
}

function starvedCount(allocation: TreasuryAllocation): number {
  return allocation.byWorker.filter((f) => f.blocked === "pool").length;
}

const ICON = "h-4 w-4 shrink-0";

/// A pot, drawn as a pot: a rim wider than the body, and a level inside it.
/// The obvious glyph here was a dollar sign, which reads as "billing" — this
/// is a container with an amount in it, which is the actual idea.
function PotIcon() {
  return (
    <svg viewBox="0 0 14 14" aria-hidden className={ICON} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.4 4.3h9.2l-1 6.4a1.4 1.4 0 0 1-1.4 1.2H4.8a1.4 1.4 0 0 1-1.4-1.2z" />
      <path d="M1.6 4.3h10.8" />
      <path d="M4 8.4h6" opacity="0.55" />
    </svg>
  );
}

/// One node fanning out to three — a batch run side by side.
function OrchestratorIcon() {
  return (
    <svg viewBox="0 0 14 14" aria-hidden className={ICON} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
      <circle cx="7" cy="2.6" r="1.3" />
      <circle cx="2.4" cy="11.4" r="1.3" />
      <circle cx="7" cy="11.4" r="1.3" />
      <circle cx="11.6" cy="11.4" r="1.3" />
      <path d="M7 3.9v6.2M7 6.6H2.4v3.5M7 6.6h4.6v3.5" />
    </svg>
  );
}

/// A clock face with one hand. Deliberately not a calendar page — the
/// calendar icon means "which days", and this screen means "this day, by the
/// hour".
function TodayIcon() {
  return (
    <svg viewBox="0 0 14 14" aria-hidden className={ICON} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
      <circle cx="7" cy="7" r="5.2" />
      <path d="M7 4.1V7l2 1.5" />
    </svg>
  );
}

/// Three jobs stacked, the top one live.
function QueueIcon() {
  return (
    <svg viewBox="0 0 14 14" aria-hidden className={ICON} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
      <circle cx="2.6" cy="3.4" r="1.4" fill="currentColor" stroke="none" />
      <path d="M6 3.4h6.4M6 7h6.4M6 10.6h6.4M2.6 7h.01M2.6 10.6h.01" />
    </svg>
  );
}

/// A calendar leaf — two hangers, a head rule, one marked day.
function CalendarIcon() {
  return (
    <svg viewBox="0 0 14 14" aria-hidden className={ICON} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
      <rect x="1.6" y="2.8" width="10.8" height="9.6" rx="1.6" />
      <path d="M1.6 5.6h10.8M4.6 1.6v2.2M9.4 1.6v2.2" />
      <rect x="4" y="7.6" width="2.4" height="2.2" rx="0.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

/// A crescent — the crew is off for the night, or the fortnight.
function MoonIcon() {
  return (
    <svg viewBox="0 0 14 14" aria-hidden className={ICON} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round">
      <path d="M11.8 8.6A5 5 0 0 1 5.4 2.2a5 5 0 1 0 6.4 6.4Z" />
    </svg>
  );
}

/// Bars on a baseline — outcomes measured, which is what the report is.
function ReportIcon() {
  return (
    <svg viewBox="0 0 14 14" aria-hidden className={ICON} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
      <path d="M1.8 12.2h10.4" />
      <path d="M3.6 12.2V6.4M7 12.2V2.6M10.4 12.2V8.6" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 14 14" aria-hidden className={ICON} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
      <circle cx="6.2" cy="6.2" r="4" />
      <path d="M9.2 9.2l3 3" />
    </svg>
  );
}

/// A panel with its left column marked — the rail itself.
function RailToggleIcon() {
  return (
    <svg viewBox="0 0 14 14" aria-hidden className={ICON} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
      <rect x="1.4" y="2.2" width="11.2" height="9.6" rx="1.6" />
      <path d="M5 2.2v9.6" />
    </svg>
  );
}

