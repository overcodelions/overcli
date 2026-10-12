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

/// Answers keyed on (branch tip, trunk tip): the same pair always gives the
/// same answer, and each check writes one dangling commit object, so it's
/// worth never asking twice.
const squashCache = new Map<string, boolean>();
const SQUASH_CACHE_MAX = 500;

// commit-tree needs an identity; the object is never referenced, so any will do.
const SQUASH_ENV = {
  GIT_AUTHOR_NAME: 'overcli',
  GIT_AUTHOR_EMAIL: 'overcli@localhost',
  GIT_COMMITTER_NAME: 'overcli',
  GIT_COMMITTER_EMAIL: 'overcli@localhost',
};

/// Squash- (or rebase-) merged: git records no link from the trunk back to the
/// branch, so its commits read as "ahead" forever. Squash the whole branch
/// onto its fork point as one unreferenced commit and ask `git cherry` whether
/// the trunk already has a commit with the same patch. Misses a squash whose
/// content was changed while merging (conflicts resolved, edits in the host's
/// merge UI) — that one keeps reading as ahead.
async function squashMergedInto(repo: string, ref: string, trunk: string): Promise<boolean> {
  const tips = await runGitAsync(['rev-parse', ref, trunk], repo);
  if (tips.exitCode !== 0) return false;
  const key = `${repo}::${tips.stdout.trim().split('\n').join('::')}`;
  const hit = squashCache.get(key);
  if (hit !== undefined) return hit;
  let merged = false;
  const base = await runGitAsync(['merge-base', trunk, ref], repo);
  if (base.exitCode === 0 && base.stdout.trim()) {
    const squash = await runGitAsync(
      ['commit-tree', `${ref}^{tree}`, '-p', base.stdout.trim(), '-m', 'squash check'],
      repo,
      SQUASH_ENV,
    );
    if (squash.exitCode === 0 && squash.stdout.trim()) {
      const cherry = await runGitAsync(['cherry', trunk, squash.stdout.trim()], repo);
      merged = cherry.exitCode === 0 && cherry.stdout.trim().startsWith('-');
    }
  }
  squashCache.set(key, merged);
  if (squashCache.size > SQUASH_CACHE_MAX) {
    const oldest = squashCache.keys().next().value;
    if (oldest !== undefined) squashCache.delete(oldest);
  }
  return merged;
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
    if (!inTrunk && ahead > 0 && trunk && (await squashMergedInto(repo, ref, trunk))) {
      // Landed as a squash: read it as merged — in the trunk, nothing ahead.
      status = { ...status, ahead: 0, inTrunk: true, cutOnly: false, squashMerged: true };
    }
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

/// The most branches one call reads in full. The Work view asks for every
/// branch it has ever recorded — times every member of a workspace — and the
/// first load would otherwise run a dozen git commands for each. The list
/// arrives newest first, so the cap keeps the records you are likely to look
/// at; older ones go without a status, as if git had nothing to say.
export const BRANCH_STATUS_MAX = 150;

/// How many git reads run at once.
const CONCURRENCY = 6;

/// Every local and origin branch name in a repo, in one read — or null when
/// git cannot say (not a repo), and the full per-branch check decides.
async function refNames(repo: string): Promise<{ local: Set<string>; remote: Set<string> } | null> {
  const res = await runGitAsync(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin'], repo);
  if (res.exitCode !== 0) return null;
  const local = new Set<string>();
  const remote = new Set<string>();
  for (const ref of res.stdout.split('\n')) {
    if (ref.startsWith('refs/heads/')) local.add(ref.slice('refs/heads/'.length));
    else if (ref.startsWith('refs/remotes/origin/')) remote.add(ref.slice('refs/remotes/origin/'.length));
  }
  return { local, remote };
}

/// Run `fn` over `items`, at most `limit` at a time.
async function eachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/// Statuses for many repo/branch pairs, a few at a time.
///
/// Most historical branches are long deleted, so one `for-each-ref` per repo
/// sorts those out first: a branch that exists nowhere gets its answer
/// without a git call of its own, and does not count toward the cap.
export async function branchStatuses(
  items: Array<{ repo: string; branch: string; worktreePath?: string }>,
  max = BRANCH_STATUS_MAX,
): Promise<Record<string, BranchStatus>> {
  const out: Record<string, BranchStatus> = {};
  const refsByRepo = new Map<string, { local: Set<string>; remote: Set<string> } | null>();
  await eachLimited([...new Set(items.map((i) => i.repo))], CONCURRENCY, async (repo) => {
    refsByRepo.set(repo, await refNames(repo));
  });

  const live: typeof items = [];
  const gone: typeof items = [];
  for (const item of items) {
    const refs = refsByRepo.get(item.repo);
    // A worktree on disk still has uncommitted files worth counting.
    const exists = !refs || item.worktreePath || refs.local.has(item.branch) || refs.remote.has(item.branch);
    (exists ? live : gone).push(item);
  }

  await eachLimited(gone, CONCURRENCY, async ({ repo, branch }) => {
    try {
      const trunk = await trunkOf(repo);
      const status: BranchStatus = { local: false, remote: false, ahead: 0, behind: 0, unpushed: 0, inTrunk: false };
      if (trunk) status.trunk = trunk.replace(/^origin\//, '');
      out[`${repo}::${branch}`] = status;
    } catch {
      // Not a repo, or git missing — the record just goes without it.
    }
  });
  await eachLimited(live.slice(0, max), CONCURRENCY, async ({ repo, branch, worktreePath }) => {
    try {
      out[`${repo}::${branch}`] = await branchStatus(repo, branch, worktreePath);
    } catch {
      // Not a repo, or git missing — the record just goes without it.
    }
  });
  return out;
}
