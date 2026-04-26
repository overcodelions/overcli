// Gemini CLI backend spec for the headless `gemini -p` path. The
// Gemini ACP transport (used when the CLI supports it) has its own send
// path in runner.ts and does not route through this spec.

import { randomUUID } from 'node:crypto';
import { parseGeminiLine } from '../parsers/gemini';
import { geminiPermissionMapping } from '../permissionRules';
import type { StreamEvent, ToolUseBlock } from '../../shared/types';
import type { BackendSendArgs, BackendSpec, ParseChunkResult } from './types';

interface GeminiStreamState {
  /// Partial line carried from the previous chunk.
  buffer: string;
  /// Stable id for the assistant message currently being coalesced.
  /// Gemini emits multiple `message` events per turn (deltas + final);
  /// we surface a single growing snapshot to the renderer using this id.
  assistantEventId?: string;
  /// Accumulated assistant text for the in-flight message.
  assistantText: string;
  /// Accumulated tool uses across deltas of the in-flight message.
  assistantToolUses: ToolUseBlock[];
  /// Set when a toolResult arrives — the next assistant event starts a
  /// fresh coalesce (Gemini doesn't bracket messages, so a tool result
  /// is our cue that the previous assistant message is done).
  assistantNeedsSplit: boolean;
}

/// True iff `raw` is a Gemini `message` event flagged `delta: true`.
/// Deltas append to the in-flight text; non-deltas (the final
/// consolidated message) replace it.
function isGeminiDelta(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw);
    return parsed?.type === 'message' && parsed?.role === 'assistant' && parsed?.delta === true;
  } catch {
    return false;
  }
}

function coalesceAssistant(state: GeminiStreamState, evt: StreamEvent): StreamEvent {
  if (evt.kind.type !== 'assistant') return evt;
  if (state.assistantNeedsSplit) {
    state.assistantEventId = undefined;
    state.assistantText = '';
    state.assistantToolUses = [];
    state.assistantNeedsSplit = false;
  }
  if (!state.assistantEventId) state.assistantEventId = randomUUID();
  const delta = isGeminiDelta(evt.raw);
  if (evt.kind.info.text) {
    state.assistantText = delta ? state.assistantText + evt.kind.info.text : evt.kind.info.text;
  }
  if (evt.kind.info.toolUses.length > 0) {
    state.assistantToolUses = [...state.assistantToolUses, ...evt.kind.info.toolUses];
  }
  return {
    ...evt,
    id: state.assistantEventId,
    kind: {
      type: 'assistant',
      info: {
        ...evt.kind.info,
        text: state.assistantText,
        toolUses: [...state.assistantToolUses],
      },
    },
  };
}

export const geminiBackend: BackendSpec = {
  name: 'gemini',

  buildArgs(args: BackendSendArgs): string[] {
    const a: string[] = ['-p', '-', '-o', 'stream-json'];
    if (args.model) a.push('-m', args.model);
    if (args.sessionId) a.push('--resume', args.sessionId);
    a.push('--approval-mode', geminiPermissionMapping(args.permissionMode));
    return a;
  },

  buildEnvelope(args: BackendSendArgs): string {
    // Gemini headless mode here is text-only for now, so image
    // attachments are dropped even though the CLI supports image paths.
    return args.prompt;
  },

  makeParserState(): GeminiStreamState {
    return {
      buffer: '',
      assistantEventId: undefined,
      assistantText: '',
      assistantToolUses: [],
      assistantNeedsSplit: false,
    };
  },

  resetForNewTurn(state: unknown): void {
    if (!state) return;
    const s = state as GeminiStreamState;
    // Drop the previous turn's coalesce buffer + line buffer so the
    // first assistant event of the new turn starts a fresh bubble.
    s.buffer = '';
    s.assistantEventId = undefined;
    s.assistantText = '';
    s.assistantToolUses = [];
    s.assistantNeedsSplit = false;
  },

  parseChunk(chunk: string, state: unknown): ParseChunkResult {
    const s = state as GeminiStreamState;
    s.buffer += chunk;
    const lines = s.buffer.split('\n');
    s.buffer = lines.pop() ?? '';
    const events: StreamEvent[] = [];
    let sessionConfigured: ParseChunkResult['sessionConfigured'];
    for (const raw of lines) {
      if (!raw) continue;
      const evt = parseGeminiLine(raw);
      if (!evt) continue;
      if (evt.kind.type === 'assistant') {
        events.push(coalesceAssistant(s, evt));
      } else {
        // A toolResult marks the boundary between assistant turns —
        // the next assistant message starts a fresh coalesce.
        if (evt.kind.type === 'toolResult') s.assistantNeedsSplit = true;
        events.push(evt);
      }
      if (evt.kind.type === 'systemInit' && evt.kind.info.sessionId) {
        sessionConfigured = { sessionId: evt.kind.info.sessionId };
      }
    }
    return sessionConfigured ? { events, sessionConfigured } : { events };
  },
};
