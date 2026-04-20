// Translates Ollama's streaming chat response into StreamEvents. Unlike
// the CLI-based backends we don't have stdout lines to parse — the
// runner's Ollama path calls these helpers directly with the HTTP event
// payloads.

import { randomUUID } from 'node:crypto';
import { OllamaToolCall } from '../ollama';
import { StreamEvent, StreamEventKind, ToolResultBlock, ToolUseBlock } from '../../shared/types';

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
): StreamEvent {
  return {
    id,
    timestamp: Date.now(),
    raw: text,
    kind: {
      type: 'assistant',
      info: { model, text, toolUses: [], thinking: [] },
    },
    revision,
  };
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
      info: { model, text, toolUses, thinking: [] },
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
