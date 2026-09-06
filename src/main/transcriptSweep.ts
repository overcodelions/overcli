// Leftover transcripts — the pile Cleanup used to leave behind.
//
// Deleting a conversation removes overcli's record of it. It does NOT remove
// the transcript, because overcli never wrote one: Claude keeps its own
// `<sessionId>.jsonl` under `~/.claude/projects/<cwd-slug>/`, keyed by the
// directory the session ran in. When that directory was a worktree we then
// deleted, the folder is stranded — no worktree, no conversation, nothing in
// the app that can reach it, and nothing that will ever clean it up.
//
// Measured on a real install before this existed: 60 stranded folders, 93 MB,
// accumulated by the OLD delete paths. It grows every time anything is
// removed, in a directory nobody looks at. So Cleanup reports it.
//
// Two rules keep this honest:
//
//   1. Slugs are computed FORWARD only. `claudeProjectSlug` maps `/`, `.` and
//      ` ` all to `-`, which is lossy — `-Users-me--overcli-worktrees-x` has
//      several possible originals. Reversing it to ask "does this path still
//      exist?" would sooner or later delete a transcript whose worktree is
//      alive. Instead we slug every worktree that EXISTS and treat that set as
//      the authority: a live worktree always produces its own slug, so a live
//      one can never be mistaken for an orphan.
//   2. Only folders under the managed worktree root's slug prefix are ever
//      candidates. A transcript from a real project checkout — the sessions
//      people actually go back to — is never in scope, whatever its age.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { claudeProjectSlug } from './history';
import { managedWorktreeRoot } from './worktreeSweep';
import { log } from './diagnostics';
import type { OrphanTranscriptEntry } from '../shared/types';

export function claudeProjectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/// Whether a transcript folder belongs to a worktree that is gone.
///
/// `liveSlugs` are the slugs of worktrees that exist right now; `rootSlug` is
/// the slug of the managed worktree root. Anything outside that prefix is
/// somebody else's and answers false.
export function isOrphanTranscriptDir(
  dirName: string,
  liveSlugs: ReadonlySet<string>,
  rootSlug: string,
): boolean {
  if (!dirName.startsWith(rootSlug)) return false;
  // The root itself, if it ever has a folder, is not a worktree.
  if (dirName === rootSlug) return false;
  return !liveSlugs.has(dirName);
}

/// Slugs for every worktree currently on disk under the managed root.
export function liveWorktreeSlugs(): Set<string> {
  const root = managedWorktreeRoot();
  const out = new Set<string>();
  let projects: fs.Dirent[];
  try {
    projects = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    // No managed root yet — then nothing under its slug prefix can be ours,
    // and `scanOrphanTranscripts` will report nothing rather than everything.
    return out;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDir = path.join(root, project.name);
    let trees: fs.Dirent[];
    try {
      trees = fs.readdirSync(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const tree of trees) {
      if (tree.isDirectory()) out.add(claudeProjectSlug(path.join(projectDir, tree.name)));
    }
  }
  return out;
}

/// Bytes and file count under a directory. These are transcript folders —
/// a handful of `.jsonl` files — so this walks them directly rather than
/// paying for a `du` subprocess each.
function measure(dir: string): { sizeKb: number; fileCount: number; modifiedAt: number } {
  let bytes = 0;
  let fileCount = 0;
  let modifiedAt = 0;
  const walk = (at: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      try {
        const stat = fs.statSync(full);
        bytes += stat.size;
        fileCount++;
        if (stat.mtimeMs > modifiedAt) modifiedAt = stat.mtimeMs;
      } catch {
        /* raced with a delete, or unreadable — skip it */
      }
    }
  };
  walk(dir);
  return { sizeKb: Math.round(bytes / 1024), fileCount, modifiedAt };
}

/// Transcript folders whose worktree is gone.
export function scanOrphanTranscripts(): {
  entries: OrphanTranscriptEntry[];
  scannedAt: number;
} {
  const root = claudeProjectsRoot();
  const rootSlug = claudeProjectSlug(managedWorktreeRoot());
  const live = liveWorktreeSlugs();
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { entries: [], scannedAt: Date.now() };
  }
  const entries: OrphanTranscriptEntry[] = [];
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    if (!isOrphanTranscriptDir(dir.name, live, rootSlug)) continue;
    const dirPath = path.join(root, dir.name);
    const { sizeKb, fileCount, modifiedAt } = measure(dirPath);
    // A folder with nothing in it is not worth reporting as reclaimable
    // storage, but it is still litter — keep it, at zero.
    entries.push({ dirPath, sizeKb, fileCount, modifiedAt: modifiedAt || undefined });
  }
  entries.sort((a, b) => b.sizeKb - a.sizeKb || a.dirPath.localeCompare(b.dirPath));
  return { entries, scannedAt: Date.now() };
}

/// Delete transcript folders. The last gate before an irreversible recursive
/// delete, so it re-derives everything rather than trusting the caller: a
/// path must sit directly under `~/.claude/projects`, carry the managed
/// worktree root's slug prefix, and still be orphaned at this instant.
export function removeOrphanTranscripts(args: { dirPaths: string[] }): {
  removed: number;
  freedKb: number;
  failures: Array<{ dirPath: string; error: string }>;
} {
  const root = claudeProjectsRoot();
  const rootSlug = claudeProjectSlug(managedWorktreeRoot());
  const live = liveWorktreeSlugs();
  const failures: Array<{ dirPath: string; error: string }> = [];
  let removed = 0;
  let freedKb = 0;

  for (const dirPath of args.dirPaths) {
    const resolved = path.resolve(dirPath);
    const name = path.basename(resolved);
    if (path.dirname(resolved) !== path.resolve(root)) {
      failures.push({ dirPath, error: 'Refused: not a Claude transcript folder.' });
      continue;
    }
    if (!isOrphanTranscriptDir(name, live, rootSlug)) {
      failures.push({
        dirPath,
        error: 'Refused: this folder belongs to a worktree that still exists.',
      });
      continue;
    }
    const { sizeKb } = measure(resolved);
    try {
      fs.rmSync(resolved, { recursive: true, force: true });
      removed++;
      freedKb += sizeKb;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log('error', 'transcriptSweep', `failed to remove ${resolved}: ${error}`);
      failures.push({ dirPath, error });
    }
  }
  return { removed, freedKb, failures };
}
