// Static validation for a Flow definition. Run before save (in the builder)
// and again at run launch. Errors are surfaced inline in the editor with a
// path pointer to the offending field; the same checks gate `flows:save`
// and `flows:startRun` server-side so an unedited hand-written YAML can't
// boot the runtime into a bad state.

import { FLOW_USER_PROMPT_REF, resolveStepModel, type Flow, type FlowStep } from './schema';
import { isSupportedPremiumModel } from '../modelCatalog';
import { isKnownRolePreset } from './roles';

export interface FlowValidationError {
  /// Dotted path to the field for editor highlight. Examples:
  /// `'name'`, `'steps[1].inputs[0]'`, `'steps[2].onFail.target'`.
  path: string;
  message: string;
}

export interface FlowValidationResult {
  ok: boolean;
  errors: FlowValidationError[];
}

/// Flow ids and step ids are slugs: lowercase, no path separators or dots.
/// Exported so storage-layer path resolution can reject a malformed id
/// before it reaches the filesystem (a flow id becomes a filename).
export const SLUG_RE = /^[a-z][a-z0-9_-]*$/;
/// Artifact (step `output`) names: a single token of letters, digits, dot,
/// dash, underscore. Exported so the AI drafter can both steer the model
/// toward valid names and repair near-misses (see `sanitizeArtifactName`).
export const ARTIFACT_NAME_RE = /^[a-zA-Z0-9._-]+$/;

/// Coerce a free-text artifact name into one that satisfies
/// `ARTIFACT_NAME_RE`: collapse any run of disallowed characters (spaces,
/// slashes, punctuation) to a single underscore and trim leading/trailing
/// separators. Returns '' if nothing usable remains. Used to salvage drafted
/// flows where the model emitted e.g. "audit report" instead of "audit_report".
export function sanitizeArtifactName(name: string): string {
  return name
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '');
}

export function validateFlow(flow: Flow): FlowValidationResult {
  const errors: FlowValidationError[] = [];

  if (!flow.name?.trim()) {
    errors.push({ path: 'name', message: 'Flow name is required.' });
  }
  if (!flow.id?.trim()) {
    errors.push({ path: 'id', message: 'Flow id is required.' });
  } else if (!SLUG_RE.test(flow.id)) {
    errors.push({
      path: 'id',
      message: 'Flow id must be lowercase letters, digits, hyphens, or underscores.',
    });
  }
  if (flow.input !== FLOW_USER_PROMPT_REF) {
    errors.push({ path: 'input', message: `Flow input must be "${FLOW_USER_PROMPT_REF}" (v1 only supports this).` });
  }
  if (!Array.isArray(flow.steps) || flow.steps.length === 0) {
    errors.push({ path: 'steps', message: 'Flow must have at least one step.' });
    return { ok: false, errors };
  }

  // Track step ids and the artifact names that have been produced *by the
  // time the step at this index runs*. The earliest a name becomes
  // referenceable is right after the producing step completes — so when
  // we validate step N, we look at outputs from steps 0..N-1.
  const stepIdSet = new Set<string>();
  const seenIds = new Set<string>();
  for (let i = 0; i < flow.steps.length; i++) {
    const step = flow.steps[i];
    const base = `steps[${i}]`;
    if (!step.id?.trim()) {
      errors.push({ path: `${base}.id`, message: 'Step id is required.' });
    } else if (!SLUG_RE.test(step.id)) {
      errors.push({
        path: `${base}.id`,
        message: 'Step id must be lowercase letters, digits, hyphens, or underscores.',
      });
    } else if (seenIds.has(step.id)) {
      errors.push({ path: `${base}.id`, message: `Duplicate step id "${step.id}".` });
    } else {
      seenIds.add(step.id);
      stepIdSet.add(step.id);
    }

    // Resolve the step's effective model (participant lookup, then legacy
    // step.model fallback). Empty backend/model surface as errors here
    // so the user sees them in the editor rather than at run time.
    const effective = resolveStepModel(flow, step);
    if (!effective.backend) {
      errors.push({ path: `${base}.model.backend`, message: 'Step backend is required.' });
    }
    if (!effective.model.trim()) {
      errors.push({ path: `${base}.model.model`, message: 'Step model is required.' });
    }
    if (step.participantId && !flow.participants?.some((p) => p.id === step.participantId)) {
      errors.push({
        path: `${base}.participantId`,
        message: `Step references unknown participant "${step.participantId}".`,
      });
    }
    if (step.role === 'custom' && !step.systemPromptOverride?.trim()) {
      errors.push({
        path: `${base}.systemPromptOverride`,
        message: 'Custom role requires a system prompt.',
      });
    } else if (step.role !== 'custom' && !isKnownRolePreset(step.role)) {
      // Without this the step resolves to no preset body and runs with the
      // literal system prompt "undefined" — a silent failure at run time.
      errors.push({
        path: `${base}.role`,
        message: `Unknown role "${step.role}". Use a preset, or "custom" with a system prompt.`,
      });
    }
    if (!step.output?.trim()) {
      errors.push({ path: `${base}.output`, message: 'Step output name is required.' });
    } else if (!ARTIFACT_NAME_RE.test(step.output)) {
      errors.push({
        path: `${base}.output`,
        message: 'Output name may only contain letters, digits, dot, dash, underscore.',
      });
    }
    if (i === 0 && step.pauseBefore) {
      errors.push({
        path: `${base}.pauseBefore`,
        message: 'First step cannot have pause_before — there are no prior artifacts to review.',
      });
    }
  }

  for (let i = 0; i < (flow.participants ?? []).length; i++) {
    const participant = flow.participants[i];
    const base = `participants[${i}]`;
    if (!participant.backend) {
      errors.push({ path: `${base}.backend`, message: 'Participant backend is required.' });
      continue;
    }
    if (!participant.model?.trim()) {
      errors.push({ path: `${base}.model`, message: 'Participant model is required.' });
      continue;
    }
    if (participant.backend !== 'ollama' && !isSupportedPremiumModel(participant.backend, participant.model)) {
      errors.push({
        path: `${base}.model`,
        message: `Model "${participant.model}" is not supported for backend "${participant.backend}".`,
      });
    }
  }

  // Multiple steps may produce the same artifact name (e.g. `build` writes
  // `diff`, then `tests` extends `diff` with new test files). Later writes
  // overwrite earlier ones in the run's artifact map; step `inputs` always
  // resolve to the most recently produced artifact under that name. No
  // validation needed.

  // Build the set of valid input refs available to each step.
  let consumesUserPrompt = false;
  const availableInputs = new Set<string>([FLOW_USER_PROMPT_REF]);
  for (let i = 0; i < flow.steps.length; i++) {
    const step = flow.steps[i];
    const base = `steps[${i}]`;
    if (!Array.isArray(step.inputs)) {
      errors.push({ path: `${base}.inputs`, message: 'Step inputs must be an array.' });
    } else {
      step.inputs.forEach((ref, j) => {
        if (ref === FLOW_USER_PROMPT_REF) consumesUserPrompt = true;
        if (!availableInputs.has(ref)) {
          errors.push({
            path: `${base}.inputs[${j}]`,
            message: `Input "${ref}" does not exist yet at this step. ` +
              `It must be "user_prompt" or the output of an earlier step.`,
          });
        }
      });
    }

    if (step.onFail?.action === 'goto') {
      if (!step.onFail.target) {
        errors.push({
          path: `${base}.onFail.target`,
          message: 'Goto target is required.',
        });
      } else if (!stepIdSet.has(step.onFail.target)) {
        errors.push({
          path: `${base}.onFail.target`,
          message: `Goto target "${step.onFail.target}" is not a known step id.`,
        });
      }
      if (!Number.isFinite(step.onFail.maxRetries) || step.onFail.maxRetries < 1) {
        errors.push({
          path: `${base}.onFail.maxRetries`,
          message: 'Goto maxRetries must be at least 1.',
        });
      }
    }

    if (step.rebound) {
      if (!step.rebound.critic?.model?.trim() || !step.rebound.critic?.backend) {
        errors.push({
          path: `${base}.rebound.critic`,
          message: 'Rebound critic backend + model are required.',
        });
      } else if (
        step.rebound.critic.backend !== 'ollama' &&
        !isSupportedPremiumModel(step.rebound.critic.backend, step.rebound.critic.model)
      ) {
        errors.push({
          path: `${base}.rebound.critic.model`,
          message: `Model "${step.rebound.critic.model}" is not supported for backend "${step.rebound.critic.backend}".`,
        });
      }
      if (!Number.isFinite(step.rebound.maxIters) || step.rebound.maxIters < 1) {
        errors.push({
          path: `${base}.rebound.maxIters`,
          message: 'Rebound maxIters must be at least 1.',
        });
      }
    }

    // After this step has run, its output is available to later steps.
    if (step.output) availableInputs.add(step.output);
  }

  if (!consumesUserPrompt) {
    errors.push({
      path: 'steps',
      message: 'At least one step must consume "user_prompt".',
    });
  }

  return { ok: errors.length === 0, errors };
}

/// Convenience that returns the array of refs reachable by `stepIndex`.
/// Used by the builder to populate the inputs multi-select.
export function reachableInputRefs(flow: Flow, stepIndex: number): string[] {
  const refs: string[] = [FLOW_USER_PROMPT_REF];
  for (let i = 0; i < stepIndex && i < flow.steps.length; i++) {
    const name = flow.steps[i].output;
    if (name) refs.push(name);
  }
  return refs;
}

/// Convenience that returns the array of step ids reachable as `goto` targets
/// from `stepIndex`. Goto targets must already exist in the flow (any step,
/// including later ones, since they're navigated to by id).
export function gotoCandidateStepIds(flow: Flow, fromStepIndex: number): string[] {
  return flow.steps
    .map((s, idx) => ({ id: s.id, idx }))
    .filter(({ idx }) => idx !== fromStepIndex)
    .map(({ id }) => id);
}

/// Helper used to check whether a `FlowStep` references a tool id. Lets the
/// builder ToolsPicker pre-check the right boxes.
export function stepHasTool(step: FlowStep, toolId: string): boolean {
  return step.tools.includes(toolId);
}
