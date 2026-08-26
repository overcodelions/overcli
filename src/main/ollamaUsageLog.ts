// Per-turn Ollama token log.
//
// Every other backend leaves a transcript on disk that computeStats() can
// re-read (~/.claude/projects, ~/.codex/sessions, ~/.gemini/tmp), so its
// token counts survive the app closing. Ollama has no such transcript: the
// counts arrive once, on the `done` frame of a streaming /api/chat call
// (`prompt_eval_count` / `eval_count`), and were only ever forwarded to the
// live UI. `scanOllama` had nowhere to read them from and hardcoded zeroes,
// which is why the Usage pane showed "Local · 32 turns · 0 tokens".
//
// So we write them down as they happen. One JSONL line per model round —
// appended, never rewritten, at <userData>/ollama-usage.jsonl. A round is
// the unit rather than a turn because a tool-using turn makes several
// round-trips and each one costs real tokens.
//
// Timestamps are per-round and real, which also fixes the rolling
// 5h/24h/7d windows and the daily chart for local models — the store scan
// can only attribute a whole conversation to its last-active day.

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import os from 'node:os';
import { logSilent } from './diagnostics';

export interface OllamaUsageEntry {
  /// Epoch ms of the round that produced these counts.
  ts: number;
  /// Working directory of the conversation — how stats attributes the
  /// tokens to a project row, matching `scanOllama`'s use of project path.
  cwd: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/// ~90 bytes a line, so this caps the file around 5MB. Trimming happens on
/// append, and only once the file is meaningfully over — rewriting 50k
/// lines on every round would be absurd.
const MAX_ENTRIES = 50_000;
const TRIM_SLACK = 5_000;
/// Conservative floor on a serialized line's byte length. Used to rule out the
/// full-file read without counting lines; a real entry is ~90 bytes.
const MIN_BYTES_PER_ENTRY = 60;

export function ollamaUsageLogPath(): string {
  let base: string;
  try {
    base = app.getPath('userData');
  } catch {
    // The stats CLI harness runs without Electron. Mirror overcliStorePath()'s
    // fallback so a headless scan reads the same file the app writes.
    const home = os.homedir();
    base =
      process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support', 'overcli')
        : process.platform === 'win32'
          ? path.join(home, 'AppData', 'Roaming', 'overcli')
          : path.join(home, '.config', 'overcli');
  }
  return path.join(base, 'ollama-usage.jsonl');
}

/// Best-effort: a failed write costs one round's numbers in the Usage pane
/// and must never take down a turn that otherwise succeeded.
export function recordOllamaUsage(entry: OllamaUsageEntry): void {
  if (!entry.inputTokens && !entry.outputTokens) return;
  const file = ollamaUsageLogPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // A crash mid-append leaves a line with no terminator. Appending straight
    // onto it would glue this round to the torn one and lose BOTH — so start
    // a fresh line first and let the reader discard the fragment alone.
    fs.appendFileSync(file, `${endsWithNewline(file) ? '' : '\n'}${JSON.stringify(entry)}\n`, 'utf-8');
  } catch (err) {
    logSilent('ollama.usageLog.write', err);
    return;
  }
  maybeTrim(file);
}

function endsWithNewline(file: string): boolean {
  let fd: number | undefined;
  try {
    const size = fs.statSync(file).size;
    if (size === 0) return true;
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(1);
    fs.readSync(fd, buf, 0, 1, size - 1);
    return buf[0] === 0x0a;
  } catch {
    // No file yet (the common case) — appendFileSync will create it.
    return true;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function maybeTrim(file: string): void {
  try {
    // `logOllamaUsage` fires once per model ROUND, and at steady state this
    // file sits near 4.5MB — reading it whole just to decide whether to trim
    // costs a multi-megabyte synchronous read on the main process every round.
    if (fs.statSync(file).size < (MAX_ENTRIES + TRIM_SLACK) * MIN_BYTES_PER_ENTRY) return;
    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    if (lines.length <= MAX_ENTRIES + TRIM_SLACK) return;
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${lines.slice(lines.length - MAX_ENTRIES).join('\n')}\n`, 'utf-8');
    fs.renameSync(tmp, file);
  } catch (err) {
    logSilent('ollama.usageLog.trim', err);
  }
}

/// Malformed lines are skipped rather than aborting the read — a torn line
/// from a crash mid-append shouldn't cost the user every earlier round.
export function readOllamaUsage(): OllamaUsageEntry[] {
  const file = ollamaUsageLogPath();
  let raw: string;
  try {
    if (!fs.existsSync(file)) return [];
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    logSilent('ollama.usageLog.read', err);
    return [];
  }
  const out: OllamaUsageEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const p = JSON.parse(line);
      const ts = Number(p?.ts);
      if (!Number.isFinite(ts) || ts <= 0) continue;
      out.push({
        ts,
        cwd: typeof p?.cwd === 'string' ? p.cwd : '',
        model: typeof p?.model === 'string' && p.model ? p.model : 'ollama',
        inputTokens: Number(p?.inputTokens) || 0,
        outputTokens: Number(p?.outputTokens) || 0,
      });
    } catch {
      // torn or hand-edited line
    }
  }
  return out;
}
