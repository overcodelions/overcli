// The Workers tab: standing personas you hire against a job description.
// A worker is not a saved prompt on a timer — every shift it re-plans from
// its job description plus its journal, parks proposals through the
// orchestrator, and earns (or loses) the right to launch work unattended.
//
// Three surfaces in one pane, mutually exclusive like SchedulesPane:
//   - the roster (list of hired workers, each with scorecard + budget burn)
//   - the hire screen (job description → drafted contract → editor)
//   - the editor (review/adjust the contract; the only place Save lives)

import { useEffect, useMemo, useRef, useState } from "react";

import { useStore } from "../../store";
import { useFlowsStore } from "../../flowsStore";
import { useOrchestratorStore } from "../../orchestratorStore";
import {
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
  type Worker,
  type WorkerJournalEntry,
  type WorkerScorecard,
  type WorkerTrustLevel,
} from "@shared/flows/worker";
import { describeFundingBlock, fundingFor } from "@shared/flows/treasury";
import { isSelectableFlow } from "@shared/flows/schema";
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
import { Markdown } from "../Markdown";
import { UserBubble } from "../UserBubble";
import { FlowMonogram } from "../flows/FlowMonogram";
import { FlowRunPane } from "../flows/FlowRunPane";
import { WorkerErrandComposer } from "./WorkerDesk";
import { WorkerAvatar } from "./WorkerAvatar";
import { ShiftCalendar } from "./ShiftCalendar";
import { FundsPane } from "./FundsPane";
import {
  adjacentDeskDay,
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
  workerActivity,
  workerAutoRenderTarget,
  workerRenderableOutputs,
  type WorkerFileJob,
  type DeskDay,
  type WorkerFile,
  type WorkerActivity,
} from "./workerDeskSelectors";
import { TRUST_LABEL, WorkerPendingProposal } from "./WorkerRowParts";

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
  const activeRun = useFlowsStore((s) =>
    s.activeRunId ? s.runs[s.activeRunId] : undefined,
  );
  const [hiring, setHiring] = useState(false);

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
  const selected = previewEmpty
    ? null
    : (selectedWorkerId && workers[selectedWorkerId]) || rows[0] || null;
  useEffect(() => {
    if (!selectedWorkerId && rows.length > 0) selectWorker(rows[0].id);
  }, [rows, selectWorker, selectedWorkerId]);

  const nameForPath = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) m.set(p.path, p.name);
    for (const w of workspaces) m.set(w.rootPath, w.name);
    return m;
  }, [projects, workspaces]);

  const defaultProjectPath = workspaces[0]?.rootPath ?? projects[0]?.path ?? "";
  const canHire = defaultProjectPath !== "";

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

  if (hiring)
    return (
      <HireWorker
        defaultProjectPath={defaultProjectPath}
        onClose={() => setHiring(false)}
      />
    );

  return (
    // A column, not a scroll box. The desk is a conversation: its transcript
    // has to scroll under a header and composer that stay put, the way the
    // Chat tab works. Scrolling the whole pane took the composer with it.
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-6 pt-6">
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
            onClick={() => openEditor(newWorkerDraft(defaultProjectPath))}
            className="text-xs px-3 py-1.5 rounded-md border border-card-strong hover:bg-white/5 disabled:opacity-40"
          >
            Add by hand
          </button>
          <button
            disabled={!canHire}
            onClick={() => setHiring(true)}
            className="text-xs px-3 py-1.5 rounded-md bg-accent text-white hover:opacity-90 disabled:opacity-40"
          >
            ✨ Hire a worker
          </button>
        </div>
        <div className="text-xs text-ink-muted mb-4">
          Standing personas on a clock — each shift they plan their own batch of
          work and file it for your approval.
        </div>

        {error && (
          <div
            onClick={clearError}
            className="mb-4 text-sm text-red-700 dark:text-red-300 bg-red-500/15 border border-red-400/40 rounded px-3 py-2 cursor-pointer"
          >
            {error}
          </div>
        )}
      </div>

      {!loaded ? (
        <div className="px-6 text-sm text-ink-muted">Loading workers…</div>
      ) : view === "calendar" ? (
        <ShiftCalendar />
      ) : view === "funds" ? (
        <FundsPane />
      ) : rows.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          <WorkersEmptyState
            canHire={canHire}
            onHire={() => setHiring(true)}
            onAddByHand={() => openEditor(newWorkerDraft(defaultProjectPath))}
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
          key={selected.id}
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
///     action on the front page is "Work now"; pausing, promoting and firing
///     are deliberate acts that belong on Settings, next to the rules that
///     govern them.
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
  const busy = useWorkersStore((s) => s.busy);
  const workShiftNow = useWorkersStore((s) => s.workShiftNow);
  const [tab, setTab] = useState<
    "desk" | "shift" | "files" | "journal" | "stats" | "settings"
  >("desk");
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
  useEffect(() => {
    if (focus?.workerId !== worker.id) return;
    setTab("desk");
    setDay(startOfDay(focus.at));
    setFocusId(focus.orchestrationId);
    clearDeskFocus();
  }, [focus, worker.id, clearDeskFocus]);

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
  const setFilesRoot = useWorkersStore((s) => s.setFilesRoot);
  useEffect(() => {
    let live = true;
    void window.overcli.invoke("workers:files", { id: worker.id }).then((res) => {
      if (!live) return;
      setFilesRoot(worker.id, res.root);
      setFiles(res.files);
    });
    return () => {
      live = false;
    };
  }, [worker.id, setFilesRoot]);

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
    () => mine.filter(isOrchestrationAwaitingApproval),
    [mine],
  );
  const activity = useMemo(() => mine.map(toWorkerActivity), [mine]);
  const days = useMemo(() => deskDays(activity), [activity]);
  // Oldest first: a transcript reads down, and the composer is at the bottom.
  const dayItems = useMemo(() => deskTimeline(activity, day), [activity, day]);
  const timelineCount = dayItems.length;

  // Park the transcript at the newest message when you arrive, and keep it
  // there as turns land — a conversation you open half-scrolled reads as
  // broken, and the last thing said is the thing you came for.
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [tab, worker.id, timelineCount, day]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-6">
        {/* Identity. Name, standing, rhythm — and one action. */}
        <div className="flex items-start gap-4">
          <WorkerAvatar worker={worker} size="lg" live={!!shift} />
          <div className="min-w-0 flex-1">
            <div className="text-2xl font-semibold tracking-tight text-ink">
              {worker.name}
            </div>
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
            disabled={busy || !!shift}
            onClick={() => void workShiftNow(worker.id)}
            title="Work one shift now, out of band. Does not change the schedule."
            className="shrink-0 rounded-md border border-card-strong px-3 py-1.5 text-xs text-ink-muted hover:bg-white/5 hover:text-ink disabled:opacity-40"
          >
            {shift ? "Working…" : "Work now"}
          </button>
        </div>

        <div className="mt-5 flex items-center gap-6 border-b border-card-strong">
          {(
            [
              ["desk", "Desk"],
              ["shift", "Shift"],
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
                "-mb-px flex items-center gap-1.5 border-b-2 px-0.5 pb-2 text-[13px] transition-colors " +
                "focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 " +
                (tab === key
                  ? "border-accent text-ink"
                  : "border-transparent text-ink-faint hover:text-ink-muted")
              }
            >
              {label}
              {key === "desk" && awaiting.length > 0 && (
                <span className="rounded-full bg-violet-500/20 px-1.5 text-[10px] text-violet-500">
                  {awaiting.length}
                </span>
              )}
              {/* A shift in flight is the one thing here that changes while you
                are not looking at it, so the tab says so. */}
              {key === "shift" && shift?.task === "shift" && (
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-60" />
                  <span className="relative h-1.5 w-1.5 rounded-full bg-sky-400" />
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {tab === "desk" ? (
        <>
          <DeskDayBar day={day} days={days} onSet={setDay} />
          <div
            ref={scroller}
            className="min-h-0 flex-1 overflow-y-auto px-6 py-4"
          >
            <WorkerTimeline
              worker={worker}
              items={dayItems}
              day={day}
              days={days}
              onSet={setDay}
              focusId={focusId}
            />
          </div>
          <div className="shrink-0 border-t border-card px-6 py-3">
            <WorkerErrandComposer worker={worker} />
          </div>
        </>
      ) : (
        <div
          ref={scroller}
          className="min-h-0 flex-1 overflow-y-auto px-6 pb-6"
        >
          {tab === "shift" && (
            <WorkerShiftPane worker={worker} nextShiftAt={nextShiftAt} />
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
              priority {funding.priority} of {allocation?.byWorker.length}
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
}: {
  worker: Worker;
  projectLabel?: string;
  files: WorkerFile[];
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
  const [resetFiles, setResetFiles] = useState(false);
  // What the last reset threw away, kept until the card unmounts. A reset is
  // silent by nature — the journal it emptied is the thing that would have
  // recorded it — so this line is the only acknowledgement there is.
  const [resetDone, setResetDone] = useState<{ entries: number; files: number } | null>(null);

  const startFresh = async () => {
    const res = await resetMemory(worker.id, resetFiles);
    setConfirmingReset(false);
    setResetFiles(false);
    if (res) setResetDone(res);
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
                    ? `Started fresh — forgot ${resetDone.entries} journal ${
                        resetDone.entries === 1 ? "entry" : "entries"
                      }${resetDone.files ? `, emptied ${resetDone.files} files` : ""}.`
                    : "Its journal steers every shift. Wipe it to start over at shift #1."}
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
                  It forgets what it proposed and what you turned down, so it may
                  offer those again. Trust and budget stay as they are.
                </div>
                <label className="mt-2 flex cursor-pointer items-start gap-2 text-xs text-ink">
                  <input
                    type="checkbox"
                    checked={resetFiles}
                    onChange={(e) => setResetFiles(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>
                    Also empty its files
                    {files.length > 0 ? ` (${files.length})` : ""}
                    <span className="block text-ink-faint">
                      Deletes the baselines and tallies it works from, and the
                      outputs it filed. Cannot be undone.
                    </span>
                  </span>
                </label>
                <div className="mt-2 flex gap-1">
                  <button
                    onClick={() => void startFresh()}
                    className="rounded bg-red-500/80 px-2 py-0.5 text-[11px] text-white"
                  >
                    {resetFiles ? "Reset memory and files" : "Reset memory"}
                  </button>
                  <button
                    onClick={() => {
                      setConfirmingReset(false);
                      setResetFiles(false);
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
  const [share, setShare] = useState<{ yaml: string; missingFlowIds: string[] } | null>(null);
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
        <div className="text-[11px] uppercase tracking-wider text-ink-faint">Share</div>
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
        <div className="mt-2 truncate text-[10px] text-ink-faint" title={savedTo}>
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
          {share.missingFlowIds.length === 1 ? "is" : "are"} not in your library,
          so {share.missingFlowIds.length === 1 ? "it travels" : "they travel"} as
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
function AutoRenderSetting({ worker, files }: { worker: Worker; files: WorkerFile[] }) {
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
          {missing && <option value={value}>{value} — not filed any more</option>}
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
function WorkerShiftPane({
  worker,
  nextShiftAt,
}: {
  worker: Worker;
  nextShiftAt: number | null;
}) {
  const shift = useWorkersStore((s) => s.shiftProgress[worker.id]);
  const workShiftNow = useWorkersStore((s) => s.workShiftNow);
  const busy = useWorkersStore((s) => s.busy);
  const orchestrations = useOrchestratorStore((s) => s.orchestrations);
  const openWorkerActivity = useWorkersStore((s) => s.openWorkerActivity);

  const latest = useMemo(
    () =>
      workerActivity(orchestrations, worker.id, 40).find(
        (a) => a.task === "shift",
      ),
    [orchestrations, worker.id],
  );
  const planning = shift?.task === "shift";
  const working = !!latest && (latest.running > 0 || latest.proposed > 0);

  return (
    <div className="mt-4 space-y-4">
      <div className="flex items-baseline gap-2">
        <span className="text-sm text-ink">
          {planning
            ? `${worker.name} is planning its shift`
            : working
              ? `Shift ${latest?.title.replace(/^Shift\s*/, "") ?? ""} is running`
              : "No shift running"}
        </span>
        <span className="text-[11px] text-ink-faint">
          {worker.enabled
            ? nextShiftAt != null
              ? `next ${untilLabel(nextShiftAt)} · ${describeTrigger(worker.cadence)}`
              : describeTrigger(worker.cadence)
            : "paused — no shifts until you resume it"}
        </span>
        <button
          disabled={busy || !!shift}
          onClick={() => void workShiftNow(worker.id)}
          title="Work one shift now, out of band. Does not change the schedule."
          className="ml-auto shrink-0 rounded-md border border-card-strong px-2.5 py-1 text-xs text-ink-muted hover:bg-white/5 hover:text-ink disabled:opacity-40"
        >
          {shift ? "Working…" : "Work now"}
        </button>
      </div>

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
            <div className="max-h-[40vh] overflow-y-auto text-xs text-ink-muted">
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
        <div className="rounded-xl border border-card-strong px-4 py-3">
          <div className="mb-1 flex items-baseline gap-2">
            <button
              onClick={() =>
                openWorkerActivity(
                  worker.id,
                  latest.orchestration.id,
                  latest.at,
                )
              }
              className="text-sm text-ink hover:underline focus:outline-none"
              title="Open this shift on the desk"
            >
              {latest.title}
            </button>
            <span className="text-[11px] text-ink-faint">
              {describeActivity(latest)} · {relativeTime(latest.at)}
            </span>
          </div>
          <ShiftPlan orchestration={latest.orchestration} />
          {isOrchestrationAwaitingApproval(latest.orchestration) && (
            <WorkerPendingProposal orchestration={latest.orchestration} />
          )}
        </div>
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
  focusId,
}: {
  worker: Worker;
  /// This day's turns, oldest first. The desk is scoped to one day — see
  /// DeskDayBar — so this is the whole transcript, not a window onto it.
  items: WorkerActivity[];
  day: number;
  days: DeskDay[];
  onSet: (day: number) => void;
  /// A turn arrived at from somewhere else (the shift calendar): opened and
  /// scrolled to, whatever the default expansion rule would have done.
  focusId: string | null;
}) {
  const sending = useWorkersStore((s) => s.errandSending[worker.id]);
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

  if (items.length === 0 && !(sending && sending.length > 0 && isToday)) {
    return <EmptyDesk worker={worker} day={day} days={days} onSet={onSet} />;
  }

  return (
    <div className="flex flex-col gap-4">
      {items.map((item) => {
        const awaiting = isOrchestrationAwaitingApproval(item.orchestration);
        const id = item.orchestration.id;
        const produced = item.orchestration.items.length > 0;
        const open = overrides[id] ?? (id === focusId || produced);
        const toggle = () => setOverrides((cur) => ({ ...cur, [id]: !open }));
        const anchor = id === focusId ? focused : undefined;

        if (item.task === "shift") {
          return (
            <div key={id} ref={anchor}>
              <ShiftRule item={item} open={open} onToggle={toggle} />
            </div>
          );
        }
        const launched = item.running + item.done + item.failed;
        return (
          <div key={id} ref={anchor} className="flex flex-col gap-2">
            <UserBubble text={item.ask || item.title} />
            <WorkerReply
              worker={worker}
              tint={tint}
              at={item.at}
              reply={item.reply}
              footer={
                launched > 0 || item.proposed > 0 ? (
                  <button
                    onClick={toggle}
                    className="mt-2 text-[11px] text-ink-faint hover:text-ink focus:outline-none"
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
                ) : null
              }
            />
            {open && (
              <div className="rounded-xl border border-card-strong px-3 pb-2">
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
      {/* The turn you just sent. It has no batch yet — one only exists once the
          planning turn finishes — so it is rendered from the in-flight record
          instead. Same bubble, so nothing shifts when the real one replaces it. */}
      {isToday &&
        sending?.map((pending) => (
          <UserBubble key={pending.id} text={pending.text} />
        ))}
    </div>
  );
}

/// A day with nothing on it. Two different silences, and they need different
/// words: today being empty is the desk working as intended, and an empty past
/// day is just an empty past day.
function EmptyDesk({
  worker,
  day,
  days,
  onSet,
}: {
  worker: Worker;
  day: number;
  days: DeskDay[];
  onSet: (day: number) => void;
}) {
  const previous = adjacentDeskDay(days, day, -1);
  const previousCount = days.find((d) => d.at === previous)?.count ?? 0;
  const everWorked = days.length > 0;
  return (
    <div className="rounded-xl border border-dashed border-card-strong px-4 py-8 text-center">
      <div className="text-sm text-ink">
        {day === startOfDay(Date.now())
          ? everWorked
            ? "Clean desk."
            : "Nothing yet."
          : "Nothing on this day."}
      </div>
      <div className="mt-1 text-xs text-ink-muted">
        {worker.name} files its next shift here — or ask it something below.
      </div>
      {/* The way back. A cleared desk must never mean "lost": the last day
          that had work is one click away, named and counted. */}
      {previous != null && (
        <button
          onClick={() => onSet(previous)}
          className="mt-3 text-xs text-accent hover:underline focus:outline-none"
        >
          {deskDayLabel(previous)} · {previousCount}{" "}
          {previousCount === 1 ? "turn" : "turns"} →
        </button>
      )}
    </div>
  );
}

/// The desk's date line. Steps only through days that HAVE work, so a worker
/// idle for a fortnight is one click back, not fourteen.
function DeskDayBar({
  day,
  days,
  onSet,
}: {
  day: number;
  days: DeskDay[];
  onSet: (day: number) => void;
}) {
  const older = adjacentDeskDay(days, day, -1);
  const newer = adjacentDeskDay(days, day, 1);
  const today = startOfDay(Date.now());
  const count = days.find((d) => d.at === day)?.count ?? 0;

  return (
    <div className="flex shrink-0 items-center gap-2 px-6 pt-3">
      <button
        onClick={() => older != null && onSet(older)}
        disabled={older == null}
        title={
          older != null ? `Back to ${deskDayLabel(older)}` : "Nothing earlier"
        }
        className="rounded border border-card-strong px-1.5 leading-5 text-[11px] text-ink-faint hover:bg-white/5 hover:text-ink focus:outline-none disabled:opacity-30"
      >
        ‹
      </button>
      <span className="text-[11px] text-ink-muted">
        {deskDayLabel(day)}
        {count > 0 && (
          <span className="text-ink-faint">
            {" "}
            · {count} {count === 1 ? "turn" : "turns"}
          </span>
        )}
      </span>
      <button
        onClick={() => newer != null && onSet(newer)}
        disabled={newer == null}
        title={
          newer != null ? `Forward to ${deskDayLabel(newer)}` : "Nothing later"
        }
        className="rounded border border-card-strong px-1.5 leading-5 text-[11px] text-ink-faint hover:bg-white/5 hover:text-ink focus:outline-none disabled:opacity-30"
      >
        ›
      </button>
      {day !== today && (
        <button
          onClick={() => onSet(today)}
          className="text-[11px] text-accent hover:underline focus:outline-none"
        >
          Today
        </button>
      )}
      <span className="ml-auto h-px flex-1" />
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
        {reply ? (
          <Markdown source={reply} />
        ) : (
          <div className="text-xs text-ink-faint">No reply recorded.</div>
        )}
        {footer}
      </div>
    </div>
  );
}

/// A shift is something the worker did unprompted, so it reads as a rule
/// across the thread rather than a message — the way a chat marks a day break.
function ShiftRule({
  item,
  open,
  onToggle,
}: {
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
          <ShiftPlan orchestration={item.orchestration} />
          {awaiting && (
            <WorkerPendingProposal orchestration={item.orchestration} />
          )}
        </div>
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
          <div className="max-h-56 overflow-y-auto rounded-md bg-card-strong/30 px-3 py-2 text-xs text-ink-muted">
            <Markdown source={prose} />
          </div>
        ) : (
          <div className="text-[11px] text-ink-faint">
            The planning turn left no notes.
          </div>
        ))}
      {orchestration.items.length > 0 ? (
        <div className={(showProse ? "mt-2 " : "") + "space-y-1"}>
          {orchestration.items.map((it) => (
            <PlanItemRow
              key={it.candidate.id}
              item={it}
              orchestration={orchestration}
            />
          ))}
        </div>
      ) : (
        <div className="mt-1 text-[11px] text-ink-faint">
          Nothing proposed — the worker judged there was nothing worth doing.
        </div>
      )}
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
}: {
  item: OrchestrationItem;
  orchestration: Orchestration;
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
    if (!workerId || item.status !== "done" || !finishedAt) return;
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
  ]);

  const pause = run?.state.kind === "paused" ? run.state : null;
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

  return (
    <div>
      <div className="flex items-baseline gap-2 text-[11px]">
        <span
          className={`shrink-0 w-16 ${PLAN_STATUS[item.status]?.cls ?? "text-ink-faint"}`}
        >
          {PLAN_STATUS[item.status]?.text ?? item.status}
        </span>
        {item.runId ? (
          <button
            onClick={openRun}
            title="Open the run"
            className="min-w-0 flex-1 truncate text-left text-ink hover:underline focus:outline-none"
          >
            {item.candidate.title}
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate text-ink">
            {item.candidate.title}
          </span>
        )}
        {item.note && (
          <span className="shrink-0 truncate text-ink-faint">
            — {item.note}
          </span>
        )}
        {pause && (
          <button
            onClick={resume}
            disabled={inFlight}
            title={PAUSE_HINT[pause.reason]}
            className="shrink-0 rounded border border-amber-500/40 px-1.5 py-[1px] text-[10px] text-amber-600 hover:bg-amber-500/10 focus:outline-none disabled:opacity-50 dark:text-amber-300"
          >
            {inFlight ? "resuming…" : PAUSE_ACTION[pause.reason]}
          </button>
        )}
      </div>
      {/* What the work was FOR, every file of it, opening in the preview pane
          the same way any other markdown in the app does. These are the filed
          copies on disk, so they outlive the run that made them. */}
      {files.length > 0 && (
        <div className="mt-0.5 flex flex-wrap gap-1 pl-[72px]">
          {files.map((file) => (
            <button
              key={file.path}
              onClick={() => openFile(file.path, undefined, "preview")}
              title={`${file.path} — ${formatBytes(file.bytes)}`}
              className="rounded border border-card-strong px-1.5 py-[1px] text-[10px] text-ink-faint hover:bg-card-strong hover:text-ink focus:outline-none"
            >
              {baseName(file.name)}
            </button>
          ))}
        </div>
      )}
      {/* A finished item that filed nothing is worth saying out loud: it is the
          difference between "the answer is elsewhere" and "there is no
          answer", and silence reads as the first. */}
      {files.length === 0 && item.status === "done" && (
        <div className="pl-[72px] text-[10px] text-ink-faint">
          nothing filed
        </div>
      )}
    </div>
  );
}

/// What a plain resume DOES depends on why the run stopped, so the button says
/// so rather than offering one word for three different acts. The escape hatch
/// on a failure pause — Override, accept this result and roll forward — stays
/// in the run pane, where the artifact it would accept is readable.
const PAUSE_ACTION: Record<string, string> = {
  preStep: "continue",
  failure: "re-run step",
  interrupted: "resume",
};

const PAUSE_HINT: Record<string, string> = {
  preStep: "Hand the prior step\u2019s output to the next step and keep going",
  failure:
    "Run the failed step again. To accept its result instead, open the run and Override.",
  interrupted:
    "The app closed mid-step \u2014 run that step again and roll forward",
};

const PLAN_STATUS: Record<string, { text: string; cls: string }> = {
  proposed: { text: "proposed", cls: "text-violet-500" },
  queued: { text: "queued", cls: "text-ink-muted" },
  running: { text: "running", cls: "text-sky-500" },
  paused: { text: "paused", cls: "text-amber-500" },
  done: { text: "done", cls: "text-emerald-500" },
  failed: { text: "failed", cls: "text-red-500" },
  cancelled: { text: "rejected", cls: "text-red-400" },
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

function HireWorker({
  defaultProjectPath,
  onClose,
}: {
  defaultProjectPath: string;
  onClose: () => void;
}) {
  const openEditor = useWorkersStore((s) => s.openEditor);
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const [jobDescription, setJobDescription] = useState("");
  const [projectPath, setProjectPath] = useState(defaultProjectPath);
  // Whether the user picked the project themselves. An explicit choice beats
  // the drafter's suggestion; the untouched default loses to it.
  const [projectTouched, setProjectTouched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  async function handleDraft(): Promise<void> {
    if (!jobDescription.trim()) {
      setError(
        "Describe the job first — the worker plans every shift from it.",
      );
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await window.overcli.invoke("workers:draftFromPrompt", {
        jobDescription,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // The drafter may recognize which project the job is about; honor that
      // only when the user left the picker on its default.
      const chosenPath = projectTouched
        ? projectPath
        : (result.contract.projectPath ?? projectPath);
      openEditor(
        draftFromContract(result.contract, chosenPath, result.contract.flowId),
        {
          draftedFlow: result.draftedFlow,
          hireSummary: result.summary || undefined,
        },
      );
      onClose();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="flex items-center gap-3 mb-1">
        <button
          onClick={onClose}
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
                    onClick={() => {
                      setJobDescription(p.job);
                      setError(null);
                    }}
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
                onChange={(e) => {
                  setProjectPath(e.target.value);
                  setProjectTouched(true);
                }}
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
                onChange={(e) => {
                  setJobDescription(e.target.value);
                  setError(null);
                }}
                placeholder={`You're the …\n\nSay what it should look at, how often, what a good proposal looks like, and what it must never do.`}
                className="w-full bg-card border border-card-strong rounded p-3 text-sm text-ink leading-relaxed"
              />
            </div>

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
                onClick={() => void handleDraft()}
                className="ml-auto shrink-0 text-xs px-4 py-2 rounded-md bg-accent text-white hover:opacity-90 disabled:opacity-40"
              >
                {loading ? "Drafting the contract…" : "✨ Draft the contract"}
              </button>
            </div>
            {loading && (
              <WorkingStrip message="Drafting — one turn writes the contract (persona, cadence, caps, budget); if no existing flow fits, a second turn drafts the flow too. Usually under two minutes." />
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
                <input
                  value={draft.heartbeatModel}
                  onChange={(e) => patch({ heartbeatModel: e.target.value })}
                  placeholder="model id"
                  className="w-full bg-card border border-card-strong rounded px-2 py-1.5 text-sm text-ink"
                />
              </Field>
            </div>

            <div className="text-[11px] text-ink-faint">
              {existing
                ? `Trust: ${existing.trust} — change it from the roster with Promote/Demote.`
                : "Hired on probation: every proposal parks for your approval, and rejected ones are never re-proposed. Promote from the roster once it has earned it."}
            </div>
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
function WorkingStrip({ message }: { message: string }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const t = setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => clearInterval(t);
  }, []);
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
  const draftedFlow = useWorkersStore((s) => s.draftedFlow);
  const applyRevision = useWorkersStore((s) => s.applyRevision);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const expanded = focused || instruction.length > 0;

  if (!draft) return null;

  async function handleRevise(): Promise<void> {
    if (!draft || busy) return;
    const text = instruction.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      // A ride-along flow (hire-drafted or already revised) is unsaved —
      // main can't load it by id, so ship the object; it's also the freshest
      // state when the flow was revised before. But only when it's still the
      // SELECTED flow — after a manual re-pick, the saved pick wins.
      const rideAlong =
        draftedFlow &&
        (draft.flowIds.length === 0 || draft.flowIds[0] === draftedFlow.id)
          ? draftedFlow
          : undefined;
      const res = await window.overcli.invoke("workers:reviseFromPrompt", {
        jobDescription: draft.jobDescription,
        flow: rideAlong,
        flowId: rideAlong ? undefined : draft.flowIds[0],
        instruction: text,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      applyRevision({ jobDescription: res.jobDescription, flow: res.flow });
      setNote(res.note);
      setInstruction("");
    } finally {
      setBusy(false);
    }
  }

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
          onChange={(e) => {
            setInstruction(e.target.value);
            setError(null);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            // ⌘/Ctrl+Enter submits — Enter alone stays a newline so a
            // multi-sentence instruction doesn't fire off half-written.
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void handleRevise();
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
        {(busy || instruction.trim()) && (
          <button
            onClick={() => void handleRevise()}
            disabled={busy || !instruction.trim()}
            className="text-xs px-2.5 py-1 rounded-md bg-accent text-white hover:opacity-90 disabled:opacity-50 whitespace-nowrap self-center"
            title="⌘↵"
          >
            {busy ? "Revising…" : "Apply"}
          </button>
        )}
      </div>

      {expanded && !busy && (
        <div className="flex flex-wrap items-center gap-1.5 mt-1.5 px-1">
          {!instruction &&
            REVISE_EXAMPLES.map((ex) => (
              <button
                key={ex}
                // Blur fires before click, and blur collapses this row — so
                // claim the press before the row can disappear under it.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setInstruction(ex)}
                className="text-[11px] px-2 py-0.5 rounded-full border border-card text-ink-faint hover:text-ink hover:bg-card-strong"
              >
                {ex}
              </button>
            ))}
          <span className="ml-auto text-[10px] text-ink-faint">
            ⌘↵ to apply · you review before saving
          </span>
        </div>
      )}

      {busy && (
        <WorkingStrip message="Revising — one drafting turn decides what changes (job description, flow, or both); a flow change runs a second pass through the flow editor. Usually under two minutes." />
      )}

      {error && (
        <div className="text-xs text-red-700 dark:text-red-300 bg-red-500/10 border border-red-500/20 rounded p-2.5 mt-2">
          {error}
        </div>
      )}

      {note && (
        <div className="flex items-start gap-2 text-xs text-emerald-800 dark:text-emerald-200 bg-emerald-500/10 border border-emerald-500/20 rounded p-2 mt-2">
          <div className="min-w-0 flex-1 whitespace-pre-wrap">
            {note}
            {"\n"}Nothing is saved until you hit Save.
          </div>
          <button
            onClick={() => setNote(null)}
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
