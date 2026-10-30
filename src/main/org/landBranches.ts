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
import { ticketOf } from './ticketFollowUp';
import { withoutPreface } from './askPreface';

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
  openPr?(repo: ConnectedRepo, branch: string, title: string, body: string): Promise<{ url: string; draft: boolean; existed?: true } | { error: string } | null>;
  /// After a run's branches are pushed: the ticket follow-up hangs off this.
  onLanded?(run: FlowRun, landed: Landed[]): void;
  /// Nothing pushed anywhere: a CI fix that changed nothing hangs off this.
  onNothing?(run: FlowRun, landed: Landed[]): void;
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
  /// It was open already: found, left as it was, not opened now.
  existed?: true;
  /// Why the pull request couldn't be opened; the link to open one stands.
  prError?: string;
  error?: string;
}

function slugify(text: string): string {
  const s = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  // Cut at a word: not mid-word, and never a dash left before the run id ("on--7b222e").
  return (s.length > 40 ? s.slice(0, 40).replace(/-[^-]*$/, '') : s) || 'change';
}

/// The branch a run's change goes on: the ticket key first, where the run
/// is for one, so the tracker links it.
export function branchFor(prefix: string, title: string, ticket: string | null, runId: string): string {
  const words = ticket ? title.replace(new RegExp(`\\b${ticket}\\b:?`, 'g'), ' ') : title;
  return `${prefix}${ticket ? `${ticket}-` : ''}${slugify(words)}-${runId.slice(0, 6)}`;
}

/// The pull request's title names the ticket, whatever its writer left out.
export function ticketed(text: { title: string; body: string }, ticket: string | null): { title: string; body: string } {
  return ticket && !text.title.includes(ticket) ? { ...text, title: `${ticket}: ${text.title}` } : text;
}

/// The title (first line) and description (the rest) a run's last step wrote.
/// Unwritten: what the run was launched as, else its ask's first line, never
/// the preface overcli put in front of it ("(Set off by a trigger…").
export function pullRequestText(run: Pick<FlowRun, 'artifacts' | 'userPrompt' | 'orchestrationItemTitle'>): { title: string; body: string } {
  const written = run.artifacts?.[PR_STEP_OUTPUT]?.body?.trim() ?? '';
  const lines = written.split('\n');
  const first = lines.findIndex((l) => l.trim());
  const asked = run.orchestrationItemTitle?.trim() || withoutPreface(run.userPrompt).split('\n').find((l) => l.trim()) || 'A change';
  const title = (first >= 0 ? lines[first] : asked)
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

  private placesOf(run: FlowRun): Array<{ name: string; projectPath: string; worktreePath: string }> {
    return run.workspaceWorktrees?.length
      ? run.workspaceWorktrees.map((m) => ({ name: m.name, projectPath: m.projectPath, worktreePath: m.worktreePath }))
      : run.worktreePath
        ? [{ name: path.basename(run.projectPath), projectPath: run.projectPath, worktreePath: run.worktreePath }]
        : [];
  }

  /// A landed run carried on in its own checkout (a CI fix): what that turn
  /// changed, committed as `message` and added to the branch each repo's
  /// change is already on, so its pull request has it. `head`: where the
  /// checkout stood before the turn, so a turn that changed nothing lands
  /// nothing. The branch moved meanwhile: a branch of its own beside it.
  async landAgain(run: FlowRun, onto: Array<{ repo: string; branch: string; head: string }>, message: string): Promise<Landed[]> {
    const out: Landed[] = [];
    for (const o of onto) {
      const place = this.placesOf(run).find((p) => p.name === o.repo);
      if (!place) {
        out.push({ repo: o.repo, error: 'its checkout is not part of that run' });
        continue;
      }
      const repo = this.deps.repos().find((r) => r.path === place.projectPath);
      out.push(
        await this.landOne(place, repo, `${o.branch}-fix`, message, '', o.head, undefined, o.branch)
          .then((l) => (l.updated ? l : this.withPr(l, repo, message, '')))
          .catch((err: unknown) => ({ repo: o.repo, error: err instanceof Error ? err.message : String(err) })),
      );
    }
    return out;
  }

  async land(run: FlowRun): Promise<Landed[]> {
    const places = this.placesOf(run);
    const { title, body } = ticketed(pullRequestText(run), ticketOf(run));
    // Named from what the run was launched as (a worker's proposal, which
    // carries the ticket's words), not from what its writer called it after.
    const branch = branchFor(this.deps.branchPrefix?.() || 'overcli/', run.orchestrationItemTitle?.trim() || title, ticketOf(run), run.id);
    const out: Landed[] = [];
    for (const place of places) {
      const repo = this.deps.repos().find((r) => r.path === place.projectPath);
      const baseline = run.workspaceWorktrees?.length ? run.baselineCommitsByMember?.[place.name]?.commit : run.baselineCommit;
      // One repo going wrong must not cost the others their links.
      out.push(
        await this.landOne(place, repo, branch, title, body, baseline, run.createdAt, run.continues)
          .then((l) => this.withPr(l, repo, title, body))
          .catch((err: unknown) => ({ repo: place.name, error: err instanceof Error ? err.message : String(err) })),
      );
    }
    this.deps.attach(run.id, LANDED_ARTIFACT, describe(out));
    if (out.some((l) => l.url || (l.branch && !l.error))) this.deps.onLanded?.(run, out);
    else this.deps.onNothing?.(run, out);
    return out;
  }

  private async landOne(
    place: { name: string; worktreePath: string },
    repo: ConnectedRepo | undefined,
    branch: string,
    title: string,
    body: string,
    baseline?: string,
    startedAt?: number,
    continues?: string,
  ): Promise<Landed> {
    const git = (args: string[]) => this.deps.git(args, place.worktreePath);
    const status = await git(['status', '--porcelain']);
    if (!status.ok) return { repo: place.name, error: status.error };
    if (status.stdout.trim()) {
      const added = await git(['add', '-A']);
      if (!added.ok) return { repo: place.name, error: added.error };
      const committed = await git(['commit', '--no-verify', '-m', title, ...(body ? ['-m', body] : [])]);
      if (!committed.ok) return { repo: place.name, error: committed.error };
    } else {
      // Nothing this run made: a checkout that started on someone else's
      // branch is already ahead of the default branch, and that's not ours.
      if (baseline) {
        const head = await git(['rev-parse', 'HEAD']);
        if (head.ok && head.stdout.trim() === baseline) return { repo: place.name, skipped: 'no changes' };
      }
      // Nor is a HEAD older than the run: one told to work from an earlier
      // branch checked it out itself and changed nothing. Landed, it would
      // have that branch's pull request rewritten and its CI watched again.
      if (startedAt) {
        const made = await git(['log', '-1', '--format=%ct', 'HEAD']);
        const at = made.ok ? Number(made.stdout.trim()) : 0;
        if (at > 0 && (at + 1) * 1000 <= startedAt) return { repo: place.name, skipped: 'no changes' };
      }
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
    // Started on a branch this server pushed, to add to it (a CI fix, a
    // follow-up for the same ticket): the new commits go on that branch, so
    // its pull request has them. Only that one: a run whose checkout merely
    // sits on someone else's commits gets a branch of its own, or its work
    // lands in another ticket's pull request. Never forced: if the branch has
    // moved, or this repo doesn't have it, a branch of its own.
    if (continues) {
      const on = await git(['merge-base', '--is-ancestor', `origin/${continues}`, 'HEAD']);
      const added = on.ok ? await git(['push', '--no-verify', 'origin', `HEAD:refs/heads/${continues}`]) : on;
      if (added.ok) return { repo: place.name, branch: continues, updated: true };
      this.deps.log(`Could not add to ${continues}, so pushing a branch of its own: ${added.error.slice(-300)}`);
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
    return { ...l, url: pr.url, pr: pr.draft ? 'draft' : 'open', ...(pr.existed ? { existed: true as const } : {}) };
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
        : l.existed
        ? `${l.repo}: its pull request was already open, left as it was: ${l.url} (branch ${l.branch})`
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

/// A pull request a run's landing note names, read back out of describe()'s lines.
export interface LandedPullRequest {
  repo: string;
  url: string;
  branch?: string;
  /// open/draft: opened now; updated: new commits on one already open;
  /// existing: found open, left alone; unopened: only a link to open one.
  state: 'open' | 'draft' | 'updated' | 'existing' | 'unopened';
}

/// The pull requests in a landing note (describe()'s output), in order.
export function pullRequestsIn(body: string): LandedPullRequest[] {
  const out: LandedPullRequest[] = [];
  for (const raw of body.split('\n')) {
    const l = raw.replace(/^-\s+/, '');
    let m: RegExpExecArray | null;
    if ((m = /^Opened a (draft )?pull request for (.+?): (https?:\/\/\S+) \(branch ([^)]+)\)/.exec(l))) out.push({ repo: m[2], url: m[3], branch: m[4], state: m[1] ? 'draft' : 'open' });
    else if ((m = /^(.+?): its pull request was already open, left as it was: (https?:\/\/\S+) \(branch ([^)]+)\)/.exec(l))) out.push({ repo: m[1], url: m[2], branch: m[3], state: 'existing' });
    else if ((m = /^(.+?): added to (\S+), so its open pull request has the new commits: (https?:\/\/\S+)/.exec(l))) out.push({ repo: m[1], url: m[3], branch: m[2], state: 'updated' });
    else if ((m = /^Open a pull request for (.+?): (https?:\/\/\S+) \(branch ([^)]+)\)/.exec(l))) out.push({ repo: m[1], url: m[2], branch: m[3], state: 'unopened' });
  }
  return out;
}
