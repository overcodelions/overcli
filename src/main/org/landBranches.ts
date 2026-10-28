// Pushing a repo or workspace run's change, done by the server rather than
// the model.
//
// A worker's flow on a connected repo ends with a step that writes the pull
// request (a title and a description). That step is external, so it waits for
// the manager's yes. When the run then finishes, this commits each worktree
// that changed and pushes it to `overcli/<change>`; the repo's test
// command runs first, without secrets, and a failing run is not pushed. The links to open
// each pull request are attached to the run, where Slack, the Library and the
// worker's page find them.
//
// The model never runs git. It used to, on narrowed grants
// (`Bash(git push:*)`), and wrote its shell its own way — loops, `;`,
// absolute paths — so pushes were refused at random. This is one command per
// repo, the same every time.

import path from 'node:path';
import type { FlowRun } from '../../shared/flows/schema';
import { newPullRequestLink, type ConnectedRepo } from './repos';

export { testUserRefusal } from './repos';

/// The artifact the server attaches: one line per repo.
export const LANDED_ARTIFACT = 'pull-requests.md';
/// The flow step whose output is the pull request's title and description.
export const PR_STEP_OUTPUT = 'pull-request.md';

export interface LandDeps {
  git(args: string[], cwd: string): Promise<{ ok: true; stdout: string } | { ok: false; error: string }>;
  repos(): ConnectedRepo[];
  /// Runs the repo's test command in the checkout, with no server secrets in its environment.
  /// `refused`: the server would not run them at all (see testUserRefusal), so `error` says why.
  test?(command: string, cwd: string): Promise<{ ok: true } | { ok: false; error: string; refused?: true }>;
  attach(runId: string, name: string, body: string): void;
  log(message: string): void;
  /// What every pushed branch starts with (the console's setting). Absent: `overcli/`.
  branchPrefix?(): string;
  /// Open (or find) the pull request for a pushed branch. Null: links only.
  openPr?(repo: ConnectedRepo, branch: string, title: string, body: string): Promise<{ url: string; draft: boolean } | { error: string } | null>;
  /// After a run's branches are pushed: the ticket follow-up hangs off this.
  onLanded?(run: FlowRun, landed: Landed[]): void;
}

export interface Landed {
  repo: string;
  branch?: string;
  url?: string;
  /// Why nothing was pushed: no changes, the tests failed, or tests are turned off here.
  skipped?: string;
  /// Pushed onto a branch an earlier run pushed, so its pull request has it.
  updated?: true;
  /// The server opened the pull request (or found it open): `url` is it.
  pr?: 'draft' | 'open';
  /// Why the pull request couldn't be opened; the link to open one stands.
  prError?: string;
  error?: string;
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'change';
}

/// The title (first line) and description (the rest) a run's last step wrote.
export function pullRequestText(run: Pick<FlowRun, 'artifacts' | 'userPrompt'>): { title: string; body: string } {
  const written = run.artifacts?.[PR_STEP_OUTPUT]?.body?.trim() ?? '';
  const lines = written.split('\n');
  const first = lines.findIndex((l) => l.trim());
  const title = (first >= 0 ? lines[first] : run.userPrompt.split('\n')[0] ?? 'A change')
    .replace(/^#+\s*/, '')
    .replace(/^title:\s*/i, '')
    .trim()
    .slice(0, 120) || 'A change';
  const body = first >= 0 ? lines.slice(first + 1).join('\n').trim() : '';
  return { title, body };
}

export class BranchLander {
  private busy = new Set<string>();

  constructor(private readonly deps: LandDeps) {}

  /// Fed every run update; acts once on a finished repo or workspace run:
  /// a repo's own flow, or any worker flow that ran in a connected repo's
  /// worktree (a "solve a ticket" flow brought from a desktop). Its model's
  /// shell holds no git credentials on a server, so its own push fails; the
  /// server pushes the same way for both.
  onRun(run: FlowRun): void {
    if (!run.flowId.startsWith('org-pr-') && !this.inConnectedRepo(run)) return;
    if (run.state.kind !== 'done' || !run.state.success) return;
    if (run.artifacts?.[LANDED_ARTIFACT] || this.busy.has(run.id)) return;
    this.busy.add(run.id);
    void this.land(run)
      .catch((err: unknown) => this.deps.log(`Could not push run ${run.id}: ${String(err)}`))
      .finally(() => this.busy.delete(run.id));
  }

  private inConnectedRepo(run: FlowRun): boolean {
    // A team member's piece works on the task's shared branch, which lands as
    // one change when the task does, not one branch per piece.
    if (!run.workerId || run.team) return false;
    const repos = new Set(this.deps.repos().map((r) => r.path));
    const places = run.workspaceWorktrees?.length ? run.workspaceWorktrees.map((m) => m.projectPath) : run.worktreePath ? [run.projectPath] : [];
    return places.some((p) => repos.has(p));
  }

  async land(run: FlowRun): Promise<Landed[]> {
    const places = run.workspaceWorktrees?.length
      ? run.workspaceWorktrees.map((m) => ({ name: m.name, projectPath: m.projectPath, worktreePath: m.worktreePath }))
      : run.worktreePath
        ? [{ name: path.basename(run.projectPath), projectPath: run.projectPath, worktreePath: run.worktreePath }]
        : [];
    const { title, body } = pullRequestText(run);
    const branch = `${this.deps.branchPrefix?.() || 'overcli/'}${slugify(title)}-${run.id.slice(0, 6)}`;
    const out: Landed[] = [];
    for (const place of places) {
      const repo = this.deps.repos().find((r) => r.path === place.projectPath);
      // One repo going wrong must not cost the others their links.
      out.push(
        await this.landOne(place, repo, branch, title, body)
          .then((l) => this.withPr(l, repo, title, body))
          .catch((err: unknown) => ({ repo: place.name, error: err instanceof Error ? err.message : String(err) })),
      );
    }
    this.deps.attach(run.id, LANDED_ARTIFACT, describe(out));
    if (out.some((l) => l.url || (l.branch && !l.error))) this.deps.onLanded?.(run, out);
    return out;
  }

  private async landOne(
    place: { name: string; worktreePath: string },
    repo: ConnectedRepo | undefined,
    branch: string,
    title: string,
    body: string,
  ): Promise<Landed> {
    const git = (args: string[]) => this.deps.git(args, place.worktreePath);
    const status = await git(['status', '--porcelain']);
    if (!status.ok) return { repo: place.name, error: status.error };
    if (status.stdout.trim()) {
      const added = await git(['add', '-A']);
      if (!added.ok) return { repo: place.name, error: added.error };
      const committed = await git(['commit', '--no-verify', '-m', title, ...(body ? ['-m', body] : [])]);
      if (!committed.ok) return { repo: place.name, error: committed.error };
    }
    const base = repo?.defaultBranch ?? 'main';
    const ahead = await git(['rev-list', '--count', `origin/${base}..HEAD`]);
    if (ahead.ok && Number(ahead.stdout.trim()) === 0) return { repo: place.name, skipped: 'no changes' };
    // The run pushed it itself (a flow with its own push step, where it could):
    // a second branch of the same commits would only be noise.
    const there = await git(['for-each-ref', '--contains', 'HEAD', '--format=%(refname:short)', 'refs/remotes/origin']);
    const pushedAs = there.ok ? there.stdout.split('\n').map((s) => s.trim()).filter((b) => b && b !== `origin/${base}` && b !== 'origin/HEAD')[0] : undefined;
    if (pushedAs) return { repo: place.name, branch: pushedAs.replace(/^origin\//, ''), ...(repo && newPullRequestLink(repo, pushedAs.replace(/^origin\//, '')) ? { url: newPullRequestLink(repo, pushedAs.replace(/^origin\//, ''))! } : {}) };
    if (repo?.testCommand && this.deps.test) {
      const tested = await this.deps.test(repo.testCommand, place.worktreePath);
      if (!tested.ok && tested.refused) return { repo: place.name, skipped: `repo tests are turned off on this server, so nothing was pushed. ${tested.error}` };
      if (!tested.ok) return { repo: place.name, skipped: `its tests failed, so nothing was pushed:\n${tested.error.slice(-1500)}` };
    }
    // Built on a branch this server pushed before (a follow-up to a change
    // whose pull request is open): the new commits go on that branch, so the
    // pull request has them. Never forced: if it has moved, a branch of its own.
    const onto = await this.builtOn(git, base);
    if (onto) {
      const added = await git(['push', '--no-verify', 'origin', `HEAD:refs/heads/${onto}`]);
      if (added.ok) return { repo: place.name, branch: onto, updated: true };
      this.deps.log(`Could not add to ${onto}, so pushing a branch of its own: ${added.error.slice(-300)}`);
    }
    const pushed = await git(['push', '--no-verify', 'origin', `HEAD:refs/heads/${branch}`]);
    if (!pushed.ok) return { repo: place.name, error: pushed.error.slice(-800) };
    const url = (repo && newPullRequestLink(repo, branch)) ?? /https?:\/\/\S+(?:pull\/new|compare|pull-requests\/new|merge_requests\/new)\S*/.exec(pushed.stdout)?.[0];
    return { repo: place.name, branch, ...(url ? { url } : {}) };
  }

  /// A pushed branch's pull request, opened through the host when the Repos
  /// page says so. Failing that, the link to open one stays.
  private async withPr(l: Landed, repo: ConnectedRepo | undefined, title: string, body: string): Promise<Landed> {
    if (!repo || !l.branch || l.error || l.skipped || !this.deps.openPr) return l;
    const pr = await this.deps.openPr(repo, l.branch, title, body).catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));
    if (!pr) return l;
    if ('error' in pr) {
      this.deps.log(`Couldn't open the pull request for ${l.repo} ${l.branch}: ${pr.error}`);
      return { ...l, prError: pr.error };
    }
    return { ...l, url: pr.url, pr: pr.draft ? 'draft' : 'open' };
  }

  /// The branch with the server's prefix that HEAD was built on and the
  /// default branch doesn't have yet, nearest first. Null: none.
  private async builtOn(git: (args: string[]) => ReturnType<LandDeps['git']>, base: string): Promise<string | null> {
    const prefix = `origin/${this.deps.branchPrefix?.() || 'overcli/'}`;
    const under = await git(['for-each-ref', '--merged', 'HEAD', '--no-merged', `origin/${base}`, '--format=%(refname:short)', 'refs/remotes/origin']);
    if (!under.ok) return null;
    let best: { name: string; behind: number } | null = null;
    for (const ref of under.stdout.split('\n').map((s) => s.trim()).filter((s) => s.startsWith(prefix))) {
      const count = await git(['rev-list', '--count', `${ref}..HEAD`]);
      const n = count.ok ? Number(count.stdout.trim()) : NaN;
      if (Number.isFinite(n) && (!best || n < best.behind)) best = { name: ref.slice('origin/'.length), behind: n };
    }
    return best?.name ?? null;
  }
}

/// The branches a run's push went to, read back from its artifact. One
/// line each; a line written before it named the branch has its link's.
export function landedBranches(text: string): string[] {
  return text.split('\n').flatMap((line) => {
    const m =
      /\(branch ([^\s)]+)\)|pushed branch (\S+)|added to (\S+), so/.exec(line) ??
      /[?&]source=([^&\s]+)|\/compare\/[^\s]+?\.\.\.([^?\s]+)|merge_requests\/new\?merge_request%5Bsource_branch%5D=([^&\s]+)/.exec(line);
    const branch = m?.slice(1).find(Boolean);
    return branch ? [decodeURIComponent(branch)] : [];
  });
}

/// One line per repo, as the run's artifact: what the front door, the
/// Library and the worker's page read the links from.
export function describe(landed: Landed[]): string {
  if (!landed.length) return 'Nothing to push: this run had no repo to push from.';
  // A workspace of thirty repos where one changed: the one, and a count of
  // the rest, not thirty lines saying "no changes".
  const quiet = landed.filter((l) => l.skipped === 'no changes');
  const told = landed.filter((l) => l.skipped !== 'no changes');
  if (!told.length) return 'Nothing to push: no repo changed.';
  return told
    .map((l) =>
      l.updated
        ? `${l.repo}: added to ${l.branch}, so its open pull request has the new commits${l.pr ? `: ${l.url}` : ''}`
        : l.pr
        ? `${l.pr === 'draft' ? 'Opened a draft pull request' : 'Opened a pull request'} for ${l.repo}: ${l.url} (branch ${l.branch})`
        : l.url
        ? `Open a pull request for ${l.repo}: ${l.url} (branch ${l.branch})${l.prError ? ` (it couldn't be opened for you: ${l.prError})` : ''}`
        : l.branch
          ? `${l.repo}: pushed branch ${l.branch}${l.prError ? ` (no pull request: ${l.prError})` : ''}`
          : l.skipped
            ? `${l.repo}: not pushed — ${l.skipped}`
            : `${l.repo}: could not push — ${pushAdvice(l.error ?? '')}`,
    )
    .concat(quiet.length ? [`${quiet.length} other ${quiet.length === 1 ? 'repo' : 'repos'} had no changes.`] : [])
    // A list, so it reads as one line per repo wherever it's shown as markdown.
    .map((line) => `- ${line}`)
    .join('\n');
}

/// A refused push, with what to do when the host says the token can't write.
function pushAdvice(error: string): string {
  if (/privilege scopes|403|permission to .* denied|write access/i.test(error)) {
    return `${error.trim()}\nThe server's token can read this repo but not push to it. Give it write access (Bitbucket: Repositories: Write; GitHub: Contents: Read and write) and save it again under Setup → Secrets.`;
  }
  return error;
}
