// Static cost lint for a Flow definition.
//
// Distinct from validation.ts, which answers "will this flow run?". This
// module answers "will this flow waste the user's money every time it runs?".
// Nothing here ever blocks a save or a run — a flow can be entirely valid,
// deliver its artifact correctly, and still pay for a step whose output is
// thrown away or run a formatting step on the most expensive model available.
//
// Every rule is PURE and synchronous so it can run in the renderer on each
// keystroke of the editor, and again in the main process at run launch
// (see preflight.ts). Rules are tuned for a low false-positive rate: a
// warning the user learns to dismiss is worse than no warning, so anything
// that needs real judgement about a step's intent is left alone. In
// particular `custom` roles are never judged on model tier — the prompt is
// the only thing that says what the step does, and this module does not read
// prompts.
//
// The same advice exists as prose in the AI drafter's brief (see the DEPTH
// BUDGET and SPEED sections in main/flows/drafter.ts). Guidance in a prompt
// is a suggestion the model can ignore, and does; these rules are the part
// that actually holds.

import { modelSpeed } from '../modelCatalog';
import { resolveStepModel, type Flow } from './schema';

export interface FlowLintWarning {
  /// Stable rule id, so the renderer can group or suppress by kind.
  rule: 'discarded-output' | 'all-steps-top-tier' | 'mechanical-step-top-tier' | 'unreadable-artifact-named';
  /// Dotted path to the offending field, matching FlowValidationError.path
  /// so the editor can highlight with the same machinery.
  path: string;
  message: string;
  /// Short actionable suggestion, rendered after the message.
  hint?: string;
}

/// Model tiers whose cost only pays off on a step that genuinely reasons.
const TOP_TIER = new Set(['thinking', 'frontier']);

/// Preset roles whose work is mechanical: they transform or report on an
/// artifact an earlier step already produced, rather than deciding anything.
/// Deliberately conservative — `debugger`, every `*-reviewer`, `planner` and
/// `implementer` all make real calls and are omitted. `researcher` is omitted
/// too: breadth of recall tracks model size.
const MECHANICAL_ROLES = new Set(['technical-writer', 'editor', 'code-reader']);

export function lintFlow(flow: Flow): FlowLintWarning[] {
  const warnings: FlowLintWarning[] = [];
  if (!Array.isArray(flow.steps) || flow.steps.length === 0) return warnings;
  flagDiscardedOutputs(flow, warnings);
  flagTopTierOveruse(flow, warnings);
  flagUnreadableArtifactNames(flow, warnings);
  return warnings;
}

/// A step whose `output` was ALREADY produced by an earlier step, and which
/// does not take that artifact as an input, throws the earlier step's work
/// away: it regenerates the artifact from scratch and overwrites it.
///
/// Overwriting an artifact is legitimate and deliberate — `build` writes
/// `diff`, then `tests` extends `diff` (see the note in validation.ts). What
/// distinguishes the extend case is that the later step CONSUMES the artifact
/// it rewrites. A step that rewrites an artifact it never read cannot be
/// extending it, so the earlier step is pure cost: a full cold model turn
/// whose output is discarded unread.
function flagDiscardedOutputs(flow: Flow, warnings: FlowLintWarning[]): void {
  const producedBy = new Map<string, string>();
  for (let i = 0; i < flow.steps.length; i++) {
    const step = flow.steps[i];
    if (!step.output) continue;
    const earlier = producedBy.get(step.output);
    if (earlier !== undefined && !step.inputs?.includes(step.output)) {
      warnings.push({
        rule: 'discarded-output',
        path: `steps[${i}].output`,
        message:
          `Step "${step.id}" overwrites "${step.output}" from step "${earlier}" without ` +
          `reading it, so everything step "${earlier}" produced is discarded unread.`,
        hint: `Delete step "${earlier}", or add "${step.output}" to step "${step.id}" inputs if it should extend it.`,
      });
    }
    producedBy.set(step.output, step.id);
  }
}

/// Two shapes of overspend on the top model tier:
///   - every step in a multi-step flow sits on it, which means no step was
///     costed at all;
///   - a single step doing mechanical work sits on it.
/// Reported as one or the other, never both — the flow-wide warning already
/// covers every step, and repeating it per step is noise.
function flagTopTierOveruse(flow: Flow, warnings: FlowLintWarning[]): void {
  const speeds = flow.steps.map((step) => modelSpeed(resolveStepModel(flow, step).model));
  if (flow.steps.length > 1 && speeds.every((s) => TOP_TIER.has(s))) {
    warnings.push({
      rule: 'all-steps-top-tier',
      path: 'steps',
      message:
        `All ${flow.steps.length} steps run on the most expensive model tier. ` +
        `Steps that draft, format, or extract from an artifact an earlier step produced ` +
        `do not need it.`,
      hint: 'Move the non-reasoning steps to a faster model.',
    });
    return;
  }
  for (let i = 0; i < flow.steps.length; i++) {
    const step = flow.steps[i];
    if (!MECHANICAL_ROLES.has(step.role)) continue;
    if (!TOP_TIER.has(speeds[i])) continue;
    warnings.push({
      rule: 'mechanical-step-top-tier',
      path: `steps[${i}].model`,
      message:
        `Step "${step.id}" is a "${step.role}" on the most expensive model tier. ` +
        `It works from artifacts earlier steps already produced, so the reasoning is already done.`,
      hint: 'A faster model usually reads the same.',
    });
  }
}

/// A step's prompt names an artifact that ALREADY EXISTS by the time the step
/// runs, but that the step does not list in `inputs` — so the model is told
/// about a document it cannot see. It will either hunt for the file with tool
/// calls that all miss, or invent the contents.
///
/// Deliberately narrow, because this is the one rule that reads prompts:
///   - Only names an EARLIER step actually produces are considered. A prompt
///     naming a LATER artifact is usually describing the pipeline ("your
///     output becomes root_cause.md"), which is fine and common.
///   - The step's own output is excluded — a writer naturally names the file
///     it writes.
///   - Matching is whole-token against the flow's own declared artifact
///     names, never a general search for filename-looking words, so prose
///     about "the report" or a path under a log directory can't trip it.
///
/// This rule does NOT catch a prompt that refers to an upstream step in prose
/// without naming its artifact ("earlier steps risk-checked that plan"). That
/// needs semantic judgement about what the flow contains, which belongs to an
/// AI review pass, not to a static rule.
function flagUnreadableArtifactNames(flow: Flow, warnings: FlowLintWarning[]): void {
  const producedEarlier = new Set<string>();
  for (let i = 0; i < flow.steps.length; i++) {
    const step = flow.steps[i];
    const prompt = step.systemPromptOverride;
    if (prompt?.trim()) {
      for (const name of producedEarlier) {
        if (name === step.output) continue;
        if (step.inputs?.includes(name)) continue;
        // Whole-token match: `plan.md` must not fire on `myplan.md`. The dot
        // in an artifact name is a literal, so escape before building the RE.
        const token = new RegExp(`(^|[^A-Za-z0-9._-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9._-]|$)`);
        if (!token.test(prompt)) continue;
        warnings.push({
          rule: 'unreadable-artifact-named',
          path: `steps[${i}].systemPromptOverride`,
          message:
            `Step "${step.id}" mentions "${name}" in its prompt but does not take it as an input, ` +
            `so the step cannot read it.`,
          hint: `Add "${name}" to step "${step.id}" inputs, or stop referring to it in the prompt.`,
        });
      }
    }
    if (step.output) producedEarlier.add(step.output);
  }
}

/// Turn lint warnings into an instruction for the AI flow editor.
///
/// Seeded into the editor's prompt box rather than sent straight off, so the
/// user reads it, edits it, and decides — an "optimize" that silently
/// rewrites someone's flow is a worse tool than one that drafts the request.
///
/// The warnings go in verbatim. A generic "make this cheaper" makes the model
/// hunt for problems and invent some; naming the exact findings keeps the
/// revision to what the rules actually caught. The guardrails matter as much:
/// every one of these warnings is about cost, and a revision that hits the
/// cost target by dropping a deliverable has not optimised anything.
export function optimizeInstructionFor(warnings: FlowLintWarning[]): string {
  if (warnings.length === 0) return '';
  const findings = warnings.map((w) => `- ${w.path}: ${w.message}${w.hint ? ` ${w.hint}` : ''}`);
  return [
    'Make this flow cheaper to run without changing what it delivers. Address exactly these findings:',
    '',
    ...findings,
    '',
    'Rules:',
    '- Keep every deliverable. Do not drop a step unless its output is discarded unread.',
    '- Keep each step\'s audience, tone and format requirements as written.',
    '- Only move a step to a faster model if it drafts, formats, or extracts from an artifact',
    '  an earlier step already produced. Steps that plan, review, judge or debug stay where they are.',
  ].join('\n');
}
