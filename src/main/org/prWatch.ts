// Watching the team's open pull requests for something a worker can fix,
// with no model in the loop: a few host API calls every few minutes per repo.
// A worker that looks after them (WorkerCaps.continueOpenPrs) is woken when
// one of its places has a pull request whose build went red or that stopped
// merging cleanly, and, on pull requests by the people it fixes comments for
// (WorkerCaps.prCommentAuthors), one that gained a review comment. It reacts in
// minutes instead of re-reading every pull request on an hourly shift, and is
// woken once a pull request has settled (its builds done, quiet for a while),
// with everything that came in meanwhile, the AI reviewers' comments too.
// Whose pull requests it touches at all can be narrowed (WorkerCaps.prAuthors).
//
// Each host is an adapter (PrHost): Bitbucket and GitHub here, the hosts a
// repo connects to. A new host is one more adapter.
//
// Conflicts are asked of git, not the host: a test merge of the pull
// request's head into its target, in the server's own clone (gitConflicted).
// Bitbucket's diffstat doesn't say when a pull request stopped merging, and a
// test merge answers the same way for every host.
//
// Comments: only top-level ones count, not replies inside a thread, and never
// one the worker posted itself: everything it posts ends with OWN_MARK.

import type { ConnectedRepo } from './repos';
import { authFor, slugOf } from './ciWatch';

type Fetch = typeof fetch;

/// What every comment a worker posts on a pull request ends with, so the
/// watcher never counts its own as news (prReplies.ts writes it).
export const OWN_MARK = '— via overgo';

export interface OpenPr {
  id: string;
  url: string;
  title: string;
  branch: string;
  /// The head commit, as the host gives it (Bitbucket: 12 characters).
  head: string;
  updatedAt: string;
  draft: boolean;
  /// Who opened it, each way the host names them (shown name, account name).
  author: string[];
  /// The branch it merges into. Absent: the repo's default branch.
  target?: string;
}
export type BuildState = 'failed' | 'passed' | 'pending' | 'none';

/// What one host answers. Undefined (or null for a list): it couldn't be asked.
export interface PrHost {
  open(): Promise<OpenPr[] | null>;
  defaultHead(): Promise<string | undefined>;
  conflicted(pr: OpenPr): Promise<boolean | undefined>;
  build(pr: OpenPr): Promise<BuildState | undefined>;
  /// Top-level comments that aren't deleted and aren't a worker's own.
  comments(pr: OpenPr): Promise<number | undefined>;
}

interface Seen {
  head: string;
  updatedAt: string;
  comments?: number;
  conflicted?: boolean;
  build?: BuildState;
  /// What it has gathered and not told yet: told once the pull request settles.
  pending?: { conflict?: true; failed?: true; comments?: number };
  /// When something last changed on it, as the server saw it.
  activeAt?: number;
  /// When its worker was woken for it, the last day's.
  woken?: number[];
}

/// Settled: nothing new for this long, and no build still running. Reviews
/// trickle in (a pipeline's AI reviewer, a scanner, a person), and a worker
/// should see them together, as someone would once the builds are done.
export const QUIET_MS = 10 * 60_000;
/// Its own push starts a new build and a new review; past this many wakes a
/// day for one pull request, the rest waits for a person.
export const MAX_WAKES_PER_DAY = 3;
const DAY_MS = 24 * 60 * 60_000;

export interface PrWatchState {
  repos: Record<string, { base?: string; prs: Record<string, Seen> }>;
}

/// A worker that looks after pull requests, and whose.
export interface PrWatcherOf {
  workerId: string;
  repos: ConnectedRepo[];
  /// Only pull requests by these people. Empty or absent: everyone's.
  authors?: string[];
  /// Review comments too, on pull requests by these people. Empty or absent: none.
  commentAuthors?: string[];
  /// How many pull requests one wake hands it: what it takes up per task
  /// (WorkerCaps.maxItemsPerShift). The rest wait their turn. Absent: 3.
  perWake?: number;
}

export interface PrWatchDeps {
  store: { load(): PrWatchState; save(value: PrWatchState): void };
  watchers(): PrWatcherOf[];
  host(repo: ConnectedRepo): PrHost | null;
  /// A commit the server pushed itself: its build is the CI watcher's business.
  ownPush(repo: ConnectedRepo, branch: string, head: string): boolean;
  wake(workerId: string, text: string): Promise<unknown>;
  /// Still on what it was last handed (planning, or its runs going): the next
  /// pull requests wait until it's free, rather than piling up behind it.
  busy?(workerId: string): boolean;
  log(message: string): void;
  now?(): number;
}

export interface PrChange {
  repo: string;
  pr: OpenPr;
  what: string[];
}

/// Whether a pull request is by one of these people, however the host names them.
export function byOneOf(pr: Pick<OpenPr, 'author'>, people: readonly string[] | undefined): boolean {
  const wanted = (people ?? []).map((n) => n.trim().toLowerCase()).filter(Boolean);
  return pr.author.some((a) => wanted.includes(a.toLowerCase()));
}

/// What a watcher takes up on a pull request: builds and conflicts, and comments.
export function wantsOf(w: Pick<PrWatcherOf, 'authors' | 'commentAuthors'>, pr: Pick<OpenPr, 'author'>): { fixes: boolean; comments: boolean } {
  const fixes = !w.authors?.length || byOneOf(pr, w.authors);
  return { fixes, comments: fixes && byOneOf(pr, w.commentAuthors) };
}

/// What one repo's pull requests have ready to tell, and what to remember.
/// Something new on a pull request is gathered, not told at once: it's ready
/// when the pull request has settled (QUIET_MS, no build running), together.
/// It stays gathered until a worker is actually handed it (markTold), so what
/// one wake can't take waits for the next.
/// `wants`: what anyone watching takes up on that pull request; nothing else is asked or gathered.
export async function changesIn(
  repo: ConnectedRepo,
  host: PrHost,
  before: { base?: string; prs: Record<string, Seen> } | undefined,
  ownPush: PrWatchDeps['ownPush'],
  now: number = Date.now(),
  wants: (pr: OpenPr) => { fixes: boolean; comments: boolean } = () => ({ fixes: true, comments: false }),
): Promise<{ changes: PrChange[]; now: { base?: string; prs: Record<string, Seen> } } | null> {
  const open = await host.open();
  if (!open) return null;
  const base = await host.defaultHead();
  const prs: Record<string, Seen> = {};
  const changes: PrChange[] = [];
  for (const pr of open.filter((p) => !p.draft)) {
    const want = wants(pr);
    if (!want.fixes) continue;
    const was = before?.prs[pr.id];
    const moved = !was || was.updatedAt !== pr.updatedAt || was.head !== pr.head;
    // A conflict comes from either side moving: the pull request, or its target.
    const conflicted = moved || (base && base !== before?.base) || was?.conflicted === undefined ? await host.conflicted(pr) : was.conflicted;
    const build = moved || !was?.build || was.build === 'pending' ? await host.build(pr) : was.build;
    const comments = want.comments ? (moved || was?.comments === undefined ? await host.comments(pr) : was.comments) : undefined;

    // Gather what's new. Comments there before it counted them came before
    // the worker was told about any.
    const pending = { ...(was?.pending ?? {}) };
    if (conflicted) {
      if (!was?.conflicted) pending.conflict = true;
    } else delete pending.conflict;
    if (build === 'failed') {
      if ((was?.build !== 'failed' || was.head !== pr.head) && !ownPush(repo, pr.branch, pr.head)) pending.failed = true;
    } else if (build === 'passed') delete pending.failed;
    if (!want.comments) delete pending.comments;
    else if (comments !== undefined && was?.comments !== undefined && comments > was.comments) pending.comments = (pending.comments ?? 0) + comments - was.comments;
    const changedNow = moved || build !== was?.build || conflicted !== was?.conflicted || comments !== was?.comments;
    const activeAt = changedNow || was?.activeAt === undefined ? now : was.activeAt;

    // Ready once it settles, and not past the day's wakes for it.
    const woken = (was?.woken ?? []).filter((t) => now - t < DAY_MS);
    const what = [
      ...(pending.conflict ? [`conflicts with ${repo.defaultBranch}`] : []),
      ...(pending.failed ? ['its build failed'] : []),
      ...(pending.comments ? [`${pending.comments} new review comment${pending.comments === 1 ? '' : 's'}`] : []),
    ];
    const settled = build !== 'pending' && now - activeAt >= QUIET_MS;
    if (what.length > 0 && settled && woken.length < MAX_WAKES_PER_DAY) changes.push({ repo: repo.name, pr, what });

    prs[pr.id] = {
      head: pr.head,
      updatedAt: pr.updatedAt,
      activeAt,
      ...(comments !== undefined ? { comments } : {}),
      ...(conflicted !== undefined ? { conflicted } : {}),
      ...(build ? { build } : {}),
      ...(what.length ? { pending } : {}),
      ...(woken.length ? { woken } : {}),
    };
  }
  return { changes, now: { ...(base ? { base } : {}), prs } };
}

/// A pull request handed to a worker: what was gathered is told, and counts toward the day's wakes.
export function markTold(entry: { prs: Record<string, Seen> } | undefined, id: string, now: number): void {
  const seen = entry?.prs[id];
  if (!seen) return;
  delete seen.pending;
  seen.woken = [...(seen.woken ?? []).filter((t) => now - t < DAY_MS), now];
}

/// The errand a worker is woken with.
export function wakeText(changes: PrChange[]): string {
  return [
    'Open pull requests changed since you last looked. The server noticed these from the host; you have not read them yet:',
    ...changes.map((c) => `- ${c.repo} PR #${c.pr.id} "${c.pr.title}" (${c.pr.url}), branch ${c.pr.branch}: ${c.what.join('; ')}`),
    '',
    'Look at each as your job says, and file a proposal for each one with work you can do. Fix review comments only where this list says there are new ones. Skip the rest and say why in one line each.',
  ].join('\n');
}

export class PrWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  constructor(private readonly deps: PrWatchDeps) {}

  start(everyMs = 5 * 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const watchers = this.deps.watchers();
      if (!watchers.length) return;
      const state = this.deps.store.load();
      const repos = new Map<string, ConnectedRepo>();
      for (const w of watchers) for (const r of w.repos) repos.set(r.name, r);
      const changed: PrChange[] = [];
      for (const repo of repos.values()) {
        const host = this.deps.host(repo);
        if (!host) continue;
        // What anyone watching this repo takes up on a pull request.
        const here = watchers.filter((w) => w.repos.some((r) => r.name === repo.name));
        const wants = (pr: OpenPr) => {
          const each = here.map((w) => wantsOf(w, pr));
          return { fixes: each.some((x) => x.fixes), comments: each.some((x) => x.comments) };
        };
        const got = await changesIn(repo, host, state.repos[repo.name], this.deps.ownPush, this.deps.now?.() ?? Date.now(), wants).catch((err: unknown) => {
          this.deps.log(`Couldn't check ${repo.name}'s pull requests: ${String(err)}`);
          return null;
        });
        if (!got) continue;
        state.repos[repo.name] = got.now;
        changed.push(...got.changes);
      }
      const now = this.deps.now?.() ?? Date.now();
      const told = new Set<string>();
      for (const w of watchers) {
        const mine = changed
          .filter((c) => w.repos.some((r) => r.name === c.repo) && !told.has(`${c.repo}#${c.pr.id}`))
          .flatMap((c) => {
            const want = wantsOf(w, c.pr);
            const what = c.what.filter((x) => (/review comment/.test(x) ? want.comments : want.fixes));
            return what.length ? [{ ...c, what }] : [];
          })
          // The longest-waiting first.
          .sort((a, b) => a.pr.updatedAt.localeCompare(b.pr.updatedAt));
        if (!mine.length || this.deps.busy?.(w.workerId)) continue;
        const batch = mine.slice(0, Math.max(1, w.perWake ?? 3));
        this.deps.log(`${batch.length} pull request${batch.length === 1 ? '' : 's'} ready${mine.length > batch.length ? `, ${mine.length - batch.length} more waiting` : ''}; waking worker ${w.workerId}.`);
        const woke = await Promise.resolve(this.deps.wake(w.workerId, wakeText(batch))).then(
          () => true,
          (err: unknown) => (this.deps.log(`Couldn't wake worker ${w.workerId}: ${String(err)}`), false),
        );
        if (!woke) continue;
        for (const c of batch) {
          markTold(state.repos[c.repo], c.pr.id, now);
          told.add(`${c.repo}#${c.pr.id}`);
        }
      }
      this.deps.store.save(state);
    } finally {
      this.busy = false;
    }
  }
}

// ---- hosts --------------------------------------------------------------------

const BB = 'https://api.bitbucket.org/2.0/repositories';
const GH = 'https://api.github.com/repos';

async function getJson<T>(f: Fetch, url: string, headers: Record<string, string>): Promise<T | undefined> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30_000);
  try {
    const res = await f(url, { headers: { Accept: 'application/json', ...headers }, signal: ctl.signal });
    return res.ok ? ((await res.json()) as T) : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/// Every page of a Bitbucket list, up to `pages`.
async function bbAll<T>(f: Fetch, url: string, auth: Record<string, string>, pages = 5): Promise<T[] | undefined> {
  const out: T[] = [];
  let next: string | undefined = url;
  for (let i = 0; next && i < pages; i++) {
    const page: { values?: T[]; next?: string } | undefined = await getJson<{ values?: T[]; next?: string }>(f, next, auth);
    if (!page) return i ? out : undefined;
    out.push(...(page.values ?? []));
    next = page.next;
  }
  return out;
}

const names = (...n: Array<string | undefined>) => n.filter((x): x is string => !!x);

/// Runs git in a clone and says how it ended: 0 is fine, anything else is git's exit code.
export type GitRun = (args: string[], cwd: string) => Promise<{ code: number; stdout: string }>;

/// Whether a pull request no longer merges into its target, by a test merge in
/// the server's clone that changes nothing (`git merge-tree`). Fetches its branch
/// and target first, so the answer is about them as they are on the host now.
/// Undefined: git couldn't say (the branch is gone, or git is too old).
export async function gitConflicted(repo: ConnectedRepo, pr: Pick<OpenPr, 'branch' | 'head' | 'target'>, git: GitRun): Promise<boolean | undefined> {
  if (!repo.path || !pr.branch) return undefined;
  const target = pr.target || repo.defaultBranch;
  const spec = (b: string) => `+refs/heads/${b}:refs/remotes/origin/${b}`;
  await git(['fetch', '--quiet', 'origin', spec(pr.branch), spec(target)], repo.path);
  const has = async (ref: string) => (await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repo.path)).code === 0;
  const head = pr.head && (await has(pr.head)) ? pr.head : `refs/remotes/origin/${pr.branch}`;
  // A branch or target that isn't there can't be test-merged; git's "no" would read as a conflict.
  if (!(await has(head)) || !(await has(`refs/remotes/origin/${target}`))) return undefined;
  const merged = await git(['merge-tree', '--write-tree', `refs/remotes/origin/${target}`, head], repo.path);
  return merged.code === 0 ? false : merged.code === 1 ? true : undefined;
}
const ours = (text: string | undefined) => !!text && text.includes(OWN_MARK);

/// `git`: how conflicts are checked (gitConflicted). Absent: they aren't.
export function prHostFor(repo: ConnectedRepo, deps: { env(name: string): string | undefined; fetchImpl?: Fetch; git?: GitRun }): PrHost | null {
  const slug = slugOf(repo);
  const auth = authFor(repo, deps.env);
  if (!slug || !auth) return null;
  const f = deps.fetchImpl ?? fetch;
  const conflicted = async (pr: OpenPr) => (deps.git ? gitConflicted(repo, pr, deps.git) : undefined);
  if (slug.host === 'bitbucket') {
    const base = `${BB}/${slug.owner}/${slug.name}`;
    type BbPr = {
      id: number;
      title: string;
      draft?: boolean;
      updated_on: string;
      links?: { html?: { href?: string } };
      source?: { branch?: { name?: string }; commit?: { hash?: string } };
      destination?: { branch?: { name?: string } };
      author?: { display_name?: string; nickname?: string };
    };
    return {
      open: async () => {
        const list = await bbAll<BbPr>(f, `${base}/pullrequests?state=OPEN&pagelen=50`, auth);
        return list
          ? list.map((p) => ({
              id: String(p.id),
              url: p.links?.html?.href ?? `${base}/pullrequests/${p.id}`,
              title: p.title,
              branch: p.source?.branch?.name ?? '',
              head: p.source?.commit?.hash ?? '',
              updatedAt: p.updated_on,
              draft: p.draft === true,
              author: names(p.author?.display_name, p.author?.nickname),
              ...(p.destination?.branch?.name ? { target: p.destination.branch.name } : {}),
            }))
          : null;
      },
      defaultHead: async () => (await getJson<{ target?: { hash?: string } }>(f, `${base}/refs/branches/${encodeURIComponent(repo.defaultBranch)}`, auth))?.target?.hash,
      conflicted,
      build: async (pr) => {
        if (!pr.head) return undefined;
        const statuses = await bbAll<{ state?: string }>(f, `${base}/commit/${pr.head}/statuses?pagelen=100`, auth, 2);
        if (!statuses) return undefined;
        if (!statuses.length) return 'none';
        if (statuses.some((s) => s.state === 'FAILED' || s.state === 'STOPPED')) return 'failed';
        return statuses.some((s) => s.state === 'INPROGRESS') ? 'pending' : 'passed';
      },
      comments: async (pr) => {
        const all = await bbAll<{ deleted?: boolean; parent?: unknown; content?: { raw?: string } }>(f, `${base}/pullrequests/${pr.id}/comments?pagelen=100`, auth);
        return all ? all.filter((c) => !c.deleted && !c.parent && !ours(c.content?.raw)).length : undefined;
      },
    };
  }
  const base = `${GH}/${slug.owner}/${slug.name}`;
  const gh = { ...auth, 'X-GitHub-Api-Version': '2022-11-28' };
  type GhPr = { number: number; title: string; html_url: string; updated_at: string; draft?: boolean; head?: { ref?: string; sha?: string }; base?: { ref?: string }; user?: { login?: string } };
  return {
    open: async () => {
      const list = await getJson<GhPr[]>(f, `${base}/pulls?state=open&per_page=100`, gh);
      return list
        ? list.map((p) => ({ id: String(p.number), url: p.html_url, title: p.title, branch: p.head?.ref ?? '', head: p.head?.sha ?? '', updatedAt: p.updated_at, draft: p.draft === true, author: names(p.user?.login), ...(p.base?.ref ? { target: p.base.ref } : {}) }))
        : null;
    },
    defaultHead: async () => (await getJson<{ commit?: { sha?: string } }>(f, `${base}/branches/${encodeURIComponent(repo.defaultBranch)}`, gh))?.commit?.sha,
    conflicted,
    build: async (pr) => {
      if (!pr.head) return undefined;
      const runs = await getJson<{ check_runs?: Array<{ status?: string; conclusion?: string | null }> }>(f, `${base}/commits/${pr.head}/check-runs?per_page=100`, gh);
      if (!runs) return undefined;
      const all = runs.check_runs ?? [];
      if (!all.length) return 'none';
      if (all.some((r) => r.status === 'completed' && r.conclusion && ['failure', 'timed_out', 'cancelled', 'action_required'].includes(r.conclusion))) return 'failed';
      return all.some((r) => r.status !== 'completed') ? 'pending' : 'passed';
    },
    comments: async (pr) => {
      type GhComment = { in_reply_to_id?: number; body?: string };
      const [talk, review] = await Promise.all([
        getJson<GhComment[]>(f, `${base}/issues/${pr.id}/comments?per_page=100`, gh),
        getJson<GhComment[]>(f, `${base}/pulls/${pr.id}/comments?per_page=100`, gh),
      ]);
      if (!talk || !review) return undefined;
      return talk.filter((c) => !ours(c.body)).length + review.filter((c) => !c.in_reply_to_id && !ours(c.body)).length;
    },
  };
}
