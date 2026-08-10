import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The renderer store calls window.overcli.invoke for IPC. Stub the global
// before importing so the module load doesn't crash in the Node test env.
const mockInvoke = vi.fn();
(globalThis as unknown as Record<string, unknown>).window = {
  overcli: { invoke: mockInvoke },
};

import { useFlowsStore } from './flowsStore';
import type { Flow, FlowRun } from '@shared/flows/schema';

// ─── helpers ──────────────────────────────────────────────────────────────────

function minimalFlow(overrides: Partial<Flow> = {}): Flow {
  return {
    id: 'test-flow',
    name: 'Test Flow',
    input: 'user_prompt',
    participants: [
      { id: 'primary', name: 'Claude Sonnet 4.6', backend: 'claude', model: 'claude-sonnet-4-6', kind: 'primary' },
    ],
    steps: [
      {
        id: 'plan',
        participantId: 'primary',
        role: 'planner',
        inputs: ['user_prompt'],
        tools: ['Read'],
        output: 'plan.md',
      },
    ],
    source: 'user',
    filePath: '/tmp/test.yaml',
    ...overrides,
  };
}

function minimalRun(id: string, flowId = 'test-flow'): FlowRun {
  return {
    id: id as FlowRun['id'],
    flowId,
    flowSnapshot: minimalFlow({ id: flowId }),
    projectPath: '/tmp/project',
    userPrompt: 'do the thing',
    conversationIds: {},
    artifacts: {},
    state: { kind: 'done', success: true },
    createdAt: Date.now(),
    attempts: [],
  };
}

afterEach(() => {
  // Reset every piece of store state between tests.
  useFlowsStore.setState({
    loaded: false,
    flows: [],
    runs: {},
    activeRunId: null,
    editor: { kind: 'idle' },
    editorDraft: null,
    editorSaveError: null,
    justSaved: null,
  });
  vi.clearAllMocks();
});

// ─── openEditor ───────────────────────────────────────────────────────────────

describe('openEditor', () => {
  it('kind:new uses the BLANK_FLOW when no template is provided', () => {
    useFlowsStore.getState().openEditor({ kind: 'new' });
    const { editor, editorDraft } = useFlowsStore.getState();
    expect(editor).toEqual({ kind: 'new' });
    expect(editorDraft).not.toBeNull();
    expect(editorDraft!.id).toBe('new-flow');
  });

  it('kind:new uses the supplied blank template', () => {
    const template = minimalFlow({ id: 'custom', name: 'Custom' });
    useFlowsStore.getState().openEditor({ kind: 'new' }, template);
    expect(useFlowsStore.getState().editorDraft!.id).toBe('custom');
  });

  it('kind:new suffixes the id when a flow with that id already exists', () => {
    // A blank flow always starts as `new-flow`; creating a second one must
    // not reuse the id (the id is the on-disk filename) or it overwrites the
    // first. Existing `new-flow` and `new-flow-2` force a `-3` suffix.
    useFlowsStore.setState({
      flows: [minimalFlow({ id: 'new-flow' }), minimalFlow({ id: 'new-flow-2' })],
    });
    useFlowsStore.getState().openEditor({ kind: 'new' });
    expect(useFlowsStore.getState().editorDraft!.id).toBe('new-flow-3');
  });

  it('kind:new suffixes a colliding template id too', () => {
    useFlowsStore.setState({ flows: [minimalFlow({ id: 'custom' })] });
    useFlowsStore.getState().openEditor({ kind: 'new' }, minimalFlow({ id: 'custom' }));
    expect(useFlowsStore.getState().editorDraft!.id).toBe('custom-2');
  });

  it('kind:new clears editorSaveError', () => {
    useFlowsStore.setState({ editorSaveError: 'prior error' });
    useFlowsStore.getState().openEditor({ kind: 'new' });
    expect(useFlowsStore.getState().editorSaveError).toBeNull();
  });

  it('kind:editing loads a deep clone of the library flow', () => {
    const flow = minimalFlow();
    useFlowsStore.setState({ flows: [flow] });
    useFlowsStore.getState().openEditor({ kind: 'editing', flowId: 'test-flow' });
    const draft = useFlowsStore.getState().editorDraft!;
    expect(draft.id).toBe('test-flow');
    // deep clone — not the same reference
    expect(draft).not.toBe(flow);
  });

  it('kind:editing falls back to idle when the flowId does not exist', () => {
    useFlowsStore.setState({ flows: [] });
    useFlowsStore.getState().openEditor({ kind: 'editing', flowId: 'ghost' });
    expect(useFlowsStore.getState().editor).toEqual({ kind: 'idle' });
    expect(useFlowsStore.getState().editorDraft).toBeNull();
  });

  it('kind:idle clears the draft', () => {
    useFlowsStore.setState({ editorDraft: minimalFlow() });
    useFlowsStore.getState().openEditor({ kind: 'idle' });
    expect(useFlowsStore.getState().editorDraft).toBeNull();
  });
});

// ─── closeEditor ─────────────────────────────────────────────────────────────

describe('closeEditor', () => {
  it('resets to idle and clears draft + error', () => {
    useFlowsStore.setState({ editor: { kind: 'new' }, editorDraft: minimalFlow(), editorSaveError: 'oops' });
    useFlowsStore.getState().closeEditor();
    const s = useFlowsStore.getState();
    expect(s.editor).toEqual({ kind: 'idle' });
    expect(s.editorDraft).toBeNull();
    expect(s.editorSaveError).toBeNull();
  });
});

// ─── updateDraft ─────────────────────────────────────────────────────────────

describe('updateDraft', () => {
  beforeEach(() => {
    useFlowsStore.getState().openEditor({ kind: 'new' });
  });

  it('merges a partial patch into the draft', () => {
    useFlowsStore.getState().updateDraft({ name: 'Renamed Flow', description: 'New desc' });
    const draft = useFlowsStore.getState().editorDraft!;
    expect(draft.name).toBe('Renamed Flow');
    expect(draft.description).toBe('New desc');
    // other fields survive
    expect(draft.id).toBeTruthy();
  });

  it('no-ops when there is no draft', () => {
    useFlowsStore.setState({ editorDraft: null });
    useFlowsStore.getState().updateDraft({ name: 'Ghost' });
    expect(useFlowsStore.getState().editorDraft).toBeNull();
  });
});

// ─── updateStep ──────────────────────────────────────────────────────────────

describe('updateStep', () => {
  beforeEach(() => {
    useFlowsStore.getState().openEditor({ kind: 'new' });
  });

  it('patches the step at the given index', () => {
    useFlowsStore.getState().updateStep(0, { output: 'plan_v2.md' });
    expect(useFlowsStore.getState().editorDraft!.steps[0].output).toBe('plan_v2.md');
  });

  it('leaves other steps untouched', () => {
    // prime the draft with two steps
    useFlowsStore.getState().addStep();
    const idBefore = useFlowsStore.getState().editorDraft!.steps[1].id;
    useFlowsStore.getState().updateStep(0, { output: 'new.md' });
    expect(useFlowsStore.getState().editorDraft!.steps[1].id).toBe(idBefore);
  });

  it('no-ops on an out-of-bounds index', () => {
    const before = useFlowsStore.getState().editorDraft!.steps.slice();
    useFlowsStore.getState().updateStep(99, { output: 'ghost.md' });
    expect(useFlowsStore.getState().editorDraft!.steps).toEqual(before);
  });
});

// ─── addStep / removeStep / moveStep ─────────────────────────────────────────

describe('addStep', () => {
  it('appends a new blank step', () => {
    useFlowsStore.getState().openEditor({ kind: 'new' });
    const before = useFlowsStore.getState().editorDraft!.steps.length;
    useFlowsStore.getState().addStep();
    expect(useFlowsStore.getState().editorDraft!.steps).toHaveLength(before + 1);
  });

  it('new step id reflects the step count', () => {
    useFlowsStore.getState().openEditor({ kind: 'new' });
    useFlowsStore.getState().addStep();
    const steps = useFlowsStore.getState().editorDraft!.steps;
    // The blank step appended at index `before` gets id `step_<before+1>`.
    expect(steps[steps.length - 1].id).toMatch(/^step_\d+$/);
  });
});

describe('removeStep', () => {
  beforeEach(() => {
    useFlowsStore.getState().openEditor({ kind: 'new' });
    useFlowsStore.getState().addStep(); // now 2 steps
  });

  it('removes the step at the given index', () => {
    const firstId = useFlowsStore.getState().editorDraft!.steps[0].id;
    useFlowsStore.getState().removeStep(0);
    expect(useFlowsStore.getState().editorDraft!.steps[0].id).not.toBe(firstId);
  });

  it('no-ops on an out-of-bounds index', () => {
    const before = useFlowsStore.getState().editorDraft!.steps.length;
    useFlowsStore.getState().removeStep(99);
    expect(useFlowsStore.getState().editorDraft!.steps).toHaveLength(before);
  });

  it("drops the removed step's output from later steps' inputs", () => {
    useFlowsStore.setState({
      editorDraft: minimalFlow({
        steps: [
          { id: 'plan', participantId: 'primary', role: 'planner', inputs: ['user_prompt'], tools: [], output: 'plan.md' },
          { id: 'build', participantId: 'primary', role: 'implementer', inputs: ['user_prompt', 'plan.md'], tools: [], output: 'diff' },
        ],
      }),
    });
    useFlowsStore.getState().removeStep(0);
    const steps = useFlowsStore.getState().editorDraft!.steps;
    expect(steps).toHaveLength(1);
    expect(steps[0].id).toBe('build');
    expect(steps[0].inputs).toEqual(['user_prompt']);
  });

  it('keeps the input if another remaining step still produces that output', () => {
    useFlowsStore.setState({
      editorDraft: minimalFlow({
        steps: [
          { id: 'plan_a', participantId: 'primary', role: 'planner', inputs: ['user_prompt'], tools: [], output: 'plan.md' },
          { id: 'plan_b', participantId: 'primary', role: 'planner', inputs: ['user_prompt'], tools: [], output: 'plan.md' },
          { id: 'build', participantId: 'primary', role: 'implementer', inputs: ['plan.md'], tools: [], output: 'diff' },
        ],
      }),
    });
    useFlowsStore.getState().removeStep(0);
    const steps = useFlowsStore.getState().editorDraft!.steps;
    expect(steps.find((s) => s.id === 'build')!.inputs).toEqual(['plan.md']);
  });

  it('clears an onFail goto that targeted the removed step', () => {
    useFlowsStore.setState({
      editorDraft: minimalFlow({
        steps: [
          { id: 'plan', participantId: 'primary', role: 'planner', inputs: ['user_prompt'], tools: [], output: 'plan.md' },
          {
            id: 'build', participantId: 'primary', role: 'implementer', inputs: ['plan.md'], tools: [], output: 'diff',
            onFail: { action: 'goto', target: 'plan', maxRetries: 2 },
          },
        ],
      }),
    });
    useFlowsStore.getState().removeStep(0);
    const build = useFlowsStore.getState().editorDraft!.steps.find((s) => s.id === 'build')!;
    expect(build.onFail).toEqual({ action: 'pause' });
    expect(build.inputs).toEqual([]);
  });
});

describe('moveStep', () => {
  beforeEach(() => {
    useFlowsStore.getState().openEditor({ kind: 'new' });
    // 3 steps: plan, step_2, step_3
    useFlowsStore.getState().addStep();
    useFlowsStore.getState().addStep();
  });

  it('swaps two steps', () => {
    const ids = () => useFlowsStore.getState().editorDraft!.steps.map(s => s.id);
    const [a, b, c] = ids();
    useFlowsStore.getState().moveStep(0, 2);
    expect(ids()).toEqual([b, c, a]);
  });

  it('no-ops on out-of-range indices', () => {
    const before = useFlowsStore.getState().editorDraft!.steps.map(s => s.id);
    useFlowsStore.getState().moveStep(0, 99);
    expect(useFlowsStore.getState().editorDraft!.steps.map(s => s.id)).toEqual(before);
  });
});

// ─── setStepModel ─────────────────────────────────────────────────────────────

describe('setStepModel', () => {
  beforeEach(() => {
    useFlowsStore.getState().openEditor({ kind: 'new' });
  });

  it('reuses an existing participant when the model already has one', () => {
    // The blank flow starts with a 'primary' participant (claude-opus-5).
    // Switching step 0 back to the same model should reuse that participant.
    const { participants } = useFlowsStore.getState().editorDraft!;
    const existingModel = { backend: participants[0].backend, model: participants[0].model };
    useFlowsStore.getState().setStepModel(0, existingModel);
    const draft = useFlowsStore.getState().editorDraft!;
    expect(draft.participants).toHaveLength(participants.length);
    expect(draft.steps[0].participantId).toBe(participants[0].id);
  });

  it('repurposes the current participant when it is the sole owner', () => {
    const newModel = { backend: 'ollama' as const, model: 'qwen2.5-coder:7b' };
    const before = useFlowsStore.getState().editorDraft!.participants.length;
    useFlowsStore.getState().setStepModel(0, newModel);
    const draft = useFlowsStore.getState().editorDraft!;
    // Participant count stays the same — repurposed in place.
    expect(draft.participants).toHaveLength(before);
    const p = draft.participants.find(p => p.id === draft.steps[0].participantId)!;
    expect(p.backend).toBe('ollama');
    expect(p.model).toBe('qwen2.5-coder:7b');
  });

  it('mints a new participant when the current one is shared across steps', () => {
    // Add a second step that also references 'primary'.
    useFlowsStore.getState().addStep();
    useFlowsStore.getState().updateStep(1, { participantId: 'primary' });
    const before = useFlowsStore.getState().editorDraft!.participants.length;
    // Changing step 0's model should mint a new participant since 'primary'
    // is now shared with step 1.
    useFlowsStore.getState().setStepModel(0, { backend: 'codex' as const, model: 'gpt-5.4' });
    const draft = useFlowsStore.getState().editorDraft!;
    expect(draft.participants).toHaveLength(before + 1);
    // step 0 now points to the new participant
    expect(draft.steps[0].participantId).not.toBe('primary');
    // step 1 still points to the original
    expect(draft.steps[1].participantId).toBe('primary');
  });

  it('resolves collision in minted participant ids with a numeric suffix', () => {
    // Force a collision: add a participant whose id will clash with the
    // auto-generated slug.
    useFlowsStore.getState().addStep();
    useFlowsStore.getState().updateStep(1, { participantId: 'primary' });
    // Switch step 0 to codex/gpt-5.4 → id "gpt-5.4"
    useFlowsStore.getState().setStepModel(0, { backend: 'codex' as const, model: 'gpt-5.4' });
    // The participant "gpt-5.4" now exists. Adding step 2 sharing primary and
    // switching step 1 to gpt-5.4 would force a collision → suffix.
    useFlowsStore.getState().addStep();
    useFlowsStore.getState().updateStep(2, { participantId: 'primary' });
    useFlowsStore.getState().setStepModel(1, { backend: 'codex' as const, model: 'gpt-5.4' });
    const draft = useFlowsStore.getState().editorDraft!;
    const ids = draft.participants.map(p => p.id);
    // All ids must be unique.
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ─── applyRunUpdate / removeRun / setActiveRun ───────────────────────────────

describe('applyRunUpdate', () => {
  it('adds a new run to the map', () => {
    const run = minimalRun('r1');
    useFlowsStore.getState().applyRunUpdate(run);
    expect(useFlowsStore.getState().runs['r1']).toEqual(run);
  });

  it('overwrites an existing run with the updated version', () => {
    const run = minimalRun('r1');
    useFlowsStore.getState().applyRunUpdate(run);
    const updated = { ...run, state: { kind: 'aborted' as const } };
    useFlowsStore.getState().applyRunUpdate(updated);
    expect(useFlowsStore.getState().runs['r1'].state.kind).toBe('aborted');
  });
});

describe('removeRun', () => {
  it('removes the run from the map', () => {
    useFlowsStore.getState().applyRunUpdate(minimalRun('r1'));
    useFlowsStore.getState().removeRun('r1');
    expect(useFlowsStore.getState().runs['r1']).toBeUndefined();
  });

  it('clears activeRunId when the removed run was active', () => {
    useFlowsStore.getState().applyRunUpdate(minimalRun('r1'));
    useFlowsStore.setState({ activeRunId: 'r1' });
    useFlowsStore.getState().removeRun('r1');
    expect(useFlowsStore.getState().activeRunId).toBeNull();
  });

  it('keeps activeRunId when a different run is removed', () => {
    useFlowsStore.getState().applyRunUpdate(minimalRun('r1'));
    useFlowsStore.getState().applyRunUpdate(minimalRun('r2'));
    useFlowsStore.setState({ activeRunId: 'r2' });
    useFlowsStore.getState().removeRun('r1');
    expect(useFlowsStore.getState().activeRunId).toBe('r2');
  });
});

describe('setActiveRun', () => {
  it('sets the active run id', () => {
    useFlowsStore.getState().setActiveRun('r42');
    expect(useFlowsStore.getState().activeRunId).toBe('r42');
  });

  it('accepts null to deselect', () => {
    useFlowsStore.setState({ activeRunId: 'r42' });
    useFlowsStore.getState().setActiveRun(null);
    expect(useFlowsStore.getState().activeRunId).toBeNull();
  });
});

// ─── dismissJustSaved ────────────────────────────────────────────────────────

describe('dismissJustSaved', () => {
  it('clears the justSaved banner', () => {
    useFlowsStore.setState({ justSaved: { name: 'My Flow', at: Date.now() } });
    useFlowsStore.getState().dismissJustSaved();
    expect(useFlowsStore.getState().justSaved).toBeNull();
  });
});

// ─── renameFlow ──────────────────────────────────────────────────────────────

describe('renameFlow', () => {
  beforeEach(() => {
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'flows:save') return { ok: true, filePath: '/tmp/test.yaml' };
      if (channel === 'flows:list') return [];
      return undefined;
    });
  });

  it('saves the flow under the new name, keeping its id and layer', async () => {
    const flow = minimalFlow();
    const result = await useFlowsStore.getState().renameFlow(flow, 'Renamed', []);
    expect(result.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith('flows:save', {
      flow: { ...flow, name: 'Renamed' },
      target: 'user',
      projectPath: undefined,
    });
  });

  it('trims the new name', async () => {
    await useFlowsStore.getState().renameFlow(minimalFlow(), '  Padded  ', []);
    const [, args] = mockInvoke.mock.calls.find(([c]) => c === 'flows:save')!;
    expect((args as { flow: Flow }).flow.name).toBe('Padded');
  });

  it('derives the projectPath for a project-layer flow', async () => {
    const flow = minimalFlow({
      source: 'project',
      filePath: '/repos/app/.overcli/flows/test-flow.yaml',
    });
    await useFlowsStore.getState().renameFlow(flow, 'Renamed', []);
    expect(mockInvoke).toHaveBeenCalledWith('flows:save', {
      flow: { ...flow, name: 'Renamed' },
      target: 'project',
      projectPath: '/repos/app',
    });
  });

  it('rejects a blank name without touching disk', async () => {
    const result = await useFlowsStore.getState().renameFlow(minimalFlow(), '   ', []);
    expect(result.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('no-ops when the name is unchanged', async () => {
    const flow = minimalFlow();
    const result = await useFlowsStore.getState().renameFlow(flow, flow.name, []);
    expect(result.ok).toBe(true);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('surfaces a save failure and skips the reload', async () => {
    mockInvoke.mockImplementation(async (channel: string) =>
      channel === 'flows:save' ? { ok: false, error: 'disk full' } : undefined,
    );
    const result = await useFlowsStore.getState().renameFlow(minimalFlow(), 'Renamed', []);
    expect(result).toEqual({ ok: false, error: 'disk full' });
    expect(mockInvoke).not.toHaveBeenCalledWith('flows:list', expect.anything());
  });

  it('reloads with every project path so other projects keep their flows', async () => {
    await useFlowsStore.getState().renameFlow(minimalFlow(), 'Renamed', ['/a', '/b']);
    expect(mockInvoke).toHaveBeenCalledWith('flows:list', { projectPaths: ['/a', '/b'] });
  });
});

// ─── saveDraft ───────────────────────────────────────────────────────────────

describe('saveDraft', () => {
  beforeEach(() => {
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'flows:save') return { ok: true, filePath: '/tmp/test.yaml' };
      if (channel === 'flows:delete') return { ok: true };
      if (channel === 'flows:list') return [];
      return undefined;
    });
  });

  function deleteCalls() {
    return mockInvoke.mock.calls.filter(([c]) => c === 'flows:delete');
  }

  it('removes the old file when the id changed in the same layer', async () => {
    useFlowsStore.setState({ flows: [minimalFlow()] });
    useFlowsStore.getState().openEditor({ kind: 'editing', flowId: 'test-flow' });
    useFlowsStore.getState().updateDraft({ id: 'renamed-flow' });
    await useFlowsStore.getState().saveDraft('user');
    expect(deleteCalls()).toEqual([
      ['flows:delete', { flowId: 'test-flow', source: 'user', projectPath: undefined }],
    ]);
  });

  it('leaves the original alone when only the display name changed', async () => {
    useFlowsStore.setState({ flows: [minimalFlow()] });
    useFlowsStore.getState().openEditor({ kind: 'editing', flowId: 'test-flow' });
    useFlowsStore.getState().updateDraft({ name: 'Renamed' });
    await useFlowsStore.getState().saveDraft('user');
    expect(deleteCalls()).toEqual([]);
  });

  it('leaves the original alone when saving a copy into the other layer', async () => {
    // Different layer = the user deliberately targeted the other layer.
    // That's a copy, not a rename — deleting the source would be data loss.
    useFlowsStore.setState({ flows: [minimalFlow()] });
    useFlowsStore.getState().openEditor({ kind: 'editing', flowId: 'test-flow' });
    useFlowsStore.getState().updateDraft({ id: 'renamed-flow' });
    await useFlowsStore.getState().saveDraft('project', '/repos/app');
    expect(deleteCalls()).toEqual([]);
  });

  it('never deletes when creating a new flow', async () => {
    useFlowsStore.setState({ flows: [minimalFlow()] });
    useFlowsStore.getState().openEditor({ kind: 'new' });
    await useFlowsStore.getState().saveDraft('user');
    expect(deleteCalls()).toEqual([]);
  });

  it('does not delete when the save itself failed', async () => {
    mockInvoke.mockImplementation(async (channel: string) =>
      channel === 'flows:save' ? { ok: false, error: 'nope' } : { ok: true },
    );
    useFlowsStore.setState({ flows: [minimalFlow()] });
    useFlowsStore.getState().openEditor({ kind: 'editing', flowId: 'test-flow' });
    useFlowsStore.getState().updateDraft({ id: 'renamed-flow' });
    const result = await useFlowsStore.getState().saveDraft('user');
    expect(result.ok).toBe(false);
    expect(deleteCalls()).toEqual([]);
  });
});

// ─── saveDraftedFlow ─────────────────────────────────────────────────────────

describe('saveDraftedFlow', () => {
  beforeEach(() => {
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'flows:save') return { ok: true, filePath: '/tmp/saved.yaml' };
      if (channel === 'flows:list') return [];
      return undefined;
    });
  });

  function savePayload() {
    return mockInvoke.mock.calls.find(([c]) => c === 'flows:save')?.[1];
  }

  it('saves an AI draft to the user layer and reports the stored flow', async () => {
    useFlowsStore.setState({ flows: [] });
    const result = await useFlowsStore
      .getState()
      .saveDraftedFlow(minimalFlow({ id: 'review-my-prs' }), []);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flow.id).toBe('review-my-prs');
      expect(result.flow.filePath).toBe('/tmp/saved.yaml');
    }
    expect(savePayload()).toMatchObject({ target: 'user' });
  });

  it('suffixes an id that collides so a second draft cannot overwrite the first', async () => {
    // The drafter derives the id from the description, so drafting "review
    // my PRs" twice produces the same id twice. Without the suffix the
    // second save silently replaces a flow the user already ran.
    useFlowsStore.setState({ flows: [minimalFlow({ id: 'review-my-prs' })] });
    const result = await useFlowsStore
      .getState()
      .saveDraftedFlow(minimalFlow({ id: 'review-my-prs' }), []);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.flow.id).toBe('review-my-prs-2');
    expect(savePayload()).toMatchObject({ flow: { id: 'review-my-prs-2' } });
  });

  it('keeps counting past the first collision', async () => {
    useFlowsStore.setState({
      flows: [minimalFlow({ id: 'audit' }), minimalFlow({ id: 'audit-2' })],
    });
    const result = await useFlowsStore.getState().saveDraftedFlow(minimalFlow({ id: 'audit' }), []);

    if (result.ok) expect(result.flow.id).toBe('audit-3');
  });

  it('forces the user layer even if the draft claims otherwise', async () => {
    // A drafted flow has no file, so `source` is whatever the parser
    // defaulted to. Saving it as 'project' would try to write into a
    // repo's .overcli/flows without a project path.
    useFlowsStore.setState({ flows: [] });
    await useFlowsStore
      .getState()
      .saveDraftedFlow(minimalFlow({ id: 'x', source: 'project' }), []);

    expect(savePayload()).toMatchObject({ target: 'user', flow: { source: 'user' } });
  });

  it('surfaces a save failure without reloading the library', async () => {
    mockInvoke.mockImplementation(async (channel: string) =>
      channel === 'flows:save' ? { ok: false, error: 'disk full' } : [],
    );
    useFlowsStore.setState({ flows: [] });
    const result = await useFlowsStore.getState().saveDraftedFlow(minimalFlow(), []);

    expect(result).toEqual({ ok: false, error: 'disk full' });
    expect(mockInvoke.mock.calls.filter(([c]) => c === 'flows:list')).toEqual([]);
  });

  it('reloads the library so the new flow shows up without a refresh', async () => {
    useFlowsStore.setState({ flows: [] });
    await useFlowsStore.getState().saveDraftedFlow(minimalFlow(), ['/repos/app']);

    expect(mockInvoke.mock.calls.some(([c]) => c === 'flows:list')).toBe(true);
  });
});

// ─── renameRun ───────────────────────────────────────────────────────────────

describe('renameRun', () => {
  beforeEach(() => {
    mockInvoke.mockResolvedValue({ ok: true });
    useFlowsStore.getState().applyRunUpdate(minimalRun('r1'));
  });

  it('patches the run optimistically and tells the main process', async () => {
    await useFlowsStore.getState().renameRun('r1', 'Login work');
    expect(useFlowsStore.getState().runs['r1'].title).toBe('Login work');
    expect(mockInvoke).toHaveBeenCalledWith('flows:renameRun', {
      runId: 'r1',
      title: 'Login work',
    });
  });

  it('trims the title', async () => {
    await useFlowsStore.getState().renameRun('r1', '  Login work  ');
    expect(useFlowsStore.getState().runs['r1'].title).toBe('Login work');
  });

  it('clears the title when handed a blank string', async () => {
    await useFlowsStore.getState().renameRun('r1', 'Login work');
    await useFlowsStore.getState().renameRun('r1', '   ');
    expect(useFlowsStore.getState().runs['r1'].title).toBeUndefined();
    expect(mockInvoke).toHaveBeenLastCalledWith('flows:renameRun', { runId: 'r1', title: '' });
  });

  it('caps an absurdly long title', async () => {
    await useFlowsStore.getState().renameRun('r1', 'x'.repeat(500));
    expect(useFlowsStore.getState().runs['r1'].title).toHaveLength(200);
  });

  it('still calls through for an unknown run so the main process can answer', async () => {
    await useFlowsStore.getState().renameRun('ghost', 'Nope');
    expect(useFlowsStore.getState().runs['ghost']).toBeUndefined();
    expect(mockInvoke).toHaveBeenCalledWith('flows:renameRun', { runId: 'ghost', title: 'Nope' });
  });
});
