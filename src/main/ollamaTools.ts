// Built-in tools exposed to local Ollama models that support tool calling.
//
// The kit splits into two tiers. The READ-ONLY trio (read_file, list_dir,
// grep) is the "look around the project" kit — safe for any chat, and the
// default when no explicit allowlist is supplied (see OLLAMA_READONLY_TOOLS
// and runner.ts). The MUTATING tools (write_file, edit_file, bash) are NOT
// handed out by default: a caller must opt in by passing an explicit
// `enabledTools` set that names them. Today only flow steps do that, and a
// flow only runs after the user has reviewed its YAML (which spells out the
// tools each step gets) and cleared preflight. Interactive chat never
// enables them, so an ordinary local-model conversation can't silently
// write files or run a shell.
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

/// The read-only subset of the tool kit — safe to expose to any chat. This
/// is the default allowlist for callers that don't pass an explicit one
/// (interactive chat); mutating tools (write_file/edit_file/bash) are only
/// dispatched when a caller names them in `enabledTools` (e.g. a flow step).
export const OLLAMA_READONLY_TOOLS: readonly string[] = ['read_file', 'list_dir', 'grep'];
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
      name: 'write_file',
      description:
        'Create or overwrite a UTF-8 text file under the project root. Creates parent ' +
        'directories as needed. Refuses to overwrite an existing file unless ' +
        '`overwrite: true` is passed. Use this to add new files (e.g. tests).',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'File path relative to the project root.',
          },
          content: {
            type: 'string',
            description: 'Full UTF-8 file contents to write.',
          },
          overwrite: {
            type: 'boolean',
            description: 'Set to true to overwrite an existing file. Defaults to false.',
          },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Edit an existing UTF-8 text file by replacing a unique substring. Fails if ' +
        '`old_string` is missing or appears more than once. To make multiple edits, ' +
        'call this tool repeatedly. Cannot create new files — use write_file for that.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the project root.' },
          old_string: {
            type: 'string',
            description: 'Exact substring to find. Must appear exactly once in the file.',
          },
          new_string: {
            type: 'string',
            description: 'Replacement text (may be empty to delete the match).',
          },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description:
        'Run a shell command in the project root via /bin/sh. 60s timeout, 256 KB output ' +
        'cap. Use for tests (`npm test`), git commands, and other one-off project tasks. ' +
        'Returns combined stdout+stderr and the exit code.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Shell command to execute (interpreted by /bin/sh).',
          },
        },
        required: ['command'],
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
  enabledTools?: ReadonlySet<string>;
}): ToolExecutionResult {
  if (args.enabledTools && !args.enabledTools.has(args.name)) {
    return {
      content:
        `Tool "${args.name}" is not enabled for this step. ` +
        `Available tools: ${[...args.enabledTools].join(', ') || '(none)'}.`,
      isError: true,
    };
  }
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
      case 'write_file':
        return writeFileTool(
          args.cwd,
          asString(args.arguments.path),
          asString(args.arguments.content),
          Boolean(args.arguments.overwrite),
        );
      case 'edit_file':
        return editFileTool(
          args.cwd,
          asString(args.arguments.path),
          asString(args.arguments.old_string),
          asString(args.arguments.new_string),
        );
      case 'bash':
        return bashTool(args.cwd, asString(args.arguments.command));
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
    // File doesn't exist yet (write_file creates it, possibly mkdir'ing
    // parents). Realpath the NEAREST EXISTING ancestor so a symlinked
    // parent dir (e.g. cwd/sub -> /etc) can't smuggle the write outside
    // the root, then re-attach the not-yet-existing tail. Resolving only
    // the literal path here would let `sub/x` follow the `sub` symlink.
    targetReal = realpathNearestAncestor(resolved);
  }
  const rel2 = path.relative(cwdReal, targetReal);
  if (rel2.startsWith('..') || path.isAbsolute(rel2)) {
    throw new Error(`path escapes project root: ${rel}`);
  }
  return resolved;
}

/// Realpath the closest existing ancestor of `target` and re-join the
/// non-existent tail. Used by safeResolve for paths that don't exist yet
/// so symlinks anywhere in the existing prefix are resolved before the
/// containment check.
function realpathNearestAncestor(target: string): string {
  let dir = path.dirname(target);
  let tail = path.basename(target);
  for (;;) {
    try {
      return path.join(fs.realpathSync(dir), tail);
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return target; // reached fs root, nothing resolved
      tail = path.join(path.basename(dir), tail);
      dir = parent;
    }
  }
}

const MAX_BASH_OUTPUT_BYTES = 256 * 1024;
const BASH_TIMEOUT_MS = 60_000;

/// Bounds for the JS grep fallback. The pattern is model-controlled, so a
/// catastrophic-backtracking regex against a long line could otherwise hang
/// the main process. We cap total wall-clock time across the walk AND skip
/// pathologically long lines (a single `re.test` on a 100 KB minified line
/// is the real ReDoS vector). The ripgrep path has its own 5s timeout.
const GREP_TIME_BUDGET_MS = 5_000;
const GREP_MAX_LINE_LEN = 10_000;

/// Write a new file (or overwrite an existing one with `overwrite=true`).
/// Parents are mkdir'd as needed. Refuses paths outside cwd via
/// safeResolve.
function writeFileTool(
  cwd: string,
  rel: string,
  content: string,
  overwrite: boolean,
): ToolExecutionResult {
  const bytes = Buffer.byteLength(content, 'utf-8');
  if (bytes > MAX_FILE_BYTES) {
    return {
      content: `${rel}: content is ${Math.round(bytes / 1024)} KB — over the 256 KB write limit. Split the file or write less at once.`,
      isError: true,
    };
  }
  const full = safeResolve(cwd, rel);
  if (fs.existsSync(full) && !overwrite) {
    return {
      content:
        `${rel}: already exists. Pass overwrite=true to replace, or use edit_file ` +
        `for targeted changes.`,
      isError: true,
    };
  }
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
  return {
    content: `Wrote ${rel} (${bytes.toLocaleString()} bytes).`,
    isError: false,
  };
}

/// Replace a UNIQUE substring in an existing file. Mirrors the Claude
/// Edit tool's semantics so models trained on similar surfaces produce
/// the right argument shape. Refuses if the file doesn't exist, or if
/// `old_string` is missing or ambiguous.
function editFileTool(
  cwd: string,
  rel: string,
  oldString: string,
  newString: string,
): ToolExecutionResult {
  const full = safeResolve(cwd, rel);
  if (!fs.existsSync(full)) {
    return { content: `${rel}: file does not exist. Use write_file to create.`, isError: true };
  }
  const stat = fs.statSync(full);
  if (!stat.isFile()) return { content: `${rel}: not a regular file`, isError: true };
  if (stat.size > MAX_FILE_BYTES) {
    return {
      content: `${rel}: file is ${Math.round(stat.size / 1024)} KB — over the 256 KB edit limit.`,
      isError: true,
    };
  }
  const original = fs.readFileSync(full, 'utf-8');
  if (!oldString) {
    return { content: 'edit_file: old_string cannot be empty.', isError: true };
  }
  // Count occurrences; require exactly one to avoid silent corruption.
  let count = 0;
  let idx = -1;
  let pos = 0;
  while ((pos = original.indexOf(oldString, pos)) !== -1) {
    if (count === 0) idx = pos;
    count += 1;
    pos += oldString.length;
    if (count > 1) break;
  }
  if (count === 0) {
    return {
      content:
        `${rel}: old_string not found. Use read_file to confirm the exact text and indentation.`,
      isError: true,
    };
  }
  if (count > 1) {
    return {
      content:
        `${rel}: old_string appears ${count} times. Provide more context so the match is unique.`,
      isError: true,
    };
  }
  const updated = original.slice(0, idx) + newString + original.slice(idx + oldString.length);
  fs.writeFileSync(full, updated, 'utf-8');
  return {
    content: `Edited ${rel}.`,
    isError: false,
  };
}

/// Shell-out via /bin/sh in the project root. Bounded by timeout + output
/// cap. We surface stdout, stderr, and exit code separately so the model
/// can react to failures (e.g. tests that didn't pass). The user opted
/// into autonomous execution via the flow's permission/trust toggle, so
/// we don't gate on per-command approval here.
function bashTool(cwd: string, command: string): ToolExecutionResult {
  if (!command.trim()) {
    return { content: 'bash: empty command.', isError: true };
  }
  const res = spawnSync('/bin/sh', ['-c', command], {
    cwd,
    encoding: 'utf-8',
    timeout: BASH_TIMEOUT_MS,
    maxBuffer: MAX_BASH_OUTPUT_BYTES,
  });
  const stdout = (res.stdout ?? '').toString();
  const stderr = (res.stderr ?? '').toString();
  const timedOut = res.signal === 'SIGTERM' || (res.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  const exit = res.status ?? -1;
  const parts: string[] = [
    `$ ${command}`,
    `exit: ${exit}${timedOut ? ' (timed out after 60s)' : ''}`,
  ];
  if (stdout) parts.push('--- stdout ---', stdout);
  if (stderr) parts.push('--- stderr ---', stderr);
  return {
    content: parts.join('\n'),
    // Treat non-zero exit as an error so the model knows to react. The
    // model can still read the output and decide what to do next.
    isError: exit !== 0 || timedOut,
  };
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
  const deadline = Date.now() + GREP_TIME_BUDGET_MS;
  while (stack.length) {
    if (Date.now() > deadline) {
      matches.push(`… (search stopped after ${GREP_TIME_BUDGET_MS / 1000}s — narrow the pattern or path)`);
      break;
    }
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
          // Skip pathologically long lines: a single re.test on a huge
          // minified line is the catastrophic-backtracking vector, and the
          // periodic deadline check can't interrupt one in-flight call.
          if (lines[i].length > GREP_MAX_LINE_LEN) continue;
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
/// Bumped from 8 → 24 after flow steps regularly tripped at 8: real
/// implementer work routinely chains 10–15 read+edit calls before
/// producing the final `<output>` marker.
export const MAX_OLLAMA_TOOL_ROUNDS = 24;

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
export function buildOllamaToolSystemPrompt(
  cwd: string,
  enabledTools?: ReadonlySet<string>,
): string {
  const isEnabled = (name: string): boolean => !enabledTools || enabledTools.has(name);
  const sections: Array<{ name: string; lines: string[] }> = [
    {
      name: 'read_file',
      lines: [
        '  read_file(path: string)',
        '    Read a UTF-8 text file relative to the project root. Returns up to 256 KB.',
      ],
    },
    {
      name: 'list_dir',
      lines: [
        '  list_dir(path: string)',
        '    List files and subdirectories under a project-relative path. Use "." for the root.',
      ],
    },
    {
      name: 'grep',
      lines: [
        '  grep(pattern: string, path?: string, caseInsensitive?: boolean)',
        '    Regex-search across the project. `path` defaults to the project root.',
      ],
    },
    {
      name: 'write_file',
      lines: [
        '  write_file(path: string, content: string, overwrite?: boolean)',
        '    Create a new file (parent dirs auto-created). Refuses to overwrite an existing',
        '    file unless overwrite is true. Use this for NEW files (e.g. new test files).',
      ],
    },
    {
      name: 'edit_file',
      lines: [
        '  edit_file(path: string, old_string: string, new_string: string)',
        '    Edit an existing file by replacing a UNIQUE substring. old_string must appear',
        '    EXACTLY ONCE in the file (whitespace included) — read_file the file first to',
        '    get the exact text. Use this for SURGICAL changes to existing files.',
      ],
    },
    {
      name: 'bash',
      lines: [
        '  bash(command: string)',
        '    Run a /bin/sh command in the project root. 60s timeout, 256 KB output cap.',
        '    Use for tests (`npm test`), git commands, package installs, etc.',
      ],
    },
  ];
  const toolBlock = sections
    .filter((s) => isEnabled(s.name))
    .flatMap((s) => ['', ...s.lines])
    .join('\n');

  const examples: Array<{ tool: string; lines: string[] }> = [
    {
      tool: 'list_dir',
      lines: [
        'User: what is in this directory?',
        'Assistant:',
        '<tool_call>',
        '{"name": "list_dir", "arguments": {"path": "."}}',
        '</tool_call>',
      ],
    },
    {
      tool: 'read_file',
      lines: [
        'User: what does README.md say?',
        'Assistant:',
        '<tool_call>',
        '{"name": "read_file", "arguments": {"path": "README.md"}}',
        '</tool_call>',
      ],
    },
    {
      tool: 'grep',
      lines: [
        'User: where do we configure the database URL?',
        'Assistant:',
        '<tool_call>',
        '{"name": "grep", "arguments": {"pattern": "DATABASE_URL", "caseInsensitive": false}}',
        '</tool_call>',
      ],
    },
    {
      tool: 'write_file',
      lines: [
        'User: create a new test file for the foo module.',
        'Assistant:',
        '<tool_call>',
        '{"name": "write_file", "arguments": {"path": "src/foo.test.ts", "content": "import { foo } from \'./foo\';\\n\\ntest(\'foo works\', () => {\\n  expect(foo()).toBe(true);\\n});\\n"}}',
        '</tool_call>',
      ],
    },
    {
      tool: 'edit_file',
      lines: [
        'User: rename the variable `count` to `total` in src/index.ts (it appears once).',
        'Assistant:',
        '<tool_call>',
        '{"name": "read_file", "arguments": {"path": "src/index.ts"}}',
        '</tool_call>',
        '(after seeing the result you would then call edit_file with the exact substring, e.g.)',
        '<tool_call>',
        '{"name": "edit_file", "arguments": {"path": "src/index.ts", "old_string": "let count = 0;", "new_string": "let total = 0;"}}',
        '</tool_call>',
      ],
    },
    {
      tool: 'bash',
      lines: [
        'User: run the tests.',
        'Assistant:',
        '<tool_call>',
        '{"name": "bash", "arguments": {"command": "npm test"}}',
        '</tool_call>',
      ],
    },
  ];
  const exampleBlock = examples
    .filter((e) => isEnabled(e.tool))
    .flatMap((e) => ['', ...e.lines])
    .join('\n');

  return [
    'You are a local coding assistant running inside overcli on the user\'s machine.',
    `You have real, working access to the user's project directory at: ${cwd}`,
    '',
    'AVAILABLE TOOLS (real, working — they read AND modify the user\'s actual disk):',
    toolBlock,
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
    '1. When you need to do something with files, you MUST call the appropriate tool. Do NOT describe what you "will" do.',
    '2. Never narrate ("I will read X", "I\'ll use the edit_file tool", "Let me list Y"). If you catch yourself typing those phrases, STOP and emit the <tool_call> block instead.',
    '3. Never fabricate file names, directory contents, or file content. If you have not called the tool yet, you do not know what is there.',
    '4. Only call the tools listed above. If a task asks for something that requires a tool not in your list, say so plainly — do not invent a tool name.',
    '5. After the tool returns, answer concisely using the real result.',
    '',
    'WORKED EXAMPLES:',
    exampleBlock,
    '',
    'WRONG (do NOT produce output like this):',
    '"I will read README.md to provide you with its contents."',
    '"Let me fetch the contents of that file."',
    '"I\'ll just use the edit_file tool."',
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
  /// Per-step tool allowlist. When set, only the named tools are
  /// dispatched; calls to other tools return a structured error so the
  /// model can correct course. Flow steps use this to enforce a
  /// researcher's read-only contract. Undefined = all tools allowed.
  enabledTools?: ReadonlySet<string>;
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
  // Track the previous no-tool-call text so we can detect a model spinning
  // on the same narration ("I'll use the edit_file tool." × 25). Once we
  // see the same gist twice in a row with no tool call, bail with a clear
  // error rather than letting the loop chew through the full round budget.
  let lastNoCallText: string | null = null;

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
      // Stuck-loop guard: a model that keeps emitting the same narration
      // round after round (gemma: "I'll just use the edit_file tool." ×25)
      // wastes the user's time and tokens. If we see substantially the
      // same text twice in a row, bail with a clear error instead of
      // chewing through the round budget.
      const norm = normalizeForRepeat(cleanedText);
      if (norm && norm === lastNoCallText) {
        return {
          ok: false,
          error:
            `Model stuck in a narration loop — produced the same text twice without ` +
            `calling a tool: "${truncate(cleanedText, 120)}". This usually means the ` +
            `model intends to use a tool (e.g. edit_file) but doesn't know the call ` +
            `format. Check the system prompt or try a different model.`,
          rounds: round + 1,
        };
      }
      if (norm) lastNoCallText = norm;

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

    // Any successful tool round resets the stuck-loop tracker — the
    // model is making progress.
    lastNoCallText = null;

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
        enabledTools: args.enabledTools,
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

/// Normalize for repeat-detection. Strips whitespace, punctuation, and
/// lowercases so "I'll just use the edit_file tool." matches "i'll just
/// use the edit_file tool" across rounds even when the model varies
/// punctuation. Empty string short-circuits to null at the caller.
function normalizeForRepeat(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase().replace(/[.,!?;:]+$/g, '');
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
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
