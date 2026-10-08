// Teams on the Workers rail: one row per team above the crew's faces, with the
// team's mark (its members' faces, stacked) and what its task needs.

import { useMemo, useState } from "react";

import { useStore } from "../../../store";
import { useTeamsStore } from "../../../teamsStore";
import { useWorkersStore } from "../../../workersStore";
import { describeTeamTaskStatus, isTaskActive, teamTaskProgress, type Team, type TeamTask } from "@shared/flows/team";
import type { Worker } from "@shared/flows/worker";
import { useWorkerColors } from "../WorkerAvatar";
import { workerColorFor } from "../workerPalette";

/// Statuses where the task is waiting on you rather than on the team.
export function taskNeedsYou(task: TeamTask | undefined): boolean {
  return !!task && (task.status === "questions" || task.status === "proposed" || task.status === "waiting" || task.status === "review");
}

/// The task a team's desk and rail row are about: the one in flight, or the
/// pack waiting for review.
export function currentTeamTask(tasks: Record<string, TeamTask>, teamId: string): TeamTask | undefined {
  return Object.values(tasks)
    .filter((t) => t.teamId === teamId && (isTaskActive(t.status) || t.status === "review"))
    .sort((a, b) => b.createdAt - a.createdAt)[0];
}

/// Team tints: separate from the worker palette, so a team never wears one
/// member's colour, and clear of the accent, which means "selected" here.
const TEAM_PALETTE = ["#2dd4bf", "#f59e0b", "#fb7185", "#38bdf8", "#a3e635", "#fb923c"];

/// A colour per team by creation order, like workers': distinct until there
/// are more teams than tints.
export function teamColorMap(teams: Team[]): Record<string, string> {
  const out: Record<string, string> = {};
  teams
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .forEach((t, i) => {
      out[t.id] = TEAM_PALETTE[i % TEAM_PALETTE.length];
    });
  return out;
}

/// A team's mark: a soft filled square — workers are rings, so shape and
/// fill alone say "team" — the size of a worker's face, holding its members
/// as dots in their own colours. Up to four; three sit as a triangle rather
/// than a grid with a hole in it. No border of its own: the rail's selection
/// is the only frame, so a selected team is not a box in a box.
export function TeamMark({
  team,
  tint,
  progress,
}: {
  team: Team;
  tint: string;
  /// Stages done out of all, while the team is working.
  progress?: number;
}) {
  const workers = useWorkersStore((s) => s.workers);
  const colors = useWorkerColors();
  const faces = team.members.map((m) => workers[m.workerId]).filter((w): w is Worker => !!w);
  const shown = faces.length > 4 ? faces.slice(0, 3) : faces;
  const more = faces.length - shown.length;
  return (
    <span className="relative flex h-8 w-8 shrink-0" aria-hidden>
      <span
        className="flex h-8 w-8 flex-wrap content-center items-center justify-center gap-[3px] rounded-[10px] px-[6px]"
        style={{
          background: `color-mix(in srgb, ${tint} 22%, var(--c-surface-muted))`,
          boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${tint} 30%, transparent)`,
        }}
      >
        {shown.map((w) => (
          <span key={w.id} className="h-2 w-2 rounded-full" style={{ background: workerColorFor(colors, w.id) }} />
        ))}
        {more > 0 && <span className="text-[8px] font-semibold leading-none text-ink-muted">+{more}</span>}
      </span>
      {progress !== undefined && (
        <span className="absolute -bottom-1.5 left-1 right-1 h-[3px] overflow-hidden rounded-full bg-card-strong">
          <span className="block h-full rounded-full" style={{ width: `${Math.round(progress * 100)}%`, background: tint }} />
        </span>
      )}
    </span>
  );
}

/// Which teams have their members open on the expanded rail. A preference
/// about this machine's rail, not data: lost storage just closes them.
const OPEN_KEY = "overcli.railTeamsOpen";

function readOpen(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(OPEN_KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}

export function TeamRailSection({
  expanded,
  renderMembers,
  forceOpen,
}: {
  expanded: boolean;
  /// The team's members as rail rows, under it when it is open. Absent on the
  /// collapsed rail: 64px has no room for a nested list.
  renderMembers?: (team: Team) => React.ReactNode;
  /// Teams to show open whatever the stored choice — the one holding the
  /// worker on screen, so it is never hidden inside a closed team.
  forceOpen?: Set<string>;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>(readOpen);
  const toggleOpen = (id: string) =>
    setOpen((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try {
        localStorage.setItem(OPEN_KEY, JSON.stringify(next));
      } catch {
        // best-effort
      }
      return next;
    });
  const teams = useTeamsStore((s) => s.teams);
  const tasks = useTeamsStore((s) => s.tasks);
  const view = useWorkersStore((s) => s.view);
  const selectedTeamId = useWorkersStore((s) => s.selectedTeamId);
  const selectTeam = useWorkersStore((s) => s.selectTeam);
  const onWorkers = useStore((s) => s.detailMode === "workers");
  const list = useMemo(() => Object.values(teams).sort((a, b) => a.createdAt - b.createdAt), [teams]);
  const tints = useMemo(() => teamColorMap(Object.values(teams)), [teams]);
  if (list.length === 0) return null;

  return (
    <>
      {expanded && (
        <div className="px-2 pb-0.5 text-[10px] uppercase tracking-wider text-ink-faint">Teams</div>
      )}
      {list.map((team) => {
        const task = currentTeamTask(tasks, team.id);
        const status = task ? describeTeamTaskStatus(task) : "Ready for a task";
        const needsYou = taskNeedsYou(task);
        const active = onWorkers && view === "team" && selectedTeamId === team.id;
        const members = expanded && renderMembers ? renderMembers(team) : null;
        const isOpen = !!members && (!!open[team.id] || !!forceOpen?.has(team.id));
        return (
          <div key={team.id} className="flex flex-col">
          <div className="relative">
          <button
            type="button"
            onClick={() => selectTeam(team.id)}
            title={`${team.name} · ${status}`}
            aria-label={expanded ? undefined : `${team.name}, ${status}`}
            aria-current={active ? "page" : undefined}
            className={
              "flex min-h-[44px] w-full items-center gap-2.5 rounded-md border border-transparent py-1.5 text-left " +
              (expanded ? "px-2 " : "justify-center px-0 ") +
              "focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 " +
              (active ? "sidebar-row-selected text-ink" : "text-ink-muted hover:bg-card-strong hover:text-ink")
            }
          >
            <span className="relative">
              <TeamMark
                team={team}
                tint={tints[team.id]}
                progress={
                  task?.status === "running" && task.stages.length > 0
                    ? teamTaskProgress(task).done / task.stages.length
                    : undefined
                }
              />
              {/* Where a worker's status dot sits, ringed in the rail's colour. */}
              {needsYou && (
                <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[color:var(--c-surface-muted)] bg-violet-400" />
              )}
            </span>
            {expanded && (
              <span className={"flex min-w-0 flex-col " + (members ? "pr-6" : "")}>
                <span className="truncate text-xs">{team.name}</span>
                <span className={"truncate text-[10.5px] " + (needsYou ? "text-violet-400" : "text-ink-faint")}>
                  {status}
                </span>
              </span>
            )}
          </button>
          {members && (
            <button
              type="button"
              onClick={() => toggleOpen(team.id)}
              aria-expanded={isOpen}
              aria-label={`${isOpen ? "Hide" : "Show"} ${team.name}'s members`}
              title={isOpen ? "Hide members" : "Show members"}
              className="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-ink-faint hover:bg-card-strong hover:text-ink"
            >
              <svg width="10" height="10" viewBox="0 0 16 16" aria-hidden className={"transition-transform " + (isOpen ? "rotate-90" : "")}>
                <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
          )}
          </div>
          {isOpen && <div className="mb-1 ml-5 flex flex-col gap-px border-l border-card pl-1.5">{members}</div>}
          </div>
        );
      })}
      <div className="mx-1 my-1.5 h-px shrink-0 bg-card" />
    </>
  );
}

/// The rail's own way in to a new team, under "Hire a worker". Always there:
/// a team can hire its own members, so it needs nobody hired first.
export function NewTeamButton({ expanded }: { expanded: boolean }) {
  const openTeamEditor = useWorkersStore((s) => s.openTeamEditor);
  const editing = useTeamsStore((s) => s.editor?.teamId === null);
  return (
    <button
      type="button"
      onClick={() => openTeamEditor(null)}
      title="Make a team — from your crew, new hires, or both — and give it a task to finish together"
      aria-label={expanded ? undefined : "New team"}
      aria-current={editing ? "page" : undefined}
      className={
        "flex min-h-[44px] w-full items-center gap-2.5 rounded-md py-1.5 text-left " +
        "focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 " +
        (editing ? "sidebar-row-selected text-ink " : "text-ink-muted hover:bg-card-strong hover:text-ink ") +
        (expanded ? "px-2" : "justify-center px-0")
      }
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-[1.5px] border-dashed border-card-strong">
        <svg viewBox="0 0 16 16" aria-hidden className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <circle cx="5.5" cy="6" r="2" />
          <circle cx="10.5" cy="6" r="2" />
          <path d="M2 12.5c.6-1.8 2-2.6 3.5-2.6s2.9.8 3.5 2.6M8.5 10.3c.5-.3 1.2-.4 2-.4 1.5 0 2.9.8 3.5 2.6" />
        </svg>
      </span>
      {expanded && <span className="text-xs">New team</span>}
    </button>
  );
}
