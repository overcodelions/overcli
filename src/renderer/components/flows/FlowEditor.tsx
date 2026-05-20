// Flow builder editor. Vertical list of step cards + a flow-header card +
// a right-side YAML preview pane.
//
// Phase 3 fills out the full editor; Phase 2 ships a working
// name/description editor + a YAML hand-edit textarea so users can save
// flows from day one. The proper card UI comes in the next phase.

import { useEffect, useMemo, useState } from 'react';

import { useFlowsStore } from '../../flowsStore';
import { useStore } from '../../store';
import { serializeFlow } from '@shared/flows/yaml';
import { validateFlow } from '@shared/flows/validation';
import { FlowStepCard } from './FlowStepCard';
import { FlowPipelineDiagram } from './FlowPipelineDiagram';
import { FlowParticipantsCard } from './FlowParticipantsCard';

/// DOM id for a step's card. Used by the pipeline diagram to scroll the
/// clicked step into view.
function stepCardDomId(stepId: string): string {
  return `flow-step-card-${stepId}`;
}

export function FlowEditor() {
  const projects = useStore((s) => s.projects);
  const editor = useFlowsStore((s) => s.editor);
  const draft = useFlowsStore((s) => s.editorDraft);
  const closeEditor = useFlowsStore((s) => s.closeEditor);
  const updateDraft = useFlowsStore((s) => s.updateDraft);
  const saveDraft = useFlowsStore((s) => s.saveDraft);
  const addStep = useFlowsStore((s) => s.addStep);
  const saveError = useFlowsStore((s) => s.editorSaveError);

  const [target, setTarget] = useState<'user' | 'project'>('user');
  const [selectedProject, setSelectedProject] = useState<string>(projects[0]?.path ?? '');
  const [yamlMode, setYamlMode] = useState(false);
  const [yamlText, setYamlText] = useState('');
  const [saving, setSaving] = useState(false);
  const [showYaml, setShowYaml] = useState(false);

  const yaml = useMemo(() => (draft ? serializeFlow(draft) : ''), [draft]);
  const validation = useMemo(() => (draft ? validateFlow(draft) : null), [draft]);

  // Sync the YAML textarea to the draft when not in yaml-mode (so switching
  // out of structured mode reflects current edits) — when in yaml mode we
  // let the user own the text.
  useEffect(() => {
    if (!yamlMode) setYamlText(yaml);
  }, [yaml, yamlMode]);

  if (!draft) {
    return (
      <div className="p-6 text-sm text-ink-muted">
        No draft. Pick a flow from the library or create a new one.
      </div>
    );
  }

  async function handleSave() {
    setSaving(true);
    try {
      await saveDraft(target, target === 'project' ? selectedProject : undefined);
      // On success the store closes the editor + sets justSaved, so this
      // component unmounts and the library shows the confirmation banner.
      // On failure the store keeps the editor open and sets editorSaveError.
    } finally {
      setSaving(false);
    }
  }

  function scrollToStep(stepId: string) {
    const el = document.getElementById(stepCardDomId(stepId));
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function applyYaml() {
    if (!draft) return;
    let result;
    try {
      result = await window.overcli.invoke('flows:validate', {
        yaml: yamlText,
        id: draft.id,
      });
    } catch (err) {
      alert('Could not validate YAML: ' + (err instanceof Error ? err.message : String(err)));
      return;
    }
    if (!result.ok) {
      alert('YAML errors:\n' + result.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n'));
      return;
    }
    updateDraft({
      name: result.flow.name,
      description: result.flow.description,
      steps: result.flow.steps,
    });
    setYamlMode(false);
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="flex items-center gap-3 mb-4">
        <button
          onClick={closeEditor}
          className="text-xs text-ink-faint hover:text-ink px-2 py-1 rounded hover:bg-white/5"
        >
          ← Library
        </button>
        <div className="text-2xl font-semibold">
          {editor.kind === 'new' ? 'New flow' : 'Edit flow'}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value as 'user' | 'project')}
            className="text-xs bg-card-strong rounded px-2 py-1"
          >
            <option value="user">User (available everywhere)</option>
            <option value="project">Project (.overcli/flows/)</option>
          </select>
          {target === 'project' && (
            <select
              value={selectedProject}
              onChange={(e) => setSelectedProject(e.target.value)}
              className="text-xs bg-card-strong rounded px-2 py-1"
            >
              <option value="">Pick a project…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.path}>{p.name}</option>
              ))}
            </select>
          )}
          <button
            onClick={handleSave}
            disabled={saving || (target === 'project' && !selectedProject) || !validation?.ok}
            className="text-xs px-3 py-1.5 rounded-md bg-accent text-white hover:opacity-90 disabled:opacity-50"
            title={!validation?.ok ? 'Fix validation errors before saving.' : undefined}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {saveError && (
        <div className="text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded p-3 mb-4">
          {saveError}
        </div>
      )}

      {/* Two-column layout: left = flow body (pipeline, header card,
          participants, step cards, validation). Right = sticky YAML
          pane that's always visible alongside the structured editor.
          Left column is narrower-than-default on the YAML side
          (`minmax(280px,360px)`) so the pipeline + step cards get the
          horizontal room they need without a separate full-width row. */}
      <div className="grid grid-cols-[1fr_minmax(280px,360px)] gap-6 items-start">
        {/* LEFT */}
        <div className="min-w-0 space-y-4">
          {/* Pipeline diagram at the top of the editable area. */}
          <FlowPipelineDiagram flow={draft} onStepClick={scrollToStep} />

          {/* Header card — name + description front-and-center, id tucked
              underneath as the slug it really is. Borderless surface
              that reads as elevation against the page bg; same pattern
              as ChangesBar / the composer at the bottom of chat. */}
          <div className="rounded-xl bg-card p-5 shadow-sm">
            <div className="text-[10px] uppercase tracking-[0.18em] text-ink-faint mb-2">
              Flow
            </div>
            <input
              value={draft.name}
              onChange={(e) => updateDraft({ name: e.target.value })}
              placeholder="Untitled flow"
              className="w-full bg-transparent text-2xl font-semibold text-ink placeholder:text-ink-faint focus:outline-none mb-1.5"
            />
            <textarea
              value={draft.description ?? ''}
              onChange={(e) => updateDraft({ description: e.target.value })}
              rows={2}
              placeholder="What does this flow do? (1–2 sentences)"
              className="w-full bg-transparent text-sm text-ink-muted placeholder:text-ink-faint focus:outline-none resize-none mb-3"
            />
            <div className="flex items-center gap-2 mt-3">
              <span className="text-[10px] uppercase tracking-wider text-ink-faint">id</span>
              <input
                value={draft.id}
                onChange={(e) => updateDraft({ id: e.target.value })}
                className="bg-card-strong rounded px-2 py-1 text-xs font-mono min-w-[180px] focus:outline-none"
              />
              <span className="text-[10px] text-ink-faint">filename on disk</span>
            </div>
          </div>

          {/* Participants — the cast of the flow */}
          <FlowParticipantsCard />

          {/* Steps section */}
          <div>
            <div className="flex items-center mb-3">
              <div className="text-sm font-semibold">Steps</div>
              <span className="ml-2 text-[11px] text-ink-faint">
                {draft.steps.length} {draft.steps.length === 1 ? 'step' : 'steps'}
              </span>
              <button
                onClick={addStep}
                className="ml-auto text-xs px-2.5 py-1 rounded bg-card hover:bg-card-strong border border-card-strong"
              >
                + Add step
              </button>
            </div>
            <div className="space-y-4">
              {draft.steps.map((step, i) => (
                <div
                  key={`${step.id}-${i}`}
                  id={stepCardDomId(step.id)}
                  className="relative"
                >
                  {/* Numbered badge that sits over the card's top-left
                      corner — easier to scan than a number-in-header. */}
                  <div className="absolute -left-3 -top-3 z-10 w-7 h-7 rounded-full bg-accent text-white text-xs font-bold flex items-center justify-center shadow-md">
                    {i + 1}
                  </div>
                  <div className="rounded-xl bg-card shadow-sm">
                    <FlowStepCard index={i} step={step} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {validation && !validation.ok && (
            <div className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">
              <div className="font-semibold mb-1">Fix before saving</div>
              <ul className="space-y-0.5">
                {validation.errors.map((e, i) => (
                  <li key={i}>
                    <span className="text-amber-200">{e.path}</span>: {e.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* RIGHT — sticky YAML pane */}
        <aside className="sticky top-2 self-start">
          <div className="rounded-xl bg-card overflow-hidden shadow-sm">
            <div className="flex items-center gap-2 px-3 py-2 bg-card-strong">
              <div className="text-xs font-semibold text-ink">YAML</div>
              <span className="text-[10px] text-ink-faint">canonical form</span>
              <div className="ml-auto flex items-center gap-1">
                <button
                  onClick={() => setYamlMode((m) => !m)}
                  className="text-[11px] text-ink-faint hover:text-ink px-2 py-0.5 rounded hover:bg-white/5"
                >
                  {yamlMode ? 'View only' : 'Edit'}
                </button>
                {yamlMode && (
                  <button
                    onClick={applyYaml}
                    className="text-[11px] text-emerald-300 hover:text-emerald-200 px-2 py-0.5 rounded hover:bg-white/5"
                  >
                    Apply →
                  </button>
                )}
              </div>
            </div>
            <textarea
              value={yamlMode ? yamlText : yaml}
              onChange={(e) => yamlMode && setYamlText(e.target.value)}
              readOnly={!yamlMode}
              rows={28}
              spellCheck={false}
              className="w-full bg-transparent p-3 text-[11px] font-mono leading-relaxed text-ink focus:outline-none resize-none"
            />
          </div>
        </aside>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-[11px] uppercase tracking-wider text-ink-faint mb-1">{label}</div>
      {children}
    </label>
  );
}
