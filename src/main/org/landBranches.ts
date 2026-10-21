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
}

export interface Landed {
  repo: string;
  branch?: string;
  url?: string;
  /// Why nothing was pushed: no changes, the tests failed, or tests are turned off here.
  skipped?: string;
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

  /// Fed every run update; acts once on a finished repo or workspace run.
  onRun(run: FlowRun): void {
    if (!run.flowId.startsWith('org-pr-')) return;
    if (run.state.kind !== 'done' || !run.state.success) return;
    if (run.artifacts?.[LANDED_ARTIFACT] || this.busy.has(run.id)) return;
    this.busy.add(run.id);
    void this.land(run)
      .catch((err: unknown) => this.deps.log(`Could not push run ${run.id}: ${String(err)}`))
      .finally(() => this.busy.delete(run.id));
  }

  async land(run: FlowRun): Promise<Landed[]> {
    const places = run.workspaceWorktrees?.length
      ? run.workspaceWorktrees.map((m) => ({ name: m.name, projectPath: m.projectPath, worktreePath: m.worktreePath }))
      : run.worktreePath
        ? [{ name: path.basename(run.projectPath), projectPath: run.projectPath, worktreePath: run.worktreePath }]
        : [];
    const { title, body } = pullRequestText(run);
    const branch = `overcli/${slugify(title)}-${run.id.slice(0, 6)}`;
    const out: Landed[] = [];
    for (const place of places) {
      const repo = this.deps.repos().find((r) => r.path === place.projectPath);
      // One repo going wrong must not cost the others their links.
      out.push(await this.landOne(place, repo, branch, title, body).catch((err: unknown) => ({ repo: place.name, error: err instanceof Error ? err.message : String(err) })));
    }
    this.deps.attach(run.id, LANDED_ARTIFACT, describe(out));
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
    if (repo?.testCommand && this.deps.test) {
      const tested = await this.deps.test(repo.testCommand, place.worktreePath);
      if (!tested.ok && tested.refused) return { repo: place.name, skipped: `repo tests are turned off on this server, so nothing was pushed. ${tested.error}` };
      if (!tested.ok) return { repo: place.name, skipped: `its tests failed, so nothing was pushed:\n${tested.error.slice(-1500)}` };
    }
    const pushed = await git(['push', '--no-verify', 'origin', `HEAD:refs/heads/${branch}`]);
    if (!pushed.ok) return { repo: place.name, error: pushed.error.slice(-800) };
    const url = (repo && newPullRequestLink(repo, branch)) ?? /https?:\/\/\S+(?:pull\/new|compare|pull-requests\/new|merge_requests\/new)\S*/.exec(pushed.stdout)?.[0];
    return { repo: place.name, branch, ...(url ? { url } : {}) };
  }
}

/// One line per repo, as the run's artifact: what the front door, the
/// Library and the worker's page read the links from.
export function describe(landed: Landed[]): string {
  if (!landed.length) return 'Nothing to push: this run had no repo to push from.';
  return landed
    .map((l) =>
      l.url
        ? `Open a pull request for ${l.repo}: ${l.url}`
        : l.branch
          ? `${l.repo}: pushed branch ${l.branch}`
          : l.skipped
            ? `${l.repo}: not pushed — ${l.skipped}`
            : `${l.repo}: could not push — ${l.error}`,
    )
    .join('\n');
}
