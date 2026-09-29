// An index of everything you typed, for the Work search.
//
// Names are what every list matches on, and names are the first sixty
// characters of the first thing you said — a typo in them ("deveopers") and
// the work is gone. The words you actually used are in the transcripts, but
// ~/.claude/projects runs to gigabytes, almost all of it tool output. So this
// keeps only the user's own prompts: a few percent of the bytes, read once per
// file and re-read only when the file changes.
//
// Claude transcripts only for now; the other CLIs keep their history in
// shapes that would each need their own reader.
//
// The cache is persisted to <userData>/work-prompt-index.json so a restart
// doesn't mean re-reading every transcript.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { host } from '../host';
import { log } from '../diagnostics';
import type { PromptHit } from '../../shared/workRecords';

const PER_PROMPT_CAP = 2000;
const PER_FILE_CAP = 60_000;
/// Line prefix filter. A user prompt line carries `"type":"user"`; one
/// holding a tool result is also type user, but its content is a
/// `tool_result` block and never a plain prompt.
const USER_MARK = '"type":"user"';

interface FileEntry {
  mtimeMs: number;
  size: number;
  sessionId: string;
  cwd: string;
  at: number;
  text: string;
}

interface IndexFile {
  v: 1;
  files: Record<string, FileEntry>;
}

let index: IndexFile | null = null;
let refreshing: Promise<void> | null = null;
let lastRefresh = 0;
const REFRESH_EVERY_MS = 30_000;

function indexPath(): string {
  return path.join(host().dataDir(), 'work-prompt-index.json');
}

function projectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/// The user's typed text on one transcript line, or null for anything else
/// (assistant turns, tool results, meta lines, command wrappers).
export function extractUserPrompt(line: string): { text: string; cwd: string; at: number } | null {
  if (!line.includes(USER_MARK)) return null;
  let j: any;
  try {
    j = JSON.parse(line);
  } catch {
    return null;
  }
  if (j?.type !== 'user' || j.isMeta) return null;
  const content = j.message?.content;
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    if (content.some((c: any) => c?.type === 'tool_result')) return null;
    text = content
      .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
      .map((c: any) => c.text)
      .join('\n');
  }
  text = text.trim();
  if (!text || text.startsWith('<command-') || text.startsWith('<local-command')) return null;
  const at = Date.parse(j.timestamp ?? '') || 0;
  return { text: text.slice(0, PER_PROMPT_CAP), cwd: typeof j.cwd === 'string' ? j.cwd : '', at };
}

function loadIndex(): IndexFile {
  if (index) return index;
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath(), 'utf-8')) as IndexFile;
    if (parsed?.v === 1 && parsed.files) index = parsed;
  } catch {
    // First run, or a torn write — rebuild.
  }
  index ??= { v: 1, files: {} };
  return index;
}

async function readPrompts(file: string): Promise<{ text: string; cwd: string; at: number }> {
  const stream = fs.createReadStream(file, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const parts: string[] = [];
  let size = 0;
  let cwd = '';
  let at = 0;
  try {
    for await (const line of rl) {
      const p = extractUserPrompt(line);
      if (!p) continue;
      if (!cwd && p.cwd) cwd = p.cwd;
      at = Math.max(at, p.at);
      if (size < PER_FILE_CAP) {
        parts.push(p.text);
        size += p.text.length;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { text: parts.join('\n\n'), cwd, at };
}

async function refresh(): Promise<void> {
  const idx = loadIndex();
  const root = projectsRoot();
  let dirs: string[];
  try {
    dirs = await fs.promises.readdir(root);
  } catch {
    return;
  }
  const seen = new Set<string>();
  let changed = false;
  for (const dir of dirs) {
    let files: string[];
    try {
      files = await fs.promises.readdir(path.join(root, dir));
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(root, dir, f);
      seen.add(full);
      let st: fs.Stats;
      try {
        st = await fs.promises.stat(full);
      } catch {
        continue;
      }
      const prev = idx.files[full];
      if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) continue;
      try {
        const { text, cwd, at } = await readPrompts(full);
        idx.files[full] = {
          mtimeMs: st.mtimeMs,
          size: st.size,
          sessionId: f.slice(0, -'.jsonl'.length),
          cwd,
          at: at || st.mtimeMs,
          text,
        };
        changed = true;
      } catch (err) {
        log('warn', 'work.promptIndex', `could not read ${full}`, err);
      }
    }
  }
  for (const k of Object.keys(idx.files)) {
    if (!seen.has(k)) {
      delete idx.files[k];
      changed = true;
    }
  }
  if (changed) {
    try {
      const tmp = `${indexPath()}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(idx));
      await fs.promises.rename(tmp, indexPath());
    } catch (err) {
      log('warn', 'work.promptIndex', 'could not persist prompt index', err);
    }
  }
}

function ensureFresh(): Promise<void> {
  if (refreshing) return refreshing;
  if (Date.now() - lastRefresh < REFRESH_EVERY_MS && index) return Promise.resolve();
  refreshing = refresh()
    .catch((err) => log('warn', 'work.promptIndex', 'refresh failed', err))
    .finally(() => {
      lastRefresh = Date.now();
      refreshing = null;
    });
  return refreshing;
}

/// Warm the index in the background so the first search isn't the slow one.
export function warmPromptIndex(): void {
  void ensureFresh();
}

/// Transcripts whose typed prompts contain every word of the query.
export async function searchPrompts(query: string, limit = 60): Promise<PromptHit[]> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length || words.join('').length < 3) return [];
  await ensureFresh();
  const idx = loadIndex();
  const hits: PromptHit[] = [];
  for (const e of Object.values(idx.files)) {
    const lower = e.text.toLowerCase();
    if (!words.every((w) => lower.includes(w))) continue;
    const at = lower.indexOf(words[0]);
    const start = Math.max(0, at - 90);
    hits.push({
      sessionId: e.sessionId,
      cwd: e.cwd,
      snippet: e.text.slice(start, at + words[0].length + 110),
      at: e.at,
    });
  }
  return hits.sort((a, b) => b.at - a.at).slice(0, limit);
}
