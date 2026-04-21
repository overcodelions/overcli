// History loading. Walks the on-disk transcripts claude/codex/gemini leave
// behind in their respective project directories and converts them to
// StreamEvent lists the renderer can display.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Backend, StreamEvent, StreamEventKind, ToolUseBlock } from '../shared/types';
import { randomUUID } from 'node:crypto';
import { loadOllamaSession } from './ollamaStore';
import { claudeToolResultText } from './parsers/claude';

export function loadHistory(args: {
  backend: Backend;
  projectPath: string;
  sessionId?: string;
  codexRolloutPaths?: string[];
  conversationCreatedAt?: number;
  conversationLastActiveAt?: number;
}): StreamEvent[] {
  switch (args.backend) {
    case 'claude':
      return loadClaudeHistory(args.sessionId, args.projectPath);
    case 'codex':
      return loadCodexHistory(
        args.codexRolloutPaths ?? [],
        args.sessionId,
        args.projectPath,
        args.conversationCreatedAt,
        args.conversationLastActiveAt,
      );
    case 'gemini':
      return loadGeminiHistory(args.sessionId, args.projectPath);
    case 'ollama':
      return loadOllamaHistory(args.sessionId);
  }
}

function loadOllamaHistory(sessionId: string | undefined): StreamEvent[] {
  if (!sessionId) return [];
  const persisted = loadOllamaSession(sessionId);
  if (!persisted) return [];
  const out: StreamEvent[] = [];
  const model = persisted.lastModel ?? 'ollama';
  const fallbackEnd = persisted.updatedAt ?? Date.now();
  for (let i = 0; i < persisted.messages.length; i++) {
    const msg = persisted.messages[i];
    const ts =
      persisted.messageTimestamps?.[i] ??
      fallbackEnd - (persisted.messages.length - 1 - i) * 1000;
    if (msg.role === 'user') {
      out.push(event({ type: 'localUser', text: msg.content }, msg.content, ts));
    } else if (msg.role === 'assistant') {
      out.push(
        event(
          {
            type: 'assistant',
            info: { model, text: msg.content, toolUses: [], thinking: [] },
          },
          msg.content,
          ts,
        ),
      );
    }
    // `system` messages exist only if the runner ever seeds one — skip
    // them from replay since they're not chat content.
  }
  return out;
}

/// Turn an absolute path into Claude CLI's project-dir slug (same rules
/// Claude itself uses: canonicalize, then replace `/`, `.`, and spaces
/// with `-`). Exported so callers that need to re-home a session file
/// between cwds (worktree → project on "Check out locally") stay in sync.
export function claudeProjectSlug(projectPath: string): string {
  let canonical = projectPath;
  try {
    canonical = fs.realpathSync.native(projectPath);
  } catch {
    /* path may not exist — fall back to the raw string */
  }
  return canonical.replaceAll('/', '-').replaceAll('.', '-').replaceAll(' ', '-');
}

/// Move the Claude session file (plus its companion sidecar dir, if any)
/// from the worktree's slug dir to the project's slug dir, so
/// `loadClaudeHistory` and `--resume` find it after the worktree is gone.
/// Silently no-ops when the source file isn't present — e.g. when the
/// conversation used a non-Claude backend or Claude never wrote a
/// session yet. Failures are swallowed because the checkout itself has
/// already succeeded on disk; we'd rather report success with missing
/// history than roll back a working git state.
export function migrateClaudeSessionCwd(args: {
  worktreePath: string;
  projectPath: string;
  sessionId: string;
}): { moved: boolean } {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const fromDir = path.join(root, claudeProjectSlug(args.worktreePath));
  const toDir = path.join(root, claudeProjectSlug(args.projectPath));
  const fromFile = path.join(fromDir, `${args.sessionId}.jsonl`);
  if (!fs.existsSync(fromFile)) return { moved: false };
  try {
    fs.mkdirSync(toDir, { recursive: true });
    fs.renameSync(fromFile, path.join(toDir, `${args.sessionId}.jsonl`));
    // Claude sometimes parks a sidecar directory next to the .jsonl
    // (e.g. for attachments). Move it too when present.
    const fromSidecar = path.join(fromDir, args.sessionId);
    if (fs.existsSync(fromSidecar)) {
      fs.renameSync(fromSidecar, path.join(toDir, args.sessionId));
    }
    return { moved: true };
  } catch {
    return { moved: false };
  }
}

function loadClaudeHistory(sessionId: string | undefined, projectPath: string): StreamEvent[] {
  if (!sessionId) return [];
  const slug = claudeProjectSlug(projectPath);
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
        content: claudeToolResultText(b.content),
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

function loadCodexHistory(
  paths: string[],
  sessionId: string | undefined,
  projectPath: string,
  conversationCreatedAt?: number,
  conversationLastActiveAt?: number,
): StreamEvent[] {
  const allPaths = paths.length
    ? paths
    : findCodexRolloutPaths(sessionId, projectPath, conversationCreatedAt, conversationLastActiveAt);
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
  return dedupeCodexEvents(merged);
}

function findCodexRolloutPaths(
  sessionId: string | undefined,
  projectPath: string,
  conversationCreatedAt?: number,
  conversationLastActiveAt?: number,
): string[] {
  const root = path.join(os.homedir(), '.codex', 'sessions');
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const candidates: string[] = [];
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
      } else if (entry.isFile()) {
        if (sessionId) {
          if (entry.name.includes(sessionId)) out.push(full);
        } else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
          candidates.push(full);
        }
      }
    }
  }
  if (sessionId) return out.sort();

  // No session id available (common with codex exec fallback). Recover by
  // selecting rollout files for this project that fall inside this
  // conversation's own lifetime. Files created before the conversation
  // belong to a prior conversation — picking them up by proximity alone
  // cross-contaminates history across conversations in the same project.
  if (!conversationCreatedAt) return [];
  const lowerBound = conversationCreatedAt - 30 * 1000; // 30s clock-skew slack
  const upperBound = (conversationLastActiveAt ?? Date.now()) + 5 * 60 * 1000;
  const normalizedProject = normalizePathKey(projectPath);
  const scoped: Array<{ file: string; ts: number }> = [];
  for (const file of candidates) {
    const meta = readCodexSessionMeta(file);
    if (!meta) continue;
    if (normalizePathKey(meta.cwd) !== normalizedProject) continue;
    const ts = Number.isFinite(meta.timestampMs) ? meta.timestampMs : 0;
    if (ts < lowerBound || ts > upperBound) continue;
    scoped.push({ file, ts });
  }
  if (scoped.length === 0) return [];
  scoped.sort((a, b) => a.ts - b.ts);
  return scoped.map((s) => s.file);
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
      const text = codexContentText(content);
      if (!text) return null;
      if (text.includes('<environment_context>') || text.includes('<permissions instructions>')) return null;
      if (payload.role === 'developer' || payload.role === 'system') return null;
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
    case 'user_message': {
      const text = typeof payload.message === 'string' ? payload.message : '';
      if (!text || text.includes('<environment_context>')) return null;
      return event({ type: 'localUser', text }, trimmed, timestamp);
    }
    case 'agent_message': {
      const text = typeof payload.message === 'string' ? payload.message : '';
      if (!text) return null;
      return event(
        {
          type: 'assistant',
          info: { model: 'codex', text, toolUses: [], thinking: [] },
        },
        trimmed,
        timestamp,
      );
    }
    case 'token_count': {
      const usage = payload.info?.total_token_usage ?? payload.info?.last_token_usage;
      if (!usage) return null;
      return event(
        {
          type: 'result',
          info: {
            subtype: 'success',
            isError: false,
            durationMs: 0,
            totalCostUSD: 0,
            modelUsage: {
              codex: {
                inputTokens: numberOrZero(usage.input_tokens),
                outputTokens: numberOrZero(usage.output_tokens),
                cacheReadInputTokens: numberOrZero(usage.cached_input_tokens),
                cacheCreationInputTokens: 0,
              },
            },
          },
        },
        trimmed,
        timestamp,
      );
    }
    default:
      return null;
  }
}

function codexContentText(content: any[]): string {
  return content
    .map((b: any) => {
      if (typeof b?.text === 'string') return b.text;
      if (typeof b?.input_text === 'string') return b.input_text;
      if (typeof b?.output_text === 'string') return b.output_text;
      return '';
    })
    .filter(Boolean)
    .join('');
}

function normalizePathKey(p: string): string {
  return p.replace(/\//g, '\\').toLowerCase();
}

function readCodexSessionMeta(file: string): { cwd: string; timestampMs: number } | null {
  try {
    const firstLine = fs.readFileSync(file, 'utf-8').split('\n')[0]?.trim();
    if (!firstLine) return null;
    const parsed = JSON.parse(firstLine);
    if (parsed?.type !== 'session_meta' || !parsed?.payload) return null;
    const cwd = typeof parsed.payload.cwd === 'string' ? parsed.payload.cwd : '';
    if (!cwd) return null;
    const tsRaw = parsed.timestamp ?? parsed.payload.timestamp;
    const timestampMs = typeof tsRaw === 'number' ? tsRaw : Date.parse(tsRaw) || 0;
    return { cwd, timestampMs };
  } catch {
    return null;
  }
}

function dedupeCodexEvents(events: StreamEvent[]): StreamEvent[] {
  const out: StreamEvent[] = [];
  const seen = new Set<string>();
  for (const ev of events) {
    const sig = codexEventSignature(ev);
    if (!sig) {
      out.push(ev);
      continue;
    }
    // Bucket timestamp to the nearest second so equivalent events emitted
    // through different codex record channels collapse cleanly.
    const key = `${Math.floor(ev.timestamp / 1000)}|${sig}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ev);
  }
  return out;
}

function codexEventSignature(ev: StreamEvent): string | null {
  switch (ev.kind.type) {
    case 'localUser':
      return `u:${normalizeSigText(ev.kind.text)}`;
    case 'assistant':
      return `a:${normalizeSigText(ev.kind.info.text)}|t:${normalizeSigText(ev.kind.info.thinking.join('\n'))}`;
    case 'toolResult':
      return `r:${ev.kind.results
        .map((r) => `${r.id}:${normalizeSigText(r.content)}:${r.isError ? 1 : 0}`)
        .join('|')}`;
    case 'result': {
      const usage = ev.kind.info.modelUsage.codex;
      if (!usage) return null;
      return `res:${usage.inputTokens}:${usage.outputTokens}:${usage.cacheReadInputTokens}`;
    }
    default:
      return null;
  }
}

function normalizeSigText(s: string): string {
  return (s || '').trim().replace(/\s+/g, ' ').slice(0, 500);
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
