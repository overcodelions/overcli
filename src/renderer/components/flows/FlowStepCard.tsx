// Editor card for a single FlowStep. The simplified version: friendly
// labels, grouped model picker, verb-based tool checkboxes, single
// "Trust this step" toggle for permission, and rebound/on_fail tucked
// behind a "Show advanced" disclosure. The schema underneath is the
// same — this is purely how it's surfaced.

import { useEffect, useMemo, useState } from 'react';

import type { Backend } from '@shared/types';
import { resolveStepModel, type FlowStep, type FlowToolDescriptor } from '@shared/flows/schema';
import { ROLE_PROMPTS } from '@shared/flows/roles';
import { PREMIUM_MODELS, friendlyModelLabel, modelSpeed, modelTierLabel } from '@shared/modelCatalog';
import { reachableInputRefs, gotoCandidateStepIds } from '@shared/flows/validation';
import { useFlowsStore } from '../../flowsStore';

interface ModelChoice {
  /// Backend + model concatenated as `${backend}:${model}` for use as the
  /// stable form value.
  value: string;
  /// Friendly label like "Claude Opus 4.7".
  label: string;
  /// Tier the picker groups by.
  tier: 'Premium' | 'Local' | 'Other';
  /// Underlying backend so picking the option restores `step.model`.
  backend: Backend;
  /// Underlying model id.
  model: string;
}

/// Build the full premium-tier choice list from the shared catalog so
/// the flow editor stays in sync with WelcomePane + ParticipantsCard.
/// Fast models get a ⚡ marker prefix so users can spot the cheap/quick
/// tier at a glance in the dropdown.
const PREMIUM_CHOICES: ModelChoice[] = (
  Object.entries(PREMIUM_MODELS) as Array<[Exclude<Backend, 'ollama'>, string[]]>
).flatMap(([backend, models]) =>
  models.map((model) => {
    const baseLabel = friendlyModelLabel(backend, model);
    const speed = modelSpeed(model);
    const marker = speed === 'fast' ? '⚡ ' : '';
    return {
      backend,
      model,
      label: `${marker}${baseLabel}`,
      tier: modelTierLabel(backend),
      value: `${backend}:${model}`,
    };
  }),
);

/// Internal tool id → friendly verb label. Anything not in the map shows
/// its raw id as-is.
const TOOL_LABELS: Record<string, string> = {
  // Claude family
  Read: 'Read files',
  Write: 'Create new files',
  Edit: 'Edit code',
  Bash: 'Run shell commands',
  Grep: 'Search file contents',
  Glob: 'Find files by name',
  WebFetch: 'Fetch from the web',
  Task: 'Spawn a sub-agent',
  // Ollama family
  read_file: 'Read files',
  list_dir: 'List directories',
  grep: 'Search file contents',
  write_file: 'Create new files',
  edit_file: 'Edit code',
  bash: 'Run shell commands',
};

const WRITE_TOOL_IDS = new Set(['Write', 'Edit', 'Bash', 'bash', 'write_file', 'edit_file']);

function modelChoiceForStep(ollamaModels: string[]): ModelChoice[] {
  const choices: ModelChoice[] = [
    ...PREMIUM_CHOICES,
    ...ollamaModels.map(
      (m): ModelChoice => ({
        backend: 'ollama',
        model: m,
        label: `${m} (local)`,
        tier: 'Local',
        value: `ollama:${m}`,
      }),
    ),
  ];
  return choices;
}

export function FlowStepCard({ index, step }: { index: number; step: FlowStep }) {
  const flow = useFlowsStore((s) => s.editorDraft);
  const updateStep = useFlowsStore((s) => s.updateStep);
  const removeStep = useFlowsStore((s) => s.removeStep);
  const moveStep = useFlowsStore((s) => s.moveStep);
  const setStepModel = useFlowsStore((s) => s.setStepModel);
  // Resolve the step's effective model (participant first, legacy fall-
  // back). Drives both the picker value and the tool-catalog probe.
  const effective = flow ? resolveStepModel(flow, step) : { backend: 'claude' as Backend, model: '' };
  const [showAdvanced, setShowAdvanced] = useState(
    !!step.rebound || step.onFail?.action === 'goto' || step.role === 'custom',
  );
  const [tools, setTools] = useState<FlowToolDescriptor[]>([]);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [ollamaDetectError, setOllamaDetectError] = useState<string | null>(null);

  useEffect(() => {
    void window.overcli
      .invoke('flows:toolCatalog', { backend: effective.backend })
      .then(setTools);
  }, [effective.backend]);

  async function refreshOllama() {
    setOllamaDetectError(null);
    try {
      const r = await window.overcli.invoke('ollama:detect');
      setOllamaModels(r.models.map((m) => m.name));
      if (!r.installed) setOllamaDetectError('Ollama not installed.');
      else if (!r.running) setOllamaDetectError('Ollama installed but not running.');
      else if (r.models.length === 0) setOllamaDetectError('No local models pulled yet.');
    } catch (err) {
      setOllamaDetectError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void refreshOllama();
  }, []);

  const allModelChoices = useMemo(
    () => modelChoiceForStep(ollamaModels),
    [ollamaModels],
  );

  // Group choices by tier for the optgroup labels.
  const groupedChoices = useMemo(() => {
    const groups: Record<string, ModelChoice[]> = {};
    for (const c of allModelChoices) {
      (groups[c.tier] ??= []).push(c);
    }
    return groups;
  }, [allModelChoices]);

  if (!flow) return null;

  const availableInputs = reachableInputRefs(flow, index);
  const availableGotoTargets = gotoCandidateStepIds(flow, index);
  const hasWriteTools = step.tools.some((t) => WRITE_TOOL_IDS.has(t));
  const trusted = !step.permissionMode || step.permissionMode === 'bypassPermissions';

  function patch(p: Partial<FlowStep>) {
    updateStep(index, p);
  }

  return (
    <div className="p-4 pl-6">
      {/* Header — id + reorder + remove */}
      <div className="flex items-center gap-2 mb-3">
        <span className="text-[11px] text-ink-faint w-6 text-center">{index + 1}</span>
        <input
          value={step.id}
          onChange={(e) => patch({ id: e.target.value })}
          className="bg-card-strong rounded px-2 py-1 text-sm font-semibold w-40"
          placeholder="step name"
        />
        <div className="ml-auto flex items-center gap-1">
          <SmallButton onClick={() => moveStep(index, index - 1)} disabled={index === 0}>↑</SmallButton>
          <SmallButton onClick={() => moveStep(index, index + 1)} disabled={index === flow.steps.length - 1}>↓</SmallButton>
          <SmallButton onClick={() => removeStep(index)} danger>×</SmallButton>
        </div>
      </div>

      {/* Run by — assign the step to one of the flow's declared
          participants. Participants own a persistent conversation
          across every step they run; the picker here is just the
          assignment. To use a different model, declare a new
          participant in the Participants section above (or pick a
          model from the fallback group, which synthesizes one). */}
      <Field label="Run by">
        <select
          value={step.participantId || ''}
          onChange={(e) => {
            const v = e.target.value;
            if (v.startsWith('__new_model__:')) {
              // Sentinel value — user picked a supported model from the
              // catalog; route through setStepModel which mints (or
              // repurposes) a participant for them.
              const compound = v.slice('__new_model__:'.length);
              const pick = allModelChoices.find((c) => c.value === compound);
              if (pick) setStepModel(index, { backend: pick.backend, model: pick.model });
              return;
            }
            patch({ participantId: v });
          }}
          className="w-full bg-card-strong rounded px-2 py-1.5 text-sm"
        >
          <option value="">(pick a participant)</option>
          {flow.participants.length > 0 && (
            <optgroup label="Declared participants">
              {flow.participants.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {p.backend}:{p.model}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="Or pick a model (creates a participant)">
            {Object.entries(groupedChoices).map(([tier, list]) =>
              list.map((c) => (
                <option key={`new:${c.value}`} value={`__new_model__:${c.value}`}>
                  {c.label}
                </option>
              )),
            )}
          </optgroup>
        </select>
        <div className="text-[11px] text-ink-faint mt-1">
          {flow.participants.length === 0
            ? 'No participants declared yet. Add one in Participants above, or pick a supported model below.'
            : `Currently running ${effective.backend}:${effective.model || '(none)'}. ` +
              `Edit models / add participants in Participants above.`}
          {ollamaDetectError && <span className="text-amber-700 dark:text-amber-300"> · {ollamaDetectError}</span>}{' '}
          <button
            onClick={() => void refreshOllama()}
            className="text-ink-faint hover:text-ink underline-offset-2 hover:underline"
          >
            refresh local
          </button>
        </div>
      </Field>

      {/* Role — friendly dropdown; system prompt hidden unless advanced */}
      <Field label="Role" className="mt-3">
        <select
          value={step.role}
          onChange={(e) => {
            const role = e.target.value as FlowStep['role'];
            patch({ role, systemPromptOverride: undefined });
          }}
          className="w-full bg-card-strong rounded px-2 py-1.5 text-sm"
        >
          <option value="planner">Plan the work</option>
          <option value="plan-reviewer">Review the plan (before implementation)</option>
          <option value="implementer">Implement the plan</option>
          <option value="reviewer">Review the work (after implementation)</option>
          <option value="test-writer">Write tests</option>
          <option value="researcher">Research / gather context</option>
          <option value="shipper">Commit, push, open PR</option>
          <option value="technical-writer">Write documentation</option>
          <option value="editor">Edit / polish a draft</option>
          <option value="debugger">Debug / find root cause</option>
          <option value="code-reader">Read / survey code</option>
          <option value="code-reviewer">Review a code change</option>
          <option value="security-reviewer">Security review</option>
          <option value="adversarial-reviewer">Adversarial review</option>
          <option value="custom">Custom (write your own prompt)</option>
        </select>
      </Field>

      {/* Output + inputs */}
      <div className="grid grid-cols-2 gap-3 mt-3">
        <Field label="Produces">
          <input
            value={step.output}
            onChange={(e) => patch({ output: e.target.value })}
            className="w-full bg-card-strong rounded px-2 py-1.5 text-sm font-mono"
            placeholder="plan.md"
          />
          <div className="text-[11px] text-ink-faint mt-0.5">A name later steps can reference.</div>
        </Field>
        <Field label="Reads from">
          <div className="flex flex-wrap gap-1.5 min-h-[34px] p-1 bg-card rounded border border-card-strong">
            {availableInputs.map((ref) => {
              const checked = step.inputs.includes(ref);
              const friendly = ref === 'user_prompt' ? "your request" : ref;
              return (
                <label
                  key={ref}
                  className={
                    'text-[11px] px-2 py-0.5 rounded cursor-pointer border ' +
                    (checked
                      ? 'border-accent bg-accent/20 text-ink'
                      : 'border-card-strong hover:bg-card-strong')
                  }
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={checked}
                    onChange={() => {
                      const next = checked
                        ? step.inputs.filter((x) => x !== ref)
                        : [...step.inputs, ref];
                      patch({ inputs: next });
                    }}
                  />
                  {friendly}
                </label>
              );
            })}
            {availableInputs.length === 0 && (
              <span className="text-[11px] text-ink-faint">No inputs available yet.</span>
            )}
          </div>
        </Field>
      </div>

      {/* Tools as verbs. Only meaningful for Ollama: overcli dispatches
          its tool calls itself, so the allowlist is enforced at the
          dispatch boundary. For Claude/Codex/Gemini/Copilot, the CLI
          owns the tool surface — the only gate the flow can apply is
          the permission mode, which controls whether the user gets
          prompted per call vs. autonomous. */}
      {effective.backend === 'ollama' ? (
        <Field label="Allowed actions" className="mt-3">
          <div className="flex flex-wrap gap-1.5">
            {tools.map((t) => {
              const checked = step.tools.includes(t.id);
              const friendly = TOOL_LABELS[t.id] ?? t.displayName;
              return (
                <label
                  key={t.id}
                  title={t.available ? t.description : t.unavailableReason}
                  className={
                    'text-[11px] px-2 py-1 rounded border ' +
                    (!t.available
                      ? 'border-card-strong bg-card/40 text-ink-faint cursor-not-allowed'
                      : checked
                        ? 'border-accent bg-accent/20 text-ink cursor-pointer'
                        : 'border-card-strong bg-card hover:bg-card-strong cursor-pointer')
                  }
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={checked}
                    disabled={!t.available}
                    onChange={() => {
                      const next = checked
                        ? step.tools.filter((x) => x !== t.id)
                        : [...step.tools, t.id];
                      patch({ tools: next });
                    }}
                  />
                  {friendly}
                </label>
              );
            })}
          </div>
        </Field>
      ) : (
        <Field label="Tool access" className="mt-3">
          <div className="text-[11px] text-ink-faint leading-relaxed">
            {effective.backend} controls its own tool surface. Use the permission
            mode below to gate it — &ldquo;Ask before each action&rdquo; prompts
            you per call, &ldquo;Allow edits&rdquo; auto-approves writes,
            &ldquo;Trust everything&rdquo; runs autonomous.
          </div>
        </Field>
      )}

      {/* Permission + pause — both columns share a Field wrapper so the
          uppercase labels + input rows line up on the same baseline. */}
      <div className="grid grid-cols-2 gap-3 mt-3 pt-3 border-t border-card">
        <Field label="Permission mode">
          <select
            value={step.permissionMode ?? ''}
            onChange={(e) =>
              patch({
                permissionMode: (e.target.value || undefined) as FlowStep['permissionMode'],
              })
            }
            className="w-full bg-card-strong rounded px-2 py-1.5 text-sm"
          >
            <option value="">Auto (sensible default for this backend)</option>
            <option value="plan">Plan only (no edits)</option>
            <option value="default">Ask before each action</option>
            <option value="acceptEdits">Allow edits, ask on bash</option>
            <option value="auto">Auto (Claude-only)</option>
            <option value="bypassPermissions">Trust everything (autonomous)</option>
          </select>
          <div className="text-[11px] text-ink-faint mt-0.5">
            {effective.backend === 'ollama'
              ? hasWriteTools
                ? 'Write tools enabled — Auto resolves to Trust everything so the step runs unattended.'
                : 'No write tools selected — Auto resolves to Ask before each action.'
              : 'Auto resolves to Trust everything for autonomous runs. Drop to Ask/Allow edits if you want to intervene per action.'}
          </div>
        </Field>
        <Field label="Pause before this step">
          <label className="flex items-center gap-2 text-xs cursor-pointer bg-card-strong rounded px-2 py-[7px]">
            <input
              type="checkbox"
              checked={step.pauseBefore ?? false}
              disabled={index === 0}
              onChange={(e) => patch({ pauseBefore: e.target.checked || undefined })}
            />
            <span>Wait for me before running this step</span>
          </label>
          <div className="text-[11px] text-ink-faint mt-0.5">
            {index === 0
              ? 'First step — nothing to review yet.'
              : step.pauseBefore
              ? 'Run will stop here so you can review the prior step before continuing.'
              : 'Runs automatically when the previous step finishes.'}
          </div>
        </Field>
      </div>

      {/* Advanced disclosure */}
      <button
        onClick={() => setShowAdvanced((v) => !v)}
        className="mt-3 text-[11px] text-ink-faint hover:text-ink"
      >
        {showAdvanced ? '▼' : '▶'} Advanced (prompt, retry, critic)
      </button>

      {showAdvanced && (
        <div className="mt-3 space-y-3 border-t border-card pt-3">
          <Field label="System prompt">
            <textarea
              value={
                step.systemPromptOverride ??
                (step.role !== 'custom' ? ROLE_PROMPTS[step.role] : '')
              }
              onChange={(e) =>
                patch({ systemPromptOverride: e.target.value, role: 'custom' })
              }
              rows={5}
              className="w-full bg-card-strong rounded p-2 text-xs font-mono"
            />
            <div className="text-[11px] text-ink-faint mt-0.5">
              Editing flips the role to "Custom".
            </div>
          </Field>

          <Field label="If the step fails">
            <select
              value={step.onFail?.action ?? 'pause'}
              onChange={(e) => {
                const action = e.target.value as 'pause' | 'goto' | 'abort';
                if (action === 'pause') patch({ onFail: { action: 'pause' } });
                else if (action === 'abort') patch({ onFail: { action: 'abort' } });
                else
                  patch({
                    onFail: {
                      action: 'goto',
                      target:
                        step.onFail?.action === 'goto'
                          ? step.onFail.target
                          : availableGotoTargets[0] ?? '',
                      maxRetries:
                        step.onFail?.action === 'goto' ? step.onFail.maxRetries : 2,
                    },
                  });
              }}
              className="w-full bg-card-strong rounded px-2 py-1.5 text-sm"
            >
              <option value="pause">Pause for me</option>
              <option value="goto">Retry a different step</option>
              <option value="abort">Stop the whole run</option>
            </select>
          </Field>

          {step.onFail?.action === 'goto' && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Go back to">
                <select
                  value={step.onFail.target}
                  onChange={(e) =>
                    patch({
                      onFail: {
                        ...step.onFail!,
                        action: 'goto',
                        target: e.target.value,
                      } as FlowStep['onFail'],
                    })
                  }
                  className="w-full bg-card-strong rounded px-2 py-1.5 text-sm"
                >
                  <option value="">(pick step)</option>
                  {availableGotoTargets.map((id) => (
                    <option key={id} value={id}>{id}</option>
                  ))}
                </select>
              </Field>
              <Field label="Max retries">
                <input
                  type="number"
                  min={1}
                  value={step.onFail.maxRetries}
                  onChange={(e) =>
                    patch({
                      onFail: {
                        ...step.onFail!,
                        action: 'goto',
                        maxRetries: parseInt(e.target.value, 10) || 1,
                      } as FlowStep['onFail'],
                    })
                  }
                  className="w-full bg-card-strong rounded px-2 py-1.5 text-sm"
                />
              </Field>
            </div>
          )}

          <ReboundEditor step={step} onPatch={patch} />
        </div>
      )}
    </div>
  );
}

function ReboundEditor({
  step,
  onPatch,
}: {
  step: FlowStep;
  onPatch: (p: Partial<FlowStep>) => void;
}) {
  const enabled = !!step.rebound;
  return (
    <div>
      <label className="inline-flex items-center gap-2 text-xs mb-2 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            if (e.target.checked) {
              onPatch({
                rebound: {
                  critic: { backend: 'claude', model: 'claude-sonnet-5' },
                  mode: 'review',
                  maxIters: 2,
                },
              });
            } else {
              onPatch({ rebound: undefined });
            }
          }}
        />
        <span className="font-semibold">Have another model critique this step</span>
      </label>
      {enabled && step.rebound && (
        <div className="grid grid-cols-3 gap-2 ml-6">
          <Field label="Critic backend">
            <select
              value={step.rebound.critic.backend}
              onChange={(e) =>
                onPatch({
                  rebound: {
                    ...step.rebound!,
                    critic: {
                      backend: e.target.value as Backend,
                      model: step.rebound!.critic.model,
                    },
                  },
                })
              }
              className="w-full bg-card-strong rounded px-2 py-1 text-xs"
            >
              {(['claude', 'codex', 'gemini', 'copilot', 'ollama'] as Backend[]).map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </Field>
          <Field label="Critic model">
            <input
              value={step.rebound.critic.model}
              onChange={(e) =>
                onPatch({
                  rebound: {
                    ...step.rebound!,
                    critic: { ...step.rebound!.critic, model: e.target.value },
                  },
                })
              }
              className="w-full bg-card-strong rounded px-2 py-1 text-xs"
            />
          </Field>
          <Field label="Max iterations">
            <input
              type="number"
              min={1}
              value={step.rebound.maxIters}
              onChange={(e) =>
                onPatch({
                  rebound: {
                    ...step.rebound!,
                    maxIters: parseInt(e.target.value, 10) || 1,
                  },
                })
              }
              className="w-full bg-card-strong rounded px-2 py-1 text-xs"
            />
          </Field>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={'block ' + (className ?? '')}>
      <div className="text-[11px] uppercase tracking-wider text-ink-faint mb-1">{label}</div>
      {children}
    </label>
  );
}

function SmallButton({
  onClick,
  children,
  disabled,
  danger,
}: {
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={
        'text-[11px] w-6 h-6 rounded flex items-center justify-center ' +
        (disabled
          ? 'text-ink-faint cursor-not-allowed'
          : danger
            ? 'text-red-700 dark:text-red-300 hover:bg-red-500/20'
            : 'text-ink-muted hover:bg-card-strong hover:text-ink')
      }
    >
      {children}
    </button>
  );
}
