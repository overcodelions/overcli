// Worker output that landed a commit but never reached its base branch.
//
// A standing worker's shift ends by committing and, usually, parking the
// commit on a `prometheus/<date>-<slug>`-style branch for a human to merge.
// Nothing downstream ever checks whether that happened. The orchestration
// item keeps `headSha` (see `OrchestrationItem.headSha`) precisely so the work
// stays reachable after its run, worktree and scratch branch are gone — this
// module is what finally asks the question that pointer exists to answer:
// "is this commit in base yet?"
//
// "Not an ancestor of base" is not the end of the answer, though. A squash
// merge, a cherry-pick, or a re-landing with edits all put the work in base
// without making the commit an ancestor, and an ancestry-only audit flags all
// of them. So every non-ancestor is triaged with an in-memory merge
// (`git merge-tree --write-tree`, git >= 2.38), which writes loose objects
// only and never moves a ref:
//   - absorbed:  merging it changes nothing — its content is already in base.
//   - clean:     it still merges without conflicts. Land it.
//   - conflicts: base has moved on underneath it. Rebuild rather than merge.
//
// Read-only with respect to the repository. Pure with respect to the store:
// the caller loads orchestrations and hands them in.

import { detectBaseBranchAsync, runGitAsync, type GitResult } from '../git';
import type { Orchestration, OrchestrationItem } from '../../shared/flows/orchestration';

export type Landability = 'clean' | 'conflicts' | 'unknown';

export interface StrandedLanding {
  workerName: string;
  batchTitle: string;
  itemTitle: string;
  headSha: string;
  branchName?: string;
  finishedAt?: number;
  projectPath: string;
  /// The branch the commit was checked against. Recorded because it is
  /// resolved per item and a reader should not have to guess.
  baseBranch: string;
  landability: Landability;
  /// Commits base has gained since this work forked from it. A rough
  /// staleness measure; null when the merge-base could not be computed.
  baseAdvance: number | null;
  /// Whether `branchName` still names a local branch. The branch is display
  /// only (it is routinely deleted or renamed); the SHA is the real pointer.
  branchResolves: boolean;
}

export interface UnresolvableLanding {
  workerName: string;
  batchTitle: string;
  itemTitle: string;
  headSha: string;
  projectPath: string;
  baseBranch: string;
  /// First line of git's complaint — usually a pruned object or a missing
  /// project directory.
  reason: string;
}

export interface LandingRef {
  workerName: string;
  itemTitle: string;
  headSha: string;
  projectPath: string;
  baseBranch: string;
}

export interface LandingAudit {
  stranded: StrandedLanding[];
  /// Not ancestors, but their content is already in base (squash merge,
  /// cherry-pick, re-landed). Not a problem; reported so the count adds up.
  absorbed: LandingRef[];
  merged: LandingRef[];
  unresolvable: UnresolvableLanding[];
  /// Done worker items with no `headSha` — finished before the field existed,
  /// or the capture failed. The audit is blind to these, and says so.
  skippedNoSha: number;
}

export interface AuditDeps {
  git?: (args: string[], cwd: string) => Promise<GitResult>;
  detectBase?: (projectPath: string) => Promise<string>;
}

function firstLine(s: string): string {
  return s.trim().split('\n')[0] ?? '';
}

export async function auditWorkerLandings(
  orchestrations: Orchestration[],
  deps: AuditDeps = {},
): Promise<LandingAudit> {
  const git = deps.git ?? ((args: string[], cwd: string) => runGitAsync(args, cwd));
  const detectBase = deps.detectBase ?? detectBaseBranchAsync;

  const out: LandingAudit = { stranded: [], absorbed: [], merged: [], unresolvable: [], skippedNoSha: 0 };
  // detectBaseBranch costs up to four git calls; one project usually holds
  // many batches.
  const detected = new Map<string, Promise<string>>();
  const baseTree = new Map<string, Promise<string | null>>();

  const resolveBase = (o: Orchestration, item: OrchestrationItem): Promise<string> => {
    // The item's own base wins: it is what the work actually forked from.
    // detectBaseBranch prefers whatever is checked out right now, which is
    // only a guess about a shift that ran days ago.
    const explicit = item.baseBranch?.trim() || o.baseBranch?.trim();
    if (explicit) return Promise.resolve(explicit);
    let p = detected.get(o.projectPath);
    if (!p) {
      p = detectBase(o.projectPath);
      detected.set(o.projectPath, p);
    }
    return p;
  };

  const treeOf = (projectPath: string, base: string): Promise<string | null> => {
    const key = `${projectPath}\0${base}`;
    let p = baseTree.get(key);
    if (!p) {
      p = git(['rev-parse', '--verify', `${base}^{tree}`], projectPath).then((r) =>
        r.exitCode === 0 ? r.stdout.trim() : null,
      );
      baseTree.set(key, p);
    }
    return p;
  };

  for (const o of orchestrations) {
    if (o.origin?.kind !== 'worker') continue;
    const workerName = o.origin.workerName;
    for (const item of o.items) {
      if (item.status !== 'done') continue;
      const headSha = item.headSha?.trim();
      if (!headSha) {
        out.skippedNoSha += 1;
        continue;
      }
      const baseBranch = await resolveBase(o, item);
      const ref: LandingRef = {
        workerName,
        itemTitle: item.candidate.title,
        headSha,
        projectPath: o.projectPath,
        baseBranch,
      };

      const anc = await git(['merge-base', '--is-ancestor', headSha, baseBranch], o.projectPath);
      if (anc.exitCode === 0) {
        out.merged.push(ref);
        continue;
      }
      if (anc.exitCode !== 1) {
        out.unresolvable.push({
          ...ref,
          batchTitle: o.title,
          reason: firstLine(anc.stderr) || `git exited ${anc.exitCode}`,
        });
        continue;
      }

      const merged = await git(['merge-tree', '--write-tree', baseBranch, headSha], o.projectPath);
      let landability: Landability = 'unknown';
      if (merged.exitCode === 0) {
        const tree = await treeOf(o.projectPath, baseBranch);
        if (tree && firstLine(merged.stdout) === tree) {
          out.absorbed.push(ref);
          continue;
        }
        landability = 'clean';
      } else if (merged.exitCode === 1) {
        landability = 'conflicts';
      }

      let baseAdvance: number | null = null;
      const mb = await git(['merge-base', baseBranch, headSha], o.projectPath);
      if (mb.exitCode === 0 && mb.stdout.trim()) {
        const count = await git(['rev-list', '--count', `${mb.stdout.trim()}..${baseBranch}`], o.projectPath);
        const n = Number.parseInt(count.stdout.trim(), 10);
        if (count.exitCode === 0 && Number.isFinite(n)) baseAdvance = n;
      }

      let branchResolves = false;
      if (item.branchName) {
        const b = await git(
          ['rev-parse', '--verify', '--quiet', `refs/heads/${item.branchName}`],
          o.projectPath,
        );
        branchResolves = b.exitCode === 0;
      }

      out.stranded.push({
        workerName,
        batchTitle: o.title,
        itemTitle: item.candidate.title,
        headSha,
        branchName: item.branchName,
        finishedAt: item.finishedAt,
        projectPath: o.projectPath,
        baseBranch,
        landability,
        baseAdvance,
        branchResolves,
      });
    }
  }
  return out;
}
