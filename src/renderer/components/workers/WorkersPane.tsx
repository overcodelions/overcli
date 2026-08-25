// The Workers tab: standing personas you hire against a job description.
// A worker is not a saved prompt on a timer — every shift it re-plans from
// its job description plus its journal, parks proposals through the
// orchestrator, and earns (or loses) the right to launch work unattended.
//
// Three surfaces in one pane, mutually exclusive like SchedulesPane:
//   - the roster (list of hired workers, each with scorecard + budget burn)
//   - the hire screen (job description → drafted contract → editor)
//   - the editor (review/adjust the contract; the only place Save lives)

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { Attachment, Backend } from "@shared/types";
import { PREMIUM_MODELS, friendlyModelLabel } from "@shared/modelCatalog";
import { resolveProducerModel } from "@shared/flows/drafterBackend";

/// CLIs a heartbeat turn can run on. Ollama is excluded for the same reason
/// the drafter excludes it: planning a shift from a job description is a
/// reasoning task small local models handle poorly.
const HEARTBEAT_BACKENDS: Backend[] = ["claude", "codex", "gemini", "copilot"];

/// The backend a worker's heartbeat will actually run on: its own pin when it
/// has one, otherwise the user's default. Ollama can be the app-wide default
/// but is never a heartbeat backend (planning a shift from a job description
/// is a reasoning task small local models handle poorly), so it falls back to
/// the head of the list.
function heartbeatBackendOf(
  pinned: Backend | undefined,
  preferred: Backend | undefined,
): Exclude<Backend, "ollama"> {
  const b = pinned ?? preferred;
  return b && b !== "ollama" ? b : "claude";
}

import { useStore } from "../../store";
import { isEverydayProject } from "@shared/everydayProjects";
import { useFlowsStore } from "../../flowsStore";
import { useOrchestratorStore } from "../../orchestratorStore";
import {
  selectRevise,
  draftFromContract,
  draftFromWorker,
  newWorkerDraft,
  useWorkersStore,
} from "../../workersStore";
import {
  WORKER_DEMOTE_REJECTION_STREAK,
  WORKER_MAX_ITEMS_PER_SHIFT,
  WORKER_MIN_INTERVAL_MINUTES,
  sortRoster,
  stripWorkerSubject,
  WORKER_AUTO_RENDER_NEWEST,
  WORKER_AUTO_RENDER_OFF,
  validateWorker,
  workerAutoApproveCap,
  WORKER_TAGLINE_MAX,
  workerTagline,
  type Worker,
  type WorkerJournalEntry,
  type WorkerScorecard,
  type WorkerTrustLevel,
} from "@shared/flows/worker";
import { describeFundingBlock, fundingFor } from "@shared/flows/treasury";
import { isSelectableFlow, type FlowRun } from "@shared/flows/schema";
import {
  describeTrigger,
  untilLabel,
  type ScheduleTrigger,
} from "@shared/flows/schedule";
import {
  isOrchestrationAwaitingApproval,
  type Orchestration,
  type OrchestrationItem,
} from "@shared/flows/orchestration";
import { ATTACHMENT_ACCEPT, intakeAttachments } from "../../attachmentIntake";
import { AttachmentChip } from "../AttachmentChip";
import { Markdown } from "../Markdown";
import { UserBubble } from "../UserBubble";
import { FlowMonogram } from "../flows/FlowMonogram";
import { FlowRunPane } from "../flows/FlowRunPane";
import { deleteFlowRunWithDirtyGuard } from "../flows/deleteRun";
import { WorkerErrandComposer } from "./WorkerDesk";
import { WorkerAvatar } from "./WorkerAvatar";
import { ShiftCalendar } from "./ShiftCalendar";
import { FundsPane } from "./FundsPane";
import { WorkerReportPane } from "./WorkerReportPane";
import {
  CARRIED_OVER_SHOWN,
  adjacentDeskDay,
  carriedOverTurns,
  conversationActivity,
  shiftActivity,
  describeActivity,
  orchestrationTask,
  deskDayLabel,
  deskDays,
  deskTimeline,
  initialDeskDay,
  relativeTime,
  fileDate,
  groupWorkerFiles,
  startOfDay,
  toWorkerActivity,
  workerAutoRenderTarget,
  workerRenderableOutputs,
  type WorkerFileJob,
  type DeskDay,
  type WorkerFile,
  type WorkerActivity,
} from "./workerDeskSelectors";
import { TRUST_LABEL, WorkerPendingProposal } from "./WorkerRowParts";
import { WorkQueuePane } from "./WorkQueuePane";
import { pinnedToBottom, shouldFollowLive } from "./deskFollow";

// Zustand selectors are consumed through React's useSyncExternalStore. Returning
// a new [] while this worker's journal is still loading makes the snapshot look
// different on every read and can put the Workers pane into an infinite render
// loop before loadJournal has a chance to populate it.
const EMPTY_WORKER_JOURNAL: WorkerJournalEntry[] = [];

export function WorkersPane() {
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const loaded = useWorkersStore((s) => s.loaded);
  const workers = useWorkersStore((s) => s.workers);
  const draft = useWorkersStore((s) => s.draft);
  const error = useWorkersStore((s) => s.error);
  const reload = useWorkersStore((s) => s.reload);
  const openEditor = useWorkersStore((s) => s.openEditor);
  const clearError = useWorkersStore((s) => s.clearError);
  const selectedWorkerId = useWorkersStore((s) => s.selectedWorkerId);
  const selectWorker = useWorkersStore((s) => s.selectWorker);
  const setPreviewEmpty = useWorkersStore((s) => s.setPreviewEmpty);
  const importFromFile = useWorkersStore((s) => s.importFromFile);
  const showDebug = useStore((s) => s.settings.showDebug ?? false);
  const view = useWorkersStore((s) => s.view);
  const selectSeq = useWorkersStore((s) => s.selectSeq);
  const activeRun = useFlowsStore((s) =>
    s.activeRunId ? s.runs[s.activeRunId] : undefined,
  );
  const hiring = useWorkersStore((st) => st.hire.open);
  const hireRunning = useWorkersStore((st) => st.hire.startedAt !== null);
  const openHire = useWorkersStore((st) => st.openHire);
  const revisions = useWorkersStore((st) => st.revise);

  useEffect(() => {
    void reload();
    // The editor's flow picker needs the flow library even when the user has
    // never opened the Flows tab this session.
    if (useFlowsStore.getState().flows.length === 0) {
      void useFlowsStore.getState().reload(projects.map((p) => p.path));
    }
  }, []);

  const previewEmpty = useWorkersStore((s) => s.previewEmpty);
  const rows = useMemo(
    () => (previewEmpty ? [] : sortRoster(Object.values(workers))),
    [workers, previewEmpty],
  );

  // The Workers sidebar is the roster; this pane is the detail half. Landing
  // on an empty pane when a roster exists reads as a broken tab, so the first
  // worker stands in until the user picks one.
  //
  // Only while the desk is what's on screen, though. The calendar and the
  // funds waterfall are about every worker at once and deliberately have no
  // selection, and `selectWorker` means "show me this desk" — filling one in
  // from here bounced the tab's own front page straight back to a desk.
  const selected = previewEmpty
    ? null
    : (selectedWorkerId && workers[selectedWorkerId]) || rows[0] || null;
  useEffect(() => {
    if (view !== "worker") return;
    if (!selectedWorkerId && rows.length > 0) selectWorker(rows[0].id);
  }, [rows, selectWorker, selectedWorkerId, view]);

  const nameForPath = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) m.set(p.path, p.name);
    for (const w of workspaces) m.set(w.rootPath, w.name);
    return m;
  }, [projects, workspaces]);

  const defaultProjectPath = workspaces[0]?.rootPath ?? projects[0]?.path ?? "";
  // Where a new hire lands decides whether it files into the folder by
  // default — see `defaultFileIntoProject`. A workspace root is never an
  // everyday project, so the lookup simply misses.
  const defaultProjectEveryday = projects.find(
    (p) => p.path === defaultProjectPath,
  )?.everyday;
  const canHire = defaultProjectPath !== "";
  const showRosterHeader = view !== "worker" || !selected;
  const revisionNotices = Object.entries(revisions)
    .filter(([, revision]) => revision.startedAt !== null || revision.pending)
    .map(([id, revision]) => ({
      worker: workers[id],
      done: revision.pending != null,
    }))
    .filter((row): row is { worker: Worker; done: boolean } => !!row.worker);
  const showProgressNotices = hireRunning || revisionNotices.length > 0;

  // The editor wins over everything below it: it is the one screen on this
  // tab the user asked for outright. A worker's run outranking it meant that
  // pressing Edit — or picking the worker in ⌘K — while its run filled the
  // pane changed nothing on screen at all.
  if (draft) return <WorkerEditor />;

  // A run this worker launched is shown HERE, not on the Flows tab. Sending
  // you to Flows swapped the whole left sidebar for the project tree — you
  // lost the roster, the tab moved under you, and the run you arrived at is
  // deliberately absent from that sidebar's list, so nothing on screen still
  // said where you were. A worker's run is part of the worker.
  if (activeRun?.workerId && activeRun.workerId === selected?.id) {
    return <FlowRunPane key={activeRun.id} runId={activeRun.id} />;
  }

  if (hiring) return <HireWorker defaultProjectPath={defaultProjectPath} />;

  return (
    // A column, not a scroll box. The desk is a conversation: its transcript
    // has to scroll under a header and composer that stay put, the way the
    // Chat tab works. Scrolling the whole pane took the composer with it.
    <div className="flex min-h-0 flex-1 flex-col">
      {(showRosterHeader || showProgressNotices) && (
        <div className="shrink-0 px-6 pt-6">
          {showRosterHeader && (
            <div className="flex items-center gap-3 mb-2">
              <div className="text-2xl font-semibold">Workers</div>
              {/* Only with Debug on. The empty state is the screen you can never
            reach again once you have hired anyone, so it needs a way to be
            looked at that is not "fire everybody". */}
              {showDebug && (
                <button
                  onClick={() => setPreviewEmpty(!previewEmpty)}
                  title="Render this tab as if nobody had been hired. Nothing is changed."
                  className={
                    "rounded-md border px-2 py-1 text-[11px] " +
                    (previewEmpty
                      ? "border-amber-400/50 text-amber-500"
                      : "border-card-strong text-ink-faint hover:text-ink")
                  }
                >
                  {previewEmpty ? "Previewing empty" : "Preview empty"}
                </button>
              )}
              {/* The other way a worker arrives: somebody else's file. Beside
              "Add by hand" because that is what it is — a hire you did not
              have to describe, landing in the same editor for the same
              confirmation. */}
              <button
                disabled={!canHire}
                onClick={() =>
                  void importFromFile({
                    projectPath: defaultProjectPath,
                    projectPaths: projects.map((p) => p.path),
                  })
                }
                title="Hire from a worker YAML someone shared with you"
                className="ml-auto text-xs px-3 py-1.5 rounded-md border border-card-strong hover:bg-white/5 disabled:opacity-40"
              >
                Import…
              </button>
              <button
                disabled={!canHire}
                onClick={() =>
                  openEditor(
                    newWorkerDraft(defaultProjectPath, defaultProjectEveryday),
                  )
                }
                className="text-xs px-3 py-1.5 rounded-md border border-card-strong hover:bg-white/5 disabled:opacity-40"
              >
                Add by hand
              </button>
              <button
                disabled={!canHire}
                onClick={() => openHire(defaultProjectPath)}
                className="text-xs px-3 py-1.5 rounded-md bg-accent text-white hover:opacity-90 disabled:opacity-40"
              >
                ✨ Hire a worker
              </button>
            </div>
          )}

          {/* A hire drafts for minutes and you are not expected to sit there —
            so when you have walked away from it, the tab says so and takes
            you back. The turn itself is running in main either way. */}
          {hireRunning && (
            <button
              onClick={() => openHire(defaultProjectPath)}
              className="mb-3 flex w-full items-center gap-2 rounded-md border border-accent/40 bg-accent/5 px-3 py-2 text-left text-[11px] hover:bg-accent/10"
            >
              <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
              <span className="text-ink-muted">
                Still drafting a contract — you can keep working; it lands in
                the editor when it&apos;s done.
              </span>
              <span className="ml-auto shrink-0 text-ink-faint">Show me →</span>
            </button>
          )}

          {/* Same for a revision, which is easier to lose track of: clicking
            any worker in the roster closes the editor it was started from.
            One line per worker being revised — they are independent, and a
            second one starting must not hide the first. */}
          {revisionNotices.map(({ worker, done }) => (
            <button
              key={worker.id}
              onClick={() => openEditor(draftFromWorker(worker))}
              className="mb-3 flex w-full items-center gap-2 rounded-md border border-accent/40 bg-accent/5 px-3 py-2 text-left text-[11px] hover:bg-accent/10"
            >
              <span
                className={
                  "h-1.5 w-1.5 shrink-0 rounded-full bg-accent " +
                  (done ? "" : "animate-pulse")
                }
              />
              <span className="text-ink-muted">
                {done
                  ? `A revision for ${worker.name} is ready — open it to review the change.`
                  : `Still revising ${worker.name} — it lands on that draft when it's done, wherever you are.`}
              </span>
              <span className="ml-auto shrink-0 text-ink-faint">
                Open the editor →
              </span>
            </button>
          ))}
        </div>
      )}

      {!loaded ? (
        <div className="px-6 text-sm text-ink-muted">Loading workers…</div>
      ) : /* The landing page — but only once somebody has been hired. On an
             empty roster the queue would be a screen explaining that nobody
             is working, which is true and useless; the vacancy below is the
             screen that says what to do about it. */
      view === "queue" && rows.length > 0 ? (
        <WorkQueuePane />
      ) : view === "calendar" ? (
        <ShiftCalendar />
      ) : view === "report" ? (
        <WorkerReportPane />
      ) : view === "funds" ? (
        <FundsPane />
      ) : rows.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          <WorkersEmptyState
            canHire={canHire}
            onHire={() => openHire(defaultProjectPath)}
            onAddByHand={() =>
              openEditor(
                newWorkerDraft(defaultProjectPath, defaultProjectEveryday),
              )
            }
            onImport={() =>
              void importFromFile({
                projectPath: defaultProjectPath,
                projectPaths: projects.map((p) => p.path),
              })
            }
          />
        </div>
      ) : selected ? (
        <WorkerRow
          key={`${selected.id}:${selectSeq}`}
          worker={selected}
          projectLabel={nameForPath.get(selected.projectPath)}
        />
      ) : (
        <div className="px-6 text-sm text-ink-muted">
          Pick a worker from the sidebar.
        </div>
      )}
    </div>
  );
}

/// The Workers tab with nobody hired.
///
/// An empty roster is not an absence, it is a VACANCY — and a vacancy has a
/// form in this feature's world: a posting. So this reads as one, down to its
/// terms, and every term is a real field of the worker contract rather than a
/// marketing bullet. The two things that sell a worker are the two things a
/// posting states plainly: what the job is, and what the employment is like.
///
/// The mark at the top is the trust ladder drawn as three empty chairs — the
/// same rings `WorkerAvatar` uses, hollow and unlettered. Dashed, solid,
/// doubled: probation, trusted, autonomous. It says both halves at once, that
/// nobody sits here yet and that whoever does will earn their way along it,
/// in the exact vocabulary you meet the moment you hire.
///
/// Deliberately not centred and deliberately not animated. A centred card with
/// three feature bullets is what every empty state looks like; a document
/// reads as something you fill in. Nothing else in this app moves on load, and
/// a flourish here would be the one thing that gave the screen away.
function WorkersEmptyState({
  canHire,
  onHire,
  onAddByHand,
  onImport,
}: {
  canHire: boolean;
  onHire: () => void;
  onAddByHand: () => void;
  onImport: () => void;
}) {
  return (
    // The posting stays a narrow document — a column you read — and the width
    // the pane actually has goes to the thing the width is FOR: a desk. Terms
    // tell you what you are agreeing to; the specimen tells you what it is
    // like, which no list of terms can.
    <div className="flex flex-wrap items-start gap-x-10 gap-y-10 py-2">
      <div className="min-w-[380px] max-w-[620px] flex-1">
        <TrustLadderMark />

        <div className="mt-7 text-[10px] uppercase tracking-[0.18em] text-ink-faint">
          Open position
        </div>
        <h2
          className="mt-2 text-[26px] leading-[1.25] text-ink"
          style={{ fontFamily: SERIF }}
        >
          A worker is a job description
          <br />
          with a clock.
        </h2>

        <p className="mt-4 text-[13px] leading-relaxed text-ink-muted">
          Write what you want done. It turns up on its own schedule, re-reads
          the project and its own journal, decides what today&apos;s most
          valuable version of that job is, and files the work for you to
          approve. Not a saved prompt on a timer — a standing persona that plans
          each shift itself.
        </p>

        <dl className="mt-7 border-t border-card-strong">
          {TERMS.map((term) => (
            <div
              key={term.label}
              className="flex gap-6 border-b border-card-strong py-2.5 text-[12px]"
            >
              <dt className="w-24 shrink-0 uppercase tracking-[0.12em] text-[10px] leading-5 text-ink-faint">
                {term.label}
              </dt>
              <dd className="min-w-0 flex-1 leading-relaxed text-ink-muted">
                {term.value}
              </dd>
            </div>
          ))}
        </dl>

        <div className="mt-7 flex items-center gap-4">
          <button
            disabled={!canHire}
            onClick={onHire}
            className="rounded-md bg-accent px-4 py-2 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-40"
          >
            ✨ Hire a worker
          </button>
          <button
            disabled={!canHire}
            onClick={onAddByHand}
            className="text-[12px] text-ink-faint hover:text-ink disabled:opacity-40"
          >
            or write the contract yourself
          </button>
          {/* The third way to fill a vacancy, and the fastest one for anyone
              joining a team that already runs workers: take theirs. */}
          <button
            disabled={!canHire}
            onClick={onImport}
            className="text-[12px] text-ink-faint hover:text-ink disabled:opacity-40"
          >
            or import one
          </button>
        </div>

        {/* An empty screen has to say what to do next, and "hire" is not the
          next thing when there is nowhere for a worker to work. */}
        {!canHire && (
          <p className="mt-3 text-[12px] text-amber-500">
            Add a project or workspace first — a worker is hired onto one.
          </p>
        )}
      </div>

      <DayRota />
      <ErrandBlock />
    </div>
  );
}

/// One Tuesday, as a rota — the half of the story that happens without you.
///
/// The posting can only describe the arrangement one worker at a time. What a
/// wide surface can show is a DAY: several of them on their own clocks, none
/// of it prompted. That is the shape of the thing being sold, and no list of
/// terms renders it.
///
/// A rota is also the right artifact: it is what this world already keeps, and
/// it reads as a document beside the posting rather than as marketing.
///
/// The errand used to sit inside this list as an opened row, which buried it —
/// a footnote to a schedule. It is now its own block, because it is the other
/// half of the story rather than a detail of this one, and the two panels make
/// the point by contrast: a rota has times and no you; a desk has you and no
/// times.
function DayRota() {
  return (
    <div className="min-w-[340px] max-w-[460px] flex-1">
      <div className="flex items-baseline gap-2">
        <span className="text-[10px] uppercase tracking-[0.18em] text-ink-faint">
          A Tuesday
        </span>
        <span className="text-[10px] text-ink-faint">
          · nobody asked for any of it
        </span>
      </div>

      <div className="mt-3 border-t border-card-strong">
        {ROTA.map((entry) => (
          <div
            key={entry.at}
            className="flex items-baseline gap-3 border-b border-card-strong py-2 text-[11px]"
          >
            <span className="w-11 shrink-0 tabular-nums text-ink-faint">
              {entry.at}
            </span>
            <span
              className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: entry.tint }}
            />
            <span className="w-28 shrink-0 truncate text-ink">{entry.who}</span>
            <span className="min-w-0 flex-1 text-ink-muted">{entry.what}</span>
          </div>
        ))}
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
        Three hires, one day, no prompting. Each one re-read the project and its
        own journal that morning and decided what today&apos;s version of its
        job was.
      </p>
    </div>
  );
}

/// The sidebar's errand mark, small: an errand is speech, and speech came
/// from you.
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

/// The other half: work that happens BECAUSE of you.
///
/// Deliberately shaped as a conversation rather than a list — the rota has a
/// time column and no you in it, this has you and no times. Set beside each
/// other, the two panels say the thing the terms cannot: it runs without you,
/// and it is still yours to interrupt.
function ErrandBlock() {
  const tint = "#34d399";
  return (
    <div className="min-w-[300px] max-w-[380px] flex-1">
      <div className="flex items-baseline gap-2">
        <span className="text-[10px] uppercase tracking-[0.18em] text-ink-faint">
          An errand
        </span>
        <span className="text-[10px] text-ink-faint">
          · 11:04, the same Tuesday
        </span>
      </div>

      <div className="mt-3 rounded-xl border border-card-strong bg-card p-3">
        <div className="mb-2 flex items-center gap-1.5 text-[10px] text-ink-faint">
          <ErrandGlyph />
          <span>You, to Test Runner</span>
        </div>

        <div className="flex justify-end">
          <div className="max-w-[88%] rounded-xl bg-accent/20 px-2.5 py-1.5 text-[11px] leading-snug text-ink">
            dig into why the nightly build got slower this week
          </div>
        </div>

        <div
          className="relative mt-2 overflow-hidden rounded-xl"
          style={{
            background: `color-mix(in srgb, ${tint} 5%, transparent)`,
            border: `1px solid color-mix(in srgb, ${tint} 18%, transparent)`,
          }}
        >
          <div
            className="absolute bottom-0 left-0 top-0 w-[2px]"
            style={{ background: tint }}
          />
          <div className="px-3 py-2 pl-[11px]">
            <div
              className="mb-1 text-[9px] font-medium"
              style={{ color: tint }}
            >
              Test Runner
            </div>
            <div className="text-[11px] leading-snug text-ink-muted">
              Two things changed on Tuesday: the dependency install stopped
              hitting the cache, and a new integration suite added 4m12s on its
              own.
            </div>
          </div>
        </div>

        <div className="mt-2 flex items-baseline gap-2 text-[10px]">
          <span className="w-11 shrink-0 text-emerald-500">done</span>
          <span className="min-w-0 flex-1 truncate text-ink-muted">
            Time the last 14 nightly builds
          </span>
          <span className="shrink-0 rounded border border-card-strong px-1 text-ink-faint">
            report.md
          </span>
        </div>
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
        You asked the one whose job it already was. It planned the answer
        through the same job description and journal, ran the work, and filed
        what it made — where you can still find it next month.
      </p>
    </div>
  );
}

interface RotaEntry {
  at: string;
  who: string;
  what: string;
  tint: string;
  kind?: "errand";
}

/// Colours are the identity palette, so the three names read as three people
/// here for the same reason they do on the calendar.
const ROTA: RotaEntry[] = [
  {
    at: "06:45",
    who: "Chief of Staff",
    what: "Filed your morning brief",
    tint: "#a78bfa",
  },
  {
    at: "08:00",
    who: "Fielder",
    what: "Started its hourly pass",
    tint: "#38bdf8",
  },
  {
    at: "11:04",
    who: "Test Runner",
    what: "why did the nightly build get slower this week?",
    tint: "#34d399",
    kind: "errand",
  },
  {
    at: "17:00",
    who: "Fielder",
    what: "Last pass — 2 proposals waiting",
    tint: "#38bdf8",
  },
  {
    at: "19:00",
    who: "Test Runner",
    what: "Suite green, 1,821 passed",
    tint: "#34d399",
  },
];

const SERIF = 'ui-serif, Georgia, Cambria, "Times New Roman", serif';

/// The terms of employment. Each one is a field of the contract, not a
/// feature: this is what you are agreeing to when you hire.
const TERMS: Array<{ label: string; value: React.ReactNode }> = [
  {
    label: "The job",
    value: (
      <>
        A paragraph in your own words —{" "}
        <span className="italic text-ink" style={{ fontFamily: SERIF }}>
          &ldquo;Read the new tickets every morning, reproduce what you can, and
          hand me ready-to-run fix candidates.&rdquo;
        </span>
      </>
    ),
  },
  {
    label: "The clock",
    value:
      "Every weekday at nine. Hourly between eight and six. Whatever the work needs.",
  },
  {
    label: "The trust",
    value: (
      <>
        Every hire starts on <span className="text-amber-500">probation</span>,
        where the cap on unattended work is literally zero. Promote it when it
        earns it, and it starts launching its own.
      </>
    ),
  },
  {
    label: "The memory",
    value:
      "Shifts, approvals and rejections go in its journal. Work you turned down never comes back, and what it produced is filed where you can find it months later.",
  },
];

/// Three empty chairs, which are also the trust ladder: the rings a worker
/// wears once hired, drawn without a face. Dashed → solid → doubled is the
/// same progression `WorkerAvatar` renders, so the mark teaches the vocabulary
/// before there is anyone to read it on.
function TrustLadderMark() {
  const rungs = [
    { tint: "#f59e0b", label: "probation", style: "dashed" as const },
    { tint: "#38bdf8", label: "trusted", style: "solid" as const },
    { tint: "#34d399", label: "autonomous", style: "double" as const },
  ];
  return (
    <div className="flex items-start gap-4" aria-hidden>
      {rungs.map((rung, i) => (
        <div key={rung.label} className="flex items-start gap-4">
          <div className="flex flex-col items-center gap-2">
            <span
              className="h-9 w-9 rounded-full"
              style={{
                border: `1.5px ${rung.style === "double" ? "solid" : rung.style} color-mix(in srgb, ${rung.tint} 55%, transparent)`,
                boxShadow:
                  rung.style === "double"
                    ? `0 0 0 2px color-mix(in srgb, ${rung.tint} 18%, transparent)`
                    : undefined,
              }}
            />
            <span className="text-[9px] uppercase tracking-[0.1em] text-ink-faint">
              {rung.label}
            </span>
          </div>
          {i < rungs.length - 1 && (
            <span
              className="mt-[18px] h-px w-8"
              style={{
                background: "color-mix(in srgb, var(--c-ink) 14%, transparent)",
              }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

// ---- Roster row ----------------------------------------------------------

/// A worker's landing page.
///
/// The design brief this answers: it was reading as a cron admin console —
/// toggle, badges, counters and a budget bar in the heaviest type at the top,
/// the actual conversation buried underneath in small text. But the domain
/// here is deliberately EMPLOYMENT: you hire against a job description, it
/// works shifts, earns trust, keeps a journal, gets promoted or fired. So the
/// page is built as a personnel file whose front page is a desk you talk at.
///
/// Three structural decisions carry that:
///   - Standing is COLOR. A worker's trust level tints its monogram ring
///     everywhere, so where it stands is legible before you read a word.
///   - The job description is set as a QUOTATION, in the one serif on the
///     page. It is the contract — the thing it was hired to do and the thing
///     every errand is judged against — not a metadata field.
///   - Everything that is not the conversation moves behind a tab. The only
///     action on the front page is "Run shift now"; pausing, promoting and firing
///     are deliberate acts that belong on Settings, next to the rules that
///     govern them.
/// Why "Run shift now" would be refused, before you press it. The engine gates a
/// manual shift on the same funding waterfall the scheduler uses, but it only
/// answers after the click — and its answer lands in the store's `error`,
/// which this pane never draws. An out-of-budget worker therefore read as a
/// dead button. The allocation is already in the renderer, so say it up front.
function useShiftBlock(
  workerId: string,
): { headline: string; reason: string } | null {
  const allocation = useWorkersStore((s) => s.allocation);
  return useMemo(() => {
    const funding = fundingFor(allocation, workerId);
    if (!allocation || !funding || funding.funded) return null;
    return {
      headline:
        funding.blocked === "paused"
          ? "Paused — no shifts."
          : "Out of budget — no shifts.",
      reason: describeFundingBlock(funding, allocation),
    };
  }, [allocation, workerId]);
}

function ShiftBlockNotice({
  block,
}: {
  block: { headline: string; reason: string };
}) {
  return (
    <div className="mt-3 rounded-md border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-xs text-ink-muted">
      <span className="text-amber-500">{block.headline}</span> {block.reason}
    </div>
  );
}

function WorkerRow({
  worker,
  projectLabel,
}: {
  worker: Worker;
  projectLabel?: string;
}) {
  const nextShiftAt = useWorkersStore((s) => s.nextShiftAt[worker.id] ?? null);
  const scorecard = useWorkersStore((s) => s.scorecards[worker.id]);
  const shift = useWorkersStore((s) => s.shiftProgress[worker.id]);
  const starting = useWorkersStore((s) => !!s.shiftStarting[worker.id]);
  const workShiftNow = useWorkersStore((s) => s.workShiftNow);
  const shiftBlock = useShiftBlock(worker.id);
  const [tab, setTab] = useState<
    "chat" | "shifts" | "tasks" | "files" | "journal" | "stats" | "settings"
  >("chat");
  const [intent, setIntent] = useState<"chat" | "work">("chat");
  // The desk is cleared nightly: it shows one day, and the rest is one step
  // back. Opening on today rather than on "the last day something happened"
  // is deliberate — a desk whose date changes depending on when the worker
  // last worked isn't a desk, it's a search result.
  const focus = useWorkersStore((s) => s.deskFocus);
  const [day, setDay] = useState(() =>
    focus?.workerId === worker.id ? startOfDay(focus.at) : initialDeskDay(),
  );
  // Arriving from the calendar names a turn, and that turn may be on any day.
  // Following it means moving the desk's date as well as opening the row —
  // otherwise the link lands on today and the thing you clicked isn't there.
  const clearDeskFocus = useWorkersStore((s) => s.clearDeskFocus);
  // Held locally so the turn stays highlighted and scrolled to after the store
  // hands it over. The store's copy is CONSUMED: a focus is a one-time
  // navigation, and leaving it set re-applied its day every time this pane
  // remounted, so a worker you had reached from the calendar kept reopening on
  // last week no matter what it did today.
  const [focusId, setFocusId] = useState<string | null>(
    focus?.workerId === worker.id ? focus.orchestrationId : null,
  );
  // Sending an errand snaps the desk back to today, because that is where the
  // errand lands. Without this you could send from a day you had stepped back
  // to — the composer is there on every day — and watch nothing happen: your
  // message, the reply and the whole turn were filed on today, which is the
  // one day you were not looking at.
  const sendingAt = useWorkersStore(
    (s) => s.errandSending[worker.id]?.[0]?.at ?? null,
  );
  useEffect(() => {
    if (sendingAt == null) return;
    setDay(startOfDay(sendingAt));
    setFocusId(null);
  }, [sendingAt]);

  // The worker's directory, read once when you open it. Two things want it:
  // the Files tab lists it, and the thing below renders one of them without
  // being asked.
  const [files, setFiles] = useState<WorkerFile[] | null>(null);
  const journal = useWorkersStore(
    (s) => s.journals[worker.id] ?? EMPTY_WORKER_JOURNAL,
  );
  const loadJournal = useWorkersStore((s) => s.loadJournal);
  const setFilesRoot = useWorkersStore((s) => s.setFilesRoot);
  useEffect(() => {
    let live = true;
    void window.overcli
      .invoke("workers:files", { id: worker.id })
      .then((res) => {
        if (!live) return;
        setFilesRoot(worker.id, res.root);
        setFiles(res.files);
      });
    return () => {
      live = false;
    };
  }, [worker.id, setFilesRoot]);
  useEffect(() => {
    void loadJournal(worker.id);
  }, [worker.id, loadJournal]);

  // Open the worker's report the moment you open the worker.
  //
  // A worker hired to produce a page is one you come to LOOK at something,
  // and its report was three clicks down (Files → today's job folder → the
  // file) every single morning, in a folder whose name changes daily.
  //
  // Once per arrival, and once more whenever the choice itself changes —
  // picking a different output in Settings should show you the thing you
  // picked, since what you see IS the setting. Tracked by the setting rather
  // than by a fired/not-fired flag so closing the pane and staying put leaves
  // it closed: the automatic act is arriving, not looking.
  const openFile = useStore((s) => s.openFile);
  const renderedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!files) return;
    const setting = worker.autoRender ?? WORKER_AUTO_RENDER_NEWEST;
    if (renderedFor.current === setting) return;
    renderedFor.current = setting;
    const target = workerAutoRenderTarget(files, worker.autoRender);
    if (target) openFile(target.path, undefined, "preview");
  }, [files, worker.autoRender, openFile]);

  const orchestrations = useOrchestratorStore((s) => s.orchestrations);
  const mine = useMemo(
    () =>
      Object.values(orchestrations).filter(
        (o) => o.origin?.kind === "worker" && o.origin.workerId === worker.id,
      ),
    [orchestrations, worker.id],
  );
  const awaiting = useMemo(
    () =>
      mine.filter(
        (item) =>
          orchestrationTask(item) === "shift" &&
          isOrchestrationAwaitingApproval(item),
      ),
    [mine],
  );
  const activity = useMemo(() => mine.map(toWorkerActivity), [mine]);
  const executedTasks = useMemo(
    () =>
      mine.flatMap((orchestration) =>
        orchestration.items.filter((item) =>
          ["queued", "running", "paused", "done", "failed"].includes(
            item.status,
          ),
        ),
      ),
    [mine],
  );
  const activeTaskCount = executedTasks.filter((item) =>
    ["queued", "running", "paused"].includes(item.status),
  ).length;
  useEffect(() => {
    if (focus?.workerId !== worker.id) return;
    const focused = mine.find((item) => item.id === focus.orchestrationId);
    setTab(
      focused && orchestrationTask(focused) === "shift" ? "shifts" : "chat",
    );
    setDay(startOfDay(focus.at));
    setFocusId(focus.orchestrationId);
    clearDeskFocus();
  }, [focus, worker.id, mine, clearDeskFocus]);
  const conversation = useMemo(
    () => conversationActivity(activity),
    [activity],
  );
  const shifts = useMemo(() => shiftActivity(activity), [activity]);
  const workSummary = useMemo<WorkerWorkSummary>(
    () => ({
      shiftCount: Math.max(worker.shiftCount ?? 0, shifts.length),
      completed:
        scorecard?.completed ??
        shifts.reduce((total, item) => total + item.done, 0),
      latest: shifts[0] ?? null,
    }),
    [worker.shiftCount, shifts, scorecard?.completed],
  );
  const days = useMemo(() => deskDays(conversation), [conversation]);
  // Oldest first: a transcript reads down, and the composer is at the bottom.
  const dayItems = useMemo(
    () => deskTimeline(conversation, day),
    [conversation, day],
  );
  const timelineCount = dayItems.length;

  const headerTagline = workerTagline(worker);

  // Park the transcript at the newest message when you arrive, and keep it
  // there as turns land — a conversation you open half-scrolled reads as
  // broken, and the last thing said is the thing you came for.
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current;
    if (el && tab === "chat") el.scrollTop = el.scrollHeight;
  }, [tab, worker.id, timelineCount, day]);

  // A shift the worker is working right now writes into the bottom of the
  // desk as it goes, and the desk follows it — but only while you are already
  // standing at the bottom. Someone who has scrolled up to read yesterday's
  // proposal is reading, and yanking them back down every time a token lands
  // is the transcript fighting its reader. See `deskFollow` for the rule.
  const live = useWorkersStore((s) => s.shiftProgress[worker.id]);
  const pinned = useRef(true);
  const wasLive = useRef(false);
  useEffect(() => {
    const el = scroller.current;
    if (!el || tab !== "chat") return;
    const follow = shouldFollowLive({
      live: !!live,
      wasLive: wasLive.current,
      pinned: pinned.current,
    });
    wasLive.current = !!live;
    if (!follow) return;
    pinned.current = true;
    el.scrollTop = el.scrollHeight;
  }, [tab, live?.text, live?.tools.length, !!live]);

  // Every other tab is a DOCUMENT, not a conversation, and it opens at the
  // top. They share this scroller with the desk, so parking at the bottom
  // unconditionally sent Settings straight past the Edit button on its first
  // line — and Journal and Stats to their oldest, least interesting end.
  // Deliberately not keyed on the timeline: a shift landing while you read
  // the settings form must not yank you back to the top of it.
  useEffect(() => {
    const el = scroller.current;
    if (el && tab !== "chat") el.scrollTop = 0;
  }, [tab, worker.id]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-6 pt-6">
        {/* Identity. Name, standing, rhythm — and one action. */}
        <div className="flex items-start gap-4">
          <WorkerAvatar worker={worker} size="lg" live={!!shift} />
          <div className="min-w-0 flex-1">
            <div className="text-2xl font-semibold tracking-tight text-ink">
              {worker.name}
            </div>
            {/* The same line the roster shows, so opening a worker confirms
                the row you clicked rather than making you re-read the job
                description to check you are in the right place. */}
            {headerTagline && (
              <div className="mt-0.5 truncate text-[13px] text-ink-muted">
                {headerTagline}
              </div>
            )}
            <div className="mt-1 text-xs text-ink-muted">
              <span
                className={TRUST_LABEL[worker.trust].cls
                  .split(" ")
                  .slice(0, 2)
                  .join(" ")}
              >
                {TRUST_LABEL[worker.trust].text}
              </span>
              {projectLabel ? ` · ${projectLabel}` : ""}
              {!worker.enabled
                ? " · paused"
                : nextShiftAt != null
                  ? ` · next shift ${untilLabel(nextShiftAt)}`
                  : ""}
            </div>
          </div>
          <button
            disabled={starting || !!shift || !!shiftBlock}
            onClick={() => void workShiftNow(worker.id)}
            title={
              shiftBlock?.reason ??
              "Work one shift now, out of band. Does not change the schedule."
            }
            className="review-btn shrink-0 disabled:opacity-40"
          >
            {shift ? "Shift running…" : "Run shift now"}
          </button>
        </div>

        {shiftBlock && <ShiftBlockNotice block={shiftBlock} />}

        <div className="mt-5 flex items-center gap-6 overflow-x-auto border-b border-card-strong">
          {(
            [
              ["chat", "Chat"],
              ["shifts", "Shifts"],
              ["tasks", "Tasks"],
              ["files", "Files"],
              ["journal", "Journal"],
              ["stats", "Stats"],
              ["settings", "Settings"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={
                "-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-0.5 pb-2 text-[13px] transition-colors " +
                "focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 " +
                (tab === key
                  ? "border-accent text-ink"
                  : "border-transparent text-ink-faint hover:text-ink-muted")
              }
            >
              {label}
              {key === "shifts" && awaiting.length > 0 && (
                <span className="rounded-full bg-violet-500/20 px-1.5 text-[10px] text-violet-500">
                  {awaiting.length}
                </span>
              )}
              {key === "tasks" && activeTaskCount > 0 && (
                <span className="rounded-full bg-sky-400/15 px-1.5 text-[10px] text-sky-400">
                  {activeTaskCount}
                </span>
              )}
              {/* A shift in flight is the one thing here that changes while you
                are not looking at it, so the tab says so. */}
              {key === "shifts" && shift?.task === "shift" && (
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-60" />
                  <span className="relative h-1.5 w-1.5 rounded-full bg-sky-400" />
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {tab === "chat" ? (
        <>
          <DeskDayBar
            day={day}
            days={days}
            onSet={setDay}
            context={
              <>
                <button
                  onClick={() => setTab("files")}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md border border-card-strong bg-card/20 px-2.5 text-[11px] font-medium text-ink-muted transition-colors hover:bg-card/50 hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
                >
                  Files{" "}
                  <span className="text-ink-faint">{files?.length ?? 0}</span>
                </button>
                <button
                  onClick={() => setTab("journal")}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md border border-card-strong bg-card/20 px-2.5 text-[11px] font-medium text-ink-muted transition-colors hover:bg-card/50 hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
                >
                  Journal{" "}
                  <span className="text-ink-faint">{journal.length}</span>
                </button>
                {shift?.task === "shift" && (
                  <button
                    onClick={() => setTab("shifts")}
                    className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-md border border-sky-400/30 bg-sky-400/10 px-2.5 text-[11px] font-medium text-sky-400 transition-colors hover:bg-sky-400/15 focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-400/50"
                  >
                    <span
                      className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400"
                      aria-hidden="true"
                    />
                    Shift {worker.shiftCount ?? 1} planning
                    <span className="text-sky-300/70">View shift →</span>
                  </button>
                )}
              </>
            }
          />
          {/* Outside the scroller on purpose: it is the one thing here that
              must not scroll away, and it is about the desk rather than on
              it. */}
          <div className="w-full">
            <CarriedOver items={conversation} day={day} onSet={setDay} />
          </div>
          <div
            ref={scroller}
            onScroll={(e) => {
              const el = e.currentTarget;
              pinned.current = pinnedToBottom(el);
            }}
            className="min-h-0 flex-1 overflow-y-auto px-6 py-4"
          >
            <div className="min-h-full w-full">
              <WorkerTimeline
                worker={worker}
                items={dayItems}
                day={day}
                days={days}
                onSet={setDay}
                onViewWork={() => setTab("shifts")}
                workSummary={workSummary}
                focusId={focusId}
              />
            </div>
          </div>
          <div className="shrink-0 border-t border-card px-6 py-3">
            <div className="w-full">
              <WorkerErrandComposer
                worker={worker}
                intent={intent}
                onIntentChange={setIntent}
              />
            </div>
          </div>
        </>
      ) : (
        <div
          ref={scroller}
          className="min-h-0 flex-1 overflow-y-auto px-6 pb-6"
        >
          {tab === "shifts" && (
            <WorkerShiftsPane
              worker={worker}
              nextShiftAt={nextShiftAt}
              focusId={focusId}
              onFocusConsumed={() => setFocusId(null)}
            />
          )}
          {tab === "tasks" && (
            <WorkerTasksPane
              worker={worker}
              orchestrations={mine}
              onViewShifts={() => setTab("shifts")}
            />
          )}
          {tab === "files" && (
            <WorkerFiles
              workerId={worker.id}
              workerName={worker.name}
              files={files}
              setFiles={setFiles}
            />
          )}
          {tab === "journal" && <JournalList workerId={worker.id} />}
          {tab === "stats" && (
            <WorkerStats worker={worker} scorecard={scorecard} />
          )}
          {tab === "settings" && (
            <WorkerSettings
              worker={worker}
              projectLabel={projectLabel}
              files={files ?? []}
              setFiles={setFiles}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ---- Stats ---------------------------------------------------------------

function WorkerStats({
  worker,
  scorecard,
}: {
  worker: Worker;
  scorecard?: WorkerScorecard;
}) {
  const allocation = useWorkersStore((s) => s.allocation);
  const showFunds = useWorkersStore((s) => s.showFunds);
  const funding = fundingFor(allocation, worker.id);
  if (!scorecard) {
    return (
      <div className="mt-4 text-sm text-ink-muted">
        No performance record yet.
      </div>
    );
  }
  const pct =
    worker.budgetUSDPerMonth > 0
      ? Math.min(
          100,
          (scorecard.spentThisMonthUSD / worker.budgetUSDPerMonth) * 100,
        )
      : 0;
  const rows: Array<{ label: string; value: string; cls?: string }> = [
    { label: "Proposed", value: String(scorecard.proposed) },
    {
      label: "Approved",
      value: String(scorecard.approved),
      cls: "text-emerald-600 dark:text-emerald-400",
    },
    {
      label: "Rejected",
      value: String(scorecard.rejected),
      cls: "text-red-600 dark:text-red-400",
    },
    { label: "Completed", value: String(scorecard.completed) },
    { label: "Failed", value: String(scorecard.failed) },
    {
      label: "Cost per completed",
      value:
        scorecard.costPerCompletedUSD != null
          ? `$${scorecard.costPerCompletedUSD.toFixed(2)}`
          : "—",
    },
  ];
  return (
    <div className="mt-5 space-y-6">
      <div>
        <div className="text-[11px] uppercase tracking-wider text-ink-faint">
          Performance
        </div>
        <dl className="mt-2 divide-y divide-card-strong">
          {rows.map((row) => (
            <div
              key={row.label}
              className="flex items-baseline justify-between py-1.5"
            >
              <dt className="text-xs text-ink-muted">{row.label}</dt>
              <dd className={"text-sm tabular-nums " + (row.cls ?? "text-ink")}>
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <div>
        <div className="flex items-baseline gap-2">
          <div className="text-[11px] uppercase tracking-wider text-ink-faint">
            Budget
          </div>
          {funding && (
            <button
              onClick={showFunds}
              className="text-[11px] text-ink-faint hover:text-ink hover:underline focus:outline-none"
              title="The pot every worker draws from, and the order it is paid in"
            >
              {funding.enabled
                ? `priority ${funding.queuePosition} of ${allocation?.byWorker.filter((f) => f.enabled).length}`
                : "benched — outside the funding queue"}
            </button>
          )}
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-card-strong">
          <div
            className={`h-full ${pct >= 100 ? "bg-red-500" : "bg-accent"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="mt-1.5 text-xs text-ink-muted">
          ${scorecard.spentThisMonthUSD.toFixed(2)} of $
          {worker.budgetUSDPerMonth.toFixed(0)} this month.{" "}
          {pct >= 100
            ? "Out of budget — shifts idle until the month rolls over."
            : "Shifts stop when it runs out, and resume next month."}
        </div>
        {/* The cap is only half the ceiling. What this worker can actually
            draw also depends on who is above it in the funding order, and
            that is the half a per-worker page could never show. */}
        {funding && funding.blocked !== "cap" && (
          <div
            className={
              "mt-1.5 text-xs " +
              (funding.blocked === "pool" ? "text-amber-500" : "text-ink-muted")
            }
          >
            {allocation && describeFundingBlock(funding, allocation)}
          </div>
        )}
      </div>

      {scorecard.rejectionStreak > 0 && (
        <div className="rounded-md border border-amber-400/40 bg-amber-500/5 px-3 py-2 text-xs text-ink-muted">
          <span className="text-amber-500">
            {scorecard.rejectionStreak} rejection
            {scorecard.rejectionStreak === 1 ? "" : "s"} in a row.
          </span>{" "}
          {WORKER_DEMOTE_REJECTION_STREAK - scorecard.rejectionStreak > 0
            ? `${WORKER_DEMOTE_REJECTION_STREAK - scorecard.rejectionStreak} more costs a trust level.`
            : "The next one costs a trust level."}{" "}
          Approving anything resets the streak.
        </div>
      )}
    </div>
  );
}

// ---- Settings ------------------------------------------------------------

/// Everything that changes what the worker IS, plus the rules that govern it.
///
/// Two columns, because the two halves answer different questions. The left is
/// what this worker is FOR — the job it was hired against, the terms it works
/// under, and whether it is employed at all — read top to bottom. The right is
/// how much of that runs unwatched, which is a single decision you revisit
/// rarely but need in view while reading the rest.
function WorkerSettings({
  worker,
  projectLabel,
  files,
  setFiles,
}: {
  worker: Worker;
  projectLabel?: string;
  files: WorkerFile[];
  setFiles: React.Dispatch<React.SetStateAction<WorkerFile[] | null>>;
}) {
  const setEnabled = useWorkersStore((s) => s.setEnabled);
  const remove = useWorkersStore((s) => s.remove);
  const resetMemory = useWorkersStore((s) => s.resetMemory);
  const openEditor = useWorkersStore((s) => s.openEditor);
  const flows = useFlowsStore((s) => s.flows);
  const openFlowEditor = useFlowsStore((s) => s.openEditor);
  const setDetailMode = useStore((s) => s.setDetailMode);
  const [confirmingFire, setConfirmingFire] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  // What the last reset threw away, kept until the card unmounts. A reset is
  // silent by nature — the journal it emptied is the thing that would have
  // recorded it — so this line is the only acknowledgement there is.
  const [resetDone, setResetDone] = useState<{
    entries: number;
    files: number;
    shifts: number;
    errands: number;
    runs: number;
  } | null>(null);

  const startFresh = async () => {
    const res = await resetMemory(worker.id);
    setConfirmingReset(false);
    if (res) {
      setFiles([]);
      setResetDone(res);
    }
  };

  return (
    <div className="mt-5 grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_19rem]">
      <div className="min-w-0 space-y-6">
        <div>
          <div className="flex items-center gap-3">
            <div className="text-[11px] uppercase tracking-wider text-ink-faint">
              The job it was hired for
            </div>
            <button
              onClick={() => openEditor(draftFromWorker(worker))}
              className="ml-auto rounded-md border border-accent/50 px-3 py-1 text-xs text-accent hover:bg-accent/10"
            >
              Edit
            </button>
          </div>
          {/* The contract, in the one serif on the page — it is the terms of
              employment and the thing every errand is judged against, not a
              metadata field. */}
          <blockquote
            className="mt-2 whitespace-pre-wrap border-l-2 border-card-strong pl-4 text-sm italic leading-relaxed text-ink-muted"
            style={{
              fontFamily:
                'ui-serif, Georgia, Cambria, "Times New Roman", serif',
            }}
          >
            {worker.jobDescription}
          </blockquote>
        </div>

        <div>
          <div className="text-[11px] uppercase tracking-wider text-ink-faint">
            Contract
          </div>
          <dl className="mt-2 divide-y divide-card-strong">
            <div className="flex items-baseline justify-between py-1.5">
              <dt className="text-xs text-ink-muted">Works</dt>
              <dd className="text-sm text-ink">
                {describeTrigger(worker.cadence)}
              </dd>
            </div>
            <div className="flex items-baseline justify-between py-1.5">
              <dt className="text-xs text-ink-muted">Project</dt>
              <dd className="text-sm text-ink">
                {projectLabel ?? worker.projectPath}
              </dd>
            </div>
            <div className="flex items-baseline justify-between py-1.5">
              <dt className="text-xs text-ink-muted">Proposes at most</dt>
              <dd className="text-sm text-ink">
                {worker.caps.maxItemsPerShift} per shift
              </dd>
            </div>
            <div className="flex items-baseline justify-between py-1.5">
              <dt className="text-xs text-ink-muted">Runs in</dt>
              <dd className="text-sm text-ink">
                {worker.caps.runIn === "cwd"
                  ? "the working copy"
                  : "a fresh worktree"}
              </dd>
            </div>
            <div className="flex items-baseline justify-between py-1.5">
              <dt className="text-xs text-ink-muted">External actions</dt>
              <dd className="text-sm text-ink">
                {worker.caps.allowExternalActions
                  ? "allowed without approval"
                  : "approval required"}
              </dd>
            </div>
            <div className="flex items-baseline justify-between py-1.5">
              <dt className="text-xs text-ink-muted">Delegation</dt>
              <dd className="text-sm text-ink">
                {!worker.caps.canDelegate
                  ? "cannot hand work on"
                  : worker.trust === "probation"
                    ? "blocked while on probation"
                    : "may hand work to colleagues"}
              </dd>
            </div>
            {/* The flows are the machinery this worker is allowed to launch —
                the hard bound on what any errand can turn into. Reading the
                contract without being able to open them means taking the
                worker's remit on faith. */}
            <div className="flex items-baseline justify-between gap-4 py-1.5">
              <dt className="shrink-0 text-xs text-ink-muted">
                {worker.flowIds.length === 1 ? "Flow" : "Flows"}
              </dt>
              <dd className="min-w-0 text-right text-sm text-ink">
                {worker.flowIds.length === 0 ? (
                  <span className="text-ink-faint">
                    none — it can propose nothing
                  </span>
                ) : (
                  worker.flowIds.map((flowId, index) => {
                    const flow = flows.find((f) => f.id === flowId);
                    return (
                      <span key={flowId}>
                        {index > 0 && (
                          <span className="text-ink-faint">, </span>
                        )}
                        <button
                          onClick={() => {
                            openFlowEditor({ kind: "editing", flowId });
                            setDetailMode("flows");
                          }}
                          className="text-accent hover:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 rounded"
                          title={
                            flow
                              ? `Open "${flow.name}" in the flow builder`
                              : `${flowId} — not in the library any more`
                          }
                        >
                          {flow?.name ?? flowId}
                        </button>
                      </span>
                    );
                  })
                )}
              </dd>
            </div>
          </dl>
        </div>

        <AutoRenderSetting worker={worker} files={files} />

        <div>
          <div className="text-[11px] uppercase tracking-wider text-ink-faint">
            Employment
          </div>
          <div className="mt-2 flex items-center justify-between py-1.5">
            <div className="min-w-0 pr-4">
              <div className="text-sm text-ink">
                {worker.enabled ? "On the clock" : "Paused"}
              </div>
              <div className="text-xs text-ink-muted">
                {worker.enabled
                  ? "Works its cadence while overcli is open."
                  : "Fires no shifts. You can still send it an errand."}
              </div>
            </div>
            <button
              onClick={() => void setEnabled(worker.id, !worker.enabled)}
              className={
                "relative w-8 shrink-0 rounded-full transition-colors " +
                (worker.enabled ? "bg-accent" : "bg-card-strong")
              }
              style={{ height: 18 }}
              aria-label={
                worker.enabled
                  ? "Pause this worker"
                  : "Put this worker back on the clock"
              }
            >
              <span
                className="absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white transition-all"
                style={{ left: worker.enabled ? 16 : 2 }}
              />
            </button>
          </div>
          <div className="mt-2 border-t border-card-strong pt-3">
            <div className="flex items-center justify-between">
              <div className="min-w-0 pr-4">
                <div className="text-sm text-ink">
                  {worker.shiftCount
                    ? `Remembers ${worker.shiftCount} ${worker.shiftCount === 1 ? "shift" : "shifts"}`
                    : "Nothing remembered yet"}
                </div>
                <div className="text-xs text-ink-muted">
                  {resetDone
                    ? `Started fresh — removed ${resetDone.shifts} ${
                        resetDone.shifts === 1 ? "shift" : "shifts"
                      }, ${resetDone.errands} ${resetDone.errands === 1 ? "errand" : "errands"}, ${
                        resetDone.files
                      } file${resetDone.files === 1 ? "" : "s"}, ${resetDone.runs} flow run${
                        resetDone.runs === 1 ? "" : "s"
                      }, and ${resetDone.entries} journal ${
                        resetDone.entries === 1 ? "entry" : "entries"
                      }.`
                    : "Remove its history and files, then start over at shift #1."}
                </div>
              </div>
              {confirmingReset ? null : (
                <button
                  onClick={() => {
                    setResetDone(null);
                    setConfirmingReset(true);
                  }}
                  className="shrink-0 text-[11px] text-ink-faint hover:text-accent"
                >
                  Start fresh
                </button>
              )}
            </div>
            {confirmingReset ? (
              <div className="mt-2 rounded-md border border-card-strong bg-card-strong/40 p-2">
                <div className="text-xs text-ink-muted">
                  Permanently removes every shift and errand, their flow-run
                  history, all files in this worker’s cabinet, and its journal.
                  Running work is stopped. It may offer rejected ideas again.
                </div>
                <div className="mt-1 text-xs text-ink-faint">
                  Trust, budget, job description, and historical usage spend
                  stay as they are. This cannot be undone
                  {files.length ? ` (${files.length} files)` : ""}.
                </div>
                <div className="mt-2 flex gap-1">
                  <button
                    onClick={() => void startFresh()}
                    className="rounded bg-red-500/80 px-2 py-0.5 text-[11px] text-white"
                  >
                    Reset worker
                  </button>
                  <button
                    onClick={() => {
                      setConfirmingReset(false);
                    }}
                    className="rounded border border-card-strong px-2 py-0.5 text-[11px]"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
          </div>
          <div className="mt-2 flex items-center justify-between border-t border-card-strong pt-3">
            <div className="min-w-0 pr-4 text-xs text-ink-muted">
              Firing removes the persona. Its runs, proposals and journal stay.
            </div>
            {confirmingFire ? (
              <div className="flex shrink-0 gap-1">
                <button
                  onClick={() => void remove(worker.id)}
                  className="rounded bg-red-500/80 px-2 py-0.5 text-[11px] text-white"
                >
                  Fire {worker.name}
                </button>
                <button
                  onClick={() => setConfirmingFire(false)}
                  className="rounded border border-card-strong px-2 py-0.5 text-[11px]"
                >
                  Keep
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmingFire(true)}
                className="shrink-0 text-[11px] text-ink-faint hover:text-red-400"
              >
                Fire
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="min-w-0 space-y-4">
        <TrustLadder worker={worker} />
        <ShareCard worker={worker} />
      </div>
    </div>
  );
}

/// The worker as a file another team can hire from.
///
/// It sits under the trust ladder because it is the same subject read the
/// other way round: the ladder is what THIS install has decided to let the
/// worker do, and the share file is everything that is true about the worker
/// with those decisions removed. Showing the YAML rather than only offering a
/// download is the point — you are about to hand someone a description of a
/// thing that will run on their machine, so you should be able to read it
/// first, and see for yourself that the trust level and the project path are
/// not in it.
function ShareCard({ worker }: { worker: Worker }) {
  const shareYaml = useWorkersStore((s) => s.shareYaml);
  const shareToFile = useWorkersStore((s) => s.shareToFile);
  const [open, setOpen] = useState(false);
  const [share, setShare] = useState<{
    yaml: string;
    missingFlowIds: string[];
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [savedTo, setSavedTo] = useState<string | null>(null);

  // Re-read whenever the card is open and the worker changes: the YAML is a
  // rendering of the contract above it, and one that lagged an edit would be
  // a file that says something the screen no longer does.
  useEffect(() => {
    if (!open) return;
    let live = true;
    void shareYaml(worker.id).then((res) => {
      if (live) setShare(res);
    });
    return () => {
      live = false;
    };
  }, [open, worker, shareYaml]);

  return (
    <div className="rounded-xl border border-card-strong p-3">
      <div className="flex items-center gap-2">
        <div className="text-[11px] uppercase tracking-wider text-ink-faint">
          Share
        </div>
        <button
          onClick={() => setOpen((v) => !v)}
          className="ml-auto text-[11px] text-accent hover:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 rounded"
        >
          {open ? "Hide the file" : "Show the file"}
        </button>
      </div>
      <p className="mt-2 text-xs text-ink-muted">
        The job, as YAML — its cadence, its caps, and the flows it launches,
        embedded whole. Its trust, its history and this project's path stay
        here. Whoever imports it hires it themselves, on probation.
      </p>

      <div className="mt-3 flex flex-wrap gap-1.5">
        <button
          onClick={() => {
            void shareToFile(worker.id).then((filePath) => {
              if (filePath) setSavedTo(filePath);
            });
          }}
          className="rounded-md border border-accent/50 px-2.5 py-1 text-[11px] text-accent hover:bg-accent/10"
        >
          Save file…
        </button>
        <button
          onClick={() => {
            void shareYaml(worker.id).then((res) => {
              if (!res) return;
              setShare(res);
              void navigator.clipboard.writeText(res.yaml);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
          className="rounded-md border border-card-strong px-2.5 py-1 text-[11px] text-ink-muted hover:text-ink"
        >
          {copied ? "Copied" : "Copy YAML"}
        </button>
      </div>

      {savedTo && (
        <div
          className="mt-2 truncate text-[10px] text-ink-faint"
          title={savedTo}
        >
          Saved to {savedTo}
        </div>
      )}

      {/* A flow the worker names but the library no longer has cannot be
          embedded, so the file would arrive short of the machinery it
          promises. Said here rather than on the recipient's screen: it is
          this install's problem to fix. */}
      {share && share.missingFlowIds.length > 0 && (
        <div className="mt-2 text-[10px] text-amber-400">
          {share.missingFlowIds.join(", ")}{" "}
          {share.missingFlowIds.length === 1 ? "is" : "are"} not in your
          library, so{" "}
          {share.missingFlowIds.length === 1 ? "it travels" : "they travel"} as
          a name only.
        </div>
      )}

      {open && (
        <pre className="mt-3 max-h-64 overflow-auto rounded-lg bg-card-strong/50 p-2 text-[10px] leading-relaxed text-ink-muted">
          {share ? share.yaml : "Reading…"}
        </pre>
      )}
    </div>
  );
}

/// What this worker shows you when you open it.
///
/// The options are the outputs it has actually FILED, not a free-text box and
/// not its flows' declared step outputs — those name the receipt and never
/// name the page, because a step that renders a dashboard writes the file and
/// declares the note. A worker that has never written a page says so and
/// offers nothing to pick, which is the honest form of this control: there is
/// no output to auto-render, so there is no choice to make.
function AutoRenderSetting({
  worker,
  files,
}: {
  worker: Worker;
  files: WorkerFile[];
}) {
  const setAutoRender = useWorkersStore((s) => s.setAutoRender);
  const outputs = useMemo(() => workerRenderableOutputs(files), [files]);
  const value = worker.autoRender ?? WORKER_AUTO_RENDER_NEWEST;
  // A pinned name whose file has since been deleted would otherwise leave the
  // select showing an unrelated option while the worker is still pinned to it.
  const names = outputs.map((f) => baseName(f.name));
  const missing =
    value !== WORKER_AUTO_RENDER_NEWEST &&
    value !== WORKER_AUTO_RENDER_OFF &&
    !names.includes(value);

  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-ink-faint">
        On arrival
      </div>
      <div className="mt-2 flex items-center justify-between gap-4 py-1.5">
        <div className="min-w-0">
          <div className="text-sm text-ink">Render its report</div>
          <div className="text-xs text-ink-muted">
            {outputs.length === 0
              ? "This worker has not written a page yet. Anything it files as .html or a component shows up here."
              : "Opens in the preview beside the desk the moment you select this worker."}
          </div>
        </div>
        <select
          value={value}
          onChange={(e) => void setAutoRender(worker.id, e.target.value)}
          aria-label="What to render when this worker is opened"
          className="field shrink-0 px-2 py-1 text-xs"
        >
          <option value={WORKER_AUTO_RENDER_NEWEST}>
            {outputs.length === 0
              ? "Newest report"
              : `Newest report (${baseName(outputs[0].name)})`}
          </option>
          {names.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
          {missing && (
            <option value={value}>{value} — not filed any more</option>
          )}
          <option value={WORKER_AUTO_RENDER_OFF}>Nothing</option>
        </select>
      </div>
    </div>
  );
}

/// The signature element, and the control itself.
///
/// Trust decides how much of a worker's output starts without you watching,
/// so each rung states its own consequence in items per shift and the whole
/// rung is the button — clicking one moves the worker there. Separate
/// Promote/Demote buttons made you read the ladder, look away, and press
/// something else; here the thing you read is the thing you press.
///
/// Moving down is also automatic, and that rule is written underneath rather
/// than left to be discovered when a worker quietly loses a level.
function TrustLadder({ worker }: { worker: Worker }) {
  const setTrust = useWorkersStore((s) => s.setTrust);
  const rungs: Array<{ level: WorkerTrustLevel; blurb: string }> = [
    { level: "probation", blurb: "Everything waits for you." },
    { level: "trusted", blurb: "Its best work starts on its own." },
    { level: "autonomous", blurb: "It runs a full shift unattended." },
  ];

  return (
    <div className="rounded-xl border border-card-strong p-3">
      <div className="text-[11px] uppercase tracking-wider text-ink-faint">
        Trust
      </div>
      <div className="mt-2 space-y-1">
        {rungs.map((rung) => {
          const cap = workerAutoApproveCap({
            trust: rung.level,
            caps: worker.caps,
          });
          const here = rung.level === worker.trust;
          const dot =
            rung.level === "autonomous"
              ? "bg-emerald-400"
              : rung.level === "trusted"
                ? "bg-sky-400"
                : "bg-amber-400";
          return (
            <button
              key={rung.level}
              onClick={() => {
                if (!here) void setTrust(worker.id, rung.level);
              }}
              aria-current={here ? "true" : undefined}
              disabled={here}
              title={
                here
                  ? `${worker.name} is ${rung.level}.`
                  : `Move ${worker.name} to ${rung.level}: ${
                      cap === 0
                        ? "nothing runs unattended."
                        : `its best ${cap} proposal${cap === 1 ? "" : "s"} per shift launch without waiting for you.`
                    }`
              }
              className={
                "flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors " +
                "focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 " +
                (here
                  ? "bg-card-strong/60 cursor-default"
                  : "opacity-60 hover:bg-card-strong/40 hover:opacity-100")
              }
            >
              <span className={"mt-1.5 h-2 w-2 shrink-0 rounded-full " + dot} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-1.5">
                  <span
                    className={
                      "text-sm " + (here ? "text-ink" : "text-ink-muted")
                    }
                  >
                    {TRUST_LABEL[rung.level].text}
                  </span>
                  {here && (
                    <span className="text-[10px] text-ink-faint">
                      where it stands
                    </span>
                  )}
                </span>
                <span className="block text-xs text-ink-muted">
                  {rung.blurb}
                </span>
                <span className="block text-[10px] tabular-nums text-ink-faint">
                  {cap === 0 ? "nothing unattended" : `${cap}/shift unattended`}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-3 border-t border-card-strong pt-2 text-xs text-ink-muted">
        Moving up is your call. Moving down is not:{" "}
        {WORKER_DEMOTE_REJECTION_STREAK} rejections in a row drop it one rung
        automatically, and approving anything resets the count.
      </p>
    </div>
  );
}

// ---- Files --------------------------------------------------------------

/// The worker's own directory: deliverables the engine filed after each run,
/// plus whatever the worker wrote for itself during a shift.
///
/// Grouped rather than listed by date. A worker that has been running a week
/// has reports from errands, reports from shifts, and its own working notes
/// all interleaved, and those are three different things to go looking for —
/// "what did I ask for" is a different question from "what did it do on its
/// own" and from "what is it keeping". The engine's filenames already encode
/// which is which, so the grouping is read off real data, not guessed.
function WorkerFiles({
  workerId,
  workerName,
  files,
  setFiles,
}: {
  workerId: string;
  workerName: string;
  /// Read once by the pane that owns the worker — the tab renders the same
  /// list the auto-render picks from, so the two can never disagree about
  /// what is in the directory.
  files: WorkerFile[] | null;
  setFiles: React.Dispatch<React.SetStateAction<WorkerFile[] | null>>;
}) {
  const [query, setQuery] = useState("");
  const openFile = useStore((s) => s.openFile);

  const groups = useMemo(
    () => groupWorkerFiles(files ?? [], query),
    [files, query],
  );

  // Deleting drops the rows locally rather than re-reading the directory: the
  // list is already the truth about what was there, and a re-read would flash
  // the whole tab through its loading state to say one row less.
  const remove = async (job: WorkerFileJob) => {
    const res = await window.overcli.invoke("workers:deleteFile", {
      id: workerId,
      name: job.folder ? job.key : job.files[0].name,
    });
    if (!res.ok) return;
    const gone = new Set(job.files.map((f) => f.name));
    setFiles((cur) => (cur ?? []).filter((f) => !gone.has(f.name)));
  };

  if (!files) {
    return (
      <div className="mt-4 text-xs text-ink-faint">
        Reading {workerName}’s files…
      </div>
    );
  }

  return (
    <div className="mt-4">
      <div className="mb-3 flex items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          placeholder={`Search ${files.length} file${files.length === 1 ? "" : "s"}…`}
          aria-label="Search this worker’s files"
          className="field min-w-0 flex-1 px-2 py-1 text-xs"
        />
        <span
          className="shrink-0 text-[11px] tabular-nums text-ink-faint"
          title="Nothing prunes these — outliving the run is the point"
        >
          {formatBytes(files.reduce((n, f) => n + f.bytes, 0))}
        </span>
        <button
          onClick={() =>
            void window.overcli.invoke("workers:revealFiles", { id: workerId })
          }
          className="shrink-0 rounded-md border border-card-strong px-2.5 py-1 text-xs text-ink-muted hover:bg-white/5 hover:text-ink"
        >
          Reveal on disk
        </button>
      </div>

      {files.length === 0 ? (
        <div className="rounded-lg border border-dashed border-card-strong px-4 py-6 text-center text-xs text-ink-muted">
          {workerName} keeps its reports and working notes here. It fills up as
          it works — or you can drop something in for it to read.
        </div>
      ) : groups.length === 0 ? (
        <div className="text-xs text-ink-faint">Nothing matches “{query}”.</div>
      ) : (
        <div className="space-y-5">
          {groups.map((group) => (
            <div key={group.key}>
              <div className="flex items-baseline gap-2">
                <span className="text-[11px] uppercase tracking-wider text-ink-faint">
                  {group.label}
                </span>
                <span className="text-[11px] text-ink-faint">
                  — {group.blurb}
                </span>
                <span className="ml-auto text-[11px] tabular-nums text-ink-faint">
                  {group.jobs.reduce((n, job) => n + job.files.length, 0)}
                </span>
              </div>
              <div className="mt-1 divide-y divide-card-strong">
                {group.jobs.map((job) => (
                  <JobRow
                    key={job.key}
                    job={job}
                    onOpen={openFile}
                    onDelete={remove}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/// One job's output. A run that produced several files was filed into a
/// directory, and that directory IS the errand or shift — so it reads as a
/// folder you open, not as five filenames you have to parse and re-associate
/// yourself. A single-file job skips the folder and opens directly: making you
/// expand something to reach its only child is a step that buys nothing.
function JobRow({
  job,
  onOpen,
  onDelete,
}: {
  job: WorkerFileJob;
  onOpen: (path: string, highlight: undefined, mode: "preview") => void;
  onDelete: (job: WorkerFileJob) => void;
}) {
  const [open, setOpen] = useState(false);
  // Deleting a job takes the whole folder, and nothing here is recoverable —
  // these ARE the copies that outlive the run. So the confirm replaces the row
  // rather than living behind a dialog, and it names what goes.
  const [confirming, setConfirming] = useState(false);
  const only = job.files.length === 1 ? job.files[0] : null;
  const bytes = job.files.reduce((n, f) => n + f.bytes, 0);

  if (confirming) {
    return (
      <div className="flex items-center gap-2 py-1.5">
        <span className="min-w-0 flex-1 truncate text-xs text-ink-muted">
          Delete{" "}
          {only ? job.label : `${job.label} and its ${job.files.length} files`}?
          The run it came from is gone or will be.
        </span>
        <button
          onClick={() => {
            setConfirming(false);
            onDelete(job);
          }}
          className="shrink-0 rounded bg-red-500/80 px-2 py-0.5 text-[11px] text-white hover:bg-red-500 focus:outline-none"
        >
          Delete
        </button>
        <button
          onClick={() => setConfirming(false)}
          className="shrink-0 rounded bg-card px-2 py-0.5 text-[11px] text-ink-muted hover:bg-card-strong focus:outline-none"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div>
      {/* The row and its delete sit on one line; the expansion belongs under
          both, so the flex is on the row rather than the whole job. */}
      <div className="group/job flex items-baseline">
        <button
          onClick={() =>
            only ? onOpen(only.path, undefined, "preview") : setOpen((v) => !v)
          }
          title={only ? `Open ${only.name}` : `${job.files.length} files`}
          className="flex w-full items-baseline gap-3 py-1.5 text-left hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
        >
          <span className="w-3 shrink-0 text-[10px] text-ink-faint">
            {only ? "" : open ? "▾" : "▸"}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm text-ink">
            {job.label}
          </span>
          {!only && (
            <span className="shrink-0 text-[11px] tabular-nums text-ink-faint">
              {job.files.length} files
            </span>
          )}
          <span className="shrink-0 text-[11px] tabular-nums text-ink-faint">
            {formatBytes(bytes)}
          </span>
          <span
            className="shrink-0 text-[11px] tabular-nums text-ink-faint"
            title={relativeTime(job.at)}
          >
            {fileDate(job.at)}
          </span>
        </button>
        <button
          onClick={() => setConfirming(true)}
          title="Delete this job’s files"
          aria-label="Delete this job’s files"
          className="ml-2 shrink-0 rounded px-1 text-[11px] leading-5 text-ink-faint opacity-0 hover:bg-card-strong hover:text-red-500 focus:opacity-100 focus:outline-none group-hover/job:opacity-100"
        >
          ×
        </button>
      </div>
      {open && !only && (
        <div className="mb-1 ml-3 border-l border-card-strong pl-3">
          {job.files.map((file) => (
            <button
              key={file.path}
              onClick={() => onOpen(file.path, undefined, "preview")}
              title={`Open ${file.name}`}
              className="flex w-full items-baseline gap-3 py-1 text-left hover:text-ink focus:outline-none"
            >
              <span className="min-w-0 flex-1 truncate text-xs text-ink-muted">
                {baseName(file.name)}
              </span>
              <span className="shrink-0 text-[11px] tabular-nums text-ink-faint">
                {formatBytes(file.bytes)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/// The file's own name, without the folder the filing put it in — the folder
/// is the row above, and repeating it in every chip crowds out the one word
/// that distinguishes them.
function baseName(name: string): string {
  const cut = name.lastIndexOf("/");
  return cut === -1 ? name : name.slice(cut + 1);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---- The shift in flight -------------------------------------------------

/// What this worker is doing on its own clock, right now.
///
/// The desk answers anything, including questions about shifts, and it stays
/// the chronological record. But a shift IN PROGRESS is not a conversation —
/// it is a job running — and rendering it as one line of transcript was the
/// weakest possible treatment of the thing you most want to watch. This is
/// where you watch it: the planning turn as it thinks, then the work it
/// launched, then what is waiting on you.
///
/// Idle is a real state here, not an empty one. A worker between shifts should
/// say when the next one is and what the last one did, so the tab answers
/// "should I be expecting something" without a click.
function WorkerShiftsPane({
  worker,
  nextShiftAt,
  focusId,
  onFocusConsumed,
}: {
  worker: Worker;
  nextShiftAt: number | null;
  focusId: string | null;
  onFocusConsumed: () => void;
}) {
  const shift = useWorkersStore((s) => s.shiftProgress[worker.id]);
  const orchestrations = useOrchestratorStore((s) => s.orchestrations);
  const openWorkerActivity = useWorkersStore((s) => s.openWorkerActivity);

  const shifts = useMemo(
    () =>
      Object.values(orchestrations)
        .filter(
          (item) =>
            item.origin?.kind === "worker" &&
            item.origin.workerId === worker.id,
        )
        .filter((item) => orchestrationTask(item) === "shift")
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 40)
        .map(toWorkerActivity),
    [orchestrations, worker.id],
  );
  const latest = shifts[0];
  const focused = useRef<HTMLDivElement>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  useEffect(() => {
    if (!focusId) return;
    setHighlightedId(focusId);
    setExpandedId(focusId);
    focused.current?.scrollIntoView({ block: "center" });
    onFocusConsumed();
  }, [focusId, onFocusConsumed, shifts.length]);
  const planning = shift?.task === "shift";
  const working = !!latest && (latest.running > 0 || latest.proposed > 0);

  return (
    <div className="space-y-5 pt-4">
      <section className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-card-strong bg-card/30 p-5 shadow-sm">
        <div>
          <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-ink-faint">
            Shift status
          </div>
          <div className="mt-2 text-xl font-semibold text-ink">
            {planning
              ? `${worker.name} is planning its shift`
              : working
                ? `Shift ${latest?.title.replace(/^Shift\s*/, "") ?? ""} is running`
                : "Between shifts"}
          </div>
          <div className="mt-1 text-xs text-ink-muted">
            {worker.enabled
              ? nextShiftAt != null
                ? `Next shift ${untilLabel(nextShiftAt)}`
                : describeTrigger(worker.cadence)
              : "paused — no shifts until you resume it"}
          </div>
        </div>
        <div className="rounded-lg border border-card-strong bg-surface-elevated/50 px-4 py-3 text-right">
          <div className="text-[10px] uppercase tracking-wider text-ink-faint">
            Cadence
          </div>
          <div className="mt-1 text-sm font-medium text-ink">
            {describeTrigger(worker.cadence)}
          </div>
          <div className="mt-0.5 text-[11px] text-ink-faint">
            {shifts.length} recorded shift{shifts.length === 1 ? "" : "s"}
          </div>
        </div>
      </section>

      {/* The planning turn, as it arrives. A worker deciding what today's
          version of its job is has reasoning worth reading — it is the part
          you would have to trust blindly otherwise. */}
      {planning && (
        <div className="rounded-xl border border-sky-400/30 bg-sky-400/[0.04] px-4 py-3">
          <div className="mb-2 flex items-center gap-2 text-[11px] text-sky-500">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-60" />
              <span className="relative h-1.5 w-1.5 rounded-full bg-sky-400" />
            </span>
            <span>Planning</span>
            {shift.tools.length > 0 && (
              <span className="truncate text-ink-faint">
                {shift.tools[shift.tools.length - 1]}
              </span>
            )}
          </div>
          {shift.text ? (
            <div className="text-xs leading-relaxed text-ink-muted">
              <Markdown source={shift.text} />
            </div>
          ) : (
            <div className="text-xs text-ink-faint">
              Reading its job description and journal…
            </div>
          )}
        </div>
      )}

      {latest ? (
        <section>
          <div className="mb-3 flex items-end justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-ink">
                Shift history
              </div>
              <div className="mt-0.5 text-xs text-ink-muted">
                Newest first. Open details only when you need the full planning
                record.
              </div>
            </div>
          </div>
          <div className="space-y-2">
            {shifts.map((item, index) => {
              const expanded =
                expandedId === item.orchestration.id ||
                (expandedId === null && index === 0);
              return (
                <div
                  key={item.orchestration.id}
                  ref={
                    item.orchestration.id === highlightedId
                      ? focused
                      : undefined
                  }
                  className={
                    "overflow-hidden rounded-xl border bg-card/20 shadow-sm " +
                    (item.orchestration.id === highlightedId
                      ? "border-accent ring-1 ring-accent/30"
                      : "border-card-strong")
                  }
                >
                  <div className="group relative flex flex-wrap items-center gap-2 px-4 py-3">
                    <button
                      onClick={() =>
                        setExpandedId(expanded ? "" : item.orchestration.id)
                      }
                      className="absolute inset-0 rounded-t-xl transition-colors hover:bg-card/40 focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/60"
                      aria-expanded={expanded}
                      aria-label={`${expanded ? "Hide" : "Show"} details for ${item.title}`}
                    />
                    <span className="pointer-events-none relative text-sm font-medium text-ink">
                      {item.title}
                    </span>
                    <span className="pointer-events-none relative text-[11px] text-ink-faint">
                      {relativeTime(item.at)}
                    </span>
                    <ShiftOutcomeBadges item={item} />
                    {index === 0 && (
                      <span className="pointer-events-none relative rounded-full bg-accent/10 px-2 py-0.5 text-[9px] font-medium uppercase tracking-wider text-accent">
                        Latest
                      </span>
                    )}
                    <div className="relative z-10 ml-auto flex h-7 items-center gap-1">
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          setExpandedId(expanded ? "" : item.orchestration.id);
                        }}
                        className="inline-flex h-7 items-center rounded-md px-2 text-[11px] text-ink-muted transition-colors hover:bg-card hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
                        aria-expanded={expanded}
                      >
                        {expanded ? "Hide details" : "Show details"}
                      </button>
                      <ReadInFull worker={worker} item={item} inline />
                    </div>
                  </div>
                  {expanded && (
                    <div className="border-t border-card-strong bg-card/30 px-4 py-3">
                      <div className="rounded-lg bg-surface/40 px-3 py-2">
                        <ShiftPlan orchestration={item.orchestration} />
                      </div>
                      {isOrchestrationAwaitingApproval(item.orchestration) && (
                        <WorkerPendingProposal
                          orchestration={item.orchestration}
                        />
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ) : (
        !planning && (
          <div className="rounded-xl border border-dashed border-card-strong px-4 py-8 text-center">
            <div className="text-sm text-ink">No shift worked yet.</div>
            <div className="mt-1 text-xs text-ink-muted">
              {worker.enabled
                ? `${worker.name} files its first shift here when its clock comes round.`
                : `${worker.name} is paused — resume it in Settings, or work one now.`}
            </div>
          </div>
        )
      )}
    </div>
  );
}

interface WorkerTaskEntry {
  orchestration: Orchestration;
  item: OrchestrationItem;
  sourceKind: "shift" | "conversation";
  sourceLabel: string;
  sourceDetail: string;
  at: number;
  durationMs: number | null;
}

function formatTaskDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return seconds === 0 ? "<1s" : `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60)
    return remainingSeconds > 0
      ? `${minutes}m ${remainingSeconds}s`
      : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

/// Concrete work, separated from the shifts that proposed it. Shifts explains
/// what the worker considered on each turn; Tasks is the operational ledger of
/// what actually entered execution, regardless of which shift or Create work
/// message launched it.
function WorkerTasksPane({
  worker,
  orchestrations,
  onViewShifts,
}: {
  worker: Worker;
  orchestrations: Orchestration[];
  onViewShifts: () => void;
}) {
  const tasks = useMemo<WorkerTaskEntry[]>(
    () =>
      orchestrations
        .flatMap((orchestration) => {
          const activity = toWorkerActivity(orchestration);
          const sourceKind: WorkerTaskEntry["sourceKind"] =
            activity.task === "shift" ? "shift" : "conversation";
          const origin =
            orchestration.origin?.kind === "worker"
              ? orchestration.origin
              : null;
          const sourceLabel =
            sourceKind === "shift"
              ? activity.title
              : origin?.from
                ? `From ${origin.from.workerName}`
                : "Conversation";
          const sourceDetail =
            sourceKind === "conversation"
              ? (origin?.errand ??
                orchestration.title.replace(/^\[Errand\]\s*/i, ""))
              : "";
          return orchestration.items
            .filter((item) =>
              [
                "proposed",
                "queued",
                "running",
                "paused",
                "done",
                "failed",
              ].includes(item.status),
            )
            .map((item) => ({
              orchestration,
              item,
              sourceKind,
              sourceLabel,
              sourceDetail,
              at: item.finishedAt ?? item.startedAt ?? orchestration.createdAt,
              durationMs: item.startedAt
                ? Math.max(0, (item.finishedAt ?? Date.now()) - item.startedAt)
                : null,
            }));
        })
        .sort((a, b) => b.at - a.at),
    [orchestrations],
  );
  const active = tasks.filter(({ item }) =>
    ["queued", "running", "paused"].includes(item.status),
  ).length;
  const needsReview = tasks.filter(
    ({ item }) => item.status === "proposed",
  ).length;
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<
    "all" | "active" | "review" | "completed" | "failed"
  >("all");
  const [sourceFilter, setSourceFilter] = useState<
    "all" | "shift" | "conversation"
  >("all");
  const [visibleCount, setVisibleCount] = useState(25);
  useEffect(() => {
    setVisibleCount(25);
  }, [worker.id, query, statusFilter, sourceFilter]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return tasks.filter((entry) => {
      const statusMatches =
        statusFilter === "all" ||
        (statusFilter === "active" &&
          ["queued", "running", "paused"].includes(entry.item.status)) ||
        (statusFilter === "review" && entry.item.status === "proposed") ||
        (statusFilter === "completed" && entry.item.status === "done") ||
        (statusFilter === "failed" && entry.item.status === "failed");
      const sourceMatches =
        sourceFilter === "all" || sourceFilter === entry.sourceKind;
      const queryMatches =
        !needle ||
        [
          entry.item.candidate.title,
          entry.sourceLabel,
          entry.sourceDetail,
        ].some((value) => value.toLowerCase().includes(needle));
      return statusMatches && sourceMatches && queryMatches;
    });
  }, [tasks, query, statusFilter, sourceFilter]);
  const visible = filtered.slice(0, visibleCount);
  const clearFilters = () => {
    setQuery("");
    setStatusFilter("all");
    setSourceFilter("all");
  };

  return (
    <div className="space-y-4 pt-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
            Tasks
          </div>
          <div className="mt-1 text-lg font-semibold text-ink">
            {worker.name}&apos;s tasks
          </div>
          <div className="mt-0.5 text-xs text-ink-muted">
            Work launched from shifts and conversations, newest first.
          </div>
        </div>
        {filtered.length !== tasks.length && (
          <div className="text-xs text-ink-muted">
            {filtered.length} of {tasks.length}
          </div>
        )}
      </div>

      {(active > 0 || needsReview > 0) && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-sky-400/20 bg-sky-400/[0.05] px-3 py-2 text-xs">
          {active > 0 && (
            <span className="font-medium text-sky-400">{active} active</span>
          )}
          {active > 0 && needsReview > 0 && (
            <span className="text-ink-faint">·</span>
          )}
          {needsReview > 0 && (
            <span className="font-medium text-violet-400">
              {needsReview} awaiting review
            </span>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2 rounded-xl border border-card-strong bg-card/20 p-3 md:flex-row md:items-center">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search tasks"
          placeholder="Search tasks…"
          className="h-8 min-w-0 flex-1 rounded-md border border-card-strong bg-surface px-3 text-xs text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
        />
        <div
          className="flex shrink-0 gap-1 overflow-x-auto"
          role="group"
          aria-label="Filter tasks by status"
        >
          {(
            [
              ["all", "All"],
              ["active", "Active"],
              ["review", "Needs review"],
              ["completed", "Completed"],
              ["failed", "Failed"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setStatusFilter(key)}
              aria-pressed={statusFilter === key}
              className={`h-7 shrink-0 rounded-md px-2.5 text-[11px] font-medium transition-colors ${statusFilter === key ? "bg-accent/15 text-accent" : "text-ink-muted hover:bg-card hover:text-ink"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div
          className="flex shrink-0 gap-1 overflow-x-auto border-l border-card-strong pl-2"
          role="group"
          aria-label="Filter tasks by source"
        >
          {(
            [
              ["all", "All sources"],
              ["shift", "Shifts"],
              ["conversation", "Conversations"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setSourceFilter(key)}
              aria-pressed={sourceFilter === key}
              className={`h-7 shrink-0 rounded-md px-2.5 text-[11px] font-medium transition-colors ${sourceFilter === key ? "bg-accent/15 text-accent" : "text-ink-muted hover:bg-card hover:text-ink"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {tasks.length > 0 && filtered.length > 0 ? (
        <section>
          <div className="mb-3">
            <div className="text-sm font-semibold text-ink">Task history</div>
            <div className="mt-0.5 text-xs text-ink-muted">
              Open a task to see its run, steps, transcript, and files.
            </div>
          </div>
          <div className="divide-y divide-card-strong overflow-hidden rounded-xl border border-card-strong bg-card/20">
            <div className="hidden grid-cols-[minmax(18rem,1fr)_9rem_7rem_7rem] gap-4 border-b border-card-strong bg-card/30 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-muted md:grid">
              <span>Task</span>
              <span>Source</span>
              <span>Duration</span>
              <span className="text-right">Finished</span>
            </div>
            {visible.map(
              ({
                orchestration,
                item,
                sourceLabel,
                sourceDetail,
                at,
                durationMs,
              }) => (
                <PlanItemRow
                  key={`${orchestration.id}:${item.candidate.id}`}
                  item={item}
                  orchestration={orchestration}
                  context={{
                    sourceLabel,
                    sourceDetail,
                    at,
                    durationMs,
                    onReview: onViewShifts,
                  }}
                  compactArtifacts
                />
              ),
            )}
          </div>
          {visibleCount < filtered.length && (
            <button
              onClick={() => setVisibleCount((count) => count + 25)}
              className="mx-auto mt-4 flex h-9 items-center rounded-md border border-card-strong bg-card/30 px-4 text-xs font-medium text-ink-muted transition-colors hover:bg-card/60 hover:text-ink"
            >
              Load 25 more · {filtered.length - visibleCount} remaining
            </button>
          )}
        </section>
      ) : tasks.length > 0 ? (
        <div className="rounded-xl border border-dashed border-card-strong px-4 py-10 text-center">
          <div className="text-sm font-medium text-ink">
            No tasks match these filters.
          </div>
          <button
            onClick={clearFilters}
            className="mt-3 text-xs font-medium text-accent hover:underline"
          >
            Clear filters
          </button>
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-card-strong px-4 py-10 text-center">
          <div className="text-sm font-medium text-ink">No tasks yet</div>
          <div className="mx-auto mt-1 max-w-sm text-xs leading-5 text-ink-muted">
            Tasks appear here when a shift or Create work message launches a
            flow.
          </div>
        </div>
      )}
    </div>
  );
}

function ShiftOutcomeBadges({ item }: { item: WorkerActivity }) {
  const badges = item.launchedNothing
    ? [
        {
          label: "Quiet · nothing proposed",
          cls: "border-sky-400/20 bg-sky-400/10 text-sky-400",
        },
      ]
    : [
        item.proposed > 0 && {
          label: `${item.proposed} awaiting review`,
          cls: "border-violet-400/25 bg-violet-400/10 text-violet-400",
        },
        item.running > 0 && {
          label: `${item.running} running`,
          cls: "border-sky-400/25 bg-sky-400/10 text-sky-400",
        },
        item.done > 0 && {
          label: `${item.done} completed`,
          cls: "border-emerald-400/25 bg-emerald-400/10 text-emerald-400",
        },
        item.failed > 0 && {
          label: `${item.failed} failed`,
          cls: "border-red-400/25 bg-red-400/10 text-red-400",
        },
      ].filter((badge): badge is { label: string; cls: string } => !!badge);
  return (
    <span className="pointer-events-none relative flex flex-wrap items-center gap-1.5">
      {badges.map((badge) => (
        <span
          key={badge.label}
          className={`rounded-full border px-2 py-0.5 text-[9px] font-medium ${badge.cls}`}
        >
          {badge.label}
        </span>
      ))}
    </span>
  );
}

// ---- Timeline ------------------------------------------------------------

/// One worker's story, oldest first, in the app's own chat layout: your
/// errands as user turns, the worker's replies as assistant turns, and the
/// shifts it worked on its own clock as quiet rules between them.
///
/// It reuses `UserBubble` outright and mirrors `AssistantBubble`'s shape
/// exactly — same rounded panel, same tint-derived fill and border, same 2px
/// left rail and small coloured label. A worker talking to you should not
/// invent a second visual language for the same act; the only thing that
/// differs is the rail colour, which is the worker's trust tint, so a reply
/// carries its author's standing the way a model reply carries its model.
function WorkerTimeline({
  worker,
  items,
  day,
  days,
  onSet,
  onViewWork,
  workSummary,
  focusId,
}: {
  worker: Worker;
  /// This day's turns, oldest first. The desk is scoped to one day — see
  /// DeskDayBar — so this is the whole transcript, not a window onto it.
  items: WorkerActivity[];
  day: number;
  days: DeskDay[];
  onSet: (day: number) => void;
  onViewWork: () => void;
  workSummary: WorkerWorkSummary;
  /// A turn arrived at from somewhere else (the shift calendar): opened and
  /// scrolled to, whatever the default expansion rule would have done.
  focusId: string | null;
}) {
  const sending = useWorkersStore((s) => s.errandSending[worker.id]);
  const live = useWorkersStore((s) => s.shiftProgress[worker.id]);
  // Expansion follows the work by default, and a click overrides it. A turn
  // that PRODUCED something — launched, queued, waiting on your approval,
  // failed — opens itself, because the work is the answer to why you are
  // looking at the turn at all. Only a turn that launched nothing (a refusal,
  // a plain answer) stays shut, and it has nothing to show anyway. This used
  // to require work to be still-running, which meant a finished shift hid its
  // own results behind a click on a desk that now only holds one day.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const tint = TRUST_TINT[worker.trust];
  const focused = useRef<HTMLDivElement>(null);
  const today = startOfDay(Date.now());
  const isToday = day === today;

  useEffect(() => {
    if (focusId) focused.current?.scrollIntoView({ block: "center" });
  }, [focusId, items.length]);

  // A day whose only content is the turn in flight is not an empty day. The
  // first shift of the morning starts on a cleared desk, which is exactly when
  // "nothing here" would be the most wrong thing the page could say.
  if (items.length === 0 && isToday && live?.task === "shift") {
    return (
      <PlanningDesk
        worker={worker}
        shiftNumber={worker.shiftCount ?? 1}
        onViewWork={onViewWork}
      />
    );
  }
  const pending =
    isToday && ((sending && sending.length > 0) || live?.task === "errand");
  if (items.length === 0 && !pending) {
    return (
      <EmptyDesk
        worker={worker}
        day={day}
        days={days}
        onSet={onSet}
        onViewWork={onViewWork}
        workSummary={workSummary}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {items.map((item) => {
        const awaiting = isOrchestrationAwaitingApproval(item.orchestration);
        const id = item.orchestration.id;
        const produced =
          item.intent === "work" && item.orchestration.items.length > 0;
        const open = overrides[id] ?? (id === focusId || produced);
        const toggle = () => setOverrides((cur) => ({ ...cur, [id]: !open }));
        const anchor = id === focusId ? focused : undefined;

        const launched = item.running + item.done + item.failed;
        return (
          <div key={id} ref={anchor} className="flex flex-col gap-2">
            {/* An errand a colleague sent still renders in the message
                position, because that is where the ask belongs — but the
                bubble reads as YOUR words, and these are not. Attribute it
                rather than moving it: the thread is what this worker was
                asked, not what you personally typed. */}
            {item.from && (
              <div className="self-end text-[11px] text-teal-500">
                handed over by {item.from}
              </div>
            )}
            <UserBubble text={item.ask || item.title} />
            <WorkerReply
              worker={worker}
              tint={tint}
              at={item.at}
              reply={item.reply}
              footer={
                item.intent === "work" ? (
                  <div className="mt-2 flex items-center gap-2 text-[11px] text-ink-faint">
                    <span className="rounded bg-violet-500/20 px-1 py-0.5 text-[9px] text-violet-500">
                      Work
                    </span>
                    {(launched > 0 || item.proposed > 0) && (
                      <button
                        onClick={toggle}
                        className="hover:text-ink focus:outline-none"
                      >
                        {[
                          launched > 0 && `launched ${launched}`,
                          item.proposed > 0 &&
                            `${item.proposed} waiting for your review`,
                        ]
                          .filter(Boolean)
                          .join(" · ")}{" "}
                        {open ? "▾" : "▸"}
                      </button>
                    )}
                  </div>
                ) : null
              }
            />
            {item.intent === "work" && open && (
              <div className="rounded-xl border border-card-strong px-3 pb-2">
                <ReadInFull worker={worker} item={item} />
                <ShiftPlan
                  orchestration={item.orchestration}
                  showProse={false}
                />
                {awaiting && (
                  <WorkerPendingProposal orchestration={item.orchestration} />
                )}
              </div>
            )}
          </div>
        );
      })}
      {/* The turn you just sent. Its receipt is interface state, not a worker
          reply: keep it visually light and remove it the moment real prose
          begins. Later queued messages retain their own position receipt. */}
      {isToday &&
        sending?.map((pending, index) => {
          const responseStarted =
            index === 0 && live?.task === "errand" && !!live.text;
          const status =
            live?.task === "shift"
              ? `Queued behind Shift ${worker.shiftCount ?? 1}`
              : index > 0
                ? `Queued · ${index} ahead`
                : pending.intent === "work"
                  ? "Preparing work"
                  : "Reading Files and Journal";
          return (
            <div key={pending.id} className="flex flex-col gap-2">
              <UserBubble text={pending.text} />
              {!responseStarted && <WorkerActivityReceipt status={status} />}
            </div>
          );
        })}
      {/* The turn happening RIGHT NOW, at the bottom where the next thing
          always goes. Today only: a live shift belongs on today's page, and
          appending it to a day you have paged back to would be the desk
          claiming work happened on a day it did not. */}
      {isToday && live?.task === "errand" && (
        <LiveTurn worker={worker} tint={tint} live={live} />
      )}
    </div>
  );
}

/// Ephemeral engine state belongs between turns, not inside an assistant
/// bubble. `aria-live` announces progress without leaving a fake message in
/// the settled transcript.
function WorkerActivityReceipt({ status }: { status: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 self-start px-1 py-0.5 text-[11px] text-ink-faint"
    >
      <span
        aria-hidden="true"
        className="h-2.5 w-2.5 animate-spin rounded-full border border-ink-faint/40 border-t-ink-muted"
      />
      <span>{status}</span>
    </div>
  );
}

/// The shift or errand in flight, written into the transcript as it happens.
///
/// The desk used to say nothing at all while a worker worked — one word in the
/// activity strip above the composer ("Read", "Bash") and an empty page under
/// it, so the moment you most wanted to watch was the moment the desk was
/// blankest. The Shift tab had the streaming planning turn all along; this is
/// that panel, in the desk's own clothes, in the one position that means
/// "now".
///
/// It keeps each task's grammar: a shift announces itself with a rule, the way
/// every other shift on this page does, because it is the worker's own clock
/// rather than something you asked for. An errand doesn't — its ask is already
/// sitting above it as your message.
function LiveTurn({
  worker,
  tint,
  live,
}: {
  worker: Worker;
  tint: string;
  live: { text: string; tools: string[]; task: "shift" | "errand" };
}) {
  const tool = live.tools[live.tools.length - 1];
  // The engine stamps `shiftCount` before the planning turn starts, so the
  // number is already this shift's — not the last one's.
  const label =
    live.task === "shift" ? `Shift ${worker.shiftCount ?? 1} · starting` : null;

  return (
    <div>
      {label && (
        <div className="flex items-center gap-3 py-1">
          <span className="h-px flex-1 bg-card-strong" />
          <span className="shrink-0 text-[11px] text-sky-500">{label}</span>
          <span className="h-px flex-1 bg-card-strong" />
        </div>
      )}
      <div
        className="relative mt-2 overflow-hidden rounded-xl"
        style={{
          background: `color-mix(in srgb, ${tint} 5%, transparent)`,
          border: `1px solid color-mix(in srgb, ${tint} 18%, transparent)`,
        }}
      >
        <div
          className="absolute bottom-0 left-0 top-0 w-[2px]"
          style={{ background: tint + "cc" }}
        />
        <div className="px-4 py-2.5 pl-[14px]">
          <div className="mb-1 flex items-center gap-2 text-[10px] font-medium">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-60" />
              <span className="relative h-1.5 w-1.5 rounded-full bg-sky-400" />
            </span>
            <span style={{ color: tint }}>{worker.name}</span>
            <span className="text-ink-faint">
              {live.task === "shift" ? "planning its shift" : "on your errand"}
            </span>
            {/* What it is doing this second. The activity strip above the
                composer says the same word, but that strip is about the
                composer being busy; this one is part of the turn. */}
            {tool && <span className="truncate text-ink-faint">· {tool}</span>}
          </div>
          {live.text ? (
            <div>
              <Markdown source={live.text} />
            </div>
          ) : (
            <div className="text-xs text-ink-faint">
              Reading its job description and journal…
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/// A day with nothing on it. Two different silences, and they need different
/// words: today being empty is the desk working as intended, and an empty past
/// day is just an empty past day.
function PlanningDesk({
  worker,
  shiftNumber,
  onViewWork,
}: {
  worker: Worker;
  shiftNumber: number;
  onViewWork: () => void;
}) {
  return (
    <div className="flex min-h-full items-center justify-center pb-16">
      <div className="w-full max-w-md text-center">
        <div className="relative mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-sky-400/25 bg-sky-400/10 text-sky-400">
          <svg
            viewBox="0 0 24 24"
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="7" />
            <path
              d="M12 8v4l2.5 1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="absolute right-0 top-0 h-2.5 w-2.5 animate-pulse rounded-full border-2 border-surface bg-sky-400" />
        </div>
        <div className="mt-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-sky-400">
          Shift {shiftNumber} in progress
        </div>
        <div className="mt-1.5 text-base font-semibold text-ink">
          {worker.name} is planning today&apos;s work
        </div>
        <p className="mx-auto mt-2 max-w-sm text-xs leading-5 text-ink-muted">
          It&apos;s reading its job description and journal now. Follow the
          planning turn in Shifts, or send a message below.
        </p>
        <button
          onClick={onViewWork}
          className="mt-4 inline-flex h-8 items-center rounded-md border border-card-strong bg-card/40 px-3 text-xs font-medium text-ink transition-colors hover:bg-card/70 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
        >
          View shift in Shifts →
        </button>
      </div>
    </div>
  );
}

function EmptyDesk({
  worker,
  day,
  days,
  onSet,
  onViewWork,
  workSummary,
}: {
  worker: Worker;
  day: number;
  days: DeskDay[];
  onSet: (day: number) => void;
  onViewWork: () => void;
  workSummary: WorkerWorkSummary;
}) {
  const previous = adjacentDeskDay(days, day, -1);
  const previousCount = days.find((d) => d.at === previous)?.count ?? 0;
  const everWorked = days.length > 0;
  const isToday = day === startOfDay(Date.now());
  const latestOutcome = workSummary.latest
    ? workSummary.latest.launchedNothing
      ? "Quiet check"
      : describeActivity(workSummary.latest)
    : null;
  return (
    <div className="flex min-h-full items-center justify-center pb-16">
      <div className="w-full max-w-lg text-center">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl border border-card-strong bg-card/30 text-ink-muted">
          <svg
            viewBox="0 0 24 24"
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            aria-hidden="true"
          >
            <path d="M5 6.5h14v9H9l-4 3v-12Z" strokeLinejoin="round" />
            <path d="M8 10h8M8 13h5" strokeLinecap="round" />
          </svg>
        </div>
        <div className="mt-4 text-sm font-semibold text-ink">
          {isToday
            ? everWorked
              ? "No conversation yet today"
              : `Start a conversation with ${worker.name}`
            : `No conversation on ${deskDayLabel(day)}`}
        </div>
        <p className="mx-auto mt-1.5 max-w-sm text-xs leading-5 text-ink-muted">
          {isToday
            ? `Messages start fresh each day. Scheduled shifts stay in Shifts; work launched from a shift or conversation appears in Tasks.`
            : `${worker.name} didn’t exchange messages on this day.`}
        </p>
        {isToday && workSummary.shiftCount > 0 && (
          <button
            onClick={onViewWork}
            className="mx-auto mt-5 block w-full rounded-xl border border-card-strong bg-card/30 p-4 text-left transition-colors hover:bg-card/50 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
          >
            <span className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
              Work continues independently
            </span>
            <span className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="text-base font-semibold text-ink">
                {workSummary.shiftCount}{" "}
                {workSummary.shiftCount === 1 ? "shift" : "shifts"} worked
              </span>
              <span className="text-xs text-ink-muted">
                ·{" "}
                {workSummary.completed > 0
                  ? `${workSummary.completed} ${workSummary.completed === 1 ? "job" : "jobs"} completed`
                  : "No jobs completed yet"}
              </span>
            </span>
            {workSummary.latest && (
              <span className="mt-2 block text-xs text-ink-muted">
                Latest:{" "}
                <span className="font-medium text-ink">
                  {workSummary.latest.title}
                </span>
                {latestOutcome ? ` · ${latestOutcome}` : ""}
              </span>
            )}
            <span className="mt-3 block text-right text-xs font-medium text-accent">
              View Shifts →
            </span>
          </button>
        )}
        {/* The way back. A cleared desk must never mean "lost": the last day
            that had work is one click away, named and counted. */}
        {previous != null && (
          <button
            onClick={() => onSet(previous)}
            className="mt-4 inline-flex h-8 items-center rounded-md px-3 text-xs font-medium text-accent transition-colors hover:bg-accent/10 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
          >
            View {deskDayLabel(previous)} · {previousCount}{" "}
            {previousCount === 1 ? "turn" : "turns"} →
          </button>
        )}
      </div>
    </div>
  );
}

interface WorkerWorkSummary {
  shiftCount: number;
  completed: number;
  latest: WorkerActivity | null;
}

/// The in-tray: proposals from earlier days that are still yours to answer,
/// carried onto whatever day the desk is showing.
///
/// Clearing the desk nightly is right for a transcript and wrong for a
/// decision. A shift that parked three candidates yesterday morning left no
/// trace on today at all — a clean desk, and the only route back to the thing
/// waiting on you was guessing it was there and pressing ‹. Nothing expires
/// here and nothing is decided for you; the work just stops being invisible.
///
/// Collapsed by default, because a tray belongs at the EDGE of the desk. One
/// violet line is enough to be seen from across the room; opening it is the
/// act of picking the paper up.
function CarriedOver({
  items,
  day,
  onSet,
}: {
  items: WorkerActivity[];
  day: number;
  onSet: (day: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const carried = useMemo(() => carriedOverTurns(items, day), [items, day]);
  if (carried.length === 0) return null;

  const proposals = carried.reduce((n, item) => n + item.proposed, 0);
  const shown = carried.slice(0, CARRIED_OVER_SHOWN);
  const rest = carried.length - shown.length;
  const oldest = startOfDay(carried[carried.length - 1].at);
  // Named by the newest turn, which is the one you are likeliest to still
  // recognise; the day count says how far back the rest of it goes.
  const dayCount = new Set(carried.map((item) => startOfDay(item.at))).size;

  return (
    <div className="shrink-0 px-6 pt-2">
      <div className="rounded-lg border border-violet-400/40 bg-violet-500/10">
        <button
          onClick={() => setOpen(!open)}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-violet-500 focus:outline-none"
        >
          <span className="shrink-0 font-medium">
            {proposals} {proposals === 1 ? "proposal" : "proposals"} carried
            over
          </span>
          <span className="truncate text-ink-muted">
            from {deskDayLabel(startOfDay(carried[0].at))}
            {dayCount > 1 &&
              ` and ${dayCount - 1} earlier ${dayCount === 2 ? "day" : "days"}`}
          </span>
          <span className="ml-auto shrink-0">{open ? "▾" : "▸"}</span>
        </button>
        {open && (
          <div className="space-y-2 px-3 pb-2.5">
            {shown.map((item) => (
              <div key={item.orchestration.id}>
                <div className="flex items-center gap-2 text-[11px] text-ink-faint">
                  <span className="truncate">
                    {item.title} · {deskDayLabel(startOfDay(item.at))} ·{" "}
                    {relativeTime(item.at)}
                  </span>
                  {/* The tray holds the decision, not the context. The
                      planning prose, the items that already ran, the shift's
                      own controls — those stay on the day they happened, and
                      this is the way there. */}
                  <button
                    onClick={() => onSet(startOfDay(item.at))}
                    className="shrink-0 text-ink-muted hover:text-ink hover:underline focus:outline-none"
                  >
                    open that day →
                  </button>
                </div>
                <WorkerPendingProposal orchestration={item.orchestration} />
              </div>
            ))}
            {/* Never a silent cut. A tray that shows three of eleven and says
                nothing reads as "three" — and the eight it dropped are the
                ones that have been waiting longest. */}
            {rest > 0 && (
              <button
                onClick={() => onSet(oldest)}
                className="text-[11px] text-ink-muted hover:text-ink hover:underline focus:outline-none"
              >
                {rest} older {rest === 1 ? "turn" : "turns"} still waiting —
                oldest is {deskDayLabel(oldest)} →
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/// The desk's date line. Steps only through days that HAVE work, so a worker
/// idle for a fortnight is one click back, not fourteen.
function DeskDayBar({
  day,
  days,
  onSet,
  context,
}: {
  day: number;
  days: DeskDay[];
  onSet: (day: number) => void;
  context?: ReactNode;
}) {
  const older = adjacentDeskDay(days, day, -1);
  const newer = adjacentDeskDay(days, day, 1);
  const today = startOfDay(Date.now());
  const count = days.find((d) => d.at === day)?.count ?? 0;

  return (
    <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-card-strong/80 px-6 py-2 text-[11px]">
      <div className="inline-flex h-8 items-center rounded-lg border border-card-strong bg-card/30 p-0.5">
        <button
          onClick={() => older != null && onSet(older)}
          disabled={older == null}
          title={
            older != null ? `Back to ${deskDayLabel(older)}` : "Nothing earlier"
          }
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-white/5 hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 disabled:text-ink-faint disabled:opacity-40"
        >
          ‹
        </button>
        <span className="min-w-16 px-2 text-center text-xs font-semibold text-ink">
          {deskDayLabel(day)}
          {count > 0 && (
            <span className="ml-1 font-normal text-ink-muted">· {count}</span>
          )}
        </span>
        <button
          onClick={() => newer != null && onSet(newer)}
          disabled={newer == null}
          title={
            newer != null
              ? `Forward to ${deskDayLabel(newer)}`
              : "Nothing later"
          }
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-white/5 hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 disabled:text-ink-faint disabled:opacity-40"
        >
          ›
        </button>
      </div>
      {day !== today && (
        <button
          onClick={() => onSet(today)}
          className="rounded-md px-2 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent/10 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
        >
          Today
        </button>
      )}
      {context && (
        <div className="ml-1 flex min-w-0 flex-1 flex-wrap items-center gap-1.5 border-l border-card-strong pl-3">
          {context}
        </div>
      )}
    </div>
  );
}

/// Trust as a hex tint, for the places that need a real colour rather than a
/// utility class — the reply rail mixes it the way AssistantBubble mixes a
/// model's colour.
const TRUST_TINT: Record<WorkerTrustLevel, string> = {
  probation: "#f59e0b",
  trusted: "#38bdf8",
  autonomous: "#34d399",
};

/// The assistant side of a turn, shaped like AssistantBubble.
function WorkerReply({
  worker,
  tint,
  at,
  reply,
  footer,
}: {
  worker: Worker;
  tint: string;
  at: number;
  reply: string;
  footer?: React.ReactNode;
}) {
  return (
    <div
      className="relative overflow-hidden rounded-xl"
      style={{
        background: `color-mix(in srgb, ${tint} 5%, transparent)`,
        border: `1px solid color-mix(in srgb, ${tint} 18%, transparent)`,
      }}
    >
      <div
        className="absolute bottom-0 left-0 top-0 w-[2px]"
        style={{ background: tint + "cc" }}
      />
      <div className="px-4 py-2.5 pl-[14px]">
        <div
          className="mb-1 flex items-center gap-2 text-[10px] font-medium"
          style={{ color: tint }}
        >
          <span>{worker.name}</span>
          <span className="text-ink-faint">{relativeTime(at)}</span>
        </div>
        <div>
          {reply ? (
            <Markdown source={reply} />
          ) : (
            <div className="text-xs text-ink-faint">No reply recorded.</div>
          )}
        </div>
        {footer}
      </div>
    </div>
  );
}

/// A shift is something the worker did unprompted, so it reads as a rule
/// across the thread rather than a message — the way a chat marks a day break.
function ShiftRule({
  worker,
  item,
  open,
  onToggle,
}: {
  worker: Worker;
  item: WorkerActivity;
  open: boolean;
  onToggle: () => void;
}) {
  const awaiting = isOrchestrationAwaitingApproval(item.orchestration);
  return (
    <div>
      <button
        onClick={onToggle}
        className="group flex w-full items-center gap-3 py-1 text-left focus:outline-none"
      >
        <span className="h-px flex-1 bg-card-strong" />
        <span
          className={
            "shrink-0 text-[11px] " +
            (awaiting
              ? "text-violet-500"
              : "text-ink-faint group-hover:text-ink-muted")
          }
        >
          {item.title} · {describeActivity(item)} · {relativeTime(item.at)}{" "}
          {open ? "▾" : "▸"}
        </span>
        <span className="h-px flex-1 bg-card-strong" />
      </button>
      {open && (
        <div className="mt-2 rounded-xl border border-card-strong px-3 pb-2">
          <ReadInFull worker={worker} item={item} />
          <ShiftPlan orchestration={item.orchestration} />
          {awaiting && (
            <WorkerPendingProposal orchestration={item.orchestration} />
          )}
          <ShiftActions worker={worker} item={item} />
        </div>
      )}
    </div>
  );
}

/// The way into the reader. A planning turn is a document rendered in a
/// message slot — 12px type, full window width, a scrollbar inside a
/// scrollbar — and past a few hundred words that stops being readable at all.
/// This opens the same turn at reading size, with find and notes.
function ReadInFull({
  worker,
  item,
  inline = false,
}: {
  worker: Worker;
  item: WorkerActivity;
  inline?: boolean;
}) {
  const openSheet = useStore((s) => s.openSheet);
  const button = (
    <button
      onClick={(event) => {
        event.stopPropagation();
        openSheet({
          type: "shiftReader",
          workerId: worker.id,
          orchestrationId: item.orchestration.id,
        });
      }}
      title="Open this turn at reading size — with find, and somewhere to leave a note"
      className="inline-flex h-7 items-center rounded-md px-2 text-[11px] text-ink-faint transition-colors hover:bg-card hover:text-accent focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
    >
      Read in full ⤢
    </button>
  );
  return inline ? (
    button
  ) : (
    <div className="mt-2 flex justify-end">{button}</div>
  );
}

/// Undo, for a shift. Two acts that share almost all their machinery and read
/// very differently, so they get two buttons rather than one with a checkbox:
///
///   RE-RUN — the shift went wrong (the worker misread the window, a flow was
///   broken, you fixed something it depended on) and you want THAT shift done
///   again rather than a new one stacked on top. It rubs out what the shift
///   did, hands its number back, and plans it afresh over the same window.
///   Offered only on the most recent shift, because an older one cannot have
///   its number back — main refuses it, and an enabled button that always
///   errors is worse than an absent one.
///
///   DELETE — the shift should never have happened. Same removal, no re-run.
///
/// Both are permanent and both take out real files and flow runs, so both
/// confirm in place.
function ShiftActions({
  worker,
  item,
}: {
  worker: Worker;
  item: WorkerActivity;
}) {
  const deleteActivity = useWorkersStore((s) => s.deleteActivity);
  const redoShift = useWorkersStore((s) => s.redoShift);
  const [confirming, setConfirming] = useState(false);
  const [confirmingRedo, setConfirmingRedo] = useState(false);
  const [busy, setBusy] = useState<"redo" | "delete" | null>(null);

  // `[Shift 7]` against the worker's running count — the same test main makes.
  // Kept in sync by construction: both read the number off the ledger title.
  const number = /^Shift\s+(\d+)$/.exec(item.title)?.[1];
  const isLatest = !!number && Number(number) === (worker.shiftCount ?? 0);
  const live = item.running > 0;

  const run = async (which: "redo" | "delete") => {
    setBusy(which);
    if (which === "redo") await redoShift(worker.id, item.orchestration.id);
    else await deleteActivity(worker.id, item.orchestration.id);
    setBusy(null);
    setConfirming(false);
  };

  return (
    <div className="mt-2 flex items-center gap-3 border-t border-card-strong pt-2">
      {isLatest && (
        <button
          onClick={() => setConfirmingRedo(true)}
          disabled={!!busy}
          className="text-[11px] text-ink-faint hover:text-accent disabled:opacity-50 focus:outline-none"
        >
          {busy === "redo" ? "Re-running\u2026" : "Re-run this shift"}
        </button>
      )}
      {confirmingRedo && (
        <span className="flex items-center gap-2">
          <span className="text-[11px] text-ink-muted">
            Deletes this shift, its flow runs, the files it filed, and your
            notes on it — then runs it again.
          </span>
          <button
            onClick={() => {
              setConfirmingRedo(false);
              void run("redo");
            }}
            className="text-[11px] text-red-300 hover:text-red-200"
          >
            Re-run
          </button>
          <button
            onClick={() => setConfirmingRedo(false)}
            className="text-[11px] text-ink-faint hover:text-ink"
          >
            Cancel
          </button>
        </span>
      )}
      {confirming ? (
        <span className="flex items-center gap-2">
          <span className="text-[11px] text-ink-muted">
            Deletes this shift{live ? ", stops the work still running," : ","}{" "}
            its flow runs, the files it filed, and its journal entries.
            {isLatest ? " Shift " + number + " will be given back." : ""}
          </span>
          <button
            onClick={() => void run("delete")}
            disabled={!!busy}
            className="rounded bg-red-500/80 px-2 py-0.5 text-[11px] text-white disabled:opacity-50"
          >
            {busy === "delete" ? "Deleting\u2026" : "Delete"}
          </button>
          <button
            onClick={() => setConfirming(false)}
            className="text-[11px] text-ink-faint hover:text-ink"
          >
            Cancel
          </button>
        </span>
      ) : (
        <button
          onClick={() => setConfirming(true)}
          disabled={!!busy}
          className="text-[11px] text-ink-faint hover:text-red-400 disabled:opacity-50 focus:outline-none"
        >
          Delete this shift
        </button>
      )}
    </div>
  );
}

/// One batch's plan: the planning turn's own prose (its reasoning about what
/// this shift or errand was for), then what each planned item became.
function ShiftPlan({
  orchestration,
  showProse = true,
}: {
  orchestration: Orchestration;
  /// An errand already shows the worker's prose in its reply bubble; repeating
  /// it in the expansion is the same paragraph twice. A shift has no bubble —
  /// it is a one-line rule — so its expansion is the only place the reasoning
  /// appears, and there it stays.
  showProse?: boolean;
}) {
  // The reply's <candidates> block is machine payload — the items below
  // render it better than raw JSON would.
  const prose = stripWorkerSubject(orchestration.producer?.reply ?? "")
    .replace(/<candidates>[\s\S]*$/i, "")
    .trim();
  return (
    // No header: this panel now hangs off a row that already states what the
    // turn was and when. It used to be the roster's "last plan" drawer, where
    // a title and timestamp were the only context available.
    <div className="mt-2">
      {showProse &&
        (prose ? (
          <div className="rounded-md bg-card-strong/30 px-3 py-2 text-xs leading-relaxed text-ink-muted">
            <Markdown source={prose} />
          </div>
        ) : (
          <div className="text-[11px] text-ink-faint">
            The planning turn left no notes.
          </div>
        ))}
      <ShiftResultSummary orchestration={orchestration} />
      {orchestration.items.length > 0 ? (
        <div className="mt-2 space-y-2">
          {orchestration.items.map((it) => (
            <PlanItemRow
              key={it.candidate.id}
              item={it}
              orchestration={orchestration}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ShiftResultSummary({
  orchestration,
}: {
  orchestration: Orchestration;
}) {
  const items = orchestration.items;
  if (items.length === 0) {
    return (
      <div className="mt-3 flex items-start gap-2.5 rounded-lg border border-sky-400/20 bg-sky-400/[0.06] px-3 py-2.5">
        <span
          className="mt-1 h-2 w-2 shrink-0 rounded-full bg-sky-400"
          aria-hidden="true"
        />
        <div>
          <div className="text-xs font-semibold text-ink">
            Quiet shift · nothing proposed
          </div>
          <div className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">
            The worker reviewed its scope and found nothing worth launching.
            This is a successful monitoring result.
          </div>
        </div>
      </div>
    );
  }

  const done = items.filter((item) => item.status === "done").length;
  const failed = items.filter((item) => item.status === "failed").length;
  const proposed = items.filter((item) => item.status === "proposed").length;
  const active = items.filter((item) =>
    ["queued", "running", "paused"].includes(item.status),
  ).length;
  const cancelled = items.filter((item) => item.status === "cancelled").length;
  const parts = [
    done > 0 && `${done} completed`,
    active > 0 && `${active} in progress`,
    proposed > 0 && `${proposed} awaiting review`,
    failed > 0 && `${failed} failed`,
    cancelled > 0 && `${cancelled} cancelled`,
  ].filter(Boolean);
  const tone =
    failed > 0
      ? "border-red-400/20 bg-red-400/[0.06]"
      : proposed > 0
        ? "border-violet-400/20 bg-violet-400/[0.06]"
        : active > 0
          ? "border-sky-400/20 bg-sky-400/[0.06]"
          : "border-emerald-400/20 bg-emerald-400/[0.06]";
  const dot =
    failed > 0
      ? "bg-red-400"
      : proposed > 0
        ? "bg-violet-400"
        : active > 0
          ? "bg-sky-400"
          : "bg-emerald-400";
  return (
    <div
      className={`mt-3 flex items-center gap-2.5 rounded-lg border px-3 py-2.5 ${tone}`}
    >
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${dot}`}
        aria-hidden="true"
      />
      <div className="text-xs font-semibold text-ink">{parts.join(" · ")}</div>
    </div>
  );
}

/// A planned item with a run behind it is a door, not a label. The run pane is
/// where its transcript, its artifacts and — when it stalls — its Continue
/// button live, so rendering the row as inert text stranded exactly the items
/// that most needed a click: a paused run is a run waiting on a person, and
/// the desk was stating that fact while offering no way to act on it.
function PlanItemRow({
  item,
  orchestration,
  context,
  compactArtifacts = false,
}: {
  item: OrchestrationItem;
  orchestration: Orchestration;
  context?: {
    sourceLabel: string;
    sourceDetail: string;
    at: number;
    durationMs: number | null;
    onReview?: () => void;
  };
  compactArtifacts?: boolean;
}) {
  const run = useFlowsStore((s) =>
    item.runId ? s.runs[item.runId] : undefined,
  );
  const setActiveRun = useFlowsStore((s) => s.setActiveRun);
  const openFile = useStore((s) => s.openFile);
  // Optimistic, same as PauseBanner: the resume lands in the main process and
  // comes back as a state change, so without this the row looks dead for a
  // round trip. Cleared by the effect when the run actually moves.
  const [resuming, setResuming] = useState(false);

  // Every file the item produced, not just the final artifact: a report that
  // cites raw_test_output.md is half an answer without it, and the run's last
  // step is not always the one that wrote the thing you want to read. Asked of
  // main rather than derived here, so the naming rule that filed them stays in
  // one place — a renderer-side copy would drift and the links would quietly
  // stop resolving.
  const [files, setFiles] = useState<WorkerFile[]>([]);
  const workerId =
    orchestration.origin?.kind === "worker"
      ? orchestration.origin.workerId
      : null;
  const finishedAt = item.finishedAt;
  useEffect(() => {
    if (compactArtifacts || !workerId || item.status !== "done" || !finishedAt)
      return;
    let live = true;
    void window.overcli
      .invoke("workers:deliverables", {
        id: workerId,
        task: orchestrationTask(orchestration),
        label: orchestration.title,
        title: item.candidate.title,
        at: finishedAt,
      })
      .then((res) => {
        if (live) setFiles(res);
      });
    return () => {
      live = false;
    };
  }, [
    workerId,
    item.status,
    finishedAt,
    item.candidate.title,
    orchestration.id,
    compactArtifacts,
  ]);

  const pause = run?.state.kind === "paused" ? run.state : null;
  const activeRun =
    run?.state.kind === "running" || run?.state.kind === "paused";
  const continuing = !!run?.pendingContinue;
  useEffect(() => {
    setResuming(false);
  }, [continuing, pause?.nextStepId, pause?.reason]);

  // No detail-mode change: the Workers tab renders the run itself, so the
  // roster stays in the sidebar and the breadcrumb is a step back rather than
  // a return trip across the app.
  const openRun = () => {
    if (item.runId) setActiveRun(item.runId);
  };

  const inFlight = resuming || continuing;
  const resume = () => {
    if (!item.runId || inFlight) return;
    setResuming(true);
    void window.overcli
      .invoke("flows:resumeRun", { runId: item.runId })
      .then((res) => {
        if (!res || res.ok === false) setResuming(false);
      });
  };

  // Rejecting a paused run is the decline half of the choice its pause
  // button offers — the run goes first, through the same dirty-worktree
  // confirm every other delete uses, so declining THAT prompt leaves the
  // item exactly as it was. Only once the run and its worktree are gone
  // does the item settle to rejected, which is what writes the journal
  // entry that keeps the idea from coming back.
  const removeRun = useFlowsStore((s) => s.removeRun);
  const [confirmingReject, setConfirmingReject] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const reject = async () => {
    if (!item.runId || rejecting) return;
    setRejecting(true);
    const res = await deleteFlowRunWithDirtyGuard(item.runId);
    if (res.deleted) {
      removeRun(item.runId);
      const r = await window.overcli.invoke("orchestrator:rejectItem", {
        id: orchestration.id,
        candidateId: item.candidate.id,
      });
      if (r && r.ok === false)
        window.alert(`Couldn't decline this item: ${r.error}`);
    }
    setRejecting(false);
    setConfirmingReject(false);
  };

  return (
    <div
      className={
        context
          ? "px-4 py-3 transition-colors hover:bg-card/35"
          : activeRun
            ? "rounded-lg border border-sky-400/20 bg-sky-400/[0.04] px-3 py-2.5 shadow-sm"
            : "rounded-lg border border-card-strong bg-surface/40 px-3 py-2.5"
      }
    >
      <div
        className={
          context
            ? "grid gap-x-4 gap-y-2 md:grid-cols-[minmax(18rem,1fr)_9rem_7rem_7rem] md:items-center"
            : "flex items-center gap-2 text-[11px]"
        }
      >
        <div
          className={context ? "flex min-w-0 items-center gap-2" : "contents"}
        >
          <span
            className={
              activeRun
                ? `inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full border px-2 text-[11px] font-medium ${
                    pause
                      ? "border-amber-400/25 bg-amber-400/10 text-amber-500 dark:text-amber-300"
                      : "border-sky-400/25 bg-sky-400/10 text-sky-500"
                  }`
                : `inline-flex h-5 shrink-0 items-center rounded-full border px-2 text-[11px] font-medium ${PLAN_STATUS[item.status]?.pill ?? "border-card-strong bg-card/50 text-ink-muted"}`
            }
          >
            {activeRun && (
              <span
                className={`h-1.5 w-1.5 rounded-full ${pause ? "bg-amber-400" : "animate-pulse bg-sky-400"}`}
                aria-hidden="true"
              />
            )}
            {PLAN_STATUS[item.status]?.text ?? item.status}
          </span>
          {/* A door only while there is a room: a rejected item keeps its
            runId for the record, but the run behind it is deleted, and a
            click that opens nothing reads as broken. */}
          {run ? (
            <button
              onClick={openRun}
              title="Open the run"
              className="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-ink hover:underline focus:outline-none"
            >
              {item.candidate.title}
            </button>
          ) : (
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
              {item.candidate.title}
            </span>
          )}
          {item.note && (
            <span className="shrink-0 truncate text-[11px] text-ink-faint">
              — {item.note}
            </span>
          )}
          {context?.onReview && item.status === "proposed" && (
            <button
              onClick={context.onReview}
              className="shrink-0 rounded-md border border-violet-400/25 bg-violet-400/10 px-2 py-1 text-[10px] font-medium text-violet-400 hover:bg-violet-400/15"
            >
              Review in Shifts →
            </button>
          )}
          {pause && !confirmingReject && (
            <button
              onClick={resume}
              disabled={inFlight}
              title={PAUSE_HINT[pause.reason]}
              className="shrink-0 rounded border border-amber-500/40 px-1.5 py-[1px] text-[10px] text-amber-600 hover:bg-amber-500/10 focus:outline-none disabled:opacity-50 dark:text-amber-300"
            >
              {inFlight ? "resuming…" : PAUSE_ACTION[pause.reason]}
            </button>
          )}
          {/* The decline half of the pause's choice. Confirms in place because
            it takes out a real run and a real worktree; the message says the
            part that isn't obvious — a rejection is remembered. */}
          {pause &&
            item.runId &&
            (confirmingReject ? (
              <span className="flex shrink-0 items-center gap-1.5">
                <span className="text-[10px] text-ink-muted">
                  Deletes the run and its worktree. The worker won&apos;t
                  propose it again.
                </span>
                <button
                  onClick={() => void reject()}
                  disabled={rejecting}
                  className="shrink-0 rounded bg-red-500/80 px-1.5 py-[1px] text-[10px] text-white disabled:opacity-50 focus:outline-none"
                >
                  {rejecting ? "rejecting…" : "Reject"}
                </button>
                <button
                  onClick={() => setConfirmingReject(false)}
                  className="shrink-0 text-[10px] text-ink-faint hover:text-ink focus:outline-none"
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                onClick={() => setConfirmingReject(true)}
                disabled={inFlight}
                title="Turn this work down — deletes the run and drops its worktree, and the rejection is journaled so it stays gone"
                className="shrink-0 rounded border border-red-500/40 px-1.5 py-[1px] text-[10px] text-red-500 hover:bg-red-500/10 focus:outline-none disabled:opacity-50 dark:text-red-400"
              >
                reject
              </button>
            ))}
        </div>
        {context && (
          <>
            <span
              className="min-w-0 truncate text-xs font-medium text-ink-muted"
              title={context.sourceDetail || context.sourceLabel}
            >
              <span className="mr-1 text-ink-faint md:hidden">Source ·</span>
              {context.sourceLabel}
            </span>
            <span className="text-xs tabular-nums text-ink-muted">
              <span className="mr-1 text-ink-faint md:hidden">Duration ·</span>
              {context.durationMs == null
                ? "—"
                : formatTaskDuration(context.durationMs)}
            </span>
            <span className="text-left text-xs tabular-nums text-ink-muted md:text-right">
              <span className="mr-1 md:hidden">Finished ·</span>
              {relativeTime(context.at)}
            </span>
          </>
        )}
      </div>
      {/* Where the run is inside its flow — the run pane's pipeline at desk
          density. "running" on a seven-step flow says almost nothing; step
          five of seven with the live one named says how far it got and what
          is left, and when it pauses, exactly where it stopped. */}
      {run && (run.state.kind === "running" || run.state.kind === "paused") && (
        <StepStrip run={run} onOpen={openRun} />
      )}
      {/* What the work was FOR, every file of it, opening in the preview pane
          the same way any other markdown in the app does. These are the filed
          copies on disk, so they outlive the run that made them. */}
      {!compactArtifacts && files.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-card-strong/70 pt-2">
          <span className="mr-1 text-[10px] font-medium uppercase tracking-wider text-ink-faint">
            Files
          </span>
          {files.map((file) => (
            <button
              key={file.path}
              onClick={() => openFile(file.path, undefined, "preview")}
              title={`${file.path} — ${formatBytes(file.bytes)}`}
              className="inline-flex h-6 items-center rounded-md border border-card-strong bg-card/40 px-2 text-[10px] text-ink-muted transition-colors hover:bg-card-strong hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
            >
              {baseName(file.name)}
            </button>
          ))}
        </div>
      )}
      {/* A finished item that filed nothing is worth saying out loud: it is the
          difference between "the answer is elsewhere" and "there is no
          answer", and silence reads as the first. */}
      {!compactArtifacts && files.length === 0 && item.status === "done" && (
        <div className="mt-2 border-t border-card-strong/70 pt-2 text-[10px] text-ink-faint">
          Completed without a filed artifact
        </div>
      )}
    </div>
  );
}

/// A compact progress summary for active work. The full flow pane owns the
/// detailed pipeline; here the user only needs the current step, position,
/// and an unmistakable route into the run.
function StepStrip({ run, onOpen }: { run: FlowRun; onOpen: () => void }) {
  const steps = run.flowSnapshot.steps;
  if (steps.length === 0) return null;
  const st = run.state;
  const liveId =
    st.kind === "running"
      ? st.currentStepId
      : st.kind === "paused"
        ? st.nextStepId
        : null;
  const liveIndex = Math.max(
    0,
    steps.findIndex((step) => step.id === liveId),
  );
  const completed = steps.filter((step) => {
    const attempts = run.attempts.filter(
      (attempt) => attempt.stepId === step.id,
    );
    return attempts[attempts.length - 1]?.outcome === "success";
  }).length;
  const position = Math.min(steps.length, liveIndex + 1);
  const progress = Math.max(
    completed,
    st.kind === "running" ? Math.max(0.35, liveIndex + 0.35) : liveIndex,
  );
  const progressPercent = Math.min(100, (progress / steps.length) * 100);
  const currentStep = steps[liveIndex]?.id ?? liveId ?? "Starting";
  const paused = st.kind === "paused";
  return (
    <button
      onClick={onOpen}
      title="Open the run"
      className="mt-2 block w-full rounded-md border border-card-strong bg-surface/50 px-3 py-2.5 text-left transition-colors hover:border-accent/40 hover:bg-surface-elevated/70 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
    >
      <span className="flex items-center justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-[10px] font-medium uppercase tracking-wider text-ink-faint">
            {paused ? "Waiting at" : "Current step"}
          </span>
          <span
            className={`mt-0.5 block truncate text-xs font-medium ${paused ? "text-amber-500 dark:text-amber-300" : "text-ink"}`}
          >
            {currentStep}
          </span>
        </span>
        <span className="shrink-0 text-[10px] text-ink-muted">
          Step {position} of {steps.length} · Open run →
        </span>
      </span>
      <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-card-strong">
        <span
          className={`block h-full rounded-full transition-[width] duration-500 ${paused ? "bg-amber-400" : "bg-sky-400"}`}
          style={{ width: `${progressPercent}%` }}
        />
      </span>
      <span className="mt-1.5 flex items-center justify-between text-[10px] text-ink-faint">
        <span>{completed} completed</span>
        <span>{Math.max(0, steps.length - completed)} remaining</span>
      </span>
    </button>
  );
}

/// What a plain resume DOES depends on why the run stopped, so the button says
/// so rather than offering one word for three different acts. The escape hatch
/// on a failure pause — Override, accept this result and roll forward — stays
/// in the run pane, where the artifact it would accept is readable.
const PAUSE_ACTION: Record<string, string> = {
  preStep: "continue",
  externalAction: "approve & run",
  needsInput: "answer & resume",
  failure: "re-run step",
  interrupted: "resume",
};

const PAUSE_HINT: Record<string, string> = {
  preStep: "Hand the prior step\u2019s output to the next step and keep going",
  externalAction: "Approve the external effect, then run this step",
  needsInput:
    "Open the run, read the Worker exchange, answer, and resume the step",
  failure:
    "Run the failed step again. To accept its result instead, open the run and Override.",
  interrupted:
    "The app closed mid-step \u2014 run that step again and roll forward",
};

const PLAN_STATUS: Record<string, { text: string; cls: string; pill: string }> =
  {
    proposed: {
      text: "Awaiting review",
      cls: "text-violet-500",
      pill: "border-violet-400/25 bg-violet-400/10 text-violet-400",
    },
    queued: {
      text: "Queued",
      cls: "text-ink-muted",
      pill: "border-card-strong bg-card/50 text-ink-muted",
    },
    running: {
      text: "Running",
      cls: "text-sky-500",
      pill: "border-sky-400/25 bg-sky-400/10 text-sky-400",
    },
    paused: {
      text: "Paused",
      cls: "text-amber-500",
      pill: "border-amber-400/25 bg-amber-400/10 text-amber-400",
    },
    done: {
      text: "Completed",
      cls: "text-emerald-500",
      pill: "border-emerald-400/25 bg-emerald-400/10 text-emerald-400",
    },
    failed: {
      text: "Failed",
      cls: "text-red-500",
      pill: "border-red-400/25 bg-red-400/10 text-red-400",
    },
    cancelled: {
      text: "Rejected",
      cls: "text-red-400",
      pill: "border-red-400/20 bg-red-400/[0.06] text-red-400",
    },
  };

// ---- Journal -------------------------------------------------------------

const KIND_LABEL: Record<
  WorkerJournalEntry["kind"],
  { text: string; cls: string }
> = {
  shift: { text: "shift", cls: "text-ink-muted" },
  proposed: { text: "proposed", cls: "text-violet-500" },
  launched: { text: "launched", cls: "text-sky-500" },
  approved: { text: "approved", cls: "text-emerald-500" },
  rejected: { text: "rejected", cls: "text-red-500" },
  completed: { text: "completed", cls: "text-emerald-600" },
  failed: { text: "failed", cls: "text-red-600" },
  errand: { text: "errand", cls: "text-sky-600" },
  // Amber, alone among the kinds, because it is the only line in the journal
  // a person wrote — everything else is the worker's own record of itself.
  note: { text: "your note", cls: "text-amber-500" },
  delegated: { text: "handed on", cls: "text-teal-500" },
  demoted: { text: "demoted", cls: "text-amber-600" },
  compacted: { text: "compacted", cls: "text-ink-faint" },
};

function JournalList({ workerId }: { workerId: string }) {
  const entries = useWorkersStore((s) => s.journals[workerId]);
  const loadJournal = useWorkersStore((s) => s.loadJournal);

  useEffect(() => {
    void loadJournal(workerId);
  }, [workerId]);

  if (!entries)
    return <div className="mt-4 text-xs text-ink-faint">Loading journal…</div>;
  if (entries.length === 0) {
    return (
      <div className="mt-4 text-xs text-ink-faint">
        Empty journal — this worker hasn&apos;t worked a shift yet.
      </div>
    );
  }
  return (
    <div className="mt-4 space-y-1">
      {entries.slice(0, 60).map((e) => {
        const kind = KIND_LABEL[e.kind];
        return (
          <div key={e.id} className="flex items-baseline gap-2 text-[11px]">
            <span className="text-ink-faint shrink-0 tabular-nums">
              {new Date(e.at).toLocaleDateString()}
            </span>
            <span className={`shrink-0 w-16 ${kind.cls}`}>{kind.text}</span>
            <span className="text-ink-muted truncate">
              {e.title || e.note || ""}
            </span>
            {e.title && e.note && (
              <span className="text-ink-faint truncate">— {e.note}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---- Hire screen ---------------------------------------------------------

/// The catalog: ready-to-hire personas. Clicking one drops its full job
/// description into the textarea — a worked example of the level of detail a
/// worker plans well from, and still editable before drafting.
const PERSONA_PRESETS: Array<{
  name: string;
  group: "code" | "beyond";
  tagline: string;
  job: string;
}> = [
  {
    name: "The Innovator",
    group: "code",
    tagline:
      "One genuinely new idea a day, judged against the codebase and the market.",
    job: `You're the Innovator. Once a day, study this codebase — its architecture, recent commits, TODOs, and rough edges — and think about what comparable products ship. Propose exactly ONE genuinely new improvement worth building: something that removes a step users endure, makes a manual thing ambient, or exposes data the app already has but hides. Skip anything that is merely a settings toggle or a restyle, anything already in flight, and anything your journal shows was rejected. The proposal must be buildable in one autonomous run: give it a sharp title, two sentences on why it matters, and a self-contained implementation prompt.`,
  },
  {
    name: "The Support Triage Worker",
    group: "code",
    tagline:
      "Reads new tickets, reproduces what it can, hands off ready-to-run fixes.",
    job: `You're the Support Triage Worker. Each weekday morning, read the new support tickets and bug reports reachable from this project (use whatever MCP tools and trackers are available). For each one, try to REPRODUCE the problem against the repo and trace it to the code most likely at fault. Hand off only what you could reproduce or trace: one candidate per bug, carrying the reproduction steps, the suspect files, and a self-contained fix instruction a coding agent can act on alone. Never propose a fix for something you couldn't trace to code — say in your summary why you set it aside instead.`,
  },
  {
    name: "The Insight Miner",
    group: "code",
    tagline:
      "Reads the product board and feedback, surfaces the loudest theme as buildable work.",
    job: `You're the Insight Miner. Twice a week, read the product feedback reachable from this project — the product board, feedback channels, and tracker labels (use your MCP tools). Cluster what's NEW since your last shift into themes and weigh them by how often they come up and how much pain they describe. Propose up to three concrete, buildable items that would address the loudest theme, each citing the specific feedback it came from and carrying a self-contained implementation prompt. Never re-propose a theme your journal shows was rejected — find the next one down. If nothing new reached a threshold worth acting on, say so and propose nothing.`,
  },
  {
    name: "The Docs Gardener",
    group: "code",
    tagline:
      "Finds where the docs drifted from the code this week and proposes fixes.",
    job: `You're the Docs Gardener. Every Friday afternoon, compare the documentation — README, docs folders, and comments that describe behavior — against what actually changed in the code this week. Find the places where the docs now lie: renamed commands, changed defaults, removed flags, new features nobody wrote up. Propose one candidate per drifted document, quoting the stale text and stating what is true now, with a self-contained instruction to fix it. Chase factual drift only — never style, tone, or formatting.`,
  },
  {
    name: "The Test Warden",
    group: "code",
    tagline: "Hunts risky recent changes that landed without tests.",
    job: `You're the Test Warden. Twice a week, look at what changed in this repo recently and find the riskiest changes that landed WITHOUT tests: bug fixes with no regression test, new branches nothing covers, error paths that would fail silently. Propose up to three candidates, each naming the file, the behavior at risk, and a self-contained instruction to write the missing test in this repo's existing test style — match its frameworks, fixtures, and naming exactly. Skip code that is trivially unlikely to break and anything your journal shows was already covered or rejected.`,
  },
  {
    name: "The Dependency Steward",
    group: "code",
    tagline:
      "Weekly dependency review — advisories first, changelogs actually read.",
    job: `You're the Dependency Steward. Once a week, review this project's dependencies for updates that matter: security advisories first, then majors with breaking changes worth planning for, then safe minor bumps. READ the changelogs — never propose a bump whose release notes you haven't read. Propose at most three candidates: each names the package, the from→to versions, why now, what in this repo touches it, and a self-contained instruction to do the update and prove the tests still pass. Skip cosmetic version churn entirely.`,
  },
  {
    name: "The Bug Sweeper",
    group: "code",
    tagline:
      "Hunts latent bugs nobody filed — flaky tests, swallowed errors, edge cases.",
    job: `You're the Bug Sweeper. Every other day, hunt for latent bugs nobody has filed: flaky or failing tests, TODO/FIXME comments marking real defects, error paths that swallow exceptions, and recent changes with suspicious edge cases. Verify each suspect by READING the code — propose only what you can argue concretely is wrong, with the file, the exact failure scenario, and a self-contained fix instruction. Quality over quantity: an honest empty shift beats a speculative finding, and anything your journal shows was rejected stays gone.`,
  },
  {
    name: "The Security Sentry",
    group: "code",
    tagline:
      "Weekly sweep for real, exploitable security debt — not scanner noise.",
    job: `You're the Security Sentry. Once a week, sweep this repo for security debt: dependencies with known advisories, secrets or tokens committed by mistake, permissive auth or CORS defaults, and input paths that skip validation. Rank findings by real exploitability in THIS codebase, not by scanner severity labels. Propose at most two candidates per shift, each with the concrete evidence, the risk in one sentence, and a self-contained remediation instruction. If the sweep is clean, say so — a quiet shift from you is good news, not a failure.`,
  },
  {
    name: "The Personal Assistant",
    group: "beyond",
    tagline:
      "Plans your day each morning — meeting prep, stale threads, drafted replies.",
    job: `You're the Personal Assistant. Every weekday morning, look across what's reachable from your tools — calendar, mail, and messages — and plan the day's paperwork: meetings that need prep or an agenda, threads that have waited more than a day for a reply, commitments made in writing with no follow-up yet. Propose up to three items, each a concrete deliverable you can draft (an agenda, a reply, a follow-up note) with everything needed to draft it carried in the prompt. Never send anything yourself — every draft parks for approval — and skip anything your journal shows was already handled or declined.`,
  },
  {
    name: "The Note Aggregator",
    group: "beyond",
    tagline: "Merges the notes that piled up into tidy, cited summaries.",
    job: `You're the Note Aggregator. Each evening, read what's new in this folder since your last shift — meeting notes, scratch files, exports. Cluster the new material by topic, and where one topic is scattered across several notes, propose ONE consolidation: a tidy summary document that merges them, keeps every decision and open question, and cites which notes it drew from. Never delete or rewrite the originals — you propose new summary documents only. If nothing meaningful accumulated, say so and propose nothing.`,
  },
  {
    name: "The Study Coach",
    group: "beyond",
    tagline:
      "Turns this week's course material into summaries, questions, and gap flags.",
    job: `You're the Study Coach. Three evenings a week, read the course materials and notes in this folder and find what was added or changed this week. Propose up to three study aids for the newest material: a one-page plain-language summary, a set of practice questions with answers, or a flash-card list of terms that appeared for the first time. Separately, flag any topic the syllabus lists that the notes never cover — that gap is worth a proposal of its own. Match the course's terminology exactly, and never invent facts that aren't in the materials.`,
  },
  {
    name: "The Customer Success Scout",
    group: "beyond",
    tagline:
      "Finds accounts going quiet and drafts the check-in, evidence attached.",
    job: `You're the Customer Success Scout. Each weekday morning, review the customer activity reachable from your tools — tickets, shared channels, CRM notes. Find the accounts that need a human touch: threads that went quiet after a complaint, questions nobody answered, renewals approaching with no recent contact. Propose up to three check-ins, each naming the account, quoting the evidence, and carrying a drafted message ready to review. Never contact anyone directly — drafts only — and never re-propose an account your journal shows was declined recently.`,
  },
  {
    name: "The Ops Coordinator",
    group: "beyond",
    tagline:
      "Sweeps runbooks and checklists for drift from how things actually run.",
    job: `You're the Ops Coordinator. Once a week, sweep the operational documents in this folder and the trackers reachable through your tools — runbooks, checklists, process docs. Find the drift: steps that no longer match how things are actually done, recurring tasks with no owner, checklists that quietly stopped being filled in. Propose one fix per finding: what's stale, the evidence, and a self-contained instruction to update the document or file the task. Chase process drift only — never propose reorganizing things that demonstrably work.`,
  },
];

const CATALOG_GROUPS: Array<{
  key: "code" | "beyond";
  label: string;
  hint: string;
}> = [
  {
    key: "code",
    label: "For the codebase",
    hint: "click one to load its job description — then edit it to fit your project",
  },
  {
    key: "beyond",
    label: "Beyond code — assistants, students, success, ops",
    hint: "these lean on your connected tools, and any folder is a fine project — a notes vault, a course, a runbook directory",
  },
];

/// The lifecycle, as five numbered stages in equal-width cards: wake → plan
/// → propose → launch → learn. Derived from real values where the caller has
/// them (the editor), generic where it doesn't (the hire page). Five cards in
/// a grid instead of eight wrapping pills: the sequence reads left-to-right
/// in one pass, and each stage has room for its one sentence of detail.
function WorkerLifecycle(props: {
  cadence?: ScheduleTrigger;
  heartbeatModel?: string;
  maxItemsPerShift?: number;
  trust?: WorkerTrustLevel;
  caps?: Worker["caps"];
  flowName?: string;
  budgetUSDPerMonth?: number;
}) {
  const cap =
    props.trust && props.caps
      ? workerAutoApproveCap({ trust: props.trust, caps: props.caps })
      : 0;
  const flow = props.flowName ? `“${props.flowName}”` : "its flow";
  const n = props.maxItemsPerShift;
  const stages: Array<{ title: string; detail: string }> = [
    {
      title: "Wakes",
      detail: props.cadence
        ? describeTrigger(props.cadence)
        : "On its cadence, while overcli is open.",
    },
    {
      title: "Plans",
      detail: `Reads its journal and the repo, then decides this shift's work on ${
        props.heartbeatModel?.trim() || "a cheap heartbeat model"
      }.`,
    },
    {
      title: "Proposes",
      detail: `Up to ${n ?? "a few"} small candidate${n === 1 ? "" : "s"} — anything you rejected before is filtered out.`,
    },
    {
      title: "Launches",
      detail:
        cap > 0
          ? `Its best ${cap} run ${flow} unattended; the rest park for your approval.`
          : `Everything parks for your approval; each approved item runs ${flow} in a worktree.`,
    },
    {
      title: "Learns",
      detail: `Your verdicts land in its journal${
        props.budgetUSDPerMonth
          ? `, and it stops at $${props.budgetUSDPerMonth}/month`
          : ", and it stops when its monthly budget is spent"
      }.`,
    },
  ];
  return (
    <div className="rounded-xl bg-card p-4 shadow-sm">
      <div className="text-[11px] uppercase tracking-wider text-ink-faint mb-2">
        A shift, start to finish
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-2">
        {stages.map((s, i) => (
          <div
            key={s.title}
            className="rounded-lg border border-card-strong p-3"
          >
            <div className="flex items-center gap-2 mb-1">
              <span className="w-5 h-5 rounded-[4px] bg-accent/15 text-accent text-[10px] font-semibold flex items-center justify-center shrink-0">
                {i + 1}
              </span>
              <span className="text-xs font-medium text-ink">{s.title}</span>
              {i < stages.length - 1 && <LifecycleArrow />}
            </div>
            <div className="text-[11px] text-ink-muted leading-relaxed">
              {s.detail}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LifecycleArrow() {
  return (
    <svg
      width="16"
      height="12"
      viewBox="0 0 20 14"
      className="text-ink-faint flex-shrink-0 ml-auto"
    >
      <path d="M2 7 H16" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M14 3 L18 7 L14 11"
        stroke="currentColor"
        strokeWidth="1.4"
        fill="none"
      />
    </svg>
  );
}

function HireWorker({ defaultProjectPath }: { defaultProjectPath: string }) {
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  // The whole form lives in the store: drafting takes minutes and this screen
  // unmounts the moment you switch tabs, so nothing typed here — and nothing
  // still in flight — can be allowed to belong to the component.
  const hire = useWorkersStore((s) => s.hire);
  const patchHire = useWorkersStore((s) => s.patchHire);
  const startHire = useWorkersStore((s) => s.startHire);
  const closeHire = useWorkersStore((s) => s.closeHire);
  const jobDescription = hire.jobDescription;
  const projectPath = hire.projectPath || defaultProjectPath;
  const loading = hire.startedAt !== null;
  const error = hire.error;

  const targets = [
    ...workspaces.map((w) => ({
      name: `${w.name} (workspace)`,
      path: w.rootPath,
    })),
    ...projects.map((p) => ({ name: p.name, path: p.path })),
  ];

  // Highlight the card whose job description is (still) in the textarea, so
  // editing the text visibly turns a preset into "your own".
  const selectedPreset = PERSONA_PRESETS.find(
    (p) => p.job === jobDescription.trim(),
  )?.name;

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="flex items-center gap-3 mb-1">
        <button
          onClick={closeHire}
          className="text-xs text-ink-faint hover:text-ink px-2 py-1 rounded hover:bg-white/5"
        >
          ← Workers
        </button>
        <div className="text-2xl font-semibold">Hire a worker</div>
      </div>
      <div className="text-xs text-ink-muted mb-5 ml-1">
        One drafting turn turns a job description into the whole standing
        configuration — persona, cadence, caps, budget, and the flow it runs.
        You review everything before anything is saved.
      </div>

      <div className="space-y-5">
        {/* What am I actually hiring? The lifecycle, before any form. */}
        <WorkerLifecycle />

        {CATALOG_GROUPS.map((group) => (
          <div key={group.key}>
            <div className="flex items-baseline gap-2 mb-2">
              <span className="text-[11px] uppercase tracking-wider text-ink-faint">
                {group.label}
              </span>
              <span className="text-[11px] text-ink-faint normal-case">
                {group.hint}
              </span>
            </div>
            <div className="grid grid-cols-2 xl:grid-cols-4 gap-2">
              {PERSONA_PRESETS.filter((p) => p.group === group.key).map((p) => {
                const selected = selectedPreset === p.name;
                return (
                  <button
                    key={p.name}
                    onClick={() =>
                      patchHire({ jobDescription: p.job, error: null })
                    }
                    className={
                      "text-left rounded-lg border p-3 transition-colors " +
                      (selected
                        ? "border-accent bg-accent/10"
                        : "border-card-strong hover:bg-white/5")
                    }
                  >
                    <div className="flex items-center gap-2 mb-1">
                      {/* Same monogram idiom as flows everywhere else — the
                          app's icon language is a letter in a tinted square,
                          not emoji. */}
                      <FlowMonogram
                        name={p.name.replace(/^The /, "")}
                        size="md"
                      />
                      <span className="text-sm font-medium text-ink">
                        {p.name}
                      </span>
                    </div>
                    <div className="text-[11px] text-ink-muted leading-relaxed">
                      {p.tagline}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        {/* Same 1fr + rail grid as the editors: the form keeps a readable
            measure and the rail absorbs the slack, so nothing hangs against
            the full-width catalog above. */}
        <div className="grid grid-cols-[1fr_minmax(280px,360px)] gap-6 items-start">
          <div className="min-w-0 rounded-xl bg-card p-5 shadow-sm space-y-5">
            <Field
              label="Works against"
              hint="the drafter can override this when the job clearly names another project"
            >
              <select
                value={projectPath}
                onChange={(e) =>
                  patchHire({
                    projectPath: e.target.value,
                    projectTouched: true,
                  })
                }
                className="w-full max-w-[360px] bg-card border border-card-strong rounded px-2 py-1.5 text-sm text-ink"
              >
                {targets.map((t) => (
                  <option key={t.path} value={t.path}>
                    {t.name}
                  </option>
                ))}
              </select>
            </Field>

            <div>
              <div className="flex items-baseline gap-2 mb-2">
                <span className="text-[11px] uppercase tracking-wider text-ink-faint">
                  The job description
                </span>
                <span className="text-[11px] text-ink-faint normal-case">
                  pick from the catalog, or write your own — the worker plans
                  every shift from exactly this text
                </span>
              </div>
              <textarea
                rows={9}
                value={jobDescription}
                onChange={(e) =>
                  patchHire({ jobDescription: e.target.value, error: null })
                }
                placeholder={`You're the …\n\nSay what it should look at, how often, what a good proposal looks like, and what it must never do.`}
                className="w-full bg-card border border-card-strong rounded p-3 text-sm text-ink leading-relaxed"
              />
            </div>

            <AttachmentField
              attachments={hire.attachments}
              disabled={loading}
              onChange={(next) => patchHire({ attachments: next, error: null })}
              hint="a spec, an example of the deliverable, a screenshot of the board it works from — the drafter reads them"
            />

            {error && (
              <div className="text-sm text-red-700 dark:text-red-300 bg-red-500/15 border border-red-400/40 rounded px-3 py-2">
                {error}
              </div>
            )}

            <div className="flex items-center gap-3 border-t border-card-strong pt-4">
              <span className="text-[11px] text-ink-faint">
                You&apos;ll land in the editor with the drafted contract —
                nothing is saved until you click Hire there.
              </span>
              <button
                disabled={loading || !jobDescription.trim()}
                onClick={() => void startHire()}
                className="ml-auto shrink-0 text-xs px-4 py-2 rounded-md bg-accent text-white hover:opacity-90 disabled:opacity-40"
              >
                {loading ? "Drafting the contract…" : "✨ Draft the contract"}
              </button>
            </div>
            {loading && (
              <WorkingStrip
                startedAt={hire.startedAt}
                message="Drafting — one turn writes the contract (persona, cadence, caps, budget); if no existing flow fits, a second turn drafts the flow too. Two full turns, so give it a few minutes. Leave this page if you like: it keeps running and lands in the editor when it's done."
              />
            )}
          </div>

          <div className="space-y-3">
            <div className="rounded-lg border border-card-strong p-4">
              <div className="text-[11px] uppercase tracking-wider text-ink-faint mb-1.5">
                What drafting produces
              </div>
              <div className="text-[11px] text-ink-faint leading-relaxed">
                One turn of your preferred CLI returns the full contract for
                review:
              </div>
              <ul className="mt-1.5 space-y-1 text-[11px] text-ink-muted list-disc pl-4">
                <li>
                  the persona, with the job description refined to stand alone
                </li>
                <li>
                  a cadence that fits the job (no 3am shifts for morning work)
                </li>
                <li>items-per-shift cap and a monthly budget</li>
                <li>a cheap heartbeat model for the planning turns</li>
                <li>
                  the flow launched items run — an existing one, or drafted
                  fresh
                </li>
              </ul>
            </div>
            <div className="rounded-lg border border-card-strong p-4">
              <div className="text-[11px] uppercase tracking-wider text-ink-faint mb-1.5">
                Probation first
              </div>
              <div className="text-[11px] text-ink-faint leading-relaxed">
                Every hire starts on{" "}
                <span className="text-amber-500">probation</span> — nothing runs
                unattended until you promote it, and rejected proposals never
                come back. Promote from the roster once its scorecard has earned
                it.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- Editor --------------------------------------------------------------

function WorkerEditor() {
  const draft = useWorkersStore((s) => s.draft)!;
  const draftedFlow = useWorkersStore((s) => s.draftedFlow);
  const hireSummary = useWorkersStore((s) => s.hireSummary);
  const hireFlowError = useWorkersStore((s) => s.hireFlowError);
  const busy = useWorkersStore((s) => s.busy);
  const error = useWorkersStore((s) => s.error);
  const patch = useWorkersStore((s) => s.patchDraft);
  const save = useWorkersStore((s) => s.save);
  const close = useWorkersStore((s) => s.closeEditor);

  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const flows = useFlowsStore((s) => s.flows);
  const workers = useWorkersStore((s) => s.workers);
  const existing = draft.id ? workers[draft.id] : undefined;
  const preferredBackend = useStore((s) => s.settings.preferredBackend);
  const flowModelDefaults = useStore((s) => s.settings.flowModelDefaults);

  // Which backend the model list belongs to. An unpinned worker plans on
  // whatever backend is default, so that's the list to offer — otherwise the
  // picker would show Claude models to someone whose shifts run on Codex.
  const heartbeatBackend = heartbeatBackendOf(
    draft.heartbeatBackend,
    preferredBackend,
  );
  const heartbeatModels = PREMIUM_MODELS[heartbeatBackend];

  // Who this worker could hand work to: the same bound the engine enforces,
  // mirrored here so the editor cannot offer a colleague a handoff would never
  // actually reach. Off-project workers are excluded outright — two workspaces
  // can each employ a "Triage", and a name is all a handoff has to go on.
  // Everyday projects are the only ones a worker may file into; the flag on
  // the project record is the real answer, with `isEverydayProject` covering
  // folders scaffolded before it existed.
  const everydayProject = isEverydayProject({
    path: draft.projectPath,
    everyday: projects.find((p) => p.path === draft.projectPath)?.everyday,
  });

  const colleagues = useMemo(
    () =>
      sortRoster(
        Object.values(workers).filter(
          (w) => w.id !== draft.id && w.projectPath === draft.projectPath,
        ),
      ),
    [workers, draft.id, draft.projectPath],
  );

  // Trust isn't editable here (hires start on probation; promotion is a
  // roster action), but validation needs it to judge the cwd rule.
  const problem = validateWorker({
    ...draft,
    trust: existing?.trust ?? "probation",
    flowIds:
      draft.flowIds.length > 0
        ? draft.flowIds
        : draftedFlow
          ? [draftedFlow.id]
          : [],
    createdAt: 0,
    id: draft.id ?? "draft",
  });

  const targets = [
    ...workspaces.map((w) => ({
      name: `${w.name} (workspace)`,
      path: w.rootPath,
    })),
    ...projects.map((p) => ({ name: p.name, path: p.path })),
  ];

  // Trust never overrides the flow's own checkpoints: a `pause_before` step
  // parks the run for review even under an autonomous worker. Say so here,
  // where trust and flow are both on screen — not at 8am via a stuck run.
  const selectedFlow =
    draftedFlow &&
    (draft.flowIds.length === 0 || draft.flowIds[0] === draftedFlow.id)
      ? draftedFlow
      : flows.find((f) => f.id === draft.flowIds[0]);
  const pauseSteps =
    selectedFlow?.steps.filter((s) => s.pauseBefore).length ?? 0;

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="flex items-center gap-3 mb-4">
        <button
          onClick={close}
          className="text-xs text-ink-faint hover:text-ink px-2 py-1 rounded hover:bg-white/5"
        >
          ← Workers
        </button>
        <div className="text-2xl font-semibold">
          {draft.id ? `Edit ${draft.name || "worker"}` : "Review the contract"}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-ink-muted mr-1">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => patch({ enabled: e.target.checked })}
            />
            Enabled
          </label>
          <button
            onClick={close}
            className="text-xs px-3 py-1.5 rounded-md border border-card-strong hover:bg-white/5"
          >
            Cancel
          </button>
          <button
            disabled={!!problem || busy}
            onClick={() => void save(projects.map((p) => p.path))}
            className="text-xs px-3 py-1.5 rounded-md bg-accent text-white hover:opacity-90 disabled:opacity-40"
          >
            {busy ? "Saving…" : draft.id ? "Save changes" : "Hire"}
          </button>
        </div>
      </div>

      {/* Same two-column body as the flow and schedule editors: the 1fr main
          column keeps a readable measure, the rail absorbs the slack —
          left-aligned width control without centering anything. */}
      <div className="grid grid-cols-[1fr_minmax(280px,360px)] gap-6 items-start">
        <div className="min-w-0 space-y-4">
          {/* First, like the flow editor's AI row: editing-by-instruction is
              the front door, the form below is the fine adjustment. */}
          <WorkerAiRevise />
          {/* Derived, never stored — every pill is a projection of the form
              below, so "what will this worker do" can't drift from the truth. */}
          <WorkerLifecycle
            cadence={draft.cadence}
            heartbeatModel={draft.heartbeatModel}
            maxItemsPerShift={draft.caps.maxItemsPerShift}
            trust={existing?.trust ?? "probation"}
            caps={draft.caps}
            budgetUSDPerMonth={draft.budgetUSDPerMonth}
            flowName={
              draftedFlow && draft.flowIds.length === 0
                ? draftedFlow.name
                : flows.find((f) => f.id === draft.flowIds[0])?.name
            }
          />
          {hireSummary && (
            <div className="rounded-lg border border-card-strong bg-card px-4 py-3 text-xs text-ink-muted">
              <div className="text-[11px] uppercase tracking-wider text-ink-faint mb-1.5">
                The drafter&apos;s read on the job
              </div>
              <Markdown source={hireSummary} />
            </div>
          )}
          <div className="rounded-xl bg-card p-5 shadow-sm space-y-5">
            <Field label="Name" hint="the persona, not the task">
              <input
                value={draft.name}
                onChange={(e) => patch({ name: e.target.value })}
                placeholder="Scout"
                className="w-full bg-card border border-card-strong rounded px-2 py-1.5 text-sm text-ink"
              />
            </Field>
            {/* Short on purpose: this is the line the roster shows under the
                name, and anything longer is truncated where it is read. Left
                empty, the roster falls back to the job description's opening
                — so this is a correction, not a chore. */}
            <Field
              label="Tagline"
              hint="one line under the name on the roster — what this worker is"
            >
              <input
                value={draft.tagline ?? ""}
                maxLength={WORKER_TAGLINE_MAX}
                onChange={(e) => patch({ tagline: e.target.value })}
                placeholder={
                  workerTagline({ jobDescription: draft.jobDescription }) ||
                  "the overcli innovator"
                }
                className="w-full bg-card border border-card-strong rounded px-2 py-1.5 text-sm text-ink"
              />
            </Field>
            <Field
              label="Job description"
              hint="the worker plans every shift from ONLY this text plus its journal"
            >
              <textarea
                rows={5}
                value={draft.jobDescription}
                onChange={(e) => patch({ jobDescription: e.target.value })}
                className="w-full bg-card border border-card-strong rounded p-3 text-sm text-ink"
              />
            </Field>
          </div>

          <div className="rounded-xl bg-card p-5 shadow-sm space-y-5">
            <CadenceField
              cadence={draft.cadence}
              onChange={(cadence) => patch({ cadence })}
            />
          </div>

          <div className="rounded-xl bg-card p-5 shadow-sm space-y-5">
            <Field label="Project">
              <select
                value={draft.projectPath}
                onChange={(e) => patch({ projectPath: e.target.value })}
                className="w-full bg-card border border-card-strong rounded px-2 py-1.5 text-sm text-ink"
              >
                <option value="">Pick a project…</option>
                {targets.map((t) => (
                  <option key={t.path} value={t.path}>
                    {t.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="Flow for launched items"
              hint="each approved proposal becomes one run of this flow"
            >
              {draftedFlow && draft.flowIds.length === 0 ? (
                <div className="text-sm text-ink rounded border border-emerald-400/40 bg-emerald-500/10 px-3 py-2">
                  New flow{" "}
                  <span className="font-medium">{draftedFlow.name}</span> —
                  drafted for this worker, saved with the hire.
                </div>
              ) : (
                <>
                  <select
                    value={draft.flowIds[0] ?? ""}
                    onChange={(e) =>
                      patch({ flowIds: e.target.value ? [e.target.value] : [] })
                    }
                    className="w-full bg-card border border-card-strong rounded px-2 py-1.5 text-sm text-ink"
                  >
                    <option value="">Pick a flow…</option>
                    {flows.filter(isSelectableFlow).map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                  {draftedFlow && draft.flowIds[0] === draftedFlow.id && (
                    <div className="mt-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
                      “{draftedFlow.name}” has unsaved AI changes — they save
                      with this worker.
                    </div>
                  )}
                  {hireFlowError && draft.flowIds.length === 0 && (
                    <div className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                      The hire asked for a new flow and the flow drafter
                      couldn&rsquo;t produce one ({hireFlowError}). Pick an
                      existing flow, or describe the flow you want in the AI box
                      above.
                    </div>
                  )}
                </>
              )}
              {pauseSteps > 0 && (
                <div className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                  This flow pauses at{" "}
                  {pauseSteps === 1 ? "one step" : `${pauseSteps} steps`} for
                  your review — runs wait there even for an autonomous worker.
                  Use the AI box above (&ldquo;remove the pause before…&rdquo;)
                  if this worker should ship unattended.
                </div>
              )}
            </Field>

            <div className="grid grid-cols-3 gap-4">
              <Field
                label="Items per shift"
                hint={`max ${WORKER_MAX_ITEMS_PER_SHIFT}`}
              >
                <input
                  type="number"
                  min={1}
                  max={WORKER_MAX_ITEMS_PER_SHIFT}
                  value={draft.caps.maxItemsPerShift}
                  onChange={(e) =>
                    patch({
                      caps: {
                        ...draft.caps,
                        maxItemsPerShift: Math.floor(Number(e.target.value)),
                      },
                    })
                  }
                  className="w-full bg-card border border-card-strong rounded px-2 py-1.5 text-sm text-ink"
                />
              </Field>
              <Field label="Budget / month" hint="shifts stop when it's spent">
                <div className="flex items-center gap-1">
                  <span className="text-sm text-ink-muted">$</span>
                  <input
                    type="number"
                    min={1}
                    value={draft.budgetUSDPerMonth}
                    onChange={(e) =>
                      patch({ budgetUSDPerMonth: Number(e.target.value) })
                    }
                    className="w-full bg-card border border-card-strong rounded px-2 py-1.5 text-sm text-ink"
                  />
                </div>
              </Field>
              <Field label="Heartbeat model" hint="plans shifts; keep it cheap">
                <div className="flex items-center gap-1">
                  {/* The backend rides with the model. Left on "default", the
                      shift runs on whatever backend is current and the model
                      is translated to its matching tier — which is how workers
                      hired before this field behave. */}
                  <select
                    value={draft.heartbeatBackend ?? ""}
                    onChange={(e) => {
                      const next = (e.target.value || undefined) as
                        Backend | undefined;
                      // Carry the model across with the backend. Leaving a
                      // Claude id selected under Codex is precisely the
                      // mismatch this pairing exists to prevent, and the user
                      // shouldn't have to notice and fix it by hand.
                      patch({
                        heartbeatBackend: next,
                        heartbeatModel: resolveProducerModel(
                          heartbeatBackendOf(next, preferredBackend),
                          draft.heartbeatModel,
                          flowModelDefaults,
                        ),
                      });
                    }}
                    className="bg-card border border-card-strong rounded px-2 py-1.5 text-sm text-ink"
                  >
                    <option value="">default</option>
                    {HEARTBEAT_BACKENDS.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                  <select
                    value={draft.heartbeatModel}
                    onChange={(e) => patch({ heartbeatModel: e.target.value })}
                    className="w-full bg-card border border-card-strong rounded px-2 py-1.5 text-sm text-ink"
                  >
                    <option value="">(pick a model)</option>
                    {heartbeatModels.map((m) => (
                      <option key={m} value={m}>
                        {friendlyModelLabel(heartbeatBackend, m)}
                      </option>
                    ))}
                    {/* A worker carrying a model this backend doesn't ship —
                        hired under another provider, or imported. Shown rather
                        than dropped, so the field isn't mysteriously blank and
                        the user can see what will be translated away. */}
                    {draft.heartbeatModel &&
                      !heartbeatModels.includes(draft.heartbeatModel) && (
                        <option value={draft.heartbeatModel}>
                          {draft.heartbeatModel} — not on {heartbeatBackend}
                        </option>
                      )}
                  </select>
                </div>
              </Field>
            </div>

            <div className="text-[11px] text-ink-faint">
              {existing
                ? `Trust: ${existing.trust} — change it from the roster with Promote/Demote.`
                : "Hired on probation: every proposal parks for your approval, and rejected ones are never re-proposed. Promote from the roster once it has earned it."}
            </div>

            <label className="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2.5">
              <input
                type="checkbox"
                checked={draft.caps.allowExternalActions === true}
                onChange={(e) =>
                  patch({
                    caps: {
                      ...draft.caps,
                      allowExternalActions: e.target.checked,
                    },
                  })
                }
                className="mt-0.5"
              />
              <span>
                <span className="block text-sm text-ink">
                  Allow external actions without approval
                </span>
                <span className="block text-[11px] leading-relaxed text-ink-faint">
                  Lets this worker push, publish, send messages, and update
                  external services. Flow-authored review checkpoints still
                  pause.
                </span>
              </span>
            </label>

            {/* Only for everyday projects. A repo has git, a review step and
                somewhere else for output to live, so offering to drop agent
                files into the tree would be a setting whose right answer is
                always no. */}
            {everydayProject && (
              <label className="flex items-start gap-2 rounded-lg border border-sky-400/30 bg-sky-400/5 px-3 py-2.5">
                <input
                  type="checkbox"
                  checked={draft.caps.fileIntoProject === true}
                  onChange={(e) =>
                    patch({
                      caps: {
                        ...draft.caps,
                        fileIntoProject: e.target.checked,
                      },
                    })
                  }
                  className="mt-0.5"
                />
                <span>
                  <span className="block text-sm text-ink">
                    Put finished work in the project folder
                  </span>
                  <span className="block text-[11px] leading-relaxed text-ink-faint">
                    Documents this worker finishes are added to the folder,
                    alongside everything else in it, and a version is saved so
                    you can undo them. Everything it produces is kept in its own
                    files either way.
                  </span>
                </span>
              </label>
            )}

            <label className="flex items-start gap-2 rounded-lg border border-teal-400/30 bg-teal-400/5 px-3 py-2.5">
              <input
                type="checkbox"
                checked={draft.caps.canDelegate === true}
                onChange={(e) =>
                  patch({
                    caps: {
                      ...draft.caps,
                      canDelegate: e.target.checked,
                    },
                  })
                }
                className="mt-0.5"
              />
              <span>
                <span className="block text-sm text-ink">
                  Let this worker hand work to colleagues
                </span>
                <span className="block text-[11px] leading-relaxed text-ink-faint">
                  Shows it the other workers on this project, and lets it pass
                  anything outside its own remit to one of them as an errand —
                  spending their budget, not yours. Off for workers on
                  probation, whatever this says.
                </span>
              </span>
            </label>

            {/* Narrowing, not an org chart. It only appears once delegation is
                on and there is someone to narrow to, because the useful default
                is "whoever fits" — you come here after seeing a handoff land
                somewhere you didn't want, not before. */}
            {draft.caps.canDelegate && colleagues.length > 0 && (
              <div className="rounded-lg border border-line px-3 py-2.5">
                <div className="text-sm text-ink">Who it may hand work to</div>
                <div className="mb-2 text-[11px] leading-relaxed text-ink-faint">
                  {(draft.delegatesTo ?? []).length === 0
                    ? "Any colleague on this project — it picks by reading their job descriptions. Tick names to restrict it."
                    : "Restricted to the ticked colleagues. Untick them all to go back to the whole roster."}
                </div>
                <div className="flex flex-col gap-1">
                  {colleagues.map((c) => {
                    const picked = (draft.delegatesTo ?? []).includes(c.id);
                    return (
                      <label
                        key={c.id}
                        className="flex items-start gap-2 text-[12px] text-ink-muted"
                      >
                        <input
                          type="checkbox"
                          checked={picked}
                          onChange={(e) => {
                            const cur = draft.delegatesTo ?? [];
                            const next = e.target.checked
                              ? [...cur, c.id]
                              : cur.filter((id) => id !== c.id);
                            patch({
                              delegatesTo: next.length > 0 ? next : undefined,
                            });
                          }}
                          className="mt-0.5"
                        />
                        <span className="truncate">{c.name}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {(problem || error) && (
            <div className="text-sm text-red-700 dark:text-red-300 bg-red-500/15 border border-red-400/40 rounded px-3 py-2">
              {error ?? problem}
            </div>
          )}
        </div>

        <WorkerHelpRail
          trust={existing?.trust ?? "probation"}
          caps={draft.caps}
        />
      </div>
    </div>
  );
}

/// The editor's right rail: what the knobs mean, and — since Promote/Demote
/// live on the roster — what each trust level actually permits.
function WorkerHelpRail({
  trust,
  caps,
}: {
  trust: WorkerTrustLevel;
  caps: Worker["caps"];
}) {
  const trustedCap = workerAutoApproveCap({ trust: "trusted", caps });
  const autonomousCap = workerAutoApproveCap({ trust: "autonomous", caps });
  const levels: Array<{ level: WorkerTrustLevel; what: string }> = [
    {
      level: "probation",
      what: "Every proposal parks and waits for your approval. Nothing runs unattended.",
    },
    {
      level: "trusted",
      what: `Its best ${trustedCap} proposal${trustedCap === 1 ? "" : "s"} per shift launch on their own; the rest still park.`,
    },
    {
      level: "autonomous",
      what: `Up to ${autonomousCap} launch per shift unattended, and it may earn the working copy.`,
    },
  ];
  return (
    <div className="space-y-3 sticky top-0">
      <div className="rounded-lg border border-card-strong p-4">
        <div className="text-[11px] uppercase tracking-wider text-ink-faint mb-2">
          How trust works
        </div>
        <div className="space-y-2.5">
          {levels.map((l) => (
            <div key={l.level} className="text-xs">
              <span
                className={
                  "font-medium " +
                  (l.level === trust ? "text-ink" : "text-ink-muted")
                }
              >
                {l.level}
                {l.level === trust ? " — current" : ""}
              </span>
              <div className="text-ink-faint leading-relaxed">{l.what}</div>
            </div>
          ))}
        </div>
        <div className="mt-2.5 text-[11px] text-ink-faint leading-relaxed">
          Promote and demote from the roster. Three rejections in a row demote
          it automatically.
        </div>
      </div>
      <div className="rounded-lg border border-card-strong p-4">
        <div className="text-[11px] uppercase tracking-wider text-ink-faint mb-1.5">
          The journal
        </div>
        <div className="text-[11px] text-ink-faint leading-relaxed">
          Every proposal and your verdict on it is remembered. The next shift
          plans against that memory — a rejected idea is filtered out even if
          the model suggests it again.
        </div>
      </div>
      <div className="rounded-lg border border-card-strong p-4">
        <div className="text-[11px] uppercase tracking-wider text-ink-faint mb-1.5">
          The budget
        </div>
        <div className="text-[11px] text-ink-faint leading-relaxed">
          Two ceilings. A worker&apos;s own cap, and the pot the whole roster
          draws from — paid down the roster in order, so a worker only spends
          what is left after everyone above it is funded. Either one empty and
          it idles until the month turns. The heartbeat model only plans shifts
          — keep it cheap and the idle cost is pennies.
        </div>
      </div>
    </div>
  );
}

/// Feedback for the long drafting turns (hire, revise): a greyed button
/// alone reads as "stuck" by second 20. Pulsing dot, honest copy about what
/// is actually running, and an elapsed counter so time visibly passes.
/// `startedAt` is when the turn actually began, not when this strip mounted.
/// The two differ whenever the user leaves and comes back mid-draft, and a
/// counter that restarts at 0 on return is a lie about how long is left.
function WorkingStrip({
  message,
  startedAt,
}: {
  message: string;
  startedAt?: number | null;
}) {
  const [elapsed, setElapsed] = useState(() =>
    startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0,
  );
  useEffect(() => {
    const started = startedAt ?? Date.now();
    setElapsed(Math.floor((Date.now() - started) / 1000));
    const t = setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => clearInterval(t);
  }, [startedAt]);
  return (
    <div className="mt-2 flex items-center gap-2 rounded-md border border-accent/40 bg-accent/5 px-3 py-2 text-[11px]">
      <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse shrink-0" />
      <span className="text-ink-muted">{message}</span>
      <span className="ml-auto text-ink-faint tabular-nums shrink-0">
        {elapsed}s
      </span>
    </div>
  );
}

/// Files attached to a drafting turn, with a picker and a drop target.
///
/// The drafting CLIs already take attachments — this is the same intake the
/// chat composer uses, so what counts as attachable can't drift between the
/// two. Owned by the caller rather than the store's conversation map: these
/// belong to one hire or one revision, not to a conversation.
function AttachmentField({
  attachments,
  onChange,
  disabled,
  hint,
  compact,
}: {
  attachments: Attachment[];
  onChange: (next: Attachment[]) => void;
  disabled?: boolean;
  hint?: string;
  /// Trim the chrome down to a single button, for the one-line AI box.
  compact?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [rejection, setRejection] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  async function take(files: FileList | File[]): Promise<void> {
    const { attachments: picked, rejections } = await intakeAttachments(files);
    setRejection(rejections.at(-1) ?? null);
    if (picked.length > 0) onChange([...attachmentsRef.current, ...picked]);
  }

  const picker = (
    <input
      ref={inputRef}
      type="file"
      multiple
      accept={ATTACHMENT_ACCEPT}
      className="hidden"
      onChange={(e) => {
        if (e.target.files?.length) void take(e.target.files);
        // Same file twice in a row fires no change event unless the input is
        // cleared — the second attach would silently do nothing.
        e.target.value = "";
      }}
    />
  );

  const chips = attachments.length > 0 && (
    <div className="flex flex-wrap gap-2">
      {attachments.map((a) => (
        <AttachmentChip
          key={a.id}
          attachment={a}
          onRemove={() => onChange(attachments.filter((x) => x.id !== a.id))}
        />
      ))}
    </div>
  );

  if (compact) {
    return (
      <>
        {picker}
        <button
          type="button"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
          title="Attach files — the reviser reads them"
          className="self-center shrink-0 flex h-6 items-center justify-center gap-1 rounded-full px-2 text-sm text-ink-muted hover:bg-card-strong hover:text-ink disabled:opacity-40"
        >
          +
          {attachments.length > 0 && (
            <span className="text-[10px] tabular-nums">
              {attachments.length}
            </span>
          )}
        </button>
      </>
    );
  }

  return (
    <div>
      <div className="mb-2 flex items-baseline gap-2">
        <span className="text-[11px] uppercase tracking-wider text-ink-faint">
          Attachments
        </span>
        {hint && (
          <span className="text-[11px] text-ink-faint normal-case">{hint}</span>
        )}
      </div>
      {picker}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files.length) void take(e.dataTransfer.files);
        }}
        className={
          "rounded-lg border border-dashed p-3 transition-colors " +
          (dragging ? "border-accent bg-accent/10" : "border-card-strong")
        }
      >
        {chips}
        <button
          type="button"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
          className={
            "text-[11px] text-ink-faint hover:text-ink disabled:opacity-40 " +
            (attachments.length > 0 ? "mt-2" : "")
          }
        >
          Attach files…{" "}
          <span className="text-ink-faint">or drop them here</span>
        </button>
      </div>
      {rejection && (
        <div className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400">
          {rejection}
        </div>
      )}
    </div>
  );
}

const REVISE_EXAMPLES = [
  "File a ticket in our tracker for each fix",
  "Also post a summary to Slack when done",
  "Work twice a day instead",
  "Remove the pause so it ships unattended",
];

/// One instruction, routed across the worker's two halves: the job
/// description (what it plans) and its flow (how approved items execute).
/// "File a ticket for each fix" lands in BOTH — the flow gains the ticket
/// step, the job description starts carrying what that step needs. Nothing
/// is saved here: changes land on the draft, and only Save commits them
/// (the revised flow included).
///
/// Same collapsed-row idiom as FlowAiEdit — one input-height at rest so it
/// never outweighs the contract it edits, expanding only while in use.
function WorkerAiRevise() {
  const draft = useWorkersStore((s) => s.draft);
  // Store-owned, like the hire form: a revision is a routing turn plus (often)
  // a whole flow edit, and the editor unmounts as soon as you go look at
  // something else. Leaving now costs you nothing — the result lands on the
  // draft when it returns, and this box shows it whenever you come back.
  // Only THIS worker's revision — another worker's in-flight instruction
  // showing up in this editor is the app looking like it lost track of which
  // worker you opened.
  const revise = useWorkersStore(selectRevise);
  const patchRevise = useWorkersStore((s) => s.patchRevise);
  const startRevise = useWorkersStore((s) => s.startRevise);
  const [focused, setFocused] = useState(false);

  const instruction = revise.instruction;
  const busy = revise.startedAt !== null;
  const expanded =
    focused || instruction.length > 0 || revise.attachments.length > 0;

  if (!draft) return null;

  return (
    <div>
      <div className="flex items-start gap-2 rounded-lg border border-card bg-card px-3 py-1.5 focus-within:border-card-strong transition-colors">
        <span
          className="text-xs text-ink-faint select-none leading-6"
          aria-hidden
        >
          ✨
        </span>
        <textarea
          value={instruction}
          onChange={(e) =>
            patchRevise({ instruction: e.target.value, error: null })
          }
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onPaste={(e) => {
            // A screenshot pasted straight in is the whole point of "make it
            // look like this" — treat it as an attachment, not as nothing.
            const files = Array.from(e.clipboardData.files);
            if (files.length === 0) return;
            e.preventDefault();
            void intakeAttachments(files).then(({ attachments: picked }) => {
              if (picked.length > 0)
                // Read through the store, not the render-time closure: two
                // pastes before the first FileReader resolves both spread the
                // same base and one screenshot is silently dropped.
                patchRevise({
                  attachments: [
                    ...selectRevise(useWorkersStore.getState()).attachments,
                    ...picked,
                  ],
                });
            });
          }}
          onKeyDown={(e) => {
            // ⌘/Ctrl+Enter submits — Enter alone stays a newline so a
            // multi-sentence instruction doesn't fire off half-written.
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void startRevise();
            }
          }}
          rows={1}
          disabled={busy}
          style={
            { fieldSizing: "content", maxHeight: 160 } as React.CSSProperties
          }
          placeholder="Change this worker with AI — the change lands on the job description, the flow, or both…"
          className="flex-1 bg-transparent text-sm text-ink placeholder:text-ink-faint focus:outline-none resize-none leading-6 disabled:opacity-60"
        />
        <AttachmentField
          compact
          disabled={busy}
          attachments={revise.attachments}
          onChange={(next) => patchRevise({ attachments: next, error: null })}
        />
        {(busy || instruction.trim()) && (
          <button
            onClick={() => void startRevise()}
            disabled={busy || !instruction.trim()}
            className="text-xs px-2.5 py-1 rounded-md bg-accent text-white hover:opacity-90 disabled:opacity-50 whitespace-nowrap self-center"
            title="⌘↵"
          >
            {busy ? "Revising…" : "Apply"}
          </button>
        )}
      </div>

      {revise.attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-2 px-1">
          {revise.attachments.map((a) => (
            <AttachmentChip
              key={a.id}
              attachment={a}
              onRemove={() =>
                patchRevise({
                  attachments: revise.attachments.filter((x) => x.id !== a.id),
                })
              }
            />
          ))}
        </div>
      )}

      {expanded && !busy && (
        <div className="flex flex-wrap items-center gap-1.5 mt-1.5 px-1">
          {!instruction &&
            REVISE_EXAMPLES.map((ex) => (
              <button
                key={ex}
                // Blur fires before click, and blur collapses this row — so
                // claim the press before the row can disappear under it.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => patchRevise({ instruction: ex })}
                className="text-[11px] px-2 py-0.5 rounded-full border border-card text-ink-faint hover:text-ink hover:bg-card-strong"
              >
                {ex}
              </button>
            ))}
          <span className="ml-auto text-[10px] text-ink-faint">
            ⌘↵ to apply · + to attach a spec or screenshot · you review before
            saving
          </span>
        </div>
      )}

      {busy && (
        <WorkingStrip
          startedAt={revise.startedAt}
          message="Revising — one drafting turn decides what changes (job description, flow, or both); a flow change runs a second pass through the flow editor. Usually under two minutes, and you can leave this page while it runs."
        />
      )}

      {revise.error && (
        <div className="text-xs text-red-700 dark:text-red-300 bg-red-500/10 border border-red-500/20 rounded p-2.5 mt-2">
          {revise.error}
        </div>
      )}

      {revise.note && (
        <div className="flex items-start gap-2 text-xs text-emerald-800 dark:text-emerald-200 bg-emerald-500/10 border border-emerald-500/20 rounded p-2 mt-2">
          <div className="min-w-0 flex-1 whitespace-pre-wrap">
            {revise.note}
            {"\n"}Nothing is saved until you hit Save.
          </div>
          <button
            onClick={() => patchRevise({ note: null })}
            aria-label="Dismiss"
            className="opacity-60 hover:opacity-100 leading-none"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}

// ---- Cadence picker ------------------------------------------------------

type ActiveWindow = { start: string; end: string };

/// Either end of the active-hours window can be typed first, and a half-typed
/// window survives until both boxes are empty again — clearing one box must not
/// throw away what was typed in the other. Typing into an empty window fills
/// the other end with the placeholder so one keystroke leaves a usable window.
function editWindow(
  window: ActiveWindow | undefined,
  field: "start" | "end",
  value: string,
): ActiveWindow | undefined {
  const other = field === "start" ? (window?.end ?? "") : (window?.start ?? "");
  if (!value && !other) return undefined;
  const filled = other || (field === "start" ? "18:00" : "08:00");
  return field === "start"
    ? { start: value, end: filled }
    : { start: filled, end: value };
}

function CadenceField({
  cadence,
  onChange,
}: {
  cadence: ScheduleTrigger;
  onChange: (t: ScheduleTrigger) => void;
}) {
  return (
    <div className="space-y-4">
      <Field label="Shift cadence">
        <div className="flex gap-2">
          <Segment
            active={cadence.kind === "daily"}
            onClick={() =>
              cadence.kind !== "daily" &&
              onChange({ kind: "daily", time: "09:00", days: cadence.days })
            }
          >
            At a time of day
          </Segment>
          <Segment
            active={cadence.kind === "interval"}
            onClick={() =>
              cadence.kind !== "interval" &&
              onChange({
                kind: "interval",
                everyMinutes: 120,
                days: cadence.days,
              })
            }
          >
            Every N minutes
          </Segment>
        </div>
      </Field>

      {cadence.kind === "daily" ? (
        <Field label="Time" hint="24h local">
          <input
            value={cadence.time}
            onChange={(e) => onChange({ ...cadence, time: e.target.value })}
            placeholder="09:00"
            className="w-28 bg-card border border-card-strong rounded px-2 py-1.5 text-sm text-ink"
          />
        </Field>
      ) : (
        <div className="grid grid-cols-3 gap-4">
          <Field
            label="Every"
            hint={`min ${WORKER_MIN_INTERVAL_MINUTES} minutes`}
          >
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={WORKER_MIN_INTERVAL_MINUTES}
                value={cadence.everyMinutes}
                onChange={(e) =>
                  onChange({
                    ...cadence,
                    everyMinutes: Math.floor(Number(e.target.value)),
                  })
                }
                className="w-24 bg-card border border-card-strong rounded px-2 py-1.5 text-sm text-ink"
              />
              <span className="text-xs text-ink-muted">minutes</span>
            </div>
          </Field>
          <Field label="Active from" hint="optional">
            <input
              value={cadence.window?.start ?? ""}
              placeholder="08:00"
              onChange={(e) =>
                onChange({
                  ...cadence,
                  window: editWindow(cadence.window, "start", e.target.value),
                })
              }
              className="w-24 bg-card border border-card-strong rounded px-2 py-1.5 text-sm text-ink"
            />
          </Field>
          <Field label="Until" hint="optional">
            <input
              value={cadence.window?.end ?? ""}
              placeholder="18:00"
              onChange={(e) =>
                onChange({
                  ...cadence,
                  window: editWindow(cadence.window, "end", e.target.value),
                })
              }
              className="w-24 bg-card border border-card-strong rounded px-2 py-1.5 text-sm text-ink"
            />
          </Field>
        </div>
      )}

      <Field label="Days" hint="none selected = every day">
        <DayPicker
          days={cadence.days}
          onChange={(days) => onChange({ ...cadence, days })}
        />
      </Field>
    </div>
  );
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function DayPicker({
  days,
  onChange,
}: {
  days?: number[];
  onChange: (days: number[] | undefined) => void;
}) {
  const selected = new Set(days ?? []);
  return (
    <div className="flex gap-1">
      {DAY_NAMES.map((name, i) => {
        const on = selected.has(i);
        return (
          <button
            key={name}
            onClick={() => {
              const next = new Set(selected);
              if (on) next.delete(i);
              else next.add(i);
              const arr = [...next].sort((a, b) => a - b);
              onChange(arr.length === 0 || arr.length === 7 ? undefined : arr);
            }}
            className={
              "px-2 py-1 rounded text-[11px] " +
              (on
                ? "bg-accent text-white"
                : "border border-card-strong text-ink-muted hover:bg-white/5")
            }
          >
            {name}
          </button>
        );
      })}
    </div>
  );
}

// ---- Local primitives (same shapes as SchedulesPane's) -------------------

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-baseline gap-2 mb-1.5">
        <span className="text-[11px] uppercase tracking-wider text-ink-faint">
          {label}
        </span>
        {hint && (
          <span className="text-[11px] text-ink-faint normal-case">{hint}</span>
        )}
      </div>
      {children}
    </div>
  );
}

function Segment({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "px-3 py-1 rounded-md text-xs " +
        (active
          ? "bg-accent text-white"
          : "border border-card-strong text-ink-muted hover:bg-white/5")
      }
    >
      {children}
    </button>
  );
}
