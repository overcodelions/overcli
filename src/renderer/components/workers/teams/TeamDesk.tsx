// A team's desk: brief it, answer its questions, approve its plan, watch the
// stages land in the shared folder, and read the finished pack.
//
// Everything on screen is what main last pushed (teamsStore); the buttons are
// requests, and the task re-renders when main says it moved.

import { useEffect, useMemo, useRef, useState } from "react";
import { ShortNameChip, teamShortNames } from "../ShortNameField";
import { OrgNudge } from "../OrgNudge";

import { Markdown } from "../../Markdown";
import { Composer } from "../../Composer";
import { useStore } from "../../../store";
import type { Attachment } from "@shared/types";
import { useTickingNow } from "../../../hooks";
import { useFlowsStore } from "../../../flowsStore";
import { useTeamsStore } from "../../../teamsStore";
import { useWorkersStore } from "../../../workersStore";
import {
  TEAM_MAX_STAGES,
  TEAM_STAGE_LABEL,
  blocksNewTask,
  describeTeamCheckpoints,
  canSkipStage,
  describeTeamTaskStatus,
  isHireKey,
  isMemberStage,
  isReadableInDesk,
  isTaskActive,
  resolveTaskFileRef,
  handoffSteps,
  rolloverReason,
  teamTaskProgress,
  unhired,
  type Team,
  type TeamPlanHire,
  type TeamAssignment,
  type TeamStage,
  type TeamStageKind,
  type TeamMessage,
  type TeamTask,
  type TeamComment,
} from "@shared/flows/team";
import { WorkerAvatar } from "../WorkerAvatar";
import { workerTagline } from "@shared/flows/worker";
import { currentTeamTask } from "./TeamRail";
import { folderSections, packChangeCard, pieceGroups, type FolderItem, type PieceGroup } from "./folderView";
import { ProjectSelect, projectName, useProjectOptions } from "./ProjectChoice";
import { exchangeOutcome, groupExchanges, plainLine, type Exchange } from "./roomView";
import {
  COORDINATOR_LANE,
  briefOpening,
  cellLabel,
  chipState,
  defaultCell,
  nextTab,
  pieceIn,
  foldedLaneLabel,
  openRound,
  planLayout,
  planRounds,
  planStatus,
  roundName,
  roundOf,
  roleTitle,
  shortDuration,
  stageMs,
  stageWhen,
  taskStatusPill,
  type ChipState,
  type PlanCell,
  type PlanColumn,
  type PlanRound,
} from "./planView";
import { CommentButton, CommentGlyph, CommentPopover, CommentsPanel, FileComments } from "./TaskComments";
import { parseWrapUp, splitOwner } from "@shared/flows/teamWrapUp";
import {
  canKeepDebating,
  canUpdatePack,
  defaultTaskTab,
  latestWrapUp,
  replyCount,
  replyGist,
  repliesTo,
  unfoldedExchanges,
  yourTurn,
  type LandedWrapUp,
  type TaskTabId,
  type TurnAction,
  type TurnBand,
} from "./landedView";
import { canRedoPiece, commentsByPiece, pieceKey } from "./commentView";

const primaryBtn = "text-xs px-3 py-1.5 rounded-md bg-accent text-white hover:opacity-90 disabled:opacity-40";
const secondaryBtn =
  "text-xs px-3 py-1.5 rounded-md border border-card-strong text-ink hover:bg-card-strong disabled:opacity-40";
const quietBtn = "text-xs px-2 py-1 rounded-md text-ink-muted hover:bg-card-strong hover:text-ink disabled:opacity-40";

const money = (n: number) => `$${n.toFixed(2)}`;

export function TeamDesk({
  teamId,
  taskId,
}: {
  teamId: string | null;
  /// Open on this task rather than the team's current one (Today's reader
  /// opening a team task). The way back from another task returns here.
  taskId?: string;
}) {
  const team = useTeamsStore((s) => (teamId ? s.teams[teamId] : undefined));
  const allTeams = useTeamsStore((s) => s.teams);
  const shortName = useMemo(() => (teamId ? teamShortNames(allTeams).get(teamId) : undefined), [allTeams, teamId]);
  const tasks = useTeamsStore((s) => s.tasks);
  const openTeamEditor = useWorkersStore((s) => s.openTeamEditor);
  const workers = useWorkersStore((s) => s.workers);
  const projectOptions = useProjectOptions();
  const orgAlpha = useStore((s) => s.settings.orgAlpha ?? false);
  const openSheet = useStore((s) => s.openSheet);
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState<{ ok: boolean; text: string; signIn?: boolean } | null>(null);
  const current = team ? currentTeamTask(tasks, team.id) : undefined;
  const past = useMemo(
    () =>
      team
        ? Object.values(tasks)
            .filter((t) => t.teamId === team.id && t.id !== current?.id)
            .sort((a, b) => b.createdAt - a.createdAt)
        : [],
    [tasks, team, current?.id],
  );
  const home = taskId ?? null;
  const [pickedTaskId, setPickedTaskId] = useState<string | null>(home);
  const [viewing, setViewing] = useState<string | null>(null);
  /// A passage to bring into view in the open file: a comment opened from
  /// the list. `n` changes on every open, so the same one scrolls again.
  const [focusQuote, setFocusQuote] = useState<{ quote: string; n: number } | null>(null);
  /// Writing a new brief while another task is still on the desk.
  const [composing, setComposing] = useState(false);
  /// The members' stack in the header, opened to who they are.
  const [crewOpen, setCrewOpen] = useState(false);
  // A new current task (you just briefed one) takes the desk back.
  useEffect(() => {
    setPickedTaskId(home);
    setViewing(null);
    setComposing(false);
  }, [current?.id, teamId, home]);

  if (!team) {
    return <div className="px-6 pt-6 text-sm text-ink-muted">That team no longer exists. Pick another from the rail.</div>;
  }
  const shown = composing ? undefined : (pickedTaskId && tasks[pickedTaskId]) || current;
  // A task with a pack is read in tabs (pack, conversation, how it was made),
  // which carry their own way back so it stays beside the tabs.
  const tabbed = !viewing && !!shown && packIsOut(shown);
  const busyWith = Object.values(tasks).find((t) => t.teamId === team.id && blocksNewTask(t));
  const briefing = composing || (!current && !pickedTaskId);
  // Every file name on the desk goes through here — a pack card, a piece, a
  // chip in a member's reply. Documents open in place; a design page opens
  // in your browser, where its links to the other pages work.
  const openFile = (ref: string) => {
    if (!shown) return;
    const name = resolveTaskFileRef(shown.files.map((f) => f.name), ref);
    if (!name) {
      useTeamsStore.setState((s) => ({
        errors: { ...s.errors, [shown.id]: `"${ref}" isn't in the shared folder.` },
      }));
      return;
    }
    setFocusQuote(null);
    if (isReadableInDesk(name)) setViewing(name);
    else void useTeamsStore.getState().openFile(shown.id, name);
  };
  // The org's server: members it doesn't have go up first, then the team;
  // published again, it's updated there.
  const publish = () => {
    setPublishing(true);
    setPublished(null);
    void window.overcli
      .invoke("org:publishTeam", { id: team.id })
      .then((res) => setPublished(res.ok ? { ok: true, text: res.message } : { ok: false, text: res.error, signIn: res.signIn }))
      .finally(() => setPublishing(false));
  };
  const openComment = (c: TeamComment) => {
    if (!c.file) return;
    openFile(c.file);
    if (c.quote && isReadableInDesk(c.file)) setFocusQuote({ quote: c.quote, n: Date.now() });
  };

  return (
    // min-w-0: it sits in a row beside Today's list, and a flex item would
    // otherwise grow to its widest line (a long round's one-line ask) and push
    // everything past the window's edge.
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-col gap-2.5 border-b border-card px-6 pb-3 pt-5">
        <div className="flex flex-wrap items-center gap-3.5">
          <div className="flex min-w-0 flex-[1_1_420px] flex-col gap-0.5">
            <div className="flex min-w-0 items-baseline gap-2.5">
              <h1 className="truncate text-[19px] font-semibold tracking-tight text-ink">{team.name}</h1>
              {shortName && <ShortNameChip command="/team" short={shortName} />}
              <span className="shrink-0 text-xs text-ink-faint">
                team{team.projectPath ? ` · works in ${projectName(projectOptions, team.projectPath)}` : ""}
              </span>
            </div>
            {team.purpose && (
              <div className="truncate text-[12.5px] text-ink-muted" title={team.purpose}>
                {team.purpose}
              </div>
            )}
          </div>
          {/* While briefing, the members get cards of their own below; on a
              task they fold into a stack that opens to the same. */}
          {!briefing && team.members.length > 0 && (
            <button
              className="inline-flex shrink-0 items-center gap-2 rounded-full border border-card py-1 pl-1 pr-2.5 hover:bg-card-strong"
              aria-expanded={crewOpen}
              aria-controls="team-crew"
              onClick={() => setCrewOpen((v) => !v)}
            >
              <span className="flex">
                {team.members.slice(0, 6).map((m, i) => {
                  const w = workers[m.workerId];
                  return (
                    <span key={m.workerId} className={"flex rounded-full ring-2 ring-surface " + (i ? "-ml-1.5" : "")}>
                      {w ? <WorkerAvatar worker={w} size="sm" untitled /> : <span className="h-6 w-6 rounded-full bg-card-strong" />}
                    </span>
                  );
                })}
              </span>
              <span className="text-xs text-ink-muted">
                {team.members.length} member{team.members.length === 1 ? "" : "s"}
              </span>
              <svg aria-hidden width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-ink-faint">
                <path d={crewOpen ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"} />
              </svg>
            </button>
          )}
          <div className="flex shrink-0 items-center gap-1.5">
            {!briefing && (
              <button
                className={primaryBtn}
                disabled={!!busyWith}
                title={
                  busyWith
                    ? `The team is still on "${busyWith.title ?? busyWith.brief}". Finish or cancel it first.`
                    : "Brief the team on something new. This task stays in the list."
                }
                onClick={() => {
                  setComposing(true);
                  setPickedTaskId(null);
                  setViewing(null);
                }}
              >
                New task
              </button>
            )}
            <TeamMenu
              items={[
                { label: "Edit team", onSelect: () => openTeamEditor(team.id) },
                ...(orgAlpha
                  ? [
                      {
                        label: publishing ? "Publishing…" : "Publish to your org",
                        title: "Put this team and its members on your org's server, where people can give it work from the console, Slack or Claude.",
                        disabled: publishing,
                        onSelect: publish,
                      },
                    ]
                  : []),
              ]}
            />
          </div>
        </div>
        {crewOpen && !briefing && (
          <div id="team-crew" className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-2 rounded-xl border border-card bg-surface-elevated p-2.5">
            {team.members.map((m) => {
              const w = workers[m.workerId];
              const does = m.role?.trim() || (w ? workerTagline(w) : "");
              return (
                <div key={m.workerId} className="flex min-w-0 items-start gap-2.5 px-1 py-0.5">
                  {w ? <WorkerAvatar worker={w} size="sm" /> : <span className="h-6 w-6 shrink-0 rounded-full bg-card-strong" />}
                  <span className="flex min-w-0 flex-col">
                    <b className="truncate text-[13px] font-semibold text-ink">{w?.name ?? "Gone"}</b>
                    {does && (
                      <span className="truncate text-xs text-ink-faint" title={does}>
                        {does}
                      </span>
                    )}
                  </span>
                </div>
              );
            })}
            <span className="col-span-full flex gap-4 px-1 text-xs">
              <button className="text-accent hover:underline" onClick={() => openTeamEditor(team.id)}>
                Edit team
              </button>
              {orgAlpha && (
                <button className="text-accent hover:underline disabled:opacity-40" disabled={publishing} onClick={publish}>
                  {publishing ? "Publishing…" : "Publish to your org"}
                </button>
              )}
            </span>
          </div>
        )}
      </header>
      {!orgAlpha && (
        <div className="px-6">
          <OrgNudge id="share-team">
            Want people across your company to give {team.name} work? Put it on your org&apos;s server, and they can from Slack, Claude or the web.
          </OrgNudge>
        </div>
      )}
      {published && (
        <div role="status" className={"flex items-center gap-2 px-6 pb-3 text-[11.5px] " + (published.ok ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300")}>
          <span>{published.text}</span>
          {published.signIn && (
            <button className="text-accent hover:underline" onClick={() => openSheet({ type: "settings", section: "org" })}>
              Open Settings
            </button>
          )}
          <button className="ml-auto text-ink-faint hover:text-ink" aria-label="Dismiss" onClick={() => setPublished(null)}>
            ×
          </button>
        </div>
      )}

      {/* Two columns that scroll on their own when there is room for both,
          so the shared folder stays beside a long conversation. On a narrow
          window they stack and scroll as one page. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
        <main
          className={
            "flex min-w-0 flex-col gap-6 px-6 lg:min-h-0 lg:flex-1 lg:overflow-y-auto " +
            // The conversation's composer sticks to the bottom edge; padding
            // there would leave a strip of scrolling text under it.
            (tabbed ? "pb-0" : "pb-6")
          }
        >
          {/* The way back stays on screen however far down you read: it is
              the one control you need at the end of a long file or debate. */}
          {composing ? (
            <div className="sticky top-0 z-10 -mx-6 flex min-w-0 items-center gap-2 border-b border-card bg-surface/95 px-6 py-2 backdrop-blur">
              <button className={quietBtn + " shrink-0"} onClick={() => setComposing(false)}>
                ← Back to the current task
              </button>
            </div>
          ) : tabbed ? null : (viewing || pickedTaskId) && shown ? (
            <div className="sticky top-0 z-10 -mx-6 flex min-w-0 items-center gap-2 border-b border-card bg-surface/95 px-6 py-2 backdrop-blur">
              <button
                className={quietBtn + " shrink-0"}
                onClick={() => (viewing ? setViewing(null) : setPickedTaskId(null))}
              >
                ← {viewing ? "Back to the task" : current ? "Back to the current task" : "All tasks"}
              </button>
              <span className="min-w-0 truncate text-xs text-ink-faint">
                {shown.title ?? shown.brief}
                {viewing && <span className="font-mono text-ink-muted"> / {viewing}</span>}
              </span>
            </div>
          ) : (
            <div className="h-0" />
          )}
          {viewing && shown ? (
            <FileViewer task={shown} name={viewing} onOpenFile={openFile} focus={focusQuote} />
          ) : shown && tabbed ? (
            <PackTabs
              key={shown.id}
              task={shown}
              team={team}
              onOpenFile={openFile}
              back={
                pickedTaskId && pickedTaskId !== home
                  ? {
                      label: home ? "Back" : current ? "Back to the current task" : "All tasks",
                      onClick: () => setPickedTaskId(home),
                    }
                  : undefined
              }
            />
          ) : shown ? (
            <TaskView task={shown} team={team} onOpenFile={openFile} />
          ) : null}
          {briefing && (
            <>
              <MemberCards team={team} />
              <BriefComposer team={team} first={past.length === 0 && !current} onEditTeam={() => openTeamEditor(team.id)} />
              <StageKinds />
            </>
          )}
          {!shown && !composing && past.length > 0 && (
            <PastTasks
              tasks={past}
              onOpen={(id) => {
                setPickedTaskId(id);
                setViewing(null);
              }}
              onOpenFile={(id, name) => {
                setPickedTaskId(id);
                if (isReadableInDesk(name)) setViewing(name);
                else {
                  setViewing(null);
                  void useTeamsStore.getState().openFile(id, name);
                }
              }}
            />
          )}
        </main>

        {/* The side column is the open task's: its folder and the other
            tasks. With no task open the main column has the whole width. */}
        {shown && (
          <aside className="flex min-w-0 shrink-0 flex-col gap-4 border-t border-card px-5 py-5 lg:min-h-0 lg:w-[300px] lg:overflow-y-auto lg:border-l lg:border-t-0">
            <FolderPanel task={shown} viewing={viewing} onOpen={openFile} />
            <CommentsPanel task={shown} onOpenComment={openComment} />
            {/* While a task is open, the others stay one click away. With none
                open they are the main column's list instead. */}
            {past.length > 0 && (
              <div className="flex flex-col gap-1">
                <h3 className="text-xs font-semibold text-ink">Other tasks</h3>
                {past.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => {
                      setPickedTaskId(t.id);
                      setViewing(null);
                    }}
                    className={
                      "flex flex-col rounded-md px-2 py-1.5 text-left hover:bg-card-strong " +
                      (pickedTaskId === t.id ? "bg-card-strong" : "")
                    }
                  >
                    <span className="line-clamp-2 text-xs leading-snug text-ink">{t.title ?? t.brief}</span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-ink-faint">
                      <TaskStatusDot status={t.status} />
                      {describeTeamTaskStatus(t)} · {relativeDay(t.finishedAt ?? t.createdAt)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

/// The header's ⋯: what you do to the team rather than to a task.
function TeamMenu({ items }: { items: Array<{ label: string; title?: string; disabled?: boolean; onSelect: () => void }> }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !btn.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btn.current?.focus();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const all = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
        const at = all.indexOf(document.activeElement as HTMLButtonElement);
        const next = all[(at + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length];
        if (next) {
          e.preventDefault();
          next.focus();
        }
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="relative">
      <button
        ref={btn}
        className={secondaryBtn + " px-2"}
        aria-label="More team actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="5" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="19" cy="12" r="1.8" />
        </svg>
      </button>
      {open && (
        <div
          ref={menu}
          role="menu"
          className="absolute right-0 top-full z-30 mt-1 flex min-w-[180px] flex-col rounded-lg border border-card bg-surface-elevated p-1 shadow-xl"
        >
          {items.map((it) => (
            <button
              key={it.label}
              role="menuitem"
              title={it.title}
              disabled={it.disabled}
              className="rounded-md px-2.5 py-1.5 text-left text-xs text-ink hover:bg-card-strong focus:bg-card-strong focus:outline-none disabled:opacity-40"
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/// The team's finished work, as the main column's list when no task is open.
/// Each row says what came of it — the verdict, the pack, the cost — so you
/// can tell tasks apart without opening each one. The title opens the task;
/// each pack file opens that file.
function PastTasks({
  tasks,
  onOpen,
  onOpenFile,
}: {
  tasks: TeamTask[];
  onOpen: (id: string) => void;
  onOpenFile: (id: string, name: string) => void;
}) {
  return (
    <section className="flex flex-col gap-2.5">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">Past tasks</h2>
      <div className="flex flex-col divide-y divide-card overflow-hidden rounded-xl border border-card bg-surface-elevated">
        {tasks.map((t) => {
          const packFiles = t.pack?.files ?? [];
          const verdict = firstLine(t.pack?.summary ?? t.error ?? "");
          const messages = t.room?.messages.length ?? 0;
          return (
            <div key={t.id} className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3.5">
              <div className="flex min-w-0 flex-[999_1_420px] flex-col gap-1.5">
                <span className="flex items-center gap-2 text-[11px] text-ink-faint">
                  <TaskStatusDot status={t.status} />
                  <span className={t.status === "review" ? "text-violet-600 dark:text-violet-400" : ""}>{describeTeamTaskStatus(t)}</span>
                  <span>· {relativeDay(t.finishedAt ?? t.createdAt)}</span>
                  {t.pack?.version && t.pack.version > 1 && <span>· pack v{t.pack.version}</span>}
                </span>
                <button
                  onClick={() => onOpen(t.id)}
                  className="self-start text-left text-sm font-semibold leading-snug text-ink hover:underline focus:outline-none focus-visible:underline"
                >
                  {t.title ?? t.brief}
                </button>
                {verdict && <span className="line-clamp-2 text-xs leading-relaxed text-ink-muted">{verdict}</span>}
                {packFiles.length > 0 && (
                  <span className="flex flex-wrap gap-1.5">
                    {packFiles.slice(0, 6).map((f) => (
                      <button
                        key={f}
                        onClick={() => onOpenFile(t.id, f)}
                        className="rounded border border-card bg-card px-1.5 py-0.5 font-mono text-[10.5px] text-ink-muted hover:border-card-strong hover:text-ink"
                      >
                        {f.replace(/^pack\//, "")}
                      </button>
                    ))}
                    {packFiles.length > 6 && (
                      <button className="text-[10.5px] text-ink-faint hover:text-ink" onClick={() => onOpen(t.id)}>
                        +{packFiles.length - 6}
                      </button>
                    )}
                  </span>
                )}
              </div>
              <div className="flex flex-auto justify-end gap-6 text-[11px] text-ink-faint">
                {t.spentUSD > 0 && <RowStat value={money(t.spentUSD)} label={`of ${money(t.budgetUSD)}`} />}
                {t.stages.length > 0 && <RowStat value={String(t.stages.length)} label={t.stages.length === 1 ? "stage" : "stages"} />}
                {messages > 0 && <RowStat value={String(messages)} label={messages === 1 ? "message" : "messages"} />}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function RowStat({ value, label }: { value: string; label: string }) {
  return (
    <span className="flex flex-col items-end">
      <span className="text-sm tabular-nums text-ink">{value}</span>
      {label}
    </span>
  );
}

/// Who is on the team and what each one does on it: the role you gave them
/// here, else the opening of their job description, which is what the
/// coordinator plans from when there is no role.
function MemberCards({ team }: { team: Team }) {
  const workers = useWorkersStore((s) => s.workers);
  return (
    <section aria-label="Members" className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2.5">
      {team.members.map((m) => {
        const w = workers[m.workerId];
        const does = m.role?.trim() || (w ? workerTagline(w) : "");
        return (
          <div key={m.workerId} className="flex min-w-0 items-center gap-3 rounded-xl border border-card bg-surface-elevated px-3.5 py-3">
            {w && <WorkerAvatar worker={w} size="md" />}
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium text-ink">{w?.name ?? "Gone"}</span>
              {does ? (
                <span className="truncate text-xs text-ink-muted" title={does}>
                  {does}
                </span>
              ) : null}
            </span>
          </div>
        );
      })}
    </section>
  );
}

function TaskStatusDot({ status }: { status: TeamTask["status"] }) {
  const tone =
    status === "done"
      ? "bg-emerald-500"
      : status === "review" || status === "questions" || status === "proposed" || status === "waiting"
        ? "bg-violet-400"
        : status === "failed"
          ? "bg-amber-500"
          : status === "cancelled"
            ? "bg-ink-faint"
            : "animate-pulse bg-accent";
  return <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone}`} />;
}

/// The summary's opening sentence, without Markdown emphasis — a card line,
/// not a document.
function firstLine(text: string): string {
  const clean = text.replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim();
  const sentence = clean.match(/^.{20,}?[.!?](\s|$)/)?.[0] ?? clean;
  return sentence.trim();
}

function relativeDay(ts: number): string {
  const day = (t: number) => new Date(new Date(t).toDateString()).getTime();
  const diff = Math.round((day(Date.now()) - day(ts)) / 86_400_000);
  if (diff === 0) return `today ${new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  if (diff === 1) return "yesterday";
  if (diff < 7) return new Date(ts).toLocaleDateString([], { weekday: "long" });
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}

function BriefComposer({ team, first, onEditTeam }: { team: Team; first: boolean; onEditTeam: () => void }) {
  const brief = useTeamsStore((s) => s.brief);
  const busy = useTeamsStore((s) => !!s.busy[team.id]);
  const error = useTeamsStore((s) => s.errors[team.id]);
  const rootPath = useWorkersStore((s) => s.workers[team.members[0]?.workerId ?? ""]?.projectPath);
  const draftKey = `team-brief:${team.id}`;
  // The team's project by default; one task can work somewhere else.
  const [workIn, setWorkIn] = useState(team.projectPath ?? "");
  const send = useComposerSend(draftKey, (text, attachments) =>
    brief(team.id, text, attachments, workIn === (team.projectPath ?? "") ? undefined : workIn || null),
  );
  return (
    <div className="flex flex-col gap-2">
      {first && (
        <p className="text-xs leading-relaxed text-ink-muted">
          Brief the team the way you would brief people: what you want, what it's for, and what you want back at the
          end. The coordinator plans the stages for each brief, and you approve the plan before anything runs.
        </p>
      )}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-ink-muted">{first ? "The team's first task" : "Brief a new task"}</span>
        <Composer
          draftKey={draftKey}
          variant="compact"
          strongBorder
          rootPath={rootPath}
          disabled={busy}
          placeholder="Brief the team — what you want, what it's for, what you want back. Attach specs, screenshots or PDFs."
          onSend={send}
        />
        {/* What sending commits you to, where you commit to it. */}
        <span className="flex flex-wrap items-center gap-x-1 text-[11px] text-ink-faint">
          <label htmlFor={`brief-project-${team.id}`}>Works in</label>
          <ProjectSelect
            id={`brief-project-${team.id}`}
            value={workIn}
            onChange={setWorkIn}
            noneLabel="each member's own project"
            className="cursor-pointer bg-transparent font-medium text-ink-muted hover:text-ink focus:outline-none"
          />
          ·{" "}
          {describeTeamCheckpoints(team.checkpoints).join(" · ")} · up to{" "}
          <b className="font-medium text-ink-muted">{money(team.budgetUSDPerTask)}</b>
          <button className="ml-1 text-accent hover:underline" onClick={onEditTeam}>
            Change
          </button>
        </span>
      </div>
      {error && <div className="text-xs text-red-500">{error}</div>}
    </div>
  );
}

function TaskView({ task, team, onOpenFile }: { task: TeamTask; team: Team; onOpenFile: (name: string) => void }) {
  const error = useTeamsStore((s) => s.errors[task.id]);
  const approve = useTeamsStore((s) => s.approve);
  const sending = useTeamsStore((s) => !!s.busy[task.id]);
  const projectOptions = useProjectOptions();
  const band = yourTurn(task);
  const onTurn = (id: TurnAction) => {
    if (id === "approvePlan") void approve(task.id);
    else if (id === "answerQuestions") scrollToId(`task-questions-${task.id}`, true);
    else if (id === "readPlan") scrollToId(`task-plan-${task.id}`);
    else if (id === "seeWaiting") scrollToId(`task-waiting-${task.id}`);
    else if (id === "openRun") openPausedRun(band?.run);
  };
  const underWay =
    task.status === "running" ||
    task.status === "waiting" ||
    task.status === "review" ||
    task.status === "done" ||
    (task.status === "cancelled" && task.stages.length > 0);
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <span className="text-[11px] text-ink-faint">
          {describeTeamTaskStatus(task)} · started {new Date(task.createdAt).toLocaleString()}
          {task.projectPath && ` · in ${projectName(projectOptions, task.projectPath)}`}
        </span>
        <h2 className="text-xl font-semibold tracking-tight text-ink">{task.title ?? "New task"}</h2>
        <ContinuationLinks task={task} />
        {task.stages.length > 0 && (
          <div className="mt-2">
            <StageTrack task={task} />
          </div>
        )}
      </div>
      {band && <TurnBandView band={band} busy={sending} onAction={onTurn} />}

      {/* Once the plan is under way the brief has been read: it folds to a
          line, so the plan is what you see. */}
      {underWay ? (
        <BriefFold task={task} onOpenFile={onOpenFile} />
      ) : (
        <div className="flex max-w-xl flex-col items-end gap-1.5 self-end">
          <div className="whitespace-pre-wrap rounded-2xl rounded-br-sm bg-accent px-4 py-2.5 text-sm text-white">
            {task.brief}
          </div>
          <AttachmentChips names={task.attachments} onOpenFile={onOpenFile} />
        </div>
      )}

      {!underWay && task.answers && task.questions && (
        <CoordinatorSays
          label="asked, and you answered"
          action={<CommentButton task={task} target={{ kind: "questions" }} onOpenFile={onOpenFile} />}
        >
          <div className="flex flex-col divide-y divide-card rounded-lg border border-card bg-surface-elevated">
            {task.questions.map((q, i) => (
              <div key={i} className="flex flex-col gap-0.5 px-3 py-2">
                <span className="text-xs text-ink-muted">{q}</span>
                <span className="text-sm text-ink">{task.answers?.[i] || "—"}</span>
              </div>
            ))}
          </div>
        </CoordinatorSays>
      )}

      {task.status === "planning" && (
        <CoordinatorSays label="is planning">
          <CoordinatorActivity taskId={task.id} stage={null} since={task.updatedAt} reading="the brief and the team" />
        </CoordinatorSays>
      )}
      {task.status === "questions" && (
        <div id={`task-questions-${task.id}`}>
          <QuestionsForm task={task} />
        </div>
      )}
      {task.status === "proposed" && (
        <div id={`task-plan-${task.id}`}>
          <PlanCard task={task} />
        </div>
      )}
      {underWay && (
        <RunView task={task} team={team} onOpenFile={onOpenFile} />
      )}
      {task.status === "failed" && <FailedCard task={task} />}
      {task.status === "cancelled" && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-card bg-card px-4 py-3 text-xs text-ink-muted">
          Cancelled. Runs already started finish on their workers' desks.
          <DeleteTaskButton task={task} />
        </div>
      )}
      {error && <div className="text-xs text-red-500">{error}</div>}
    </div>
  );
}

function CoordinatorSays({ label, action, children }: { label: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent" aria-hidden>
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="8" cy="4" r="2" />
          <circle cx="3.5" cy="12" r="2" />
          <circle cx="12.5" cy="12" r="2" />
          <path d="M8 6v2.5M8 8.5L4.5 10.4M8 8.5l3.5 1.9" />
        </svg>
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-ink">
            Coordinator <span className="font-normal text-ink-faint">· {label}</span>
          </span>
          {action}
        </span>
        {children}
      </div>
    </div>
  );
}

/// The brief, folded to its opening line once the plan is under way. Opened,
/// it is the whole ask, what you attached, and the questions you answered.
function BriefFold({ task, onOpenFile }: { task: TeamTask; onOpenFile: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const answered = task.answers && task.questions ? task.questions.length : 0;
  return (
    <section aria-label="The brief" className="flex flex-col rounded-xl border border-card bg-surface-elevated">
      <button
        className="flex min-w-0 items-center gap-3 px-4 py-2.5 text-left"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="shrink-0 text-[10.5px] font-bold uppercase tracking-wider text-ink-faint">The brief</span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink-muted">“{briefOpening(task.brief)}”</span>
        <span className="shrink-0 text-xs text-ink-faint">
          {answered > 0 && `${answered} question${answered === 1 ? "" : "s"} answered · `}
          <span className="text-accent">{open ? "hide" : "show"}</span>
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-4 border-t border-card px-4 py-3">
          <div className="flex flex-col gap-1.5">
            <p className="max-w-3xl whitespace-pre-wrap text-sm leading-relaxed text-ink">{task.brief}</p>
            <AttachmentChips names={task.attachments} onOpenFile={onOpenFile} />
          </div>
          {task.answers && task.questions && (
            <CoordinatorSays
              label="asked, and you answered"
              action={<CommentButton task={task} target={{ kind: "questions" }} onOpenFile={onOpenFile} />}
            >
              <div className="flex flex-col divide-y divide-card rounded-lg bg-card">
                {task.questions.map((q, i) => (
                  <div key={i} className="flex flex-col gap-0.5 px-3 py-2">
                    <span className="text-xs text-ink-muted">{q}</span>
                    <span className="text-sm text-ink">{task.answers?.[i] || "—"}</span>
                  </div>
                ))}
              </div>
            </CoordinatorSays>
          )}
        </div>
      )}
    </section>
  );
}

function QuestionsForm({ task }: { task: TeamTask }) {
  const answer = useTeamsStore((s) => s.answer);
  const cancel = useTeamsStore((s) => s.cancel);
  const busy = useTeamsStore((s) => !!s.busy[task.id]);
  const [answers, setAnswers] = useState<string[]>(() => (task.questions ?? []).map(() => ""));
  return (
    <CoordinatorSays label={`has ${task.questions?.length ?? 0} question${task.questions?.length === 1 ? "" : "s"}`}>
      {task.planNote && <p className="text-sm text-ink-muted">{task.planNote}</p>}
      <div className="flex flex-col gap-3 rounded-lg border border-card bg-surface-elevated p-3">
        {(task.questions ?? []).map((q, i) => (
          <label key={i} className="flex flex-col gap-1.5 text-sm text-ink">
            {q}
            <textarea
              rows={2}
              value={answers[i] ?? ""}
              onChange={(e) => setAnswers((prev) => prev.map((a, j) => (j === i ? e.target.value : a)))}
              className="field resize-y px-2.5 py-1.5 text-sm"
              placeholder="Leave blank to let the coordinator decide"
            />
          </label>
        ))}
        <div className="flex justify-end gap-2">
          <button className={secondaryBtn} disabled={busy} onClick={() => void cancel(task.id)}>
            Cancel task
          </button>
          <button className={primaryBtn} disabled={busy} onClick={() => void answer(task.id, answers)}>
            Send answers
          </button>
        </div>
      </div>
    </CoordinatorSays>
  );
}

function PlanCard({ task }: { task: TeamTask }) {
  const approve = useTeamsStore((s) => s.approve);
  const revise = useTeamsStore((s) => s.revise);
  const cancel = useTeamsStore((s) => s.cancel);
  const busy = useTeamsStore((s) => !!s.busy[task.id]);
  const [editing, setEditing] = useState(false);
  const [feedback, setFeedback] = useState("");
  const members = new Set(task.stages.flatMap((s) => s.assignments.map((a) => a.workerId)));
  const hires = task.hires ?? [];
  return (
    <CoordinatorSays label="proposed a plan">
      <article className="overflow-hidden rounded-xl border-2 border-accent/70 bg-surface-elevated">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-card px-4 py-3">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-semibold text-ink">Plan · {task.stages.length} stages</h3>
              <CommentButton task={task} target={{ kind: "plan" }} label="Comment · re-plans" />
            </span>
            {task.deliverables && task.deliverables.length > 0 && (
              <span className="text-xs text-ink-muted">You'll get: {task.deliverables.join(" · ")}</span>
            )}
            {task.planNote && <p className="text-xs leading-relaxed text-ink-muted">{task.planNote}</p>}
          </div>
          <div className="flex flex-col items-end">
            <span className="text-lg font-semibold text-ink">up to {money(task.budgetUSD)}</span>
            <span className="text-[11px] text-ink-faint">
              {members.size} member{members.size === 1 ? "" : "s"} · runs pause at the cap
            </span>
          </div>
        </div>
        {hires.length > 0 && <PlanHires hires={hires} />}
        <ol className="flex flex-col">
          {task.stages.map((s, i) => (
            <li key={i} className="flex flex-wrap items-start gap-3 border-b border-card px-4 py-3 last:border-b-0">
              <span className="w-5 shrink-0 text-sm font-semibold text-ink-faint">{i + 1}</span>
              <KindChip stage={s} />
              <div className="flex min-w-0 flex-[1_1_260px] flex-col gap-1">
                <span className="text-sm font-medium text-ink">{s.title}</span>
                {s.ask && <span className="text-xs leading-relaxed text-ink-muted">{s.ask}</span>}
                {s.assignments.map((a) => (
                  <span key={a.workerId} className="text-xs leading-relaxed text-ink-muted">
                    <b className="font-medium text-ink">{a.workerName}</b>
                    {isHireKey(a.workerId) && <span className="ml-1 text-[10px] text-accent">new hire</span>}
                    {a.full && (
                      <span className="ml-1 text-[10px] text-ink-faint" title="Runs their whole usual process, with its own reviews">
                        full job
                      </span>
                    )}{" "}
                    — {a.ask}
                  </span>
                ))}
              </div>
              <span className="shrink-0 text-xs text-ink-faint">
                {isMemberStage(s.kind) ? s.assignments.map((a) => a.workerName).join(", ") : "Coordinator"}
              </span>
            </li>
          ))}
        </ol>
        <div className="flex flex-col gap-2 bg-card px-4 py-3">
          {editing && (
            <textarea
              rows={2}
              autoFocus
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="e.g. Skip the market stage — I already have that. Have Rook challenge twice."
              className="field resize-y px-2.5 py-1.5 text-sm"
            />
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button className={quietBtn + " mr-auto"} disabled={busy} onClick={() => void cancel(task.id)}>
              Cancel task
            </button>
            {editing ? (
              <>
                <button className={secondaryBtn} onClick={() => setEditing(false)}>
                  Never mind
                </button>
                <button
                  className={primaryBtn}
                  disabled={busy || !feedback.trim()}
                  onClick={() => void revise(task.id, feedback).then((r) => r.ok && setFeedback(""))}
                >
                  Re-plan
                </button>
              </>
            ) : (
              <>
                <button className={secondaryBtn} disabled={busy} onClick={() => setEditing(true)}>
                  Ask for changes
                </button>
                <button className={primaryBtn} disabled={busy} onClick={() => void approve(task.id)}>
                  {hires.length > 0 ? `Approve, hire ${hires.length} and start` : "Approve and start"}
                </button>
              </>
            )}
          </div>
        </div>
      </article>
    </CoordinatorSays>
  );
}

/// The members this plan hires. Approving the plan hires them: each joins
/// the crew on demand, with no shifts, and onto this team.
function PlanHires({ hires }: { hires: TeamPlanHire[] }) {
  return (
    <div className="flex flex-col gap-2 border-b border-card bg-accent/5 px-4 py-3">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
        New {hires.length === 1 ? "hire" : "hires"} · join the crew on demand, no shifts
      </span>
      {hires.map((h) => (
        <div key={h.key} className="flex flex-col gap-0.5">
          <span className="text-sm text-ink">
            <b className="font-medium">{h.name}</b> — {h.role}
          </span>
          {h.why && <span className="text-xs leading-relaxed text-ink-muted">{h.why}</span>}
          <span className="text-xs leading-relaxed text-ink-faint">{h.job}</span>
        </div>
      ))}
    </div>
  );
}

/// The approved plan is waiting on its hires.
function HiringCard({ task }: { task: TeamTask }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-accent/50 bg-accent/10 px-4 py-3">
      <span className="text-xs font-semibold text-ink">Hiring before the first stage</span>
      {(task.hires ?? []).map((h) => (
        <span key={h.key} className="flex items-center gap-2 text-sm text-ink">
          {h.status === "hired" ? (
            <span className="text-emerald-500">✓</span>
          ) : h.status === "failed" ? (
            <span className="text-red-500">!</span>
          ) : (
            <span className="h-3 w-3 animate-spin rounded-full border border-ink-faint/40 border-t-accent" />
          )}
          <b className="font-medium">{h.name}</b>
          <span className="text-xs text-ink-muted">
            {h.status === "hired" ? "on the crew" : h.status === "failed" ? h.error ?? "failed" : "drafting their job and flow…"}
          </span>
        </span>
      ))}
    </div>
  );
}

function KindChip({ stage }: { stage: Pick<TeamStage, "kind"> }) {
  return (
    <span className="w-[86px] shrink-0">
      <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted bg-card-strong">
        {TEAM_STAGE_LABEL[stage.kind]}
      </span>
    </span>
  );
}

function RunView({ task, team, onOpenFile }: { task: TeamTask; team: Team; onOpenFile: (name: string) => void }) {
  return (
    <div className="flex flex-col gap-4">
      <PlanLanes task={task} onOpenFile={onOpenFile} />

      {task.status === "running" && unhired(task).length > 0 && <HiringCard task={task} />}
      {task.status === "waiting" && task.waiting && (
        <div id={`task-waiting-${task.id}`}>
          <WaitingCard task={task} team={team} />
        </div>
      )}
      {task.code && <CodeCard task={task} landable={false} />}
      {task.codeError && (
        <p className="text-xs text-amber-500">
          No shared branch for this task — each piece works on its own branch. {task.codeError}
        </p>
      )}
    </div>
  );
}

/// Whether the pack is written and the task is now read as a pack and a
/// conversation — finished, or running work handed off from the room.
function packIsOut(task: TeamTask): boolean {
  if (!task.pack) return false;
  if (task.status === "review" || task.status === "done") return true;
  return (task.status === "running" || task.status === "waiting") && !!task.stages[task.stageIndex]?.fromRoom;
}

type TaskTab = TaskTabId;

/// How far into a task's room you have read, on this machine. A reading
/// position, not data: lost storage only means nothing is marked new.
const SEEN_KEY = "overcli.teamRoomSeen";

function readSeen(taskId: string): number | null {
  try {
    const map = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}") as Record<string, number>;
    return typeof map[taskId] === "number" ? map[taskId] : null;
  } catch {
    return null;
  }
}

function writeSeen(taskId: string, count: number): void {
  try {
    const map = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}") as Record<string, number>;
    map[taskId] = count;
    localStorage.setItem(SEEN_KEY, JSON.stringify(map));
  } catch {
    // best-effort
  }
}

/// Replies from the team after `from` — what "new" counts.
function repliesAfter(messages: TeamMessage[], from: number): number {
  return messages.slice(from).filter((m) => m.speaker.kind !== "you").length;
}

/// A task whose pack is written, in tabs: where the debate landed (once the
/// coordinator has wrapped one up), the debate itself, the pack, and the
/// brief and plan. The debate is the one that grows, so it gets a panel of
/// its own whose composer never scrolls away.
function PackTabs({
  task,
  team,
  onOpenFile,
  back,
}: {
  task: TeamTask;
  team: Team;
  onOpenFile: (name: string) => void;
  back?: { label: string; onClick: () => void };
}) {
  const error = useTeamsStore((s) => s.errors[task.id]);
  const updatePack = useTeamsStore((s) => s.updatePack);
  const roomContinue = useTeamsStore((s) => s.roomContinue);
  const sending = useTeamsStore((s) => !!s.busy[task.id]);
  const projectOptions = useProjectOptions();
  const messages = task.room?.messages ?? [];
  const landed = useMemo(() => latestWrapUp(task), [task]);
  // The first time a task is opened here, everything in it counts as read.
  const [seen, setSeen] = useState(() => readSeen(task.id) ?? messages.length);
  const [tab, setTab] = useState<TaskTab>(() => defaultTaskTab(task, seen));
  /// Where "new since you were here" goes, fixed when you open the tab.
  const [newFrom, setNewFrom] = useState<number | null>(() =>
    tab === "conversation" && seen < messages.length ? seen : null,
  );
  // A wrap-up arriving while you read gives the task its first tab; one
  // going away (it can't, today) would not leave you on an empty tab.
  const shownTab: TaskTab = tab === "landed" && !landed ? "conversation" : tab;
  // Reading the conversation reads what lands in it.
  useEffect(() => {
    if (shownTab !== "conversation" || seen === messages.length) return;
    writeSeen(task.id, messages.length);
    setSeen(messages.length);
  }, [shownTab, messages.length, seen, task.id]);
  const unread = shownTab === "conversation" ? 0 : repliesAfter(messages, seen);
  const rootRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Partial<Record<TaskTab, HTMLButtonElement | null>>>({});
  const pill = taskStatusPill(task);
  const band = yourTurn(task);
  const open = (next: TaskTab) => {
    if (next === shownTab) return;
    if (next === "conversation") setNewFrom(seen < messages.length ? seen : null);
    // The other tabs read from the top; the conversation places itself (at
    // what's new, or its end).
    else scrollerOf(rootRef.current)?.scrollTo({ top: 0 });
    setTab(next);
  };
  /// Fold changes into the pack, then watch it being rewritten in the debate.
  const sendChanges = (changes?: string[]) =>
    void updatePack(task.id, changes).then((res) => {
      if (res.ok) open("conversation");
    });
  const onTurn = (id: TurnAction) => {
    if (id === "addChanges") sendChanges(band?.changes);
    else if (id === "updatePack") sendChanges();
    else if (id === "reviewPack") open("pack");
    else if (id === "seeWaiting") scrollToId(`task-waiting-${task.id}`);
    else if (id === "openRun") openPausedRun(band?.run);
    else if (id === "keepDebating") {
      if (canKeepDebating(task)) void roomContinue(task.id);
      open("conversation");
    }
  };
  const replies = replyCount(messages);
  const tabs: Array<{ id: TaskTab; label: string; count?: string }> = [
    ...(landed ? [{ id: "landed" as const, label: "Where it landed" }] : []),
    { id: "conversation", label: "Debate", count: replies > 0 ? String(replies) : undefined },
    { id: "pack", label: "Pack", count: `v${task.pack?.version ?? 1}` },
    { id: "plan", label: "Brief & plan" },
  ];

  return (
    <div ref={rootRef} className="flex w-full flex-1 flex-col gap-4">
      {back && (
        <div className="flex min-w-0 items-center gap-2 pt-2">
          <button className={quietBtn + " shrink-0"} onClick={back.onClick}>
            ← {back.label}
          </button>
        </div>
      )}
      <header className={"flex flex-col gap-3 " + (back ? "" : "pt-4")}>
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
          <div className="flex min-w-0 flex-[1_1_420px] flex-col gap-0.5">
            <span className="truncate text-xs text-ink-faint">
              Task{task.pack?.updatedAt ? ` · pack updated ${relativeDay(task.pack.updatedAt)}` : ""}
              {task.projectPath && ` · in ${projectName(projectOptions, task.projectPath)}`}
            </span>
            <h2 className="truncate text-lg font-semibold tracking-tight text-ink" title={task.brief}>
              {task.title ?? "Team task"}
            </h2>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-[11px] text-ink-faint">
            <span
              role="status"
              className={
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11.5px] font-medium " +
                (pill.tone === "working"
                  ? "bg-accent/15 text-accent"
                  : pill.tone === "accent"
                    ? "bg-accent text-white"
                    : pill.tone === "waiting"
                      ? "bg-violet-400/15 text-violet-700 dark:text-violet-300"
                      : pill.tone === "done"
                        ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                        : pill.tone === "failed"
                          ? "bg-amber-500/15 text-amber-500"
                          : "bg-card-strong text-ink-muted")
              }
            >
              {pill.tone === "working" && <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />}
              {pill.text}
            </span>
            <span className="tabular-nums">
              {money(task.spentUSD)} of {money(task.budgetUSD)}
            </span>
          </div>
        </div>
        <StageTrack task={task} />
        <ContinuationLinks task={task} />
      </header>

      {band ? <TurnBandView band={band} busy={sending} onAction={onTurn} /> : <RolloverBand task={task} />}

      {/* The tabs stay at the top of the task column however far you read:
          the way between where it landed, the debate, the pack and the plan. */}
      <div className="sticky top-0 z-10 -mx-6 flex border-b border-card bg-surface/95 px-6 py-2 backdrop-blur">
        <div role="tablist" aria-label="Task views" className="flex flex-wrap gap-1 rounded-[10px] border border-card bg-surface-elevated p-1">
          {tabs.map((t) => {
            const on = shownTab === t.id;
            return (
              <button
                key={t.id}
                id={`task-tab-${t.id}`}
                ref={(el) => {
                  tabRefs.current[t.id] = el;
                }}
                role="tab"
                aria-selected={on}
                aria-controls={`task-panel-${t.id}`}
                tabIndex={on ? 0 : -1}
                onClick={() => open(t.id)}
                onKeyDown={(e) => {
                  const to = nextTab(tabs.map((x) => x.id), shownTab, e.key);
                  if (!to) return;
                  e.preventDefault();
                  open(to);
                  tabRefs.current[to]?.focus();
                }}
                className={
                  "flex items-center gap-2 rounded-[7px] px-3.5 py-1.5 text-[13px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/60 " +
                  (on ? "bg-card-strong text-ink shadow-sm" : "text-ink-muted hover:bg-card hover:text-ink")
                }
              >
                {t.label}
                {t.count && (
                  <span
                    className={
                      "rounded-full px-1.5 py-px text-[11px] font-medium tabular-nums " +
                      (on ? "bg-accent text-white" : "bg-card-strong text-ink-muted")
                    }
                  >
                    {t.count}
                  </span>
                )}
                {t.id === "conversation" && unread > 0 && (
                  <span className="rounded-full bg-accent px-1.5 py-px text-[11px] font-normal text-white">{unread} new</span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {task.status === "waiting" && task.waiting && (
        <div id={`task-waiting-${task.id}`}>
          <WaitingCard task={task} team={team} />
        </div>
      )}
      {error && <div className="text-xs text-red-500">{error}</div>}

      {shownTab === "landed" && landed && (
        <div role="tabpanel" id="task-panel-landed" aria-labelledby="task-tab-landed" className="pb-6">
          <LandedView
            task={task}
            landed={landed}
            sending={sending}
            onSend={(changes) => sendChanges(changes)}
            onOpenDebate={() => open("conversation")}
          />
        </div>
      )}
      {shownTab === "pack" && (
        <div role="tabpanel" id="task-panel-pack" aria-labelledby="task-tab-pack" className="pb-6">
          <PackView task={task} onOpenFile={onOpenFile} />
        </div>
      )}
      {shownTab === "conversation" && (
        <div role="tabpanel" id="task-panel-conversation" aria-labelledby="task-tab-conversation" className="flex flex-1 flex-col">
          <TeamRoom task={task} team={team} onOpenFile={onOpenFile} newFrom={newFrom} />
        </div>
      )}
      {shownTab === "plan" && (
        <div role="tabpanel" id="task-panel-plan" aria-labelledby="task-tab-plan" className="flex flex-col gap-5 pb-6">
          <BriefFold task={task} onOpenFile={onOpenFile} />
          <PlanLanes task={task} onOpenFile={onOpenFile} />
        </div>
      )}
    </div>
  );
}

/// The header's stage track: one bar per stage, its name under it. Once
/// follow-ups have added rounds, each round is one group of bars under one
/// name, so a long task's track stays readable.
function StageTrack({ task }: { task: TeamTask }) {
  const { done, total } = teamTaskProgress(task);
  const rounds = useMemo(() => planRounds(task), [task]);
  if (total === 0) return null;
  const bar = (st: TeamStage, i: number) => (
    <span
      key={i}
      aria-hidden
      className={"h-[5px] min-w-0 flex-1 rounded-full " + STAGE_BAR[st.status]}
      title={`${stageWhere(rounds, i)} · ${st.title} · ${st.status}`}
    />
  );
  if (rounds.length > 1) {
    return (
      <ol aria-label={`Stages · ${done} of ${total} done, in ${rounds.length} rounds`} className="flex gap-3">
        {rounds.map((r) => (
          <li key={r.index} className="flex min-w-0 flex-col gap-1" style={{ flex: `${r.stages.length} 1 0` }}>
            <span className="flex gap-[3px]">{r.stages.map((i) => bar(task.stages[i], i))}</span>
            <span className={"truncate text-[11.5px] " + (r.live ? "text-accent" : r.failed > 0 ? "text-amber-500" : "text-ink-muted")} title={r.ask}>
              {roundName(r)} · {r.stages.length}
              {r.ask && <span className="text-ink-faint"> · {r.ask}</span>}
            </span>
          </li>
        ))}
      </ol>
    );
  }
  return (
    <ol
      aria-label={`Stages · ${done} of ${total} done`}
      className="grid gap-1"
      style={{ gridTemplateColumns: `repeat(${total}, minmax(0, 1fr))` }}
    >
      {task.stages.map((st, i) => {
        const ink =
          st.status === "running" ? "text-accent" : st.status === "failed" ? "text-amber-500" : st.status === "done" ? "text-ink-muted" : "text-ink-faint";
        return (
          <li key={i} className="flex min-w-0 flex-col gap-1" title={`${stageWhere(rounds, i)} · ${st.title} · ${st.status}`}>
            <span aria-hidden className={"h-[5px] rounded-full " + STAGE_BAR[st.status]} />
            <span className={"truncate text-[11.5px] " + ink + (st.status === "skipped" ? " line-through" : "")}>{st.title}</span>
          </li>
        );
      })}
    </ol>
  );
}

/// "Stage 9", or "Round 3 · stage 9" for a follow-up: the one way a stage is
/// named in titles and the detail strip.
function stageWhere(rounds: PlanRound[], stage: number): string {
  const r = roundOf(rounds, stage);
  return r && r.index > 0 ? `${roundName(r)} · stage ${stage + 1}` : `Stage ${stage + 1}`;
}

/// Where this task picks up from, and where it was picked up: the two ends
/// of a task continued as a fresh run.
function ContinuationLinks({ task }: { task: TeamTask }) {
  const from = task.continuesFrom;
  const next = task.continuedAs;
  if (!from && !next) return null;
  const go = (taskId: string) => useWorkersStore.getState().selectTeam(task.teamId, taskId);
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-faint">
      {from && (
        <span>
          Continues{" "}
          <button className={linkBtn} onClick={() => go(from.taskId)}>
            ← {from.title ?? "the earlier task"}
          </button>{" "}
          · {from.stages} stages · Pack v{from.packVersion}
        </span>
      )}
      {next && (
        <span>
          Continued in a new run{" "}
          <button className={linkBtn} onClick={() => go(next.taskId)}>
            open it →
          </button>
        </span>
      )}
    </div>
  );
}

const ROLLOVER_KEY = "overcli.teamRolloverDismissed";

/// In place of the composer once a task was picked up as a new run: what
/// you'd ask here belongs there, or both tasks build the same thing.
function ContinuedNotice({ task }: { task: TeamTask }) {
  const next = task.continuedAs!;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-card bg-surface-elevated px-4 py-3 text-[13px] text-ink-muted">
      <span>This task continued in a new run. Ask the team there; this conversation is kept as it is.</span>
      <button className={primaryBtn} onClick={() => useWorkersStore.getState().selectTeam(task.teamId, next.taskId)}>
        Open the new run →
      </button>
    </div>
  );
}

/// Follow-up stages since you last said "keep going here", so the band comes
/// back only once the task has grown again.
function readRolloverDismissed(taskId: string): number | null {
  try {
    const map = JSON.parse(localStorage.getItem(ROLLOVER_KEY) ?? "{}") as Record<string, number>;
    return typeof map[taskId] === "number" ? map[taskId] : null;
  } catch {
    return null;
  }
}

function writeRolloverDismissed(taskId: string, followUps: number): void {
  try {
    const map = JSON.parse(localStorage.getItem(ROLLOVER_KEY) ?? "{}") as Record<string, number>;
    map[taskId] = followUps;
    localStorage.setItem(ROLLOVER_KEY, JSON.stringify(map));
  } catch {
    // best-effort
  }
}

/// A task whose follow-ups have sprawled: the offer to pick it up as a fresh
/// run from its pack, and what comes along when you do.
function RolloverBand({ task }: { task: TeamTask }) {
  const now = useTickingNow(3_600_000);
  const continueAsNew = useTeamsStore((s) => s.continueAsNew);
  const busy = useTeamsStore((s) => !!s.busy[task.id]);
  const followUps = task.stages.filter((s) => s.fromRoom).length;
  const [dismissed, setDismissed] = useState(() => readRolloverDismissed(task.id));
  const [form, setForm] = useState(false);
  const [ask, setAsk] = useState("");
  const [talk, setTalk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reason = rolloverReason(task, now);
  if (!reason || (dismissed !== null && followUps < dismissed + 3)) return null;
  const version = task.pack?.version ?? 1;
  const open = task.stages.filter((s) => s.status === "failed");
  const start = async () => {
    setError(null);
    const res = await continueAsNew(task.id, ask, talk);
    if (!res.ok) setError(res.error);
    else useWorkersStore.getState().selectTeam(task.teamId, res.task.id);
  };
  return (
    <section aria-label="Start a new run" className="flex flex-col gap-3 rounded-xl border border-amber-500/40 bg-amber-500/[0.08] px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-0.5">
          <b className="text-[14.5px] font-semibold text-ink">{reason.title}</b>
          <span className="text-[12.5px] leading-relaxed text-ink-muted">{reason.detail}</span>
        </div>
        {!form && (
          <div className="flex flex-wrap gap-2">
            <button className={primaryBtn} onClick={() => setForm(true)}>
              Start a new run from Pack v{version}
            </button>
            <button
              className={secondaryBtn}
              onClick={() => {
                writeRolloverDismissed(task.id, followUps);
                setDismissed(followUps);
              }}
            >
              Keep going here
            </button>
          </div>
        )}
      </div>
      {form && (
        <div className="flex flex-col gap-2.5 border-t border-amber-500/25 pt-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-ink">What should the new run do?</span>
            <textarea
              value={ask}
              onChange={(e) => setAsk(e.target.value)}
              rows={3}
              placeholder={`Leave it blank to carry on from Pack v${version}`}
              className="resize-y rounded-md border border-card bg-surface px-2.5 py-2 text-[13px] text-ink outline-none focus:border-accent"
            />
          </label>
          <ul className="flex flex-col gap-1 text-xs text-ink-muted">
            <li>Pack v{version} and the shared folder come along, under <code>earlier/</code>.</li>
            {open.length > 0 && (
              <li>
                {open.length === 1 ? "The failed stage" : `The ${open.length} failed stages`} ({open.map((s) => `“${s.title}”`).join(", ")}) start the new plan.
              </li>
            )}
            {task.code?.branch && <li>Code starts from the {task.code.branch} branch.</li>}
          </ul>
          <label className="flex items-center gap-2 text-xs text-ink">
            <input type="checkbox" checked={talk} onChange={(e) => setTalk(e.target.checked)} className="accent-accent" />
            Bring the conversation too
            <span className="text-ink-faint">· this task keeps it either way</span>
          </label>
          {error && <span className="text-xs text-red-500">{error}</span>}
          <div className="flex gap-2">
            <button className={primaryBtn} disabled={busy} onClick={() => void start()}>
              Start the new run
            </button>
            <button className={quietBtn} onClick={() => setForm(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/// A paused piece's run, where its approval or question is answered.
function openPausedRun(run: TurnBand["run"]): void {
  if (!run) return;
  useWorkersStore.getState().selectWorker(run.workerId);
  useFlowsStore.getState().setActiveRun(run.runId);
}

/// "Your turn": what the task is waiting on you for, and what answers it.
function TurnBandView({ band, busy, onAction }: { band: TurnBand; busy: boolean; onAction: (id: TurnAction) => void }) {
  return (
    <section aria-label="Your turn" className="flex flex-wrap items-center gap-4 rounded-xl border border-amber-500/40 bg-amber-500/[0.08] px-4 py-3.5">
      <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-amber-500/20 text-amber-700 dark:text-amber-400">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 11l3 3 8-8" />
          <path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9" />
        </svg>
      </span>
      <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-0.5">
        <b className="text-[14.5px] font-semibold text-ink">{band.title}</b>
        {band.detail && <span className="text-[12.5px] leading-relaxed text-ink-muted">{band.detail}</span>}
      </div>
      <div className="flex flex-wrap gap-2">
        {band.actions.map((a) => (
          <button key={a.id} className={a.primary ? primaryBtn : secondaryBtn} disabled={busy} onClick={() => onAction(a.id)}>
            {a.label}
          </button>
        ))}
      </div>
    </section>
  );
}

/// "Where it landed": the coordinator's latest wrap-up in its parts — the
/// bottom line, what was agreed, what is still open and who answers it, and
/// the changes worth making to the pack, ticked to send.
function LandedView({
  task,
  landed,
  sending,
  onSend,
  onOpenDebate,
}: {
  task: TeamTask;
  landed: LandedWrapUp;
  sending: boolean;
  onSend: (changes: string[]) => void;
  onOpenDebate: () => void;
}) {
  const { wrap, folded, message } = landed;
  /// Unticked changes, by text: a wrap-up rewritten under you keeps the
  /// ones you left ticked.
  const [off, setOff] = useState<Set<string>>(() => new Set());
  const picked = wrap.changes.filter((c) => !off.has(c));
  const canSend = canUpdatePack(task) && !folded && picked.length > 0;
  const card = "flex flex-col gap-2.5 rounded-xl border border-card bg-surface-elevated px-4 py-3.5";
  const label = "text-[10.5px] font-bold uppercase tracking-wider";
  const nothing = <span className="text-xs text-ink-faint">Nothing noted.</span>;
  return (
    <div className="flex w-full flex-col gap-3.5">
      <div className="flex flex-col gap-3 rounded-xl border border-card bg-surface-elevated px-5 py-4">
        <span className="flex flex-wrap items-center gap-2.5">
          <span aria-hidden className="flex h-[26px] w-[26px] items-center justify-center rounded-full bg-card-strong text-[11px] font-bold text-ink-muted">
            C
          </span>
          <span className={label + " text-ink-faint"}>The bottom line · from the coordinator · {clockOrDay(message.at)}</span>
          <button className="ml-auto text-xs text-accent hover:underline" onClick={onOpenDebate}>
            Read the debate
          </button>
        </span>
        <p className="text-base font-medium leading-relaxed text-ink">
          {wrap.bottomLine || "The coordinator went straight to the lists below."}
        </p>
      </div>

      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
        <section className={card} aria-label="Agreed">
          <span className={label + " text-emerald-700 dark:text-emerald-400"}>Agreed · {wrap.agreed.length}</span>
          {wrap.agreed.length === 0
            ? nothing
            : wrap.agreed.map((a, i) => (
                <div key={i} className="flex items-start gap-2.5">
                  <svg aria-hidden width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="mt-[3px] shrink-0 text-emerald-700 dark:text-emerald-400">
                    <path d="M5 12l5 5L20 7" />
                  </svg>
                  <span className="text-[13px] leading-relaxed text-ink">{a}</span>
                </div>
              ))}
        </section>
        <section className={card} aria-label="Still open">
          <span className={label + " text-amber-700 dark:text-amber-400"}>Still open · {wrap.open.length}</span>
          {wrap.open.length === 0
            ? nothing
            : wrap.open.map((o, i) => {
                const { text, who } = splitOwner(o);
                return (
                  <div key={i} className="flex flex-col gap-0.5">
                    <span className="text-[13px] leading-relaxed text-ink">{text}</span>
                    {who && <span className="text-[11.5px] text-ink-faint">{who}</span>}
                  </div>
                );
              })}
        </section>
        <section className={card} aria-label="Change in the pack">
          <span className={label + " text-accent"}>
            Change in the pack ·{" "}
            {folded ? `in v${task.pack?.version ?? 1}` : `${picked.length} of ${wrap.changes.length} picked`}
          </span>
          {wrap.changes.length === 0
            ? nothing
            : folded
              ? wrap.changes.map((c, i) => (
                  <span key={i} className="text-[13px] leading-relaxed text-ink-muted">
                    {c}
                  </span>
                ))
              : wrap.changes.map((c, i) => (
                  <label key={i} className="flex cursor-pointer items-start gap-2.5">
                    <input
                      type="checkbox"
                      className="tl-check mt-[3px] h-[15px] w-[15px] shrink-0"
                      checked={!off.has(c)}
                      onChange={() =>
                        setOff((prev) => {
                          const next = new Set(prev);
                          if (next.has(c)) next.delete(c);
                          else next.add(c);
                          return next;
                        })
                      }
                    />
                    <span className="text-[13px] leading-relaxed text-ink">{c}</span>
                  </label>
                ))}
          {folded ? (
            wrap.changes.length > 0 && <span className="text-[11.5px] text-ink-faint">A pack update since this wrap-up took these in.</span>
          ) : (
            wrap.changes.length > 0 && (
              <button
                className={primaryBtn + " mt-0.5 self-start"}
                disabled={!canSend || sending}
                title={
                  canUpdatePack(task)
                    ? "The coordinator rewrites the pack with these changes. The current version is kept."
                    : "Once the team has finished answering"
                }
                onClick={() => onSend(picked)}
              >
                Send {picked.length} to the pack
              </button>
            )
          )}
        </section>
      </div>
    </div>
  );
}

/// This task's plan as swimlanes: the coordinator's lane first, then one per
/// member, one column per stage. A cell holds a chip only where that member
/// has a piece. Work handed off from the conversation after the pack sits in
/// its own tinted columns past a divider. Picking a cell shows it in full in
/// the strip under the grid.
function PlanLanes({ task, onOpenFile }: { task: TeamTask; onOpenFile: (name: string) => void }) {
  const [why, setWhy] = useState(false);
  const workers = useWorkersStore((s) => s.workers);
  const team = useTeamsStore((s) => s.teams[task.teamId]);
  const live = task.stages.some((s) => s.status === "running");
  const now = useTickingNow(live ? 30_000 : 3_600_000);
  const { lanes, columns } = planLayout(task);
  const rounds = useMemo(() => planRounds(task), [task]);
  const counts = useMemo(() => commentsByPiece(task), [task]);
  /// Until you pick a cell, the strip follows the work.
  const [picked, setPicked] = useState<PlanCell | null>(null);
  const hasCell = (c: PlanCell | null) => !!c && !!columns[c.stage]?.lanes.includes(c.lane);
  const selected = hasCell(picked) ? picked : defaultCell(task);
  /// Until you pick a round, the one at work is open and the rest fold.
  const [pickedRound, setPickedRound] = useState<number | null>(null);
  const [all, setAll] = useState(false);
  const folds = rounds.length > 1 && !all;
  const shownRound = pickedRound !== null && pickedRound < rounds.length ? pickedRound : openRound(rounds);
  const isOpen = (r: PlanRound) => !folds || r.index === shownRound;

  // One slot per stage of an open round; settled rounds side by side fold
  // into one column (the plan always on its own), so ten follow-ups still
  // take at most three folded columns. A thin divider between groups.
  type Slot = { kind: "stage"; column: PlanColumn; round: PlanRound } | { kind: "fold"; group: PlanRound[] } | { kind: "divider" };
  const groups: Array<{ open: boolean; rounds: PlanRound[] }> = [];
  for (const r of rounds) {
    const last = groups.at(-1);
    if (!isOpen(r) && last && !last.open && last.rounds[0].index > 0) last.rounds.push(r);
    else groups.push({ open: isOpen(r), rounds: [r] });
  }
  const slots: Slot[] = groups.flatMap((g, i): Slot[] => [
    ...(i > 0 ? [{ kind: "divider" as const }] : []),
    ...(g.open
      ? g.rounds[0].stages.map((s) => ({ kind: "stage" as const, column: columns[s], round: g.rounds[0] }))
      : [{ kind: "fold" as const, group: g.rounds }]),
  ]);
  const merged = (g: PlanRound[]): PlanRound =>
    g.length === 1
      ? g[0]
      : {
          index: g.at(-1)!.index,
          stages: g.flatMap((r) => r.stages),
          done: g.reduce((n, r) => n + r.done, 0),
          failed: g.reduce((n, r) => n + r.failed, 0),
          live: g.some((r) => r.live),
          from: g.find((r) => r.from !== undefined)?.from,
          to: g.reduce<number | undefined>((t, r) => (r.to === undefined ? t : Math.max(t ?? r.to, r.to)), undefined),
        };
  const template = ["150px", ...slots.map((s) => (s.kind === "divider" ? "14px" : `minmax(${COLUMN_MIN}px,1fr)`))].join(" ");
  const minWidth = 150 + slots.reduce((n, s) => n + (s.kind === "divider" ? 14 : COLUMN_MIN), 0);
  const rowOf = (lane: number) => 2 + lane;
  const tint = (r: PlanRound, lane: number) => (r.index > 0 ? "bg-emerald-500/[0.06]" : lane === 0 ? "bg-surface/60" : "");

  return (
    <section aria-label="The plan" className="flex flex-col overflow-hidden rounded-xl border border-card bg-surface-elevated">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-card px-4 py-2.5">
        <h3 className="flex-1 text-[10.5px] font-bold uppercase tracking-wider text-ink-faint">
          The plan · {task.stages.length} {task.stages.length === 1 ? "stage" : "stages"}
          {rounds.length > 1 && ` in ${rounds.length} rounds`}, {planStatus(task)}
        </h3>
        {rounds.length > 1 && (
          <button className="text-xs text-accent hover:underline" aria-pressed={all} onClick={() => setAll((v) => !v)}>
            {all ? "Fold settled rounds" : `Show all ${task.stages.length} stages`}
          </button>
        )}
        {task.planNote && (
          <button className="text-xs text-accent hover:underline" aria-expanded={why} onClick={() => setWhy((v) => !v)}>
            {why ? "Hide why" : "Why this plan"}
          </button>
        )}
        <CommentButton task={task} target={{ kind: "plan" }} onOpenFile={onOpenFile} />
        <span className="flex items-center gap-2 text-[11px] tabular-nums text-ink-faint" title="Spent of the task's budget; runs pause at the cap">
          <span className="h-1 w-20 overflow-hidden rounded-full bg-card-strong">
            <span
              className="block h-full rounded-full bg-accent"
              style={{ width: `${Math.min(100, task.budgetUSD > 0 ? (task.spentUSD / task.budgetUSD) * 100 : 0)}%` }}
            />
          </span>
          <span>
            <b className="font-medium text-ink">{money(task.spentUSD)}</b> of {money(task.budgetUSD)}
          </span>
        </span>
      </div>
      {why && task.planNote && <p className="border-b border-card px-4 py-2.5 text-xs leading-relaxed text-ink-muted">{task.planNote}</p>}

      {rounds.length > 1 && (
        <RoundPicker
          task={task}
          rounds={rounds}
          open={folds ? shownRound : null}
          onPick={(i) => {
            setAll(false);
            setPickedRound(i);
          }}
        />
      )}

      {/* Scrolls sideways only inside this box, and only when the open
          stages truly can't fit. Zero width, at least the box's: the grid's
          own minimum never widens the task column around it. */}
      <div className="w-0 min-w-full overflow-x-auto">
        <div className="grid" style={{ gridTemplateColumns: template, minWidth }}>
          <div className="border-b border-card" style={{ gridColumn: 1, gridRow: 1 }} />
          {slots.map((s, i) =>
            s.kind === "divider" ? (
              <div key={`div-${i}`} aria-hidden className="relative" style={{ gridColumn: 2 + i, gridRow: `1 / ${rowOf(lanes.length)}` }}>
                <span className="absolute inset-y-0 left-1/2 w-px bg-card-strong" />
              </div>
            ) : s.kind === "stage" ? (
              <ColumnHead
                key={`head-${s.column.index}`}
                kicker={`${s.column.index + 1} · ${TEAM_STAGE_LABEL[s.column.stage.kind]}`}
                kickerInk={KIND_INK[s.column.stage.kind]}
                title={s.column.stage.title}
                meta={stageWhen(s.column.stage, now, clock) || (s.column.stage.status === "pending" ? "Not started" : "")}
                running={s.column.stage.status === "running"}
                struck={s.column.stage.status === "skipped"}
                tinted={s.round.index > 0}
                style={{ gridColumn: 2 + i, gridRow: 1 }}
              />
            ) : (
              (() => {
                const r = merged(s.group);
                const first = s.group[0];
                const several = s.group.length > 1;
                return (
                  <ColumnHead
                    key={`fold-${first.index}`}
                    kicker={`${several ? `${roundName(first)}–${r.index + 1}` : roundName(first)} · ${r.stages.length === 1 ? "1 stage" : `${r.stages.length} stages`}`}
                    kickerInk="text-ink-faint"
                    title={several ? `${s.group.length} follow-ups, folded` : (first.ask ?? (first.index === 0 ? briefOpening(task.brief, 80) : roundName(first)))}
                    meta={roundWhen(r, now)}
                    running={r.live}
                    tinted={first.index > 0}
                    onOpen={() => {
                      setAll(false);
                      setPickedRound(r.index);
                    }}
                    openLabel={`Open ${roundName(r).toLowerCase()}`}
                    style={{ gridColumn: 2 + i, gridRow: 1 }}
                  />
                );
              })()
            ),
          )}

          {lanes.map((l, i) => {
            const w = l.workerId ? workers[l.workerId] : undefined;
            const role = team?.members.find((m) => m.workerId === l.workerId)?.role;
            const sub = l.id === COORDINATOR_LANE ? "plans and writes the pack" : roleTitle(role) || (w ? workerTagline(w) : "");
            return (
              <div
                key={`lane-${l.id}`}
                className={"flex min-w-0 items-center gap-2.5 border-b border-card px-4 py-2 " + (i === 0 ? "bg-surface/60" : "")}
                style={{ gridColumn: 1, gridRow: rowOf(i) }}
              >
                {l.id === COORDINATOR_LANE ? <CoordinatorFace /> : w ? <WorkerAvatar worker={w} size="sm" /> : <GoneFace name={l.name} />}
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[12.5px] font-semibold text-ink">{l.name}</span>
                  {sub && (
                    <span className="truncate text-[11px] text-ink-faint" title={role ?? sub}>
                      {sub}
                    </span>
                  )}
                </span>
              </div>
            );
          })}

          {slots.flatMap((s, si) => {
            if (s.kind === "divider") return [];
            return lanes.map((l, i) => {
              const style = { gridColumn: 2 + si, gridRow: rowOf(i) };
              const wrap = "flex min-w-0 items-center border-b border-card px-1.5 py-1.5 " + tint(s.kind === "fold" ? s.group[0] : s.round, i);
              if (s.kind === "fold") {
                const r = merged(s.group);
                const key = `foldcell-${s.group[0].index}-${l.id}`;
                const sum = foldedLaneLabel(task, r, l.id);
                return (
                  <div key={key} className={wrap} style={style}>
                    {sum && (
                      <button
                        onClick={() => {
                          setAll(false);
                          setPickedRound(r.index);
                        }}
                        title={`Open ${roundName(r).toLowerCase()}`}
                        className="flex w-full min-w-0 items-center gap-1.5 rounded-md border border-dashed border-card-strong px-2 py-1.5 text-left text-xs text-ink-muted transition-colors hover:border-accent/60 hover:text-ink"
                      >
                        <span aria-hidden className={"h-1.5 w-1.5 shrink-0 rounded-full " + DOT[sum.state]} />
                        <span className="min-w-0 flex-1 truncate">{sum.label}</span>
                      </button>
                    )}
                  </div>
                );
              }
              const c = s.column;
              const key = `cell-${c.index}-${l.id}`;
              if (!c.lanes.includes(l.id)) return <div key={key} className={wrap} style={style} />;
              const isSel = selected?.stage === c.index && selected.lane === l.id;
              const pick = () => setPicked({ stage: c.index, lane: l.id });
              const a = l.id === COORDINATOR_LANE ? undefined : pieceIn(c.stage, l.id);
              return (
                <div key={key} className={wrap} style={style}>
                  {a ? (
                    <PieceChip a={a} stage={c.stage} now={now} selected={isSel} count={counts.get(pieceKey(c.index, l.id)) ?? 0} onPick={pick} />
                  ) : (
                    <DocChip
                      task={task}
                      stage={c.stage}
                      now={now}
                      selected={isSel}
                      onPick={pick}
                      onOpen={c.stage.status === "done" && c.stage.file ? () => {
                        pick();
                        onOpenFile(c.stage.file!);
                      } : undefined}
                    />
                  )}
                </div>
              );
            });
          })}
        </div>
      </div>

      {selected && task.stages[selected.stage] && (
        <CellDetail key={`${selected.stage}-${selected.lane}`} task={task} cell={selected} now={now} counts={counts} onOpenFile={onOpenFile} />
      )}
    </section>
  );
}

/// Every column of the plan, a stage's or a folded round's, is this narrow.
const COLUMN_MIN = 120;

/// The rounds of a long task, one card each: what started it, a tick per
/// stage, and when it ran. Picking one opens it in the grid and folds the rest.
function RoundPicker({
  task,
  rounds,
  open,
  onPick,
}: {
  task: TeamTask;
  rounds: PlanRound[];
  open: number | null;
  onPick: (index: number) => void;
}) {
  const now = useTickingNow(60_000);
  return (
    <div role="group" aria-label="Rounds" className="flex flex-wrap gap-2 border-b border-card px-4 py-3">
      {rounds.map((r) => {
        const on = open === r.index;
        return (
          <button
            key={r.index}
            aria-pressed={on}
            onClick={() => onPick(r.index)}
            className={
              "flex min-w-[150px] max-w-[320px] flex-col gap-1.5 rounded-lg border px-3 py-2 text-left transition-colors " +
              (on ? "border-accent bg-accent/10" : "border-card bg-surface hover:border-card-strong")
            }
            style={{ flex: `${Math.max(1, Math.min(r.stages.length, 3))} 1 150px` }}
          >
            <span className="flex items-baseline justify-between gap-3">
              <span className="truncate text-[12.5px] font-semibold text-ink">{roundName(r)}</span>
              <span className="shrink-0 text-[11px] tabular-nums text-ink-faint">
                {r.stages.length === 1 ? "1 stage" : `${r.stages.length} stages`}
                {r.failed > 0 && <span className="text-red-600 dark:text-red-400"> · {r.failed} failed</span>}
              </span>
            </span>
            <span className="truncate text-xs text-ink-muted" title={r.ask}>
              {r.ask ? `“${briefOpening(r.ask, 80)}”` : briefOpening(task.brief, 80)}
            </span>
            <span aria-hidden className="flex gap-[3px]">
              {r.stages.map((i) => (
                <span key={i} className={"h-1 flex-1 rounded-full " + STAGE_BAR[task.stages[i].status]} />
              ))}
            </span>
            <span className="text-[11px] tabular-nums text-ink-faint">{roundWhen(r, now) || "Not started"}</span>
          </button>
        );
      })}
    </div>
  );
}

/// When a round ran: "1:02 PM – 1:39 PM", with the day once it isn't today.
function roundWhen(r: Pick<PlanRound, "from" | "to" | "live">, now: number): string {
  if (r.from === undefined) return "";
  const day = (at: number) => new Date(at).toDateString();
  const date = day(r.from) === day(now) ? "" : `${new Date(r.from).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · `;
  const end = r.live ? "now" : r.to !== undefined && r.to !== r.from ? clock(r.to) : "";
  return `${date}${clock(r.from)}${end ? ` – ${end}` : ""}`;
}

const STAGE_BAR: Record<TeamStage["status"], string> = {
  done: "bg-emerald-500",
  running: "bg-accent",
  failed: "bg-amber-500",
  skipped: "bg-ink-faint/40",
  pending: "bg-card-strong",
};

function clock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/// Each stage kind's colour, as text: the same family as `KindMark`.
const KIND_INK: Record<TeamStageKind, string> = {
  contribute: "text-blue-600 dark:text-blue-400",
  draft: "text-ink-muted",
  challenge: "text-orange-600 dark:text-orange-400",
  respond: "text-amber-800 dark:text-amber-200",
  synthesize: "text-emerald-700 dark:text-emerald-400",
};

/// A plan column's head. Every column, a stage's or a folded round's, has
/// the same three lines at the same heights — what it is, its title, and
/// when — so the row of heads reads as one.
function ColumnHead({
  kicker,
  kickerInk,
  title,
  meta,
  running,
  struck,
  tinted,
  onOpen,
  openLabel,
  style,
}: {
  kicker: string;
  kickerInk: string;
  title: string;
  meta: string;
  running?: boolean;
  struck?: boolean;
  tinted?: boolean;
  onOpen?: () => void;
  openLabel?: string;
  style: React.CSSProperties;
}) {
  const body = (
    <>
      <span className={"truncate text-[10.5px] font-bold uppercase tracking-wider " + kickerInk} title={kicker}>
        {kicker}
      </span>
      <span
        className={"line-clamp-2 min-h-[2lh] text-[12.5px] font-semibold leading-tight " + (struck ? "text-ink-faint line-through" : "text-ink")}
        title={title}
      >
        {title}
      </span>
      <span className={"truncate text-[11px] tabular-nums " + (running ? "text-accent" : "text-ink-faint")}>{meta || "\u00a0"}</span>
    </>
  );
  const cls =
    "flex min-w-0 flex-col justify-end gap-0.5 border-b px-2.5 py-2.5 text-left " +
    (running ? "border-accent " : "border-card ") +
    (tinted ? "bg-emerald-500/[0.06]" : "");
  return onOpen ? (
    <button className={cls + " transition-colors hover:bg-card"} style={style} onClick={onOpen} aria-label={`${openLabel}: ${title}`}>
      {body}
    </button>
  ) : (
    <div className={cls} style={style}>
      {body}
    </div>
  );
}

const DOT: Record<ChipState, string> = {
  done: "bg-emerald-500",
  working: "bg-accent animate-pulse",
  waiting: "bg-violet-400",
  failed: "bg-red-500",
  skipped: "bg-ink-faint/50",
  pending: "bg-ink-faint/50",
};

/// A member's piece in its cell: a quiet chip, its dot saying where it
/// stands. One not started yet is just its words, with no box.
function PieceChip({
  a,
  stage,
  now,
  selected,
  count,
  onPick,
}: {
  a: TeamAssignment;
  stage: TeamStage;
  now: number;
  selected: boolean;
  count: number;
  onPick: () => void;
}) {
  const state = chipState(a);
  const label = cellLabel(a, stage, now);
  const quiet = state === "pending" || state === "skipped";
  return (
    <button
      aria-pressed={selected}
      aria-label={`${a.workerName}, ${TEAM_STAGE_LABEL[stage.kind]} "${stage.title}": ${label}${count ? `, ${count} comment${count === 1 ? "" : "s"}` : ""}`}
      title={`${a.workerName}: ${a.ask}${a.error ? `\n\n${a.error}` : ""}`}
      onClick={onPick}
      className={
        "flex w-full min-w-0 items-center gap-1.5 rounded-md border px-2 py-1.5 text-left text-xs transition-colors " +
        (selected
          ? "border-accent bg-accent/15 text-ink"
          : quiet
            ? "border-transparent text-ink-faint hover:text-ink-muted"
            : state === "failed"
              ? "border-transparent bg-red-500/10 text-red-700 dark:text-red-300 hover:bg-red-500/15"
              : state === "waiting"
                ? "border-transparent bg-violet-400/10 text-violet-700 dark:text-violet-300 hover:bg-violet-400/15"
                : "border-transparent bg-card text-ink hover:bg-card-strong")
      }
    >
      <span aria-hidden className={"h-1.5 w-1.5 shrink-0 rounded-full " + DOT[state]} />
      <span className={"min-w-0 flex-1 truncate " + (state === "skipped" ? "line-through" : "")}>{label}</span>
      {count > 0 && <span className="shrink-0 rounded-full bg-amber-400/20 px-1.5 text-[10.5px] font-bold text-amber-700 dark:text-amber-400">{count}</span>}
    </button>
  );
}

/// The coordinator's draft or pack in its lane: opens the file once written.
function DocChip({
  task,
  stage,
  now,
  selected,
  onPick,
  onOpen,
}: {
  task: TeamTask;
  stage: TeamStage;
  now: number;
  selected: boolean;
  onPick: () => void;
  onOpen?: () => void;
}) {
  const pack = stage.kind === "synthesize";
  const ms = stageMs(stage, now);
  const label = onOpen
    ? pack
      ? `Pack v${task.pack?.version ?? 1}`
      : fileStem(stage.file!)
    : stage.status === "running"
      ? `Writing${ms !== undefined ? ` · ${shortDuration(ms)}` : ""}`
      : stage.status === "failed"
        ? "Failed"
        : stage.status === "skipped"
          ? "Skipped"
          : stage.status === "done"
            ? "Done"
            : "Up next";
  const quiet = !onOpen && stage.status !== "running" && stage.status !== "failed";
  return (
    <button
      aria-pressed={selected}
      title={onOpen ? `Open ${stage.file}` : stage.ask ?? stage.title}
      onClick={onOpen ?? onPick}
      className={
        "flex w-full min-w-0 items-center gap-1.5 rounded-md border px-2 py-1.5 text-left text-xs transition-colors " +
        (selected
          ? "border-accent bg-accent/15 text-ink"
          : onOpen
            ? pack
              ? "border-emerald-600/50 bg-emerald-500/10 font-semibold text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20"
              : "border-card-strong bg-card text-ink hover:border-accent/60"
            : quiet
              ? "border-transparent text-ink-faint"
              : stage.status === "failed"
                ? "border-transparent bg-red-500/10 text-red-700 dark:text-red-300"
                : "border-transparent bg-card text-ink")
      }
    >
      {onOpen ? (
        <DocGlyph />
      ) : (
        <span aria-hidden className={"h-1.5 w-1.5 shrink-0 rounded-full " + (stage.status === "running" ? "animate-pulse bg-accent" : stage.status === "failed" ? "bg-red-500" : "bg-ink-faint/50")} />
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

function CoordinatorFace() {
  return (
    <span aria-hidden className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-card-strong text-[11px] text-ink-muted">
      ◆
    </span>
  );
}

function GoneFace({ name }: { name: string }) {
  return (
    <span aria-hidden className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-card-strong text-[10px] text-ink-muted">
      {name.slice(0, 2).toUpperCase()}
    </span>
  );
}

const linkBtn = "text-xs text-accent hover:underline disabled:opacity-40 disabled:no-underline";

/// The selected cell, in full: who, which stage and where it stands, what
/// they were asked, and what you can do — read it, watch the run, say
/// something, redo it, retry or skip it.
function CellDetail({
  task,
  cell,
  now,
  counts,
  onOpenFile,
}: {
  task: TeamTask;
  cell: PlanCell;
  now: number;
  counts: Map<string, number>;
  onOpenFile: (name: string) => void;
}) {
  const stage = task.stages[cell.stage];
  const a = cell.lane === COORDINATOR_LANE ? undefined : pieceIn(stage, cell.lane);
  const worker = useWorkersStore((s) => (a ? s.workers[a.workerId] : undefined));
  const redoPiece = useTeamsStore((s) => s.redoPiece);
  const [talk, setTalk] = useState<{ anchor: DOMRect; el: HTMLElement } | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const when = stageWhen(stage, now, clock);
  const where = `${stageWhere(planRounds(task), cell.stage)} · ${stage.title}`;
  const skippable = canSkipStage(task, cell.stage);

  if (!a) {
    const pack = stage.kind === "synthesize";
    const status =
      stage.status === "done" ? `done ${when}` : stage.status === "running" ? `writing · ${when.replace(/^now · /, "")}` : stage.status === "pending" ? "up next" : stage.status;
    return (
      <div className="flex items-start gap-3 border-t border-card bg-surface/40 px-4 py-3">
        <CoordinatorFace />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <b className="text-[13.5px] font-semibold text-ink">Coordinator</b>
            <span className="text-xs text-ink-faint">
              {where} · {status}
            </span>
          </span>
          {stage.ask && <span className="text-[12.5px] leading-relaxed text-ink-muted">{stage.ask}</span>}
          {stage.status === "running" && (
            <span className="text-xs text-ink-muted">
              <CoordinatorActivity
                taskId={task.id}
                stage={cell.stage}
                since={stage.startedAt ?? task.updatedAt}
                reading={`${task.files.filter((f) => !f.name.startsWith("pack/")).length} files in the shared folder`}
              />
            </span>
          )}
          {stage.error && <span className="whitespace-pre-wrap text-xs text-amber-600">{stage.error}</span>}
          <span className="mt-0.5 flex flex-wrap items-center gap-x-4 gap-y-1">
            {stage.status === "done" && stage.file && (
              <button className={linkBtn} onClick={() => onOpenFile(stage.file!)}>
                Open {pack ? `Pack v${task.pack?.version ?? 1}` : fileStem(stage.file)}
              </button>
            )}
            {skippable && <SkipButton taskId={task.id} stage={cell.stage} label="Skip this stage" confirm={stage.status === "running"} />}
          </span>
        </div>
      </div>
    );
  }

  const state = chipState(a);
  const redo = canRedoPiece(task, cell.stage, a.workerId);
  const live = a.status === "pending" || a.status === "running" || a.status === "paused";
  const count = counts.get(pieceKey(cell.stage, a.workerId)) ?? 0;
  const status = state === "done" ? `done ${when}` : cellLabel(a, stage, now).toLowerCase();
  const viewRun = () => {
    if (!a.runId) return;
    useWorkersStore.getState().selectWorker(a.workerId);
    useFlowsStore.getState().setActiveRun(a.runId);
  };
  const openTalk = (el: HTMLElement) => setTalk((t) => (t?.el === el ? null : { el, anchor: el.getBoundingClientRect() }));
  return (
    <div className="flex items-start gap-3 border-t border-card bg-surface/40 px-4 py-3">
      {worker ? <WorkerAvatar worker={worker} size="md" live={a.status === "running"} /> : <GoneFace name={a.workerName} />}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <b className="text-[13.5px] font-semibold text-ink">{a.workerName}</b>
          <span className={"text-xs " + (state === "failed" ? "text-red-700 dark:text-red-300" : state === "waiting" ? "text-violet-700 dark:text-violet-300" : "text-ink-faint")}>
            {where} · {status}
          </span>
          {count > 0 && (
            <span className="inline-flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-400">
              <CommentGlyph /> {count} comment{count === 1 ? "" : "s"}
            </span>
          )}
        </span>
        <span className="text-[12.5px] leading-relaxed text-ink-muted">{a.ask}</span>
        {a.status === "paused" && a.waitingFor && <span className="text-xs text-violet-700 dark:text-violet-300">{a.workerName} {a.waitingFor}.</span>}
        {a.error && <span className="whitespace-pre-wrap text-xs text-amber-600">{a.error}</span>}
        {stage.error && <span className="whitespace-pre-wrap text-xs text-amber-600">{stage.error}</span>}
        {error && (
          <span role="alert" className="text-xs text-red-600 dark:text-red-400">
            {error}
          </span>
        )}
        <span className="mt-0.5 flex flex-wrap items-center gap-x-4 gap-y-1">
          {a.file && (
            <button className={linkBtn} onClick={() => onOpenFile(a.file!)}>
              Read the piece
            </button>
          )}
          {a.status === "paused" && a.runId && <ApprovePieceButton a={a} />}
          {a.runId && (
            <button className={linkBtn} onClick={viewRun}>
              {a.status === "paused" ? "Open the run" : "View the run"}
            </button>
          )}
          <button className={linkBtn} aria-haspopup="dialog" onClick={(e) => openTalk(e.currentTarget)}>
            Say something…
          </button>
          {redo && state !== "failed" && (
            <button className={linkBtn} aria-haspopup="dialog" onClick={(e) => openTalk(e.currentTarget)}>
              Redo with a note
            </button>
          )}
          {redo && state === "failed" && (
            <button
              className={linkBtn}
              disabled={retrying}
              onClick={() => {
                setRetrying(true);
                setError(null);
                void redoPiece(task.id, a.workerId).then((res) => {
                  setRetrying(false);
                  if (!res.ok) setError(res.error);
                });
              }}
            >
              {retrying ? "Starting…" : "Retry"}
            </button>
          )}
          {skippable && live && (
            <SkipButton
              taskId={task.id}
              stage={cell.stage}
              workerId={stage.assignments.length > 1 ? a.workerId : undefined}
              label={stage.assignments.length > 1 ? "Skip this piece" : "Skip this stage"}
              confirm={a.status !== "pending"}
            />
          )}
        </span>
      </div>
      {talk && (
        <CommentPopover
          task={task}
          target={{ kind: "member", workerId: a.workerId, workerName: a.workerName, stageIndex: cell.stage, piece: a }}
          anchor={talk.anchor}
          opener={talk.el}
          onOpenFile={onOpenFile}
          onClose={() => setTalk(null)}
        />
      )}
    </div>
  );
}

/// `pack/PROPOSAL.md` → `PROPOSAL`; `02-ranked-plan-coordinator.md` → `ranked-plan-coordinator`.
function fileStem(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.[^.]+$/, "").replace(/^\d+-/, "");
}

function DocGlyph() {
  return (
    <svg aria-hidden width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" className="shrink-0 opacity-70">
      <path d="M3 1.5h4l2.5 2.5v6.5H3z" />
    </svg>
  );
}

function AssignmentLine({
  a,
  onOpenFile,
  skip,
}: {
  a: TeamAssignment;
  onOpenFile: (name: string) => void;
  /// Where this piece sits, when it can still be skipped on its own. Absent
  /// for a stage with one piece: skipping that is skipping the stage.
  skip?: { taskId: string; stage: number };
}) {
  const worker = useWorkersStore((s) => s.workers[a.workerId]);
  const viewRun = () => {
    if (!a.runId) return;
    useWorkersStore.getState().selectWorker(a.workerId);
    useFlowsStore.getState().setActiveRun(a.runId);
  };
  const state =
    a.status === "done"
      ? "Done"
      : a.status === "skipped"
        ? "Skipped"
        : a.status === "failed"
        ? `Failed${a.error ? `: ${a.error}` : ""}`
        : a.status === "paused"
          ? `Waiting on you${a.waitingFor ? ` — ${a.waitingFor}` : ""}`
          : a.status === "running"
            ? "Working…"
            : "Up next";
  const live = a.status === "pending" || a.status === "running" || a.status === "paused";
  return (
    <div
      className={
        "flex flex-wrap items-center gap-2 rounded-md px-2.5 py-1.5 text-xs " +
        (a.status === "paused" ? "border border-violet-500/40 bg-violet-500/10" : "bg-card")
      }
    >
      {worker && <WorkerAvatar worker={worker} size="xs" live={a.status === "running"} />}
      <b className="font-medium text-ink">{a.workerName}</b>
      <span className={a.status === "failed" ? "text-amber-600" : a.status === "paused" ? "text-violet-600 dark:text-violet-400" : "text-ink-muted"}>
        {state}
      </span>
      <span className="ml-auto flex gap-1">
        {a.file && (
          <button className={quietBtn} onClick={() => onOpenFile(a.file!)}>
            Read
          </button>
        )}
        {a.status === "paused" && a.runId && <ApprovePieceButton a={a} />}
        {a.runId && (
          <button className={quietBtn} onClick={viewRun}>
            {a.status === "paused" ? "Open run" : "View run"}
          </button>
        )}
        {skip && live && (
          <SkipButton
            taskId={skip.taskId}
            stage={skip.stage}
            workerId={a.workerId}
            label="Skip"
            confirm={a.status !== "pending"}
          />
        )}
      </span>
    </div>
  );
}

/// Approve a member's paused piece where you see it, rather than in its
/// run: only for a pause that is asking your OK (an external action), since
/// a question or a failure needs the run open to answer.
function ApprovePieceButton({ a }: { a: TeamAssignment }) {
  const [state, setState] = useState<"idle" | "busy" | string>("idle");
  if (!a.runId || !a.waitingFor?.startsWith("wants your OK")) return null;
  const approve = async () => {
    setState("busy");
    const res = await window.overcli.invoke("flows:resumeRun", { runId: a.runId! }).catch((err: unknown) => ({ ok: false as const, error: String(err) }));
    setState(res.ok ? "busy" : res.error);
  };
  return (
    <>
      <button className={primaryBtn} disabled={state === "busy"} onClick={() => void approve()}>
        {state === "busy" ? "Approving…" : "Approve"}
      </button>
      {state !== "idle" && state !== "busy" && (
        <span role="alert" className="text-xs text-red-600 dark:text-red-400">
          {state}
        </span>
      )}
    </>
  );
}

/// Skip a stage, or one member's piece of it. When that would stop a run
/// mid-way, the first click arms it and the second does it — the run's work
/// so far is lost, and a mis-click should not cost that.
function SkipButton({
  taskId,
  stage,
  workerId,
  label,
  confirm,
}: {
  taskId: string;
  stage: number;
  workerId?: string;
  label: string;
  confirm: boolean;
}) {
  const skip = useTeamsStore((s) => s.skip);
  const busy = useTeamsStore((s) => !!s.busy[taskId]);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      className={armed ? "text-xs px-2 py-1 rounded-md bg-amber-500/15 text-amber-600 hover:bg-amber-500/25 disabled:opacity-40" : quietBtn}
      disabled={busy}
      title={workerId ? "Carry on without this piece" : "Carry on without this stage"}
      onClick={() => {
        if (confirm && !armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        void skip(taskId, stage, workerId);
      }}
    >
      {armed ? "Stop and skip?" : label}
    </button>
  );
}

function WaitingCard({ task, team }: { task: TeamTask; team: Team }) {
  const continueTask = useTeamsStore((s) => s.continueTask);
  const retry = useTeamsStore((s) => s.retry);
  const cancel = useTeamsStore((s) => s.cancel);
  const busy = useTeamsStore((s) => !!s.busy[task.id]);
  const waiting = task.waiting!;
  const top = Math.max(1, Math.round(team.budgetUSDPerTask / 2));
  const stage = task.stages[task.stageIndex];
  const hireFailed = waiting.reason === "failed" && unhired(task).length > 0;
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-violet-400/50 bg-violet-400/10 px-4 py-3">
      <span className="text-xs font-semibold text-ink">
        {waiting.reason === "checkpoint"
          ? "Checkpoint"
          : waiting.reason === "away"
            ? "Crew away"
            : waiting.reason === "budget"
              ? "Budget reached"
              : hireFailed
                ? "A hire needs you"
                : "A stage needs you"}
      </span>
      <p className="text-sm text-ink">{waiting.message}</p>
      <div className="flex flex-wrap gap-2">
        {waiting.reason === "checkpoint" && (
          <button className={primaryBtn} disabled={busy} onClick={() => void continueTask(task.id)}>
            Continue
          </button>
        )}
        {waiting.reason === "away" && (
          <button className={primaryBtn} disabled={busy} onClick={() => void continueTask(task.id)}>
            Start now
          </button>
        )}
        {waiting.reason === "budget" && (
          <button className={primaryBtn} disabled={busy} onClick={() => void continueTask(task.id, top)}>
            Add {money(top)} and continue
          </button>
        )}
        {waiting.reason === "failed" && (
          <>
            <button className={primaryBtn} disabled={busy} onClick={() => void retry(task.id)}>
              Retry
            </button>
            {(hireFailed || stage?.kind !== "synthesize") && (
              <button
                className={secondaryBtn}
                disabled={busy}
                onClick={() => void continueTask(task.id)}
                title={hireFailed ? "Drop their pieces from the plan and start without them" : undefined}
              >
                {hireFailed ? "Continue without them" : "Continue without"}
              </button>
            )}
          </>
        )}
        <button className={quietBtn} disabled={busy} onClick={() => void cancel(task.id)}>
          Cancel task
        </button>
      </div>
    </div>
  );
}

function PackView({ task, onOpenFile }: { task: TeamTask; onOpenFile: (name: string) => void }) {
  const accept = useTeamsStore((s) => s.accept);
  const busy = useTeamsStore((s) => !!s.busy[task.id]);
  const pack = task.pack!;
  return (
    <div className="flex flex-col gap-3">
      {pack.summary && (
        <div className="max-w-3xl text-sm leading-relaxed text-ink">
          <Markdown source={pack.summary} onOpenPath={onOpenFile} />
        </div>
      )}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2.5">
        {pack.files.map((name) => (
          <button
            key={name}
            onClick={() => onOpenFile(name)}
            className="flex flex-col gap-1 rounded-lg border border-card bg-surface-elevated p-3 text-left hover:border-card-strong"
          >
            <span className="font-mono text-xs font-semibold text-ink">{name.replace(/^pack\//, "")}</span>
            <span className="text-[11px] text-ink-faint">Open</span>
          </button>
        ))}
      </div>
      {task.code && <CodeCard task={task} landable />}
      <div className="flex flex-wrap gap-2">
        {task.status === "review" && (
          <button className={primaryBtn} disabled={busy} onClick={() => void accept(task.id)}>
            Approve and file
          </button>
        )}
        <button className={secondaryBtn} onClick={() => void useTeamsStore.getState().openFolder(task.id)}>
          Open folder
        </button>
        <DeleteTaskButton task={task} />
      </div>
    </div>
  );
}

/// Where the task's code is: one branch, in every repo the task works in.
/// Each piece forked from it and merged back; once the pack is in, each repo
/// either pushes it for a pull request or merges it into its base — in your
/// checkout, which has to be on that base and clean, as for any agent branch.
/// Only repos the task changed are listed: a workspace task cuts the branch
/// in every member, and thirty rows of "in progress" hid the two that mattered.
function CodeCard({ task, landable }: { task: TeamTask; landable: boolean }) {
  const landCode = useTeamsStore((s) => s.landCode);
  const pushCode = useTeamsStore((s) => s.pushCode);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const code = task.code!;
  // Uncounted (older tasks, or git could not say) stays listed.
  const changed = code.repos.filter((r) => r.ahead !== 0 || r.landed);
  const untouched = code.repos.length - changed.length;
  const openLink = (url: string) => void window.overcli.invoke("app:openExternal", url);
  // Folded while the team works: a long repo list pushes the plan off screen.
  // Open once there is something to push or merge.
  const [open, setOpen] = useState(landable);
  useEffect(() => {
    if (landable) setOpen(true);
  }, [landable]);
  return (
    <section className="flex flex-col gap-2 rounded-xl border border-card bg-surface-elevated px-4 py-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="group flex flex-wrap items-baseline justify-between gap-2 text-left"
      >
        <span className="flex items-center gap-1.5 text-xs font-semibold text-ink">
          <svg aria-hidden width="8" height="8" viewBox="0 0 8 8" className={`text-ink-faint transition-transform ${open ? "rotate-90" : ""}`}>
            <path d="M2 1l4 3-4 3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Code · <span className="font-mono font-normal text-ink-muted">{code.branch}</span>
          <span className="font-normal text-ink-faint">
            {changed.length} repo{changed.length === 1 ? "" : "s"}
          </span>
        </span>
        <span className="text-[11px] text-ink-faint group-hover:text-ink-muted">
          {landable
            ? "Every piece merged here. Push it for a pull request, or merge it into each repo."
            : "Each piece starts from this branch and merges back into it."}
        </span>
      </button>
      {!open ? null : changed.length === 0 ? (
        <span className="text-[11px] text-ink-faint">No commits on this branch yet.</span>
      ) : (
        <ul className="flex flex-col divide-y divide-card">
          {changed.map((repo) => (
            <li key={repo.projectPath} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
              <span className="text-sm text-ink">
                {repo.name}{" "}
                <span className="text-[11px] text-ink-faint">
                  {repo.ahead ? `${repo.ahead} commit${repo.ahead === 1 ? "" : "s"} ` : ""}from {repo.base}
                </span>
              </span>
              {repo.landed ? (
                <span className="text-xs text-emerald-500">Merged into {repo.base}</span>
              ) : landable ? (
                <span className="flex items-center gap-2">
                  {repo.pushed?.url && (
                    <button className={primaryBtn} onClick={() => openLink(repo.pushed!.url!)}>
                      Open pull request
                    </button>
                  )}
                  <button
                    className={repo.pushed?.url ? secondaryBtn : primaryBtn}
                    disabled={busy !== null}
                    title={`git push -u origin ${code.branch}, from the task's own checkout`}
                    onClick={async () => {
                      setBusy(`push:${repo.projectPath}`);
                      setNote(null);
                      const res = await pushCode(task.id, repo.projectPath);
                      setBusy(null);
                      if (res.ok) setNote(res.message);
                    }}
                  >
                    {busy === `push:${repo.projectPath}` ? "Pushing…" : repo.pushed ? "Push again" : "Push"}
                  </button>
                  <button
                    className={secondaryBtn}
                    disabled={busy !== null}
                    onClick={async () => {
                      setBusy(`land:${repo.projectPath}`);
                      setNote(null);
                      const res = await landCode(task.id, repo.projectPath);
                      setBusy(null);
                      if (res.ok) setNote(res.message);
                    }}
                  >
                    {busy === `land:${repo.projectPath}` ? "Merging…" : `Merge into ${repo.base}`}
                  </button>
                </span>
              ) : (
                <span className="text-[11px] text-ink-faint">in progress</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {open && untouched > 0 && (
        <span className="text-[11px] text-ink-faint">
          {untouched} other repo{untouched === 1 ? "" : "s"} in this workspace {untouched === 1 ? "has" : "have"} no changes.
        </span>
      )}
      {note && <span className="text-[11px] text-emerald-500">{note}</span>}
    </section>
  );
}

function FailedCard({ task }: { task: TeamTask }) {
  const retry = useTeamsStore((s) => s.retry);
  const busy = useTeamsStore((s) => !!s.busy[task.id]);
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-amber-500/50 bg-amber-500/10 px-4 py-3">
      <span className="text-sm text-ink">{task.error ?? "The task failed."}</span>
      <div className="flex gap-2">
        {task.stages.length === 0 && (
          <button className={primaryBtn} disabled={busy} onClick={() => void retry(task.id)}>
            Plan again
          </button>
        )}
        <DeleteTaskButton task={task} />
      </div>
    </div>
  );
}

function DeleteTaskButton({ task }: { task: TeamTask }) {
  const deleteTask = useTeamsStore((s) => s.deleteTask);
  const busy = useTeamsStore((s) => !!s.busy[task.id]);
  if (isTaskActive(task.status) && task.status !== "waiting" && task.status !== "questions" && task.status !== "proposed") return null;
  return (
    <button
      className={quietBtn}
      disabled={busy}
      onClick={() => {
        if (window.confirm("Delete this task and its shared folder?")) void deleteTask(task.id);
      }}
    >
      Delete task
    </button>
  );
}

function FolderPanel({ task, viewing, onOpen }: { task: TeamTask; viewing: string | null; onOpen: (name: string) => void }) {
  const sections = useMemo(() => folderSections(task), [task]);
  // Past the first pack, the pack is read as what its latest version
  // changed; the pieces, as one row per stage.
  const changes = useMemo(() => packChangeCard(task), [task]);
  const groups = useMemo(() => pieceGroups(task), [task]);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-ink">
          Shared folder <span className="font-normal text-ink-faint">· {task.files.length}</span>
        </h3>
        <button
          className={quietBtn + " inline-flex items-center gap-1"}
          title="Show the folder in Finder"
          onClick={() => void useTeamsStore.getState().openFolder(task.id)}
        >
          <FolderGlyph /> Open
        </button>
      </div>
      {sections.length === 0 ? (
        <p className="rounded-lg border border-dashed border-card-strong px-3 py-3 text-[11px] leading-relaxed text-ink-faint">
          Empty for now. Each member's work lands here as it finishes, and every later stage reads it.
        </p>
      ) : (
        sections.map((section) =>
          section.id === "pack" && changes ? (
            <PackChanges key="pack" card={changes} viewing={viewing} onOpen={onOpen} />
          ) : section.id === "pieces" ? (
            <PieceStages key="pieces" groups={groups} count={section.items.length} viewing={viewing} onOpen={onOpen} />
          ) : (
          <details key={section.id} open={!section.collapsed} className="group/section flex flex-col">
            <summary className="flex cursor-pointer select-none list-none items-center gap-1.5 px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint hover:text-ink-muted [&::-webkit-details-marker]:hidden">
              <svg aria-hidden width="8" height="8" viewBox="0 0 8 8" className="transition-transform group-open/section:rotate-90">
                <path d="M2 1l4 3-4 3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {section.title}
              <span className="font-normal normal-case tracking-normal">{section.items.length}</span>
              {section.note && (
                <span className="ml-auto font-normal normal-case tracking-normal" title="Version and last update">
                  {section.note}
                </span>
              )}
            </summary>
            <div className="flex flex-col gap-0.5">
              {section.items.map((item) => (
                <FolderEntry key={item.name} item={item} active={viewing === item.name} onOpen={() => onOpen(item.name)} />
              ))}
            </div>
          </details>
          ),
        )
      )}
    </div>
  );
}

/// "Changed in vN": the files the latest pack update changed, the first few
/// shown and the rest of the pack a click away.
function PackChanges({
  card,
  viewing,
  onOpen,
}: {
  card: NonNullable<ReturnType<typeof packChangeCard>>;
  viewing: string | null;
  onOpen: (name: string) => void;
}) {
  const [all, setAll] = useState(false);
  const rows = all ? [...card.shown, ...card.more] : card.shown;
  return (
    <section aria-label={`Changed in v${card.version}`} className="flex flex-col gap-1 rounded-xl border border-card bg-surface-elevated p-2.5">
      <span className="flex items-center gap-1.5 px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
        {card.changedCount === 0 ? `The pack · v${card.version}` : `Changed in v${card.version}`}
        <span className="ml-auto font-normal normal-case tracking-normal" title="When this version was written">
          {card.note}
        </span>
      </span>
      {card.changedCount === 0 && !all && (
        <span className="px-1 text-[11px] text-ink-faint">No file changed in this version.</span>
      )}
      {rows.map((item) => (
        <FolderEntry key={item.name} item={item} active={viewing === item.name} onOpen={() => onOpen(item.name)} />
      ))}
      {card.more.length > 0 && (
        <button className="self-start px-1 pt-0.5 text-xs font-semibold text-accent hover:underline" aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? "Show only what changed" : `${card.more.length} more file${card.more.length === 1 ? "" : "s"} in the pack`}
        </button>
      )}
    </section>
  );
}

/// Who did what: one row per stage, with everyone who worked it and when.
/// A stage with one file opens it; one with more opens to its files.
function PieceStages({
  groups,
  count,
  viewing,
  onOpen,
}: {
  groups: PieceGroup[];
  count: number;
  viewing: string | null;
  onOpen: (name: string) => void;
}) {
  const [opened, setOpened] = useState<string | null>(null);
  return (
    <section aria-label="Who did what" className="flex flex-col">
      <span className="flex items-center gap-1.5 px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
        Who did what
        <span className="font-normal normal-case tracking-normal">
          {count} piece{count === 1 ? "" : "s"}
        </span>
      </span>
      <div className="flex flex-col gap-0.5">
        {groups.map((g) => {
          const one = g.files.length === 1;
          const isOpen = opened === g.key;
          const active = g.files.some((f) => f.name === viewing);
          return (
            <div key={g.key} className="flex flex-col">
              <button
                onClick={() => (one ? onOpen(g.files[0].name) : setOpened(isOpen ? null : g.key))}
                aria-expanded={one ? undefined : isOpen}
                title={one ? g.files[0].name : `${g.files.length} pieces: ${g.authors.join(", ")}`}
                className={
                  "flex min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors " +
                  (active && one ? "bg-accent/10 ring-1 ring-accent/30" : "hover:bg-card-strong")
                }
              >
                <span aria-hidden className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md bg-card text-[11px] font-bold text-ink-muted">
                  {g.stage ?? "·"}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-xs text-ink">{g.title}</span>
                  <span className="truncate text-[10.5px] text-ink-faint">{g.when}</span>
                </span>
                <AuthorStack names={g.authors} />
              </button>
              {isOpen && (
                <div className="ml-7 flex flex-col gap-0.5 border-l border-card pl-1.5">
                  {g.files.map((item) => (
                    <FolderEntry key={item.name} item={item} active={viewing === item.name} onOpen={() => onOpen(item.name)} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/// Faces of the people who wrote something, overlapped; the coordinator as
/// its mark.
function AuthorStack({ names }: { names: string[] }) {
  const workers = useWorkersStore((s) => s.workers);
  const shown = names.slice(0, 4);
  return (
    <span className="flex shrink-0" aria-label={names.join(", ")}>
      {shown.map((name, i) => {
        const w = Object.values(workers).find((x) => x.name === name);
        return (
          <span key={name} title={name} className={"flex rounded-full ring-2 ring-surface " + (i ? "-ml-1.5" : "")}>
            {name === "Coordinator" ? <CoordinatorFace /> : w ? <WorkerAvatar worker={w} size="xs" untitled /> : <GoneFace name={name} />}
          </span>
        );
      })}
      {names.length > shown.length && <span className="ml-1 text-[10.5px] text-ink-faint">+{names.length - shown.length}</span>}
    </span>
  );
}

function FolderEntry({ item, active, onOpen }: { item: FolderItem; active: boolean; onOpen: () => void }) {
  const worker = useWorkersStore((s) => Object.values(s.workers).find((w) => w.name === item.author));
  return (
    <button
      onClick={onOpen}
      title={`${item.name} · last written ${new Date(item.at).toLocaleString()}${isReadableInDesk(item.name) ? "" : " — opens in its app"}`}
      className={
        "group flex min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors " +
        (active ? "bg-accent/10 ring-1 ring-accent/30" : "hover:bg-card-strong")
      }
    >
      <FileGlyph kind={item.kind} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-xs text-ink">{item.label}</span>
          {item.fresh && (
            <span
              className="shrink-0 rounded bg-accent/15 px-1 text-[9.5px] font-medium uppercase tracking-wide text-accent"
              title="Rewritten by the latest pack update"
            >
              Updated
            </span>
          )}
        </span>
        <span className="flex min-w-0 items-center gap-1 text-[10.5px] text-ink-faint">
          {worker && <WorkerAvatar worker={worker} size="xs" untitled />}
          <span className="truncate">{item.detail}</span>
        </span>
      </span>
      {!isReadableInDesk(item.name) && (
        <svg aria-label="Opens outside the desk" width="10" height="10" viewBox="0 0 10 10" className="shrink-0 text-ink-faint opacity-0 group-hover:opacity-100">
          <path d="M4 2H2v6h6V6M6 2h2v2M8 2L4.5 5.5" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}

/// One small glyph per kind of file, so a page you open in the browser reads
/// differently from a document you read here.
function FileGlyph({ kind }: { kind: FolderItem["kind"] }) {
  const tone =
    kind === "page" ? "text-sky-600 dark:text-sky-400" : kind === "image" ? "text-emerald-700 dark:text-emerald-400" : kind === "data" ? "text-amber-700 dark:text-amber-400" : "text-ink-faint";
  return (
    <span className={`flex h-7 w-6 shrink-0 items-center justify-center rounded border border-card bg-card ${tone}`} aria-hidden>
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round">
        {kind === "page" ? (
          <>
            <circle cx="6" cy="6" r="4.5" />
            <path d="M1.5 6h9M6 1.5c1.4 1.3 1.4 7.7 0 9M6 1.5c-1.4 1.3-1.4 7.7 0 9" />
          </>
        ) : kind === "image" ? (
          <>
            <rect x="1.5" y="2" width="9" height="8" rx="1" />
            <circle cx="4.2" cy="4.7" r="0.9" />
            <path d="M2 9l2.8-2.6L7 8.3l1.5-1.4L10.5 9" />
          </>
        ) : kind === "data" ? (
          <path d="M2 3h8M2 6h8M2 9h8M5 2v8" />
        ) : (
          <path d="M3.5 4.5h5M3.5 6.5h5M3.5 8.5h3" />
        )}
      </svg>
    </span>
  );
}

function FolderGlyph() {
  return (
    <svg aria-hidden width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round">
      <path d="M1.5 3.5h3l1 1h5v5.5h-9z" />
    </svg>
  );
}

/// The stage kinds a plan is built from. Not a sequence: the coordinator
/// picks and orders them for each brief, so this is a vocabulary.
function StageKinds() {
  return (
    <section aria-label="What a plan is made of" className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">What a plan is made of</h2>
        <span className="text-[11px] text-ink-faint">
          The coordinator picks and orders these for each brief, up to {TEAM_MAX_STAGES} stages. Every plan ends in a final pack.
        </span>
      </div>
      <ul className="flex flex-wrap gap-2">
        {KIND_ORDER.map((kind) => (
          <li
            key={kind}
            className="flex items-center gap-2 rounded-full border border-card bg-surface-elevated px-3 py-1.5 text-[11px] text-ink-faint"
          >
            <KindMark kind={kind} />
            <b className="font-semibold text-ink">{TEAM_STAGE_LABEL[kind]}</b>
            {STAGE_KIND_BLURB[kind]}
          </li>
        ))}
      </ul>
    </section>
  );
}

/// The order they usually come in — members first, the pack last.
const KIND_ORDER: TeamStageKind[] = ["contribute", "draft", "challenge", "respond", "synthesize"];

const STAGE_KIND_BLURB: Record<TeamStageKind, string> = {
  contribute: "members produce, in parallel",
  draft: "the coordinator combines what exists",
  challenge: "ranked objections",
  respond: "resolve, accept as risk, or cut",
  synthesize: "the final pack, always last",
};

/// One mark per stage kind: round for the members' stages, square for the
/// coordinator's, so a plan's shape reads at a glance.
function KindMark({ kind }: { kind: TeamStageKind }) {
  const tone =
    kind === "contribute"
      ? "bg-blue-400"
      : kind === "challenge"
        ? "bg-orange-500"
        : kind === "respond"
          ? "bg-amber-200"
          : kind === "synthesize"
            ? "bg-emerald-500"
            : "bg-ink-faint";
  return <span aria-hidden className={`h-2 w-2 shrink-0 ${isMemberStage(kind) ? "rounded-full" : "rounded-[2px]"} ${tone}`} />;
}

function FileViewer({
  task,
  name,
  onOpenFile,
  focus,
}: {
  task: TeamTask;
  name: string;
  onOpenFile: (name: string) => void;
  /// A commented passage to bring into view.
  focus?: { quote: string; n: number } | null;
}) {
  const readFile = useTeamsStore((s) => s.readFile);
  const content = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<{ body?: string; error?: string }>({});
  useEffect(() => {
    let live = true;
    setState({});
    void readFile(task.id, name).then((res) => {
      if (live) setState(res.ok ? { body: res.body } : { error: res.error });
    });
    return () => {
      live = false;
    };
  }, [task.id, name, readFile, task.updatedAt]);
  return (
    <div className="flex flex-col gap-3">
      <FileComments task={task} file={name} content={content} ready={state.body !== undefined} focus={focus} />
      {state.error ? (
        <div className="text-xs text-red-500">{state.error}</div>
      ) : state.body === undefined ? (
        <div className="text-xs text-ink-faint">Loading…</div>
      ) : (
        <div ref={content} tabIndex={-1} className="rounded-xl border border-card bg-surface-elevated px-5 py-4 outline-none">
          <Markdown source={state.body} onOpenPath={onOpenFile} />
        </div>
      )}
    </div>
  );
}

/// What a coordinator turn is doing right now. Before the first word it is
/// reading and thinking — on the strongest model, with every piece in front
/// of it, that can be minutes — so the clock is what says it is alive. Once
/// it writes, the count and the latest lines show the work arriving.
function CoordinatorActivity({
  taskId,
  stage,
  since,
  reading,
  who,
}: {
  taskId: string;
  stage: number | null | "room";
  since: number;
  reading: string;
  /// Who is speaking, when it is not the coordinator's own stage.
  who?: string;
}) {
  const now = useTickingNow(1000);
  const progress = useTeamsStore((s) => s.progress[taskId]);
  const live = progress && progress.stage === stage ? progress : undefined;
  const [open, setOpen] = useState(true);
  const elapsed = formatElapsed(now - since);
  const words = live ? Math.round(live.chars / 5.5) : 0;
  return (
    <span className="flex w-full flex-col gap-1.5">
      <span className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
        {live && live.chars > 0 ? (
          <>
            {who ? `${who} is answering` : "Writing"} · about {words.toLocaleString()} words so far · {elapsed}
            <button className={quietBtn} onClick={() => setOpen((o) => !o)}>
              {open ? "Hide" : "Show"} text
            </button>
          </>
        ) : (
          <>{who ? `${who} is reading ` : "Reading "}{reading} and thinking · {elapsed}</>
        )}
      </span>
      {live && live.chars > 0 && open && (
        <span className="block max-h-48 overflow-hidden whitespace-pre-wrap rounded-md border border-card bg-card px-3 py-2 text-left font-mono text-[11px] leading-relaxed text-ink-muted [mask-image:linear-gradient(to_bottom,transparent,black_30%)]">
          {live.tail.split("\n").slice(-12).join("\n")}
        </span>
      )}
    </span>
  );
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return m > 0 ? `${m}m ${String(sec).padStart(2, "0")}s` : `${sec}s`;
}

/// Talking with the team once the pack is written. You ask; the coordinator
/// picks who answers (or @Name picks them); members answer as themselves and
/// may answer each other; the coordinator says where it landed.
function TeamRoom({
  task,
  team,
  onOpenFile,
  newFrom,
}: {
  task: TeamTask;
  team: Team;
  onOpenFile: (name: string) => void;
  /// Index of the first message that arrived since you last read the room.
  newFrom: number | null;
}) {
  const roomAsk = useTeamsStore((s) => s.roomAsk);
  const roomContinue = useTeamsStore((s) => s.roomContinue);
  const roomStop = useTeamsStore((s) => s.roomStop);
  const updatePack = useTeamsStore((s) => s.updatePack);
  const sending = useTeamsStore((s) => !!s.busy[task.id]);
  const workers = useWorkersStore((s) => s.workers);
  const rootPath = useWorkersStore((s) => s.workers[team.members[0]?.workerId ?? ""]?.projectPath);
  const draftKey = `team-room:${task.id}`;
  const messages = task.room?.messages ?? [];
  const busy = task.room?.busy ?? null;
  const queue = task.room?.queue ?? [];
  const unfolded = unfoldedExchanges(task);
  const canDebate = canKeepDebating(task);
  const names = team.members.map((m) => workers[m.workerId]?.name).filter(Boolean);
  const setDraft = useStore((s) => s.setDraft);
  const draft = useStore((s) => s.conversationDrafts[draftKey] ?? "");
  /// Bumped to put the caret in the composer: "Reply to <name>".
  const [focusSignal, setFocusSignal] = useState(0);
  const replyTo = (name: string) => {
    const tag = `@${name}`;
    const rest = draft.trim();
    setDraft(draftKey, rest.toLowerCase().startsWith(tag.toLowerCase()) ? `${rest} ` : `${tag} ${rest}${rest ? " " : ""}`);
    setFocusSignal((n) => n + 1);
  };
  const send = useComposerSend(draftKey, (text, attachments) => {
    stickToEnd.current = true;
    return roomAsk(task.id, text, attachments);
  });
  const working = task.status === "running" || task.status === "waiting" ? task.stages[task.stageIndex] : undefined;
  const workingOn = working?.fromRoom
    ? `${working.assignments.map((a) => a.workerName).join(" and ")} ${working.assignments.length === 1 ? "is" : "are"} working on "${working.title}" — they'll report back here. Ask anything meanwhile…`
    : null;
  const idle = !busy && !workingOn && (task.status === "review" || task.status === "done");

  const exchanges = useMemo(() => groupExchanges(messages), [messages]);
  const indexOf = useMemo(() => new Map(messages.map((m, i) => [m.id, i])), [messages]);
  // Every exchange but the latest folds to a line. Ones holding something
  // new start open, so the "new" line is never hidden inside a fold.
  const [opened, setOpened] = useState<Set<number>>(
    () =>
      new Set(
        newFrom === null
          ? []
          : exchanges.filter((ex) => ex.messages.some((m) => (indexOf.get(m.id) ?? -1) >= newFrom)).map((ex) => ex.n),
      ),
  );
  const [showAll, setShowAll] = useState(false);
  const earlier = exchanges.slice(0, -1);
  const latest = exchanges.at(-1);
  const hiddenCount = showAll ? 0 : Math.max(0, earlier.length - EARLIER_SHOWN);
  const toggle = (n: number) =>
    setOpened((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });

  // Follow the conversation while you are at its end; when you have scrolled
  // up to read, stay put and say what arrived instead.
  const endRef = useRef<HTMLDivElement>(null);
  const newRef = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const stickToEnd = useRef(false);
  const [arrived, setArrived] = useState(0);
  useEffect(() => {
    const el = endRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => {
      atEnd.current = entry.isIntersecting;
      if (entry.isIntersecting) setArrived(0);
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const toEnd = (smooth: boolean) => {
    const box = scrollerOf(endRef.current);
    box?.scrollTo({ top: box.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  };
  // Opening the tab lands on the first new message, else the end.
  useEffect(() => {
    const box = scrollerOf(endRef.current);
    if (!box) return;
    const line = newRef.current;
    if (line) {
      box.scrollTop += line.getBoundingClientRect().top - box.getBoundingClientRect().top - STICKY_TOP_PX;
    } else {
      box.scrollTop = box.scrollHeight;
    }
  }, []);
  const count = messages.length;
  const seenCount = useRef(count);
  useEffect(() => {
    const added = count - seenCount.current;
    seenCount.current = count;
    if (added <= 0) return;
    if (atEnd.current || stickToEnd.current) {
      stickToEnd.current = false;
      toEnd(true);
    } else {
      setArrived((n) => n + added);
    }
  }, [count]);
  const jumpToEnd = () => {
    setArrived(0);
    toEnd(true);
  };

  const renderMessages = (list: TeamMessage[]) =>
    list.map((m) => (
      <div key={m.id} className="flex flex-col gap-3">
        {newFrom !== null && indexOf.get(m.id) === newFrom && <NewSinceLine innerRef={newRef} />}
        <RoomMessage
          message={m}
          task={task}
          canHandOff={idle}
          onOpenFile={onOpenFile}
          to={repliesTo(messages, indexOf.get(m.id) ?? -1)}
          onReply={replyTo}
        />
      </div>
    ));

  return (
    <section className="flex flex-1 flex-col gap-3" aria-label="Conversation with the team">
      {messages.length === 0 ? (
        <p className="text-xs text-ink-muted">
          Ask anything about the work. Use @{names[0] ?? "Name"} to ask someone directly, or @everyone — or ask someone
          to make or change something and they'll do it as a real run.
        </p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {hiddenCount > 0 && (
            <button
              className="self-center rounded-full border border-card-strong px-3 py-1 text-xs text-ink-muted hover:text-ink"
              onClick={() => setShowAll(true)}
            >
              Show {hiddenCount} earlier exchange{hiddenCount === 1 ? "" : "s"}
            </button>
          )}
          {earlier.slice(hiddenCount).map((ex) =>
            opened.has(ex.n) ? (
              <div key={ex.n} className="flex flex-col gap-3 rounded-xl border border-card-strong bg-surface-elevated p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-ink-faint">
                    Exchange {ex.n + 1} · {clockOrDay(ex.messages.at(-1)!.at)}
                  </span>
                  <button className={quietBtn} onClick={() => toggle(ex.n)}>
                    Collapse
                  </button>
                </div>
                {renderMessages(ex.messages)}
              </div>
            ) : (
              <ExchangeRow key={ex.n} exchange={ex} onOpen={() => toggle(ex.n)} />
            ),
          )}
          {latest && <div className="mt-2 flex flex-col gap-3">{renderMessages(latest.messages)}</div>}
        </div>
      )}

      {busy && (
        <div className="flex flex-col gap-1.5 rounded-lg bg-card px-3 py-2">
          <CoordinatorActivity
            taskId={task.id}
            stage="room"
            since={busy.since}
            reading={busy.speaker === "Coordinator" ? "the conversation" : `${busy.speaker}'s work and the pack`}
            who={busy.speaker}
          />
          <button className={quietBtn + " self-start"} onClick={() => void roomStop(task.id)}>
            Stop
          </button>
        </div>
      )}
      {/* What you sent while someone was answering: each goes in by itself
          once the room is free, and leaves this list when it's taken. */}
      {queue.length > 0 && (
        <ul className="flex flex-col items-end gap-1.5" aria-label="Queued questions">
          {queue.map((q, i) => (
            <li key={`${q.at}-${i}`} className="flex max-w-xl flex-col items-end gap-1">
              <span className="whitespace-pre-wrap rounded-2xl rounded-br-sm border border-dashed border-accent/50 bg-accent/10 px-3.5 py-2 text-sm text-ink">
                {q.text}
              </span>
              <span className="flex items-center gap-1.5 text-[10.5px] text-ink-faint">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-ink-faint" />
                Queued · goes in when the coordinator finishes
              </span>
            </li>
          ))}
        </ul>
      )}
      {/* Pinned to the bottom of the column: however long the conversation,
          what you type next is where you are. */}
      <div className="sticky bottom-0 z-10 -mx-6 mt-auto flex flex-col gap-2 border-t border-card bg-surface px-6 pb-4 pt-3">
        {arrived > 0 && (
          <button
            onClick={jumpToEnd}
            className="absolute -top-12 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-accent px-3.5 py-1.5 text-xs text-white shadow-lg hover:opacity-90"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 5v14" />
              <path d="M19 12l-7 7-7-7" />
            </svg>
            {arrived} new · jump to latest
          </button>
        )}
        {task.continuedAs ? (
          <ContinuedNotice task={task} />
        ) : (
          <>
        {(canDebate || unfolded > 0) && !workingOn && (
          <div className="flex flex-wrap gap-2">
            {canDebate && (
              <button className={secondaryBtn} disabled={!!busy || sending} onClick={() => void roomContinue(task.id)}>
                Keep debating
              </button>
            )}
            {unfolded > 0 && (
              <button
                className={secondaryBtn}
                disabled={!!busy || sending}
                title="Have the coordinator revise the pack with what this conversation settled. The current version is kept."
                onClick={() => void updatePack(task.id)}
              >
                Update the pack · {unfolded} exchange{unfolded === 1 ? "" : "s"} not in it
              </button>
            )}
          </div>
        )}
        <Composer
          draftKey={draftKey}
          variant="compact"
          strongBorder
          rootPath={rootPath}
          autoFocus={focusSignal > 0}
          focusSignal={focusSignal}
          // Stays a normal input while someone answers: what you send waits
          // its turn. The answer and its Stop live in the conversation above.
          disabled={sending}
          disabledPlaceholder="Sending…"
          attachDisabled={busy ? `Attach files once ${busy.speaker} finishes answering — a question with files can't wait in line.` : undefined}
          placeholder={
            busy
              ? `${busy.speaker} is answering — write anyway; it goes in when they finish.`
              : (workingOn ??
                "Ask the team, or ask someone to make or change something… e.g. @Lena redo the settings mockup against the real billing screen.")
          }
          onSend={send}
        />
          </>
        )}
      </div>
      {/* The very end of the column, below the composer: in view only when
          you have scrolled all the way down. */}
      <div ref={endRef} className="h-px" aria-hidden />
    </section>
  );
}

/// The box that scrolls this element: the task column. Scrolling it
/// directly, rather than with `scrollIntoView`, leaves every box around it
/// where it was — the page jumped under you when they moved too.
function scrollerOf(el: HTMLElement | null): HTMLElement | null {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

/// Bring an element of the task column into view by scrolling the column
/// itself (see `scrollerOf`); `focus` puts the caret in its first field.
function scrollToId(id: string, focus = false): void {
  const el = document.getElementById(id);
  if (!el) return;
  const box = scrollerOf(el);
  if (box) box.scrollTo({ top: box.scrollTop + el.getBoundingClientRect().top - box.getBoundingClientRect().top - 16, behavior: "smooth" });
  if (focus) el.querySelector<HTMLElement>("textarea, input, button")?.focus({ preventScroll: true });
}

/// Room for the sticky tabs above something scrolled to the top.
const STICKY_TOP_PX = 64;

/// Earlier exchanges shown as lines before "Show N earlier".
const EARLIER_SHOWN = 3;

function clockOrDay(at: number): string {
  const d = new Date(at);
  const today = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === today.toDateString() ? time : `${relativeDay(at)} ${time}`;
}

function ExchangeRow({ exchange, onOpen }: { exchange: Exchange; onOpen: () => void }) {
  const workers = useWorkersStore((s) => s.workers);
  const asked = exchange.messages.find((m) => m.speaker.kind === "you");
  const replies = exchange.messages.filter((m) => m.speaker.kind !== "you" && !m.failed);
  const outcome = exchangeOutcome(exchange.messages);
  const faces = [...new Set(replies.flatMap((m) => (m.speaker.kind === "member" ? [m.speaker.workerId] : [])))]
    .map((id) => workers[id])
    .filter(Boolean);
  const label = { landed: "Landed:", work: "Work done:", proposed: "Proposed:", open: "Last:" }[outcome.kind];
  return (
    <button
      onClick={onOpen}
      aria-expanded={false}
      className="flex w-full items-start gap-3 rounded-lg border border-card bg-surface-elevated px-3.5 py-2.5 text-left hover:border-card-strong"
    >
      <span className="w-5 shrink-0 pt-0.5 text-[11px] text-ink-faint">{exchange.n + 1}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="line-clamp-1 text-[13px] text-ink">
          {asked ? `You: ${plainLine(asked.text)}` : "The team kept debating"}
        </span>
        <span className="line-clamp-1 text-xs text-ink-muted">
          <b
            className={
              "font-semibold " +
              (outcome.kind === "landed" ? "text-accent" : outcome.kind === "work" ? "text-emerald-500" : "text-ink-muted")
            }
          >
            {label}
          </b>{" "}
          {outcome.text}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2 text-[11px] text-ink-faint">
        <span className="flex">
          {faces.slice(0, 3).map((w, i) => (
            <span key={w!.id} className={i > 0 ? "-ml-1.5" : ""}>
              <WorkerAvatar worker={w!} size="xs" />
            </span>
          ))}
        </span>
        {replies.length} repl{replies.length === 1 ? "y" : "ies"} · {clockOrDay(exchange.messages.at(-1)!.at)}
        <span aria-hidden>›</span>
      </span>
    </button>
  );
}

function NewSinceLine({ innerRef }: { innerRef: React.Ref<HTMLDivElement> }) {
  return (
    <div ref={innerRef} role="separator" className="flex items-center gap-2.5">
      <span className="h-px flex-1 bg-accent/50" />
      <span className="text-[10.5px] font-semibold uppercase tracking-wider text-accent">New since you were here</span>
      <span className="h-px flex-1 bg-accent/50" />
    </div>
  );
}

function RoomMessage({
  message,
  task,
  canHandOff,
  onOpenFile,
  to,
  onReply,
}: {
  message: TeamMessage;
  task: TeamTask;
  canHandOff: boolean;
  onOpenFile: (name: string) => void;
  /// Who it answers, when that can be told: see `repliesTo`.
  to: string[];
  onReply: (name: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const worker = useWorkersStore((s) => (message.speaker.kind === "member" ? s.workers[message.speaker.workerId] : undefined));
  const roomHandOff = useTeamsStore((s) => s.roomHandOff);
  const roomAllowTools = useTeamsStore((s) => s.roomAllowTools);
  const sending = useTeamsStore((s) => !!s.busy[task.id]);
  const offerHandOff =
    canHandOff && message.speaker.kind === "member" && !message.failed && !message.workReport;
  if (message.speaker.kind === "you") {
    return (
      <div className="flex max-w-2xl flex-col items-end gap-1.5 self-end">
        <div className="whitespace-pre-wrap rounded-2xl rounded-br-sm bg-accent px-4 py-2 text-sm text-white">
          {message.text}
        </div>
        <AttachmentChips names={message.attachments} onOpenFile={onOpenFile} />
      </div>
    );
  }
  const name = message.speaker.kind === "member" ? message.speaker.name : "Coordinator";
  // A member's reply, or a wrap-up, folds to its point; the coordinator's
  // plain answers and work cards stay whole.
  const foldable = !message.failed && !message.handoff && (message.speaker.kind === "member" || !!message.wrapUp);
  const wrap = message.wrapUp ? parseWrapUp(message.text) : null;
  const folded = foldable ? (wrap?.bottomLine ? { gist: wrap.bottomLine, more: wrap.agreed.length + wrap.open.length + wrap.changes.length } : replyGist(message.text)) : null;
  const whole = !folded || folded.more === 0 || expanded;
  return (
    <div className="group/msg flex items-start gap-2.5">
      {worker ? (
        <WorkerAvatar worker={worker} size="sm" />
      ) : (
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-[10px] font-semibold text-accent">
          C
        </span>
      )}
      <div
        className={
          "flex min-w-0 flex-1 flex-col gap-1 rounded-lg px-3 py-2 " +
          (message.wrapUp ? "border border-accent/40 bg-accent/5" : message.failed ? "bg-amber-500/10" : "bg-card")
        }
      >
        <span className="flex items-baseline gap-2">
          <span className="text-[11px] font-semibold text-ink">
            {name}
            {worker?.heartbeatBackend && <span className="font-normal text-ink-faint"> · {worker.heartbeatBackend}</span>}
            {message.wrapUp && <span className="font-normal text-ink-faint"> · where this landed</span>}
            {message.workReport && <span className="font-normal text-emerald-500"> · reporting back on the work</span>}
            {to.length > 0 && !message.wrapUp && (
              <span className="font-normal text-ink-faint"> · to {to.join(", ")}</span>
            )}
            <span className="font-normal text-ink-faint"> · {clockOrDay(message.at)}</span>
          </span>
          {offerHandOff && (
            <button
              className="ml-auto text-[11px] text-ink-faint opacity-0 transition-opacity hover:text-accent focus:opacity-100 disabled:opacity-40 group-hover/msg:opacity-100"
              disabled={sending}
              title="Have them do what they described, as a real run with their tools. What they make lands in the shared folder."
              onClick={() => void roomHandOff(task.id, message.id)}
            >
              Hand this to {name} →
            </button>
          )}
        </span>
        {message.failed ? (
          <span className="text-xs text-amber-600">{message.text}</span>
        ) : whole ? (
          <div className="text-sm">
            <Markdown source={message.text} onOpenPath={onOpenFile} />
          </div>
        ) : (
          <p className="text-sm leading-relaxed text-ink">{folded!.gist}</p>
        )}
        {foldable && (
          <span className="flex flex-wrap items-center gap-x-1.5 text-xs">
            {folded && folded.more > 0 && (
              <button className="py-0.5 font-semibold text-accent hover:underline" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
                {expanded ? "Hide detail" : `Show detail (${folded.more})`}
              </button>
            )}
            {folded && folded.more > 0 && message.speaker.kind === "member" && (
              <span aria-hidden className="text-ink-faint">
                ·
              </span>
            )}
            {message.speaker.kind === "member" && (
              <button className="py-0.5 font-semibold text-accent hover:underline" onClick={() => onReply(name)}>
                Reply to {name}
              </button>
            )}
          </span>
        )}
        {message.refused && message.speaker.kind === "member" && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-xs">
            {message.refused.allowed ? (
              <span className="text-ink-muted">
                {name} can now use {message.refused.tools.join(", ")}.
              </span>
            ) : (
              <>
                <span className="text-amber-600">
                  {name} was refused {message.refused.tools.join(", ")}: it isn't in their flow, so nothing was locked.
                </span>
                <button
                  className="ml-auto font-semibold text-accent hover:underline disabled:opacity-40"
                  disabled={sending}
                  title={`Adds ${message.refused.tools.join(", ")} to ${name}'s flow, then offers to run this again.`}
                  onClick={() => void roomAllowTools(task.id, message.id)}
                >
                  Let {name} use {message.refused.tools.join(", ")} →
                </button>
              </>
            )}
          </div>
        )}
        {message.handoff && <HandoffCard message={message} task={task} onOpenFile={onOpenFile} />}
      </div>
    </div>
  );
}

/// Work handed off in the room: who does what, and — once it starts — how it
/// is going. It runs as a stage of the task; this card is where you watch it.
function HandoffCard({ message, task, onOpenFile }: { message: TeamMessage; task: TeamTask; onOpenFile: (name: string) => void }) {
  const start = useTeamsStore((s) => s.roomStartWork);
  const dismiss = useTeamsStore((s) => s.roomDismissWork);
  const stop = useTeamsStore((s) => s.cancel);
  const sending = useTeamsStore((s) => !!s.busy[task.id]);
  const roomBusy = !!task.room?.busy;
  const handoff = message.handoff!;
  // Started work runs as one stage, or one per step.
  const stageIndexes = handoff.stages ?? (handoff.stage !== undefined ? [handoff.stage] : []);
  const stages = stageIndexes.map((i) => task.stages[i]).filter((st): st is TeamStage => !!st);
  const steps = stages.length > 0 ? stages.map((st) => st.assignments) : handoffSteps(handoff.assignments);
  const left = Math.max(0, task.budgetUSD - task.spentUSD);
  const busyNow = task.status === "running" || task.status === "waiting";
  const runningNow =
    busyNow && stageIndexes.includes(task.stageIndex) && !!task.stages[task.stageIndex] && !isPieceSettledStage(task.stages[task.stageIndex]);
  const current = busyNow ? task.stages[task.stageIndex] : undefined;
  return (
    <div className="mt-1 flex flex-col gap-2 rounded-lg border border-card-strong bg-surface-elevated px-3 py-2.5">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
          {handoff.status === "proposed" ? "Work to hand off" : handoff.status === "queued" ? "Queued" : "Handed off"}
        </span>
        <span className="text-sm font-medium text-ink">{handoff.title}</span>
        {handoff.status === "dismissed" && <span className="text-[11px] text-ink-faint">· set aside</span>}
        {runningNow && (
          <button className={quietBtn + " ml-auto"} disabled={sending} onClick={() => void stop(task.id)}>
            Stop
          </button>
        )}
      </div>
      {steps.map((step, i) => (
        <div key={i} className="flex flex-col gap-1">
          {steps.length > 1 && (
            <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
              Step {i + 1}
              {i > 0 && ` · after ${steps[i - 1].map((a) => a.workerName).join(" and ")}`}
            </span>
          )}
          {stages.length > 0
            ? (step as TeamAssignment[]).map((a) => <AssignmentLine key={a.workerId} a={a} onOpenFile={onOpenFile} />)
            : step.map((a) => <HandoffAsk key={a.workerId} assignment={a} />)}
        </div>
      ))}
      {handoff.status === "queued" && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-ink-faint">
            Starts when {current?.fromRoom ? `"${current.title}"` : "the current work"} reports back
          </span>
          <button className={quietBtn} disabled={sending} onClick={() => void dismiss(task.id, message.id)}>
            Don't start it
          </button>
        </div>
      )}
      {handoff.status === "proposed" && task.continuedAs && <AskInNewRun message={message} task={task} />}
      {handoff.status === "proposed" && !task.continuedAs && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            className={primaryBtn}
            disabled={sending || roomBusy || busyNow}
            onClick={() => void start(task.id, message.id)}
          >
            Start the work
          </button>
          <button className={quietBtn} disabled={sending} onClick={() => void dismiss(task.id, message.id)}>
            Not now
          </button>
          <span className="text-[11px] text-ink-faint">
            {busyNow
              ? "Can start once the current work reports back"
              : `Runs with their tools · ${money(left)} left of the task's ${money(task.budgetUSD)}`}
          </span>
        </div>
      )}
    </div>
  );
}

/// Work proposed here before the task was picked up as a new run can't start
/// here any more: what you asked goes to the new run's composer instead.
function AskInNewRun({ message, task }: { message: TeamMessage; task: TeamTask }) {
  const setDraft = useStore((s) => s.setDraft);
  const next = task.continuedAs!;
  const asked = task.room?.messages.find((m) => m.exchange === message.exchange && m.speaker.kind === "you")?.text ?? "";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        className={primaryBtn}
        onClick={() => {
          if (asked.trim()) setDraft(`team-room:${next.taskId}`, asked);
          useWorkersStore.getState().selectTeam(task.teamId, next.taskId);
        }}
      >
        Ask in the new run →
      </button>
      <span className="text-[11px] text-ink-faint">This task continued in a new run; your request goes into its message box to send there.</span>
    </div>
  );
}

function isPieceSettledStage(stage: TeamStage): boolean {
  return stage.status === "done" || stage.status === "failed" || stage.status === "skipped";
}

function HandoffAsk({ assignment }: { assignment: { workerId: string; workerName: string; ask: string } }) {
  const worker = useWorkersStore((s) => s.workers[assignment.workerId]);
  return (
    <details className="group/ask min-w-0 rounded-md bg-card px-2.5 py-1.5 text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
        {worker && <WorkerAvatar worker={worker} size="xs" />}
        <b className="font-medium text-ink">{assignment.workerName}</b>
        {/* w-0, not min-w-0: a truncated line still counts its full width
            when the desk sizes itself, and pushed the whole pane wide. */}
        <span className="w-0 flex-1 truncate text-ink-muted group-open/ask:hidden">{assignment.ask.split("\n")[0]}</span>
        <span className="ml-auto shrink-0 text-ink-faint group-open/ask:hidden">What they'll do</span>
      </summary>
      <div className="mt-1.5 whitespace-pre-wrap text-ink-muted">{assignment.ask}</div>
    </details>
  );
}

/// Send from a shared Composer. Composer hands the text off but does not empty
/// itself (in chat, the store's send clears the draft); here the box is
/// cleared only once main accepted the message, so a refused send keeps what
/// you typed and attached.
function useComposerSend(
  draftKey: string,
  send: (text: string, attachments: Attachment[]) => Promise<{ ok: boolean }>,
): (text: string, attachments: Attachment[]) => void {
  const setDraft = useStore((s) => s.setDraft);
  const removeAttachment = useStore((s) => s.removeAttachment);
  return (text, attachments) => {
    void send(text, attachments).then((res) => {
      if (!res.ok) return;
      setDraft(draftKey, "");
      for (const a of attachments) removeAttachment(draftKey, a.id);
    });
  };
}

/// What you attached to a brief or a question, as chips that open the file.
function AttachmentChips({ names, onOpenFile }: { names?: string[]; onOpenFile: (name: string) => void }) {
  if (!names?.length) return null;
  return (
    <span className="flex flex-wrap justify-end gap-1.5">
      {names.map((n) => (
        <button
          key={n}
          onClick={() => onOpenFile(n)}
          className="rounded border border-card-strong bg-card px-1.5 py-0.5 font-mono text-[10.5px] text-ink-muted hover:text-ink"
        >
          📎 {n.split("/").pop()}
        </button>
      ))}
    </span>
  );
}
