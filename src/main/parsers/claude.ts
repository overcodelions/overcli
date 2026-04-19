// Parses events from `claude --output-format stream-json --verbose`.
// Wire format is newline-delimited JSON. We pick out the subset the UI
// cares about and emit typed StreamEvent kinds for the renderer.

import { StreamEvent, StreamEventKind, ToolUseBlock } from '../../shared/types';
import { randomUUID } from 'node:crypto';

/// Incoming JSON shape varies by `type`. We keep it loose (`any`) at the
/// boundary and narrow as we branch — the real contract is with Anthropic's
/// CLI, not our types.
export function parseClaudeLine(line: string): StreamEvent | null {
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
      // api_retry, thinking_summary, etc — surface as a "other" marker.
      return eventFromKind({ type: 'other', label: `system:${json.subtype ?? 'unknown'}` }, trimmed);
    }
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
      return eventFromKind(
        {
          type: 'assistant',
          info: {
            model: msg.model ?? null,
            text: textBlocks.join(''),
            toolUses,
            thinking,
            hasOpaqueReasoning,
          },
        },
        trimmed,
      );
    }
    case 'user': {
      // Tool results come back as a user message with tool_result blocks.
      const msg = json.message ?? {};
      const content: any[] = Array.isArray(msg.content) ? msg.content : [];
      const results = content
        .filter((b: any) => b?.type === 'tool_result')
        .map((b: any) => {
          const raw = b.content;
          let text: string;
          if (typeof raw === 'string') {
            text = raw;
          } else if (Array.isArray(raw)) {
            text = raw
              .map((r: any) => (typeof r === 'string' ? r : typeof r?.text === 'string' ? r.text : ''))
              .join('\n');
          } else if (raw && typeof raw === 'object' && typeof raw.text === 'string') {
            text = raw.text;
          } else {
            text = '';
          }
          return {
            id: b.tool_use_id ?? b.id ?? '',
            content: text,
            isError: !!b.is_error,
          };
        });
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

function eventFromKind(kind: StreamEventKind, raw: string): StreamEvent {
  return {
    id: randomUUID(),
    timestamp: Date.now(),
    raw,
    kind,
    revision: 0,
  };
}
