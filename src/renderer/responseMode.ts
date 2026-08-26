import type { ResponseMode, ResponseStyle, StreamEvent } from '@shared/types';
import {
  CONCISE_RESPONSE_DIRECTIVE,
  EFFICIENT_TOOL_DIRECTIVE,
  SPEED_FIRST_DIRECTIVE,
} from '@shared/responseDirectives';

export interface ConsolidationOpportunity {
  toolName: string;
  calls: number;
  rounds: number;
}

// Defined in shared/ because the worker engine (main) sends the same two on a
// swift errand. Re-exported here so every existing importer keeps working.
export {
  CONCISE_RESPONSE_DIRECTIVE,
  EFFICIENT_TOOL_DIRECTIVE,
  SPEED_FIRST_DIRECTIVE,
} from '@shared/responseDirectives';

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

/// A hostile MCP server can register a tool whose NAME carries instructions,
/// and that name would otherwise be interpolated verbatim into a directive
/// prepended to the user's prompt. Only names of the shape real tools use are
/// quoted back; anything else drops the hint rather than promoting the text.
/// 128 rather than 64: a fully-qualified MCP tool name is routinely 60+
/// characters (`mcp__claude_ai_Atlassian_Rovo__getJiraProjectIssueTypesMetadata`
/// is 63), and silently dropping the hint for a legitimate long name is a
/// quality regression with no signal. The character class is what bounds the
/// injection surface; the length is only a sanity cap.
const TOOL_NAME_SHAPE = /^[A-Za-z0-9_.-]{1,128}$/;

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
    if (opportunity && TOOL_NAME_SHAPE.test(opportunity.toolName)) {
      directives.push(
        `The previous turn used ${opportunity.toolName} in ${opportunity.rounds} separate model rounds ` +
          `(${opportunity.calls} calls). Consolidate independent ${opportunity.toolName} work this turn.`,
      );
    }
  }
  if (mode === 'turbo' || mode === 'warp') directives.push(SPEED_FIRST_DIRECTIVE);
  return `${directives.join('\n\n')}\n\n${prompt}`;
}
