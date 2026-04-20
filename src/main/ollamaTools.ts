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
import { OllamaToolDefinition } from './ollama';

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
