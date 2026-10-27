// Processes on the Workers tab: one piece of work moving through several
// teams and your decisions, in order. The list, the library (processes to
// start from, and one opened up), the editor and one process's board,
// mutually exclusive like the team desk and its editor.
//
// Main decides everything (src/main/org/processes.ts): the board shows what
// it last said and refreshes on a timer and whenever a team task moves,
// since that is what carries an item from one stage to the next.

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { useStore } from "../../../store";
import { useTeamsStore } from "../../../teamsStore";
import { useWorkersStore } from "../../../workersStore";
import { relativeTime } from "../workerDeskSelectors";
import { WorkerAvatar, workerInitials } from "../WorkerAvatar";
import { ShortNameChip, ShortNameField } from "../ShortNameField";
import { ProcessItemPage } from "./ProcessItemPage";
import { FLOW_KIND_PILL, FlowLegend, ProcessFlow, flowWho } from "./ProcessFlow";
import { FromImageSheet, ImageGlyph, PictureBanner, PictureViewer, type PictureStart } from "./FromImage";
import { StageAsksEditor } from "./StageFields";
import { workerTagline, type Worker } from "@shared/flows/worker";
import type { ProcessDef, ProcessStage } from "@shared/org/process";
import { libraryProcess, stagesFromLibrary, suggestTeamFor, type LibraryProcess } from "@shared/org/processLibrary";
import type { ProcessItemView, ProcessSummary } from "@shared/types";
import {
  DESKTOP_PERSON,
  STAGE_KIND_LABEL,
  goodMatches,
  libraryByCategory,
  libraryDraft,
  libraryStageFor,
  moveStage,
  newStage,
  pickerSections,
  pictureEditorDraft,
  rankDoers,
  removeStage,
  sendBackName,
  stageMatchText,
  stageMissing,
  DAY_NAMES,
  SCHEDULE_PRESETS,
  delayOptions,
  parseWatchArgs,
  repeatFromKey,
  repeatKey,
  repeatOptions,
  scheduleCadence,
  timingText,
  FLOW_GAP,
  durationWords,
  endToEnd,
  filterCounts,
  filterItems,
  flowColumns,
  flowMinWidth,
  itemOrigin,
  itemTone,
  nowLine,
  outcomeLine,
  pageStats,
  quietSummary,
  recentFinished,
  recentTrack,
  shortSpan,
  stageDurations,
  stageMoreAtDefaults,
  stageSentence,
  stageTimeWords,
  startedWords,
  timeBars,
  waysInPhrase,
  waysInShort,
  type BoardFilter,
  type SchedulePreset,
  type TrackStep,
  stageReady,
  teamBriefFor,
  teamOptions,
  workerOptions,
  type DoerOption,
  type LocalTeam,
  type LocalWorker,
  type RankedDoer,
} from "./processView";

const primaryBtn = "text-xs px-3 py-1.5 rounded-md bg-accent text-white hover:opacity-90 disabled:opacity-40";
const secondaryBtn =
  "text-xs px-3 py-1.5 rounded-md border border-card-strong text-ink hover:bg-card-strong disabled:opacity-40";
const quietBtn = "text-xs px-2 py-1 rounded-md text-ink-muted hover:bg-card-strong hover:text-ink disabled:opacity-40";

/// How often an open list or board asks main again. Main catches up with the
/// team tasks on each ask, so this is how late a finished stage can show.
const REFRESH_MS = 10_000;
/// How long team tasks must sit still before the board reloads for them.
const TASK_SETTLE_MS = 750;

type Board = Extract<Awaited<ReturnType<typeof getProcess>>, { ok: true }>;

function getProcess(id: string) {
  return window.overcli.invoke("processes:get", { id });
}

/// The local teams a stage can use: the ones still standing, with what the
/// library matches them on.
function useLocalTeams(): LocalTeam[] {
  const loaded = useTeamsStore((s) => s.loaded);
  const teams = useTeamsStore((s) => s.teams);
  useEffect(() => {
    if (!loaded) void useTeamsStore.getState().reload();
  }, [loaded]);
  return useMemo(
    () =>
      Object.values(teams)
        .filter((t) => !t.disbanded)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((t) => ({
          id: t.id,
          name: t.name,
          ...(t.purpose ? { purpose: t.purpose } : {}),
          members: t.members.map((m) => ({ role: m.role })),
        })),
    [teams],
  );
}

/// The workers a stage can use: the whole crew, by name, each with the line
/// the Workers rail shows under its name.
function useLocalWorkers(): { list: LocalWorker[]; byId: Record<string, Worker> } {
  const loaded = useWorkersStore((s) => s.loaded);
  const workers = useWorkersStore((s) => s.workers);
  useEffect(() => {
    if (!loaded) void useWorkersStore.getState().reload();
  }, [loaded]);
  const list = useMemo(
    () =>
      Object.values(workers)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((w) => ({ id: w.id, name: w.name, tagline: workerTagline(w), enabled: w.enabled })),
    [workers],
  );
  return { list, byId: workers };
}

/// Re-run `load` every REFRESH_MS and whenever a team task changes. Tasks
/// change in bursts while a team works, so those reloads wait for a pause;
/// a new `load` (another process opened) runs at once.
function useRefresh(load: () => void) {
  const tasks = useTeamsStore((s) => s.tasks);
  const loaded = useRef<() => void>();
  useEffect(() => {
    if (loaded.current !== load) {
      loaded.current = load;
      load();
      return;
    }
    const t = setTimeout(load, TASK_SETTLE_MS);
    return () => clearTimeout(t);
  }, [load, tasks]);
  useEffect(() => {
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);
}

/// The library process open when "Make this team" left for the team
/// editor, so coming back to Processes lands on it again, matched against
/// the team just made. Read once, by the next pane to mount.
let resumeLibraryPick: string | null = null;

/// The editor as it was when "Make this team" left for the team editor, so
/// coming back to Processes opens it again with nothing lost. Read once.
type EditorSnapshot = {
  existing: ProcessDef | null;
  name: string;
  shortName: string;
  purpose: string;
  about?: string;
  templateId?: string;
  stages: ProcessStage[];
  sel: number;
  codeIn?: { name: string; path: string } | null;
};
let resumeEditor: EditorSnapshot | null = null;

export function ProcessesPane() {
  const selectedProcessId = useWorkersStore((s) => s.selectedProcessId);
  /// The editor: `id` null is a new process, `from` a library process it
  /// starts from, `picture` a draft read from a picture.
  const [editing, setEditing] = useState<{ id: string | null; from?: string; picture?: PictureStart; resume?: EditorSnapshot } | null>(() =>
    resumeEditor ? { id: resumeEditor.existing?.id ?? null, resume: resumeEditor } : null,
  );
  /// The library: `pick` the process opened up, null the whole library.
  const [library, setLibrary] = useState<{ pick: string | null } | null>(() => (resumeLibraryPick ? { pick: resumeLibraryPick } : null));
  useEffect(() => {
    resumeLibraryPick = null;
    resumeEditor = null;
  }, []);
  // A different process picked closes the editor. Compared with the last
  // one seen, so mounting (which may be reopening the editor) doesn't.
  const lastPick = useRef(selectedProcessId);
  useEffect(() => {
    if (lastPick.current === selectedProcessId) return;
    lastPick.current = selectedProcessId;
    setEditing(null);
  }, [selectedProcessId]);
  useEffect(() => {
    if (selectedProcessId) setLibrary(null);
  }, [selectedProcessId]);
  const openLibrary = () => {
    setEditing(null);
    setLibrary({ pick: null });
  };
  /// "From an image": its sheet over whichever page opened it.
  const [fromImage, setFromImage] = useState(false);
  const openFromImage = () => setFromImage(true);
  const sheet = fromImage ? (
    <FromImageSheet
      onClose={() => setFromImage(false)}
      onDrafted={(picture) => {
        setFromImage(false);
        setLibrary(null);
        setEditing({ id: null, picture });
      }}
    />
  ) : null;
  const page = (): ReactNode => {
    if (editing) {
      return (
        <ProcessEditor
          key={editing.id ?? editing.from ?? (editing.picture ? "picture" : "new")}
          id={editing.id}
          from={editing.from}
          picture={editing.picture}
          resume={editing.resume}
          onClose={() => setEditing(null)}
          onLibrary={openLibrary}
        />
      );
    }
    const picked = library?.pick ? libraryProcess(library.pick) : undefined;
    if (library && picked) {
      return (
        <LibraryDetail
          key={picked.id}
          process={picked}
          onBack={() => setLibrary({ pick: null })}
          onUse={() => {
            setLibrary(null);
            setEditing({ id: null, from: picked.id });
          }}
        />
      );
    }
    if (library) {
      return (
        <ProcessLibrary
          onPick={(pick) => setLibrary({ pick })}
          onFromImage={openFromImage}
          onBack={() => setLibrary(null)}
          onBlank={() => {
            setLibrary(null);
            setEditing({ id: null });
          }}
        />
      );
    }
    if (selectedProcessId) {
      return <ProcessBoard key={selectedProcessId} id={selectedProcessId} onEdit={() => setEditing({ id: selectedProcessId })} />;
    }
    return <ProcessList onNew={() => setEditing({ id: null })} onLibrary={openLibrary} onFromImage={openFromImage} onPick={(pick) => setLibrary({ pick })} />;
  };
  return (
    <>
      {page()}
      {sheet}
    </>
  );
}

/// Processes reached (by history or a link) while its lab is off: say where
/// the switch is rather than showing it anyway.
export function ProcessesLabOff() {
  const openSheet = useStore((s) => s.openSheet);
  return (
    <div className="flex min-h-0 flex-1 flex-col items-start gap-3 px-6 pt-6">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Processes</h1>
      <p className="m-0 max-w-xl text-sm text-ink-muted">
        Processes is in Labs and switched off. Turn it on to run one piece of work through several teams, workers and your decisions, in order.
      </p>
      <button className={primaryBtn} onClick={() => openSheet({ type: "settings", section: "labs" })}>
        Open Labs
      </button>
    </div>
  );
}

// ---- LIST ----------------------------------------------------------------

function ProcessList({ onNew, onLibrary, onFromImage, onPick }: { onNew: () => void; onLibrary: () => void; onFromImage: () => void; onPick: (id: string) => void }) {
  const showProcesses = useWorkersStore((s) => s.showProcesses);
  const [rows, setRows] = useState<ProcessSummary[] | null>(null);
  const load = useCallback(() => {
    void window.overcli.invoke("processes:list").then(setRows);
  }, []);
  useRefresh(load);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pb-6 pt-6">
      <header className="flex flex-wrap items-start justify-between gap-4 pb-5">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="text-xs text-ink-faint">Workers / Processes</div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Processes</h1>
          <div className="max-w-2xl text-sm text-ink-muted">
            One piece of work moving through several teams and your decisions, in order. Each team is briefed with
            everything the stages before it produced.
          </div>
        </div>
        {rows && rows.length > 0 && (
          <span className="flex shrink-0 items-center gap-2">
            <button className={secondaryBtn} onClick={onLibrary}>
              Process library
            </button>
            <button className={secondaryBtn + " flex items-center gap-1.5"} onClick={onFromImage}>
              <ImageGlyph size={13} />
              From an image
            </button>
            <button className={primaryBtn} onClick={onNew}>
              New process
            </button>
          </span>
        )}
      </header>

      {rows === null ? (
        <div className="text-sm text-ink-muted">Loading processes…</div>
      ) : rows.length === 0 ? (
        <section className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <h2 className="text-base font-semibold text-ink">Start from the library</h2>
              <div className="text-sm text-ink-muted">
                Ways software companies commonly run work across teams. Pick one to see its stages and which of your
                teams fit, then change anything before you save.
              </div>
            </div>
            <span className="flex shrink-0 items-center gap-2">
              <button className={secondaryBtn + " flex items-center gap-1.5"} onClick={onFromImage}>
                <ImageGlyph size={13} />
                From an image
              </button>
              <button className={secondaryBtn} onClick={onNew}>
                Start from nothing
              </button>
            </span>
          </div>
          <LibraryGrid onPick={onPick} />
        </section>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
          {rows.map((p) => {
            const done = p.stages.length;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => showProcesses(p.id)}
                className="flex min-w-0 cursor-pointer flex-col gap-3 rounded-xl border border-card bg-surface-elevated p-4 text-left transition-colors hover:border-accent hover:bg-card-strong/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              >
                <span className="flex min-w-0 items-start gap-3">
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="truncate text-[15px] font-semibold text-ink">{p.name}</span>
                    {p.purpose && <span className="line-clamp-2 text-xs leading-relaxed text-ink-muted">{p.purpose}</span>}
                  </span>
                  <span
                    className={
                      "shrink-0 rounded-full px-2 py-0.5 text-[11px] " +
                      (p.active ? "bg-accent/15 text-accent" : "bg-card-strong text-ink-faint")
                    }
                  >
                    {p.active === 0 ? "Nothing in it" : `${p.active} in flight`}
                  </span>
                </span>
                <StageStrip stages={p.stages} counts={p.byStage} />
                <span className="mt-auto flex items-center gap-3 border-t border-card pt-2.5 text-[11px] text-ink-faint">
                  <span>
                    {done} {done === 1 ? "stage" : "stages"}
                  </span>
                  <span>Owned by {p.owner.name}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/// The stages as a row of chips, with how many items sit at each: a team's
/// in the accent, a worker's sky, a decision amber and dashed, as on the
/// editor's map.
function StageStrip({ stages, counts }: { stages: ProcessStage[]; counts?: number[] }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {stages.map((s, i) => (
        <span key={s.id} className="flex items-center gap-1">
          {i > 0 && <span className="text-[10px] text-ink-faint">→</span>}
          <span
            className={
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] " +
              (s.kind === "people"
                ? "border-dashed border-amber-400/60 text-amber-700 dark:text-amber-300"
                : s.kind === "worker"
                  ? "border-sky-400/50 text-ink-muted"
                  : "border-accent/50 text-ink-muted")
            }
            title={s.ask}
          >
            {s.name}
            {counts && counts[i] > 0 && <span className="rounded-full bg-card-strong px-1.5 text-[10px] text-ink">{counts[i]}</span>}
          </span>
        </span>
      ))}
    </span>
  );
}

// ---- LIBRARY -------------------------------------------------------------

function ProcessLibrary({ onPick, onFromImage, onBack, onBlank }: { onPick: (id: string) => void; onFromImage: () => void; onBack: () => void; onBlank: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pb-6 pt-6">
      <header className="flex flex-wrap items-start justify-between gap-4 pb-5">
        <div className="flex min-w-0 flex-col gap-1">
          <button className="self-start text-xs text-ink-faint hover:text-ink" onClick={onBack}>
            ← Processes
          </button>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Process library</h1>
          <div className="max-w-2xl text-sm text-ink-muted">
            Ways software companies commonly run work across teams. Each says when to use it, why each stage is there and
            who usually decides. Pick one to see which of your teams fit.
          </div>
        </div>
        <span className="flex shrink-0 items-center gap-2">
          <button className={secondaryBtn + " flex items-center gap-1.5"} onClick={onFromImage}>
            <ImageGlyph size={13} />
            From an image
          </button>
          <button className={secondaryBtn} onClick={onBlank}>
            Start from nothing
          </button>
        </span>
      </header>
      <LibraryGrid onPick={onPick} />
    </div>
  );
}

/// The library's cards, by category.
function LibraryGrid({ onPick }: { onPick: (id: string) => void }) {
  const groups = useMemo(() => libraryByCategory(), []);
  return (
    <div className="flex flex-col gap-6">
      {groups.map((g) => (
        <section key={g.category} aria-label={g.category} className="flex flex-col gap-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">{g.category}</h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
            {g.processes.map((p) => (
              <LibraryCard key={p.id} process={p} onPick={() => onPick(p.id)} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function LibraryCard({ process, onPick }: { process: LibraryProcess; onPick: () => void }) {
  const stages = useMemo(() => stagesFromLibrary(process, () => undefined), [process]);
  return (
    <div className="flex min-w-0 flex-col gap-2.5 rounded-xl border border-card bg-surface-elevated p-4">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-sm font-semibold text-ink">{process.name}</span>
        <span className="text-xs leading-relaxed text-ink-muted">{process.summary}</span>
      </div>
      <StageStrip stages={stages} />
      <button className={secondaryBtn + " mt-auto self-start"} onClick={onPick} aria-label={`Use ${process.name}`}>
        Use this
      </button>
    </div>
  );
}

/// One library process opened up: what it's for, what goes in and comes
/// out, and each stage with the team of yours that fits it.
function LibraryDetail({ process, onBack, onUse }: { process: LibraryProcess; onBack: () => void; onUse: () => void }) {
  const teams = useLocalTeams();
  const openTeamEditor = useWorkersStore((s) => s.openTeamEditor);
  const makeTeam = (stage: LibraryProcess["stages"][number]) => {
    // Back on Processes, this process opens again, matched against the new team.
    resumeLibraryPick = process.id;
    openTeamEditor(null, teamBriefFor(stage, process.name));
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-6">
        <div className="flex max-w-4xl flex-col gap-5">
          <header className="flex flex-col gap-1">
            <button className="self-start text-xs text-ink-faint hover:text-ink" onClick={onBack}>
              ← Process library
            </button>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">{process.category}</div>
            <h1 className="text-2xl font-semibold tracking-tight text-ink">{process.name}</h1>
            <div className="text-sm text-ink-muted">{process.summary}</div>
          </header>

          <section className="flex flex-col gap-3 rounded-xl border border-card bg-surface-elevated p-4">
            <div className="text-sm leading-relaxed text-ink">{process.about}</div>
            <div className="grid grid-cols-1 gap-4 border-t border-card pt-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">What goes in</span>
                <span className="text-xs leading-relaxed text-ink-muted">{process.intake}</span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">What comes out</span>
                <span className="text-xs leading-relaxed text-ink-muted">{process.outcome}</span>
              </div>
            </div>
          </section>

          <section aria-label="The stages" className="flex flex-col gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">The stages</span>
            <ol className="flex flex-col gap-2">
              {process.stages.map((s, i) => {
                const team = s.kind === "team";
                const fit = team ? suggestTeamFor(s, teams) : null;
                return (
                  <li
                    key={s.key}
                    className={
                      "flex min-w-0 flex-col gap-1.5 rounded-xl border-[1.5px] bg-surface px-4 py-3 " +
                      (team ? "border-card-strong" : "border-dashed border-amber-400/60")
                    }
                  >
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span
                        className={
                          "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10.5px] font-bold " +
                          (team ? "bg-accent text-white" : "bg-amber-400 text-black")
                        }
                      >
                        {i + 1}
                      </span>
                      <span className={"text-[10px] font-bold uppercase tracking-wider " + (team ? "text-accent" : "text-amber-700 dark:text-amber-300")}>
                        {team ? "Team" : "Decision"}
                      </span>
                      <span className="text-[13px] font-semibold text-ink">{s.name}</span>
                    </span>
                    <span className="text-xs leading-relaxed text-ink">{s.ask}</span>
                    <span className="text-[11.5px] leading-relaxed text-ink-faint">{s.why}</span>
                    {team ? (
                      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px]">
                        {fit ? (
                          <span className="text-emerald-700 dark:text-emerald-300">Your team that fits: {fit.team.name}</span>
                        ) : (
                          <>
                            <span className="text-amber-700 dark:text-amber-300">No team fits: it needs {(s.crew ?? []).join(", ") || "a team"}.</span>
                            <button className="text-accent hover:underline" onClick={() => makeTeam(s)}>
                              Make this team
                            </button>
                          </>
                        )}
                        <span className="text-ink-faint">Usually led by {s.who}</span>
                        {timingText(s) && (
                          <span className="flex items-center gap-1 text-ink-faint">
                            <Glyph name="clock" size={11} />
                            {timingText(s)}
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="text-[11.5px] text-amber-700 dark:text-amber-300">Usually decided by {s.who}. Here it&apos;s you.</span>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>
        </div>
      </div>
      <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-card px-6 py-3">
        <span className="text-[11px] text-ink-faint">You can change any stage, team or decider before you save.</span>
        <span className="flex items-center gap-2">
          <button className={quietBtn} onClick={onBack}>
            Back
          </button>
          <button className={primaryBtn} onClick={onUse}>
            Use this process
          </button>
        </span>
      </footer>
    </div>
  );
}

// ---- LOOKS ---------------------------------------------------------------

/// Each kind of stage in its own colour, as the map's legend says: a team in
/// the accent, a worker sky, a decision amber and dashed.
const KIND_LOOK: Record<
  ProcessStage["kind"],
  { text: string; num: string; key: string; bar: string; ring: string; flow: string; flowOn: string }
> = {
  team: {
    text: "text-accent",
    num: "bg-accent text-white",
    key: "h-2.5 w-2.5 rounded-sm bg-accent",
    bar: "bg-accent",
    ring: "border-accent",
    flow: "border-card-strong bg-surface hover:border-accent",
    flowOn: "border-accent bg-accent/10",
  },
  worker: {
    text: "text-sky-700 dark:text-sky-300",
    num: "bg-sky-400 text-black",
    key: "h-2.5 w-2.5 rounded-sm bg-sky-400",
    bar: "bg-sky-400",
    ring: "border-sky-400",
    flow: "border-card-strong bg-surface hover:border-sky-400",
    flowOn: "border-sky-400 bg-sky-400/10",
  },
  people: {
    text: "text-amber-700 dark:text-amber-300",
    num: "bg-amber-400 text-black",
    key: "h-2.5 w-2.5 rounded-sm border border-dashed border-amber-400",
    bar: "bg-amber-400",
    ring: "border-amber-400",
    flow: "border-amber-400/40 bg-surface hover:border-amber-400",
    flowOn: "border-amber-400 bg-amber-400/10",
  },
};

const sectionLabel = "text-[11px] font-semibold uppercase tracking-wider text-ink-faint";

/// Small line icons, drawn in the text colour.
function Glyph({
  name,
  size = 14,
  className = "",
}: {
  name: "team" | "person" | "worker" | "search" | "check" | "chevron" | "plus" | "inbox" | "slack" | "clock" | "code" | "branch";
  size?: number;
  className?: string;
}) {
  const paths: Record<typeof name, ReactNode> = {
    team: (
      <>
        <circle cx="9" cy="8" r="3" />
        <path d="M3 19c0-3.3 2.7-6 6-6s6 2.7 6 6" />
        <path d="M16 5.5a2.5 2.5 0 0 1 0 5M18 13.5c1.8.8 3 2.6 3 5" />
      </>
    ),
    person: (
      <>
        <circle cx="12" cy="8" r="3.5" />
        <path d="M5 20c0-3.9 3.1-7 7-7s7 3.1 7 7" />
      </>
    ),
    worker: (
      <>
        <rect x="5" y="7" width="14" height="11" rx="3" />
        <path d="M12 3v4M9.5 12h.01M14.5 12h.01" />
      </>
    ),
    search: (
      <>
        <circle cx="11" cy="11" r="6" />
        <path d="m20 20-4.5-4.5" />
      </>
    ),
    check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
    chevron: <path d="m7 10 5 5 5-5" />,
    plus: <path d="M12 5v14M5 12h14" />,
    inbox: (
      <>
        <path d="M4 13h4l1.5 3h5L16 13h4" />
        <path d="M5.5 6h13L20 13v5H4v-5z" />
      </>
    ),
    slack: (
      <>
        <path d="M9 3v18M15 3v18M3 9h18M3 15h18" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="8" />
        <path d="M12 8v4.5l3 2" />
      </>
    ),
    code: <path d="m9 7-5 5 5 5M15 7l5 5-5 5" />,
    branch: (
      <>
        <circle cx="7" cy="5.5" r="2" />
        <circle cx="7" cy="18.5" r="2" />
        <circle cx="17" cy="8" r="2" />
        <path d="M7 7.5v9M17 10c0 4-10 2-10 6.5" />
      </>
    ),
  };
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={"shrink-0 " + className}
    >
      {paths[name]}
    </svg>
  );
}

/// Who does a stage, in a few words.
function stageDoer(stage: ProcessStage, teamName: (id?: string) => string | undefined, workerName: (id?: string) => string | undefined): string {
  if (stage.kind === "team") return teamName(stage.teamId) ?? (stage.teamId ? "A team that's gone" : "Pick a team");
  if (stage.kind === "worker") return workerName(stage.workerId) ?? (stage.workerId ? "A worker that's gone" : "Pick a worker");
  const names = [...(stage.approverGroups ?? []).map((g) => g.name), ...(stage.approvers ?? []).map((p) => p.name)];
  return names.join(", ") || "Who decides?";
}


// ---- PICKER --------------------------------------------------------------

/// A team's face: its initials on a tile, where a worker's is a round avatar.
function TeamFace({ name, size = "md" }: { name: string; size?: "sm" | "md" }) {
  return (
    <span
      aria-hidden
      className={
        "flex shrink-0 items-center justify-center rounded-lg bg-accent/15 font-semibold text-accent " +
        (size === "md" ? "h-8 w-8 text-[11px]" : "h-6 w-6 text-[10px]")
      }
    >
      {workerInitials(name)}
    </span>
  );
}

/// Pick who does a stage: each option says what it does, the best fits for
/// this stage come first with the words they share, and a box narrows it.
/// The console's picker, in React.
function DoerPicker({
  label,
  options,
  current,
  stageText,
  roleHint,
  face,
  onPick,
}: {
  /// "Pick a team" / "Pick a worker".
  label: string;
  options: DoerOption[];
  current?: string;
  /// What the stage is about, from `stageMatchText`.
  stageText: string;
  /// Who does the stage, as the picture it was drafted from says, shown
  /// while nobody is picked.
  roleHint?: string;
  face: (o: DoerOption) => ReactNode;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const ranked = useMemo(() => rankDoers(options, stageText), [options, stageText]);
  const good = useMemo(() => goodMatches(ranked), [ranked]);
  const sections = useMemo(() => pickerSections(ranked, query), [ranked, query]);
  const chosen = options.find((o) => o.id === current);
  const gone = !!current && !chosen;

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", outside);
    search.current?.focus();
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);

  const close = () => {
    setOpen(false);
    setQuery("");
    button.current?.focus();
  };
  const optionEls = () => Array.from(list.current?.querySelectorAll<HTMLButtonElement>("[role=option]") ?? []);
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      const first = optionEls()[0];
      if (first) {
        e.preventDefault();
        first.focus();
      }
    } else if (e.key === "Enter") {
      const first = sections[0]?.rows[0];
      if (first) {
        e.preventDefault();
        onPick(first.option.id);
        close();
      }
    }
  };
  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = optionEls();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown" && at < all.length - 1) {
      e.preventDefault();
      all[at + 1].focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (at > 0) all[at - 1].focus();
      else search.current?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  const row = (r: RankedDoer, why: boolean) => {
    const on = r.option.id === current;
    return (
      <button
        key={r.option.id}
        type="button"
        role="option"
        aria-selected={on}
        onClick={() => {
          onPick(r.option.id);
          close();
        }}
        className={
          "flex w-full items-start gap-3 rounded-md px-2.5 py-2 text-left focus:outline-none " +
          (on ? "bg-accent/15" : "hover:bg-card-strong focus:bg-card-strong")
        }
      >
        {face(r.option)}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[13px] font-semibold text-ink">{r.option.name}</span>
          {(r.option.about || r.option.paused) && (
            <span className="line-clamp-2 text-xs leading-snug text-ink-muted">
              {r.option.paused ? `Paused${r.option.about ? " · " : ""}` : ""}
              {r.option.about}
            </span>
          )}
          {why && r.hits.length > 0 && (
            <span className="flex items-center gap-1 text-[11.5px] text-emerald-700 dark:text-emerald-300">
              <Glyph name="check" size={11} />
              Fits: {r.hits.slice(0, 4).join(", ")}
            </span>
          )}
        </span>
        {on && <Glyph name="check" size={14} className="mt-0.5 text-accent" />}
      </button>
    );
  };

  return (
    <div ref={wrap} className="relative max-w-xl">
      <button
        ref={button}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => (open ? close() : setOpen(true))}
        className="flex min-h-[52px] w-full items-center gap-3 rounded-lg border border-card-strong bg-surface px-3 py-2 text-left hover:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        {chosen ? (
          face(chosen)
        ) : (
          <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-dashed border-card-strong text-ink-faint">
            <Glyph name="plus" size={15} />
          </span>
        )}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className={"truncate text-[13px] font-semibold " + (gone ? "text-red-700 dark:text-red-300" : "text-ink")}>
            {chosen ? chosen.name : gone ? "One that's gone. Pick another" : label}
          </span>
          <span className="line-clamp-2 text-xs leading-snug text-ink-muted">
            {chosen
              ? chosen.about
              : (roleHint ? `The picture says: ${roleHint}. ` : "") +
                (good.length ? `${good.length} good ${good.length === 1 ? "match" : "matches"} for this stage` : "See what each one does")}
          </span>
        </span>
        <Glyph name="chevron" size={14} className="text-ink-faint" />
      </button>
      {open && (
        <div className="absolute left-0 top-[calc(100%+6px)] z-30 flex w-full min-w-[min(460px,80vw)] flex-col rounded-xl border border-card-strong bg-surface-elevated shadow-2xl">
          <div className="flex items-center gap-2 border-b border-card px-3 py-2 text-ink-faint">
            <Glyph name="search" size={14} />
            <input
              ref={search}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKey}
              aria-label="Search"
              autoComplete="off"
              placeholder="Search by name or what it does"
              className="min-w-0 flex-1 bg-transparent py-1 text-[13px] text-ink outline-none placeholder:text-ink-faint"
            />
          </div>
          <div ref={list} role="listbox" aria-label={label} onKeyDown={onListKey} className="max-h-[380px] overflow-y-auto p-1">
            {sections.length === 0 ? (
              <p className="m-2.5 text-xs text-ink-faint">Nothing matches &ldquo;{query.trim()}&rdquo;.</p>
            ) : (
              sections.map((sec) => (
                <div key={sec.label} className="flex flex-col">
                  <div className={sectionLabel + " px-2.5 pb-1 pt-2"}>{sec.label}</div>
                  {sec.rows.map((r) => row(r, sec.why))}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- EDITOR --------------------------------------------------------------

/// One labelled row of the stage form: the label on the left, the control
/// and its one muted line on the right.
function FormRow({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-2 py-2 sm:grid-cols-[120px_minmax(0,1fr)] sm:gap-4">
      <span className="text-[13px] font-semibold text-ink-muted sm:pt-2">{label}</span>
      <div className="flex min-w-0 flex-col gap-1">
        {children}
        {hint && <span className="text-[11.5px] leading-relaxed text-ink-faint">{hint}</span>}
      </div>
    </div>
  );
}

function ProcessEditor({
  id,
  from,
  picture,
  resume,
  onClose,
  onLibrary,
}: {
  id: string | null;
  /// A library process to start from.
  from?: string;
  /// A draft read from a picture, to check before it's saved.
  picture?: PictureStart;
  /// The editor as it was before "Make this team" left it.
  resume?: EditorSnapshot;
  onClose: () => void;
  onLibrary: () => void;
}) {
  const teams = useLocalTeams();
  const { list: workers, byId: workersById } = useLocalWorkers();
  const teamIds = useMemo(() => new Set(teams.map((t) => t.id)), [teams]);
  const workerIds = useMemo(() => new Set(workers.map((w) => w.id)), [workers]);
  const teamName = (teamId?: string) => teams.find((t) => t.id === teamId)?.name;
  const workerName = (workerId?: string) => workers.find((w) => w.id === workerId)?.name;
  const teamOpts = useMemo(() => teamOptions(teams), [teams]);
  const workerOpts = useMemo(() => workerOptions(workers), [workers]);
  const showProcesses = useWorkersStore((s) => s.showProcesses);
  const openTeamEditor = useWorkersStore((s) => s.openTeamEditor);
  const [draft] = useState(() => {
    if (resume) return null;
    if (picture) return pictureEditorDraft(picture.draft);
    const p = from ? libraryProcess(from) : undefined;
    return p ? libraryDraft(p, teams) : null;
  });
  /// Who does each stage in the picture, by stage id, when none of yours
  /// clearly fit: a hint in its doer picker.
  const roles: Record<string, string> = draft && "roles" in draft ? draft.roles : {};
  const [pictureOpen, setPictureOpen] = useState(false);
  const [existing, setExisting] = useState<ProcessDef | null>(resume?.existing ?? null);
  const [loading, setLoading] = useState(!!id && !resume);
  const [name, setName] = useState(resume?.name ?? draft?.name ?? "");
  const [purpose, setPurpose] = useState(resume?.purpose ?? draft?.purpose ?? "");
  const [shortName, setShortName] = useState(resume?.shortName ?? "");
  /// Carried through a save: what the library said it's for, and which one.
  const [about, setAbout] = useState(resume ? resume.about : draft && "about" in draft ? draft.about : undefined);
  const [templateId, setTemplateId] = useState(resume ? resume.templateId : draft && "templateId" in draft ? draft.templateId : undefined);
  const [stages, setStages] = useState<ProcessStage[]>(() => resume?.stages ?? draft?.stages ?? [newStage("team")]);
  /// The stage open below the map.
  const [sel, setSel] = useState(resume?.sel ?? 0);
  /// The stage whose "More" rows were opened; a stage whose rows aren't at
  /// their defaults shows them anyway.
  const [moreFor, setMoreFor] = useState<string | null>(null);
  /// Where the code lives, for a process whose stages change code.
  const [codeIn, setCodeIn] = useState<{ name: string; path: string } | null>(resume?.codeIn ?? null);
  const [places, setPlaces] = useState<Array<{ name: string; path: string; kind: "workspace" | "project" }> | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id || resume) return;
    void getProcess(id).then((res) => {
      setLoading(false);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setExisting(res.process);
      setName(res.process.name);
      // Its initials are used while the box is empty: they stay automatic.
      setShortName(res.process.shortNameAuto ? "" : (res.process.shortName ?? ""));
      setPurpose(res.process.purpose ?? "");
      setAbout(res.process.about);
      setTemplateId(res.process.templateId);
      setStages(res.process.stages);
      setCodeIn(res.process.codeIn ?? null);
    });
  }, [id, resume]);

  const at = Math.max(0, Math.min(sel, stages.length - 1));
  const cur = stages[at];
  const patch = (i: number, change: Partial<ProcessStage>) =>
    setStages((prev) => prev.map((s, n) => (n === i ? { ...s, ...change } : s)));
  const add = (kind: ProcessStage["kind"]) => {
    setStages((p) => [...p, newStage(kind, kind === "team" ? "New team stage" : kind === "worker" ? "New worker stage" : "New decision")]);
    setSel(stages.length);
  };
  const setKind = (k: ProcessStage["kind"]) =>
    // Only a team or worker stage waits or repeats.
    patch(
      at,
      k === "people"
        ? { kind: k, approvers: cur.approvers?.length ? cur.approvers : [DESKTOP_PERSON], delayDays: undefined, repeat: undefined }
        : { kind: k, mode: undefined, fields: undefined },
    );
  const missing = stages.map((s, i) => ({ s, i })).filter((x) => !stageReady(x.s, teamIds, workerIds));
  const fromLibrary = cur ? libraryStageFor(templateId, cur.id) : undefined;
  const roleHint = cur ? roles[cur.id] : undefined;
  const stageText = cur ? `${stageMatchText(cur, fromLibrary)}${roleHint ? ` ${roleHint}` : ""}` : "";
  const showMore = !!cur && (moreFor === cur.id || !stageMoreAtDefaults(cur));
  const changesCode = !!(templateId && libraryProcess(templateId)?.changesCode);
  useEffect(() => {
    void window.overcli.invoke("processes:places").then(setPlaces);
  }, []);

  /// Leave for the team editor with a brief for this stage's team, and
  /// come back to this editor as it is.
  const makeTeam = () => {
    if (!cur) return;
    resumeEditor = { existing, name, shortName, purpose, about, templateId, stages, sel: at, codeIn };
    openTeamEditor(null, fromLibrary ? teamBriefFor(fromLibrary, name || "this process") : `A team for the "${cur.name}" stage. ${cur.ask ?? ""}`.trim());
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    // `about` and `templateId` keep the library link, so the editor can
    // show what each stage needs when it's opened again.
    const payload = {
      ...(existing ? { id: existing.id } : {}),
      name,
      shortName,
      ...(purpose.trim() ? { purpose } : {}),
      ...(about ? { about } : {}),
      ...(templateId ? { templateId } : {}),
      codeIn,
      stages: stages.map((s) => (s.ask?.trim() ? s : (({ ask: _a, ...rest }) => rest)(s))),
    };
    const res = await window.overcli.invoke("processes:save", payload);
    setSaving(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onClose();
    showProcesses(res.process.id);
  };

  const retire = async () => {
    if (!existing) return;
    if (!window.confirm(`Retire ${existing.name}? Items that finished stay in its history.`)) return;
    const res = await window.overcli.invoke("processes:archive", { id: existing.id });
    if (!res.ok) setError(res.error);
    else showProcesses(null);
  };

  if (loading) return <div className="px-6 pt-6 text-sm text-ink-muted">Loading the process…</div>;

  const doerFace = (kind: "team" | "worker") => (o: DoerOption) => {
    const w = kind === "worker" ? workersById[o.id] : undefined;
    return w ? <WorkerAvatar worker={w} size="md" /> : <TeamFace name={o.name} />;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-6">
        <div className="flex flex-col gap-5">
          <header className="flex flex-col gap-0.5">
            <div className="text-xs text-ink-faint">
              <button className="hover:text-ink" onClick={onClose}>
                Processes
              </button>{" "}
              / {existing ? existing.name : picture ? "New process, from a picture" : "New process"}
            </div>
            <label htmlFor="process-name" className="sr-only">
              Process name
            </label>
            <input
              id="process-name"
              value={name}
              autoFocus={!existing && !resume}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name the process"
              className="-ml-1.5 mt-1 rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-[28px] font-semibold leading-tight tracking-tight text-ink outline-none placeholder:font-normal placeholder:italic placeholder:text-ink-faint hover:border-card focus:border-accent focus:bg-surface-elevated"
            />
            <label htmlFor="process-purpose" className="sr-only">
              What it's for
            </label>
            <input
              id="process-purpose"
              value={purpose}
              maxLength={300}
              onChange={(e) => setPurpose(e.target.value)}
              placeholder="What it takes in and what comes out"
              className="-ml-1.5 rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-sm text-ink-muted outline-none placeholder:italic placeholder:text-ink-faint hover:border-card focus:border-accent focus:bg-surface-elevated"
            />
            <span className="mt-1.5">
              <ShortNameField id="process-short" value={shortName} name={name} command="/idea" onChange={setShortName} />
            </span>
            <span className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-ink-faint">
              <span className="flex items-center gap-1.5">
                <Glyph name="person" size={12} />
                Owned by you
              </span>
              <label className="flex items-center gap-2">
                <Glyph name="code" size={12} />
                Code lives in
                <select
                  aria-label="Code lives in"
                  value={codeIn?.path ?? ""}
                  onChange={(e) => {
                    const hit = places?.find((p) => p.path === e.target.value);
                    setCodeIn(hit ? { name: hit.name, path: hit.path } : null);
                  }}
                  className="field w-auto max-w-[260px] px-2 py-1 text-xs text-ink"
                >
                  <option value="">Each stage in its own place</option>
                  {codeIn && !places?.some((p) => p.path === codeIn.path) && <option value={codeIn.path}>{codeIn.name}</option>}
                  {(["workspace", "project"] as const).map((kind) => {
                    const list = (places ?? []).filter((p) => p.kind === kind);
                    return list.length ? (
                      <optgroup key={kind} label={kind === "workspace" ? "Workspaces" : "Projects"}>
                        {list.map((p) => (
                          <option key={p.path} value={p.path}>
                            {p.name}
                          </option>
                        ))}
                      </optgroup>
                    ) : null;
                  })}
                </select>
              </label>
              {changesCode && !codeIn && (
                <span className="flex items-center gap-2">
                  <span className="rounded-full bg-amber-400/15 px-2 py-px text-[11px] font-semibold text-amber-700 dark:text-amber-300">Pick one</span>
                  <span>so a build, its tests and its release are one change</span>
                </span>
              )}
            </span>
          </header>

          {picture && !existing && <PictureBanner start={picture} open={pictureOpen} onToggle={() => setPictureOpen((o) => !o)} />}

          <section aria-label="The process map" className="flex flex-col gap-3.5 rounded-xl border border-card bg-surface-elevated px-[18px] py-4">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className={sectionLabel + " flex-1"}>The flow</span>
              {(["team", "worker", "people"] as const).map((k) => (
                <span key={k} className="flex items-center gap-1.5 text-[11.5px] text-ink-muted">
                  <span className={KIND_LOOK[k].key} />
                  {k === "team" ? "A team" : k === "worker" ? "A worker" : "You decide"}
                </span>
              ))}
              <span className="flex items-center gap-1.5 text-[11.5px] text-ink-muted">
                <span className="h-2 w-2 rounded-full bg-red-400" />
                Needs setting up
              </span>
            </div>
            {teams.length === 0 && workers.length === 0 && (
              <div className="text-xs text-amber-700 dark:text-amber-300">
                You have no teams or workers yet. A team or worker stage needs one: hire a worker or make a team first, or use decisions only for now.
              </div>
            )}
            {/* The board's flow strip, editable: cards share the width and
                wrap rather than scrolling sideways. */}
            <ol className="flex flex-wrap items-stretch gap-y-2" aria-label="Stages in order">
              {stages.map((s, i) => {
                const look = KIND_LOOK[s.kind];
                const ready = stageReady(s, teamIds, workerIds);
                const on = i === at;
                const timing = s.kind === "people" ? `↩ Back to ${sendBackName(stages, i)}` : timingText(s);
                return (
                  <li key={s.id} className="flex min-w-[160px] max-w-[280px] flex-1 items-center">
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() => setSel(i)}
                      className={
                        "flex min-w-0 flex-1 flex-col gap-[3px] self-stretch rounded-[10px] border-[1.5px] px-3 py-2.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 " +
                        (s.kind === "people" ? "border-dashed " : "") +
                        (on ? look.flowOn : look.flow)
                      }
                    >
                      <span className="flex items-center gap-2">
                        <span className={"flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold " + (on ? look.num : "bg-card-strong text-ink-muted")}>
                          {i + 1}
                        </span>
                        <span className={"text-[10.5px] font-bold uppercase tracking-wider " + look.text}>{STAGE_KIND_LABEL[s.kind]}</span>
                        {!ready && <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-red-400" title="Needs setting up" aria-label="Needs setting up" />}
                      </span>
                      <span className="truncate text-[13.5px] font-semibold text-ink">{s.name || "Unnamed stage"}</span>
                      <span className={"truncate text-xs " + (ready ? "text-ink-faint" : "text-red-700 dark:text-red-300")}>{stageDoer(s, teamName, workerName)}</span>
                      {timing && (
                        <span className={"flex min-w-0 items-center gap-1 text-[11.5px] " + (s.kind === "people" ? "text-amber-700/80 dark:text-amber-300/80" : "text-ink-faint")} title={timing}>
                          {s.kind !== "people" && <Glyph name="clock" size={11} />}
                          <span className="truncate">{timing}</span>
                        </span>
                      )}
                    </button>
                    {i < stages.length - 1 && <FlowArrow />}
                  </li>
                );
              })}
            </ol>
            <div className="flex flex-wrap items-center gap-2">
              <button className={secondaryBtn} onClick={() => add("team")}>
                + Team stage
              </button>
              <button className={secondaryBtn} onClick={() => add("worker")}>
                + Worker stage
              </button>
              <button className={secondaryBtn} onClick={() => add("people")}>
                + Decision
              </button>
            </div>
          </section>

          <div className="flex flex-wrap items-start gap-[18px]">
            <section aria-label="The stage you picked" className="min-w-0 flex-[999_1_520px] rounded-xl border border-card bg-surface-elevated">
              {!cur ? (
                <div className="flex flex-col items-start gap-2 px-[18px] py-7">
                  <span className="text-sm font-semibold text-ink">No stages yet</span>
                  <span className="text-sm text-ink-muted">Add a stage above, or start from a process in the library.</span>
                  {!existing && (
                    <button className={secondaryBtn} onClick={onLibrary}>
                      Browse the process library
                    </button>
                  )}
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-3 border-b border-card px-[18px] py-3">
                    <span className={"flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[13px] font-bold " + KIND_LOOK[cur.kind].num}>{at + 1}</span>
                    <label htmlFor="stage-name" className="sr-only">
                      Stage name
                    </label>
                    <input
                      id="stage-name"
                      value={cur.name}
                      onChange={(e) => patch(at, { name: e.target.value })}
                      placeholder={cur.kind === "people" ? "e.g. Validate and approve" : "e.g. Prototype"}
                      className="min-w-0 flex-[1_1_200px] rounded-md border border-transparent bg-transparent px-1.5 py-1 text-base font-semibold text-ink outline-none hover:border-card focus:border-accent"
                    />
                    <span role="group" aria-label="Who does this stage" className="flex rounded-lg border border-card bg-surface p-0.5">
                      {(["team", "worker", "people"] as const).map((k) => (
                        <button
                          key={k}
                          type="button"
                          aria-pressed={cur.kind === k}
                          onClick={() => setKind(k)}
                          className={"rounded-md px-2.5 py-1 text-xs font-medium " + (cur.kind === k ? "bg-card-strong text-ink" : "text-ink-muted hover:text-ink")}
                        >
                          {k === "team" ? "A team" : k === "worker" ? "A worker" : "You decide"}
                        </button>
                      ))}
                    </span>
                    <span className="flex shrink-0 items-center">
                      <button
                        className={quietBtn}
                        disabled={at === 0}
                        aria-label="Move earlier"
                        title="Move earlier"
                        onClick={() => {
                          setStages((p) => moveStage(p, at, -1));
                          setSel(at - 1);
                        }}
                      >
                        ←
                      </button>
                      <button
                        className={quietBtn}
                        disabled={at === stages.length - 1}
                        aria-label="Move later"
                        title="Move later"
                        onClick={() => {
                          setStages((p) => moveStage(p, at, 1));
                          setSel(at + 1);
                        }}
                      >
                        →
                      </button>
                      <button className={quietBtn} aria-label="Remove this stage" title="Remove this stage" onClick={() => setStages((p) => removeStage(p, at))}>
                        ×
                      </button>
                    </span>
                  </div>
                  {cur.why && (
                    <p className="m-0 border-b border-card bg-surface px-[18px] py-3 text-[13px] leading-relaxed text-ink-muted">
                      <b className="font-semibold text-ink">Why this stage. </b>
                      {cur.why}
                    </p>
                  )}
                  <div className="flex flex-col px-[18px] pb-3 pt-1.5">
                    {cur.kind === "team" || cur.kind === "worker" ? (
                      <>
                        <FormRow
                          label={cur.kind === "team" ? "Team" : "Worker"}
                          hint={
                            cur.kind === "team"
                              ? "Briefed with this stage's job and everything earlier stages produced."
                              : "Asked to do this stage on its own: for a step one worker can handle."
                          }
                        >
                          {cur.kind === "team" ? (
                            teamOpts.length ? (
                              <DoerPicker
                                key={`team:${cur.id}`}
                                label="Pick a team"
                                options={teamOpts}
                                current={cur.teamId}
                                stageText={stageText}
                                roleHint={roleHint}
                                face={doerFace("team")}
                                onPick={(teamId) => patch(at, { teamId })}
                              />
                            ) : (
                              <span className="flex flex-wrap items-center gap-2 pt-1.5 text-sm text-ink-muted">
                                No teams yet.
                                <button className={secondaryBtn} onClick={makeTeam}>
                                  Make a team
                                </button>
                              </span>
                            )
                          ) : workerOpts.length ? (
                            <DoerPicker
                              key={`worker:${cur.id}`}
                              label="Pick a worker"
                              options={workerOpts}
                              current={cur.workerId}
                              stageText={stageText}
                              roleHint={roleHint}
                              face={doerFace("worker")}
                              onPick={(workerId) => patch(at, { workerId })}
                            />
                          ) : (
                            <span className="pt-1.5 text-sm text-ink-muted">No workers yet. Hire one from the Workers rail.</span>
                          )}
                        </FormRow>
                        {cur.kind === "team" && !cur.teamId && fromLibrary?.crew?.length ? (
                          <FormRow label="">
                            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-400/10 px-2.5 py-2 text-[13px] text-ink">
                              <span className="min-w-0 flex-1">None of your teams fits yet. It needs: {fromLibrary.crew.join(", ")}.</span>
                              <button className={secondaryBtn} onClick={makeTeam}>
                                Make this team
                              </button>
                            </div>
                          </FormRow>
                        ) : null}
                        <FormRow
                          label="Lead"
                          hint={
                            (cur.kind === "team" ? "Answers its questions, approves its plan and signs off its pack." : "Answers its questions and approves what it does.") +
                            (fromLibrary ? ` Usually the ${fromLibrary.who.toLowerCase()}.` : "")
                          }
                        >
                          <span className="flex items-center gap-2 pt-1 text-[13px] text-ink">
                            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-card-strong text-ink-muted">
                              <Glyph name="person" size={13} />
                            </span>
                            You
                          </span>
                        </FormRow>
                        <FormRow label="The job" hint="Goes in the brief.">
                          <textarea
                            rows={3}
                            aria-label="This stage's job"
                            value={cur.ask ?? ""}
                            onChange={(e) => patch(at, { ask: e.target.value })}
                            placeholder="What this stage should produce."
                            className="field max-w-xl resize-y px-2.5 py-2 text-[13px] leading-relaxed text-ink"
                          />
                        </FormRow>
                        {showMore && (
                          <>
                        <FormRow
                          label="Timing"
                          hint="Wait until there's something to look at, or run it several times before it moves on."
                        >
                          <span className="flex flex-wrap items-center gap-2">
                            <select
                              aria-label="When it starts"
                              value={cur.delayDays ?? 0}
                              onChange={(e) => patch(at, { delayDays: Number(e.target.value) || undefined })}
                              className="field px-2 py-1.5 text-xs"
                            >
                              {delayOptions(cur.delayDays).map((o) => (
                                <option key={o.value} value={o.value}>
                                  {o.label}
                                </option>
                              ))}
                            </select>
                            <select
                              aria-label="How many times it runs"
                              value={repeatKey(cur.repeat)}
                              onChange={(e) => patch(at, { repeat: repeatFromKey(e.target.value) })}
                              className="field px-2 py-1.5 text-xs"
                            >
                              {repeatOptions(cur.repeat).map((o) => (
                                <option key={o.value} value={o.value}>
                                  {o.label}
                                </option>
                              ))}
                            </select>
                          </span>
                        </FormRow>
                          </>
                        )}
                        {showMore ? null : (
                          <button
                            type="button"
                            className="mt-1 flex items-center gap-1 self-start text-xs text-ink-faint hover:text-ink"
                            aria-expanded={false}
                            onClick={() => setMoreFor(cur.id)}
                          >
                            <Glyph name="chevron" size={12} />
                            More: when it starts and how often it runs
                          </button>
                        )}
                      </>
                    ) : (
                      <>
                        <FormRow
                          label={cur.mode === "input" ? "Who fills it in" : "Who decides"}
                          hint={
                            (roleHint ? `The picture says: ${roleHint}. ` : "") +
                            (fromLibrary ? `Usually the ${fromLibrary.who.toLowerCase()}. Here it's you.` : "Here it's you. Published to your org, they're asked in Slack.")
                          }
                        >
                          <span className="flex flex-wrap items-center gap-1.5 pt-1">
                            {(cur.approvers ?? []).map((p, n) => (
                              <span key={p.name + n} className="flex items-center gap-1.5 rounded-full border border-card-strong bg-surface py-0.5 pl-1 pr-2 text-xs text-ink">
                                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-amber-400/20 text-amber-700 dark:text-amber-300">
                                  <Glyph name="person" size={11} />
                                </span>
                                {p.name}
                                <button
                                  className="text-ink-faint hover:text-ink"
                                  aria-label={`Remove ${p.name}`}
                                  onClick={() => patch(at, { approvers: (cur.approvers ?? []).filter((_, k) => k !== n) })}
                                >
                                  ×
                                </button>
                              </span>
                            ))}
                            {!(cur.approvers ?? []).some((p) => p.name === DESKTOP_PERSON.name) && (
                              <button className={quietBtn} onClick={() => patch(at, { approvers: [DESKTOP_PERSON, ...(cur.approvers ?? [])] })}>
                                + You
                              </button>
                            )}
                            <input
                              aria-label="Add someone who decides"
                              placeholder="Add a name, then Enter"
                              className="field w-[200px] px-2 py-1 text-xs"
                              onKeyDown={(e) => {
                                const v = e.currentTarget.value.trim();
                                if (e.key !== "Enter" || !v) return;
                                patch(at, { approvers: [...(cur.approvers ?? []), { name: v }] });
                                e.currentTarget.value = "";
                              }}
                            />
                          </span>
                        </FormRow>
                        <FormRow label="Look for">
                          <textarea
                            rows={3}
                            aria-label="What to look for when deciding"
                            value={cur.ask ?? ""}
                            onChange={(e) => patch(at, { ask: e.target.value })}
                            placeholder="What makes it worth going on."
                            className="field max-w-xl resize-y px-2.5 py-2 text-[13px] leading-relaxed text-ink"
                          />
                        </FormRow>
                        <FormRow label="Asks for" hint="What they fill in is handed on to every stage after: a budget, the segment, what they think.">
                          <StageAsksEditor stage={cur} onChange={(p) => patch(at, p)} />
                        </FormRow>
                        {showMore && (
                          <>
                        <FormRow label="Send back to" hint="Briefed with what you say needs to change.">
                          <select
                            aria-label="Send back goes to"
                            value={cur.sendBackTo ?? ""}
                            onChange={(e) => patch(at, e.target.value ? { sendBackTo: e.target.value } : { sendBackTo: undefined })}
                            className="field w-auto max-w-[280px] px-2 py-1.5 text-xs"
                          >
                            <option value="">The stage before</option>
                            {stages
                              .slice(0, at)
                              .filter((x) => x.kind !== "people")
                              .map((x) => (
                                <option key={x.id} value={x.id}>
                                  {x.name || "Unnamed stage"}
                                </option>
                              ))}
                          </select>
                        </FormRow>
                          </>
                        )}
                        {showMore ? null : (
                          <button
                            type="button"
                            className="mt-1 flex items-center gap-1 self-start text-xs text-ink-faint hover:text-ink"
                            aria-expanded={false}
                            onClick={() => setMoreFor(cur.id)}
                          >
                            <Glyph name="chevron" size={12} />
                            More: where send back goes
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </>
              )}
            </section>

            <aside className="flex min-w-0 max-w-[400px] flex-[1_1_280px] flex-col gap-3.5 rounded-xl border border-card bg-surface-elevated px-[18px] py-4">
              <div className="flex flex-col gap-2.5">
                <span className={sectionLabel}>Ready to make?</span>
                <span className="flex items-center gap-2.5">
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-card-strong">
                    <span
                      className="block h-full rounded-full bg-accent"
                      style={{ width: `${stages.length ? Math.round(((stages.length - missing.length) / stages.length) * 100) : 0}%` }}
                    />
                  </span>
                  <span className="shrink-0 text-xs text-ink-muted">
                    {stages.length - missing.length} of {stages.length} set
                  </span>
                </span>
                {missing.length > 0 && (
                  <ul className="flex flex-col gap-1.5">
                    {missing.slice(0, 6).map(({ s, i }) => (
                      <li key={s.id} className="flex items-center gap-2 text-[13px]">
                        <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-red-400" />
                        <button className="truncate text-left text-ink hover:underline" onClick={() => setSel(i)}>
                          {i + 1}. {s.name || "Unnamed stage"}: {stageMissing(s)}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {about && (
                <div className="flex flex-col gap-1.5 border-t border-card pt-3.5">
                  <span className={sectionLabel}>When to use it</span>
                  <p className="m-0 text-[13px] leading-relaxed text-ink">{about}</p>
                </div>
              )}
              <div className="flex flex-col gap-2 border-t border-card pt-3.5">
                <span className={sectionLabel}>How an item moves</span>
                <ol className="list-decimal space-y-1.5 pl-[18px] text-[13px] text-ink-muted">
                  <li>A team stage ends when you sign off its pack.</li>
                  <li>A worker stage ends when the worker answers and any work it started is done.</li>
                  <li>A decision ends when you approve it.</li>
                  <li>You can move, restart or stop any item.</li>
                </ol>
              </div>
            </aside>
          </div>

          {error && (
            <div role="alert" className="text-xs text-red-700 dark:text-red-300">
              {error}
            </div>
          )}
        </div>
      </div>
      {picture && pictureOpen && <PictureViewer image={picture.image} onClose={() => setPictureOpen(false)} />}
      </div>
      <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-card px-6 py-3">
        <span className="flex items-center gap-3">
          {existing && (
            <button className={quietBtn + " text-red-700 dark:text-red-300"} onClick={() => void retire()}>
              Retire process
            </button>
          )}
          <span className="text-xs text-ink-faint">
            {!stages.length
              ? "Add a stage to start."
              : missing.length
                ? `${missing.length} ${missing.length === 1 ? "stage needs" : "stages need"} setting up before items can run.`
                : "Every stage is set."}
          </span>
        </span>
        <span className="flex items-center gap-2">
          <button className={quietBtn} onClick={onClose}>
            Cancel
          </button>
          <button className={primaryBtn} disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : existing ? "Save changes" : "Create process"}
          </button>
        </span>
      </footer>
    </div>
  );
}

// ---- THE PROCESS PAGE ----------------------------------------------------
// One process: its name and a summary line, "How it works" drawn as a flow,
// then either how to start one and what happened lately (nothing in
// flight) or the board, each item under the stage it's at.

/// The colour a stage's segment of an item's track is drawn in.
const TRACK_INK: Record<TrackStep, (kind: ProcessStage["kind"]) => string> = {
  done: () => "bg-emerald-400",
  now: (kind) => KIND_LOOK[kind].bar,
  stuck: () => "bg-red-400",
  ahead: () => "bg-card-strong",
};

/// Whether "How it works" is open above the board: open the first time,
/// then as you left it.
const FLOW_OPEN_KEY = "overcli.processPage.flowOpen";

function readFlowOpen(): boolean {
  try {
    return window.localStorage.getItem(FLOW_OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

function writeFlowOpen(open: boolean) {
  try {
    window.localStorage.setItem(FLOW_OPEN_KEY, open ? "1" : "0");
  } catch {
    // Not kept; it opens again next time.
  }
}

const FILTERS: Array<[BoardFilter, string]> = [
  ["all", "All"],
  ["you", "Waiting on you"],
  ["stuck", "Stuck"],
  ["mine", "Mine"],
];

function ProcessBoard({ id, onEdit }: { id: string; onEdit: () => void }) {
  const showProcesses = useWorkersStore((s) => s.showProcesses);
  const orgAlpha = useStore((s) => s.settings.orgAlpha ?? false);
  const slackOn = useStore((s) => s.settings.slackEnabled ?? false);
  const openSheet = useStore((s) => s.openSheet);
  const { list: workers } = useLocalWorkers();
  const [board, setBoard] = useState<Board | null>(null);
  const [intake, setIntake] = useState<Intake | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openItem, setOpenItem] = useState<string | null>(() => useWorkersStore.getState().selectedProcessItemId);
  // An item asked for from outside the board (a Today row): open it, once.
  const pickedItem = useWorkersStore((s) => s.selectedProcessItemId);
  useEffect(() => {
    if (!pickedItem) return;
    setOpenItem(pickedItem);
    useWorkersStore.getState().clearProcessItemPick();
  }, [pickedItem]);
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState<BoardFilter>("all");
  const [flowOpen, setFlowOpen] = useState(readFlowOpen);
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState<{ ok: boolean; text: string; signIn?: boolean } | null>(null);

  const load = useCallback(() => {
    void getProcess(id).then((res) => {
      if (res.ok) {
        setBoard(res);
        setError(null);
      } else setError(res.error);
    });
  }, [id]);
  useRefresh(load);
  const loadIntake = useCallback(() => {
    void getIntake(id).then(setIntake);
  }, [id]);
  useEffect(loadIntake, [loadIntake]);

  const stages = board?.process.stages;
  const items = board?.items;
  const times = useMemo(() => (stages && items ? stageDurations(items, stages) : []), [stages, items]);
  const selectTeam = useWorkersStore((s) => s.selectTeam);
  const selectWorker = useWorkersStore((s) => s.selectWorker);
  // A stage's team or worker opens on its own page from the diagram.
  const openDoer = (s: ProcessStage) => {
    if (s.kind === "team" && s.teamId) selectTeam(s.teamId);
    else if (s.kind === "worker" && s.workerId) selectWorker(s.workerId);
  };

  if (!board) {
    return <div className="px-6 pt-6 text-sm text-ink-muted">{error ?? "Loading the process…"}</div>;
  }
  const { process, teams } = board;
  const all = board.items;
  const teamName = (teamId?: string) => teams.find((t) => t.id === teamId)?.name;
  const workerName = (workerId?: string) => (board.workers ?? workers).find((w) => w.id === workerId)?.name;
  const doer = (s: ProcessStage) => stageDoer(s, teamName, workerName);
  const stats = pageStats(all);
  const counts = filterCounts(all);
  const busy = stats.inFlight > 0;
  const selected = openItem ? all.find((i) => i.id === openItem) : undefined;
  const first = process.stages[0];
  const n = process.stages.length;
  const recent = recentFinished(all);
  const whole = endToEnd(all, process.stages);
  const ways = waysInShort(intake, slackOn);

  // One item picked: it takes the whole pane, with the process name to come back.
  if (selected) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <ProcessItemPage key={selected.id} processId={process.id} itemId={selected.id} onOpenProcess={() => {
          setOpenItem(null);
          load();
        }} />
      </div>
    );
  }

  const openOne = (itemId: string) => setOpenItem(itemId);
  const toggleFlow = () => {
    setFlowOpen((v) => {
      writeFlowOpen(!v);
      return !v;
    });
  };
  const flowHead = (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <span className={sectionLabel + " flex-1"}>
        How it works · {n} {n === 1 ? "stage" : "stages"}
      </span>
      <FlowLegend />
    </div>
  );
  const flow = <ProcessFlow stages={process.stages} doer={doer} onOpenDoer={openDoer} times={times} waysIn={ways} />;
  // The board's columns line up under the flow's stage cards: same grid,
  // same side padding as the flow's card.
  const sidePad = "px-[18px]";
  const shown = filterItems(all, filter);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <main className="flex min-w-0 flex-col gap-5 px-7 pb-10 pt-6">
          <header className="flex flex-wrap items-start gap-3.5">
            <div className="flex min-w-0 flex-[1_1_520px] flex-col gap-1">
              <button className="self-start text-xs text-ink-faint hover:text-ink" onClick={() => showProcesses(null)}>
                Processes
              </button>
              <div className="flex min-w-0 items-baseline gap-2.5">
                <h1 className="truncate text-2xl font-semibold tracking-tight text-ink">{process.name}</h1>
                {process.shortName && <ShortNameChip command="/idea" short={process.shortName} />}
              </div>
              {process.purpose && <div className="max-w-3xl text-[13px] text-ink-muted">{process.purpose}</div>}
              {!busy && (
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[12.5px] text-ink-faint">
                  {quietSummary(process.owner, stats, waysInPhrase(intake, slackOn)).map((t) => (
                    <span key={t}>{t}</span>
                  ))}
                  {process.codeIn && (
                    <span className="flex items-center gap-1" title={process.codeIn.path}>
                      <Glyph name="code" size={12} />
                      Code: {process.codeIn.name}
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {process.canSteer && (
                <button className={secondaryBtn} onClick={onEdit}>
                  Edit
                </button>
              )}
              {busy && (
                <button className={secondaryBtn} aria-expanded={flowOpen} onClick={toggleFlow}>
                  How it works
                </button>
              )}
              {/* The org's server: its teams have to be there first; published
                  again, it's updated there. */}
              {orgAlpha && (
                <button
                  className={secondaryBtn}
                  disabled={publishing}
                  title="Put this process on your org's server, where people can put work into it from the console or Slack. Publish its teams first."
                  onClick={() => {
                    setPublishing(true);
                    setPublished(null);
                    void window.overcli
                      .invoke("org:publishProcess", { id: process.id })
                      .then((res) => setPublished(res.ok ? { ok: true, text: res.message } : { ok: false, text: res.error, signIn: res.signIn }))
                      .finally(() => setPublishing(false));
                  }}
                >
                  {publishing ? "Publishing…" : "Publish to my org"}
                </button>
              )}
              {busy && (
                <button className={primaryBtn + " flex items-center gap-1.5"} disabled={!first} onClick={() => setAdding(true)}>
                  <Glyph name="plus" size={13} />
                  Put something in
                </button>
              )}
            </div>
          </header>
          {published && (
            <div role="status" className={"-mt-2 flex items-center gap-2 text-[11.5px] " + (published.ok ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300")}>
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
          {error && <div className="-mt-2 text-xs text-red-700 dark:text-red-300">{error}</div>}

          {!busy ? (
            <>
              <section aria-label="How it works" className="flex flex-col gap-3.5 rounded-xl border border-card bg-surface-elevated px-[18px] py-4">
                {flowHead}
                <div className="overflow-x-auto">{flow}</div>
                <ol className="m-0 grid list-none gap-3.5 border-t border-card p-0 pt-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))" }}>
                  {process.stages.map((s, i) => (
                    <li key={s.id} className="flex min-w-0 flex-col gap-0.5">
                      <b className="text-[12.5px] font-semibold text-ink">
                        {i + 1} · {s.name}
                      </b>
                      <span className="text-[12.5px] leading-relaxed text-ink-muted">{stageSentence(s, process.templateId) || timingText(s) || `${STAGE_KIND_LABEL[s.kind]}: ${flowWho(s, doer)}.`}</span>
                    </li>
                  ))}
                </ol>
              </section>

              <div className="grid items-start gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(380px, 100%), 1fr))" }}>
                <PutInCard
                  processId={process.id}
                  processName={process.name}
                  shortName={process.shortName}
                  first={first}
                  firstWho={first ? flowWho(first, doer) : ""}
                  canSteer={process.canSteer}
                  slackOn={slackOn}
                  intake={intake}
                  onIntakeChanged={loadIntake}
                  onPut={(itemId) => {
                    setOpenItem(itemId);
                    load();
                  }}
                />
                <section aria-label="Recent" className="flex flex-col gap-3 rounded-xl border border-card bg-surface-elevated px-[18px] py-4">
                  <span className={sectionLabel}>Recent · last 30 days</span>
                  {recent.length === 0 ? (
                    <p className="m-0 text-[12.5px] text-ink-faint">Nothing has finished or been stopped in the last 30 days.</p>
                  ) : (
                    recent.slice(0, 5).map((item) => <RecentCard key={item.id} item={item} stages={process.stages} onOpen={() => openOne(item.id)} track />)
                  )}
                  <TimeSpent items={all} stages={process.stages} />
                </section>
              </div>
            </>
          ) : (
            <>
              <div className="-mt-1 flex flex-wrap items-baseline gap-x-[22px] gap-y-1 text-[13px] text-ink-muted">
                <span>
                  <b className="text-[17px] font-semibold text-ink">{stats.inFlight}</b> in flight
                </span>
                <span>
                  <b className={"text-[17px] font-semibold " + (stats.waiting ? "text-amber-700 dark:text-amber-300" : "text-ink-faint")}>{stats.waiting}</b> waiting on you
                </span>
                <span>
                  <b className={"text-[17px] font-semibold " + (stats.stuck ? "text-red-700 dark:text-red-300" : "text-ink-faint")}>{stats.stuck}</b> stuck
                </span>
                <span>
                  <b className={"text-[17px] font-semibold " + (stats.done30 ? "text-emerald-700 dark:text-emerald-300" : "text-ink-faint")}>{stats.done30}</b> done in 30 days
                </span>
                {whole && (
                  <span className="text-ink-faint">
                    usually {durationWords(whole.typicalMs)} end to end{whole.slowest ? ` · most of it at ${whole.slowest}` : ""}
                  </span>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <span className={sectionLabel + " flex-1"}>The board · each item sits under the stage it's at</span>
                <span role="group" aria-label="Show" className="inline-flex gap-0.5 rounded-lg border border-card p-0.5">
                  {FILTERS.map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={filter === key}
                      onClick={() => setFilter(key)}
                      className={"rounded-md px-2.5 py-1 text-xs font-semibold " + (filter === key ? "bg-card-strong text-ink" : "text-ink-faint hover:text-ink")}
                    >
                      {label} {counts[key]}
                    </button>
                  ))}
                </span>
              </div>

              <div className="overflow-x-auto">
                <div className="flex flex-col gap-3" style={{ minWidth: flowMinWidth(n) + 38 }}>
                  {flowOpen && (
                    <section aria-label="How it works" className="flex flex-col gap-3.5 rounded-xl border border-card bg-surface-elevated px-[18px] py-4">
                      {flowHead}
                      {flow}
                    </section>
                  )}
                  <div className={"grid border border-transparent " + sidePad} style={{ gridTemplateColumns: flowColumns(n), columnGap: FLOW_GAP }}>
                    <div aria-hidden />
                    {process.stages.map((s, i) => (
                      <StageColumn
                        key={s.id}
                        stage={s}
                        index={i}
                        who={flowWho(s, doer)}
                        time={stageTimeWords(times[i])}
                        items={shown.filter((it) => it.stageIndex === i)}
                        onOpen={openOne}
                      />
                    ))}
                    <div aria-hidden />
                  </div>
                </div>
              </div>
              {shown.length === 0 && filter !== "all" && (
                <p className="-mt-2 m-0 text-[12.5px] text-ink-faint">
                  {filter === "you" ? "Nothing is waiting on you." : filter === "stuck" ? "Nothing is stuck." : "Nothing you put in is in flight."}{" "}
                  <button className="text-accent hover:underline" onClick={() => setFilter("all")}>
                    Show all
                  </button>
                </p>
              )}

              {recent.length > 0 && (
                <section aria-label="Finished recently" className="flex flex-col gap-2">
                  <span className={sectionLabel}>Finished recently · {recent.length}</span>
                  <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(300px, 100%), 1fr))" }}>
                    {recent.slice(0, 9).map((item) => (
                      <RecentCard key={item.id} item={item} stages={process.stages} onOpen={() => openOne(item.id)} />
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </main>
      </div>
      {adding && (
        <SubmitSheet
          processId={process.id}
          processName={process.name}
          firstStage={first ? `${first.name} (${doer(first)})` : ""}
          onDone={(itemId) => {
            setAdding(false);
            if (itemId) {
              setOpenItem(itemId);
              load();
            }
          }}
        />
      )}
    </div>
  );
}

/// One stage's column on the board: who and how long it usually takes,
/// then the items at it.
function StageColumn({
  stage,
  index,
  who,
  time,
  items,
  onOpen,
}: {
  stage: ProcessStage;
  index: number;
  who: string;
  time: string;
  items: ProcessItemView[];
  onOpen: (id: string) => void;
}) {
  const now = Date.now();
  return (
    <section
      aria-label={stage.name}
      className={
        "flex min-h-[220px] min-w-0 flex-col gap-2 rounded-xl border bg-surface-elevated p-3 " +
        (stage.kind === "people" ? "border-dashed border-amber-400/40" : "border-card")
      }
    >
      <div className="flex flex-col gap-0.5 border-b border-card pb-2.5">
        <span className="flex items-center gap-2">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-card-strong text-[11px] font-bold text-ink-muted">{index + 1}</span>
          <span className={"rounded-full px-[7px] py-px text-[10px] font-bold uppercase tracking-wider " + FLOW_KIND_PILL[stage.kind]}>{STAGE_KIND_LABEL[stage.kind]}</span>
          <span className="flex-1" />
          <span className={"text-xs " + (items.length ? "text-ink" : "text-ink-faint")}>{items.length}</span>
        </span>
        <b className="truncate text-[13.5px] font-semibold text-ink" title={stage.name}>
          {stage.name}
        </b>
        <span className="truncate text-xs text-ink-faint" title={[who, time].filter(Boolean).join(" · ")}>
          {[who, time].filter(Boolean).join(" · ")}
        </span>
      </div>
      {items.length === 0 ? (
        <span className="px-0.5 py-2 text-xs text-ink-faint/70">Nothing here</span>
      ) : (
        items.map((item) => {
          const tone = itemTone(item);
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onOpen(item.id)}
              className={
                "flex min-w-0 cursor-pointer flex-col gap-[3px] rounded-[9px] border px-3 py-2.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 " +
                (tone === "you"
                  ? "border-amber-400/40 bg-amber-400/[0.08] hover:border-amber-400/70"
                  : tone === "stuck"
                    ? "border-red-400/40 bg-red-400/[0.08] hover:border-red-400/70"
                    : "border-card-strong bg-surface hover:border-accent/60")
              }
            >
              <b className="line-clamp-2 text-[13px] font-semibold text-ink">{item.title}</b>
              <span className={"line-clamp-2 text-xs " + (tone === "you" ? "text-amber-700 dark:text-amber-300" : tone === "stuck" ? "text-red-700 dark:text-red-300" : "text-ink-muted")}>
                {nowLine(item, stage)}
              </span>
              <span className="truncate text-[11.5px] text-ink-faint">
                {itemOrigin(item)} · {shortSpan(now - item.createdAt)}
              </span>
            </button>
          );
        })
      )}
    </section>
  );
}

/// A finished or stopped item: its state, when, and what came of it.
function RecentCard({ item, stages, onOpen, track = false }: { item: ProcessItemView; stages: ProcessStage[]; onOpen: () => void; track?: boolean }) {
  const steps = recentTrack(item, stages.length);
  const done = item.status === "done";
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex min-w-0 cursor-pointer flex-col gap-1.5 rounded-[10px] border border-card bg-surface px-3.5 py-3 text-left hover:border-accent/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
    >
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        {!track && <StateChip done={done} />}
        <b className={"min-w-0 truncate font-semibold text-ink " + (track ? "text-[13.5px]" : "order-last basis-full text-[13px]")}>{item.title}</b>
        {track && <StateChip done={done} />}
        <span className="text-xs text-ink-faint">{startedWords(item.finishedAt ?? item.updatedAt)}</span>
      </span>
      {track && (
        <span className="grid gap-[3px]" style={{ gridTemplateColumns: `repeat(${Math.max(1, stages.length)}, minmax(0, 1fr))` }} aria-hidden>
          {steps.map((t, i) => (
            <span key={i} className={"h-1 rounded-sm " + TRACK_INK[t](stages[i]?.kind ?? "team")} />
          ))}
        </span>
      )}
      <span className={"line-clamp-2 " + (track ? "text-[12.5px] text-ink-muted" : "text-xs text-ink-muted")}>{outcomeLine(item, stages)}</span>
    </button>
  );
}

function StateChip({ done }: { done: boolean }) {
  return (
    <span className={"shrink-0 rounded-full px-2 py-px text-[11px] font-bold " + (done ? "bg-emerald-400/15 text-emerald-700 dark:text-emerald-300" : "bg-card-strong text-ink-muted")}>
      {done ? "Done" : "Stopped"}
    </span>
  );
}

/// "Where items spend their time": a bar per stage once enough have made
/// it through, else what it will show.
function TimeSpent({ items, stages }: { items: ProcessItemView[]; stages: ProcessStage[] }) {
  const bars = timeBars(items, stages);
  return (
    <div className="flex flex-col gap-1.5 border-t border-card pt-3">
      <span className="text-xs text-ink-muted">Where items spend their time</span>
      {!bars ? (
        <span className="text-[12.5px] text-ink-faint">After a few items finish, this shows which stage they wait in longest and how long the whole thing usually takes.</span>
      ) : (
        bars.map((b) => (
          <span key={b.stage.id} className="grid items-center gap-2.5 text-xs" style={{ gridTemplateColumns: "minmax(90px, 0.9fr) 2fr 52px" }}>
            <span className="truncate text-ink-muted">{b.stage.name}</span>
            <span className="h-1.5 overflow-hidden rounded-full bg-card-strong">
              <span className={"block h-full rounded-full " + KIND_LOOK[b.stage.kind].bar} style={{ width: `${Math.max(2, Math.round(b.share * 100))}%` }} />
            </span>
            <span className="text-right text-ink-faint">{b.ms ? shortSpan(b.ms) : "–"}</span>
          </span>
        ))
      )}
    </div>
  );
}

/// "Put something in", on the page itself while nothing is in flight: a
/// title and details, straight into the first stage; and the other ways in.
function PutInCard({
  processId,
  processName,
  shortName,
  first,
  firstWho,
  canSteer,
  slackOn,
  intake,
  onIntakeChanged,
  onPut,
}: {
  processId: string;
  processName: string;
  shortName?: string;
  first: ProcessStage | undefined;
  firstWho: string;
  canSteer: boolean;
  slackOn: boolean;
  intake: Intake | null;
  onIntakeChanged: () => void;
  onPut: (itemId: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addWay, setAddWay] = useState(false);
  const body = brief.trim() || title.trim();
  const ready = !!first && body.length >= 3 && !busy;
  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    const res = await window.overcli.invoke("processes:submit", { processId, ...(title.trim() ? { title: title.trim() } : {}), brief: body });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else onPut(res.item.id);
  };
  const way = (key: string, dot: string, what: string, detail: string, bad = false) => (
    <div key={key} className="flex min-w-0 items-center gap-2.5">
      <span aria-hidden className={"h-2 w-2 shrink-0 rounded-full " + dot} />
      <span className="min-w-0 flex-1 truncate text-[13px] text-ink" title={what}>
        {what}
      </span>
      <span className={"shrink-0 text-xs " + (bad ? "text-red-700 dark:text-red-300" : "text-ink-faint")}>{detail}</span>
    </div>
  );
  return (
    <section aria-label="Put something in" className="flex flex-col gap-3 rounded-xl border border-card-strong bg-surface-elevated px-[18px] py-4">
      <span className={sectionLabel + " text-accent"}>Put something in</span>
      <label className="flex flex-col gap-1.5">
        <span className="text-[12.5px] text-ink-muted">Title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="A short title, e.g. Export fails over 10k rows" className="field px-3 py-2 text-sm" />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-[12.5px] text-ink-muted">Details, steps, a ticket link</span>
        <textarea
          rows={3}
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
          }}
          placeholder="Anything the first stage should know."
          className="field resize-y px-3 py-2 text-[13px] leading-relaxed"
        />
      </label>
      {error && <div className="text-xs text-red-700 dark:text-red-300">{error}</div>}
      <div className="flex flex-wrap items-center gap-2.5">
        <button className={primaryBtn} disabled={!ready} onClick={() => void submit()}>
          {busy ? "Putting it in…" : first ? `Start at ${first.name}` : "Add a stage first"}
        </button>
        {first && (
          <span className="text-xs text-ink-faint">
            {first.kind === "people" ? `${firstWho} decide${firstWho === DESKTOP_PERSON.name ? "" : "s"} first.` : `${firstWho} picks it up.`}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-2 border-t border-card pt-3">
        <span className="text-xs text-ink-muted">Other ways in</span>
        {way("page", "bg-accent", "This page", "anyone who can see it")}
        {slackOn && way("slack", "bg-violet-400", shortName ? `/idea ${shortName} … in Slack, or starting with “${processName}:”` : `/idea in Slack, starting with “${processName}:”`, "anyone in the org")}
        {(intake?.watches ?? []).map((w) =>
          way(
            `w:${w.id}`,
            "bg-emerald-400",
            `Watch on ${w.server}: ${w.tool}`,
            w.lastError ? "not working" : `every ${w.everyMinutes} min${w.lastFiredAt ? ` · last one ${relativeTime(w.lastFiredAt)}` : ""}`,
            !!w.lastError,
          ),
        )}
        {(intake?.schedules ?? []).map((s) => way(`s:${s.id}`, "bg-sky-400", s.title, s.when))}
        {canSteer && !addWay && (
          <button className="self-start text-[12.5px] font-semibold text-accent hover:underline" onClick={() => setAddWay(true)}>
            Add a way in: a schedule or a tool watch
          </button>
        )}
        {addWay && (
          <div className="-mx-[18px] -mb-4 mt-1 border-t border-card">
            <IntakePanel processId={processId} processName={processName} shortName={shortName} canSteer={canSteer} slackOn={slackOn} onChanged={onIntakeChanged} bare />
            <div className="px-4 pb-3">
              <button className={quietBtn} onClick={() => setAddWay(false)}>
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

/// The arrow between two stages on the flow strip and the editor's map.
function FlowArrow() {
  return (
    <svg aria-hidden width="22" height="12" viewBox="0 0 22 12" fill="none" className="shrink-0 text-card-strong">
      <path d="M1 6h17M14 2l5 4-5 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}


/// "Put something in", as a sheet over the board.
function SubmitSheet({
  processId,
  processName,
  firstStage,
  onDone,
}: {
  processId: string;
  processName: string;
  firstStage: string;
  onDone: (itemId?: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onDone();
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onDone]);
  const submit = async () => {
    setBusy(true);
    setError(null);
    const res = await window.overcli.invoke("processes:submit", { processId, ...(title.trim() ? { title } : {}), brief });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else onDone(res.item.id);
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={() => onDone()}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="process-submit-title"
        onClick={(e) => e.stopPropagation()}
        className="flex w-[min(580px,100%)] flex-col overflow-hidden rounded-xl border border-card-strong bg-surface-elevated shadow-2xl"
      >
        <header className="flex items-start gap-3 border-b border-card px-5 py-4">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 id="process-submit-title" className="text-base font-semibold text-ink">
              Put something in
            </h2>
            <span className="truncate text-xs text-ink-muted">{processName}</span>
          </div>
          <button className={quietBtn} aria-label="Close" onClick={() => onDone()}>
            ×
          </button>
        </header>
        <div className="flex flex-col gap-4 px-5 py-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-semibold text-ink-muted">Title</span>
            <input
              value={title}
              autoFocus
              onChange={(e) => setTitle(e.target.value)}
              placeholder="A short title, e.g. One-step sign-up for Acme Notes"
              className="field px-2.5 py-1.5 text-sm"
            />
            <span className="text-[11.5px] text-ink-faint">Optional. Left blank, it's made from what you write below.</span>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-semibold text-ink-muted">What it is</span>
            <textarea
              rows={6}
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && brief.trim().length >= 3 && !busy) void submit();
              }}
              placeholder="The idea, the request or the problem, and anything the first stage should know."
              className="field resize-y px-2.5 py-2 text-sm leading-relaxed"
            />
          </label>
          {error && <div className="text-xs text-red-700 dark:text-red-300">{error}</div>}
        </div>
        <footer className="flex items-center justify-between gap-3 border-t border-card px-5 py-3">
          <span className="min-w-0 truncate text-xs text-ink-faint">{firstStage ? `It starts at ${firstStage}.` : ""}</span>
          <span className="flex shrink-0 items-center gap-2">
            <button className={quietBtn} onClick={() => onDone()}>
              Cancel
            </button>
            <button className={primaryBtn} disabled={busy || brief.trim().length < 3} onClick={() => void submit()}>
              {busy ? "Putting it in…" : "Put it in"}
            </button>
          </span>
        </footer>
      </section>
    </div>
  );
}


// ---- WAYS IN -------------------------------------------------------------

type Intake = Awaited<ReturnType<typeof getIntake>>;

function getIntake(id: string) {
  return window.overcli.invoke("processes:intake", { id });
}

function fmtWhen(t: number): string {
  return Number.isFinite(t)
    ? new Date(t).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "never";
}

/// How work comes in besides by hand: Slack, each schedule, each tool
/// watch, and adding another. The console's panel, on the desktop.
function IntakePanel({
  processId,
  processName,
  shortName,
  canSteer,
  slackOn,
  onChanged,
  bare = false,
}: {
  processId: string;
  processName: string;
  shortName?: string;
  canSteer: boolean;
  slackOn: boolean;
  /// Told after a way in is added or removed, so a summary of them can catch up.
  onChanged?: () => void;
  /// Inside another card: no border or heading of its own.
  bare?: boolean;
}) {
  const [intake, setIntake] = useState<Intake | null>(null);
  const [adding, setAdding] = useState<"schedule" | "watch" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    void getIntake(processId).then((next) => {
      setIntake(next);
      onChanged?.();
    });
  }, [processId, onChanged]);
  useEffect(load, [load]);

  const remove = async (run: () => Promise<{ ok: true } | { ok: false; error: string }>) => {
    setError(null);
    const res = await run();
    if (!res.ok) setError(res.error);
    load();
  };
  const done = () => {
    setAdding(null);
    load();
  };

  const way = (icon: "slack" | "clock" | "search" | "plus", key: string, title: ReactNode, sub: ReactNode, action?: ReactNode, bad = false) => (
    <div key={key} className="flex items-start gap-3 border-t border-card px-4 py-3 first:border-t-0">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-card-strong text-ink-muted">
        <Glyph name={icon} size={15} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[13px] font-semibold text-ink">{title}</span>
        <span className={"text-xs leading-relaxed " + (bad ? "text-red-700 dark:text-red-300" : "text-ink-muted")}>{sub}</span>
      </span>
      {action}
    </div>
  );
  const removeBtn = (label: string, run: () => Promise<{ ok: true } | { ok: false; error: string }>) =>
    canSteer ? (
      <button className={quietBtn + " shrink-0"} aria-label={label} onClick={() => void remove(run)}>
        Remove
      </button>
    ) : null;

  return (
    <section aria-label="How work comes in" className={"flex flex-col " + (bare ? "" : "rounded-xl border border-card bg-surface-elevated")}>
      {!bare && (
        <div className="flex items-center gap-2 border-b border-card px-4 py-2.5">
          <span className={sectionLabel + " flex-1"}>How work comes in</span>
        </div>
      )}
      <div className="flex flex-col">
        {way("plus", "page", "This page", "Put something in, above.")}
        {way(
          "slack",
          "slack",
          slackOn ? "Slack" : "Slack (off)",
          slackOn ? (
            <>
              {shortName && (
                <>
                  <code>/idea {shortName} …</code>,{" "}
                </>
              )}
              <code>/idea {processName}: …</code> or <code>@overgo idea: …</code>. <code>/idea</code> alone shows where yours are.
            </>
          ) : (
            <>
              Turn Slack on in Settings and you can send one in with <code>/idea {shortName ? `${shortName} …` : `${processName}: …`}</code>
            </>
          ),
        )}
        {(intake?.schedules ?? []).map((sch) =>
          way(
            "clock",
            `sch:${sch.id}`,
            sch.title,
            `${sch.when}. Next: ${fmtWhen(sch.nextAt)}.`,
            removeBtn(`Remove ${sch.title}`, () => window.overcli.invoke("processes:removeSchedule", { id: processId, scheduleId: sch.id })),
          ),
        )}
        {(intake?.watches ?? []).map((w) =>
          way(
            "search",
            `watch:${w.id}`,
            `New items in ${w.server}`,
            w.lastError ?? `${w.tool}, checked every ${w.everyMinutes} min. ${w.lastFiredAt ? `Last one ${relativeTime(w.lastFiredAt)}.` : "Nothing yet."}`,
            removeBtn(`Stop watching ${w.server}`, () => window.overcli.invoke("processes:removeWatch", { triggerId: w.id })),
            !!w.lastError,
          ),
        )}
      </div>
      {canSteer && (
        <div className="flex flex-col gap-3 border-t border-card px-4 py-3">
          {adding === "schedule" ? (
            <ScheduleForm processId={processId} onDone={done} onCancel={() => setAdding(null)} />
          ) : adding === "watch" ? (
            <WatchForm processId={processId} onDone={done} onCancel={() => setAdding(null)} />
          ) : (
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-ink-faint">Add a way in:</span>
              <button className={secondaryBtn + " flex items-center gap-1.5"} onClick={() => setAdding("schedule")}>
                <Glyph name="clock" size={13} />
                On a schedule
              </button>
              <button className={secondaryBtn + " flex items-center gap-1.5"} onClick={() => setAdding("watch")}>
                <Glyph name="search" size={13} />
                Watch a tool
              </button>
            </span>
          )}
        </div>
      )}
      {error && (
        <div role="alert" className="px-4 pb-3 text-xs text-red-700 dark:text-red-300">
          {error}
        </div>
      )}
    </section>
  );
}

/// "Every quarter, plan the roadmap": when, and the item each one puts in.
function ScheduleForm({ processId, onDone, onCancel }: { processId: string; onDone: () => void; onCancel: () => void }) {
  const [preset, setPreset] = useState<SchedulePreset>("weekly");
  const [day, setDay] = useState(1);
  const [time, setTime] = useState("09:00");
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    const res = await window.overcli.invoke("processes:addSchedule", { id: processId, cadence: scheduleCadence(preset, time, day), title, brief });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else onDone();
  };
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-card bg-surface p-3">
      <span className="text-[13px] font-semibold text-ink">Start an item on a schedule</span>
      <span className="flex flex-wrap items-center gap-2 text-xs text-ink-faint">
        <select aria-label="When" value={preset} onChange={(e) => setPreset(e.target.value as SchedulePreset)} className="field px-2 py-1.5 text-xs">
          {SCHEDULE_PRESETS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {preset === "weekly" && (
          <>
            on
            <select aria-label="On" value={day} onChange={(e) => setDay(Number(e.target.value))} className="field px-2 py-1.5 text-xs">
              {DAY_NAMES.map((n, i) => (
                <option key={n} value={i}>
                  {n}
                </option>
              ))}
            </select>
          </>
        )}
        at
        <input type="time" aria-label="At" value={time} onChange={(e) => setTime(e.target.value)} className="field w-[120px] px-2 py-1 text-xs" />
      </span>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-semibold text-ink-muted">Each one is called</span>
        <input value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Quarterly roadmap" className="field px-2.5 py-1.5 text-xs" />
        <span className="text-[11.5px] text-ink-faint">The date is added: &ldquo;Quarterly roadmap · Jan 1, 2027&rdquo;.</span>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-semibold text-ink-muted">What each one is about</span>
        <textarea
          rows={3}
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder="What the first stage should do each time, e.g. Plan next quarter's roadmap from this quarter's requests, usage and churn."
          className="field resize-y px-2.5 py-2 text-xs leading-relaxed"
        />
      </label>
      {error && <div className="text-xs text-red-700 dark:text-red-300">{error}</div>}
      <span className="flex items-center gap-2">
        <button className={primaryBtn} disabled={busy} onClick={() => void save()}>
          {busy ? "Adding…" : "Add the schedule"}
        </button>
        <button className={quietBtn} onClick={onCancel}>
          Cancel
        </button>
      </span>
    </div>
  );
}

/// Each new item a tool returns (a ticket in a view, a row) goes in, tried
/// before it's saved.
function WatchForm({ processId, onDone, onCancel }: { processId: string; onDone: () => void; onCancel: () => void }) {
  const [tools, setTools] = useState<string[] | null>(null);
  const [server, setServer] = useState("");
  const [calls, setCalls] = useState<{ ok: true; tools: Array<{ name: string; description?: string }> } | { ok: false; error: string } | null>(null);
  const [tool, setTool] = useState("");
  const [args, setArgs] = useState("");
  const [every, setEvery] = useState(15);
  const [note, setNote] = useState("");
  const [tried, setTried] = useState<{ ok: true; items: Array<{ id: string; title: string }> } | { ok: false; error: string } | null>(null);
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.overcli.invoke("processes:tools").then(setTools);
  }, []);
  useEffect(() => {
    setCalls(null);
    setTool("");
    if (!server) return;
    let live = true;
    void window.overcli.invoke("processes:toolCalls", { server }).then((r) => {
      if (!live) return;
      setCalls(r);
      if (r.ok && r.tools[0]) setTool(r.tools[0].name);
    });
    return () => {
      live = false;
    };
  }, [server]);

  const parsed = parseWatchArgs(args);
  const test = async () => {
    setTried(null);
    if (!parsed) {
      setTried({ ok: false, error: "The arguments aren't valid JSON." });
      return;
    }
    setBusy("test");
    setTried(await window.overcli.invoke("processes:testWatch", { server, tool, args: parsed }));
    setBusy(null);
  };
  const save = async () => {
    setError(null);
    if (!parsed) {
      setError("The arguments aren't valid JSON.");
      return;
    }
    setBusy("save");
    const res = await window.overcli.invoke("processes:addWatch", {
      id: processId,
      server,
      tool,
      args: parsed,
      everyMinutes: every,
      ...(note.trim() ? { instructions: note.trim() } : {}),
    });
    setBusy(null);
    if (!res.ok) setError(res.error);
    else onDone();
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-card bg-surface p-3">
      <span className="text-[13px] font-semibold text-ink">Put in each new item a tool finds</span>
      <span className="flex flex-wrap items-center gap-2">
        <select aria-label="Tool" value={server} onChange={(e) => setServer(e.target.value)} className="field min-w-[160px] px-2 py-1.5 text-xs">
          {tools === null ? (
            <option value="">Loading tools…</option>
          ) : tools.length === 0 ? (
            <option value="">No tools installed</option>
          ) : (
            <>
              <option value="">Pick a tool</option>
              {tools.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </>
          )}
        </select>
        <select aria-label="What to ask it" value={tool} onChange={(e) => setTool(e.target.value)} disabled={!calls?.ok} className="field min-w-[160px] px-2 py-1.5 text-xs">
          {!server ? (
            <option value="">Pick a tool first</option>
          ) : !calls ? (
            <option value="">Loading…</option>
          ) : !calls.ok ? (
            <option value="">{calls.error}</option>
          ) : (
            calls.tools.map((t) => (
              <option key={t.name} value={t.name} title={t.description}>
                {t.name}
              </option>
            ))
          )}
        </select>
        <select aria-label="How often" value={every} onChange={(e) => setEvery(Number(e.target.value))} className="field px-2 py-1.5 text-xs">
          {[5, 10, 15, 30, 60].map((n) => (
            <option key={n} value={n}>
              every {n} min
            </option>
          ))}
        </select>
      </span>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-semibold text-ink-muted">With (JSON)</span>
        <textarea
          rows={3}
          value={args}
          onChange={(e) => setArgs(e.target.value)}
          placeholder='{ "jql": "project = ACME AND type = Bug AND created >= -1d" }'
          className={"field resize-y px-2.5 py-2 font-mono text-[11.5px] " + (parsed ? "" : "border-red-400/60")}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-semibold text-ink-muted">Add to each brief</span>
        <textarea
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Optional: what the first stage should know about every item from here."
          className="field resize-y px-2.5 py-2 text-xs leading-relaxed"
        />
      </label>
      {tried && (
        <div aria-live="polite" className="text-xs">
          {tried.ok ? (
            <>
              <p className="m-0 text-ink-muted">
                It sees {tried.items.length} {tried.items.length === 1 ? "item" : "items"} now. These are skipped; each new one after goes in.
              </p>
              {tried.items.length > 0 && (
                <ul className="mt-1.5 list-disc pl-[18px] text-ink">
                  {tried.items.slice(0, 6).map((i) => (
                    <li key={i.id}>{i.title}</li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <span className="text-red-700 dark:text-red-300">{tried.error}</span>
          )}
        </div>
      )}
      {error && <div className="text-xs text-red-700 dark:text-red-300">{error}</div>}
      <span className="flex flex-wrap items-center gap-2">
        <button className={secondaryBtn} disabled={!!busy || !server || !tool} onClick={() => void test()}>
          {busy === "test" ? "Asking the tool…" : "Try it now"}
        </button>
        <button className={primaryBtn} disabled={!!busy || !server || !tool} onClick={() => void save()}>
          {busy === "save" ? "Saving…" : "Start watching"}
        </button>
        <button className={quietBtn} onClick={onCancel}>
          Cancel
        </button>
      </span>
    </div>
  );
}
