// Turns the user's actual flow-run history into exemplars for the flow
// drafter. Pure module — type-only imports so it can be unit-tested with
// plain literals and reused wherever a drafting prompt is built.

import type { Flow } from '../../shared/flows/schema';
import type { RunSummary } from './runSummaryLog';

/// A flow the user actually runs, with its real track record.
export interface ProvenFlow {
  flow: Flow;
  runs: number;
  completionRate: number;
  medianWallMs: number;
}

const MIN_RUNS = 3;
const MIN_COMPLETION = 0.6;
const MAX_EXEMPLARS = 3;
/// A deep flow can be well-used and still be the wrong thing to copy. The
/// most-run flow in a real library is often the oldest and longest one, and
/// holding it up as "the shape that works" directly contradicts the DEPTH
/// BUDGET section it sits next to. Exemplars must be evidence FOR the budget,
/// so anything over the budget's own ceiling is not an exemplar.
const MAX_EXEMPLAR_STEPS = 7;

/// Rank the user's flows by how much they're actually trusted: enough runs to
/// mean something, most of them completing, and shallow enough to hold up as
/// a model. Sorted most-run first so the prompt leads with the strongest
/// precedent.
export function rankProvenFlows(flows: Flow[], summaries: RunSummary[]): ProvenFlow[] {
  const byFlowId = new Map<string, { runs: number; completed: number; wallMs: number[] }>();
  for (const s of summaries) {
    const group = byFlowId.get(s.flowId) ?? { runs: 0, completed: 0, wallMs: [] };
    group.runs += 1;
    if (s.completed) group.completed += 1;
    group.wallMs.push(s.wallClockMs);
    byFlowId.set(s.flowId, group);
  }

  const flowsById = new Map(flows.map((f) => [f.id, f]));
  const ranked: ProvenFlow[] = [];
  for (const [flowId, group] of byFlowId) {
    if (group.runs < MIN_RUNS) continue;
    const completionRate = group.completed / group.runs;
    if (completionRate < MIN_COMPLETION) continue;
    const flow = flowsById.get(flowId);
    if (!flow) continue;
    if (flow.steps.length > MAX_EXEMPLAR_STEPS) continue;
    const wallMs = [...group.wallMs].sort((a, b) => a - b);
    const medianWallMs = wallMs.length > 0 ? wallMs[Math.floor(wallMs.length / 2)] : 0;
    ranked.push({ flow, runs: group.runs, completionRate, medianWallMs });
  }

  ranked.sort((a, b) => {
    if (b.runs !== a.runs) return b.runs - a.runs;
    if (b.completionRate !== a.completionRate) return b.completionRate - a.completionRate;
    return a.flow.name.localeCompare(b.flow.name);
  });

  return ranked.slice(0, MAX_EXEMPLARS);
}

/// Render the "PROVEN FLOWS" prompt section for the flow drafter. Empty
/// string when the user has no flow with a track record yet, so callers can
/// splice this in unconditionally.
export function renderProvenFlowsSection(flows: Flow[], summaries: RunSummary[]): string {
  const exemplars = rankProvenFlows(flows, summaries);
  if (exemplars.length === 0) return '';

  return [
    "PROVEN FLOWS IN THIS USER'S LIBRARY",
    '===================================',
    'These are the flows this user actually runs, and how they perform. Copy their',
    'SHAPE — step count and role chain — unless the request genuinely needs something',
    'different. Every one of them fits inside the DEPTH BUDGET above, and they are the',
    'evidence for it: this is what delivers here, at this depth, at this speed.',
    ...exemplars.flatMap((e) => [
      `  - "${e.flow.name}" — ${e.runs} runs, ${Math.round(e.completionRate * 100)}% completed, ~${Math.max(1, Math.round(e.medianWallMs / 60000))} min median, ${e.flow.steps.length} steps`,
      `    ${e.flow.steps.map((s) => s.role).join(' → ')}`,
    ]),
  ].join('\n');
}
