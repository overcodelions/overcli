// Zustand slice for the flows feature: the library (loaded YAML files),
// the editor's working copy of the flow being edited, and active runs.
//
// Kept separate from the main store + runnersStore so it has its own
// reload cycle and doesn't churn the main store on every flow IPC.

import { create } from 'zustand';

import type { Flow, FlowModelRef, FlowParticipant, FlowRun, FlowStep } from '@shared/flows/schema';
import { friendlyModelLabel as friendlyModelLabelImported } from '@shared/modelCatalog';

/// Pointer to the flow currently open in the editor. `'new'` is the
/// "blank" state (no flow yet — fields render empty/defaults).
export type EditorTarget = { kind: 'idle' } | { kind: 'new' } | { kind: 'editing'; flowId: string };

interface FlowsState {
  /// Whether the library has been loaded at least once.
  loaded: boolean;
  /// All flows (user + project), keyed by id, project layer winning.
  flows: Flow[];
  /// In-progress + recently completed runs, keyed by runId.
  runs: Record<string, FlowRun>;
  /// Which run is currently shown in the active run pane.
  activeRunId: string | null;
  /// Editor target — drives FlowEditor render.
  editor: EditorTarget;
  /// Working copy of the flow being edited. Lifted out of the library so
  /// edits don't churn the library list until save.
  editorDraft: Flow | null;
  /// Last save error, if any — surfaced as a banner in the editor.
  editorSaveError: string | null;
  /// Transient success state: the name of the flow that was just saved
  /// + a timestamp. The library shows a "✓ Saved {name}" banner that
  /// fades after a few seconds. Cleared by `dismissJustSaved`.
  justSaved: { name: string; at: number } | null;
  registryEntries: import('@shared/types').FlowRegistryEntry[];
  registryLoaded: boolean;
  registryErrors: Array<{ registryId: string; error: string }>;
}

interface FlowsActions {
  reload(projectPaths: string[]): Promise<void>;
  /// Patch the in-memory map for a single run (used by main event
  /// `flowRunUpdate`).
  applyRunUpdate(run: FlowRun): void;
  removeRun(id: string): void;
  setActiveRun(id: string | null): void;
  openEditor(target: EditorTarget, blank?: Flow): void;
  closeEditor(): void;
  updateDraft(patch: Partial<Flow>): void;
  updateStep(index: number, patch: Partial<FlowStep>): void;
  addStep(): void;
  removeStep(index: number): void;
  moveStep(from: number, to: number): void;
  /// Bridge for the legacy step-level model picker. Routes the change
  /// through the step's participant so the participant-based runtime
  /// sees the new model. If the step doesn't yet have a participant, we
  /// synthesize one keyed by backend+model.
  setStepModel(index: number, model: FlowModelRef): void;
  saveDraft(target: 'user' | 'project', projectPath?: string): Promise<{ ok: boolean; error?: string }>;
  dismissJustSaved(): void;
  /// Set (or clear) the per-participant model override for a run. Pass
  /// `null` to revert to the participant's declared model. Persists on the
  /// run in the main process and drives ALL subsequent turns for that
  /// participant (orchestration, finalize, question-answers, hijack), so
  /// it survives a restart. Optimistically patches the in-memory run so
  /// the UI reflects the change before the main-process round-trip lands.
  setParticipantModelOverride(runId: string, participantId: string, model: string | null): Promise<void>;
  browseRegistries(force?: boolean): Promise<void>;
  installFromRegistry(args: { registryId: string; id: string; version: string }): Promise<{ ok: boolean; error?: string }>;
  previewRegistryFlow(args: { registryId: string; id: string; version: string }): Promise<{ ok: true; flow: Flow } | { ok: false; error: string }>;
}

export type FlowsStore = FlowsState & FlowsActions;

const BLANK_FLOW: Flow = {
  id: 'new-flow',
  name: 'New flow',
  description: '',
  input: 'user_prompt',
  participants: [
    {
      id: 'primary',
      name: 'Claude Opus 4.7',
      backend: 'claude',
      model: 'claude-opus-4-7',
      kind: 'primary',
    },
  ],
  steps: [
    {
      id: 'plan',
      participantId: 'primary',
      role: 'planner',
      inputs: ['user_prompt'],
      tools: ['Read', 'Grep', 'Glob'],
      output: 'plan.md',
    },
  ],
  source: 'user',
  filePath: '',
};

function cloneFlow(flow: Flow): Flow {
  return JSON.parse(JSON.stringify(flow));
}

/// Friendly auto-name for a synthesized participant. Uses the shared
/// model catalog's `friendlyModelLabel` so the auto-name matches what
/// users see in pickers ("Claude Sonnet 4.6", "GPT-5.4 mini",
/// "gemma4:26b (local)") instead of the raw model id.
function friendlyName(model: FlowModelRef): string {
  // Lazy import — flowsStore is renderer code, the catalog is shared,
  // no cycle risk.
  return friendlyModelLabelImported(model.backend, model.model);
}

/// Shorter participant id than the full backend+model slug. Keeps the
/// Participants list scannable. Examples:
///   - claude/claude-opus-4-7 → "opus-4-7"
///   - codex/gpt-5.4-mini     → "gpt-5.4-mini"
///   - ollama/gemma4:26b      → "gemma4-26b"
function shortParticipantId(model: FlowModelRef): string {
  let base = model.model.toLowerCase();
  if (model.backend === 'claude') base = base.replace(/^claude-/, '');
  base = base.replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return base.slice(0, 24) || 'participant';
}

function blankStep(idx: number): FlowStep {
  // New blank steps default to the flow's first participant. Callers
  // that know the flow can override this with the participant the user
  // actually picks; we always need SOMETHING valid so the type stays
  // sound and the validator doesn't complain immediately.
  return {
    id: `step_${idx + 1}`,
    participantId: 'primary',
    role: 'custom',
    inputs: [],
    tools: [],
    output: `out_${idx + 1}.md`,
  };
}

export const useFlowsStore = create<FlowsStore>((set, get) => ({
  loaded: false,
  flows: [],
  runs: {},
  activeRunId: null,
  editor: { kind: 'idle' },
  editorDraft: null,
  editorSaveError: null,
  justSaved: null,
  registryEntries: [],
  registryLoaded: false,
  registryErrors: [],

  async reload(projectPaths) {
    const flows = await window.overcli.invoke('flows:list', { projectPaths });
    set({ flows, loaded: true });
  },

  applyRunUpdate(run) {
    set(s => ({ runs: { ...s.runs, [run.id]: run } }));
  },

  removeRun(id) {
    set(s => {
      if (!(id in s.runs)) return {};
      const { [id]: _drop, ...rest } = s.runs;
      return {
        runs: rest,
        activeRunId: s.activeRunId === id ? null : s.activeRunId,
      };
    });
  },

  setActiveRun(id) {
    set({ activeRunId: id });
  },

  openEditor(target, blank) {
    if (target.kind === 'new') {
      const flow = blank ? cloneFlow(blank) : cloneFlow(BLANK_FLOW);
      set({ editor: target, editorDraft: flow, editorSaveError: null });
      return;
    }
    if (target.kind === 'editing') {
      const flow = get().flows.find(f => f.id === target.flowId);
      if (!flow) {
        set({ editor: { kind: 'idle' }, editorDraft: null });
        return;
      }
      set({ editor: target, editorDraft: cloneFlow(flow), editorSaveError: null });
      return;
    }
    set({ editor: { kind: 'idle' }, editorDraft: null, editorSaveError: null });
  },

  closeEditor() {
    set({ editor: { kind: 'idle' }, editorDraft: null, editorSaveError: null });
  },

  updateDraft(patch) {
    set(s => (s.editorDraft ? { editorDraft: { ...s.editorDraft, ...patch } } : {}));
  },

  updateStep(index, patch) {
    set(s => {
      if (!s.editorDraft) return {};
      const steps = s.editorDraft.steps.slice();
      if (index < 0 || index >= steps.length) return {};
      steps[index] = { ...steps[index], ...patch };
      return { editorDraft: { ...s.editorDraft, steps } };
    });
  },

  addStep() {
    set(s => {
      if (!s.editorDraft) return {};
      const steps = s.editorDraft.steps.slice();
      steps.push(blankStep(steps.length));
      return { editorDraft: { ...s.editorDraft, steps } };
    });
  },

  removeStep(index) {
    set(s => {
      if (!s.editorDraft) return {};
      const steps = s.editorDraft.steps.slice();
      if (index < 0 || index >= steps.length) return {};
      steps.splice(index, 1);
      return { editorDraft: { ...s.editorDraft, steps } };
    });
  },

  moveStep(from, to) {
    set(s => {
      if (!s.editorDraft) return {};
      const steps = s.editorDraft.steps.slice();
      if (from < 0 || from >= steps.length || to < 0 || to >= steps.length) return {};
      const [moved] = steps.splice(from, 1);
      steps.splice(to, 0, moved);
      return { editorDraft: { ...s.editorDraft, steps } };
    });
  },

  setStepModel(index, model) {
    set(s => {
      if (!s.editorDraft) return {};
      const draft = s.editorDraft;
      const steps = draft.steps.slice();
      let participants = draft.participants.slice();
      const step = steps[index];
      if (!step) return {};

      // Try to find an existing participant matching the requested model.
      const existing = participants.find(
        (p) => p.backend === model.backend && p.model === model.model,
      );
      let participantId: string;
      if (existing) {
        participantId = existing.id;
      } else {
        // If the step's CURRENT participant is solely owned by this step
        // (no other step references it), edit it in place instead of
        // minting a new one. Keeps the participant list from accumulating
        // orphans as the user cycles through model choices.
        const currentParticipant = participants.find((p) => p.id === step.participantId);
        const stepsUsingCurrent = steps.filter((s2) => s2.participantId === currentParticipant?.id);
        const canRepurpose =
          currentParticipant && stepsUsingCurrent.length === 1 && stepsUsingCurrent[0] === step;
        if (canRepurpose) {
          participantId = currentParticipant.id;
          participants = participants.map((p) =>
            p.id === currentParticipant.id
              ? { ...p, backend: model.backend, model: model.model, name: friendlyName(model) }
              : p,
          );
        } else {
          // Mint a new participant for this model. Id is a short
          // human-readable slug derived from the model; collisions get
          // suffixed with `-N`.
          const baseId = shortParticipantId(model);
          let id = baseId;
          let n = 2;
          while (participants.some((p) => p.id === id)) {
            id = `${baseId}-${n++}`;
          }
          participants.push({
            id,
            name: friendlyName(model),
            backend: model.backend,
            model: model.model,
          });
          participantId = id;
        }
      }

      steps[index] = { ...step, participantId, model };
      return { editorDraft: { ...draft, steps, participants } };
    });
  },

  async saveDraft(target, projectPath) {
    const draft = get().editorDraft;
    if (!draft) return { ok: false, error: 'No draft to save.' };
    const result = await window.overcli.invoke('flows:save', {
      flow: draft,
      target,
      projectPath,
    });
    if (!result.ok) {
      set({ editorSaveError: result.error });
      return { ok: false, error: result.error };
    }
    // Reload the library so the saved flow appears, then return to the
    // library view with a transient "Saved" banner so the user gets a
    // clear confirmation instead of a silent toggle into edit mode.
    const projectPaths = projectPath ? [projectPath] : [];
    await get().reload(projectPaths);
    set({
      editor: { kind: 'idle' },
      editorDraft: null,
      editorSaveError: null,
      justSaved: { name: draft.name, at: Date.now() },
    });
    return { ok: true };
  },

  dismissJustSaved() {
    set({ justSaved: null });
  },

  async setParticipantModelOverride(runId, participantId, model) {
    // Optimistic local patch so the picker + badge update instantly; the
    // main process emits an authoritative flowRunUpdate that reconciles.
    set((s) => {
      const run = s.runs[runId];
      if (!run) return {};
      const participant = run.flowSnapshot.participants?.find((p) => p.id === participantId);
      const next = { ...(run.modelOverrides ?? {}) };
      const trimmed = model?.trim();
      if (!trimmed || trimmed === participant?.model) delete next[participantId];
      else next[participantId] = trimmed;
      const modelOverrides = Object.keys(next).length > 0 ? next : undefined;
      return { runs: { ...s.runs, [runId]: { ...run, modelOverrides } } };
    });
    await window.overcli.invoke('flows:setModelOverride', { runId, participantId, model });
  },

  async browseRegistries(force) {
    const res = await window.overcli.invoke('flows:browseRegistry', { force: !!force });
    set({ registryEntries: res.entries, registryErrors: res.errors, registryLoaded: true });
  },

  async previewRegistryFlow(args) {
    return await window.overcli.invoke('flows:previewRegistryFlow', args);
  },

  async installFromRegistry(args) {
    const res = await window.overcli.invoke('flows:installFromRegistry', args);
    if (!res.ok) return { ok: false, error: res.error };
    await get().reload([]);
    return { ok: true };
  },
}));
