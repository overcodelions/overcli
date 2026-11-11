// Which pushed branch a worker's new run should build on, if any.
//
// A follow-up on a change the server already pushed (the same worker, place
// and ticket) starts on that change's branch, and its push adds to it
// (BranchLander's `continues`), so the open pull request gets the new
// commits instead of a second one opening beside it. Not once the branch is
// merged or gone: then it starts fresh.
//
// Only the server's own records name the branch: the CI watcher's marker for
// a fix it asked for, the branches earlier runs landed, and the watcher's
// record of what it watched. Prose never does: a branch or ticket a prompt
// merely mentions (a duplicate, the ticket it was cloned from, someone
// else's pull request) would push this run's work into that pull request.
//
// A worker may name one of its own, though: a `[continue-branch: …]` marker
// for a branch this worker's runs pushed in this place counts like the CI
// watcher's, so "add that fix to the PR you opened" lands on that PR and not
// on whichever of the ticket's branches was pushed last. And where a ticket
// has several, a pull request number the ask names picks among them.

import type { FlowRun } from '../../shared/flows/schema';
import type { CiWatch } from './ciWatch';
import { continueBranchOf } from './ciWatch';
import { LANDED_ARTIFACT, landedBranches } from './landBranches';
import type { ConnectedRepo } from './repos';
import { ticketKey, ticketOf } from './ticketFollowUp';

export interface ContinueBranchDeps {
  repos(): ConnectedRepo[];
  workspaces(): Array<{ rootPath: string; repos: string[] }>;
  runs(): FlowRun[];
  /// What the CI watcher has watched (ciWatch.ts).
  ciWatches(): CiWatch[];
  /// Whether the watcher asked this worker to fix that branch, lately.
  fixAskedOn(workerId: string, branch: string, repos?: string[]): boolean;
  /// Still there on origin, and not merged into the repo's default branch.
  open(repo: ConnectedRepo, branch: string): Promise<boolean>;
}

/// The branch to start on, or null to start fresh. In a workspace, each repo
/// starts on it where it has it, and from its default branch where not.
export async function continueBranchFor(
  args: { projectPath: string; workerId: string; title: string; prompt: string },
  deps: ContinueBranchDeps,
): Promise<string | null> {
  const all = deps.repos();
  const ws = deps.workspaces().find((w) => w.rootPath === args.projectPath);
  const repos = ws ? all.filter((r) => ws.repos.includes(r.name)) : all.filter((r) => r.path === args.projectPath);
  if (!repos.length) return null;
  const names = repos.map((r) => r.name);

  // A branch that's still open in one of this place's repos: the first, in
  // the order given, asked about all at once rather than one fetch at a time.
  const firstOpen = async (branches: string[]): Promise<string | null> => {
    const unique = [...new Set(branches)];
    const open = await Promise.all(unique.map(async (b) => (await Promise.all(repos.map((r) => deps.open(r, b)))).some(Boolean)));
    return unique.find((_, i) => open[i]) ?? null;
  };

  // What this worker's earlier runs pushed here, newest first. A workspace
  // run works in a folder of its own, and a repo run in a worktree of the
  // repo: either way `sourceProjectPath` is the place, and `projectPath`
  // only once the worktree is gone and the run re-pointed.
  const ownRuns = deps
    .runs()
    .filter(
      (r) =>
        r.workerId === args.workerId &&
        (ws ? !!r.workspaceWorktrees?.length : !r.workspaceWorktrees?.length) &&
        (r.sourceProjectPath ?? r.projectPath) === args.projectPath &&
        !!r.artifacts?.[LANDED_ARTIFACT],
    )
    .sort((a, b) => b.createdAt - a.createdAt);
  const pushedBy = (runs: FlowRun[]) => runs.flatMap((r) => landedPulls(r.artifacts![LANDED_ARTIFACT]!.body ?? ''));

  // A marker names its branch outright: a CI fix the watcher asked this
  // worker for, or a branch this worker pushed here itself.
  const marked = continueBranchOf(args.prompt);
  if (marked && (deps.fixAskedOn(args.workerId, marked, names) || pushedBy(ownRuns).some((p) => p.branch === marked))) return firstOpen([marked]);

  // Otherwise the ticket its title names, never one its ask only mentions.
  const ticket = ticketKey(args.title);
  if (!ticket) return null;

  // The branches earlier runs for that ticket landed, newest first; one
  // whose pull request the ask names ("onto PR 26439") ahead of the rest.
  const landed = pushedBy(ownRuns.filter((r) => ticketOf(r) === ticket));
  const asked = `${args.title}\n${args.prompt}`;
  const named = landed.filter((p) => p.pr && new RegExp(`(?:#|\\bPR\\s*#?|pull request\\s*#?)${p.pr}\\b`, 'i').test(asked));
  const fromRuns = await firstOpen([...named, ...landed].map((p) => p.branch));
  if (fromRuns) return fromRuns;

  // Runs are pruned after a while, and the watcher keeps what it watched:
  // the branches it saw pushed for that ticket, in these repos.
  const watched = deps
    .ciWatches()
    .filter((w) => w.workerId === args.workerId && names.includes(w.repo) && ticketKey(w.title) === ticket)
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((w) => w.branch);
  return firstOpen(watched);
}

/// Each branch a run's landed artifact names, with its pull request's number
/// where the line links one.
function landedPulls(text: string): Array<{ branch: string; pr?: string }> {
  return text.split('\n').flatMap((line) => {
    const [branch] = landedBranches(line);
    if (!branch) return [];
    const pr = /\/(?:pull-requests|pull|merge_requests)\/(\d+)/.exec(line)?.[1];
    return [pr ? { branch, pr } : { branch }];
  });
}
