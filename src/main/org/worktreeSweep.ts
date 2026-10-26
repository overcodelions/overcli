// Finished runs' checkouts, removed once nothing in them can be lost. Every
// run in a workspace checks out each of its repos, and only deleting the run
// ever removed them: two days of a busy server came to 720 checkouts and
// 18 GB. A checkout goes when its run has ended and it holds nothing that
// isn't somewhere else: no changes at all, or changes already pushed. One
// with unpushed work is kept, however old.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import os from 'node:os';
import { flowRunTitle, type FlowRun } from '../../shared/flows/schema';

/// A run that changed nothing: its checkouts go soon after it ends.
export const EMPTY_AFTER_MS = 10 * 60_000;
/// One whose changes were pushed: kept a while for "see its changes".
export const PUSHED_AFTER_MS = 2 * 60 * 60_000;

function git(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0, out: String(stdout ?? '') });
    });
  });
}

/// When a run last did anything: its last step's end.
export function endedAt(run: FlowRun): number {
  return (run.attempts ?? []).reduce((m, a) => Math.max(m, a.endedAt ?? a.startedAt ?? 0), run.createdAt ?? 0);
}

export interface Checkout {
  repoPath: string;
  worktreePath: string;
  branchName: string;
  baseline?: string;
}

export function checkoutsOf(run: FlowRun): Checkout[] {
  if (run.workspaceWorktrees?.length) {
    return run.workspaceWorktrees.map((m) => ({
      repoPath: m.projectPath,
      worktreePath: m.worktreePath,
      branchName: m.branchName,
      ...(run.baselineCommitsByMember?.[m.name]?.commit ? { baseline: run.baselineCommitsByMember[m.name].commit } : {}),
    }));
  }
  if (run.worktreePath && run.worktreePath !== run.projectPath) {
    return [{ repoPath: run.sourceProjectPath ?? run.projectPath, worktreePath: run.worktreePath, branchName: run.branchName ?? '', ...(run.baselineCommit ? { baseline: run.baselineCommit } : {}) }];
  }
  return [];
}

/// What a checkout holds: nothing beyond where it started, work that is on a
/// remote branch, or work only here.
export async function checkoutState(c: Checkout): Promise<'empty' | 'pushed' | 'unpushed'> {
  const status = await git(c.worktreePath, ['status', '--porcelain']);
  if (status.code !== 0 || status.out.trim()) return 'unpushed';
  if (c.baseline) {
    const ahead = await git(c.worktreePath, ['rev-list', '--count', `${c.baseline}..HEAD`]);
    if (ahead.code === 0 && ahead.out.trim() === '0') return 'empty';
  }
  const remote = await git(c.worktreePath, ['branch', '-r', '--contains', 'HEAD']);
  return remote.code === 0 && remote.out.trim() ? 'pushed' : 'unpushed';
}

async function remove(c: Checkout): Promise<boolean> {
  const res = await git(c.repoPath, ['worktree', 'remove', '--force', c.worktreePath]);
  if (res.code !== 0) return false;
  // Its branch was empty or is on the remote: the local copy can go too.
  if (c.branchName) await git(c.repoPath, ['branch', '-D', c.branchName]);
  return true;
}

/// A run's title for people, however little the run carries.
function titleOf(run: FlowRun): string {
  try {
    return flowRunTitle(run) || run.id;
  } catch {
    return run.orchestrationItemTitle ?? run.id;
  }
}

let sweeping = false;
/// What the last pass kept because only it had the work.
let keptLast: Array<{ runId: string; title: string; worker?: string; workerId?: string; since: number }> = [];
/// Unpushed work older than this is worth someone's look.
export const STALE_UNPUSHED_MS = 3 * 86_400_000;

/// One pass over the runs. Ended runs only; a paused or running one is
/// using its checkouts.
export async function sweepWorktrees(runs: FlowRun[], log: (level: 'info' | 'warn', msg: string) => void, now = Date.now()): Promise<{ removed: number; kept: number }> {
  if (sweeping) return { removed: 0, kept: 0 };
  sweeping = true;
  let removed = 0;
  let kept = 0;
  const keptRuns: typeof keptLast = [];
  try {
    for (const run of runs) {
      if (run.state.kind !== 'done' && run.state.kind !== 'aborted') continue;
      const age = now - endedAt(run);
      if (age < EMPTY_AFTER_MS) continue;
      for (const c of checkoutsOf(run)) {
        if (!fs.existsSync(c.worktreePath) || !fs.existsSync(path.join(c.repoPath, '.git'))) continue;
        const state = await checkoutState(c);
        const due = state === 'empty' || (state === 'pushed' && age >= PUSHED_AFTER_MS);
        if (!due) {
          if (state === 'unpushed') {
            kept++;
            const title = titleOf(run);
            if (!keptRuns.some((k) => k.title === title && k.since === endedAt(run))) keptRuns.push({ runId: run.id, title, ...(run.workerName ? { worker: run.workerName } : {}), ...(run.workerId ? { workerId: run.workerId } : {}), since: endedAt(run) });
          }
          continue;
        }
        if (await remove(c)) removed++;
      }
    }
    keptLast = keptRuns;
    if (removed) log('info', `Removed ${removed} finished run checkout${removed === 1 ? '' : 's'}${kept ? `; kept ${kept} with unpushed work` : ''}.`);
  } catch (err) {
    log('warn', `Checkout cleanup stopped: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    sweeping = false;
  }
  return { removed, kept };
}

/// For Setup → Readiness: how many checkouts are on disk, and any kept for
/// unpushed work, flagged once it's been sitting a while.
export function checkoutHealth(now = Date.now(), root = path.join(os.homedir(), '.overcli', 'worktrees')): { name: string; ok: boolean; detail: string } {
  let count = 0;
  try {
    for (const repo of fs.readdirSync(root)) {
      try {
        count += fs.readdirSync(path.join(root, repo)).length;
      } catch {
        // not a folder
      }
    }
  } catch {
    // none yet
  }
  const stale = keptLast.filter((k) => now - k.since > STALE_UNPUSHED_MS).sort((a, b) => a.since - b.since);
  const days = (ms: number) => Math.max(1, Math.round(ms / 86_400_000));
  const base = `${count} run checkout${count === 1 ? '' : 's'} on disk. A finished run's are removed once nothing in them can be lost.`;
  if (stale.length) {
    const o = stale[0];
    return { name: 'Run checkouts', ok: false, detail: `${base} ${stale.length} kept with work that was never pushed, the oldest ${days(now - o.since)} days: ${o.worker ? `${o.worker}'s ` : ''}"${o.title}". Push it or delete the run.` };
  }
  return { name: 'Run checkouts', ok: true, detail: keptLast.length ? `${base} ${keptLast.length} kept with work not pushed yet.` : base };
}

/// The checkouts kept last pass for work never pushed, oldest first.
export function keptCheckouts(): Array<{ runId: string; title: string; worker?: string; workerId?: string; since: number }> {
  return [...keptLast].sort((a, b) => a.since - b.since);
}

/// Remove a run's checkouts whatever they hold: an admin chose to lose it.
export async function discardCheckouts(run: FlowRun): Promise<number> {
  let n = 0;
  for (const c of checkoutsOf(run)) {
    if (!fs.existsSync(c.worktreePath)) continue;
    if (await remove(c)) n++;
  }
  keptLast = keptLast.filter((k) => k.runId !== run.id);
  return n;
}

/// How big a folder is, in bytes (`du`), or null when it can't be told.
export function folderBytes(dir: string): Promise<number | null> {
  return new Promise((resolve) => {
    if (!fs.existsSync(dir)) return resolve(0);
    execFile('du', ['-sk', dir], { timeout: 120_000 }, (err, stdout) => {
      const kb = Number(String(stdout ?? '').split(/\s+/)[0]);
      resolve(err || !Number.isFinite(kb) ? null : kb * 1024);
    });
  });
}

/// The volume a folder is on: free and total bytes.
export function volumeOf(dir: string): { freeBytes: number; totalBytes: number } | null {
  try {
    const s = fs.statfsSync(dir);
    return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  } catch {
    return null;
  }
}
