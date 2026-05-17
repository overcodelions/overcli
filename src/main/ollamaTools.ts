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
import { OllamaToolCall, OllamaToolDefinition } from './ollama';

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
