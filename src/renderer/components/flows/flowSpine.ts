// Pure read-outs for describing a flow's pipeline to someone deciding
// whether to run it. Lives outside the components so it's testable — the
// "does this edit my files" call in particular is a claim we make to the
// user about what's about to happen to their repo, and a wrong answer is
// worse than no answer.

import { resolveStepModel, type Flow, type FlowStep } from '@shared/flows/schema';

/// Human phrase for what a step's role actually does, in the user's terms
/// rather than the preset's id. `custom` is absent on purpose — a bespoke
/// step's name is the only honest summary we have of it.
export const ROLE_VERB: Record<string, string> = {
  planner: 'plans the work',
  implementer: 'writes the code',
  'plan-reviewer': 'reviews the plan',
  reviewer: 'reviews the work',
  'test-writer': 'writes tests',
  researcher: 'researches',
  shipper: 'commits and opens a PR',
  'technical-writer': 'writes the docs',
  editor: 'edits for clarity',
  debugger: 'finds the cause',
  'code-reader': 'reads the code',
  'code-reviewer': 'reviews the code',
  'security-reviewer': 'audits for security',
  'adversarial-reviewer': 'tries to break it',
};

/// Tools whose presence means a step can change the working tree. Matched
/// against tool ids, which vary by backend (`Edit`/`Write`/`Bash` on
/// Claude, `edit_file`/`write_file`/`run_shell` on Ollama, MCP ids
/// elsewhere), so this is a substring test rather than an exact set.
/// Deliberately errs toward claiming a step writes: over-warning is a
/// smaller harm than letting a flow edit files unannounced.
const WRITE_TOOL_RE = /edit|write|bash|shell|patch|apply|commit|push/i;

/// Whether a step can change files. Drives the one consequence a person
/// most needs to see before launching something an AI wrote for them.
export function stepWrites(step: FlowStep): boolean {
  // A permission mode that pre-approves edits is decisive on its own: it
  // exists precisely so the step can write without asking.
  if (step.permissionMode === 'bypassPermissions' || step.permissionMode === 'acceptEdits') {
    return true;
  }
  return step.tools.some((t) => WRITE_TOOL_RE.test(t));
}

/// Compact model label for a step — "opus 5", "gpt-5.6-sol", "qwen2.5".
/// Strips the vendor prefix, restores dotted version numbers, and turns
/// the remaining word-separating dashes into spaces.
export function compactStepModel(flow: Flow, step: FlowStep): string {
  return compactModelLabel(resolveStepModel(flow, step).model);
}

/// The same formatting for a bare model id — a step's critic is a model
/// reference rather than a step, and it deserves to be named in the same
/// shape as the step it critiques.
export function compactModelLabel(m: string | undefined): string {
  if (!m) return '(no model)';
  if (m.startsWith('claude-')) {
    return m
      .replace('claude-', '')
      .replace(/(\d)-(\d)/g, '$1.$2')
      .replace(/-/g, ' ');
  }
  if (m.includes(':')) return m.split(':')[0];
  return m;
}

/// What the flow amounts to: scale, cost, and consequence. A list of step
/// names reads as five labels; "5 steps · 2 models · edits your files"
/// reads as a piece of work — which is what someone deciding whether to
/// run it is actually weighing.
///
/// Returned in pieces rather than pre-joined because callers disagree
/// about which pieces earn their place. The overview drawer draws every
/// critic loop on the step it belongs to, so repeating the count in the
/// summary line is noise there; the launch panel has no such drawing and
/// needs it.
export function flowSpineFacts(flow: Flow): {
  steps: string;
  models: string;
  loops: string | null;
  writes: boolean;
} {
  const models = new Set(flow.steps.map((s) => compactStepModel(flow, s)));
  const loops = flow.steps.filter((s) => s.rebound).length;
  return {
    steps: `${flow.steps.length} ${flow.steps.length === 1 ? 'step' : 'steps'}`,
    // One model: name it, since that IS the useful fact. Several: count
    // them, because listing four ids here would out-shout the step list.
    models: models.size === 1 ? [...models][0] : `${models.size} models`,
    loops: loops > 0 ? `${loops} critic ${loops === 1 ? 'loop' : 'loops'}` : null,
    writes: flow.steps.some(stepWrites),
  };
}

export function flowSpineSummary(flow: Flow): string {
  const { steps, models, loops, writes } = flowSpineFacts(flow);
  return [steps, models, loops, writes ? 'edits your files' : 'read-only']
    .filter(Boolean)
    .join(' · ');
}

/// How a step is referred to when something else points at it. A number
/// is easier to find in a vertical list than an id is — "back to step 2"
/// beats "back to write-tests" when the reader has to go look.
export function stepOrdinal(flow: Flow, stepId: string): string {
  const idx = flow.steps.findIndex((s) => s.id === stepId);
  return idx < 0 ? stepId : `step ${idx + 1}`;
}
