// Parses events from `copilot -p PROMPT --output-format=json --stream=on`.
// Wire format is newline-delimited JSON ("JSONL"). Each line is a typed
// event with `type`, `data`, `id`, `timestamp`, optional `parentId`. The
// shape is richer than Claude's stream-json — there are explicit
// reasoning_delta events, turn_start/turn_end boundaries, and a final
// `result` event with sessionId/usage — so we have less synthesis to do.
//
// Tool names get normalized to overcli's canonical set (Read / Edit /
// Write / Bash / Glob / Grep) so ToolUseCard renders them consistently
// with claude/gemini history.

import { randomUUID } from 'node:crypto';
import { StreamEvent, StreamEventKind, ToolUseBlock } from '../../shared/types';

export interface CopilotParserState {
  /// In-flight assistant message id. Set on `assistant.message_start`,
  /// reused for streaming snapshots, cleared when the final
  /// `assistant.message` arrives so the snapshot is replaced in place.
  inFlightMessageId: string | null;
  /// Streaming text accumulator for the current message.
  inFlightText: string;
  /// Streaming reasoning accumulator, keyed by reasoningId so multiple
  /// reasoning blocks per turn don't collide.
  inFlightReasoningById: Map<string, string>;
  /// Model copilot reports via `session.tools_updated`. Used as the
  /// `model` field on every assistant event we synthesize.
  model: string | null;
  /// Snapshot throttle wallclock — see SNAPSHOT_THROTTLE_MS.
  lastSnapshotAt: number;
  /// True once we've emitted the systemInit event for this subprocess.
  /// Copilot fires `session.*` events repeatedly during startup; we
  /// only want one systemInit per stream.
  systemInitEmitted: boolean;
  /// MCP servers seen during init, accumulated so the systemInit event
  /// carries the full set the user sees in the dashboard.
  mcpServers: Array<{ name: string; status: string }>;
}

const SNAPSHOT_THROTTLE_MS = 50;

export function makeCopilotParserState(): CopilotParserState {
  return {
    inFlightMessageId: null,
    inFlightText: '',
    inFlightReasoningById: new Map(),
    model: null,
    lastSnapshotAt: 0,
    systemInitEmitted: false,
    mcpServers: [],
  };
}

/// Maps copilot's lowercase builtin tool names onto overcli's
/// PascalCase set so ToolUseCard's name-based rendering (FileEditCard,
/// BashCard, etc) lights up the same way as for claude/gemini.
export function normalizeCopilotToolName(name: string): string {
  switch (name) {
    case 'view':
      return 'Read';
    case 'edit':
      return 'Edit';
    case 'create':
      return 'Write';
    case 'bash':
    case 'powershell':
      return 'Bash';
    case 'glob':
      return 'Glob';
    case 'grep':
    case 'rg':
      return 'Grep';
    default:
      return name;
  }
}

export function parseCopilotLine(
  line: string,
  state: CopilotParserState,
): StreamEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let json: any;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return [eventFromKind({ type: 'parseError', message: trimmed.slice(0, 200) }, trimmed)];
  }
  const type = json.type;

  switch (type) {
    case 'session.mcp_servers_loaded': {
      const servers = Array.isArray(json.data?.servers) ? json.data.servers : [];
      for (const s of servers) {
        if (!s?.name) continue;
        if (!state.mcpServers.find((x) => x.name === s.name)) {
          state.mcpServers.push({ name: s.name, status: s.status ?? 'connected' });
        }
      }
      return [];
    }
    case 'session.tools_updated': {
      if (json.data?.model && !state.model) {
        state.model = String(json.data.model);
      }
      // Emit a single systemInit once we know the model — copilot doesn't
      // expose a sessionId until the final `result` event, so this is a
      // best-effort init banner rather than the source of session truth.
      if (!state.systemInitEmitted) {
        state.systemInitEmitted = true;
        return [
          eventFromKind(
            {
              type: 'systemInit',
              info: {
                sessionId: '',
                model: state.model ?? '',
                cwd: '',
                apiKeySource: 'copilot',
                tools: [],
                slashCommands: [],
                mcpServers: state.mcpServers.slice(),
              },
            },
            trimmed,
          ),
        ];
      }
      return [];
    }
    case 'session.mcp_server_status_changed':
    case 'session.skills_loaded':
    case 'session.session_started':
      return [];
    case 'user.message':
      // Echo of the prompt we just sent — the renderer already shows it
      // as a localUser event.
      return [];
    case 'assistant.turn_start':
    case 'assistant.turn_end':
      return [];
    case 'assistant.message_start': {
      const id = json.data?.messageId;
      if (typeof id === 'string' && id) {
        state.inFlightMessageId = id;
        state.inFlightText = '';
        state.lastSnapshotAt = 0;
      }
      return [];
    }
    case 'assistant.message_delta': {
      const delta = json.data?.deltaContent;
      if (typeof delta !== 'string' || !delta) return [];
      state.inFlightText += delta;
      const snap = snapshotAssistant(state, trimmed, false);
      return snap ? [snap] : [];
    }
    case 'assistant.reasoning_delta': {
      const reasoningId = json.data?.reasoningId;
      const delta = json.data?.deltaContent;
      if (typeof reasoningId !== 'string' || typeof delta !== 'string') return [];
      const prior = state.inFlightReasoningById.get(reasoningId) ?? '';
      state.inFlightReasoningById.set(reasoningId, prior + delta);
      // Reasoning deltas arrive before any assistant.message_start when
      // the model decides to call a tool immediately — there's no
      // message id to attach a snapshot to. Skip emitting until message
      // events provide a stable id.
      if (!state.inFlightMessageId) return [];
      const snap = snapshotAssistant(state, trimmed, false);
      return snap ? [snap] : [];
    }
    case 'assistant.reasoning': {
      // Consolidated reasoning at end of turn. Replace any partial
      // accumulator for this id with the canonical text.
      const reasoningId = json.data?.reasoningId;
      const content = json.data?.content;
      if (typeof reasoningId === 'string' && typeof content === 'string') {
        state.inFlightReasoningById.set(reasoningId, content);
      }
      return [];
    }
    case 'assistant.message': {
      // Final form of an assistant message. Carries the complete text,
      // any tool requests, and reasoningText for the just-completed
      // reasoning block. Replace the in-flight snapshot.
      const data = json.data ?? {};
      const messageId = typeof data.messageId === 'string' ? data.messageId : null;
      const text: string = typeof data.content === 'string' ? data.content : '';
      const toolRequests: any[] = Array.isArray(data.toolRequests) ? data.toolRequests : [];
      const toolUses: ToolUseBlock[] = toolRequests.map((t) => {
        const args = t?.arguments ?? {};
        const inputJSON = typeof args === 'string' ? args : JSON.stringify(args);
        return {
          id: t?.toolCallId ?? randomUUID(),
          name: normalizeCopilotToolName(t?.name ?? 'tool'),
          inputJSON,
          filePath: typeof args?.file_path === 'string'
            ? args.file_path
            : typeof args?.path === 'string'
              ? args.path
              : undefined,
          oldString: typeof args?.old_string === 'string' ? args.old_string : undefined,
          newString: typeof args?.new_string === 'string' ? args.new_string : undefined,
        };
      });
      const reasoningText: string =
        typeof data.reasoningText === 'string' ? data.reasoningText : '';
      const thinking = reasoningText ? [reasoningText] : [];
      // Pick a stable id: prefer messageId so streaming snapshots get
      // replaced; fall back to inFlightMessageId; fall back to a new uuid.
      const id = messageId ?? state.inFlightMessageId ?? randomUUID();
      const model = data.model ?? state.model ?? null;
      state.inFlightMessageId = null;
      state.inFlightText = '';
      state.lastSnapshotAt = 0;
      return [
        {
          id,
          timestamp: Date.now(),
          raw: trimmed,
          kind: {
            type: 'assistant',
            info: { model, text, toolUses, thinking },
          },
          revision: 0,
        },
      ];
    }
    case 'tool.execution_start':
      // The toolUses block on the matching assistant.message already
      // tells the renderer which tool is running; the execution start
      // line carries the same args. No extra event needed.
      return [];
    case 'tool.execution_complete': {
      const data = json.data ?? {};
      const callId = typeof data.toolCallId === 'string' ? data.toolCallId : '';
      const result = data.result ?? {};
      const content =
        typeof result.content === 'string'
          ? result.content
          : typeof result === 'string'
            ? result
            : JSON.stringify(result);
      const isError = data.success === false;
      return [
        eventFromKind(
          {
            type: 'toolResult',
            results: [{ id: callId, content, isError }],
          },
          trimmed,
        ),
      ];
    }
    case 'result': {
      const usage = json.usage ?? {};
      const model = state.model ?? 'copilot';
      const durationMs = typeof usage.sessionDurationMs === 'number' ? usage.sessionDurationMs : 0;
      return [
        eventFromKind(
          {
            type: 'result',
            info: {
              subtype: 'success',
              isError: json.exitCode !== 0,
              durationMs,
              totalCostUSD: 0,
              modelUsage: {
                [model]: {
                  // Copilot reports premiumRequests rather than token
                  // counts. We surface it on outputTokens so the TurnCaption
                  // shows something meaningful; cache counts stay zero.
                  inputTokens: 0,
                  outputTokens:
                    typeof usage.premiumRequests === 'number' ? usage.premiumRequests : 0,
                  cacheReadInputTokens: 0,
                  cacheCreationInputTokens: 0,
                },
              },
            },
          },
          trimmed,
        ),
      ];
    }
    default:
      // Unknown event kinds get a faint 'other' tag so they're inspectable
      // in the raw stream view but don't otherwise affect the transcript.
      return [eventFromKind({ type: 'other', label: type ?? 'unknown' }, trimmed)];
  }
}

function snapshotAssistant(
  state: CopilotParserState,
  raw: string,
  force: boolean,
): StreamEvent | null {
  if (!state.inFlightMessageId) return null;
  const now = Date.now();
  if (!force && now - state.lastSnapshotAt < SNAPSHOT_THROTTLE_MS) return null;
  state.lastSnapshotAt = now;
  const thinking = [...state.inFlightReasoningById.values()].filter(Boolean);
  return {
    id: state.inFlightMessageId,
    timestamp: now,
    raw,
    kind: {
      type: 'assistant',
      info: {
        model: state.model,
        text: state.inFlightText,
        toolUses: [],
        thinking,
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

/// Extracts the session id from a `result` line if present. Used by the
/// backend spec's parseChunk wrapper to surface sessionConfigured.
export function copilotSessionIdFromResult(json: any): string | null {
  const id = json?.sessionId;
  return typeof id === 'string' && id ? id : null;
}
