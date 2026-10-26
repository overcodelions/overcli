// A worker's own flow, shaped for a run on a connected repo on the server.
//
// A flow written for a desktop ends by shipping its work itself: a step that
// runs `git push`, opens the pull request, then checks it shipped, often
// with a pause before the push for whoever is at the machine. On a server
// none of that works — the model's shell holds no git credentials — and
// none of it is needed: the server pushes each repo's branch itself, after
// the repo's tests, and hands back the links (landBranches.ts). So the run
// keeps every step that plans, builds, reviews or tests, drops the steps
// that ship (and any that only check what those did), and ends with the
// server's own pull-request step, whose words the server pushes with.
//
// Only the run's copy changes: the flow as stored still runs as written on a
// desktop.

import { pullRequestPrompt } from './repos';
import { PR_STEP_OUTPUT } from './landBranches';
import type { Flow, FlowStep } from '../../shared/flows/schema';

/// The step id the server's pull-request step takes, and that a trusted
/// coding worker's grant names (CODING_STEP_GRANT).
export const SERVER_PR_STEP = 'pull-request';

const NEGATED = /\b(?:do\s+not|don't|never|must\s+not)\s+(?:git\s+)?(?:push|open|create|merge|deploy|publish)\b[^.\n]*/gi;
const SHIPS =
  /\bgit\s+push\b|\bpush(?:es|ing)?\s+(?:the\s+|a\s+|your\s+)?(?:branch|code|changes|commits?)\b|\b(?:open|create|raise|submit)s?\s+(?:the\s+|a\s+)?(?:pull request|merge request|pr)\b|\bgh\s+pr\b|\bdeploy\b|\bmerge\s+(?:the\s+)?(?:branch|pull request|pr)\b/i;

/// Whether a step ships the work itself: pushes, opens a pull request,
/// deploys or merges.
export function stepShips(step: Pick<FlowStep, 'id' | 'role' | 'systemPromptOverride' | 'output' | 'tools'>): boolean {
  if (step.role === 'shipper') return true;
  if (step.tools.some((t) => /git\s+push|gh\s+pr/i.test(t))) return true;
  const text = [step.id, step.output, step.systemPromptOverride ?? ''].join(' ').replace(/[_-]+/g, ' ').replace(NEGATED, '');
  return SHIPS.test(text);
}

/// The flow as the server runs it on a connected repo, or null when there is
/// nothing to change: the server's own repo flows, team pieces, and flows
/// with no step that ships.
export function serverShapedFlow(flow: Flow): Flow | null {
  if (flow.id.startsWith('org-pr-') || flow.id.startsWith('team-piece-')) return null;
  const dropped = new Set<string>();
  const gone = new Set<string>();
  for (const step of flow.steps) {
    // A step that ships, or that only reads what a shipping step made (a
    // "verify it shipped" step reading its push's PR url), goes with it.
    if (stepShips(step) || step.inputs.some((i) => gone.has(i))) {
      dropped.add(step.id);
      if (step.output) gone.add(step.output);
    }
  }
  if (!dropped.size) return null;
  const kept = flow.steps.filter((s) => !dropped.has(s.id) && s.id !== SERVER_PR_STEP);
  if (!kept.length) return null;
  // Its words come from everything the run made: the ask, then each output.
  const inputs = [...new Set(['user_prompt', ...kept.map((s) => s.output).filter((o): o is string => !!o && o !== PR_STEP_OUTPUT)])];
  const writer = flow.participants.find((p) => p.backend === 'claude') ?? flow.participants.find((p) => p.id === kept[kept.length - 1].participantId) ?? flow.participants[0];
  if (!writer) return null;
  const pr: FlowStep = {
    id: SERVER_PR_STEP,
    participantId: writer.id,
    role: 'custom',
    effect: 'external',
    inputs,
    tools: ['Read', 'Grep', 'Glob'],
    systemPromptOverride: pullRequestPrompt('repos').join('\n'),
    output: PR_STEP_OUTPUT,
  };
  return {
    ...flow,
    description: `${flow.description ? `${flow.description.trim()} ` : ''}On the server: its shipping steps (${[...dropped].join(', ')}) give way to the server's push, which hands back a pull request link per repo.`,
    steps: [...kept, pr],
  };
}
