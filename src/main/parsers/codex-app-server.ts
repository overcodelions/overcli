import { randomUUID } from 'node:crypto';
import { StreamEvent, StreamEventKind, ToolUseBlock } from '../../shared/types';

interface PartialAssistantState {
  eventId: string;
  text: string;
  revision: number;
}

export interface CodexAppServerParserState {
  assistantByItemId: Record<string, PartialAssistantState>;
  reasoningByItemId: Record<string, PartialAssistantState>;
}

export function makeCodexAppServerParserState(): CodexAppServerParserState {
  return {
    assistantByItemId: {},
    reasoningByItemId: {},
  };
}

export function parseCodexAppServerNotification(
  method: string,
  params: any,
  state: CodexAppServerParserState,
  raw = '',
): { events: StreamEvent[]; sessionConfigured?: { sessionId: string } } {
  switch (method) {
    case 'thread/started':
      return { events: [], sessionConfigured: sessionFromThread(params?.thread) };
    case 'item/started':
      return parseItemStarted(params?.item, state, raw);
    case 'item/completed':
      return parseItemCompleted(params?.item, state, raw);
    case 'item/agentMessage/delta':
      return parseAgentMessageDelta(params, state, raw);
    case 'item/reasoning/textDelta':
      return parseReasoningDelta(params, state, raw);
    case 'item/reasoning/summaryTextDelta':
      return parseReasoningDelta(params, state, raw);
    case 'turn/completed':
      return {
        events: [
          event(
            {
              type: 'result',
              info: {
                subtype: params?.turn?.status ?? 'completed',
                isError: params?.turn?.status != null && params.turn.status !== 'completed',
                durationMs: params?.turn?.durationMs ?? 0,
                totalCostUSD: 0,
                modelUsage: {},
              },
            },
            raw,
          ),
        ],
      };
    case 'warning':
    case 'deprecationNotice':
    case 'configWarning':
      return {
        events: [
          event(
            {
              type: 'systemNotice',
              text: typeof params?.message === 'string' ? params.message : method,
            },
            raw,
          ),
        ],
      };
    case 'error':
      return {
        events: [
          event(
            {
              type: 'systemNotice',
              text: typeof params?.message === 'string' ? params.message : 'codex app-server error',
            },
            raw,
          ),
        ],
      };
    default:
      return { events: [event({ type: 'other', label: `codex:${method}` }, raw)] };
  }
}

function parseItemStarted(
  item: any,
  state: CodexAppServerParserState,
  raw: string,
): { events: StreamEvent[] } {
  if (!item?.type) return { events: [event({ type: 'other', label: 'codex:item/started' }, raw)] };
  switch (item.type) {
    case 'agentMessage': {
      const next = ensurePartialState(state.assistantByItemId, item.id, item.text);
      if (!next.text) return { events: [] };
      return {
        events: [assistantTextEvent(next, raw)],
      };
    }
    case 'reasoning': {
      const next = ensurePartialState(state.reasoningByItemId, item.id, reasoningText(item));
      if (!next.text) return { events: [] };
      return {
        events: [assistantThinkingEvent(next, raw)],
      };
    }
    case 'commandExecution':
      return {
        events: [
          event(
            {
              type: 'assistant',
              info: {
                model: 'codex',
                text: '',
                thinking: [],
                toolUses: [commandToolUse(item)],
              },
            },
            raw,
          ),
        ],
      };
    case 'fileChange':
      return {
        events: [
          event(
            {
              type: 'assistant',
              info: {
                model: 'codex',
                text: '',
                thinking: [],
                toolUses: [fileChangeToolUse(item)],
              },
            },
            raw,
          ),
        ],
      };
    default:
      return { events: [] };
  }
}

function parseItemCompleted(
  item: any,
  state: CodexAppServerParserState,
  raw: string,
): { events: StreamEvent[] } {
  if (!item?.type) return { events: [] };
  switch (item.type) {
    case 'agentMessage': {
      const next = ensurePartialState(state.assistantByItemId, item.id, item.text);
      next.text = typeof item.text === 'string' ? item.text : next.text;
      next.revision += 1;
      delete state.assistantByItemId[item.id];
      return {
        events: [assistantTextEvent(next, raw)],
      };
    }
    case 'reasoning': {
      const next = ensurePartialState(state.reasoningByItemId, item.id, reasoningText(item));
      next.text = reasoningText(item) || next.text;
      next.revision += 1;
      delete state.reasoningByItemId[item.id];
      return {
        events: [assistantThinkingEvent(next, raw)],
      };
    }
    case 'commandExecution':
      return {
        events: [
          event(
            {
              type: 'toolResult',
              results: [
                {
                  id: item.id ?? '',
                  content: typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '',
                  isError: item.status != null && item.status !== 'completed',
                },
              ],
            },
            raw,
          ),
        ],
      };
    case 'fileChange':
      return {
        events: [
          event(
            {
              type: 'patchApply',
              info: {
                id: item.id ?? randomUUID(),
                files: normalizeFileChanges(item.changes),
                success: item.status === 'completed',
              },
            },
            raw,
          ),
        ],
      };
    default:
      return { events: [] };
  }
}

function parseAgentMessageDelta(
  params: any,
  state: CodexAppServerParserState,
  raw: string,
): { events: StreamEvent[] } {
  const next = ensurePartialState(state.assistantByItemId, params?.itemId, '');
  if (typeof params?.delta === 'string') next.text += params.delta;
  next.revision += 1;
  return { events: [assistantTextEvent(next, raw)] };
}

function parseReasoningDelta(
  params: any,
  state: CodexAppServerParserState,
  raw: string,
): { events: StreamEvent[] } {
  const next = ensurePartialState(state.reasoningByItemId, params?.itemId, '');
  if (typeof params?.delta === 'string') next.text += params.delta;
  next.revision += 1;
  return { events: [] };
}

function assistantTextEvent(state: PartialAssistantState, raw: string): StreamEvent {
  return {
    id: state.eventId,
    timestamp: Date.now(),
    raw,
    kind: {
      type: 'assistant',
      info: {
        model: 'codex',
        text: state.text,
        toolUses: [],
        thinking: [],
      },
    },
    revision: state.revision,
  };
}

function assistantThinkingEvent(state: PartialAssistantState, raw: string): StreamEvent {
  return {
    id: state.eventId,
    timestamp: Date.now(),
    raw,
    kind: {
      type: 'assistant',
      info: {
        model: 'codex',
        text: '',
        toolUses: [],
        thinking: state.text ? [state.text] : [],
      },
    },
    revision: state.revision,
  };
}

function event(kind: StreamEventKind, raw: string): StreamEvent {
  return {
    id: randomUUID(),
    timestamp: Date.now(),
    raw,
    kind,
    revision: 0,
  };
}

function ensurePartialState(
  target: Record<string, PartialAssistantState>,
  itemId: string | undefined,
  initialText: string | undefined,
): PartialAssistantState {
  const id = itemId || randomUUID();
  const existing = target[id];
  if (existing) return existing;
  const created: PartialAssistantState = {
    eventId: randomUUID(),
    text: typeof initialText === 'string' ? initialText : '',
    revision: 0,
  };
  target[id] = created;
  return created;
}

function sessionFromThread(thread: any): { sessionId: string } | undefined {
  const sessionId = typeof thread?.id === 'string' ? thread.id : '';
  if (!sessionId) return undefined;
  return { sessionId };
}

function reasoningText(item: any): string {
  const summary = Array.isArray(item?.summary) ? item.summary.filter((v: unknown) => typeof v === 'string') : [];
  const content = Array.isArray(item?.content) ? item.content.filter((v: unknown) => typeof v === 'string') : [];
  return [...summary, ...content].join('\n').trim();
}

function commandToolUse(item: any): ToolUseBlock {
  return {
    id: item?.id ?? randomUUID(),
    name: 'Bash',
    inputJSON: JSON.stringify({ command: String(item?.command ?? '') }),
  };
}

function fileChangeToolUse(item: any): ToolUseBlock {
  return {
    id: item?.id ?? randomUUID(),
    name: 'Patch',
    inputJSON: JSON.stringify({
      changes: Array.isArray(item?.changes)
        ? item.changes.map((change: any) => ({ path: change?.path ?? '', kind: patchKind(change?.kind) }))
        : [],
    }),
  };
}

function normalizeFileChanges(changes: any): Array<{
  id: string;
  path: string;
  kind: 'add' | 'modify' | 'delete' | 'move';
  movedFrom?: string;
  additions: number;
  deletions: number;
  diff?: string;
}> {
  if (!Array.isArray(changes)) return [];
  return changes.map((change: any) => {
    const diff = typeof change?.diff === 'string' ? change.diff : '';
    const kind = patchKind(change?.kind);
    const counts = countDiffChanges(diff);
    return {
      id: change?.path ?? randomUUID(),
      path: change?.path ?? '',
      kind,
      movedFrom:
        kind === 'move' && typeof change?.kind?.move_path === 'string' ? change.kind.move_path : undefined,
      additions: counts.additions,
      deletions: counts.deletions,
      diff: diff || undefined,
    };
  });
}

/// Translates an app-server server-initiated request into a codexApproval
/// StreamEvent (matching the existing approval surface) plus the metadata
/// the runner needs to route the user's decision back. Returns null for
/// unrecognized request methods so the runner can auto-decline them.
export function translateApprovalRequest(
  method: string,
  params: any,
): {
  callId: string;
  kind: 'exec' | 'patch';
  /// Builds the JSON-RPC `result` payload to send back when the user
  /// decides. Different request methods expect different decision shapes.
  buildResult: (approved: boolean) => any;
  event: StreamEvent;
} | null {
  switch (method) {
    case 'execCommandApproval': {
      const callId = String(params?.callId ?? params?.approvalId ?? randomUUID());
      const command = Array.isArray(params?.command) ? params.command.join(' ') : params?.command;
      return {
        callId,
        kind: 'exec',
        buildResult: (approved) => ({ decision: approved ? 'approved' : 'denied' }),
        event: event(
          {
            type: 'codexApproval',
            info: {
              callId,
              kind: 'exec',
              command: typeof command === 'string' ? command : undefined,
              reason: typeof params?.reason === 'string' ? params.reason : undefined,
            },
          },
          '',
        ),
      };
    }
    case 'item/commandExecution/requestApproval': {
      const callId = String(params?.approvalId ?? params?.itemId ?? randomUUID());
      return {
        callId,
        kind: 'exec',
        buildResult: (approved) => ({ decision: approved ? 'accept' : 'decline' }),
        event: event(
          {
            type: 'codexApproval',
            info: {
              callId,
              kind: 'exec',
              command: typeof params?.command === 'string' ? params.command : undefined,
              reason: typeof params?.reason === 'string' ? params.reason : undefined,
            },
          },
          '',
        ),
      };
    }
    case 'applyPatchApproval': {
      const callId = String(params?.callId ?? randomUUID());
      return {
        callId,
        kind: 'patch',
        buildResult: (approved) => ({ decision: approved ? 'approved' : 'denied' }),
        event: event(
          {
            type: 'codexApproval',
            info: {
              callId,
              kind: 'patch',
              changesSummary: summarizeApprovalChanges(params?.fileChanges),
              reason: typeof params?.reason === 'string' ? params.reason : undefined,
            },
          },
          '',
        ),
      };
    }
    case 'item/fileChange/requestApproval': {
      const callId = String(params?.itemId ?? randomUUID());
      return {
        callId,
        kind: 'patch',
        buildResult: (approved) => ({ decision: approved ? 'accept' : 'decline' }),
        event: event(
          {
            type: 'codexApproval',
            info: {
              callId,
              kind: 'patch',
              reason: typeof params?.reason === 'string' ? params.reason : undefined,
            },
          },
          '',
        ),
      };
    }
    default:
      return null;
  }
}

function summarizeApprovalChanges(fileChanges: any): string | undefined {
  if (!fileChanges || typeof fileChanges !== 'object') return undefined;
  const lines: string[] = [];
  for (const [path, change] of Object.entries(fileChanges as Record<string, any>)) {
    if (!change || typeof change !== 'object') continue;
    if ((change as any).add) lines.push(`add ${path}`);
    else if ((change as any).delete) lines.push(`delete ${path}`);
    else if ((change as any).update) lines.push(`modify ${path}`);
    else lines.push(path);
  }
  return lines.length ? lines.join('\n') : undefined;
}

function patchKind(kind: any): 'add' | 'modify' | 'delete' | 'move' {
  if (kind?.type === 'add') return 'add';
  if (kind?.type === 'delete') return 'delete';
  if (kind?.type === 'update' && typeof kind?.move_path === 'string' && kind.move_path) return 'move';
  return 'modify';
}

function countDiffChanges(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions += 1;
    if (line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions };
}
