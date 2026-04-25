// Parses events from `claude --output-format stream-json --verbose
// --include-partial-messages`. Wire format is newline-delimited JSON. We
// pick out the subset the UI cares about and emit typed StreamEvent kinds
// for the renderer.
//
// `--include-partial-messages` interleaves per-token `stream_event` lines
// carrying Anthropic's Messages-API streaming shape (message_start,
// content_block_delta, etc) alongside the consolidated `assistant` line
// that arrives once the message is complete. We keep a small parser state
// so deltas accumulate into a single live assistant snapshot with a
// stable id — the renderer updates the row in place. When the final
// `assistant` line arrives we reuse the same id so the complete payload
// replaces the preview without flicker.

import { StreamEvent, StreamEventKind, ToolUseBlock } from '../../shared/types';
import { randomUUID } from 'node:crypto';

type StreamBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; partialJSON: string };

export interface ClaudeParserState {
  /// Stable id for the assistant message currently being streamed.
  /// Assigned on `message_start`; reused by every snapshot emitted from
  /// subsequent deltas; picked up by the final non-stream `assistant`
  /// line so the finished message overwrites the streaming preview.
  inFlightEventId: ReturnType<typeof randomUUID> | null;
  model: string | null;
  blocks: Map<number, StreamBlock>;
  hasOpaqueReasoning: boolean;
  /// Wallclock (ms) of the last snapshot we emitted. Delta snapshots are
  /// throttled against this so a fast stream (hundreds of deltas/sec)
  /// doesn't thrash the renderer. Flush points (block start/stop,
  /// message stop) bypass the throttle so UI moments aren't missed.
  lastSnapshotAt: number;
}

/// Max snapshots/sec emitted for streaming text — enough to look live
/// (~20 fps) without forcing ChatView to reindex its full event list
/// hundreds of times per second on long conversations.
const SNAPSHOT_THROTTLE_MS = 50;

export function makeClaudeParserState(): ClaudeParserState {
  return {
    inFlightEventId: null,
    model: null,
    blocks: new Map(),
    hasOpaqueReasoning: false,
    lastSnapshotAt: 0,
  };
}

export function claudeToolResultText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((item: any) => (typeof item === 'string' ? item : typeof item?.text === 'string' ? item.text : ''))
      .join('\n');
  }
  if (raw && typeof raw === 'object' && typeof (raw as any).text === 'string') {
    return (raw as any).text;
  }
  return '';
}

/// Incoming JSON shape varies by `type`. We keep it loose (`any`) at the
/// boundary and narrow as we branch — the real contract is with Anthropic's
/// CLI, not our types. `state` is optional so stateless callers (tests,
/// history replay) keep working — streaming deltas only materialize when
/// the runner threads a persistent state through.
export function parseClaudeLine(line: string, state?: ClaudeParserState): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let json: any;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return eventFromKind({ type: 'parseError', message: trimmed.slice(0, 200) }, trimmed);
  }
  const type = json.type;

  switch (type) {
    case 'system': {
      if (json.subtype === 'init') {
        return eventFromKind(
          {
            type: 'systemInit',
            info: {
              sessionId: json.session_id ?? '',
              model: json.model ?? '',
              cwd: json.cwd ?? '',
              apiKeySource: json.apiKeySource ?? 'unknown',
              tools: json.tools ?? [],
              slashCommands: json.slash_commands ?? [],
              mcpServers: json.mcp_servers ?? [],
            },
          },
          trimmed,
        );
      }
      if (json.subtype === 'api_error') {
        const err = json.error ?? {};
        const status = typeof err.status === 'number' ? err.status : '?';
        const retryIn = typeof json.retryInMs === 'number' ? Math.round(json.retryInMs) : null;
        const attempt = typeof json.retryAttempt === 'number' ? json.retryAttempt : null;
        const max = typeof json.maxRetries === 'number' ? json.maxRetries : null;
        const parts = [`API error (status ${status})`];
        if (retryIn != null) parts.push(`retrying in ${retryIn}ms`);
        if (attempt != null && max != null) parts.push(`attempt ${attempt}/${max}`);
        return eventFromKind({ type: 'systemNotice', text: parts.join(' · ') }, trimmed);
      }
      if (json.subtype === 'compact_boundary') {
        return eventFromKind(
          { type: 'systemNotice', text: 'Conversation compacted' },
          trimmed,
        );
      }
      // stop_hook_summary, turn_duration, thinking_summary, etc — noise.
      return null;
    }
    case 'stream_event':
      return state ? handleStreamEvent(json.event ?? {}, state, trimmed) : null;
    case 'assistant': {
      const msg = json.message ?? {};
      const content: any[] = Array.isArray(msg.content) ? msg.content : [];
      const textBlocks: string[] = [];
      const thinking: string[] = [];
      const toolUses: ToolUseBlock[] = [];
      let hasOpaqueReasoning = false;
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const t = block.type;
        if (t === 'text' && typeof block.text === 'string') {
          textBlocks.push(block.text);
        } else if (t === 'thinking' && typeof block.thinking === 'string') {
          thinking.push(block.thinking);
        } else if (t === 'redacted_thinking') {
          hasOpaqueReasoning = true;
        } else if (t === 'tool_use') {
          const input = block.input ?? {};
          const inputJSON = typeof input === 'string' ? input : JSON.stringify(input);
          toolUses.push({
            id: block.id ?? randomUUID(),
            name: block.name ?? 'tool',
            inputJSON,
            filePath: typeof input?.file_path === 'string' ? input.file_path : undefined,
            oldString: typeof input?.old_string === 'string' ? input.old_string : undefined,
            newString: typeof input?.new_string === 'string' ? input.new_string : undefined,
          });
        }
      }
      // Reuse the streaming snapshot's id (if one is in flight) so the
      // final event replaces the preview in place instead of appending a
      // duplicate bubble.
      let id = randomUUID();
      if (state?.inFlightEventId) {
        id = state.inFlightEventId;
        state.inFlightEventId = null;
        state.blocks.clear();
        state.hasOpaqueReasoning = false;
        state.model = null;
        state.lastSnapshotAt = 0;
      }
      return {
        id,
        timestamp: Date.now(),
        raw: trimmed,
        kind: {
          type: 'assistant',
          info: {
            model: msg.model ?? null,
            text: textBlocks.join(''),
            toolUses,
            thinking,
            hasOpaqueReasoning,
          },
        },
        revision: 0,
      };
    }
    case 'user': {
      // Tool results come back as a user message with tool_result blocks.
      const msg = json.message ?? {};
      const content: any[] = Array.isArray(msg.content) ? msg.content : [];
      const results = content
        .filter((b: any) => b?.type === 'tool_result')
        .map((b: any) => ({
          id: b.tool_use_id ?? b.id ?? '',
          content: claudeToolResultText(b.content),
          isError: !!b.is_error,
        }));
      if (results.length === 0) {
        // Plain user message echo — not useful to display again.
        return null;
      }
      return eventFromKind({ type: 'toolResult', results }, trimmed);
    }
    case 'result': {
      const usageByModel: Record<string, any> = json.modelUsage ?? {};
      const modelUsage: Record<string, any> = {};
      for (const [model, u] of Object.entries(usageByModel)) {
        const usage = u as any;
        modelUsage[model] = {
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          cacheReadInputTokens: usage?.cacheReadInputTokens ?? 0,
          cacheCreationInputTokens: usage?.cacheCreationInputTokens ?? 0,
        };
      }
      return eventFromKind(
        {
          type: 'result',
          info: {
            subtype: json.subtype ?? '',
            isError: !!json.is_error,
            durationMs: json.duration_ms ?? 0,
            totalCostUSD: json.total_cost_usd ?? 0,
            modelUsage,
          },
        },
        trimmed,
      );
    }
    case 'rate_limit_event': {
      return eventFromKind(
        {
          type: 'rateLimit',
          info: {
            status: json.status ?? '',
            rateLimitType: json.rate_limit_type ?? '',
            remaining: json.remaining,
            resetsAt: json.resets_at,
            limit: json.limit,
          },
        },
        trimmed,
      );
    }
    case 'permission_request': {
      return eventFromKind(
        {
          type: 'permissionRequest',
          info: {
            backend: 'claude',
            requestId: json.request_id ?? '',
            toolName: json.tool_name ?? 'tool',
            description: json.description ?? '',
            toolInput:
              typeof json.tool_input === 'string'
                ? json.tool_input
                : JSON.stringify(json.tool_input ?? {}, null, 2),
          },
        },
        trimmed,
      );
    }
    default:
      return eventFromKind({ type: 'other', label: type ?? 'unknown' }, trimmed);
  }
}

/// Fold one `stream_event` payload into parser state and (sometimes)
/// return an assistant snapshot. Flush points — `content_block_start`,
/// `content_block_stop`, `message_stop` — always emit so the user sees
/// block transitions instantly. `content_block_delta` throttles to
/// ~20 fps so a long response doesn't flood the IPC bus.
function handleStreamEvent(ev: any, state: ClaudeParserState, raw: string): StreamEvent | null {
  const evType = ev?.type;
  switch (evType) {
    case 'message_start': {
      state.inFlightEventId = randomUUID();
      state.model = ev.message?.model ?? null;
      state.blocks.clear();
      state.hasOpaqueReasoning = false;
      state.lastSnapshotAt = 0;
      return null;
    }
    case 'content_block_start': {
      if (!state.inFlightEventId) state.inFlightEventId = randomUUID();
      const idx = typeof ev.index === 'number' ? ev.index : -1;
      const block = ev.content_block ?? {};
      const bt = block.type;
      if (bt === 'text') {
        state.blocks.set(idx, { type: 'text', text: typeof block.text === 'string' ? block.text : '' });
      } else if (bt === 'thinking') {
        state.blocks.set(idx, {
          type: 'thinking',
          thinking: typeof block.thinking === 'string' ? block.thinking : '',
        });
      } else if (bt === 'redacted_thinking') {
        state.hasOpaqueReasoning = true;
      } else if (bt === 'tool_use') {
        state.blocks.set(idx, {
          type: 'tool_use',
          id: typeof block.id === 'string' ? block.id : randomUUID(),
          name: typeof block.name === 'string' ? block.name : 'tool',
          partialJSON: '',
        });
      }
      return snapshotAssistantEvent(state, raw, /*force*/ true);
    }
    case 'content_block_delta': {
      const idx = typeof ev.index === 'number' ? ev.index : -1;
      const delta = ev.delta ?? {};
      const block = state.blocks.get(idx);
      if (!block) return null;
      if (delta.type === 'text_delta' && block.type === 'text' && typeof delta.text === 'string') {
        block.text += delta.text;
      } else if (
        delta.type === 'thinking_delta' &&
        block.type === 'thinking' &&
        typeof delta.thinking === 'string'
      ) {
        block.thinking += delta.thinking;
      } else if (
        delta.type === 'input_json_delta' &&
        block.type === 'tool_use' &&
        typeof delta.partial_json === 'string'
      ) {
        block.partialJSON += delta.partial_json;
      } else {
        // signature_delta, citations_delta, etc — ignored.
        return null;
      }
      return snapshotAssistantEvent(state, raw, /*force*/ false);
    }
    case 'content_block_stop':
    case 'message_stop':
      return snapshotAssistantEvent(state, raw, /*force*/ true);
    case 'message_delta':
    default:
      return null;
  }
}

function snapshotAssistantEvent(
  state: ClaudeParserState,
  raw: string,
  force: boolean,
): StreamEvent | null {
  if (!state.inFlightEventId) return null;
  const now = Date.now();
  if (!force && now - state.lastSnapshotAt < SNAPSHOT_THROTTLE_MS) return null;
  state.lastSnapshotAt = now;

  const indices = [...state.blocks.keys()].sort((a, b) => a - b);
  const textParts: string[] = [];
  const thinking: string[] = [];
  const toolUses: ToolUseBlock[] = [];
  for (const idx of indices) {
    const b = state.blocks.get(idx)!;
    if (b.type === 'text') {
      if (b.text) textParts.push(b.text);
    } else if (b.type === 'thinking') {
      if (b.thinking) thinking.push(b.thinking);
    } else {
      // tool_use: only surface the block once its input JSON is fully
      // accumulated and parses cleanly. Mid-stream fragments like
      // `{"file_pa` can't yield a file path, and the "current reveal"
      // slot (ChatView.tsx) caches a ToolUseBlock by id — if we hand it
      // an empty-path copy first it sticks forever, even after the
      // final `assistant` event arrives with the real input.
      if (!b.partialJSON) continue;
      let input: any;
      try {
        input = JSON.parse(b.partialJSON);
      } catch {
        continue;
      }
      toolUses.push({
        id: b.id,
        name: b.name,
        inputJSON: b.partialJSON,
        filePath: typeof input?.file_path === 'string' ? input.file_path : undefined,
        oldString: typeof input?.old_string === 'string' ? input.old_string : undefined,
        newString: typeof input?.new_string === 'string' ? input.new_string : undefined,
      });
    }
  }

  return {
    id: state.inFlightEventId,
    timestamp: now,
    raw,
    kind: {
      type: 'assistant',
      info: {
        model: state.model,
        text: textParts.join(''),
        toolUses,
        thinking,
        hasOpaqueReasoning: state.hasOpaqueReasoning,
        isPartial: true,
      },
    },
    revision: 0,
  };
}

function eventFromKind(kind: StreamEventKind, raw: string): StreamEvent {
  return {
    id: randomUUID(),
    timestamp: Date.now(),
    raw,
    kind,
    revision: 0,
  };
}
