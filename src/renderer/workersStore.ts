// Renderer mirror of the worker engine, plus the hire/edit draft. Main owns
// every decision — when a shift fires, what the scorecard says, whether a
// save is valid — and pushes whole records via `workerUpdate`; this store is
// a mirror plus the form state. `nextShiftAt` and the scorecard are never
// computed here for the same reason `nextFireAt` isn't in schedulesStore:
// two implementations would disagree.

import { create } from 'zustand';

import { useFlowsStore } from './flowsStore';

import type { Attachment, Backend, UUID } from '@shared/types';
import { flowProjectPath, type Flow } from '@shared/flows/schema';
import { moveInRoster, placeInRoster } from '@shared/flows/worker';
import { isEverydayProject } from '@shared/everydayProjects';
import { allocateTreasury, fundingFor, type Treasury, type TreasuryAllocation } from '@shared/flows/treasury';
import type {
  Worker,
  WorkerCaps,
  WorkerContract,
  WorkerErrandResult,
  WorkerJournalEntry,
  WorkerMessageIntent,
  WorkerScorecard,
  WorkerTrustLevel,
} from '@shared/flows/worker';
import type { PortableWorker } from '@shared/flows/workerYaml';
import type { ScheduleTrigger } from '@shared/flows/schedule';

export interface WorkerDraft {
  id?: UUID;
  name: string;
  /// The one-line "what this is" under the name on the roster. Blank is
  /// allowed — the roster falls back to the job description's opening.
  tagline?: string;
  jobDescription: string;
  projectPath: string;
  cadence: ScheduleTrigger;
  caps: WorkerCaps;
  budgetUSDPerMonth: number;
  heartbeatModel: string;
  heartbeatBackend?: Backend;
  flowIds: string[];
  enabled: boolean;
  /// Narrowed handoff targets. Absent/empty means every colleague on the
  /// same project, which is the default the editor writes.
  delegatesTo?: UUID[];
}

interface WorkersState {
  loaded: boolean;
  workers: Record<string, Worker>;
  nextShiftAt: Record<string, number | null>;
  scorecards: Record<string, WorkerScorecard>;
  /// Journals load lazily per worker (they're read from disk in main).
  journals: Record<string, WorkerJournalEntry[]>;
  /// Live shift state per worker: present while a planning turn is running,
  /// carrying its streamed text and tool invocations. Cleared when the shift
  /// settles — driven entirely by main's events, never inferred here.
  shiftProgress: Record<string, { text: string; tools: string[]; task: 'shift' | 'errand' }>;
  /// Per-worker errand state. Desk composers are independent of the global
  /// editor busy flag and retain a no-launch result until dismissed.
  errandBusy: Record<string, boolean>;
  /// The errand currently in flight, per worker. The timeline is derived from
  /// orchestration batches, and a batch does not exist until the planning turn
  /// finishes — which can be minutes. Without this the message you just sent
  /// simply isn't on screen until the reply lands. Chat solves the same problem
  /// with an optimistic `localUser` event; this is that, scoped to a desk.
  /// A LIST, not one record: errands queue behind whatever the worker is
  /// doing, so two sent in a row are both in flight from your side and both
  /// have to be on screen. One overwriting the other looked like the first
  /// message vanished.
  errandSending: Record<string, Array<{ id: string; text: string; intent: WorkerMessageIntent; at: number }>>;
  /// Each worker's own directory, learned when its Files tab loads. The file
  /// editor is scoped to it so opening one worker's file cannot walk up into
  /// the others — they are all siblings under userData.
  filesRoot: Record<string, string>;
  errandError: Record<string, string>;
  errandResult: Record<string, WorkerErrandResult>;
  draft: WorkerDraft | null;
  /// A flow riding along with the draft: hire-drafted (new), or AI-revised
  /// (an existing flow with unsaved changes). Persisted only when the worker
  /// itself saves — cancelling the editor discards both together.
  draftedFlow: Flow | null;
  /// The hire drafter's prose read on the job, shown above the editor.
  hireSummary: string | null;
  /// Why the hire came back without a flow, when it asked for one and the
  /// flow drafter failed. Shown under the (empty) flow picker so the gap is
  /// explained rather than left for the user to discover on Hire.
  hireFlowError: string | null;
  /// Which worker the Workers pane is showing. The Workers sidebar is the
  /// roster and this is its selection — the same master/detail split the Chat
  /// and Flows tabs use, so a worker's shifts, errands and replies have a full
  /// pane to render in instead of expanding inside a sidebar row.
  selectedWorkerId: string | null;
  /// The monthly pool, and the waterfall it produces across the roster. Both
  /// are pushed by main; `allocation` is only ever re-derived here mid-drag,
  /// so a reorder shows the money move before the round trip lands.
  treasury: Treasury | null;
  allocation: TreasuryAllocation | null;
  /// The Workers pane shows the selected worker's desk, or one of the four
  /// roster-wide screens. Those four are peers of the selection rather than
  /// part of it — each is about every worker at once, so none has a worker to
  /// be the selection of, and picking anyone from them must land you on their
  /// desk.
  ///
  /// `queue` is the tab's landing page, and deliberately not `worker`. The
  /// other three answer what is coming (calendar), what it cost (funds) and
  /// what it came to (report); nothing answered NOW, so the tab opened on
  /// whichever worker happened to be hired first — an accident of sort order
  /// standing in for a front page.
  view: 'queue' | 'worker' | 'calendar' | 'funds' | 'report';
  /// Bumped every time a worker is picked from the roster, including a pick
  /// of the one already on screen. The pane keys the worker's screen on it, so
  /// clicking a name lands on that worker's desk rather than on whichever tab
  /// you happened to leave it on — "show me this worker" means the front of
  /// the worker, not the fifth tab of the last one.
  selectSeq: number;
  /// One turn to open when the desk mounts, set by arriving from somewhere
  /// that already knows which turn you meant — clicking a past shift on the
  /// calendar. The desk shows one DAY, so a link into it has to carry the
  /// day too; `at` is what puts the desk on the right date instead of on
  /// today, where the turn isn't.
  deskFocus: { workerId: string; orchestrationId: string; at: number } | null;
  /// Render the Workers tab as if nobody had been hired, without firing
  /// anyone. Session-only and never persisted: it exists so the empty state
  /// can be LOOKED at — the one screen you cannot reach once the feature is
  /// working, and therefore the one that rots. Gated behind the debug setting.
  previewEmpty: boolean;
  /// A short, modal act the editor is in the middle of: saving a contract, or
  /// reading an import off disk. Deliberately NOT "a worker is doing
  /// something" — `workers:workShiftNow` does not resolve until the whole
  /// planning turn has run, which is minutes, and holding one app-wide flag
  /// across that made clicking Work now on one worker disable Save on every
  /// worker's editor until the shift finished. Per-worker work is tracked per
  /// worker: `shiftStarting`, `shiftProgress`, `errandBusy`.
  busy: boolean;
  /// Workers whose manual shift has been asked for but has not yet been
  /// announced as running. It is the gap between the click and the engine's
  /// first `workerShiftProgress` event — without it the button stays live
  /// through that gap and a second click earns "A shift is already starting."
  shiftStarting: Record<string, boolean>;
  error: string | null;
  /// The hire screen, hoisted out of the pane component.
  ///
  /// Drafting a contract is two full CLI turns and can run for minutes, and
  /// the pane unmounts the moment you switch tabs or open a worker — which
  /// used to throw away the typed job description AND the reply that was
  /// still on its way. Living here, the turn keeps running, the result lands
  /// wherever the user happens to be, and coming back shows either the form
  /// as it was left or the editor the draft opened.
  hire: HireState;
  /// AI revisions, keyed by the worker each one is about (`draft:<seq>` for
  /// a hire draft with no id yet).
  ///
  /// Per worker, not one global box: a revision runs for minutes and you can
  /// open anyone else's editor while it does, and a single shared box put
  /// Prometheus's instruction and its "Revising…" spinner inside Chief of
  /// Staff's editor — which reads as the app having lost track of which
  /// worker you are editing. Each editor now shows only its own.
  revise: Record<string, ReviseState>;
  /// Bumped every time the editor opens on something. A revision that lands
  /// after the user moved on compares this against the value it started with,
  /// so it can't rewrite a different worker's job description. Ids can't do
  /// that job — an unsaved hire draft doesn't have one yet.
  draftSeq: number;
}

export interface HireState {
  /// Whether the hire screen is what the Workers tab should show.
  open: boolean;
  jobDescription: string;
  projectPath: string;
  /// Whether the user picked the project themselves. An explicit choice beats
  /// the drafter's suggestion; the untouched default loses to it.
  projectTouched: boolean;
  /// Files attached to the job description — a spec, an example of the
  /// deliverable, a screenshot of the board the worker will work from.
  attachments: Attachment[];
  /// Epoch ms the in-flight drafting turn started, or null when idle. Stored
  /// rather than derived so the elapsed counter doesn't restart at zero every
  /// time the screen remounts.
  startedAt: number | null;
  error: string | null;
}

export interface ReviseState {
  instruction: string;
  attachments: Attachment[];
  startedAt: number | null;
  error: string | null;
  /// The reviser's prose read on what it changed, kept until dismissed.
  note: string | null;
  /// Which worker the running revision is about, so the tab can say whose it
  /// is while the editor is closed. Null for a hire draft not yet saved.
  targetWorkerId: string | null;
  /// A finished revision with nowhere to go yet: it landed while the editor
  /// was closed, or on somebody else. Held rather than dropped — the turn
  /// took minutes, and "you clicked away, so it was thrown out" is the exact
  /// failure this whole background-drafting change exists to prevent. It is
  /// applied the next time that worker's editor opens.
  pending: {
    workerId: string;
    jobDescription?: string;
    flow?: Flow;
    note: string;
  } | null;
}

const IDLE_HIRE: HireState = {
  open: false,
  jobDescription: '',
  projectPath: '',
  projectTouched: false,
  attachments: [],
  startedAt: null,
  error: null,
};

export const IDLE_REVISE: ReviseState = {
  instruction: '',
  attachments: [],
  startedAt: null,
  error: null,
  note: null,
  targetWorkerId: null,
  pending: null,
};

interface WorkersActions {
  reload(): Promise<void>;
  applyUpdate(worker: Worker, nextShiftAt: number | null, scorecard: WorkerScorecard): void;
  setShiftActive(id: string, active: boolean, task?: 'shift' | 'errand'): void;
  applyShiftProgress(id: string, text: string, tools: string[]): void;
  removeLocal(id: string): void;
  openEditor(
    draft: WorkerDraft,
    extras?: {
      draftedFlow?: Flow;
      hireSummary?: string;
      hireFlowError?: string;
    },
  ): void;
  closeEditor(): void;
  patchDraft(patch: Partial<WorkerDraft>): void;
  /// Open the hire screen, seeded with the project to work against. A hire
  /// already in flight is never disturbed — reopening returns you to it.
  openHire(defaultProjectPath: string): void;
  closeHire(): void;
  patchHire(patch: Partial<HireState>): void;
  /// Run the hire drafter. Resolves when the turn lands; the result is
  /// applied to the store either way, so nothing depends on the caller still
  /// being mounted.
  startHire(): Promise<void>;
  /// Clear a hire draft stuck mid-turn so the user can start a fresh one.
  cancelHire(): void;
  patchRevise(patch: Partial<ReviseState>): void;
  /// Run one AI revision against the open draft. Same deal: the result lands
  /// on the store, not on a component.
  startRevise(): Promise<void>;
  /// Land an AI revision on the open draft: new job description text and/or
  /// a revised flow that will save alongside the worker.
  applyRevision(patch: { jobDescription?: string; flow?: Flow }): void;
  /// Commit the open draft. Takes the project paths because a ride-along
  /// flow saves with it, and the flow library has to be reloaded from the
  /// same set of projects afterwards.
  save(projectPaths: string[]): Promise<boolean>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  setTrust(id: string, trust: WorkerTrustLevel): Promise<void>;
  /// Which of this worker's outputs renders when you open it.
  setAutoRender(id: string, autoRender: string): Promise<void>;
  remove(id: string): Promise<void>;
  workShiftNow(id: string): Promise<void>;
  selectWorker(id: string | null): void;
  /// Open a worker's desk from outside the roster — the command palette, a
  /// link. The same arrival as clicking the row, plus dismissing any draft
  /// left open: the editor renders over the desk, so a half-written edit from
  /// earlier would swallow the worker just asked for.
  openWorkerDesk(id: string): void;
  showQueue(): void;
  showCalendar(): void;
  showFunds(): void;
  showReport(): void;
  applyTreasury(treasury: Treasury, allocation: TreasuryAllocation): void;
  setTreasury(monthlyUSD: number): Promise<boolean>;
  distributeFunds(): Promise<boolean>;
  setPreviewEmpty(on: boolean): void;
  openWorkerActivity(workerId: string, orchestrationId: string, at: number): void;
  clearDeskFocus(): void;
  moveWorker(id: string, direction: -1 | 1): Promise<void>;
  /// Drop a worker at an arbitrary slot. `insertBefore` is a gap index into
  /// the current order — what a drop indicator drawn between two rows means.
  dropWorker(id: string, insertBefore: number): Promise<void>;
  setFilesRoot(id: string, root: string): void;
  runErrand(
    id: string,
    instruction: string,
    intent: import('@shared/flows/worker').WorkerMessageIntent,
    attachments?: Attachment[],
  ): Promise<boolean>;
  clearErrand(id: string): void;
  loadJournal(id: string): Promise<void>;
  /// Leave a note against one of this worker's turns. It becomes a journal
  /// entry, so the worker reads it before planning its next shift. Resolves
  /// true when it landed; the journal is reloaded either way, since it is what
  /// every surface showing notes reads from.
  addNote(id: string, orchestrationId: string, note: string): Promise<boolean>;
  /// Return this worker to a just-hired clean slate. Resolves to what was
  /// thrown away so the caller can say it out loud, or null on failure.
  resetMemory(id: string): Promise<{
    entries: number;
    files: number;
    shifts: number;
    errands: number;
    runs: number;
  } | null>;
  /// Rub out one turn — its ledger, runs, filed output and journal entries.
  /// Resolves to what went, or null on failure (the error is on the store).
  deleteActivity(
    id: string,
    orchestrationId: string,
  ): Promise<{
    task: 'shift' | 'errand';
    label: string;
    entries: number;
    files: number;
    runs: number;
    shiftGivenBack: number | null;
  } | null>;
  /// Work the most recent shift again from the state it started in. Resolves
  /// to the shift number that was re-run, or null on failure.
  redoShift(id: string, orchestrationId: string): Promise<number | null>;
  /// This worker as a share file. Read on demand rather than held in state:
  /// it is a rendering of the worker plus its flows, and a copy kept here
  /// would go stale the moment either is edited.
  shareYaml(id: string): Promise<{ yaml: string; missingFlowIds: string[] } | null>;
  /// Write that file wherever the user points the save dialog. Resolves to
  /// the path written, or null if they dismissed it.
  shareToFile(id: string): Promise<string | null>;
  /// Take a worker file: installs the flows it carries and opens the hire
  /// editor on it. Resolves false when the user dismissed the file dialog or
  /// the file could not be read — the error is on the store either way.
  /// `projectPath` is the project the arriving worker is offered; the caller
  /// passes `projectPaths` too because the flow library it must re-read spans
  /// every project, and only the caller knows them.
  importFromFile(args: { projectPath: string; projectPaths: string[] }): Promise<boolean>;
  clearError(): void;
}

/// Whether a new hire should file its deliverables into the project folder.
///
/// On for everyday projects and off for repos — see `WorkerCaps.fileIntoProject`.
/// `everyday` is the project record's own flag when the caller has it; the
/// path check behind `isEverydayProject` covers the rest.
export function defaultFileIntoProject(projectPath: string, everyday?: boolean): boolean {
  return isEverydayProject({ path: projectPath, everyday });
}

export function newWorkerDraft(projectPath: string, everyday?: boolean): WorkerDraft {
  return {
    name: '',
    tagline: '',
    jobDescription: '',
    projectPath,
    cadence: { kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] },
    caps: {
      maxItemsPerShift: 3,
      runIn: 'worktree',
      allowExternalActions: false,
      canDelegate: false,
      fileIntoProject: defaultFileIntoProject(projectPath, everyday),
    },
    budgetUSDPerMonth: 10,
    heartbeatModel: '',
    flowIds: [],
    enabled: true,
  };
}

export function draftFromWorker(w: Worker): WorkerDraft {
  return {
    id: w.id,
    name: w.name,
    tagline: w.tagline ?? '',
    jobDescription: w.jobDescription,
    projectPath: w.projectPath,
    cadence: structuredClone(w.cadence),
    caps: { ...w.caps },
    delegatesTo: w.delegatesTo ? [...w.delegatesTo] : undefined,
    budgetUSDPerMonth: w.budgetUSDPerMonth,
    heartbeatModel: w.heartbeatModel,
    heartbeatBackend: w.heartbeatBackend,
    flowIds: [...w.flowIds],
    enabled: w.enabled,
  };
}

/// Fill a draft from a hire-drafter contract. Trust never appears — every
/// hire starts on probation, enforced in main.
export function draftFromContract(
  contract: WorkerContract,
  projectPath: string,
  flowId: string | undefined,
  everyday?: boolean,
): WorkerDraft {
  return {
    name: contract.name,
    tagline: contract.tagline ?? '',
    jobDescription: contract.jobDescription,
    projectPath,
    cadence: structuredClone(contract.cadence),
    caps: {
      maxItemsPerShift: contract.maxItemsPerShift,
      runIn: 'worktree',
      allowExternalActions: false,
      canDelegate: false,
      fileIntoProject: defaultFileIntoProject(projectPath, everyday),
    },
    budgetUSDPerMonth: contract.budgetUSDPerMonth,
    heartbeatModel: contract.heartbeatModel,
    heartbeatBackend: contract.heartbeatBackend,
    flowIds: flowId ? [flowId] : [],
    enabled: true,
  };
}

/// Fill a draft from an imported share file. Like `draftFromContract`, trust
/// never appears — an imported worker starts on probation like any other hire,
/// and main enforces it regardless.
///
/// `availableFlowIds` filters the worker's flows down to the ones this library
/// can actually supply. A dangling id would be a worker that looks hired and
/// can launch nothing; dropping it here means the editor's own "a worker needs
/// at least one flow" rule stops the hire, with the import summary explaining
/// which flow is missing.
export function draftFromPortable(
  worker: PortableWorker,
  projectPath: string,
  availableFlowIds: string[],
): WorkerDraft {
  const available = new Set(availableFlowIds);
  return {
    name: worker.name,
    // The share file's description IS the arriving worker's tagline — see
    // `buildWorkerShare`, which writes one from the other.
    tagline: worker.description ?? '',
    jobDescription: worker.jobDescription,
    projectPath,
    cadence: structuredClone(worker.cadence),
    // External authority is local employment state, like trust and cwd
    // access. A shared worker file cannot arrive pre-authorized — and that
    // covers delegation too: an imported worker knows nothing about who else
    // this install employs, and must not arrive able to commission them.
    // Where its output lands is the receiving install's decision too: the
    // sender's folder is not this one, and the file cannot carry the flag
    // anyway (`coerceCaps`). Defaulted from the project it is landing in.
    caps: {
      ...worker.caps,
      allowExternalActions: false,
      canDelegate: false,
      fileIntoProject: defaultFileIntoProject(projectPath),
    },
    budgetUSDPerMonth: worker.budgetUSDPerMonth,
    heartbeatModel: worker.heartbeatModel,
    heartbeatBackend: worker.heartbeatBackend,
    flowIds: worker.flowIds.filter((id) => available.has(id)),
    enabled: true,
  };
}

/// Land a new roster order locally, then persist it.
///
/// Applied locally FIRST: the roster is what the user is looking at, and a row
/// that waits for a round trip before moving reads as a dead control. The
/// waterfall is re-run on the new order with the spend we were last pushed,
/// because position is a funding decision now — a row that moved while its
/// funded column stayed put reads as the reorder having done nothing.
async function applyRosterOrder(
  set: (fn: (s: WorkersState) => Partial<WorkersState>) => void,
  ids: string[],
): Promise<void> {
  set((s) => {
    const workers = { ...s.workers };
    ids.forEach((wid, index) => {
      const worker = workers[wid];
      if (worker) workers[wid] = { ...worker, order: index };
    });
    const allocation =
      s.allocation && s.treasury
        ? allocateTreasury(
            Object.values(workers),
            (wid) => fundingFor(s.allocation, wid)?.spentUSD ?? 0,
            s.treasury.monthlyUSD,
            s.allocation.spentUSD,
          )
        : s.allocation;
    return { workers, allocation };
  });
  await window.overcli.invoke('workers:reorder', { ids });
}

/// Where the open draft's revision state lives. A saved worker is keyed by
/// its id, which survives the editor being closed and reopened; a hire draft
/// has no id yet, so it is keyed by the editor opening that produced it and
/// is therefore gone for good once you leave it — which is correct, since so
/// is the draft.
function reviseKey(draft: WorkerDraft | null, draftSeq: number): string | null {
  if (!draft) return null;
  return draft.id ?? `draft:${draftSeq}`;
}

/// Drop the open editor's revision entry when it has nothing left to do — a
/// finished, read box shouldn't outlive the editor it belongs to. One still
/// running, or holding a result, is kept.
function forgetIdleRevision(st: WorkersState): Record<string, ReviseState> {
  const key = reviseKey(st.draft, st.draftSeq);
  const entry = key ? st.revise[key] : undefined;
  if (!key || !entry || entry.startedAt || entry.pending) return st.revise;
  const next = { ...st.revise };
  delete next[key];
  return next;
}

/// The revision state for whatever editor is open. Returns the shared idle
/// object rather than a fresh one, so a selector on it doesn't re-render on
/// every store tick.
export function selectRevise(s: WorkersState): ReviseState {
  const key = reviseKey(s.draft, s.draftSeq);
  return (key ? s.revise[key] : undefined) ?? IDLE_REVISE;
}

/// Every sidebar destination is a NAVIGATION, so it has to LEAVE whatever is
/// filling the pane — not just set `view`. The Workers tab draws the editor,
/// the hire screen and a worker's flow run in place of its own screens and
/// checks for them first, so a bare `set({ view })` changed a variable nobody
/// on screen was reading: clicking Funds from an open editor sat there on the
/// editor, and clicking a name in the roster did nothing at all.
///
/// Closing the editor discards the draft, which is the same bargain every
/// other route out of it already made — the roster is a navigation bar, and a
/// navigation bar that refuses to navigate is the worse failure.
function leavePane(get: () => WorkersState & WorkersActions): void {
  useFlowsStore.getState().setActiveRun(null);
  const st = get();
  if (st.draft) st.closeEditor();
  if (st.hire.open) st.closeHire();
}

export const useWorkersStore = create<WorkersState & WorkersActions>((set, get) => ({
  loaded: false,
  workers: {},
  nextShiftAt: {},
  scorecards: {},
  journals: {},
  shiftProgress: {},
  errandBusy: {},
  errandSending: {},
  filesRoot: {},
  errandError: {},
  errandResult: {},
  draft: null,
  draftedFlow: null,
  hireSummary: null,
  hireFlowError: null,
  selectedWorkerId: null,
  treasury: null,
  allocation: null,
  view: 'queue',
  selectSeq: 0,
  deskFocus: null,
  previewEmpty: false,
  busy: false,
  shiftStarting: {},
  error: null,
  hire: IDLE_HIRE,
  revise: {},
  draftSeq: 0,

  async reload() {
    const [rows, funds] = await Promise.all([
      window.overcli.invoke('workers:list'),
      window.overcli.invoke('workers:treasury'),
    ]);
    const workers: Record<string, Worker> = {};
    const nextShiftAt: Record<string, number | null> = {};
    const scorecards: Record<string, WorkerScorecard> = {};
    for (const row of rows) {
      workers[row.worker.id] = row.worker;
      nextShiftAt[row.worker.id] = row.nextShiftAt;
      scorecards[row.worker.id] = row.scorecard;
    }
    set({
      workers,
      nextShiftAt,
      scorecards,
      treasury: funds.treasury,
      allocation: funds.allocation,
      loaded: true,
    });
  },

  applyTreasury(treasury, allocation) {
    set({ treasury, allocation });
  },

  async setTreasury(monthlyUSD) {
    const res = await window.overcli.invoke('workers:setTreasury', {
      monthlyUSD,
    });
    if (!res.ok) {
      set({ error: res.error });
      return false;
    }
    return true;
  },

  async distributeFunds() {
    const res = await window.overcli.invoke('workers:distributeFunds');
    if (!res.ok) {
      set({ error: res.error });
      return false;
    }
    set((state) => ({
      workers: res.workers.reduce((all, worker) => ({ ...all, [worker.id]: worker }), state.workers),
      treasury: res.treasury,
      allocation: res.allocation,
    }));
    return true;
  },

  applyUpdate(worker, nextShiftAt, scorecard) {
    set((s) => ({
      workers: { ...s.workers, [worker.id]: worker },
      nextShiftAt: { ...s.nextShiftAt, [worker.id]: nextShiftAt },
      scorecards: { ...s.scorecards, [worker.id]: scorecard },
    }));
  },

  setShiftActive(id, active, task = 'shift') {
    set((s) => {
      const shiftProgress = { ...s.shiftProgress };
      // Keep any text already streamed for this worker, but let the newly
      // announced task win — it is the authoritative label for what is running.
      if (active) {
        const prior = shiftProgress[id];
        shiftProgress[id] = {
          text: prior?.text ?? '',
          tools: prior?.tools ?? [],
          task,
        };
      } else delete shiftProgress[id];
      return { shiftProgress };
    });
  },

  applyShiftProgress(id, text, tools) {
    set((s) => ({
      shiftProgress: {
        ...s.shiftProgress,
        // `task` is set by setShiftActive, which always precedes streamed text.
        [id]: { task: s.shiftProgress[id]?.task ?? 'shift', text, tools },
      },
    }));
  },

  removeLocal(id) {
    set((s) => {
      const workers = { ...s.workers };
      const nextShiftAt = { ...s.nextShiftAt };
      const scorecards = { ...s.scorecards };
      const journals = { ...s.journals };
      const shiftProgress = { ...s.shiftProgress };
      const shiftStarting = { ...s.shiftStarting };
      const errandBusy = { ...s.errandBusy };
      const errandSending = { ...s.errandSending };
      const errandError = { ...s.errandError };
      const errandResult = { ...s.errandResult };
      delete workers[id];
      delete nextShiftAt[id];
      delete scorecards[id];
      delete journals[id];
      delete shiftProgress[id];
      delete shiftStarting[id];
      delete errandBusy[id];
      delete errandSending[id];
      delete errandError[id];
      delete errandResult[id];
      return {
        workers,
        nextShiftAt,
        scorecards,
        journals,
        shiftProgress,
        shiftStarting,
        errandBusy,
        errandSending,
        errandError,
        errandResult,
        // Firing the selected worker must clear the selection, or the pane
        // holds an id nothing resolves and renders blank.
        selectedWorkerId: s.selectedWorkerId === id ? null : s.selectedWorkerId,
      };
    });
  },

  selectWorker(id) {
    // Picking a worker outright is a fresh arrival: it clears any turn a
    // previous link asked for, so the desk opens on today as it should.
    leavePane(get);
    set((st) => ({
      selectedWorkerId: id,
      view: 'worker',
      deskFocus: null,
      selectSeq: st.selectSeq + 1,
    }));
  },

  openWorkerDesk(id) {
    get().selectWorker(id);
  },

  showQueue() {
    leavePane(get);
    set({ view: 'queue' });
  },

  showCalendar() {
    leavePane(get);
    set({ view: 'calendar' });
  },

  showFunds() {
    leavePane(get);
    set({ view: 'funds' });
  },

  showReport() {
    leavePane(get);
    set({ view: 'report' });
  },

  clearDeskFocus() {
    if (get().deskFocus) set({ deskFocus: null });
  },

  setPreviewEmpty(on) {
    set({ previewEmpty: on });
  },

  async moveWorker(id, direction) {
    await applyRosterOrder(set, moveInRoster(Object.values(get().workers), id, direction));
  },

  async dropWorker(id, insertBefore) {
    await applyRosterOrder(set, placeInRoster(Object.values(get().workers), id, insertBefore));
  },

  openWorkerActivity(workerId, orchestrationId, at) {
    leavePane(get);
    set((st) => ({
      selectedWorkerId: workerId,
      view: 'worker',
      deskFocus: { workerId, orchestrationId, at },
      selectSeq: st.selectSeq + 1,
    }));
  },

  setFilesRoot(id, root) {
    set((s) => ({ filesRoot: { ...s.filesRoot, [id]: root } }));
  },

  openEditor(draft, extras) {
    set((st) => {
      const draftSeq = st.draftSeq + 1;
      // A revision that finished while this worker's editor was closed has
      // been waiting for exactly this moment.
      const key = reviseKey(draft, draftSeq)!;
      const held = st.revise[key]?.pending ?? null;
      return {
        draft: held?.jobDescription ? { ...draft, jobDescription: held.jobDescription } : draft,
        draftedFlow: held?.flow ?? extras?.draftedFlow ?? null,
        hireSummary: extras?.hireSummary ?? null,
        hireFlowError: held?.flow ? null : (extras?.hireFlowError ?? null),
        error: null,
        draftSeq,
        revise: held
          ? {
              ...st.revise,
              [key]: {
                ...IDLE_REVISE,
                note: `${held.note}\n\n(That revision finished while this editor was closed, and has been applied to the draft now.)`,
              },
            }
          : st.revise,
      };
    });
  },

  closeEditor() {
    set((st) => ({
      draft: null,
      draftedFlow: null,
      hireSummary: null,
      hireFlowError: null,
      error: null,
      // A revision still running (or one holding a result) keeps its entry so
      // it has somewhere to land; a finished, read box is forgotten.
      revise: forgetIdleRevision(st),
    }));
  },

  patchDraft(patch) {
    set((s) => (s.draft ? { draft: { ...s.draft, ...patch }, error: null } : {}));
  },

  openHire(defaultProjectPath) {
    set((st) => ({
      hire: st.hire.startedAt
        ? { ...st.hire, open: true }
        : {
            ...st.hire,
            open: true,
            projectPath: st.hire.projectPath || defaultProjectPath,
          },
    }));
  },

  closeHire() {
    // Closing is "put this screen away", not "cancel the draft". A turn in
    // flight keeps running and still lands in the editor when it returns —
    // so the form it was launched from is kept exactly as it was.
    set((st) => ({
      hire: st.hire.startedAt ? { ...st.hire, open: false } : { ...IDLE_HIRE },
    }));
  },

  patchHire(patch) {
    set((st) => ({ hire: { ...st.hire, ...patch } }));
  },

  cancelHire() {
    set((st) => ({ hire: { ...st.hire, startedAt: null, error: null } }));
  },

  async startHire() {
    const { hire } = get();
    // Already drafting — one turn at a time, unless the last one has been
    // stuck long enough that it is more likely wedged than actually working.
    if (hire.startedAt && Date.now() - hire.startedAt <= 10 * 60_000) return;
    const jobDescription = hire.jobDescription.trim();
    if (!jobDescription) {
      set((st) => ({
        hire: {
          ...st.hire,
          error: 'Describe the job first — the worker plans every shift from it.',
        },
      }));
      return;
    }
    set((st) => ({
      hire: { ...st.hire, startedAt: Date.now(), error: null },
    }));
    try {
      const result = await window.overcli.invoke('workers:draftFromPrompt', {
        jobDescription,
        attachments: hire.attachments.length > 0 ? hire.attachments : undefined,
      });
      if (!result.ok) {
        set((st) => ({
          hire: { ...st.hire, startedAt: null, error: result.error },
        }));
        return;
      }
      // The picker may have moved while the turn ran; read it fresh.
      const current = get().hire;
      const chosenPath = current.projectTouched
        ? current.projectPath
        : (result.contract.projectPath ?? current.projectPath);
      get().openEditor(draftFromContract(result.contract, chosenPath, result.contract.flowId), {
          draftedFlow: result.draftedFlow,
          hireSummary: result.summary || undefined,
          hireFlowError: result.flowError,
      });
      // The hire's own form is done with; other workers' revisions are not
      // this hire's business and keep running.
      set({ hire: { ...IDLE_HIRE } });
    } catch (err) {
      set((st) => ({
        hire: {
          ...st.hire,
          startedAt: null,
          error: err instanceof Error ? err.message : String(err),
        },
      }));
    }
  },

  patchRevise(patch) {
    set((st) => {
      const key = reviseKey(st.draft, st.draftSeq);
      if (!key) return {};
      return {
        revise: {
          ...st.revise,
          [key]: { ...(st.revise[key] ?? IDLE_REVISE), ...patch },
        },
      };
    });
  },

  async startRevise() {
    const { draft, draftedFlow, draftSeq } = get();
    const key = reviseKey(draft, draftSeq);
    if (!draft || !key) return;
    const entry = get().revise[key] ?? IDLE_REVISE;
    if (entry.startedAt) return;
    const instruction = entry.instruction.trim();
    if (!instruction) return;
    // A ride-along flow (hire-drafted or already revised) is unsaved — main
    // can't load it by id, so ship the object; it's also the freshest state
    // when the flow was revised before. But only when it's still the SELECTED
    // flow — after a manual re-pick, the saved pick wins.
    const rideAlong =
      draftedFlow && (draft.flowIds.length === 0 || draft.flowIds[0] === draftedFlow.id) ? draftedFlow : undefined;
    const editedWorkerId = draft.id ?? null;
    const patchEntry = (patch: Partial<ReviseState>) =>
      set((st) => ({
        revise: {
          ...st.revise,
          [key]: { ...(st.revise[key] ?? IDLE_REVISE), ...patch },
        },
      }));

    patchEntry({
      startedAt: Date.now(),
      error: null,
      targetWorkerId: editedWorkerId,
      pending: null,
    });
    try {
      const res = await window.overcli.invoke('workers:reviseFromPrompt', {
        jobDescription: draft.jobDescription,
        flow: rideAlong,
        flowId: rideAlong ? undefined : draft.flowIds[0],
        instruction,
        attachments: entry.attachments.length > 0 ? entry.attachments : undefined,
      });
      if (!res.ok) {
        patchEntry({ startedAt: null, error: res.error });
        return;
      }
      // The editor may have been closed, or swapped to another worker, while
      // the turn ran — clicking any worker in the roster closes it. The result
      // belongs to the worker it was asked about and to no other, so it lands
      // only when that same editor is what's open.
      if (reviseKey(get().draft, get().draftSeq) === key) {
        get().applyRevision({
          jobDescription: res.jobDescription,
          flow: res.flow,
        });
        set((st) => ({
          revise: { ...st.revise, [key]: { ...IDLE_REVISE, note: res.note } },
        }));
        return;
      }
      if (editedWorkerId) {
        // Hold it for that worker rather than throwing minutes of work away;
        // opening its editor again applies it.
        set((st) => ({
          revise: {
            ...st.revise,
            [key]: {
              ...IDLE_REVISE,
              pending: {
                workerId: editedWorkerId,
                jobDescription: res.jobDescription,
                flow: res.flow,
                note: res.note,
              },
            },
          },
        }));
        return;
      }
      // A hire draft that was discarded mid-revision: there is nothing left
      // to apply it to, and nothing that could ever reopen it.
      set((st) => {
        const next = { ...st.revise };
        delete next[key];
        return { revise: next };
      });
    } catch (err) {
      patchEntry({
        startedAt: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  applyRevision(patch) {
    set((s) => ({
      ...(s.draft && patch.jobDescription ? { draft: { ...s.draft, jobDescription: patch.jobDescription } } : {}),
      ...(patch.flow ? { draftedFlow: patch.flow, hireFlowError: null } : {}),
      error: null,
    }));
  },

  async save(projectPaths) {
    const { draft, draftedFlow } = get();
    if (!draft) return false;
    set({ busy: true, error: null });
    try {
      let flowIds = draft.flowIds;
      // A riding-along flow persists only now, with the worker itself — so a
      // cancelled hire or revision leaves nothing behind. A hire-drafted flow
      // is new (target user); a revised one goes back where it lives.
      if (draftedFlow) {
        const savedFlow = await window.overcli.invoke('flows:save', {
          flow: draftedFlow,
          target: draftedFlow.source === 'project' ? 'project' : 'user',
          projectPath: flowProjectPath(draftedFlow) ?? undefined,
        });
        if (!savedFlow.ok) {
          set({ error: savedFlow.error });
          return false;
        }
        if (!flowIds.includes(draftedFlow.id)) flowIds = [...flowIds, draftedFlow.id];
        // `flows:save` writes the file; the library every flow-reading pane
        // binds to is a renderer mirror that knows nothing about it. Without
        // this the worker's Settings tab kept rendering the flow's
        // pre-revision self until something else happened to reload.
        await useFlowsStore.getState().reload(projectPaths);
      }
      const res = await window.overcli.invoke('workers:save', {
        // An emptied tagline field is "no tagline", not a blank one: the
        // roster falls back to the job description only when the field is
        // absent, and a stored '' would render an empty second line forever.
        worker: {
          ...draft,
          tagline: draft.tagline?.trim() || undefined,
          flowIds,
        },
      });
      if (!res.ok) {
        set({ error: res.error });
        return false;
      }
      // The `workerUpdate` push has already landed the record; just close.
      set((st) => ({
        draft: null,
        draftedFlow: null,
        hireSummary: null,
        hireFlowError: null,
        revise: forgetIdleRevision(st),
      }));
      return true;
    } finally {
      set({ busy: false });
    }
  },

  async setEnabled(id, enabled) {
    const res = await window.overcli.invoke('workers:setEnabled', {
      id,
      enabled,
    });
    if (!res.ok) set({ error: res.error });
  },

  async setTrust(id, trust) {
    const res = await window.overcli.invoke('workers:setTrust', {
      id,
      trust,
    });
    if (!res.ok) set({ error: res.error });
  },

  async setAutoRender(id, autoRender) {
    const res = await window.overcli.invoke('workers:setAutoRender', {
      id,
      autoRender,
    });
    if (!res.ok) set({ error: res.error });
  },

  async remove(id) {
    const res = await window.overcli.invoke('workers:delete', { id });
    if (!res.ok) set({ error: res.error });
  },

  async workShiftNow(id) {
    set((s) => ({
      shiftStarting: { ...s.shiftStarting, [id]: true },
      error: null,
    }));
    try {
      const res = await window.overcli.invoke('workers:workShiftNow', { id });
      if (!res.ok) set({ error: res.error });
    } finally {
      // This resolves when the whole shift has been planned, not when it
      // started — by then `shiftProgress` has long since taken over saying
      // the worker is busy, and this flag has nothing left to hold.
      set((s) => {
        const shiftStarting = { ...s.shiftStarting };
        delete shiftStarting[id];
        return { shiftStarting };
      });
    }
  },

  async runErrand(id, instruction, intent, attachments) {
    const sendId = `${id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    set((s) => ({
      errandBusy: { ...s.errandBusy, [id]: true },
      errandError: { ...s.errandError, [id]: '' },
      errandSending: {
        ...s.errandSending,
        [id]: [...(s.errandSending[id] ?? []), { id: sendId, text: instruction, intent, at: Date.now() }],
      },
    }));
    try {
      const res = await window.overcli.invoke('workers:runErrand', {
        id,
        instruction,
        intent,
        attachments,
      });
      if (!res.ok) {
        set((s) => ({ errandError: { ...s.errandError, [id]: res.error } }));
        return false;
      }
      set((s) => ({ errandResult: { ...s.errandResult, [id]: res.result } }));
      return true;
    } finally {
      set((s) => {
        // Drop only THIS one. Anything still queued behind it stays on screen
        // until its own turn finishes.
        const rest = (s.errandSending[id] ?? []).filter((e) => e.id !== sendId);
        const errandSending = { ...s.errandSending };
        if (rest.length > 0) errandSending[id] = rest;
        else delete errandSending[id];
        return {
          errandBusy: { ...s.errandBusy, [id]: rest.length > 0 },
          errandSending,
        };
      });
    }
  },

  clearErrand(id) {
    set((s) => {
      const errandError = { ...s.errandError };
      const errandResult = { ...s.errandResult };
      delete errandError[id];
      delete errandResult[id];
      return { errandError, errandResult };
    });
  },

  async addNote(id, orchestrationId, note) {
    const res = await window.overcli.invoke('workers:note', {
      id,
      orchestrationId,
      note,
    });
    if (!res.ok) {
      set({ error: res.error });
      return false;
    }
    await get().loadJournal(id);
    return true;
  },

  async loadJournal(id) {
    const entries = await window.overcli.invoke('workers:journal', { id });
    set((s) => ({ journals: { ...s.journals, [id]: entries } }));
  },

  async deleteActivity(id, orchestrationId) {
    const res = await window.overcli.invoke('workers:deleteActivity', {
      id,
      orchestrationId,
    });
    if (!res.ok) {
      set({ error: res.error });
      return null;
    }
    // The journal drawer is a snapshot taken when it was opened; entries this
    // just removed would otherwise sit there until the next manual reload.
    await get().loadJournal(id);
    return res;
  },

  async redoShift(id, orchestrationId) {
    const res = await window.overcli.invoke('workers:redoShift', {
      id,
      orchestrationId,
    });
    if (!res.ok) {
      set({ error: res.error });
      return null;
    }
    await get().loadJournal(id);
    return res.shift;
  },

  async resetMemory(id) {
    const res = await window.overcli.invoke('workers:resetMemory', { id });
    if (!res.ok) {
      set({ error: res.error });
      return null;
    }
    // The pane renders this local state alongside the persisted ledgers. Clear
    // it in the same turn so a no-launch errand reply or stale error does not
    // survive an otherwise clean worker.
    set((s) => {
      const errandError = { ...s.errandError };
      const errandResult = { ...s.errandResult };
      const errandBusy = { ...s.errandBusy };
      const errandSending = { ...s.errandSending };
      delete errandError[id];
      delete errandResult[id];
      delete errandBusy[id];
      delete errandSending[id];
      return {
        journals: { ...s.journals, [id]: [] },
        errandError,
        errandResult,
        errandBusy,
        errandSending,
      };
    });
    return {
      entries: res.entries,
      files: res.files,
      shifts: res.shifts,
      errands: res.errands,
      runs: res.runs,
    };
  },

  async shareYaml(id) {
    const res = await window.overcli.invoke('workers:share', { id });
    if (!res.ok) {
      set({ error: res.error });
      return null;
    }
    return { yaml: res.yaml, missingFlowIds: res.missingFlowIds };
  },

  async shareToFile(id) {
    const res = await window.overcli.invoke('workers:shareToFile', { id });
    if (!res.ok) {
      set({ error: res.error });
      return null;
    }
    return res.filePath;
  },

  async importFromFile({ projectPath, projectPaths }) {
    set({ busy: true, error: null });
    try {
      const res = await window.overcli.invoke('workers:importFromFile');
      if (!res.ok) {
        set({ error: res.error });
        return false;
      }
      if (res.canceled) return false;
      // The flows arrived in main; the library the editor picks from has to
      // learn about them before the draft references them.
      await useFlowsStore.getState().reload(projectPaths);
      const available = useFlowsStore.getState().flows.map((f) => f.id);
      get().openEditor(draftFromPortable(res.worker, projectPath, available), {
        hireSummary: [`Imported ${res.worker.name}.`, res.summary].filter(Boolean).join(' '),
      });
      return true;
    } finally {
      set({ busy: false });
    }
  },

  clearError() {
    set({ error: null });
  },
}));
