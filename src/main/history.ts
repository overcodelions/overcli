// History loading. Walks the on-disk transcripts claude/codex/gemini leave
// behind in their respective project directories and converts them to
// StreamEvent lists the renderer can display.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Backend, StreamEvent, StreamEventKind, ToolUseBlock } from '../shared/types';
import { createHash, randomUUID } from 'node:crypto';
import { loadOllamaSession } from './ollamaStore';
import { claudeToolResultText, modelFallbackText } from './parsers/claude';
import { makeCopilotParserState, parseCopilotLine } from './parsers/copilot';
import { logSilent } from './diagnostics';

/// True if `text` matches a known synthetic-collab pingPrompt overcli
/// previously fed to the primary CLI. Each replay branch consults this
/// before emitting a `localUser` event, so reviewer feedback the
/// primary persisted as a user message doesn't resurface as a
/// misattributed user-style bubble. Hashing the text avoids storing
/// (potentially long) prompt bodies in conversation state.
function isSyntheticPrompt(text: string, syntheticHashes: Set<string>): boolean {
  if (syntheticHashes.size === 0) return false;
  const h = createHash('sha256').update(text, 'utf8').digest('hex');
  return syntheticHashes.has(h);
}

/// Cap on the total source size of replayed history, in bytes (measured by
/// each event's original transcript-line length). A watched flow's
/// conversation gains a turn on every poll tick, so its transcript can reach
/// tens of MB; opening it shipped every event — each carrying a full copy of
/// its source line — across IPC and into renderer memory, which is what made
/// the "Loading history…" spinner drag. We keep only the most recent slice,
/// since the tail is what the user wants on open.
const HISTORY_TAIL_BUDGET_BYTES = 1_500_000;

export function loadHistory(args: {
  backend: Backend;
  projectPath: string;
  sessionId?: string;
  codexRolloutPaths?: string[];
  conversationCreatedAt?: number;
  conversationLastActiveAt?: number;
  syntheticPrompts?: string[];
}): StreamEvent[] {
  const synthetic = new Set(args.syntheticPrompts ?? []);
  return trimHistoryForReplay(loadFullHistory(args, synthetic), HISTORY_TAIL_BUDGET_BYTES);
}

function loadFullHistory(
  args: { backend: Backend; projectPath: string; sessionId?: string; codexRolloutPaths?: string[]; conversationCreatedAt?: number; conversationLastActiveAt?: number },
  synthetic: Set<string>,
): StreamEvent[] {
  switch (args.backend) {
    case 'claude':
      return loadClaudeHistory(args.sessionId, args.projectPath, synthetic);
    case 'codex':
      return loadCodexHistory(
        args.codexRolloutPaths ?? [],
        args.sessionId,
        args.projectPath,
        args.conversationCreatedAt,
        args.conversationLastActiveAt,
        synthetic,
      );
    case 'gemini':
      return loadGeminiHistory(args.sessionId, args.projectPath, synthetic);
    case 'ollama':
      return loadOllamaHistory(args.sessionId, synthetic);
    case 'copilot':
      return loadCopilotHistory(args.sessionId, synthetic);
  }
}

/// Trim replayed history to the most recent ~budget bytes and shed each
/// event's `raw` field. Two independent wins for large transcripts:
///   - `raw` (a full copy of the source transcript line) is consumed ONLY by
///     the live DebugSheet — replay rendering never reads it. Dropping it
///     roughly halves the IPC payload and renderer memory for free.
///   - The byte cap bounds how much we ever ship, so an unbounded watcher
///     transcript can't dump tens of MB across the IPC boundary at once.
/// When anything is dropped we prepend a `systemNotice` so the user knows
/// older turns exist but were elided to keep the open fast.
function trimHistoryForReplay(events: StreamEvent[], budgetBytes: number): StreamEvent[] {
  let total = 0;
  let startIdx = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    total += events[i].raw?.length ?? 0;
    if (total > budgetBytes) {
      startIdx = i + 1;
      break;
    }
  }
  const kept = events.slice(startIdx).map((e) => (e.raw ? { ...e, raw: '' } : e));
  if (startIdx > 0) {
    kept.unshift(
      event(
        {
          type: 'systemNotice',
          text: `Showing the most recent part of a long transcript — ${startIdx} earlier event${startIdx === 1 ? '' : 's'} hidden so this loads faster.`,
        },
        '',
        events[startIdx]?.timestamp ?? Date.now(),
      ),
    );
  }
  return kept;
}

function loadCopilotHistory(
  sessionId: string | undefined,
  syntheticPrompts: Set<string>,
): StreamEvent[] {
  if (!sessionId) return [];
  // Copilot persists every JSONL event for a session under
  // ~/.copilot/session-state/<sessionId>/events.jsonl — the exact same
  // wire format the live stream uses. We feed each line back through
  // parseCopilotLine with a fresh parser state and let it synthesize
  // the same StreamEvents we'd emit during a live run.
  const file = path.join(os.homedir(), '.copilot', 'session-state', sessionId, 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  try {
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    const state = makeCopilotParserState();
    const out: StreamEvent[] = [];
    for (const raw of lines) {
      if (!raw.trim()) continue;
      // Copilot's persisted user.message echoes are the conversation's
      // user prompts. parseCopilotLine drops them (live, the renderer
      // already shows localUser); on replay we need to synthesize them
      // so the user side of the transcript isn't blank.
      const userEv = maybeCopilotUserEcho(raw);
      if (userEv) {
        if (!isSyntheticPrompt(userEv.kind.type === 'localUser' ? userEv.kind.text : '', syntheticPrompts)) {
          out.push(userEv);
        }
        continue;
      }
      const evs = parseCopilotLine(raw, state);
      for (const ev of evs) {
        // Drop streaming partials — only the final consolidated
        // assistant.message event is useful for history replay.
        if (ev.kind.type === 'assistant' && ev.kind.info.isPartial) continue;
        out.push(ev);
      }
    }
    return out;
  } catch (e) {
    logSilent('history.loadCopilot', e);
    return [];
  }
}

/// Parse a copilot user.message line into a localUser StreamEvent so
/// replayed transcripts show the prompts the user actually typed.
function maybeCopilotUserEcho(line: string): StreamEvent | null {
  let json: any;
  try {
    json = JSON.parse(line);
  } catch {
    return null;
  }
  if (json?.type !== 'user.message') return null;
  const text = typeof json.data?.content === 'string' ? json.data.content : '';
  if (!text) return null;
  const tsRaw = json.timestamp;
  const timestamp =
    typeof tsRaw === 'string' ? Date.parse(tsRaw) || Date.now() : typeof tsRaw === 'number' ? tsRaw : Date.now();
  return {
    id: randomUUID(),
    timestamp,
    raw: line,
    kind: { type: 'localUser', text },
    revision: 0,
  };
}

function loadOllamaHistory(
  sessionId: string | undefined,
  syntheticPrompts: Set<string>,
): StreamEvent[] {
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
      if (isSyntheticPrompt(msg.content, syntheticPrompts)) continue;
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
  } catch (e) {
    logSilent('history.migrateClaudeSessionCwd', e);
    return { moved: false };
  }
}

/// Resolve the on-disk `~/.claude/projects/<slug>` directory for a slug,
/// tolerating case drift. `claudeProjectSlug` recovers the cwd's true
/// casing via `realpathSync.native` — but ONLY while the cwd still exists.
/// Once a flow's worktree/coordinator cwd is cleaned up, realpath throws
/// and the slug falls back to the raw stored path, whose casing can differ
/// from the directory Claude actually created (e.g. stored `…overcli…` vs
/// Claude's `…Overcli…` under "Application Support"). The session JSONLs
/// outlive the cwd, so a case-sensitive `path.join` would miss them and the
/// transcript would silently vanish. Match the directory case-insensitively
/// to find it regardless.
function resolveClaudeProjectDir(slug: string): string {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const exact = path.join(root, slug);
  if (fs.existsSync(exact)) return exact;
  try {
    const want = slug.toLowerCase();
    for (const name of fs.readdirSync(root)) {
      if (name.toLowerCase() === want) return path.join(root, name);
    }
  } catch {
    /* projects root missing — fall through to the exact path (existsSync fails → []) */
  }
  return exact;
}

function loadClaudeHistory(
  sessionId: string | undefined,
  projectPath: string,
  syntheticPrompts: Set<string>,
): StreamEvent[] {
  if (!sessionId) return [];
  const slug = claudeProjectSlug(projectPath);
  const dir = resolveClaudeProjectDir(slug);
  const file = path.join(dir, `${sessionId}.jsonl`);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf-8').split('\n');
  const out: StreamEvent[] = [];
  for (const line of lines) {
    const evs = parseClaudeHistoryLine(line);
    for (const ev of evs) {
      if (ev.kind.type === 'localUser' && isSyntheticPrompt(ev.kind.text, syntheticPrompts)) {
        continue;
      }
      out.push(ev);
    }
  }
  return out;
}

export function parseClaudeHistoryLine(line: string): StreamEvent[] {
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
  // Sidechain entries in the JSONL transcript came from a Task/Agent
  // subagent. Tag them so the renderer routes to the SubagentDrawer
  // instead of appending into the main transcript. The transcript
  // lacks an explicit parent_tool_use_id on each row, so we coalesce
  // under a single synthetic key until we wire a proper parent link.
  const parentToolUseId: string | undefined =
    typeof json.parent_tool_use_id === 'string' && json.parent_tool_use_id
      ? json.parent_tool_use_id
      : json.isSidechain
        ? '__sidechain__'
        : undefined;
  // The API refused the turn on the model we asked for and the CLI retried on
  // another. Surface it on replay too — otherwise reopening the conversation
  // shows Opus's answers under a header that says Fable, with no explanation.
  if (type === 'system' && json.subtype === 'model_refusal_fallback') {
    return [
      tag(event({ type: 'systemNotice', text: modelFallbackText(json) }, trimmed, timestamp), parentToolUseId),
    ];
  }
  if (type === 'user' && typeof json.message?.content === 'string') {
    const content = json.message.content;
    if (json.isMeta === true) {
      const match = content.match(/^\s*<system-reminder>([\s\S]*?)<\/system-reminder>\s*$/);
      const text = match ? match[1].trim() : content;
      return [tag(event({ type: 'metaReminder', text }, trimmed, timestamp), parentToolUseId)];
    }
    // A finished background Task. The harness injects it as an ordinary user
    // message — no isMeta, no isSidechain, no parent_tool_use_id — so it is
    // indistinguishable from something the user typed unless we sniff the
    // wrapper. Left alone it renders as the user's own bubble, attributing a
    // subagent's report to them.
    const task = content.match(/<task-notification>([\s\S]*?)<\/task-notification>/);
    if (task) {
      const inner = task[1];
      const summary = inner.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim() ?? 'Agent finished';
      const body = inner.match(/<result>([\s\S]*?)<\/result>/)?.[1]?.trim() ?? inner.trim();
      return [tag(event({ type: 'taskNotification', summary, body }, trimmed, timestamp), parentToolUseId)];
    }
    return [tag(event({ type: 'localUser', text: content }, trimmed, timestamp), parentToolUseId)];
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
    if (results.length) return [tag(event({ type: 'toolResult', results }, trimmed, timestamp), parentToolUseId)];
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
    const usageOnMsg = json.message?.usage;
    const assistantUsage =
      usageOnMsg && typeof usageOnMsg === 'object'
        ? {
            inputTokens: numberOrZero(usageOnMsg.input_tokens),
            outputTokens: numberOrZero(usageOnMsg.output_tokens),
            cacheReadInputTokens: numberOrZero(usageOnMsg.cache_read_input_tokens),
            cacheCreationInputTokens: numberOrZero(usageOnMsg.cache_creation_input_tokens),
          }
        : undefined;
    const events: StreamEvent[] = [
      tag(
        event(
          {
            type: 'assistant',
            info: {
              model: json.message.model ?? null,
              text: textBlocks.join(''),
              toolUses,
              thinking,
              ...(assistantUsage ? { usage: assistantUsage } : {}),
            },
          },
          trimmed,
          timestamp,
        ),
        parentToolUseId,
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
          tag(
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
            parentToolUseId,
          ),
        );
      }
    }
    return events;
  }
  return [];
}

export function numberOrZero(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function loadCodexHistory(
  paths: string[],
  sessionId: string | undefined,
  projectPath: string,
  conversationCreatedAt: number | undefined,
  conversationLastActiveAt: number | undefined,
  syntheticPrompts: Set<string>,
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
      if (!ev) continue;
      if (ev.kind.type === 'localUser' && isSyntheticPrompt(ev.kind.text, syntheticPrompts)) {
        continue;
      }
      merged.push(ev);
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

export function parseCodexHistoryLine(line: string): StreamEvent | null {
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

export function codexContentText(content: any[]): string {
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

export function normalizePathKey(p: string): string {
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

export function dedupeCodexEvents(events: StreamEvent[]): StreamEvent[] {
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

export function normalizeSigText(s: string): string {
  return (s || '').trim().replace(/\s+/g, ' ').slice(0, 500);
}

function loadGeminiHistory(
  sessionId: string | undefined,
  projectPath: string,
  syntheticPrompts: Set<string>,
): StreamEvent[] {
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
        if (text && !isSyntheticPrompt(text, syntheticPrompts)) {
          out.push(event({ type: 'localUser', text }, '', ts));
        }
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
  } catch (e) {
    logSilent('history.loadGemini', e);
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

function tag(ev: StreamEvent, parentToolUseId: string | undefined): StreamEvent {
  if (parentToolUseId) ev.parentToolUseId = parentToolUseId;
  return ev;
}
