// Renderer mirror of the worker engine, plus the hire/edit draft. Main owns
// every decision — when a shift fires, what the scorecard says, whether a
// save is valid — and pushes whole records via `workerUpdate`; this store is
// a mirror plus the form state. `nextShiftAt` and the scorecard are never
// computed here for the same reason `nextFireAt` isn't in schedulesStore:
// two implementations would disagree.

import { create } from 'zustand';

import type { UUID } from '@shared/types';
import { flowProjectPath, type Flow } from '@shared/flows/schema';
import type {
  Worker,
  WorkerCaps,
  WorkerContract,
  WorkerJournalEntry,
  WorkerScorecard,
  WorkerTrustLevel,
} from '@shared/flows/worker';
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
  shiftProgress: Record<string, { text: string; tools: string[] }>;
  draft: WorkerDraft | null;
  /// A flow riding along with the draft: hire-drafted (new), or AI-revised
  /// (an existing flow with unsaved changes). Persisted only when the worker
  /// itself saves — cancelling the editor discards both together.
  draftedFlow: Flow | null;
  /// The hire drafter's prose read on the job, shown above the editor.
  hireSummary: string | null;
  busy: boolean;
  error: string | null;
}

interface WorkersActions {
  reload(): Promise<void>;
  applyUpdate(worker: Worker, nextShiftAt: number | null, scorecard: WorkerScorecard): void;
  setShiftActive(id: string, active: boolean): void;
  applyShiftProgress(id: string, text: string, tools: string[]): void;
  removeLocal(id: string): void;
  openEditor(draft: WorkerDraft, extras?: { draftedFlow?: Flow; hireSummary?: string }): void;
  closeEditor(): void;
  patchDraft(patch: Partial<WorkerDraft>): void;
  /// Land an AI revision on the open draft: new job description text and/or
  /// a revised flow that will save alongside the worker.
  applyRevision(patch: { jobDescription?: string; flow?: Flow }): void;
  save(): Promise<boolean>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  setTrust(id: string, trust: WorkerTrustLevel): Promise<void>;
  remove(id: string): Promise<void>;
  workShiftNow(id: string): Promise<void>;
  loadJournal(id: string): Promise<void>;
  clearError(): void;
}

export function newWorkerDraft(projectPath: string): WorkerDraft {
  return {
    name: '',
    jobDescription: '',
    projectPath,
    cadence: { kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] },
    caps: { maxItemsPerShift: 3, runIn: 'worktree' },
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
    caps: { maxItemsPerShift: contract.maxItemsPerShift, runIn: 'worktree' },
    budgetUSDPerMonth: contract.budgetUSDPerMonth,
    heartbeatModel: contract.heartbeatModel,
    flowIds: flowId ? [flowId] : [],
    enabled: true,
  };
}

export const useWorkersStore = create<WorkersState & WorkersActions>((set, get) => ({
  loaded: false,
  workers: {},
  nextShiftAt: {},
  scorecards: {},
  journals: {},
  shiftProgress: {},
  draft: null,
  draftedFlow: null,
  hireSummary: null,
  busy: false,
  error: null,

  async reload() {
    const rows = await window.overcli.invoke('workers:list');
    const workers: Record<string, Worker> = {};
    const nextShiftAt: Record<string, number | null> = {};
    const scorecards: Record<string, WorkerScorecard> = {};
    for (const row of rows) {
      workers[row.worker.id] = row.worker;
      nextShiftAt[row.worker.id] = row.nextShiftAt;
      scorecards[row.worker.id] = row.scorecard;
    }
    set({ workers, nextShiftAt, scorecards, loaded: true });
  },

  applyUpdate(worker, nextShiftAt, scorecard) {
    set((s) => ({
      workers: { ...s.workers, [worker.id]: worker },
      nextShiftAt: { ...s.nextShiftAt, [worker.id]: nextShiftAt },
      scorecards: { ...s.scorecards, [worker.id]: scorecard },
    }));
  },

  setShiftActive(id, active) {
    set((s) => {
      const shiftProgress = { ...s.shiftProgress };
      if (active) shiftProgress[id] = shiftProgress[id] ?? { text: '', tools: [] };
      else delete shiftProgress[id];
      return { shiftProgress };
    });
  },

  applyShiftProgress(id, text, tools) {
    set((s) => ({ shiftProgress: { ...s.shiftProgress, [id]: { text, tools } } }));
  },

  removeLocal(id) {
    set((s) => {
      const workers = { ...s.workers };
      const nextShiftAt = { ...s.nextShiftAt };
      const scorecards = { ...s.scorecards };
      const journals = { ...s.journals };
      const shiftProgress = { ...s.shiftProgress };
      delete workers[id];
      delete nextShiftAt[id];
      delete scorecards[id];
      delete journals[id];
      delete shiftProgress[id];
      return { workers, nextShiftAt, scorecards, journals, shiftProgress };
    });
  },

  openEditor(draft, extras) {
    set({
      draft,
      draftedFlow: extras?.draftedFlow ?? null,
      hireSummary: extras?.hireSummary ?? null,
      error: null,
    });
  },

  closeEditor() {
    set({ draft: null, draftedFlow: null, hireSummary: null, error: null });
  },

  patchDraft(patch) {
    set((s) => (s.draft ? { draft: { ...s.draft, ...patch }, error: null } : {}));
  },

  applyRevision(patch) {
    set((s) => ({
      ...(s.draft && patch.jobDescription
        ? { draft: { ...s.draft, jobDescription: patch.jobDescription } }
        : {}),
      ...(patch.flow ? { draftedFlow: patch.flow } : {}),
      error: null,
    }));
  },

  async save() {
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
      }
      const res = await window.overcli.invoke('workers:save', {
        worker: { ...draft, flowIds },
      });
      if (!res.ok) {
        set({ error: res.error });
        return false;
      }
      // The `workerUpdate` push has already landed the record; just close.
      set({ draft: null, draftedFlow: null, hireSummary: null });
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

  async loadJournal(id) {
    const entries = await window.overcli.invoke('workers:journal', { id });
    set((s) => ({ journals: { ...s.journals, [id]: entries } }));
  },

  clearError() {
    set({ error: null });
  },
}));
