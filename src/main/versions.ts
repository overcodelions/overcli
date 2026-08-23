import fs from 'node:fs';
import path from 'node:path';
import { commitAllAsync, readProjectLog, restoreProjectVersion } from './git';
import type { ProjectVersion } from './git';

/// Checkpointing for everyday projects.
///
/// These folders get a git repo at creation so their owner can undo anything
/// Overcli does. That promise only holds if something actually commits —
/// otherwise the history is a single starting-point snapshot and "restore"
/// means throwing away everything since.
///
/// Checkpoints fire on BOUNDARIES, not on saves: a kept rewrite, a finished
/// agent run, documents arriving, a spell of editing ending. One commit per
/// keystroke-burst would be thousands of entries and a history nobody can
/// read, which is the same as no history at all.

/// Skip the checkpoint when the pending change is bigger than this. Git can
/// never garbage-collect a reachable blob, so a 40 MB PDF revised twenty
/// times permanently costs ~800 MB inside someone's Documents folder. Text
/// documents — the thing this feature is for — never come close.
export const MAX_CHECKPOINT_BYTES = 25 * 1024 * 1024;

/// Entry cap on the pre-checkpoint size walk, matching fileWalk.ts.
const MAX_SIZE_WALK_ENTRIES = 20_000;

export interface CheckpointResult {
  ok: boolean;
  /// Set when we deliberately skipped, so callers can stay quiet instead of
  /// reporting a failure the user cannot act on.
  skipped?: 'nothing-to-save' | 'too-large';
  error?: string;
}

/// Bytes of every file with pending changes, so an oversized checkpoint can
/// be declined before it lands in the object store rather than after.
export function pendingChangeBytes(cwd: string, porcelain: string): number {
  let total = 0;
  const budget = { left: MAX_SIZE_WALK_ENTRIES };
  for (const line of porcelain.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // Porcelain v1: two status chars, a space, then the path. Renames carry
    // `old -> new`; the new name is the one on disk.
    const raw = line.slice(3).trim();
    const rel = raw.includes(' -> ') ? raw.slice(raw.indexOf(' -> ') + 4) : raw;
    const unquoted = rel.startsWith('"') && rel.endsWith('"') ? rel.slice(1, -1) : rel;
    total += sizeOnDisk(path.join(cwd, unquoted), 0, budget);
  }
  return total;
}

/// Bytes at a path, recursing when it is a directory. Porcelain collapses a
/// wholly-untracked folder into a single `?? exports/` entry, so measuring
/// only files would report zero for the 40 MB of artifacts inside it.
function sizeOnDisk(target: string, depth = 0, budget = { left: MAX_SIZE_WALK_ENTRIES }): number {
  // Cheap cycle/runaway guard; a documents folder is never this deep.
  if (depth > 12) return 0;
  // Cap hit: fail safe as "too large" rather than freezing the main process.
  if (--budget.left < 0) return Number.MAX_SAFE_INTEGER;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    return 0; // Deleted, or unreadable — it costs nothing to store.
  }
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let total = 0;
  try {
    for (const entry of fs.readdirSync(target)) {
      if (entry === '.git') continue;
      total += sizeOnDisk(path.join(target, entry), depth + 1, budget);
    }
  } catch {
    // Unreadable directory — treat as empty rather than failing the guard.
  }
  return total;
}

export async function checkpointProject(
  args: { projectPath: string; message: string },
  deps: {
    statusPorcelain: (cwd: string) => Promise<string>;
    commit: typeof commitAllAsync;
    sizeOf?: (cwd: string, porcelain: string) => number;
  },
): Promise<CheckpointResult> {
  const porcelain = await deps.statusPorcelain(args.projectPath);
  if (!porcelain.trim()) return { ok: false, skipped: 'nothing-to-save' };

  const bytes = (deps.sizeOf ?? pendingChangeBytes)(args.projectPath, porcelain);
  if (bytes > MAX_CHECKPOINT_BYTES) return { ok: false, skipped: 'too-large' };

  const res = await deps.commit({ cwd: args.projectPath, message: args.message });
  if (res.ok) return { ok: true };
  if (res.nothingToCommit) return { ok: false, skipped: 'nothing-to-save' };
  return { ok: false, error: res.error };
}

export async function listVersions(
  args: { projectPath: string; limit?: number },
): Promise<{ ok: true; versions: ProjectVersion[] } | { ok: false; error: string }> {
  return readProjectLog({ cwd: args.projectPath, limit: args.limit ?? 50 });
}

export async function restoreVersion(
  args: { projectPath: string; sha: string; label: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await restoreProjectVersion({
    cwd: args.projectPath,
    sha: args.sha,
    label: args.label,
  });
  return res.ok ? { ok: true } : res;
}
