// Zustand slice for the flows feature: the library (loaded YAML files),
// the editor's working copy of the flow being edited, and active runs.
//
// Kept separate from the main store + runnersStore so it has its own
// reload cycle and doesn't churn the main store on every flow IPC.

import { create } from 'zustand';

import type { Flow, FlowModelRef, FlowParticipant, FlowRun, FlowStep } from '@shared/flows/schema';
import { flowProjectPath, flowStarKey, MAX_RUN_TITLE_LENGTH } from '@shared/flows/schema';
import type { UUID } from '@shared/types';
import { friendlyModelLabel as friendlyModelLabelImported, isSupportedPremiumModel } from '@shared/modelCatalog';

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
  /// Whether startup's `flows:listRuns` has landed. Anything that reasons
  /// about a MISSING run — the Workers work queue calls those orphaned — has
  /// to wait for this, or every run looks missing for the first half second.
  runsLoaded: boolean;
  /// Ids of `done` runs whose worktree still holds uncommitted work nobody
  /// has reviewed. Kept PARALLEL to `runs` rather than on the run itself:
  /// `applyRunUpdate` replaces a run wholesale with the main process's
  /// un-enriched copy, so a field on FlowRun would be wiped by the next
  /// rename/artifact event. Populated by `flows:listRuns` at fetch time.
  unreviewedRunIds: Record<string, true>;
  /// Which run is currently shown in the active run pane.
  activeRunId: string | null;
  /// runId → when the user last opened it. The sidebar's Active section
  /// orders rows by what the user last touched, and opening a run counts;
  /// the run's own progress does not. In-memory only — it's a this-session
  /// notion of "what I'm working on", and a restart starts that over.
  lastOpenedAtByRun: Record<string, number>;
  /// Which segment of the Flows library is showing. Lives here rather than as
  /// local state in the pane so the title bar's schedule indicator can deep-
  /// link straight into Schedules from any tab.
  librarySegment: 'flows' | 'runs' | 'schedules';
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
  /// Live worktree-preparation progress during a launch, keyed by the
  /// target `projectPath`. Set from the main `flowLaunchProgress` event and
  /// read by the launching pane to label its spinner; cleared when the
  /// launch resolves.
  launchProgress: Record<string, { completed: number; total: number; message: string }>;
}

interface FlowsActions {
  reload(projectPaths: string[]): Promise<void>;
  /// Patch the in-memory map for a single run (used by main event
  /// `flowRunUpdate`).
  applyRunUpdate(run: FlowRun): void;
  /// Merge many runs in ONE store update. Startup hydration (`flows:listRuns`)
  /// returns every persisted run; applying them one-by-one fired a separate
  /// `set` (and re-render of every `runs` subscriber) per run, so opening the
  /// Flows view with N runs did O(N) renders. Batching collapses that to one.
  applyRunsBulk(runs: FlowRun[]): void;
  /// Replace the set of done-but-unreviewed run ids. Authoritative, not
  /// merged — the main process recomputes it from `git status` on every
  /// `flows:listRuns`, so a run that has since been committed or cleaned
  /// must be able to drop back out of the set.
  applyUnreviewedRuns(ids: string[]): void;
  removeRun(id: string): void;
  /// Set (or clear, with `null`) the worktree-prep progress for a launch
  /// target. Called from the `flowLaunchProgress` main event and reset by
  /// the launching pane when its `startRun` resolves.
  setLaunchProgress(
    projectPath: string,
    progress: { completed: number; total: number; message: string } | null,
  ): void;
  setActiveRun(id: string | null): void;
  setLibrarySegment(segment: 'flows' | 'runs' | 'schedules'): void;
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
  /// Rename a flow from the library list — display name only. The id (and
  /// therefore the file on disk, the star key, and every recorded run's
  /// `flowId`) is left alone, so a rename never orphans anything. Changing
  /// the id is the editor's job; see `saveDraft`. `projectPaths` is the
  /// full set the library is showing, so the post-rename reload doesn't
  /// drop other projects' flows.
  renameFlow(
    flow: Flow,
    name: string,
    projectPaths: string[],
  ): Promise<{ ok: boolean; error?: string }>;
  dismissJustSaved(): void;
  /// Set (or clear) the per-participant model override for a run. Pass
  /// `null` to revert to the participant's declared model. Persists on the
  /// run in the main process and drives ALL subsequent turns for that
  /// participant (orchestration, finalize, question-answers, hijack), so
  /// it survives a restart. Optimistically patches the in-memory run so
  /// the UI reflects the change before the main-process round-trip lands.
  setParticipantModelOverride(runId: string, participantId: string, model: string | null): Promise<void>;
  /// Rename a run (display title only — see `flowRunTitle`). Allowed at
  /// any point, including while the run is mid-step: nothing in the
  /// runtime reads the title. Pass an empty string to drop back to the
  /// prompt-derived title. Optimistic, then reconciled by the main
  /// process's `flowRunUpdate`.
  renameRun(runId: string, title: string): Promise<void>;
  /// Stamp "the user just typed at this run" so the sidebar orders it by
  /// that rather than by when it was launched. Fire-and-forget: the turn it
  /// accompanies has already gone out, and a failed stamp is a stale sort
  /// order, not a lost message.
  noteUserTurn(runId: string): void;
  /// Queue a course correction for the next step of a running flow. Pass an
  /// empty string to withdraw one. Not optimistic — the main process guards
  /// on run state and echoes the authoritative run back.
  steerRun(runId: string, text: string): Promise<{ ok: boolean; error?: string }>;
  /// Persist an AI-drafted flow straight from a launch surface, bypassing
  /// the editor. The launch screens draft a flow and run it in one motion;
  /// routing that through the editor tab would make the user save, navigate
  /// back, and find the flow again just to do the thing they already asked
  /// for. Saves to the user layer (available in every project, like the
  /// drafted intent implies) and returns the flow AS SAVED — the id can
  /// differ from the draft's when it collided with an existing flow.
  saveDraftedFlow(
    flow: Flow,
    projectPaths: string[],
  ): Promise<{ ok: true; flow: Flow } | { ok: false; error: string }>;
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
      name: 'Claude Opus 5',
      backend: 'claude',
      model: 'claude-opus-5',
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

/// Ensure a brand-new flow's id doesn't collide with one already in the
/// library. The id becomes the on-disk filename (`<id>.yaml`), so two flows
/// sharing an id overwrite each other on save — which is exactly what a
/// blank flow (constant id `new-flow`) did when created repeatedly. Suffix
/// `-2`, `-3`, … until free. Only applied when opening a *new* flow; editing
/// an existing flow keeps its id.
function uniqueFlowId(desired: string, existing: Flow[]): string {
  const taken = new Set(existing.map((f) => f.id));
  if (!taken.has(desired)) return desired;
  let n = 2;
  while (taken.has(`${desired}-${n}`)) n += 1;
  return `${desired}-${n}`;
}

/// The registry fetch currently in flight, so overlapping callers join it
/// instead of each firing their own. The library and start-page search boxes
/// both call `browseRegistries` from an effect guarded on `registryLoaded`,
/// which only flips once the fetch RESOLVES — so typing "review" would
/// otherwise fire five index fetches before the first came back. Only
/// unforced calls share; a `force` refresh is an explicit "get me fresh
/// data" and must never be answered by an in-flight cached read.
let registryFetch: Promise<void> | null = null;

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
  runsLoaded: false,
  unreviewedRunIds: {},
  activeRunId: null,
  lastOpenedAtByRun: {},
  librarySegment: 'flows',
  editor: { kind: 'idle' },
  editorDraft: null,
  editorSaveError: null,
  justSaved: null,
  registryEntries: [],
  registryLoaded: false,
  registryErrors: [],
  launchProgress: {},

  async reload(projectPaths) {
    const flows = await window.overcli.invoke('flows:list', { projectPaths });
    // Main returns these sorted by id, which is the filename on disk and is
    // editable independently of the name — so a list ordered by it only looks
    // alphabetical until someone renames a flow without renaming its file.
    // Sort by the string every surface actually renders: the picker in the
    // schedule editor, the Orchestrator's flow-per-candidate select, and the
    // library's own groups all take this order as given and none re-sort.
    flows.sort(
      (a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
        a.id.localeCompare(b.id),
    );
    set({ flows, loaded: true });
  },

  applyRunUpdate(run) {
    set(s => ({ runs: { ...s.runs, [run.id]: run } }));
  },

  applyRunsBulk(runs) {
    // The flag flips even for an empty list: no runs at all is a loaded state,
    // and treating it as "still loading" would leave dangling items looking
    // merely slow forever.
    if (runs.length === 0) {
      set({ runsLoaded: true });
      return;
    }
    set(s => {
      const next = { ...s.runs };
      for (const r of runs) next[r.id] = r;
      return { runs: next, runsLoaded: true };
    });
  },

  applyUnreviewedRuns(ids) {
    set({ unreviewedRunIds: Object.fromEntries(ids.map(id => [id, true as const])) });
  },

  removeRun(id) {
    set(s => {
      if (!(id in s.runs)) return {};
      const { [id]: _drop, ...rest } = s.runs;
      const { [id]: _dropDirty, ...restDirty } = s.unreviewedRunIds;
      return {
        runs: rest,
        unreviewedRunIds: restDirty,
        activeRunId: s.activeRunId === id ? null : s.activeRunId,
      };
    });
  },

  setLaunchProgress(projectPath, progress) {
    set(s => {
      if (!progress) {
        if (!(projectPath in s.launchProgress)) return {};
        const { [projectPath]: _drop, ...rest } = s.launchProgress;
        return { launchProgress: rest };
      }
      return { launchProgress: { ...s.launchProgress, [projectPath]: progress } };
    });
  },

  setActiveRun(id) {
    // Switching runs re-roots the side-file editor (App.tsx passes the
    // active run's projectPath as the root override) at the new run's
    // worktree, so a file left open from the previous run would be
    // re-resolved against the wrong one. This used to close the editor
    // outright; each run is now its own editor tab scope, so `useFileScope`
    // swaps in the incoming run's own files instead — no stale path, and
    // coming back to a run brings its files back with it.
    set((s) => ({
      activeRunId: id,
      lastOpenedAtByRun: id
        ? { ...s.lastOpenedAtByRun, [id]: Date.now() }
        : s.lastOpenedAtByRun,
    }));
  },

  setLibrarySegment(segment) {
    set({ librarySegment: segment });
  },

  openEditor(target, blank) {
    if (target.kind === 'new') {
      const flow = blank ? cloneFlow(blank) : cloneFlow(BLANK_FLOW);
      // Give the new flow a collision-free id so saving it creates a new
      // file instead of overwriting an existing flow that shares the id
      // (blank flows all start as `new-flow`; templates reuse the template
      // id). The user can still rename it in the editor before saving.
      flow.id = uniqueFlowId(flow.id, get().flows);
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
      const [removed] = steps.splice(index, 1);

      // Clean up references to the removed step so the remaining steps stay
      // valid. Drop its output from later steps' inputs (unless another
      // remaining step still produces an artifact by that name), and clear
      // any onFail goto that targeted the removed step.
      const stillProduced = new Set(
        steps.map((st) => st.output).filter(Boolean),
      );
      const cleaned = steps.map((st) => {
        let next = st;
        if (removed.output && !stillProduced.has(removed.output) && st.inputs.includes(removed.output)) {
          next = { ...next, inputs: next.inputs.filter((ref) => ref !== removed.output) };
        }
        if (next.onFail?.action === 'goto' && next.onFail.target === removed.id) {
          next = { ...next, onFail: { action: 'pause' } };
        }
        return next;
      });

      return { editorDraft: { ...s.editorDraft, steps: cleaned } };
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
      if (model.backend !== 'ollama' && !isSupportedPremiumModel(model.backend, model.model)) {
        return {};
      }
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
    const editor = get().editor;
    // The flow as it was before this edit, when we're editing an existing
    // one. Needed below to finish an id rename: `flows:save` writes
    // `<new-id>.yaml` but knows nothing about the file the flow used to
    // live in.
    const original =
      editor.kind === 'editing'
        ? get().flows.find((f) => f.id === editor.flowId)
        : undefined;
    const result = await window.overcli.invoke('flows:save', {
      flow: draft,
      target,
      projectPath,
    });
    if (!result.ok) {
      set({ editorSaveError: result.error });
      return { ok: false, error: result.error };
    }
    // Renaming the id renames the file: the new one is written above, so
    // remove the old one or the library shows the flow twice. Deliberately
    // scoped to a same-layer id change — saving into the *other* layer is a
    // copy (the user picked a different target), not a rename, so it must
    // not delete anything.
    if (original && original.id !== draft.id && original.source === target) {
      await window.overcli.invoke('flows:delete', {
        flowId: original.id,
        source: original.source,
        projectPath: flowProjectPath(original) ?? projectPath,
      });
      // Stars are keyed by `source:id`, so carry the old key over rather
      // than silently unstarring the flow the user just renamed. Lazy
      // import — store.ts imports this module, so a static one would cycle.
      // Star bookkeeping is cosmetic; never let it fail the save.
      void import('./store')
        .then(async ({ useStore }) => {
          const state = useStore.getState();
          const starred = state.settings.starredFlows ?? [];
          const oldKey = flowStarKey(original);
          if (!starred.includes(oldKey)) return;
          const newKey = flowStarKey({ source: target, id: draft.id });
          const next = starred.filter((k) => k !== oldKey);
          if (!next.includes(newKey)) next.push(newKey);
          await state.saveSettings({ ...state.settings, starredFlows: next });
        })
        .catch(() => {});
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

  async renameFlow(flow, name, projectPaths) {
    const trimmed = name.trim();
    if (!trimmed) return { ok: false, error: 'Flow name cannot be empty.' };
    if (trimmed === flow.name) return { ok: true };
    const projectPath = flowProjectPath(flow);
    if (flow.source === 'project' && !projectPath) {
      return { ok: false, error: `Could not resolve the project for "${flow.filePath}".` };
    }
    const result = await window.overcli.invoke('flows:save', {
      flow: { ...flow, name: trimmed },
      target: flow.source,
      projectPath,
    });
    if (!result.ok) return { ok: false, error: result.error };
    await get().reload(projectPaths);
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
      if (!participant) return {};
      if (participant.backend !== 'ollama' && model && !isSupportedPremiumModel(participant.backend, model)) {
        return {};
      }
      const next = { ...(run.modelOverrides ?? {}) };
      const trimmed = model?.trim();
      if (!trimmed || trimmed === participant?.model) delete next[participantId];
      else next[participantId] = trimmed;
      const modelOverrides = Object.keys(next).length > 0 ? next : undefined;
      return { runs: { ...s.runs, [runId]: { ...run, modelOverrides } } };
    });
    await window.overcli.invoke('flows:setModelOverride', { runId, participantId, model });
  },

  async renameRun(runId, title) {
    const trimmed = title.trim().slice(0, MAX_RUN_TITLE_LENGTH);
    // Optimistic so the row settles instantly; the main process echoes an
    // authoritative flowRunUpdate that reconciles.
    set((s) => {
      const run = s.runs[runId];
      if (!run) return {};
      return { runs: { ...s.runs, [runId]: { ...run, title: trimmed || undefined } } };
    });
    await window.overcli.invoke('flows:renameRun', { runId: runId as UUID, title: trimmed });
  },

  noteUserTurn(runId) {
    const at = Date.now();
    // Optimistic so the row moves under the pointer the moment the message
    // is sent, not a round-trip later; the main process echoes an
    // authoritative flowRunUpdate that reconciles.
    set((s) => {
      const run = s.runs[runId];
      if (!run) return {};
      return { runs: { ...s.runs, [runId]: { ...run, lastUserTurnAt: at } } };
    });
    // A renderer-only reload leaves the main process on a build without this
    // channel, and `invoke` REJECTS when no handler is registered. The stamp
    // is cosmetic, so swallow it rather than surfacing an unhandled rejection.
    void Promise.resolve(window.overcli.invoke('flows:noteUserTurn', { runId: runId as UUID })).catch(
      () => {},
    );
  },

  async steerRun(runId, text) {
    try {
      const res = await window.overcli.invoke('flows:steerRun', { runId: runId as UUID, text });
      return res.ok ? { ok: true } : { ok: false, error: res.error };
    } catch (err) {
      // `ipcRenderer.invoke` REJECTS when no handler is registered — which is
      // exactly what a renderer-only reload looks like, since the main process
      // keeps running the build that predates this channel. Without this catch
      // the rejection is swallowed and the button appears to do nothing at all.
      const message = err instanceof Error ? err.message : String(err);
      return message.includes('No handler registered')
        ? { ok: false, error: 'Restart the app to pick up this feature — the main process is running an older build.' }
        : { ok: false, error: message };
    }
  },

  async saveDraftedFlow(flow, projectPaths) {
    // Dedupe the id against the library: the drafter derives it from the
    // description, so drafting "review my PRs" twice would otherwise have
    // the second save silently overwrite the first.
    const saved: Flow = { ...flow, id: uniqueFlowId(flow.id, get().flows), source: 'user' };
    const result = await window.overcli.invoke('flows:save', { flow: saved, target: 'user' });
    if (!result.ok) return { ok: false as const, error: result.error };
    const stored: Flow = { ...saved, filePath: result.filePath };
    await get().reload(projectPaths);
    return { ok: true as const, flow: stored };
  },

  async browseRegistries(force) {
    if (!force && registryFetch) return registryFetch;
    const run = (async () => {
      const res = await window.overcli.invoke('flows:browseRegistry', { force: !!force });
      set({ registryEntries: res.entries, registryErrors: res.errors, registryLoaded: true });
    })();
    registryFetch = run;
    // Clear on settle, not just success: a failed fetch that left the handle
    // set would wedge the search box on "loading" for the rest of the session.
    try {
      await run;
    } finally {
      if (registryFetch === run) registryFetch = null;
    }
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
