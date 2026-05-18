// Built-in tools exposed to local Ollama models that support tool calling.
// Kept intentionally small and read-only — this is the "look around the
// project" kit that lets a local model answer questions about the code
// without us handing it a shell. Writing/editing tools live under the
// regular permissioned flow on the subprocess backends; if we add them
// here later they need to route through respondPermission.
//
// All paths are resolved against the conversation's cwd and rejected if
// they escape that root. Sizes are capped so a chatty model can't OOM us
// by asking for a 2 GB log file.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  OLLAMA_CATALOG,
  OllamaChatMessage,
  OllamaToolCall,
  OllamaToolDefinition,
  streamChat,
} from './ollama';

const MAX_FILE_BYTES = 256 * 1024;
const MAX_LIST_ENTRIES = 500;
const MAX_GREP_MATCHES = 200;
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.build',
  'build',
  'dist',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  'DerivedData',
  '.swiftpm',
]);

export const OLLAMA_BUILTIN_TOOLS: OllamaToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a UTF-8 text file from the project. Paths are relative to the project root. ' +
        'Returns up to 256 KB of content; binary files are rejected.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'File path relative to the project root (e.g. "src/main/index.ts").',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description:
        'List files and subdirectories under a project path. Skips common build/VCS dirs ' +
        '(node_modules, .git, dist, etc). Caps output at 500 entries.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Directory path relative to the project root. Use "." for the root.',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description:
        'Search for a regex pattern across the project. Uses ripgrep when available, otherwise ' +
        'falls back to a JS scan. Returns matching lines with file paths; caps at 200 matches.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Regular expression (POSIX-ish) to search for.',
          },
          path: {
            type: 'string',
            description: 'Optional subdirectory to limit the search to. Defaults to the project root.',
          },
          caseInsensitive: {
            type: 'boolean',
            description: 'If true, match case-insensitively. Defaults to false.',
          },
        },
        required: ['pattern'],
      },
    },
  },
];

export interface ToolExecutionResult {
  content: string;
  isError: boolean;
}

/// Some models (especially the smaller Qwen/Llama coder variants) emit
/// tool calls as plain text in `message.content` instead of using
/// Ollama's structured `tool_calls` field. We sniff the content for
/// `{"name": "...", "arguments": {...}}` blocks — bare, fenced with
/// ```json, or wrapped in Qwen's `<tool_call>…</tool_call>` tags — and
/// promote them to real tool calls.
///
/// Returns `cleanedText` with the extracted blocks (and their fences /
/// XML tags) stripped out so the user doesn't see the raw JSON in the
/// chat bubble.
export function extractInlineToolCalls(text: string): {
  calls: OllamaToolCall[];
  cleanedText: string;
} {
  const calls: OllamaToolCall[] = [];
  const removed: Array<{ start: number; end: number }> = [];

  let i = 0;
  while (i < text.length) {
    if (text[i] !== '{') {
      i += 1;
      continue;
    }
    const closeIdx = findBalancedBrace(text, i);
    if (closeIdx < 0) break;
    const candidate = text.slice(i, closeIdx + 1);
    let parsed: any = null;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      // Not JSON — advance past the open brace so we don't re-scan it.
      i += 1;
      continue;
    }
    const name = parsed?.name;
    const argsObj = parsed?.arguments;
    const isToolCall =
      parsed &&
      typeof parsed === 'object' &&
      typeof name === 'string' &&
      name.length > 0 &&
      argsObj &&
      typeof argsObj === 'object' &&
      !Array.isArray(argsObj);
    if (!isToolCall) {
      i = closeIdx + 1;
      continue;
    }
    // Widen the strip range to swallow a surrounding wrapper (a
    // ```json … ``` fence or Qwen's <tool_call>…</tool_call> tag) so the
    // cleaned bubble reads naturally.
    const before = text.slice(0, i);
    const after = text.slice(closeIdx + 1);
    const fenceBefore = before.match(/```(?:json)?\s*$/);
    const fenceAfter = fenceBefore ? after.match(/^\s*```/) : null;
    const xmlBefore = !fenceBefore ? before.match(/<tool_call>\s*$/) : null;
    const xmlAfter = xmlBefore ? after.match(/^\s*<\/tool_call>/) : null;
    const startPad = (fenceBefore?.[0].length ?? 0) + (xmlBefore?.[0].length ?? 0);
    const endPad = (fenceAfter?.[0].length ?? 0) + (xmlAfter?.[0].length ?? 0);
    const start = i - startPad;
    const end = closeIdx + 1 + endPad;
    calls.push({
      id: `call_fallback_${calls.length}_${Date.now()}`,
      name,
      arguments: argsObj as Record<string, unknown>,
    });
    removed.push({ start, end });
    i = end;
  }

  if (removed.length === 0) return { calls: [], cleanedText: text };

  const parts: string[] = [];
  let cursor = 0;
  for (const r of removed) {
    parts.push(text.slice(cursor, r.start));
    cursor = r.end;
  }
  parts.push(text.slice(cursor));
  return { calls, cleanedText: parts.join('').replace(/\n{3,}/g, '\n\n').trim() };
}

/// True iff `text` looks like the model declaring it's about to use a
/// tool ("I will read…", "Let me list…", "Sure, I'll search…") without
/// actually emitting a tool call. Used to trigger a one-shot nudge that
/// asks the model to actually invoke the tool.
///
/// Kept deliberately conservative: we only match when the sentence
/// clearly references one of our tool verbs (read/list/search/grep/
/// look/check/fetch/inspect/show/find) so a model that legitimately
/// finished a turn without tool use ("Yes, that file looks fine") isn't
/// nudged.
export function looksLikeToolNarration(text: string): boolean {
  if (!text) return false;
  const t = text.trim();
  if (t.length > 600) return false;
  const pattern =
    /\b(?:i(?:'| wi)ll|i am going to|let me|sure,?\s*i'?ll|i can|i'll go ahead and|please allow me to)\b[^.\n]*\b(?:read|open|list|search|grep|look\s*(?:at|in|up)|check|fetch|inspect|show|find|analy[sz]e|extract|provide a summary|summari[sz]e|tell you what)\b/i;
  return pattern.test(t);
}

/// Walks forward from an open brace and returns the index of the matching
/// close brace, respecting string literals. Returns -1 if unbalanced.
function findBalancedBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/// Run a tool call against the project root. Never throws — every failure
/// is returned as `{ isError: true }` so the result can be fed back into
/// the model without breaking the tool-call loop.
export function executeOllamaTool(args: {
  name: string;
  arguments: Record<string, unknown>;
  cwd: string;
}): ToolExecutionResult {
  try {
    switch (args.name) {
      case 'read_file':
        return readFileTool(args.cwd, asString(args.arguments.path));
      case 'list_dir':
        return listDirTool(args.cwd, asString(args.arguments.path));
      case 'grep':
        return grepTool(
          args.cwd,
          asString(args.arguments.pattern),
          args.arguments.path == null ? '.' : asString(args.arguments.path),
          Boolean(args.arguments.caseInsensitive),
        );
      default:
        return { content: `Unknown tool: ${args.name}`, isError: true };
    }
  } catch (err: any) {
    return { content: `Error: ${err?.message ?? String(err)}`, isError: true };
  }
}

function asString(v: unknown): string {
  if (typeof v !== 'string') throw new Error('expected string argument');
  return v;
}

/// Resolve a relative path against cwd and reject anything that escapes
/// the root. We also reject symlinks to avoid ".././../etc/passwd" via
/// a planted symlink in the project.
function safeResolve(cwd: string, rel: string): string {
  const resolved = path.resolve(cwd, rel);
  const cwdReal = fs.realpathSync(cwd);
  let targetReal: string;
  try {
    targetReal = fs.realpathSync(resolved);
  } catch {
    // File doesn't exist yet — check the parent is inside cwd.
    targetReal = resolved;
  }
  const rel2 = path.relative(cwdReal, targetReal);
  if (rel2.startsWith('..') || path.isAbsolute(rel2)) {
    throw new Error(`path escapes project root: ${rel}`);
  }
  return resolved;
}

function readFileTool(cwd: string, rel: string): ToolExecutionResult {
  const full = safeResolve(cwd, rel);
  const stat = fs.statSync(full);
  if (!stat.isFile()) return { content: `${rel}: not a regular file`, isError: true };
  if (stat.size > MAX_FILE_BYTES) {
    return {
      content: `${rel}: file is ${Math.round(stat.size / 1024)} KB — over the 256 KB tool limit. Use grep or read a smaller file.`,
      isError: true,
    };
  }
  const buf = fs.readFileSync(full);
  if (buf.includes(0)) return { content: `${rel}: binary file`, isError: true };
  return { content: buf.toString('utf-8'), isError: false };
}

function listDirTool(cwd: string, rel: string): ToolExecutionResult {
  const full = safeResolve(cwd, rel);
  const stat = fs.statSync(full);
  if (!stat.isDirectory()) return { content: `${rel}: not a directory`, isError: true };
  const entries = fs.readdirSync(full, { withFileTypes: true });
  const lines: string[] = [];
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const suffix = e.isDirectory() ? '/' : '';
    lines.push(`${e.name}${suffix}`);
    if (lines.length >= MAX_LIST_ENTRIES) {
      lines.push(`… (truncated at ${MAX_LIST_ENTRIES} entries)`);
      break;
    }
  }
  lines.sort();
  return { content: lines.join('\n') || '(empty directory)', isError: false };
}

function grepTool(
  cwd: string,
  pattern: string,
  rel: string,
  caseInsensitive: boolean,
): ToolExecutionResult {
  const full = safeResolve(cwd, rel);
  // Prefer ripgrep if it's on PATH — it already knows about .gitignore and
  // is significantly faster than a JS walk. Fall back to a constrained JS
  // scan so the tool still works on boxes without `rg` installed.
  const rgResult = spawnSync(
    'rg',
    ['--no-heading', '-n', caseInsensitive ? '-i' : '-s', '--max-count', '20', '--', pattern, full],
    { encoding: 'utf-8', timeout: 5000 },
  );
  if (!rgResult.error && typeof rgResult.status === 'number') {
    const out = (rgResult.stdout ?? '').trim();
    if (!out && rgResult.status === 1) return { content: '(no matches)', isError: false };
    const lines = out.split('\n').slice(0, MAX_GREP_MATCHES);
    const rel_ = (p: string) => path.relative(cwd, p) || p;
    const rewritten = lines.map((ln) => {
      const firstColon = ln.indexOf(':');
      if (firstColon < 0) return ln;
      return rel_(ln.slice(0, firstColon)) + ln.slice(firstColon);
    });
    if (out.split('\n').length > MAX_GREP_MATCHES) {
      rewritten.push(`… (truncated at ${MAX_GREP_MATCHES} matches)`);
    }
    return { content: rewritten.join('\n') || '(no matches)', isError: false };
  }

  let re: RegExp;
  try {
    re = new RegExp(pattern, caseInsensitive ? 'i' : '');
  } catch (err: any) {
    return { content: `Invalid regex: ${err?.message ?? String(err)}`, isError: true };
  }
  const matches: string[] = [];
  const stack: string[] = [full];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = path.join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(p);
      } else if (e.isFile()) {
        let stat: fs.Stats;
        try {
          stat = fs.statSync(p);
        } catch {
          continue;
        }
        if (stat.size > MAX_FILE_BYTES) continue;
        let text: string;
        try {
          const buf = fs.readFileSync(p);
          if (buf.includes(0)) continue;
          text = buf.toString('utf-8');
        } catch {
          continue;
        }
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 1) {
          if (re.test(lines[i])) {
            matches.push(`${path.relative(cwd, p)}:${i + 1}:${lines[i]}`);
            if (matches.length >= MAX_GREP_MATCHES) {
              matches.push(`… (truncated at ${MAX_GREP_MATCHES} matches)`);
              return { content: matches.join('\n'), isError: false };
            }
          }
        }
      }
    }
  }
  return { content: matches.join('\n') || '(no matches)', isError: false };
}

/// Cap on how many tool/response rounds a single Ollama turn can take.
/// Smaller models occasionally get stuck re-calling the same tool; the
/// cap surfaces that as a visible error instead of an infinite spinner.
export const MAX_OLLAMA_TOOL_ROUNDS = 8;

/// True iff `tag` is in the curated catalog AND its family is trained on
/// the Ollama tool-calling protocol. Unknown/custom tags get `false` —
/// passing tools to a model that wasn't trained for them typically
/// produces garbage or outright JSON-mode refusals.
export function modelSupportsTools(tag: string): boolean {
  const hit = OLLAMA_CATALOG.find((m) => m.tag === tag);
  return !!hit?.supportsTools;
}

/// System prompt prepended on every tool-enabled Ollama call. We embed
/// the tool schemas directly here (rather than passing `tools` to
/// Ollama) because Ollama's templating is unreliable for many coder
/// models — qwen2.5-coder in particular tends to narrate ("I will read
/// X") without ever emitting a structured tool_call when invoked via
/// the API field. Putting the schema in-prompt with worked examples
/// makes the contract deterministic.
export function buildOllamaToolSystemPrompt(cwd: string): string {
  return [
    'You are a local coding assistant running inside overcli on the user\'s machine.',
    `You have real, working access to the user's project directory at: ${cwd}`,
    '',
    'AVAILABLE TOOLS (real, working — they read the user\'s actual disk):',
    '',
    '  read_file(path: string)',
    '    Read a UTF-8 text file relative to the project root. Returns up to 256 KB.',
    '',
    '  list_dir(path: string)',
    '    List files and subdirectories under a project-relative path. Use "." for the root.',
    '',
    '  grep(pattern: string, path?: string, caseInsensitive?: boolean)',
    '    Regex-search across the project. `path` defaults to the project root.',
    '',
    'TOOL-CALL FORMAT (MANDATORY):',
    'Whenever you need to use a tool, emit EXACTLY this block — no prose, no markdown fences, just the tag:',
    '',
    '<tool_call>',
    '{"name": "<tool_name>", "arguments": {<json args>}}',
    '</tool_call>',
    '',
    'The wrapper tags and the JSON are BOTH required. Stop generating after </tool_call>; the tool result will be fed back to you on the next turn.',
    '',
    'CRITICAL RULES:',
    '1. When the user asks about files, directories, or code content, you MUST call the appropriate tool. Do NOT describe what you "will" do.',
    '2. Never narrate ("I will read X", "Let me list Y", "I\'ll check Z", "I will now…"). If you find yourself writing one of those phrases, STOP and emit the <tool_call> block instead.',
    '3. Never fabricate file names, directory contents, or file content. If you have not called the tool yet, you do not know what is there.',
    '4. After the tool returns, answer the user\'s question concisely using the real result.',
    '',
    'WORKED EXAMPLES:',
    '',
    'User: what is in this directory?',
    'Assistant:',
    '<tool_call>',
    '{"name": "list_dir", "arguments": {"path": "."}}',
    '</tool_call>',
    '',
    'User: what does README.md say?',
    'Assistant:',
    '<tool_call>',
    '{"name": "read_file", "arguments": {"path": "README.md"}}',
    '</tool_call>',
    '',
    'User: where do we configure the database URL?',
    'Assistant:',
    '<tool_call>',
    '{"name": "grep", "arguments": {"pattern": "DATABASE_URL", "caseInsensitive": false}}',
    '</tool_call>',
    '',
    'WRONG (do NOT produce output like this):',
    '"I will read README.md to provide you with its contents."',
    '"Let me fetch the contents of that file."',
    '"Sure, I\'ll list the directory."',
  ].join('\n');
}

/// Shared tool-call loop used by both the primary Ollama chat path
/// (`sendOllama`) and the rebound reviewer (`runOllamaReview`). Owns the
/// streamChat → parse → execute → re-enter cycle so the two paths stay
/// in lockstep on narration scrubbing, the inline-tool-call parser, the
/// one-shot nudge, and the round cap.
///
/// The helper mutates `args.messages` as it goes — appending assistant
/// messages (with `tool_calls` attached when the round invokes tools)
/// and `role: 'tool'` results — so the caller can persist the full
/// transcript when the helper resolves. UI/event concerns live in the
/// caller via `onEvent`.
export interface OllamaToolLoopArgs {
  model: string;
  cwd: string;
  signal: AbortSignal;
  /// Prepended on every wire request when non-empty. Pass
  /// `buildOllamaToolSystemPrompt(cwd)` when tools are enabled, or an
  /// empty string for the no-tools path.
  systemPrompt: string;
  /// Conversation transcript. Mutated by the helper.
  messages: OllamaChatMessage[];
  /// Index in `messages` marking the start of "this turn". History
  /// before this is scrubbed for tool narration before being sent on
  /// the wire — qwen/llama coders gleefully pattern-continue narration
  /// they see in context, drowning out the in-prompt instructions.
  turnStartIndex: number;
  maxRounds?: number;
  /// One-shot nudge when a round ends with tool narration ("I will read
  /// X") but no actual tool call. Defaults to true. The reviewer sets
  /// this false since "I'll check the diff and report back" is a
  /// legitimate verdict shape for that path.
  nudgeOnNarration?: boolean;
}

export type OllamaToolLoopEvent =
  | { type: 'roundStart'; round: number }
  | { type: 'assistantDelta'; round: number; cumulative: string }
  | { type: 'roundComplete'; round: number; text: string; toolCalls: OllamaToolCall[] }
  | { type: 'toolResult'; round: number; call: OllamaToolCall; result: ToolExecutionResult };

export type OllamaToolLoopOutcome =
  | { ok: true; finalText: string; rounds: number }
  | { ok: false; error: string; rounds: number };

export async function runOllamaToolLoop(
  args: OllamaToolLoopArgs,
  onEvent: (ev: OllamaToolLoopEvent) => void,
): Promise<OllamaToolLoopOutcome> {
  const maxRounds = args.maxRounds ?? MAX_OLLAMA_TOOL_ROUNDS;
  const nudgeOnNarration = args.nudgeOnNarration ?? true;
  let nudged = false;

  for (let round = 0; round < maxRounds; round += 1) {
    onEvent({ type: 'roundStart', round });

    const wireMessages = buildWireMessages(args.messages, args.turnStartIndex, args.systemPrompt);
    let acc = '';
    let pendingCalls: OllamaToolCall[] = [];
    let streamError: string | null = null;

    await streamChat(
      { model: args.model, messages: wireMessages, signal: args.signal },
      (ev) => {
        if (ev.type === 'token') {
          acc += ev.text;
          onEvent({ type: 'assistantDelta', round, cumulative: acc });
        } else if (ev.type === 'toolCalls') {
          pendingCalls = pendingCalls.concat(ev.calls);
        } else if (ev.type === 'error') {
          streamError = ev.message;
        }
      },
    ).catch((err: any) => {
      streamError = err?.message ?? String(err);
    });

    if (streamError) return { ok: false, error: streamError, rounds: round + 1 };

    // No structured tool_calls came through → check the content channel
    // for the `<tool_call>{…}</tool_call>` wrapper (and bare/fenced JSON
    // fallbacks). Most coder models route through this path.
    let cleanedText = acc;
    if (pendingCalls.length === 0) {
      const extracted = extractInlineToolCalls(acc);
      if (extracted.calls.length > 0) {
        pendingCalls = extracted.calls;
        cleanedText = extracted.cleanedText;
      }
    }

    onEvent({ type: 'roundComplete', round, text: cleanedText, toolCalls: pendingCalls });

    if (pendingCalls.length === 0) {
      // No tool call this round. If the response looks like narration
      // ("I'll read X") and we haven't nudged yet, push a system reminder
      // and re-enter — but only when the caller opted into nudging.
      if (nudgeOnNarration && !nudged && looksLikeToolNarration(cleanedText)) {
        nudged = true;
        if (cleanedText) {
          args.messages.push({ role: 'assistant', content: cleanedText });
        }
        args.messages.push({
          role: 'system',
          content:
            'You described what you would do but did not call a tool. Call the tool now using a <tool_call>{"name":"…","arguments":{…}}</tool_call> block. Do not narrate again — emit only the tool_call.',
        });
        continue;
      }
      // Clean finish — append final assistant text to transcript.
      if (cleanedText) {
        args.messages.push({ role: 'assistant', content: cleanedText });
      }
      return { ok: true, finalText: cleanedText, rounds: round + 1 };
    }

    // Tool-call round — persist the assistant's partial reply (with
    // `tool_calls` attached so the transcript keeps the call/result
    // pairing Ollama expects on replay) and execute each call.
    args.messages.push({
      role: 'assistant',
      content: cleanedText,
      tool_calls: pendingCalls.map((c) => ({
        function: { name: c.name, arguments: c.arguments },
      })),
    });

    for (const call of pendingCalls) {
      const result = executeOllamaTool({
        name: call.name,
        arguments: call.arguments,
        cwd: args.cwd,
      });
      onEvent({ type: 'toolResult', round, call, result });
      args.messages.push({
        role: 'tool',
        content: result.content,
        tool_name: call.name,
      });
    }
  }

  return {
    ok: false,
    error: `Reached tool-call limit (${maxRounds} rounds) without a final answer.`,
    rounds: maxRounds,
  };
}

/// Build the wire messages for one streamChat round: system prompt,
/// scrubbed prior turns (narration-without-tool-call stripped to avoid
/// pattern continuation), then this turn verbatim so the model sees its
/// own promise + any nudge we injected.
function buildWireMessages(
  messages: OllamaChatMessage[],
  turnStartIndex: number,
  systemPrompt: string,
): OllamaChatMessage[] {
  const priorTurns = messages.slice(0, turnStartIndex);
  const thisTurn = messages.slice(turnStartIndex);
  // Only scrub when we have a system prompt — i.e. when tools are
  // active. Without it we have no in-prompt protocol to protect from
  // pattern-continuation, so leave history verbatim.
  const scrubbedPriorTurns = systemPrompt
    ? priorTurns.filter((m) => {
        if (m.role !== 'assistant') return true;
        const hasToolCalls = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
        if (hasToolCalls) return true;
        return !looksLikeToolNarration(m.content ?? '');
      })
    : priorTurns;
  const head: OllamaChatMessage[] = systemPrompt
    ? [{ role: 'system', content: systemPrompt }]
    : [];
  return [...head, ...scrubbedPriorTurns, ...thisTurn];
}
