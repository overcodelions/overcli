// Parses events from `codex proto` stdio stream. Proto events look like
// `{"id": "N", "msg": {"type": "...", ...}}`.

import { StreamEvent, StreamEventKind, ToolUseBlock } from '../../shared/types';
import { randomUUID } from 'node:crypto';

export interface CodexParserState {
  /// Codex emits reasoning + message as separate event streams that need to
  /// fold into one "assistant" event in our model. The parser maintains a
  /// small amount of turn-local state so we can build a single coherent
  /// assistant block at the end of the turn.
  messageText: string;
  thinkingText: string;
  pendingToolUses: ToolUseBlock[];
  /// Map of call_id → tool name so we can stitch a function_call_output
  /// back to the tool use that produced it.
  toolNames: Record<string, string>;
}

export function makeCodexParserState(): CodexParserState {
  return { messageText: '', thinkingText: '', pendingToolUses: [], toolNames: {} };
}

export function parseCodexProtoLine(
  line: string,
  state: CodexParserState,
): { events: StreamEvent[]; sessionConfigured?: { sessionId: string; rolloutPath?: string } } {
  const trimmed = line.trim();
  if (!trimmed) return { events: [] };
  let json: any;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return { events: [event({ type: 'parseError', message: trimmed.slice(0, 200) }, trimmed)] };
  }
  const msg = json?.msg;
  if (!msg?.type) return { events: [event({ type: 'other', label: 'codex:unknown' }, trimmed)] };

  switch (msg.type) {
    case 'session_configured':
      return {
        events: [],
        sessionConfigured: {
          sessionId: msg.session_id ?? '',
          rolloutPath: msg.rollout_path,
        },
      };
    case 'agent_reasoning_delta':
      if (typeof msg.delta === 'string') state.thinkingText += msg.delta;
      return { events: [] };
    case 'agent_reasoning':
      if (typeof msg.text === 'string') state.thinkingText = msg.text;
      return { events: [] };
    case 'agent_message_delta':
      if (typeof msg.delta === 'string') state.messageText += msg.delta;
      return { events: [] };
    case 'agent_message':
      if (typeof msg.message === 'string') state.messageText = msg.message;
      return { events: [] };
    case 'exec_command_begin': {
      const id = msg.call_id ?? randomUUID();
      const cmd = Array.isArray(msg.command) ? msg.command.join(' ') : String(msg.command ?? '');
      state.toolNames[id] = 'Bash';
      const tool: ToolUseBlock = {
        id,
        name: 'Bash',
        inputJSON: JSON.stringify({ command: cmd }),
      };
      state.pendingToolUses.push(tool);
      return {
        events: [
          event(
            {
              type: 'assistant',
              info: {
                model: 'codex',
                text: '',
                toolUses: [tool],
                thinking: [],
              },
            },
            trimmed,
          ),
        ],
      };
    }
    case 'exec_command_end': {
      const id = msg.call_id ?? '';
      const stdout = typeof msg.stdout === 'string' ? msg.stdout : '';
      const stderr = typeof msg.stderr === 'string' ? msg.stderr : '';
      const output = stderr && stdout ? `${stdout}\n\n[stderr]\n${stderr}` : stdout || stderr;
      return {
        events: [
          event(
            {
              type: 'toolResult',
              results: [
                {
                  id,
                  content: output,
                  isError: (msg.exit_code ?? 0) !== 0,
                },
              ],
            },
            trimmed,
          ),
        ],
      };
    }
    case 'patch_apply_begin':
    case 'patch_apply_end': {
      const id = msg.call_id ?? randomUUID();
      // Codex sends `changes` as an object keyed by path with per-path
      // variants: { update: { unified_diff }, create: { content },
      // delete: {} }. We normalize into our flat PatchFileChange[].
      // Older test fixtures used an array — accept both.
      const files = normalizeCodexChanges(msg.changes);
      return {
        events: [
          event(
            {
              type: 'patchApply',
              info: {
                id,
                files,
                success: msg.type === 'patch_apply_end' ? !!msg.success : true,
                stderr: msg.stderr,
              },
            },
            trimmed,
          ),
        ],
      };
    }
    case 'exec_approval_request':
    case 'apply_patch_approval_request': {
      return {
        events: [
          event(
            {
              type: 'codexApproval',
              info: {
                callId: msg.call_id ?? '',
                kind: msg.type === 'exec_approval_request' ? 'exec' : 'patch',
                command: Array.isArray(msg.command) ? msg.command.join(' ') : msg.command,
                changesSummary: summarizeChanges(msg.changes),
                reason: msg.reason,
              },
            },
            trimmed,
          ),
        ],
      };
    }
    case 'task_started':
      return { events: [] };
    case 'task_complete': {
      const events: StreamEvent[] = [];
      // Flush the accumulated assistant text + thinking as a single event
      // if we've got content; zero the turn-local state.
      if (state.messageText || state.thinkingText) {
        events.push(
          event(
            {
              type: 'assistant',
              info: {
                model: 'codex',
                text: state.messageText,
                toolUses: [],
                thinking: state.thinkingText ? [state.thinkingText] : [],
              },
            },
            trimmed,
          ),
        );
      }
      state.messageText = '';
      state.thinkingText = '';
      state.pendingToolUses = [];
      state.toolNames = {};
      events.push(
        event(
          {
            type: 'result',
            info: {
              subtype: 'success',
              isError: false,
              durationMs: 0,
              totalCostUSD: 0,
              modelUsage: {},
            },
          },
          trimmed,
        ),
      );
      return { events };
    }
    case 'token_count':
      // Ignored in the visible stream — usage gets aggregated on result events.
      return { events: [] };
    case 'error': {
      return {
        events: [
          event(
            {
              type: 'systemNotice',
              text: typeof msg.message === 'string' ? msg.message : 'codex error',
            },
            trimmed,
          ),
        ],
      };
    }
    default:
      return { events: [event({ type: 'other', label: `codex:${msg.type}` }, trimmed)] };
  }
}

function summarizeChanges(changes: any): string | undefined {
  const files = normalizeCodexChanges(changes);
  if (files.length === 0) return undefined;
  return files.map((f) => `${f.kind} ${f.path}`.trim()).join('\n');
}

function normalizeCodexChanges(changes: any): Array<{
  id: string;
  path: string;
  kind: 'add' | 'modify' | 'delete' | 'move';
  movedFrom?: string;
  additions: number;
  deletions: number;
  diff?: string;
}> {
  if (!changes) return [];
  // Object shape (real codex): { "<path>": { update: { unified_diff } | create: { content } | delete: {} } }
  if (!Array.isArray(changes) && typeof changes === 'object') {
    const out: Array<{
      id: string;
      path: string;
      kind: 'add' | 'modify' | 'delete' | 'move';
      movedFrom?: string;
      additions: number;
      deletions: number;
      diff?: string;
    }> = [];
    for (const [path, raw] of Object.entries(changes as Record<string, any>)) {
      if (!raw || typeof raw !== 'object') continue;
      let kind: 'add' | 'modify' | 'delete' | 'move' = 'modify';
      let diff: string | undefined;
      if (raw.update && typeof raw.update === 'object') {
        kind = 'modify';
        diff = typeof raw.update.unified_diff === 'string' ? raw.update.unified_diff : undefined;
      } else if (raw.create && typeof raw.create === 'object') {
        kind = 'add';
        diff = typeof raw.create.content === 'string' ? raw.create.content : undefined;
      } else if (raw.delete) {
        kind = 'delete';
      }
      const { additions, deletions } = diff ? countDiffChanges(diff) : { additions: 0, deletions: 0 };
      out.push({
        id: randomUUID(),
        path,
        kind,
        additions,
        deletions,
        diff,
      });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }
  // Array shape (older fixtures): [{ path, kind, additions, deletions, diff }]
  if (Array.isArray(changes)) {
    return changes.map((c: any) => ({
      id: randomUUID(),
      path: c.path ?? '',
      kind: (c.kind ?? 'modify') as 'add' | 'modify' | 'delete' | 'move',
      movedFrom: c.moved_from,
      additions: c.additions ?? 0,
      deletions: c.deletions ?? 0,
      diff: c.diff,
    }));
  }
  return [];
}

function countDiffChanges(unified: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const raw of unified.split('\n')) {
    if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('@@')) continue;
    if (raw.startsWith('+')) additions += 1;
    else if (raw.startsWith('-')) deletions += 1;
  }
  return { additions, deletions };
}

function event(kind: StreamEventKind, raw: string): StreamEvent {
  return { id: randomUUID(), timestamp: Date.now(), raw, kind, revision: 0 };
}
