// Branches named for a ticket, across a place's repos.
//
// Ticket work rarely has one branch the app knows about: a workspace run cuts
// one per member repo, a chat may have made one by hand, and an evicted run
// took its record of them with it. But teams name branches for the ticket
// (`feature/ABC-123-…`), so the repos themselves still say where the work
// went. One `for-each-ref` per repo — local and origin — no fetch.

import { runGitAsync } from '../git';
import type { RepoBranch } from '../../shared/workRecords';

const TTL_MS = 2 * 60_000;
const refCache = new Map<string, { at: number; branches: string[] }>();

async function branchesOf(repo: string): Promise<string[]> {
  const hit = refCache.get(repo);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.branches;
  const res = await runGitAsync(
    ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin'],
    repo,
  );
  const names = new Set<string>();
  if (res.exitCode === 0) {
    for (const ref of res.stdout.split('\n')) {
      const name = ref.startsWith('refs/heads/')
        ? ref.slice('refs/heads/'.length)
        : ref.startsWith('refs/remotes/origin/')
          ? ref.slice('refs/remotes/origin/'.length)
          : '';
      if (name && name !== 'HEAD') names.add(name);
    }
  }
  const branches = [...names];
  refCache.set(repo, { at: Date.now(), branches });
  return branches;
}

/// Does `branch` name `key` as a whole token? `ABC-12` matches
/// `feature/abc-12-fix` and `ABC-12`, not `ABC-123`.
export function branchNamesTicket(branch: string, key: string): boolean {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9])${esc}(?![0-9])`, 'i').test(branch);
}

export async function ticketBranches(repos: string[], keys: string[]): Promise<Record<string, RepoBranch[]>> {
  const out: Record<string, RepoBranch[]> = {};
  const wanted = [...new Set(keys.map((k) => k.toUpperCase()))].filter((k) => /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/.test(k));
  if (!wanted.length) return out;
  const unique = [...new Set(repos)];
  let next = 0;
  const worker = async () => {
    while (next < unique.length) {
      const repo = unique[next++];
      let branches: string[] = [];
      try {
        branches = await branchesOf(repo);
      } catch {
        continue;
      }
      for (const key of wanted) {
        for (const branch of branches) {
          if (branchNamesTicket(branch, key)) (out[key] ??= []).push({ repo, branch });
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, unique.length) }, worker));
  return out;
}
