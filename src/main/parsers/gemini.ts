// Gemini CLI streams `init`, `message`, `tool_use`, `tool_result`, and
// `result` events. Headless mode is one-shot per turn, but we still parse
// the live stream so the UI can show assistant text + tool activity.

import { StreamEvent, StreamEventKind } from '../../shared/types';
import { randomUUID } from 'node:crypto';

export function parseGeminiLine(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let json: any;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return event({ type: 'parseError', message: trimmed.slice(0, 200) }, trimmed);
  }
  const t = json.type;
  switch (t) {
    case 'init':
      return event(
        {
          type: 'systemInit',
          info: {
            sessionId: json.session_id ?? '',
            model: json.model ?? 'gemini',
            cwd: json.cwd ?? '',
            apiKeySource: json.apiKeySource ?? 'none',
            tools: [],
            slashCommands: [],
            mcpServers: [],
          },
        },
        trimmed,
      );
    case 'message':
      if (json.role === 'assistant' && typeof json.content === 'string') {
        return event(
          {
            type: 'assistant',
            info: { model: 'gemini', text: json.content, toolUses: [], thinking: [] },
          },
          trimmed,
        );
      }
      return event({ type: 'other', label: 'message' }, trimmed);
    case 'tool_use': {
      const input = json.parameters ?? {};
      return event(
        {
          type: 'assistant',
          info: {
            model: 'gemini',
            text: '',
            thinking: [],
            toolUses: [
              {
                id: json.tool_id ?? randomUUID(),
                name: geminiToolName(json.tool_name),
                inputJSON: typeof input === 'string' ? input : JSON.stringify(input),
                filePath: typeof input?.file_path === 'string' ? input.file_path : undefined,
                oldString: typeof input?.old_string === 'string' ? input.old_string : undefined,
                newString: typeof input?.new_string === 'string' ? input.new_string : undefined,
              },
            ],
          },
        },
        trimmed,
      );
    }
    case 'tool_result':
      return event(
        {
          type: 'toolResult',
          results: [
            {
              id: json.tool_id ?? randomUUID(),
              content: geminiToolResultContent(json),
              isError: json.status === 'error',
            },
          ],
        },
        trimmed,
      );
    case 'result':
      return event(
        {
          type: 'result',
          info: {
            subtype: json.status ?? '',
            isError: json.status !== 'success',
            durationMs: json.stats?.duration_ms ?? 0,
            totalCostUSD: 0,
            modelUsage: geminiModelUsage(json.stats?.models),
          },
        },
        trimmed,
      );
    default:
      return event({ type: 'other', label: `gemini:${t ?? 'unknown'}` }, trimmed);
  }
}

function event(kind: StreamEventKind, raw: string): StreamEvent {
  return { id: randomUUID(), timestamp: Date.now(), raw, kind, revision: 0 };
}

function geminiToolName(name: string | undefined): string {
  switch (name) {
    case 'read_file':
      return 'Read';
    case 'write_file':
      return 'Write';
    case 'replace':
      return 'Edit';
    case 'run_shell_command':
      return 'Bash';
    default:
      return name ?? 'tool';
  }
}

function geminiToolResultContent(json: any): string {
  if (typeof json.output === 'string') return json.output;
  if (json.output != null) return JSON.stringify(json.output);
  if (typeof json.error?.message === 'string') return json.error.message;
  return '';
}

function geminiModelUsage(models: any): Record<string, any> {
  if (!models || typeof models !== 'object') return {};
  const out: Record<string, any> = {};
  for (const [model, usage] of Object.entries(models)) {
    const u: any = usage ?? {};
    out[model] = {
      inputTokens: u.input_tokens ?? u.input ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheReadInputTokens: u.cached ?? 0,
      cacheCreationInputTokens: 0,
    };
  }
  return out;
}
