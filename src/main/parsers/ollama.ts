// Translates Ollama's streaming chat response into StreamEvents. Unlike
// the CLI-based backends we don't have stdout lines to parse — the
// runner's Ollama path calls these helpers directly with the HTTP event
// payloads.

import { randomUUID } from 'node:crypto';
import { OllamaToolCall } from '../ollama';
import {
  ModelUsage,
  StreamEvent,
  StreamEventKind,
  ToolResultBlock,
  ToolUseBlock,
} from '../../shared/types';

export function makeSystemInitEvent(model: string, cwd: string, sessionId: string): StreamEvent {
  return event(
    {
      type: 'systemInit',
      info: {
        sessionId,
        model,
        cwd,
        apiKeySource: 'none',
        tools: [],
        slashCommands: [],
        mcpServers: [],
      },
    },
    `ollama:init model=${model}`,
  );
}

/// Build an assistant snapshot for the current turn. `id` must be stable
/// across tokens of the same turn so the renderer mutates a single row
/// instead of appending one bubble per chunk; `revision` bumps on every
/// emit to signal the in-place update.
export function makeAssistantEvent(
  model: string,
  text: string,
  id: string,
  revision: number,
  extra?: OllamaAssistantExtra,
): StreamEvent {
  return {
    id,
    timestamp: Date.now(),
    raw: text,
    kind: {
      type: 'assistant',
      info: {
        model,
        text,
        toolUses: [],
        thinking: extra?.thinking ? [extra.thinking] : [],
        ...(extra?.usage ? { usage: extra.usage } : {}),
        ...(extra?.isPartial ? { isPartial: true } : {}),
      },
    },
    revision,
  };
}

/// Translate Ollama's terminal-frame counters into the ModelUsage shape
/// the rest of the app sums over. Ollama has no prompt cache to report, so
/// the cache fields are always zero. Returns undefined when the frame
/// carried no counts, so callers can omit `usage` entirely rather than
/// publishing a misleading zero.
export function ollamaUsage(counts?: {
  promptEvalCount?: number;
  evalCount?: number;
}): ModelUsage | undefined {
  if (!counts) return undefined;
  const inputTokens = counts.promptEvalCount ?? 0;
  const outputTokens = counts.evalCount ?? 0;
  if (inputTokens === 0 && outputTokens === 0) return undefined;
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
}

/// Optional extras on an Ollama assistant snapshot.
///
/// `thinking` is the round's accumulated reasoning from Ollama's separate
/// `message.thinking` channel — passed as one blob (not per-delta) because
/// the renderer's ThinkingBlock takes whole strings and each emit replaces
/// the previous snapshot in place.
///
/// `usage` comes from the terminal `done` frame's `prompt_eval_count` /
/// `eval_count`. Without it the flow header's "local" token chip reads
/// zero for every Ollama step, which reads as "nothing happened".
export interface OllamaAssistantExtra {
  thinking?: string;
  usage?: ModelUsage;
  /// Mark mid-stream snapshots. `isPartial` means "cumulative snapshot of
  /// the message currently streaming — replace what you had"; its absence
  /// means "a message finished — append it". Every Ollama delta carries the
  /// round's cumulative text, so emitting them unmarked made consumers that
  /// append (the flow's step buffer, the one-shot waiter) accumulate the
  /// message once per token. Exactly one settled event per round should go
  /// out unmarked.
  isPartial?: boolean;
}

/// Same as `makeAssistantEvent` but attaches pending tool uses so the UI
/// can render the tool-call blocks inline with the assistant bubble,
/// matching how claude/codex tool uses are displayed.
export function makeAssistantEventWithTools(
  model: string,
  text: string,
  id: string,
  revision: number,
  toolCalls: OllamaToolCall[],
  extra?: OllamaAssistantExtra,
): StreamEvent {
  const toolUses: ToolUseBlock[] = toolCalls.map((c) => ({
    id: c.id,
    name: c.name,
    inputJSON: JSON.stringify(c.arguments),
  }));
  return {
    id,
    timestamp: Date.now(),
    raw: text,
    kind: {
      type: 'assistant',
      info: {
        model,
        text,
        toolUses,
        thinking: extra?.thinking ? [extra.thinking] : [],
        ...(extra?.usage ? { usage: extra.usage } : {}),
        ...(extra?.isPartial ? { isPartial: true } : {}),
      },
    },
    revision,
  };
}

/// Emit a toolResult event in the same shape the Claude parser uses
/// (`type: 'toolResult'` with id-correlated result blocks) so renderers
/// already handling Claude's tool output work unchanged for Ollama.
export function makeToolResultEvent(results: ToolResultBlock[]): StreamEvent {
  return event({ type: 'toolResult', results }, `ollama:toolResult ${results.length}`);
}

export function makeResultEvent(args: {
  durationMs?: number;
  evalCount?: number;
  promptEvalCount?: number;
  error?: string;
}): StreamEvent {
  return event(
    {
      type: 'result',
      info: {
        subtype: args.error ? 'error' : 'success',
        isError: !!args.error,
        durationMs: args.durationMs ?? 0,
        totalCostUSD: 0,
        modelUsage: args.evalCount
          ? {
              ollama: {
                inputTokens: args.promptEvalCount ?? 0,
                outputTokens: args.evalCount,
                cacheReadInputTokens: 0,
                cacheCreationInputTokens: 0,
              },
            }
          : {},
      },
    },
    args.error ?? 'done',
  );
}

export function makeErrorEvent(message: string): StreamEvent {
  return event({ type: 'systemNotice', text: `Ollama error: ${message}` }, message);
}

function event(kind: StreamEventKind, raw: string): StreamEvent {
  return { id: randomUUID(), timestamp: Date.now(), raw, kind, revision: 0 };
}
