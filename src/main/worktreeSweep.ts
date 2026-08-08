// Worktree sweep — find agent/flow worktrees that outlived whatever created
// them and offer them for removal.
//
// Worktrees are deliberately long-lived: a conversation keeps its tree so you
// can reopen the chat and carry on. What was missing is the exit ramp. Nothing
// removed a tree when the work was actually finished, and two paths orphaned
// trees outright — `pruneOldRuns` evicts run metadata without touching the
// worktrees it recorded (see `removeRunWorktrees`), and a failed
// `git worktree remove` used to still drop the conversation row, leaving a
// tree no code path could ever reach again.
//
// This module reads the truth from git rather than from app state: for each
// project, `git worktree list --porcelain` is the authority on what exists.
// App state only decides whether something is still *spoken for*.

import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { runGitAsync, detectBaseBranchAsync, removeWorktreeAsync } from './git';
import { log } from './diagnostics';
import type {
  WorktreeSweepEntry,
  WorktreeSweepBucket,
  WorktreeSweepResult,
} from '../shared/types';

/// Root `createWorktree` mints into. Anything git reports outside this tree
/// belongs to someone else — a hand-rolled worktree, another tool's (Claude
/// Code uses `~/git-worktrees`), a checkout the user set up themselves. We
/// surface those so the accounting is honest, but never offer to delete them.
export function managedWorktreeRoot(): string {
  return path.join(os.homedir(), '.overcli', 'worktrees');
}

function isUnderManagedRoot(worktreePath: string): boolean {
  const root = managedWorktreeRoot();
  const rel = path.relative(root, worktreePath);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export interface ParsedWorktree {
  worktreePath: string;
  /// Short branch name (`refs/heads/` stripped), or null for a detached
  /// HEAD — review worktrees are detached by design.
  branchName: string | null;
  locked: boolean;
  /// git considers the registration stale (the directory is gone). Nothing
  /// to remove from disk; `git worktree prune` is what clears these.
  prunable: boolean;
}

/// Parse `git worktree list --porcelain`. Records are separated by blank
/// lines; the FIRST record is always the main checkout, which is never a
/// sweep candidate, so callers drop it. Keys we care about:
///   worktree <path> / branch refs/heads/<name> / detached / locked / prunable
/// `locked` and `prunable` may carry a trailing reason we ignore.
export function parseWorktreeList(porcelain: string): ParsedWorktree[] {
  const out: ParsedWorktree[] = [];
  let current: ParsedWorktree | null = null;
  const flush = (): void => {
    if (current) out.push(current);
    current = null;
  };
  for (const rawLine of porcelain.split('\n')) {
    const line = rawLine.trim();
    if (line === '') {
      flush();
      continue;
    }
    const sep = line.indexOf(' ');
    const key = sep === -1 ? line : line.slice(0, sep);
    const value = sep === -1 ? '' : line.slice(sep + 1);
    if (key === 'worktree') {
      flush();
      current = { worktreePath: value, branchName: null, locked: false, prunable: false };
      continue;
    }
    if (!current) continue;
    if (key === 'branch') current.branchName = value.replace(/^refs\/heads\//, '');
    else if (key === 'locked') current.locked = true;
    else if (key === 'prunable') current.prunable = true;
  }
  flush();
  return out;
}

/// Decide what a worktree is, given git's view of it plus whether app state
/// still points at it. Precedence matters and is deliberately conservative —
/// each rule can only ever move an entry to a LESS deletable bucket than the
/// one below it:
///   foreign      — outside the managed root; not ours to touch
///   live         — a conversation or flow run still references it
///   has-work     — unreferenced, but holds changes that would be destroyed
///   reclaimable  — unreferenced, clean, and nothing unmerged. Safe.
/// "Unreferenced" alone never makes something reclaimable: an orphan with
/// uncommitted work still lands in `has-work` so the sweep can't quietly
/// discard it. And anything still referenced is `live` however old it is —
/// ageing a conversation out means deleting the conversation, which is
/// Settings → Conversations' job, not a disk sweep's.
export function classifyWorktree(args: {
  worktreePath: string;
  referenced: 'conversation' | 'run' | null;
  dirtyFiles: number;
  commitsAhead: number;
  isMergedIntoBase: boolean;
}): WorktreeSweepBucket {
  if (!isUnderManagedRoot(args.worktreePath)) return 'foreign';
  if (args.referenced) return 'live';
  if (args.dirtyFiles > 0) return 'has-work';
  if (args.commitsAhead > 0 && !args.isMergedIntoBase) return 'has-work';
  return 'reclaimable';
}

/// Run `tasks` with at most `limit` in flight. The scan fans out four cheap
/// git/du calls per worktree across potentially hundreds of trees; without a
/// cap that is thousands of concurrent subprocesses.
async function pooled<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

/// Apparent disk usage in KB. Best-effort — a `du` failure reports 0 rather
/// than failing the scan, since size is informational.
function duKb(target: string): Promise<number> {
  return new Promise((resolve) => {
    execFile('du', ['-sk', target], { encoding: 'utf-8' }, (err, stdout) => {
      if (err && !stdout) return resolve(0);
      const n = Number.parseInt((stdout || '').trim().split(/\s+/)[0] ?? '', 10);
      resolve(Number.isFinite(n) ? n : 0);
    });
  });
}

/// Gather per-worktree detail. Each field degrades to a "looks like it has
/// work" answer on git failure so an unreadable tree is never classified as
/// safe to delete.
async function inspect(args: {
  worktreePath: string;
  projectPath: string;
  branchName: string | null;
  baseBranch: string;
  prunable: boolean;
}): Promise<{
  dirtyFiles: number;
  commitsAhead: number;
  isMergedIntoBase: boolean;
  sizeKb: number;
  lastCommitAt?: number;
}> {
  // A prunable registration has no directory behind it — every probe would
  // fail. Report it as empty and clean; `git worktree prune` clears it.
  if (args.prunable) {
    return { dirtyFiles: 0, commitsAhead: 0, isMergedIntoBase: true, sizeKb: 0 };
  }
  const [status, ahead, merged, sizeKb, lastCommit] = await Promise.all([
    runGitAsync(['status', '--porcelain'], args.worktreePath),
    args.branchName
      ? runGitAsync(['rev-list', '--count', `${args.baseBranch}..${args.branchName}`], args.projectPath)
      : Promise.resolve({ stdout: '0', stderr: '', exitCode: 0 }),
    args.branchName
      ? runGitAsync(
          ['merge-base', '--is-ancestor', args.branchName, args.baseBranch],
          args.projectPath,
        )
      : Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
    duKb(args.worktreePath),
    // Dates an orphan. Its conversation is gone, so there's no `lastActiveAt`
    // to age it by — but the last commit in the tree is a good proxy for when
    // work stopped, and it makes the date filter meaningful on every row
    // rather than only the ones a conversation still claims.
    runGitAsync(['log', '-1', '--format=%ct'], args.worktreePath),
  ]);
  // An unreadable status is treated as dirty: we'd rather leave a tree
  // behind than delete one we couldn't inspect.
  const dirtyFiles =
    status.exitCode !== 0
      ? 1
      : status.stdout.split('\n').filter((l) => l.trim().length > 0).length;
  const commitsAhead =
    ahead.exitCode === 0 ? Number.parseInt(ahead.stdout.trim(), 10) || 0 : 0;
  const commitSeconds =
    lastCommit.exitCode === 0 ? Number.parseInt(lastCommit.stdout.trim(), 10) : NaN;
  return {
    dirtyFiles,
    commitsAhead,
    isMergedIntoBase: merged.exitCode === 0,
    sizeKb,
    lastCommitAt: Number.isFinite(commitSeconds) ? commitSeconds * 1000 : undefined,
  };
}

/// Scan every project for worktrees, classify each, and report totals.
/// `runPaths`/`conversationPaths` are supplied by the caller: the renderer
/// owns live conversation state and the flow runtime owns run state, so
/// neither is re-derived from disk here (reading a stale `overcli.json` could
/// report a live tree as an orphan).
///
/// Two passes, because the expensive work is worth avoiding. Pass one needs
/// nothing but `git worktree list` and the referenced-path sets, and that is
/// already enough to settle `live` and `foreign` — which on a real install is
/// most of them. Only what survives gets pass two (status, merge-base, `du`),
/// which costs seconds per worktree and dominates the scan: measured over 867
/// worktrees, inspecting everything took ~4 minutes, and `du` alone was 83s of
/// it. Sizes for `live`/`foreign` entries would have cost most of that budget
/// to display a number the user can't act on, so those report `sizeKb: 0` and
/// the UI shows counts for them instead.
export async function scanWorktrees(
  args: {
    projects: Array<{ path: string; name: string }>;
    conversationPaths: string[];
    runPaths: string[];
  },
  onProgress?: (p: { completed: number; total: number }) => void,
): Promise<WorktreeSweepResult> {
  const convSet = new Set(args.conversationPaths.map((p) => path.resolve(p)));
  const runSet = new Set(args.runPaths.map((p) => path.resolve(p)));

  const perProject = await pooled(
    args.projects.map((project) => async () => {
      const listed = await runGitAsync(
        ['worktree', 'list', '--porcelain'],
        project.path,
      );
      if (listed.exitCode !== 0) {
        // Not a git repo, or the project directory is gone. Not an error
        // worth failing the whole scan over.
        return { project, worktrees: [] as ParsedWorktree[], baseBranch: 'main' };
      }
      const all = parseWorktreeList(listed.stdout);
      // Drop the main checkout — it's the repo itself, never a candidate.
      const mainPath = path.resolve(project.path);
      const worktrees = all.filter((w) => path.resolve(w.worktreePath) !== mainPath);
      const baseBranch = await detectBaseBranchAsync(project.path);
      return { project, worktrees, baseBranch };
    }),
    6,
  );

  // Pass one: everything decidable from the path and the referenced sets.
  const staged = perProject.flatMap(({ project, worktrees, baseBranch }) =>
    worktrees.map((wt) => {
      const resolved = path.resolve(wt.worktreePath);
      const referenced: 'conversation' | 'run' | null = convSet.has(resolved)
        ? 'conversation'
        : runSet.has(resolved)
          ? 'run'
          : null;
      const base: WorktreeSweepEntry = {
        worktreePath: wt.worktreePath,
        projectPath: project.path,
        projectName: project.name,
        branchName: wt.branchName,
        baseBranch,
        referenced,
        locked: wt.locked,
        prunable: wt.prunable,
        dirtyFiles: 0,
        commitsAhead: 0,
        isMergedIntoBase: false,
        sizeKb: 0,
        // Provisional. Fed clean-looking detail, `classifyWorktree` can only
        // answer foreign/live/reclaimable; the reclaimable ones are exactly
        // what pass two must verify before we stand behind that answer.
        bucket: classifyWorktree({
          worktreePath: wt.worktreePath,
          referenced,
          dirtyFiles: 0,
          commitsAhead: 0,
          isMergedIntoBase: true,
        }),
      };
      return { entry: base, project, baseBranch, wt };
    }),
  );

  const candidates = staged.filter((s) => s.entry.bucket === 'reclaimable');
  const settled = staged.filter((s) => s.entry.bucket !== 'reclaimable').map((s) => s.entry);

  // Pass two: the real inspection, only for entries that could be removed.
  let completed = 0;
  const total = candidates.length;
  onProgress?.({ completed: 0, total });
  const inspected = await pooled(
    candidates.map(({ entry, project, baseBranch, wt }) => async () => {
      const detail = await inspect({
        worktreePath: wt.worktreePath,
        projectPath: project.path,
        branchName: wt.branchName,
        baseBranch,
        prunable: wt.prunable,
      });
      completed++;
      onProgress?.({ completed, total });
      return {
        ...entry,
        ...detail,
        bucket: classifyWorktree({
          worktreePath: wt.worktreePath,
          referenced: entry.referenced,
          dirtyFiles: detail.dirtyFiles,
          commitsAhead: detail.commitsAhead,
          isMergedIntoBase: detail.isMergedIntoBase,
        }),
      };
    }),
    6,
  );

  const entries = [...settled, ...inspected];
  entries.sort(
    (a, b) =>
      a.projectName.localeCompare(b.projectName) ||
      a.worktreePath.localeCompare(b.worktreePath),
  );
  return { entries, scannedAt: Date.now() };
}

/// What deleting each conversation's worktree would cost. Settings →
/// Conversations is about history rather than disk, so this deliberately
/// skips the `du` that dominates `scanWorktrees` — it only answers "is there
/// work in here that removal would destroy?". Fast enough to run over every
/// agent conversation without a progress bar.
export async function conversationWorktreeStates(args: {
  targets: Array<{
    convId: string;
    projectPath: string;
    worktreePath: string;
    branchName: string | null;
    baseBranch: string;
  }>;
}): Promise<
  Array<{
    convId: string;
    exists: boolean;
    dirtyFiles: number;
    commitsAhead: number;
    isMergedIntoBase: boolean;
  }>
> {
  return pooled(
    args.targets.map((t) => async () => {
      const status = await runGitAsync(['status', '--porcelain'], t.worktreePath);
      // A non-zero status here means the directory is gone or isn't a work
      // tree. Report it rather than guessing: the pane shows "worktree
      // already gone", and deleting the conversation is then trivially safe.
      if (status.exitCode !== 0) {
        return {
          convId: t.convId,
          exists: false,
          dirtyFiles: 0,
          commitsAhead: 0,
          isMergedIntoBase: true,
        };
      }
      const [ahead, merged] = await Promise.all([
        t.branchName
          ? runGitAsync(
              ['rev-list', '--count', `${t.baseBranch}..${t.branchName}`],
              t.projectPath,
            )
          : Promise.resolve({ stdout: '0', stderr: '', exitCode: 0 }),
        t.branchName
          ? runGitAsync(
              ['merge-base', '--is-ancestor', t.branchName, t.baseBranch],
              t.projectPath,
            )
          : Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
      ]);
      return {
        convId: t.convId,
        exists: true,
        dirtyFiles: status.stdout.split('\n').filter((l) => l.trim().length > 0).length,
        commitsAhead:
          ahead.exitCode === 0 ? Number.parseInt(ahead.stdout.trim(), 10) || 0 : 0,
        isMergedIntoBase: merged.exitCode === 0,
      };
    }),
    8,
  );
}

/// Branches the sweep will never delete, even when a worktree sitting on one
/// is otherwise reclaimable. git already stops two worktrees sharing a branch,
/// so a linked worktree can only be on `master` when the main checkout has
/// moved off it — rare, but that is exactly the state where deleting the
/// branch would be worst. The worktree still gets removed; only the branch
/// delete is skipped.
const PROTECTED_BRANCHES = new Set(['main', 'master', 'develop', 'trunk', 'HEAD']);

export function isProtectedBranch(branchName: string | null, baseBranch?: string): boolean {
  if (!branchName) return false;
  if (baseBranch && branchName === baseBranch) return true;
  return PROTECTED_BRANCHES.has(branchName);
}

/// Remove the selected worktrees. Mirrors the single-agent path
/// (`removeWorktree`): `git worktree remove --force` then a safe branch
/// delete that only escalates to `-D` for genuinely unmerged branches.
/// Each project touched gets a final `git worktree prune` to clear stale
/// registrations — including entries that were already `prunable` and so
/// had no directory to remove.
export async function sweepWorktrees(args: {
  entries: Array<{
    projectPath: string;
    worktreePath: string;
    branchName: string | null;
    baseBranch?: string;
  }>;
}): Promise<{
  removed: number;
  freedKb: number;
  failures: Array<{ worktreePath: string; error: string }>;
  warnings: string[];
}> {
  const failures: Array<{ worktreePath: string; error: string }> = [];
  const warnings: string[] = [];
  let removed = 0;
  let freedKb = 0;

  // Refuse anything outside the managed root even if a caller asks — the
  // renderer already filters, but this is the last gate before a
  // destructive git call and it should not depend on the UI being correct.
  const safe = args.entries.filter((e) => {
    if (isUnderManagedRoot(e.worktreePath)) return true;
    failures.push({
      worktreePath: e.worktreePath,
      error: 'Refused: outside the overcli-managed worktree root.',
    });
    return false;
  });

  // Sequential: these are destructive git mutations against a shared repo
  // (branch deletes touch the same refs), and a sweep is not latency-
  // sensitive. Concurrency here would buy little and risk index contention.
  for (const entry of safe) {
    const sizeKb = await duKb(entry.worktreePath);
    // An empty branchName makes `removeWorktreeAsync` skip the branch delete
    // entirely — the same path detached review worktrees take.
    const protectedBranch = isProtectedBranch(entry.branchName, entry.baseBranch);
    if (protectedBranch) {
      warnings.push(
        `Removed the worktree at ${entry.worktreePath} but kept branch \`${entry.branchName}\` — protected branch.`,
      );
    }
    try {
      const res = await removeWorktreeAsync({
        projectPath: entry.projectPath,
        worktreePath: entry.worktreePath,
        branchName: protectedBranch ? '' : (entry.branchName ?? ''),
      });
      if (!res.ok) {
        failures.push({ worktreePath: entry.worktreePath, error: res.error ?? 'unknown error' });
        continue;
      }
      if (res.warning) warnings.push(res.warning);
      removed++;
      freedKb += sizeKb;
    } catch (err) {
      failures.push({
        worktreePath: entry.worktreePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (const projectPath of new Set(safe.map((e) => e.projectPath))) {
    const pruned = await runGitAsync(['worktree', 'prune'], projectPath);
    if (pruned.exitCode !== 0) {
      log(
        'warn',
        'worktreeSweep',
        `git worktree prune failed in ${projectPath}: ${pruned.stderr || pruned.stdout}`,
      );
    }
  }

  return { removed, freedKb, failures, warnings };
}
