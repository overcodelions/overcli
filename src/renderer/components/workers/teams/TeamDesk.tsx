// A team's desk: brief it, answer its questions, approve its plan, watch the
// stages land in the shared folder, and read the finished pack.
//
// Everything on screen is what main last pushed (teamsStore); the buttons are
// requests, and the task re-renders when main says it moved.

import { useEffect, useMemo, useRef, useState } from "react";

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
  teamTaskProgress,
  unhired,
  type Team,
  type TeamPlanHire,
  type TeamAssignment,
  type TeamStage,
  type TeamStageKind,
  type TeamMessage,
  type TeamTask,
} from "@shared/flows/team";
import { WorkerAvatar } from "../WorkerAvatar";
import { workerTagline } from "@shared/flows/worker";
import { currentTeamTask } from "./TeamRail";
import { folderSections, type FolderItem } from "./folderView";
import { ProjectSelect, projectName, useProjectOptions } from "./ProjectChoice";
import { exchangeOutcome, groupExchanges, plainLine, type Exchange } from "./roomView";

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
  const tasks = useTeamsStore((s) => s.tasks);
  const openTeamEditor = useWorkersStore((s) => s.openTeamEditor);
  const workers = useWorkersStore((s) => s.workers);
  const projectOptions = useProjectOptions();
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
  /// Writing a new brief while another task is still on the desk.
  const [composing, setComposing] = useState(false);
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
    if (isReadableInDesk(name)) setViewing(name);
    else void useTeamsStore.getState().openFile(shown.id, name);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-wrap items-start justify-between gap-4 border-b border-card px-6 pb-4 pt-6">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="truncate text-2xl font-semibold tracking-tight text-ink">{team.name}</h1>
          {team.purpose && <div className="text-sm text-ink-muted">{team.purpose}</div>}
          {team.projectPath && (
            <div className="text-xs text-ink-faint">
              Works in <span className="text-ink-muted">{projectName(projectOptions, team.projectPath)}</span>
            </div>
          )}
          {/* While briefing, the members get cards of their own below; on a
              task they shrink to a line so the task has the room. */}
          {!briefing && (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {team.members.map((m) => {
                const w = workers[m.workerId];
                return (
                  <span
                    key={m.workerId}
                    className="inline-flex items-center gap-1.5 rounded-full border border-card bg-card px-2 py-0.5 text-[11px] text-ink-muted"
                  >
                    {w ? <WorkerAvatar worker={w} size="xs" /> : null}
                    <span className="text-ink">{w?.name ?? "Gone"}</span>
                    {m.role && <span>· {m.role}</span>}
                  </span>
                );
              })}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!briefing && (
            <button
              className={primaryBtn + " shrink-0"}
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
          <button className="review-btn shrink-0" onClick={() => openTeamEditor(team.id)}>
            Edit team
          </button>
        </div>
      </header>

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
            <FileViewer task={shown} name={viewing} onOpenFile={openFile} />
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
                  <span className={t.status === "review" ? "text-violet-400" : ""}>{describeTeamTaskStatus(t)}</span>
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
  const projectOptions = useProjectOptions();
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <span className="text-[11px] text-ink-faint">
          {describeTeamTaskStatus(task)} · started {new Date(task.createdAt).toLocaleString()}
          {task.projectPath && ` · in ${projectName(projectOptions, task.projectPath)}`}
        </span>
        <h2 className="text-xl font-semibold tracking-tight text-ink">{task.title ?? "New task"}</h2>
      </div>

      <div className="flex max-w-xl flex-col items-end gap-1.5 self-end">
        <div className="whitespace-pre-wrap rounded-2xl rounded-br-sm bg-accent px-4 py-2.5 text-sm text-white">
          {task.brief}
        </div>
        <AttachmentChips names={task.attachments} onOpenFile={onOpenFile} />
      </div>

      {task.answers && task.questions && (
        <CoordinatorSays label="asked, and you answered">
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
      {task.status === "questions" && <QuestionsForm task={task} />}
      {task.status === "proposed" && <PlanCard task={task} />}
      {(task.status === "running" || task.status === "waiting" || task.status === "review" || task.status === "done" || (task.status === "cancelled" && task.stages.length > 0)) && (
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

function CoordinatorSays({ label, children }: { label: string; children: React.ReactNode }) {
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
        <span className="text-xs font-semibold text-ink">
          Coordinator <span className="font-normal text-ink-faint">· {label}</span>
        </span>
        {children}
      </div>
    </div>
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
            <h3 className="text-base font-semibold text-ink">Plan · {task.stages.length} stages</h3>
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
  const { done, total } = teamTaskProgress(task);
  return (
    <div className="flex flex-col gap-4">
      <PlanStrip task={task} done={done} total={total} />

      {task.status === "running" && unhired(task).length > 0 && <HiringCard task={task} />}
      {task.status === "waiting" && task.waiting && <WaitingCard task={task} team={team} />}
      {task.code && <CodeCard task={task} landable={false} />}
      {task.codeError && (
        <p className="text-xs text-amber-500">
          No shared branch for this task — each piece works on its own branch. {task.codeError}
        </p>
      )}

      <ol className="flex flex-col overflow-hidden rounded-xl border border-card bg-surface-elevated">
        {task.stages.map((s, i) => (
          <StageRow key={i} task={task} stage={s} index={i} current={i === task.stageIndex} onOpenFile={onOpenFile} />
        ))}
      </ol>
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

type TaskTab = "pack" | "conversation" | "plan";

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

/// A task whose pack is written, in three tabs. The conversation is the one
/// that grows, so it gets a panel of its own whose composer never scrolls
/// away; the pack and how it was made stop sitting between you and it.
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
  const projectOptions = useProjectOptions();
  const messages = task.room?.messages ?? [];
  const { done, total } = teamTaskProgress(task);
  const roomWork = (task.status === "running" || task.status === "waiting") && !!task.stages[task.stageIndex]?.fromRoom;
  // The first time a task is opened here, everything in it counts as read.
  const [seen, setSeen] = useState(() => readSeen(task.id) ?? messages.length);
  const opensOnConversation =
    messages.length > 0 &&
    (repliesAfter(messages, seen) > 0 ||
      !!task.room?.busy ||
      roomWork ||
      (messages.at(-1)?.at ?? 0) > (task.pack?.updatedAt ?? 0));
  const [tab, setTab] = useState<TaskTab>(opensOnConversation ? "conversation" : "pack");
  /// Where "new since you were here" goes, fixed when you open the tab.
  const [newFrom, setNewFrom] = useState<number | null>(() =>
    opensOnConversation && seen < messages.length ? seen : null,
  );
  // Reading the conversation reads what lands in it.
  useEffect(() => {
    if (tab !== "conversation" || seen === messages.length) return;
    writeSeen(task.id, messages.length);
    setSeen(messages.length);
  }, [tab, messages.length, seen, task.id]);
  const unread = tab === "conversation" ? 0 : repliesAfter(messages, seen);
  const rootRef = useRef<HTMLDivElement>(null);
  const open = (next: TaskTab) => {
    if (next === tab) return;
    if (next === "conversation") setNewFrom(seen < messages.length ? seen : null);
    // The pack and the plan read from the top; the conversation places
    // itself (at what's new, or its end).
    else scrollerOf(rootRef.current)?.scrollTo({ top: 0 });
    setTab(next);
  };
  const tabs: Array<{ id: TaskTab; label: string; count?: string }> = [
    { id: "pack", label: "Pack", count: `v${task.pack?.version ?? 1}` },
    { id: "conversation", label: "Conversation", count: messages.length > 0 ? String(new Set(messages.map((m) => m.exchange)).size) : undefined },
    { id: "plan", label: "Brief & plan" },
  ];

  return (
    <div ref={rootRef} className="flex flex-1 flex-col gap-4">
      <div className="flex flex-col gap-1 pt-4">
        <span className="text-[11px] text-ink-faint">
          {describeTeamTaskStatus(task)}
          {task.pack?.updatedAt ? ` · pack updated ${relativeDay(task.pack.updatedAt)}` : ""}
          {task.projectPath && ` · in ${projectName(projectOptions, task.projectPath)}`}
        </span>
        <h2 className="text-xl font-semibold tracking-tight text-ink">{task.title ?? "Team task"}</h2>
      </div>

      <div className="sticky top-0 z-10 -mx-6 flex flex-col border-b border-card bg-surface/95 px-6 backdrop-blur">
        {back && (
          <div className="flex min-w-0 items-center gap-2 pt-2">
            <button className={quietBtn + " shrink-0"} onClick={back.onClick}>
              ← {back.label}
            </button>
          </div>
        )}
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
          <nav className="flex gap-1" aria-label="Task views">
            {tabs.map((t) => (
              <button
                key={t.id}
                onClick={() => open(t.id)}
                aria-current={tab === t.id ? "page" : undefined}
                className={
                  "flex items-center gap-1.5 px-3 py-2.5 text-[13px] " +
                  (tab === t.id ? "text-ink shadow-[inset_0_-2px_0_var(--c-accent)]" : "text-ink-muted hover:text-ink")
                }
              >
                {t.label}
                {t.count && <span className="rounded-full bg-card-strong px-1.5 text-[10.5px] text-ink-muted">{t.count}</span>}
                {t.id === "conversation" && unread > 0 && (
                  <span className="rounded-full bg-accent px-1.5 text-[10.5px] text-white">{unread} new</span>
                )}
              </button>
            ))}
          </nav>
          <span className="flex items-center gap-2 pb-2.5 text-[11px] text-ink-faint" title={`${done} of ${total} stages done`}>
            <span className="flex gap-0.5" aria-hidden>
              {task.stages.map((st, i) => (
                <span
                  key={i}
                  className={
                    "h-1 w-3.5 rounded-sm " +
                    (st.status === "done"
                      ? "bg-emerald-500"
                      : st.status === "running"
                        ? "bg-accent"
                        : st.status === "failed"
                          ? "bg-amber-500"
                          : "bg-card-strong")
                  }
                />
              ))}
            </span>
            {total} stages · {money(task.spentUSD)} of {money(task.budgetUSD)}
          </span>
        </div>
      </div>

      {task.status === "waiting" && task.waiting && <WaitingCard task={task} team={team} />}
      {error && <div className="text-xs text-red-500">{error}</div>}

      {tab === "pack" && (
        <div className="pb-6">
          <PackView task={task} onOpenFile={onOpenFile} />
        </div>
      )}
      {tab === "conversation" && <TeamRoom task={task} team={team} onOpenFile={onOpenFile} newFrom={newFrom} />}
      {tab === "plan" && (
        <div className="flex flex-col gap-5 pb-6">
          <div className="flex max-w-xl flex-col items-end gap-1.5 self-end">
            <div className="whitespace-pre-wrap rounded-2xl rounded-br-sm bg-accent px-4 py-2.5 text-sm text-white">
              {task.brief}
            </div>
            <AttachmentChips names={task.attachments} onOpenFile={onOpenFile} />
          </div>
          {task.answers && task.questions && (
            <CoordinatorSays label="asked, and you answered">
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
          <PlanStrip task={task} done={done} total={total} />
          <ol className="flex flex-col overflow-hidden rounded-xl border border-card bg-surface-elevated">
            {task.stages.map((st, i) => (
              <StageRow key={i} task={task} stage={st} index={i} current={i === task.stageIndex} onOpenFile={onOpenFile} />
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

/// This task's own plan across the full width — one tile per stage, in the
/// coordinator's order, with who is on it and how far it got. Repeated kinds
/// stay repeated: the strip is the plan, not the vocabulary.
function PlanStrip({ task, done, total }: { task: TeamTask; done: number; total: number }) {
  const [why, setWhy] = useState(false);
  const workers = useWorkersStore((s) => s.workers);
  return (
    <section aria-label={`${done} of ${total} stages done`} className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
          This task's plan · {total} {total === 1 ? "stage" : "stages"}
        </h3>
        {task.planNote && (
          <button className="text-[11px] text-accent hover:underline" aria-expanded={why} onClick={() => setWhy((v) => !v)}>
            {why ? "Hide why" : "Why this plan"}
          </button>
        )}
      </div>
      {why && task.planNote && <p className="text-xs leading-relaxed text-ink-muted">{task.planNote}</p>}
      <ol className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-1.5">
        {task.stages.map((s, i) => {
          const live = s.status === "running";
          return (
            <li
              key={i}
              className={
                "flex min-w-0 flex-col gap-1.5 rounded-lg border-t-2 px-3 py-2.5 " +
                (s.status === "done"
                  ? "border-emerald-500 bg-surface-elevated"
                  : s.status === "skipped"
                    ? "border-card bg-surface-elevated opacity-60"
                    : s.status === "failed"
                      ? "border-amber-500 bg-surface-elevated"
                    : live
                      ? "border-accent bg-accent/10"
                      : "border-card-strong bg-surface-elevated")
              }
            >
              <span className={"flex items-center gap-1.5 text-[10.5px] " + (live ? "text-accent" : "text-ink-faint")}>
                <KindMark kind={s.kind} />
                {i + 1} · {TEAM_STAGE_LABEL[s.kind]}
              </span>
              <span className="line-clamp-2 text-xs font-semibold leading-snug text-ink" title={s.title}>
                {s.title}
              </span>
              <span className="flex min-w-0 items-center gap-1 text-[11px]">
                {s.assignments.map((a) => {
                  const w = workers[a.workerId];
                  return w ? <WorkerAvatar key={a.workerId} worker={w} size="xs" live={a.status === "running"} /> : null;
                })}
                <span
                  className={
                    "truncate " +
                    (s.assignments.length > 0 ? "ml-1 " : "") +
                    (s.status === "done"
                      ? "text-emerald-400"
                      : s.status === "failed"
                        ? "text-amber-500"
                        : live
                          ? "text-accent"
                          : "text-ink-faint")
                  }
                >
                  {s.status === "done"
                    ? "Done"
                    : s.status === "skipped"
                      ? "Skipped"
                      : s.status === "failed"
                      ? "Needs you"
                      : live
                        ? "Working…"
                        : isMemberStage(s.kind)
                          ? "Up next"
                          : "Coordinator"}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
      <div className="flex items-center gap-3 text-[11px] text-ink-faint">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-card-strong">
          <div
            className="h-full rounded-full bg-accent"
            style={{ width: `${Math.min(100, task.budgetUSD > 0 ? (task.spentUSD / task.budgetUSD) * 100 : 0)}%` }}
          />
        </div>
        <span className="tabular-nums">
          <b className="font-medium text-ink">{money(task.spentUSD)}</b> of {money(task.budgetUSD)}
        </span>
      </div>
    </section>
  );
}

function StageRow({
  task,
  stage,
  index,
  current,
  onOpenFile,
}: {
  task: TeamTask;
  stage: TeamStage;
  index: number;
  current: boolean;
  onOpenFile: (name: string) => void;
}) {
  const skippable = canSkipStage(task, index);
  // Stopping a run throws away what it has done so far, so a skip that
  // stops something asks once more; skipping work that has not started
  // does not.
  const stopsWork =
    stage.status === "running" &&
    (!isMemberStage(stage.kind) || stage.assignments.some((a) => a.status === "running" || a.status === "paused"));
  return (
    <li className={"flex items-start gap-3 border-b border-card px-4 py-3 last:border-b-0 " + (current && stage.status !== "done" ? "bg-accent/5" : "")}>
      <StatusDot status={stage.status} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-baseline gap-2">
          <span className={"text-sm font-medium " + (stage.status === "skipped" ? "text-ink-faint line-through" : "text-ink")}>
            {index + 1}. {stage.title}
          </span>
          <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
            {TEAM_STAGE_LABEL[stage.kind]}
          </span>
          {skippable && (
            <span className="ml-auto">
              <SkipButton taskId={task.id} stage={index} label="Skip stage" confirm={stopsWork} />
            </span>
          )}
        </span>
        {!isMemberStage(stage.kind) && (
          <span className="text-xs text-ink-muted">
            {stage.status === "running"
              ? (
                  <CoordinatorActivity
                    taskId={task.id}
                    stage={index}
                    since={stage.startedAt ?? task.updatedAt}
                    reading={`${task.files.filter((f) => !f.name.startsWith("pack/")).length} files in the shared folder`}
                  />
                )
              : stage.status === "done" && stage.file
                ? (
                    <button className="text-accent hover:underline" onClick={() => onOpenFile(stage.file!)}>
                      {stage.file}
                    </button>
                  )
                : stage.status === "pending"
                  ? "Coordinator"
                  : stage.status === "skipped"
                    ? "Skipped"
                    : ""}
          </span>
        )}
        {stage.assignments.map((a) => (
          <AssignmentLine
            key={a.workerId}
            a={a}
            onOpenFile={onOpenFile}
            skip={skippable && stage.assignments.length > 1 ? { taskId: task.id, stage: index } : undefined}
          />
        ))}
        {stage.error && <span className="whitespace-pre-wrap text-xs text-amber-600">{stage.error}</span>}
      </div>
    </li>
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
          ? "Waiting on you — it asked a question"
          : a.status === "running"
            ? "Working…"
            : "Up next";
  const live = a.status === "pending" || a.status === "running" || a.status === "paused";
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md bg-card px-2.5 py-1.5 text-xs">
      {worker && <WorkerAvatar worker={worker} size="xs" live={a.status === "running"} />}
      <b className="font-medium text-ink">{a.workerName}</b>
      <span className={a.status === "failed" ? "text-amber-600" : a.status === "paused" ? "text-violet-400" : "text-ink-muted"}>
        {state}
      </span>
      <span className="ml-auto flex gap-1">
        {a.file && (
          <button className={quietBtn} onClick={() => onOpenFile(a.file!)}>
            Read
          </button>
        )}
        {a.runId && (
          <button className={quietBtn} onClick={viewRun}>
            {a.status === "paused" ? "Answer" : "View run"}
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

function StatusDot({ status }: { status: TeamStage["status"] }) {
  if (status === "done") {
    return (
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ink text-surface">
        <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 7.5l2.5 2.5L11 4" />
        </svg>
      </span>
    );
  }
  if (status === "running") {
    return (
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-accent">
        <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
      </span>
    );
  }
  if (status === "failed") {
    return <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-500 text-[11px] font-bold text-white">!</span>;
  }
  if (status === "skipped") {
    return (
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-[1.5px] border-card-strong text-ink-faint">
        <svg width="10" height="10" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M3 7h8" />
        </svg>
      </span>
    );
  }
  return <span className="mt-0.5 h-5 w-5 shrink-0 rounded-full border-[1.5px] border-dashed border-ink-faint" />;
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
/// merges it into its base — in your checkout, which has to be on that base
/// and clean, as for any agent branch.
function CodeCard({ task, landable }: { task: TeamTask; landable: boolean }) {
  const landCode = useTeamsStore((s) => s.landCode);
  const [landing, setLanding] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const code = task.code!;
  return (
    <section className="flex flex-col gap-2 rounded-xl border border-card bg-surface-elevated px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-xs font-semibold text-ink">
          Code · <span className="font-mono font-normal text-ink-muted">{code.branch}</span>
        </span>
        <span className="text-[11px] text-ink-faint">
          {landable ? "Every piece merged here. Merge it into each repo when you're happy." : "Each piece starts from this branch and merges back into it."}
        </span>
      </div>
      <ul className="flex flex-col divide-y divide-card">
        {code.repos.map((repo) => (
          <li key={repo.projectPath} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
            <span className="text-sm text-ink">
              {repo.name} <span className="text-[11px] text-ink-faint">from {repo.base}</span>
            </span>
            {repo.landed ? (
              <span className="text-xs text-emerald-500">Merged into {repo.base}</span>
            ) : landable ? (
              <button
                className={secondaryBtn}
                disabled={landing !== null}
                onClick={async () => {
                  setLanding(repo.projectPath);
                  setNote(null);
                  const res = await landCode(task.id, repo.projectPath);
                  setLanding(null);
                  if (res.ok) setNote(res.message);
                }}
              >
                {landing === repo.projectPath ? "Merging…" : `Merge into ${repo.base}`}
              </button>
            ) : (
              <span className="text-[11px] text-ink-faint">in progress</span>
            )}
          </li>
        ))}
      </ul>
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
        sections.map((section) => (
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
        ))
      )}
    </div>
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
    kind === "page" ? "text-sky-400" : kind === "image" ? "text-emerald-400" : kind === "data" ? "text-amber-400" : "text-ink-faint";
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
}: {
  task: TeamTask;
  name: string;
  onOpenFile: (name: string) => void;
}) {
  const readFile = useTeamsStore((s) => s.readFile);
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
      {state.error ? (
        <div className="text-xs text-red-500">{state.error}</div>
      ) : state.body === undefined ? (
        <div className="text-xs text-ink-faint">Loading…</div>
      ) : (
        <div className="rounded-xl border border-card bg-surface-elevated px-5 py-4">
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
  const folded = task.room?.foldedThrough ?? 0;
  const unfoldedExchanges = new Set(
    messages.slice(folded).filter((m) => m.speaker.kind !== "you" && !m.failed).map((m) => m.exchange),
  ).size;
  const lastExchange = messages.at(-1)?.exchange;
  const canDebate =
    !busy && messages.some((m) => m.exchange === lastExchange && m.speaker.kind === "member" && !m.failed);
  const names = team.members.map((m) => workers[m.workerId]?.name).filter(Boolean);
  const send = useComposerSend(draftKey, (text, attachments) => {
    stickToEnd.current = true;
    return roomAsk(task.id, text, attachments);
  });
  const working = task.status === "running" || task.status === "waiting" ? task.stages[task.stageIndex] : undefined;
  const workingOn = working?.fromRoom
    ? `${working.assignments.map((a) => a.workerName).join(" and ")} ${working.assignments.length === 1 ? "is" : "are"} working on "${working.title}" — they'll report back here.`
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
        <RoomMessage message={m} task={task} canHandOff={idle} onOpenFile={onOpenFile} />
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
        {(canDebate || unfoldedExchanges > 0) && !workingOn && (
          <div className="flex flex-wrap gap-2">
            {canDebate && (
              <button className={secondaryBtn} disabled={!!busy || sending} onClick={() => void roomContinue(task.id)}>
                Keep debating
              </button>
            )}
            {unfoldedExchanges > 0 && (
              <button
                className={secondaryBtn}
                disabled={!!busy || sending}
                title="Have the coordinator revise the pack with what this conversation settled. The current version is kept."
                onClick={() => void updatePack(task.id)}
              >
                Update the pack · {unfoldedExchanges} exchange{unfoldedExchanges === 1 ? "" : "s"} not in it
              </button>
            )}
          </div>
        )}
        <Composer
          draftKey={draftKey}
          variant="compact"
          strongBorder
          rootPath={rootPath}
          isRunning={!!busy}
          onStop={() => void roomStop(task.id)}
          disabled={sending || !!workingOn}
          placeholder={
            workingOn ??
            (busy
              ? `${busy.speaker} is answering…`
              : "Ask the team, or ask someone to make or change something… e.g. @Lena redo the settings mockup against the real billing screen.")
          }
          onSend={send}
        />
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

/// Room for the sticky tabs above something scrolled to the top.
const STICKY_TOP_PX = 96;

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
}: {
  message: TeamMessage;
  task: TeamTask;
  canHandOff: boolean;
  onOpenFile: (name: string) => void;
}) {
  const worker = useWorkersStore((s) => (message.speaker.kind === "member" ? s.workers[message.speaker.workerId] : undefined));
  const roomHandOff = useTeamsStore((s) => s.roomHandOff);
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
        ) : (
          <div className="text-sm">
            <Markdown source={message.text} onOpenPath={onOpenFile} />
          </div>
        )}
        {message.handoff && <HandoffCard message={message} task={task} onOpenFile={onOpenFile} />}
      </div>
    </div>
  );
}

/// Work proposed in the room: who does what, and — once you start it — how
/// it is going. It runs as a stage of the task; this card is where you watch it.
function HandoffCard({ message, task, onOpenFile }: { message: TeamMessage; task: TeamTask; onOpenFile: (name: string) => void }) {
  const start = useTeamsStore((s) => s.roomStartWork);
  const dismiss = useTeamsStore((s) => s.roomDismissWork);
  const sending = useTeamsStore((s) => !!s.busy[task.id]);
  const roomBusy = !!task.room?.busy;
  const handoff = message.handoff!;
  const stage = handoff.stage !== undefined ? task.stages[handoff.stage] : undefined;
  const left = Math.max(0, task.budgetUSD - task.spentUSD);
  return (
    <div className="mt-1 flex flex-col gap-2 rounded-lg border border-card-strong bg-surface-elevated px-3 py-2.5">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">Work to hand off</span>
        <span className="text-sm font-medium text-ink">{handoff.title}</span>
        {handoff.status === "dismissed" && <span className="text-[11px] text-ink-faint">· set aside</span>}
      </div>
      {stage ? (
        <div className="flex flex-col gap-1">
          {stage.assignments.map((a) => (
            <AssignmentLine key={a.workerId} a={a} onOpenFile={onOpenFile} />
          ))}
        </div>
      ) : (
        handoff.assignments.map((a) => <HandoffAsk key={a.workerId} assignment={a} />)
      )}
      {handoff.status === "proposed" && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            className={primaryBtn}
            disabled={sending || roomBusy || task.status === "running" || task.status === "waiting"}
            onClick={() => void start(task.id, message.id)}
          >
            Start the work
          </button>
          <button className={quietBtn} disabled={sending} onClick={() => void dismiss(task.id, message.id)}>
            Not now
          </button>
          <span className="text-[11px] text-ink-faint">
            Runs with their tools · {money(left)} left of the task's {money(task.budgetUSD)}
          </span>
        </div>
      )}
    </div>
  );
}

function HandoffAsk({ assignment }: { assignment: { workerId: string; workerName: string; ask: string } }) {
  const worker = useWorkersStore((s) => s.workers[assignment.workerId]);
  return (
    <details className="group/ask rounded-md bg-card px-2.5 py-1.5 text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
        {worker && <WorkerAvatar worker={worker} size="xs" />}
        <b className="font-medium text-ink">{assignment.workerName}</b>
        <span className="min-w-0 flex-1 truncate text-ink-muted group-open/ask:hidden">{assignment.ask.split("\n")[0]}</span>
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
