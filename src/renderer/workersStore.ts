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
import {
  allocateTreasury,
  fundingFor,
  type Treasury,
  type TreasuryAllocation,
} from '@shared/flows/treasury';
import type {
  Worker,
  WorkerCaps,
  WorkerContract,
  WorkerErrandResult,
  WorkerJournalEntry,
  WorkerScorecard,
  WorkerTrustLevel,
} from '@shared/flows/worker';
import type { PortableWorker } from '@shared/flows/workerYaml';
import type { ScheduleTrigger } from '@shared/flows/schedule';

export interface WorkerDraft {
  id?: UUID;
  name: string;
  jobDescription: string;
  projectPath: string;
  cadence: ScheduleTrigger;
  caps: WorkerCaps;
  budgetUSDPerMonth: number;
  heartbeatModel: string;
  heartbeatBackend?: Backend;
  flowIds: string[];
  enabled: boolean;
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
  errandSending: Record<string, Array<{ id: string; text: string; at: number }>>;
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
  /// The Workers pane shows one of three things: the selected worker's desk,
  /// the roster calendar, or the funding waterfall. The last two are peers of
  /// the selection rather than part of it — both are about every worker at
  /// once, so neither has a worker to be the selection of, and picking anyone
  /// from them must land you on their desk.
  view: 'worker' | 'calendar' | 'funds';
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
  busy: boolean;
  error: string | null;
}

interface WorkersActions {
  reload(): Promise<void>;
  applyUpdate(worker: Worker, nextShiftAt: number | null, scorecard: WorkerScorecard): void;
  setShiftActive(id: string, active: boolean, task?: 'shift' | 'errand'): void;
  applyShiftProgress(id: string, text: string, tools: string[]): void;
  removeLocal(id: string): void;
  openEditor(
    draft: WorkerDraft,
    extras?: { draftedFlow?: Flow; hireSummary?: string; hireFlowError?: string },
  ): void;
  closeEditor(): void;
  patchDraft(patch: Partial<WorkerDraft>): void;
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
  showCalendar(): void;
  showFunds(): void;
  applyTreasury(treasury: Treasury, allocation: TreasuryAllocation): void;
  setTreasury(monthlyUSD: number): Promise<boolean>;
  setPreviewEmpty(on: boolean): void;
  openWorkerActivity(workerId: string, orchestrationId: string, at: number): void;
  clearDeskFocus(): void;
  moveWorker(id: string, direction: -1 | 1): Promise<void>;
  /// Drop a worker at an arbitrary slot. `insertBefore` is a gap index into
  /// the current order — what a drop indicator drawn between two rows means.
  dropWorker(id: string, insertBefore: number): Promise<void>;
  setFilesRoot(id: string, root: string): void;
  runErrand(id: string, instruction: string, attachments?: Attachment[]): Promise<boolean>;
  clearErrand(id: string): void;
  loadJournal(id: string): Promise<void>;
  /// Return this worker to a just-hired clean slate. Resolves to what was
  /// thrown away so the caller can say it out loud, or null on failure.
  resetMemory(id: string): Promise<{
    entries: number;
    files: number;
    shifts: number;
    errands: number;
    runs: number;
  } | null>;
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

export function newWorkerDraft(projectPath: string): WorkerDraft {
  return {
    name: '',
    jobDescription: '',
    projectPath,
    cadence: { kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] },
    caps: { maxItemsPerShift: 3, runIn: 'worktree', allowExternalActions: false },
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
    jobDescription: w.jobDescription,
    projectPath: w.projectPath,
    cadence: structuredClone(w.cadence),
    caps: { ...w.caps },
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
): WorkerDraft {
  return {
    name: contract.name,
    jobDescription: contract.jobDescription,
    projectPath,
    cadence: structuredClone(contract.cadence),
    caps: {
      maxItemsPerShift: contract.maxItemsPerShift,
      runIn: 'worktree',
      allowExternalActions: false,
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
    jobDescription: worker.jobDescription,
    projectPath,
    cadence: structuredClone(worker.cadence),
    // External authority is local employment state, like trust and cwd
    // access. A shared worker file cannot arrive pre-authorized.
    caps: { ...worker.caps, allowExternalActions: false },
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
          )
        : s.allocation;
    return { workers, allocation };
  });
  await window.overcli.invoke('workers:reorder', { ids });
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
  view: 'worker',
  deskFocus: null,
  previewEmpty: false,
  busy: false,
  error: null,

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
    const res = await window.overcli.invoke('workers:setTreasury', { monthlyUSD });
    if (!res.ok) {
      set({ error: res.error });
      return false;
    }
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
        shiftProgress[id] = { text: prior?.text ?? '', tools: prior?.tools ?? [], task };
      }
      else delete shiftProgress[id];
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
      const errandBusy = { ...s.errandBusy };
      const errandSending = { ...s.errandSending };
      const errandError = { ...s.errandError };
      const errandResult = { ...s.errandResult };
      delete workers[id];
      delete nextShiftAt[id];
      delete scorecards[id];
      delete journals[id];
      delete shiftProgress[id];
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
    // previous link asked for, so the desk opens on today as it should — and
    // any run filling the pane, since the Workers tab renders a worker's run
    // in place of its desk and you just asked for the desk.
    useFlowsStore.getState().setActiveRun(null);
    set({ selectedWorkerId: id, view: 'worker', deskFocus: null });
  },

  openWorkerDesk(id) {
    get().closeEditor();
    get().selectWorker(id);
  },

  showCalendar() {
    set({ view: 'calendar' });
  },

  showFunds() {
    set({ view: 'funds' });
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
    useFlowsStore.getState().setActiveRun(null);
    set({
      selectedWorkerId: workerId,
      view: 'worker',
      deskFocus: { workerId, orchestrationId, at },
    });
  },

  setFilesRoot(id, root) {
    set((s) => ({ filesRoot: { ...s.filesRoot, [id]: root } }));
  },

  openEditor(draft, extras) {
    set({
      draft,
      draftedFlow: extras?.draftedFlow ?? null,
      hireSummary: extras?.hireSummary ?? null,
      hireFlowError: extras?.hireFlowError ?? null,
      error: null,
    });
  },

  closeEditor() {
    set({ draft: null, draftedFlow: null, hireSummary: null, hireFlowError: null, error: null });
  },

  patchDraft(patch) {
    set((s) => (s.draft ? { draft: { ...s.draft, ...patch }, error: null } : {}));
  },

  applyRevision(patch) {
    set((s) => ({
      ...(s.draft && patch.jobDescription
        ? { draft: { ...s.draft, jobDescription: patch.jobDescription } }
        : {}),
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
        if (flowIds.length === 0) flowIds = [draftedFlow.id];
        // `flows:save` writes the file; the library every flow-reading pane
        // binds to is a renderer mirror that knows nothing about it. Without
        // this the worker's Settings tab kept rendering the flow's
        // pre-revision self until something else happened to reload.
        await useFlowsStore.getState().reload(projectPaths);
      }
      const res = await window.overcli.invoke('workers:save', {
        worker: { ...draft, flowIds },
      });
      if (!res.ok) {
        set({ error: res.error });
        return false;
      }
      // The `workerUpdate` push has already landed the record; just close.
      set({ draft: null, draftedFlow: null, hireSummary: null, hireFlowError: null });
      return true;
    } finally {
      set({ busy: false });
    }
  },

  async setEnabled(id, enabled) {
    const res = await window.overcli.invoke('workers:setEnabled', { id, enabled });
    if (!res.ok) set({ error: res.error });
  },

  async setTrust(id, trust) {
    const res = await window.overcli.invoke('workers:setTrust', { id, trust });
    if (!res.ok) set({ error: res.error });
  },

  async setAutoRender(id, autoRender) {
    const res = await window.overcli.invoke('workers:setAutoRender', { id, autoRender });
    if (!res.ok) set({ error: res.error });
  },

  async remove(id) {
    const res = await window.overcli.invoke('workers:delete', { id });
    if (!res.ok) set({ error: res.error });
  },

  async workShiftNow(id) {
    set({ busy: true, error: null });
    try {
      const res = await window.overcli.invoke('workers:workShiftNow', { id });
      if (!res.ok) set({ error: res.error });
    } finally {
      set({ busy: false });
    }
  },

  async runErrand(id, instruction, attachments) {
    const sendId = `${id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    set((s) => ({
      errandBusy: { ...s.errandBusy, [id]: true },
      errandError: { ...s.errandError, [id]: '' },
      errandSending: {
        ...s.errandSending,
        [id]: [...(s.errandSending[id] ?? []), { id: sendId, text: instruction, at: Date.now() }],
      },
    }));
    try {
      const res = await window.overcli.invoke('workers:runErrand', {
        id,
        instruction,
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
        return { errandBusy: { ...s.errandBusy, [id]: rest.length > 0 }, errandSending };
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

  async loadJournal(id) {
    const entries = await window.overcli.invoke('workers:journal', { id });
    set((s) => ({ journals: { ...s.journals, [id]: entries } }));
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
