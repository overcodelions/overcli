import type { ResponseMode, ResponseStyle, StreamEvent } from '@shared/types';

export interface ConsolidationOpportunity {
  toolName: string;
  calls: number;
  rounds: number;
}

export const CONCISE_RESPONSE_DIRECTIVE =
  'Keep progress updates to one short sentence. Give a compact final answer focused on the outcome, important caveats, and any action the user must take. Preserve full reasoning quality; concise refers only to visible output.';

export const EFFICIENT_TOOL_DIRECTIVE =
  'Before calling tools, collect independent reads, searches, and checks and issue them in one larger parallel batch when the tools allow it. Combine related shell checks into one command. Never skip necessary verification or combine dependent steps.';

export const SPEED_FIRST_DIRECTIVE =
  'Prioritize response latency. Take the shortest reliable path to the requested outcome, avoid optional exploration, and begin the useful answer as soon as enough evidence is available. Do not skip required checks.';

/// Find the strongest evidence that the most recent completed turn paid for
/// repeated model round trips to the same tool. Several calls in one assistant
/// message are already batched; only the same tool appearing in 3+ distinct
/// final assistant messages counts as an opportunity.
export function detectConsolidationOpportunity(
  events: readonly StreamEvent[],
): ConsolidationOpportunity | null {
  let start = -1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].kind.type === 'localUser') {
      start = i;
      break;
    }
  }
  if (start < 0) return null;

  const byTool = new Map<string, { calls: number; rounds: number }>();
  for (const event of events.slice(start + 1)) {
    if (event.kind.type !== 'assistant' || event.kind.info.isPartial) continue;
    const inRound = new Map<string, number>();
    for (const tool of event.kind.info.toolUses) {
      inRound.set(tool.name, (inRound.get(tool.name) ?? 0) + 1);
    }
    for (const [toolName, calls] of inRound) {
      const total = byTool.get(toolName) ?? { calls: 0, rounds: 0 };
      total.calls += calls;
      total.rounds += 1;
      byTool.set(toolName, total);
    }
  }

  const candidates = Array.from(byTool, ([toolName, counts]) => ({ toolName, ...counts }))
    .filter((entry) => entry.rounds >= 3)
    .sort((a, b) => b.rounds - a.rounds || b.calls - a.calls || a.toolName.localeCompare(b.toolName));
  return candidates[0] ?? null;
}

export function buildResponseModePrompt(
  prompt: string,
  style: ResponseStyle | undefined,
  priorEvents: readonly StreamEvent[],
  mode?: ResponseMode,
): string {
  if (!style || style === 'normal') return prompt;
  const directives = [CONCISE_RESPONSE_DIRECTIVE];
  if (style === 'efficient') {
    directives.push(EFFICIENT_TOOL_DIRECTIVE);
    const opportunity = detectConsolidationOpportunity(priorEvents);
    if (opportunity) {
      directives.push(
        `The previous turn used ${opportunity.toolName} in ${opportunity.rounds} separate model rounds ` +
          `(${opportunity.calls} calls). Consolidate independent ${opportunity.toolName} work this turn.`,
      );
    }
  }
  if (mode === 'turbo' || mode === 'warp') directives.push(SPEED_FIRST_DIRECTIVE);
  return `${directives.join('\n\n')}\n\n${prompt}`;
}
