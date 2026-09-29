// Where a branch stands in git, for the Work view.
//
// The PR lookup only answers for GitHub repos, and only for work that went
// through a PR — so most records had no status at all, and "merged" showed up
// once. Git itself knows a lot more, on any remote: whether the branch still
// exists here or on origin, how far it is ahead of (and behind) the trunk,
// what hasn't been pushed, and whether everything on it is already in the
// trunk. Cheap local reads; nothing is fetched.

import { runGitAsync } from '../git';
import type { BranchStatus } from '../../shared/workRecords';

const TTL_MS = 2 * 60_000;
const cache = new Map<string, { at: number; status: BranchStatus }>();
const trunkCache = new Map<string, { at: number; trunk: string | null }>();
const lineCache = new Map<string, { at: number; shas: Set<string> }>();

/// The trunk's own line — its first-parent history. A branch cut and never
/// committed to has its tip on this line; a merged branch's tip sits on a
/// side of a merge instead.
async function trunkLine(repo: string, trunk: string): Promise<Set<string>> {
  const key = `${repo}::${trunk}`;
  const hit = lineCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.shas;
  const res = await runGitAsync(['rev-list', '--first-parent', '--max-count=5000', trunk], repo);
  const shas = new Set(res.exitCode === 0 ? res.stdout.split('\n').filter(Boolean) : []);
  lineCache.set(key, { at: Date.now(), shas });
  return shas;
}

/// Changed files in a worktree, or undefined when it isn't on disk.
async function uncommittedIn(worktreePath: string | undefined): Promise<number | undefined> {
  if (!worktreePath) return undefined;
  const res = await runGitAsync(['status', '--porcelain'], worktreePath);
  if (res.exitCode !== 0) return undefined;
  return res.stdout.split('\n').filter((l) => l.trim()).length;
}

/// The branch work lands in: origin's default, else a local main/master.
async function trunkOf(repo: string): Promise<string | null> {
  const hit = trunkCache.get(repo);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.trunk;
  let trunk: string | null = null;
  const head = await runGitAsync(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repo);
  if (head.exitCode === 0 && head.stdout.trim()) trunk = head.stdout.trim();
  else {
    for (const name of ['origin/main', 'origin/master', 'main', 'master']) {
      if ((await runGitAsync(['rev-parse', '--verify', '--quiet', name], repo)).exitCode === 0) {
        trunk = name;
        break;
      }
    }
  }
  trunkCache.set(repo, { at: Date.now(), trunk });
  return trunk;
}

async function verify(repo: string, ref: string): Promise<boolean> {
  return (await runGitAsync(['rev-parse', '--verify', '--quiet', ref], repo)).exitCode === 0;
}

async function count(repo: string, range: string): Promise<number> {
  const res = await runGitAsync(['rev-list', '--count', range], repo);
  return res.exitCode === 0 ? Number(res.stdout.trim()) || 0 : 0;
}

export async function branchStatus(repo: string, branch: string, worktreePath?: string): Promise<BranchStatus> {
  const key = `${repo}::${branch}::${worktreePath ?? ''}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.status;

  const trunk = await trunkOf(repo);
  const [local, remote] = await Promise.all([
    verify(repo, `refs/heads/${branch}`),
    verify(repo, `refs/remotes/origin/${branch}`),
  ]);
  let status: BranchStatus = { local, remote, ahead: 0, behind: 0, unpushed: 0, inTrunk: false };
  if (local && !remote) {
    const upstream = await runGitAsync(['for-each-ref', '--format=%(upstream)', `refs/heads/${branch}`], repo);
    if (upstream.exitCode === 0 && upstream.stdout.trim()) status.remoteGone = true;
  }
  if (trunk) status.trunk = trunk.replace(/^origin\//, '');
  const ref = local ? `refs/heads/${branch}` : remote ? `refs/remotes/origin/${branch}` : null;
  if (ref) {
    const [ahead, behind, unpushed, inTrunk, last] = await Promise.all([
      trunk ? count(repo, `${trunk}..${ref}`) : Promise.resolve(0),
      trunk ? count(repo, `${ref}..${trunk}`) : Promise.resolve(0),
      local && remote ? count(repo, `refs/remotes/origin/${branch}..refs/heads/${branch}`) : Promise.resolve(0),
      trunk ? runGitAsync(['merge-base', '--is-ancestor', ref, trunk], repo).then((r) => r.exitCode === 0) : Promise.resolve(false),
      runGitAsync(['log', '-1', '--format=%ct%x00%s', ref], repo),
    ]);
    status = { ...status, ahead, behind, unpushed, inTrunk };
    if (inTrunk && trunk) {
      const tip = await runGitAsync(['rev-parse', ref], repo);
      if (tip.exitCode === 0) status.cutOnly = (await trunkLine(repo, trunk)).has(tip.stdout.trim());
    }
    if (last.exitCode === 0) {
      const [ts, subject] = last.stdout.trim().split('\0');
      if (ts) status.lastCommitAt = Number(ts) * 1000;
      if (subject) status.lastSubject = subject;
    }
  }
  const uncommitted = await uncommittedIn(worktreePath);
  if (uncommitted !== undefined) status.uncommitted = uncommitted;
  cache.set(key, { at: Date.now(), status });
  return status;
}

/// Statuses for many repo/branch pairs, a few repos at a time.
export async function branchStatuses(
  items: Array<{ repo: string; branch: string; worktreePath?: string }>,
): Promise<Record<string, BranchStatus>> {
  const out: Record<string, BranchStatus> = {};
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const { repo, branch, worktreePath } = items[next++];
      try {
        out[`${repo}::${branch}`] = await branchStatus(repo, branch, worktreePath);
      } catch {
        // Not a repo, or git missing — the record just goes without it.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, items.length) }, worker));
  return out;
}
