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
  WorktreeClaim,
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

/// Decide what a worktree is, given git's view of it plus whether the thing
/// that made it is still working. Precedence matters and is deliberately
/// conservative — each rule can only ever move an entry to a LESS deletable
/// bucket than the one below it:
///   foreign      — outside the managed root; not ours to touch
///   live         — busy right now (streaming turn, or a run mid-flight)
///   has-work     — idle, but holds changes that would be destroyed
///   reclaimable  — idle, clean, and nothing unmerged. Safe.
/// Being idle alone never makes something reclaimable: a finished shift with
/// uncommitted work still lands in `has-work` so cleanup can't quietly
/// discard it.
///
/// `busy` replaced an older `referenced` rule that made any CLAIMED tree
/// untouchable. That rule was why a worker's forty finished shifts read as
/// forty live worktrees nothing was allowed to clear.
export function classifyWorktree(args: {
  worktreePath: string;
  busy: boolean;
  dirtyFiles: number;
  commitsAhead: number;
  isMergedIntoBase: boolean;
}): WorktreeSweepBucket {
  if (!isUnderManagedRoot(args.worktreePath)) return 'foreign';
  if (args.busy) return 'live';
  if (args.dirtyFiles > 0) return 'has-work';
  if (args.commitsAhead > 0 && !args.isMergedIntoBase) return 'has-work';
  return 'reclaimable';
}

/// Fold claims into one per worktree path, resolved so two spellings of the
/// same directory can't both claim it.
///
/// A run and a conversation can claim the SAME tree: "New chat here" on a run
/// pane attaches a fresh conversation to the run's worktree (`adoptedWorktree`).
/// The run owns it, so the run's claim wins and the borrowing conversations
/// ride along in `adoptedConvIds` — removing the tree has to take those rows
/// too, or they are left pointing at a directory that no longer exists.
///
/// `busy` is a union across everything claiming the tree: one live turn in a
/// borrowed chat is enough to make the whole tree untouchable.
export function indexClaims(claims: WorktreeClaim[]): Map<string, WorktreeClaim> {
  const out = new Map<string, WorktreeClaim>();
  for (const claim of claims) {
    const key = path.resolve(claim.worktreePath);
    const prior = out.get(key);
    if (!prior) {
      out.set(key, { ...claim });
      continue;
    }
    const [owner, other] =
      prior.kind === 'run' || claim.kind !== 'run' ? [prior, claim] : [claim, prior];
    const adopted = [
      ...(owner.adoptedConvIds ?? []),
      ...(other.adoptedConvIds ?? []),
      ...(other.convId && other.convId !== owner.convId ? [other.convId] : []),
    ];
    out.set(key, {
      ...owner,
      busy: !!owner.busy || !!other.busy,
      adoptedConvIds: adopted.length > 0 ? [...new Set(adopted)] : undefined,
    });
  }
  return out;
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

/// Facts that are the same for every worktree in a project, read once.
///
/// Three of the five probes per worktree never needed the worktree at all —
/// "is this branch merged into base", "how far ahead is it", "when was its
/// last commit" are all questions about REFS, answerable for every branch in
/// the repo in a single call each. Asking them per worktree meant ~4,500 git
/// processes on a 1,500-worktree install (measured: ~21s of pure subprocess
/// overhead) all contending on one repo's ref cache.
export interface ProjectRefFacts {
  /// Branches already merged into the base branch.
  merged: Set<string>;
  /// Branch → last commit time in ms.
  committedAt: Map<string, number>;
}

/// Strip `git branch`'s decoration: `* ` for the current branch, `+ ` for one
/// checked out in another worktree — which, here, is nearly all of them.
function bareBranchName(line: string): string {
  return line.replace(/^[*+]?\s+/, '').trim();
}

export async function readProjectRefFacts(
  projectPath: string,
  baseBranch: string,
): Promise<ProjectRefFacts> {
  const [merged, dated] = await Promise.all([
    runGitAsync(['branch', '--merged', baseBranch, '--format=%(refname:short)'], projectPath),
    runGitAsync(
      ['for-each-ref', '--format=%(refname:short)%09%(committerdate:unix)', 'refs/heads/'],
      projectPath,
    ),
  ]);
  const mergedSet = new Set<string>();
  if (merged.exitCode === 0) {
    for (const line of merged.stdout.split('\n')) {
      const name = bareBranchName(line);
      if (name) mergedSet.add(name);
    }
  }
  const committedAt = new Map<string, number>();
  if (dated.exitCode === 0) {
    for (const line of dated.stdout.split('\n')) {
      const [name, seconds] = line.split('\t');
      const at = Number.parseInt((seconds ?? '').trim(), 10);
      if (name && Number.isFinite(at)) committedAt.set(name.trim(), at * 1000);
    }
  }
  return { merged: mergedSet, committedAt };
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
  /// `du` walks the whole tree and dominates the scan — measured at ~91s of a
  /// ~2-minute run over 1,519 worktrees, because a worktree carrying
  /// node_modules can be gigabytes. Skipping it answers every safety question
  /// — clean, merged, dated — and only loses the size column.
  measureSizes: boolean;
  facts: ProjectRefFacts;
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
  // A branch with no name is a detached review worktree: nothing in the ref
  // tables can speak for it, so it keeps its own `git log`.
  const isMergedIntoBase = args.branchName ? args.facts.merged.has(args.branchName) : true;
  const datedFromRefs = args.branchName
    ? args.facts.committedAt.get(args.branchName)
    : undefined;

  const [status, ahead, sizeKb, lastCommit] = await Promise.all([
    runGitAsync(['status', '--porcelain'], args.worktreePath),
    // Only unmerged branches need counting: `classifyWorktree` reads
    // `commitsAhead` solely to catch work that is ahead AND unmerged, so a
    // merged branch's count changes no answer and is not worth a process.
    args.branchName && !isMergedIntoBase
      ? runGitAsync(['rev-list', '--count', `${args.baseBranch}..${args.branchName}`], args.projectPath)
      : Promise.resolve({ stdout: '0', stderr: '', exitCode: 0 }),
    args.measureSizes ? duKb(args.worktreePath) : Promise.resolve(0),
    // Dates an orphan. Its conversation is gone, so there's no `lastActiveAt`
    // to age it by — but the last commit in the tree is a good proxy for when
    // work stopped, and it makes the date filter meaningful on every row
    // rather than only the ones a conversation still claims.
    datedFromRefs === undefined
      ? runGitAsync(['log', '-1', '--format=%ct'], args.worktreePath)
      : Promise.resolve({ stdout: '', stderr: '', exitCode: 1 }),
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
    isMergedIntoBase,
    sizeKb,
    lastCommitAt:
      datedFromRefs ?? (Number.isFinite(commitSeconds) ? commitSeconds * 1000 : undefined),
  };
}

/// Scan every project for worktrees, classify each, and report totals.
/// `claims` is supplied by the caller: the renderer owns conversation state
/// and the flow runtime owns run state, so neither is re-derived from disk
/// here (reading a stale `overcli.json` could report a live tree as an
/// orphan, and offer to delete it).
///
/// Two passes, because the expensive work is worth avoiding. Pass one needs
/// nothing but `git worktree list` and the claim index, and that already
/// settles `foreign` and `live`. Everything else gets pass two (status,
/// merge-base, `du`), which costs seconds per worktree and dominates the
/// scan: measured over 867 worktrees, inspecting everything took ~4 minutes,
/// and `du` alone was 83s of it.
///
/// Pass two used to run only over UNCLAIMED trees. It now covers every idle
/// one, claimed or not, because a finished worker shift is exactly the thing
/// this scan exists to offer up — and offering it means standing behind
/// "clean and merged", which only inspection can say. Busy and foreign trees
/// still skip it and report `sizeKb: 0`; nothing can be done with them, so
/// their size would cost most of the budget to display a number the user
/// can't act on.
/// Above this many candidates, `auto` stops measuring disk usage.
///
/// `du` walks every file in every tree and is the single most expensive thing
/// the scan does — 83s of a 4-minute run over 867 worktrees, and it scales
/// with repo size, not worktree count. Under a few hundred trees the wait is
/// worth the size column; a 1,500-worktree install would spend minutes on a
/// number that changes no decision, so it reports counts instead and offers
/// the measurement as a deliberate second pass.
export const SIZE_MEASURE_LIMIT = 300;

export async function scanWorktrees(
  args: {
    projects: Array<{ path: string; name: string }>;
    claims: WorktreeClaim[];
    /// `'auto'` (the default) measures disk only when there are at most
    /// `SIZE_MEASURE_LIMIT` candidates. `true` always measures, `false`
    /// never does — same buckets either way, since size decides nothing.
    measureSizes?: boolean | 'auto';
  },
  onProgress?: (p: { completed: number; total: number }) => void,
): Promise<WorktreeSweepResult> {
  const claims = indexClaims(args.claims);

  const perProject = await pooled(
    args.projects.map((project) => async () => {
      const listed = await runGitAsync(
        ['worktree', 'list', '--porcelain'],
        project.path,
      );
      if (listed.exitCode !== 0) {
        // Not a git repo, or the project directory is gone. Not an error
        // worth failing the whole scan over.
        return {
          project,
          worktrees: [] as ParsedWorktree[],
          baseBranch: 'main',
          facts: { merged: new Set<string>(), committedAt: new Map<string, number>() },
        };
      }
      const all = parseWorktreeList(listed.stdout);
      // Drop the main checkout — it's the repo itself, never a candidate.
      const mainPath = path.resolve(project.path);
      const worktrees = all.filter((w) => path.resolve(w.worktreePath) !== mainPath);
      const baseBranch = await detectBaseBranchAsync(project.path);
      const facts = await readProjectRefFacts(project.path, baseBranch);
      return { project, worktrees, baseBranch, facts };
    }),
    6,
  );

  // Pass one: everything decidable from the path and the claim index.
  const staged = perProject.flatMap(({ project, worktrees, baseBranch, facts }) =>
    worktrees.map((wt) => {
      const claim = claims.get(path.resolve(wt.worktreePath));
      const base: WorktreeSweepEntry = {
        worktreePath: wt.worktreePath,
        projectPath: project.path,
        projectName: project.name,
        branchName: wt.branchName,
        baseBranch,
        referenced: claim ? claim.kind : null,
        claim,
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
          busy: !!claim?.busy,
          dirtyFiles: 0,
          commitsAhead: 0,
          isMergedIntoBase: true,
        }),
      };
      return { entry: base, project, baseBranch, wt, facts };
    }),
  );

  const candidates = staged.filter((s) => s.entry.bucket === 'reclaimable');
  const settled = staged.filter((s) => s.entry.bucket !== 'reclaimable').map((s) => s.entry);

  const sizePolicy = args.measureSizes ?? 'auto';
  const measureSizes =
    sizePolicy === 'auto' ? candidates.length <= SIZE_MEASURE_LIMIT : sizePolicy;

  // Pass two: the real inspection, only for entries that could be removed.
  let completed = 0;
  const total = candidates.length;
  onProgress?.({ completed: 0, total });
  const inspected = await pooled(
    candidates.map(({ entry, project, baseBranch, wt, facts }) => async () => {
      const detail = await inspect({
        worktreePath: wt.worktreePath,
        projectPath: project.path,
        branchName: wt.branchName,
        baseBranch,
        prunable: wt.prunable,
        measureSizes,
        facts,
      });
      completed++;
      onProgress?.({ completed, total });
      return {
        ...entry,
        ...detail,
        bucket: classifyWorktree({
          worktreePath: wt.worktreePath,
          busy: !!entry.claim?.busy,
          dirtyFiles: detail.dirtyFiles,
          commitsAhead: detail.commitsAhead,
          isMergedIntoBase: detail.isMergedIntoBase,
        }),
      };
    }),
    // Pass two is IO-bound (git plumbing and directory walks), so the old
    // limit of 6 left the disk idle waiting on process startup. Measured on a
    // 1,519-worktree install, `git status` throughput flattens out around 24
    // in flight (24s at 6, 16s at 12, 14s at 24, no better at 48), so this is
    // the knee of the curve rather than a guess.
    24,
  );

  const entries = [...settled, ...inspected];
  entries.sort(
    (a, b) =>
      a.projectName.localeCompare(b.projectName) ||
      a.worktreePath.localeCompare(b.worktreePath),
  );
  return { entries, scannedAt: Date.now(), measuredSizes: measureSizes };
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
