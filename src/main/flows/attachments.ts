// Out-of-prompt attachments for flow inputs that would otherwise blow
// the per-step context budget. We write the artifact body to a file
// under userData and the step prompt references the absolute path —
// the CLI's own Read tool loads the bytes when the model asks for them.
//
// Why not write into the run's cwd? Per project convention we don't
// write to the user's git repos (it would leak run-scoped junk into
// their working tree and we can't predict their .gitignore). userData
// is private to the app.
//
// Only used for the premium backends (claude/codex/gemini/copilot)
// whose Read tools can take an absolute path. Ollama's read_file is
// cwd-scoped via `safeResolve`, so attachments are silently skipped on
// that path and the runtime falls back to inline + budget truncation.

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

function rootDir(): string {
  return path.join(app.getPath('userData'), 'flow-attachments');
}

function runDir(runId: string): string {
  return path.join(rootDir(), runId);
}

/// Map an artifact name to a filesystem-safe filename. Artifact names
/// can include `.` and `-` (e.g. `plan_review.md`) so we mostly let
/// them through; anything outside `[A-Za-z0-9._-]` is replaced. Empty
/// names fall back to a hash-like stub so we never produce a literal
/// `/` or hidden `.` filename.
function safeFilename(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned || 'input';
}

export interface WrittenAttachment {
  /// Absolute path that the step prompt will reference.
  path: string;
  /// Bytes written (== `body.length`, but returned for convenience so
  /// callers don't have to recompute when shaping the prompt).
  size: number;
}

/// Write `body` as an attachment for `runId/name`. Creates the run's
/// attachment directory on demand. Returns the absolute path on disk.
/// Failure is fatal at the caller's discretion — most callers fall back
/// to inlining the body if this throws.
export function writeAttachment(
  runId: string,
  name: string,
  body: string,
): WrittenAttachment {
  const dir = runDir(runId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, safeFilename(name));
  fs.writeFileSync(file, body, 'utf-8');
  return { path: file, size: body.length };
}

/// Recursively delete all attachments for `runId`. Best-effort: errors
/// are swallowed because attachments are transient — a stuck file
/// shouldn't keep a run from being evicted.
export function clearAttachments(runId: string): void {
  const dir = runDir(runId);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}
