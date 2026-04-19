// History loading. Walks the on-disk transcripts claude/codex/gemini leave
// behind in their respective project directories and converts them to
// StreamEvent lists the renderer can display.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Backend, StreamEvent, StreamEventKind, ToolUseBlock } from '../shared/types';
import { randomUUID } from 'node:crypto';

export function loadHistory(args: {
  backend: Backend;
  projectPath: string;
  sessionId?: string;
  codexRolloutPaths?: string[];
}): StreamEvent[] {
  switch (args.backend) {
    case 'claude':
      return loadClaudeHistory(args.sessionId, args.projectPath);
    case 'codex':
      return loadCodexHistory(args.codexRolloutPaths ?? [], args.sessionId);
    case 'gemini':
      return loadGeminiHistory(args.sessionId, args.projectPath);
    case 'ollama':
      // Ollama has no on-disk transcript — sessions are in-memory only.
      return [];
  }
}

function loadClaudeHistory(sessionId: string | undefined, projectPath: string): StreamEvent[] {
  if (!sessionId) return [];
  // claude slugs its project dir by replacing both `/` and `.` with `-`.
  const slug = projectPath.replaceAll('/', '-').replaceAll('.', '-');
  const file = path.join(os.homedir(), '.claude', 'projects', slug, `${sessionId}.jsonl`);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf-8').split('\n');
  const out: StreamEvent[] = [];
  for (const line of lines) {
    const evs = parseClaudeHistoryLine(line);
    for (const ev of evs) out.push(ev);
  }
  return out;
}

function parseClaudeHistoryLine(line: string): StreamEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let json: any;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const tsRaw = json.timestamp ?? json.time ?? Date.now();
  const timestamp = typeof tsRaw === 'number' ? tsRaw : Date.parse(tsRaw) || Date.now();
  const type = json.type ?? json.message?.type;
  if (type === 'user' && typeof json.message?.content === 'string') {
    return [event({ type: 'localUser', text: json.message.content }, trimmed, timestamp)];
  }
  if (type === 'user' && Array.isArray(json.message?.content)) {
    // tool_result blocks
    const results = json.message.content
      .filter((b: any) => b?.type === 'tool_result')
      .map((b: any) => ({
        id: b.tool_use_id ?? '',
        content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? ''),
        isError: !!b.is_error,
      }));
    if (results.length) return [event({ type: 'toolResult', results }, trimmed, timestamp)];
    return [];
  }
  if (type === 'assistant' && json.message?.content) {
    const content: any[] = Array.isArray(json.message.content) ? json.message.content : [];
    const textBlocks: string[] = [];
    const thinking: string[] = [];
    const toolUses: ToolUseBlock[] = [];
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string') textBlocks.push(block.text);
      else if (block.type === 'thinking' && typeof block.thinking === 'string')
        thinking.push(block.thinking);
      else if (block.type === 'tool_use') {
        const input = block.input ?? {};
        toolUses.push({
          id: block.id ?? randomUUID(),
          name: block.name ?? 'tool',
          inputJSON: typeof input === 'string' ? input : JSON.stringify(input),
          filePath: typeof input?.file_path === 'string' ? input.file_path : undefined,
          oldString: typeof input?.old_string === 'string' ? input.old_string : undefined,
          newString: typeof input?.new_string === 'string' ? input.new_string : undefined,
        });
      }
    }
    const events: StreamEvent[] = [
      event(
        {
          type: 'assistant',
          info: {
            model: json.message.model ?? null,
            text: textBlocks.join(''),
            toolUses,
            thinking,
          },
        },
        trimmed,
        timestamp,
      ),
    ];
    // Synthesize a result event from message.usage so TurnCaption can
    // render token counts on replayed history (live sessions get this
    // from the CLI's separate `result` line — JSONL transcripts don't).
    const usage = json.message?.usage;
    if (usage && typeof usage === 'object') {
      const model = json.message.model ?? 'claude';
      const modelUsage = {
        [model]: {
          inputTokens: numberOrZero(usage.input_tokens),
          outputTokens: numberOrZero(usage.output_tokens),
          cacheReadInputTokens: numberOrZero(usage.cache_read_input_tokens),
          cacheCreationInputTokens: numberOrZero(usage.cache_creation_input_tokens),
        },
      };
      const hasUsage = Object.values(modelUsage[model]).some((n) => n > 0);
      if (hasUsage) {
        events.push(
          event(
            {
              type: 'result',
              info: {
                subtype: 'success',
                isError: false,
                durationMs: 0,
                totalCostUSD: 0,
                modelUsage,
              },
            },
            trimmed,
            timestamp + 1,
          ),
        );
      }
    }
    return events;
  }
  return [];
}

function numberOrZero(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function loadCodexHistory(paths: string[], sessionId?: string): StreamEvent[] {
  const allPaths = paths.length ? paths : findCodexRolloutPaths(sessionId);
  if (!allPaths.length) return [];
  const merged: StreamEvent[] = [];
  for (const p of allPaths) {
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, 'utf-8').split('\n');
    for (const line of lines) {
      const ev = parseCodexHistoryLine(line);
      if (ev) merged.push(ev);
    }
  }
  merged.sort((a, b) => a.timestamp - b.timestamp);
  return merged;
}

function findCodexRolloutPaths(sessionId: string | undefined): string[] {
  if (!sessionId) return [];
  const root = path.join(os.homedir(), '.codex', 'sessions');
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.includes(sessionId)) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

function parseCodexHistoryLine(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let json: any;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const payload = json.type === 'response_item' ? json.payload : json.payload ?? json;
  if (!payload) return null;
  const tsRaw = json.timestamp ?? Date.now();
  const timestamp = typeof tsRaw === 'number' ? tsRaw : Date.parse(tsRaw) || Date.now();
  const kind = payload.type;
  switch (kind) {
    case 'message': {
      const content = Array.isArray(payload.content) ? payload.content : [];
      const text = content
        .map((b: any) => (typeof b?.text === 'string' ? b.text : ''))
        .join('');
      if (text.includes('<environment_context>')) return null;
      if (!text) return null;
      if (payload.role === 'user') return event({ type: 'localUser', text }, trimmed, timestamp);
      return event(
        {
          type: 'assistant',
          info: { model: 'codex', text, toolUses: [], thinking: [] },
        },
        trimmed,
        timestamp,
      );
    }
    case 'reasoning': {
      const summary = Array.isArray(payload.summary) ? payload.summary : [];
      const text = summary.map((s: any) => s.text ?? s.summary_text ?? '').join('\n');
      if (!text) return null;
      return event(
        {
          type: 'assistant',
          info: { model: 'codex', text: '', toolUses: [], thinking: [text] },
        },
        trimmed,
        timestamp,
      );
    }
    case 'function_call': {
      const name = payload.name ?? 'tool';
      const argsStr = payload.arguments ?? '{}';
      let argsJSON: any = {};
      try {
        argsJSON = JSON.parse(argsStr);
      } catch {}
      const isBash = name === 'shell' || name === 'exec_command';
      let inputJSON = argsStr;
      if (isBash) {
        const cmd = Array.isArray(argsJSON.command)
          ? argsJSON.command.join(' ')
          : typeof argsJSON.command === 'string'
            ? argsJSON.command
            : argsStr;
        inputJSON = JSON.stringify({ command: cmd });
      }
      const tool: ToolUseBlock = {
        id: payload.call_id ?? randomUUID(),
        name: isBash ? 'Bash' : name,
        inputJSON,
        filePath: argsJSON.file_path,
      };
      return event(
        {
          type: 'assistant',
          info: { model: 'codex', text: '', toolUses: [tool], thinking: [] },
        },
        trimmed,
        timestamp,
      );
    }
    case 'function_call_output': {
      const callId = payload.call_id ?? '';
      const outputStr = payload.output ?? '';
      let inner = outputStr;
      try {
        const parsed = JSON.parse(outputStr);
        if (typeof parsed?.output === 'string') inner = parsed.output;
      } catch {}
      return event(
        {
          type: 'toolResult',
          results: [{ id: callId, content: inner, isError: false }],
        },
        trimmed,
        timestamp,
      );
    }
    default:
      return null;
  }
}

function loadGeminiHistory(sessionId: string | undefined, projectPath: string): StreamEvent[] {
  if (!sessionId) return [];
  const shortId = sessionId.slice(0, 8);
  // gemini writes sessions under ~/.gemini/tmp/<slug>/chats/session-...-<shortId>.json
  // where <slug> is the cwd basename unless projects.json remaps it.
  const home = os.homedir();
  let slug = path.basename(projectPath);
  const projectsFile = path.join(home, '.gemini', 'projects.json');
  try {
    const raw = fs.readFileSync(projectsFile, 'utf-8');
    const parsed = JSON.parse(raw);
    const mapped = parsed?.projects?.[projectPath];
    if (typeof mapped === 'string') slug = mapped;
  } catch {}
  const chatsDir = path.join(home, '.gemini', 'tmp', slug, 'chats');
  if (!fs.existsSync(chatsDir)) return [];
  const match = fs
    .readdirSync(chatsDir)
    .find((name) => name.includes(shortId) && name.endsWith('.json'));
  if (!match) return [];
  try {
    const raw = fs.readFileSync(path.join(chatsDir, match), 'utf-8');
    const parsed = JSON.parse(raw);
    const out: StreamEvent[] = [];
    const baseTs = Date.parse(parsed.startTime) || Date.now();
    let idx = 0;
    for (const turn of parsed.messages ?? []) {
      const ts = Date.parse(turn.timestamp) || baseTs + idx;
      idx++;
      const kind = turn.type ?? turn.role;
      if (kind === 'user') {
        const text = geminiUserText(turn.content);
        if (text) out.push(event({ type: 'localUser', text }, '', ts));
      } else if (kind === 'gemini' || kind === 'model' || kind === 'assistant') {
        const text = typeof turn.content === 'string' ? turn.content : geminiUserText(turn.content);
        const thinking: string[] = [];
        for (const t of turn.thoughts ?? []) {
          const parts = [t?.subject, t?.description].filter(
            (s): s is string => typeof s === 'string' && !!s,
          );
          if (parts.length) thinking.push(parts.join(': '));
        }
        const toolUses: ToolUseBlock[] = [];
        const toolResults: { id: string; content: string; isError: boolean }[] = [];
        for (const call of turn.toolCalls ?? []) {
          const input = call.args ?? call.parameters ?? {};
          const inputJSON = typeof input === 'string' ? input : JSON.stringify(input);
          toolUses.push({
            id: call.id ?? randomUUID(),
            name: geminiHistoryToolName(call.name),
            inputJSON,
            filePath: typeof input?.file_path === 'string' ? input.file_path : undefined,
            oldString: typeof input?.old_string === 'string' ? input.old_string : undefined,
            newString: typeof input?.new_string === 'string' ? input.new_string : undefined,
          });
          const resText = geminiHistoryToolResultText(call.result);
          if (resText != null) {
            toolResults.push({ id: call.id ?? '', content: resText, isError: false });
          }
        }
        if (text || thinking.length || toolUses.length) {
          out.push(
            event(
              {
                type: 'assistant',
                info: { model: turn.model ?? 'gemini', text: text ?? '', toolUses, thinking },
              },
              '',
              ts,
            ),
          );
        }
        for (const r of toolResults) {
          out.push(event({ type: 'toolResult', results: [r] }, '', ts));
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

function geminiUserText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (item && typeof item === 'object') {
      const it = item as any;
      if (typeof it.text === 'string') parts.push(it.text);
      else if (it.inlineData?.mimeType) parts.push(`[attachment: ${it.inlineData.mimeType}]`);
    }
  }
  return parts.join('');
}

function geminiHistoryToolName(name: string | undefined): string {
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

function geminiHistoryToolResultText(result: unknown): string | null {
  if (result == null) return null;
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    const parts: string[] = [];
    for (const item of result) {
      const resp = (item as any)?.functionResponse?.response;
      if (resp == null) continue;
      if (typeof resp.output === 'string') parts.push(resp.output);
      else parts.push(JSON.stringify(resp));
    }
    return parts.length ? parts.join('\n') : null;
  }
  return JSON.stringify(result);
}

function event(kind: StreamEventKind, raw: string, timestamp: number): StreamEvent {
  return { id: randomUUID(), timestamp, raw, kind, revision: 0 };
}
