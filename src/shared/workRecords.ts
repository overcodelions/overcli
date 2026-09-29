// Find the work, not the tool that did it.
//
// One piece of work is scattered across records that don't know about each
// other: the flow run that built it, the chats spun off to fix it, the batch
// or worker shift that launched it, and the PR it ended in. Every list in the
// app shows one of those kinds, so finding "the developer MCP we did" meant
// remembering which tool did it first — and once the run was evicted, not
// even that worked.
//
// A WorkRecord stitches them back together. The join key is the branch: a
// chat, a run and a batch item that worked on `feat/x` in the same place are
// the same work, and the PR for `feat/x` is where it ended up. Anything with
// no branch (a plain chat, a run in the main checkout) is a record of its own.
//
// Pure and Electron-free: the renderer builds records from what its stores
// already hold plus the main-process work log (runs that outlived eviction)
// and the PR lookup.

import type { Conversation } from './types';
import type { FlowRun } from './flows/schema';
import type { Orchestration } from './flows/orchestration';
import { isSamePath } from './pathScope';

/// One finished flow run, as the main process logs it when the run goes
/// terminal. Survives the LRU eviction of `flow-runs/<id>.json`, which is
/// what made old runs unfindable.
export interface WorkLogEntry {
  runId: string;
  /// A workspace run's per-repo branches — the run has no single branch.
  repoBranches?: Array<{ repo: string; branch: string }>;
  /// The flow the run ran — absent on lines written before this existed.
  flowId?: string;
  flowName: string;
  /// The user's ask, shortened to a line.
  title: string;
  /// The user's ask in full (capped).
  prompt: string;
  headline?: string;
  summary?: string;
  /// The project/workspace the run belongs to (`flowRunOwnerPath`).
  ownerPath: string;
  /// Where the run's agents actually worked — a worktree or coordinator dir.
  /// Transcripts are filed under this cwd, so it is how a prompt-search hit
  /// finds its way back to the run.
  cwd?: string;
  branchName?: string;
  startedAt?: number;
  at: number;
  outcome: 'done' | 'failed';
  workerName?: string;
  /// Rebuilt from the summary log and a transcript after the fact, for runs
  /// evicted before this log existed. Title and prompt are best-effort.
  backfilled?: boolean;
}

export interface WorkPr {
  number: number;
  url: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  title: string;
  headRefName: string;
  mergedAt?: string | null;
}

/// A match from the main process's index of everything you typed.
export interface PromptHit {
  sessionId: string;
  /// The cwd the transcript was recorded in.
  cwd: string;
  snippet: string;
  at: number;
}

/// A finished run read back from its transcripts — one step per agent session.
export interface RunTranscriptStep {
  sessionId: string;
  /// "plan (planner)", from the banner the runtime puts on a step's prompt.
  label: string;
  messages: Array<{ role: 'user' | 'assistant'; text: string; at: number }>;
  /// Only the last messages of a very long session are kept.
  truncated: boolean;
}

export interface RunTranscript {
  steps: RunTranscriptStep[];
}

export type WorkKind = 'chat' | 'run' | 'batch';

/// Where a branch stands in git — see main/work/branchStatus.ts.
export interface BranchStatus {
  local: boolean;
  remote: boolean;
  /// The branch work lands in (origin's default), without `origin/`.
  trunk?: string;
  ahead: number;
  behind: number;
  /// Local commits origin doesn't have.
  unpushed: number;
  /// Every commit on the branch is already in the trunk.
  inTrunk: boolean;
  /// In the trunk only because nothing was ever committed to it: its tip is a
  /// commit on the trunk's own line. A merged branch's tip is not. (A
  /// fast-forward merge reads as this too.) Absent from older answers.
  cutOnly?: boolean;
  /// Files changed but not committed in the work's worktree, when it is on
  /// disk — where a paused run keeps its work.
  uncommitted?: number;
  lastCommitAt?: number;
  lastSubject?: string;
}

/// One repo's branch that belongs to a piece of work — a workspace run makes
/// one per member repo, and a ticket's branches can be spread over several.
export interface RepoBranch {
  repo: string;
  branch: string;
  /// The run's worktree for this repo, while it is still on disk.
  worktreePath?: string;
}

export interface RepoGit extends RepoBranch {
  status: BranchStatus;
}

/// `landed`: no PR found, but git shows the branch's own commits in the trunk.
export type WorkStatus = 'merged' | 'landed' | 'pr-open' | 'pr-closed' | 'running' | 'done' | 'failed' | 'chat';

export interface WorkRecordRun {
  id: string;
  flowId?: string;
  flowName: string;
  title: string;
  at: number;
  /// Still in the renderer's run store, so it can be opened.
  retained: boolean;
  live: boolean;
  cwd?: string;
}

export interface WorkRecordChat {
  id: string;
  name: string;
  at: number;
  archived: boolean;
  sessionId?: string;
  /// An agent chat's own worktree, or one it borrowed from a run.
  worktreePath?: string;
}

export interface WorkRecordJob {
  orchestrationId: string;
  title: string;
  workerName?: string;
}

export interface WorkRecord {
  key: string;
  kind: WorkKind;
  title: string;
  placePath: string;
  placeName: string;
  branch?: string;
  startedAt: number;
  updatedAt: number;
  status: WorkStatus;
  pr?: WorkPr;
  /// The branch in git, when the record has one and a repo answered.
  git?: BranchStatus;
  /// Every repo branch the work may have used: a workspace run's members, and
  /// branches named for the record's ticket. Candidates — `repoGit` is the
  /// subset that was actually committed to.
  repoBranches: RepoBranch[];
  /// The repo branches with commits of their own, with where each stands.
  repoGit: RepoGit[];
  ticket?: string;
  headline?: string;
  summary?: string;
  runs: WorkRecordRun[];
  chats: WorkRecordChat[];
  jobs: WorkRecordJob[];
  /// Readable text the search and its snippets draw from.
  body: string;
}

export interface WorkPlace {
  path: string;
  name: string;
  /// Member repos of a workspace — a PR for the branch can live in any of them.
  memberPaths?: string[];
  conversations: Conversation[];
}

export interface BuildWorkRecordsInput {
  places: WorkPlace[];
  runs: FlowRun[];
  log: WorkLogEntry[];
  orchestrations: Orchestration[];
  prsByRepo: Record<string, WorkPr[]>;
  /// Keyed `${repoPath}::${branch}`, repo paths as the places spell them.
  branchStatus?: Record<string, BranchStatus>;
  /// Branches whose names carry a ticket key, by key (upper case).
  ticketBranches?: Record<string, RepoBranch[]>;
}

/// Branches that are never "the work" — sharing one is not a link.
const TRUNK = new Set(['main', 'master', 'develop', 'dev', 'trunk', 'head']);

export function isWorkBranch(branch: string | undefined | null): branch is string {
  return !!branch && !TRUNK.has(branch.toLowerCase());
}

function norm(p: string): string {
  return p.replace(/[\\/]+$/, '').toLowerCase();
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/// First line of a prompt, trimmed to something a row can show.
export function titleFromPrompt(prompt: string, max = 90): string {
  const line = prompt.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('[Attached file')) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/// Words that look like a ticket key next to a number but never are one.
const NOT_TICKET = new Set([
  'SHIFT', 'STEP', 'PHASE', 'ROUND', 'PART', 'DAY', 'WEEK', 'BATCH', 'RUN', 'ITEM',
  'FEAT', 'FEATURE', 'FIX', 'CHORE', 'CI', 'V', 'PR', 'RC', 'UTF', 'SHA', 'ISO',
]);

function ticketKey(text: string, anyCase: boolean): string | undefined {
  const re = anyCase ? /\b([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,6})\b/g : /\b([A-Z][A-Z0-9]{1,9})-(\d{1,6})\b/g;
  for (const m of text.matchAll(re)) {
    const prefix = m[1].toUpperCase();
    if (!NOT_TICKET.has(prefix) && /[A-Z]/.test(prefix)) return `${prefix}-${m[2]}`;
  }
  return undefined;
}

/// A ticket the work names: a Jira-style key, a GitHub issue URL, or
/// `closes #12`. Branch names are lower-cased by convention, so a key counts
/// there in any case; in prose it has to be written in capitals, or
/// "shift-25" and "step-2" would read as tickets.
export function extractTicket(branch: string | undefined, ...texts: Array<string | undefined>): string | undefined {
  if (branch) {
    const key = ticketKey(branch, true);
    if (key) return key;
  }
  for (const t of texts) {
    if (!t) continue;
    const url = t.match(/\/issues\/(\d+)/);
    if (url) return `#${url[1]}`;
    const key = ticketKey(t, false);
    if (key) return key;
    const hash = t.match(/\b(?:closes|fixes|resolves|issue)\s+#(\d+)/i);
    if (hash) return `#${hash[1]}`;
  }
  return undefined;
}

function findPlace(places: WorkPlace[], path: string): WorkPlace | undefined {
  return (
    places.find((p) => isSamePath(p.path, path)) ??
    places.find((p) => p.memberPaths?.some((m) => isSamePath(m, path)))
  );
}

function findPr(place: WorkPlace | undefined, placePath: string, branch: string, prsByRepo: Record<string, WorkPr[]>): WorkPr | undefined {
  const repos = [placePath, ...(place?.memberPaths ?? [])];
  const byNorm = new Map(Object.entries(prsByRepo).map(([k, v]) => [norm(k), v]));
  const found: WorkPr[] = [];
  for (const repo of repos) {
    for (const pr of byNorm.get(norm(repo)) ?? []) {
      if (pr.headRefName === branch) found.push(pr);
    }
  }
  // A branch reused after a closed PR: the merged or open one is the answer.
  const rank = (pr: WorkPr) => (pr.state === 'MERGED' ? 0 : pr.state === 'OPEN' ? 1 : 2);
  return found.sort((a, b) => rank(a) - rank(b) || b.number - a.number)[0];
}

/// In the trunk because it was merged, not because it was never committed
/// to. Git says so directly when it can (`cutOnly`); an older answer falls
/// back to "its last commit is newer than the work".
function mergedIn(s: BranchStatus, startedAt: number): boolean {
  if (!s.inTrunk || s.ahead > 0) return false;
  if (s.cutOnly !== undefined) return !s.cutOnly;
  return (s.lastCommitAt ?? 0) >= startedAt - 10 * 60_000;
}

function findBranchStatus(
  place: WorkPlace | undefined,
  placePath: string,
  branch: string,
  statuses: Record<string, BranchStatus> | undefined,
): BranchStatus | undefined {
  if (!statuses) return undefined;
  const repos = [placePath, ...(place?.memberPaths ?? [])];
  const found = repos.map((repo) => statuses[`${repo}::${branch}`]).filter((s): s is BranchStatus => !!s);
  // In a workspace the branch lives in whichever member it was made in.
  return found.find((s) => s.local || s.remote) ?? found[0];
}

/// A line on where the branch stands: "not pushed", "3 unpushed",
/// "2 ahead of main", "in main", "branch deleted".
export function gitSummary(g: BranchStatus | undefined): string | undefined {
  if (!g) return undefined;
  if (!g.local && !g.remote) return 'branch deleted';
  const trunk = g.trunk ?? 'trunk';
  const parts: string[] = [];
  if (g.uncommitted) parts.push(`${g.uncommitted} uncommitted file${g.uncommitted === 1 ? '' : 's'}`);
  if (g.inTrunk && g.ahead === 0 && g.cutOnly) {
    if (!g.uncommitted) parts.push('no commits yet');
    return parts.join(' · ') || undefined;
  }
  if (g.local && !g.remote) parts.push('not pushed');
  else if (g.unpushed > 0) parts.push(`${g.unpushed} unpushed`);
  if (g.inTrunk && g.ahead === 0) parts.push(`in ${trunk}`);
  else if (g.ahead > 0) parts.push(`${g.ahead} ahead of ${trunk}`);
  if (g.behind > 0 && !g.inTrunk) parts.push(`${g.behind} behind`);
  return parts.join(' · ') || undefined;
}

/// "3 repos · 2 pushed · 1 in master" — across a record's repo branches.
export function repoSummary(r: Pick<WorkRecord, 'repoGit'>): string | undefined {
  const g = r.repoGit;
  if (!g.length) return undefined;
  if (g.length === 1) {
    const one = gitSummary(g[0].status);
    return `${basename(g[0].repo)}${one ? ` · ${one}` : ''}`;
  }
  const trunk = g.find((x) => x.status.trunk)?.status.trunk ?? 'trunk';
  const uncommitted = g.filter((x) => (x.status.uncommitted ?? 0) > 0).length;
  const committed = g.filter((x) => x.status.ahead > 0 || (x.status.inTrunk && !x.status.cutOnly));
  const inTrunk = committed.filter((x) => x.status.inTrunk && x.status.ahead === 0).length;
  const notPushed = committed.filter((x) => x.status.local && (!x.status.remote || x.status.unpushed > 0)).length;
  const pushed = committed.length - notPushed - inTrunk;
  return [
    `${g.length} repos`,
    uncommitted > 0 ? `${uncommitted} uncommitted` : null,
    pushed > 0 ? `${pushed} pushed` : null,
    notPushed > 0 ? `${notPushed} not pushed` : null,
    inTrunk > 0 ? `${inTrunk} in ${trunk}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

interface Draft {
  key: string;
  placePath: string;
  branch?: string;
  titles: Array<{ text: string; weight: number }>;
  prompts: string[];
  headline?: string;
  summary?: string;
  startedAt: number;
  updatedAt: number;
  runs: Map<string, WorkRecordRun & { failed: boolean }>;
  chats: Map<string, WorkRecordChat>;
  jobs: WorkRecordJob[];
  repoBranches: Map<string, RepoBranch>;
  workerName?: string;
}

export function buildWorkRecords(input: BuildWorkRecordsInput): WorkRecord[] {
  const drafts = new Map<string, Draft>();
  const draftFor = (placePath: string, branch: string | undefined, soloKey: string, at: number): Draft => {
    const key = isWorkBranch(branch) ? `${norm(placePath)}::${branch}` : soloKey;
    let d = drafts.get(key);
    if (!d) {
      d = {
        key,
        placePath,
        branch: isWorkBranch(branch) ? branch : undefined,
        titles: [],
        prompts: [],
        startedAt: at,
        updatedAt: at,
        runs: new Map(),
        chats: new Map(),
        jobs: [],
        repoBranches: new Map(),
      };
      drafts.set(key, d);
    }
    d.startedAt = Math.min(d.startedAt, at);
    d.updatedAt = Math.max(d.updatedAt, at);
    return d;
  };

  // Batch items, indexed by run so a run lands in its batch's record even
  // after the worker shift renamed or deleted the branch.
  const jobByRun = new Map<string, { job: WorkRecordJob; branch?: string; title: string; prompt: string }>();
  for (const o of input.orchestrations) {
    const workerName = o.origin?.kind === 'worker' ? o.origin.workerName : undefined;
    for (const item of o.items) {
      if (!item.runId) continue;
      jobByRun.set(item.runId, {
        job: { orchestrationId: o.id, title: o.title, ...(workerName ? { workerName } : {}) },
        branch: item.branchName,
        title: item.candidate.title,
        prompt: item.candidate.prompt,
      });
    }
  }

  const participantConvs = new Set<string>();
  const seenRuns = new Set<string>();

  const addRun = (r: {
    id: string;
    flowId?: string;
    flowName: string;
    prompt: string;
    ownerPath: string;
    branch?: string;
    at: number;
    startedAt: number;
    live: boolean;
    failed: boolean;
    retained: boolean;
    headline?: string;
    summary?: string;
    cwd?: string;
    workerName?: string;
    repoBranches?: RepoBranch[];
  }) => {
    seenRuns.add(r.id);
    const job = jobByRun.get(r.id);
    const d = draftFor(r.ownerPath, r.branch ?? job?.branch, `run:${r.id}`, r.startedAt);
    d.updatedAt = Math.max(d.updatedAt, r.at);
    const title = job?.title || titleFromPrompt(r.prompt) || r.flowName;
    d.titles.push({ text: title, weight: job ? 3 : 2 });
    d.prompts.push(job?.prompt ?? r.prompt);
    if (r.headline && !d.headline) d.headline = r.headline;
    if (r.summary && !d.summary) d.summary = r.summary;
    if (job && !d.jobs.some((j) => j.orchestrationId === job.job.orchestrationId)) d.jobs.push(job.job);
    if (r.workerName ?? job?.job.workerName) d.workerName = r.workerName ?? job?.job.workerName;
    for (const rb of r.repoBranches ?? []) d.repoBranches.set(`${norm(rb.repo)}::${rb.branch}`, rb);
    d.runs.set(r.id, {
      id: r.id,
      ...(r.flowId ? { flowId: r.flowId } : {}),
      flowName: r.flowName,
      title,
      at: r.at,
      retained: r.retained,
      live: r.live,
      failed: r.failed,
      ...(r.cwd ? { cwd: r.cwd } : {}),
    });
  };

  for (const run of input.runs) {
    for (const id of Object.values(run.conversationIds ?? {})) participantConvs.add(id);
    const kind = run.state.kind;
    const live = kind !== 'done' && kind !== 'archived' && kind !== 'aborted';
    const last = run.attempts?.length ? run.attempts[run.attempts.length - 1] : undefined;
    addRun({
      id: run.id,
      flowId: run.flowId,
      flowName: run.flowSnapshot?.name ?? run.flowId,
      prompt: run.userPrompt ?? '',
      ownerPath: run.sourceProjectPath ?? run.projectPath,
      branch: run.branchName,
      startedAt: run.createdAt,
      at: last?.endedAt ?? last?.startedAt ?? run.createdAt,
      live,
      failed: kind === 'aborted',
      retained: true,
      headline: run.digest?.headline,
      summary: run.digest?.summary,
      cwd: run.worktreePath ?? run.projectPath,
      repoBranches: (run.workspaceWorktrees ?? [])
        .filter((w) => isWorkBranch(w.branchName))
        .map((w) => ({ repo: w.projectPath, branch: w.branchName, worktreePath: w.worktreePath })),
    });
  }

  for (const e of input.log) {
    if (seenRuns.has(e.runId)) continue;
    addRun({
      id: e.runId,
      ...(e.flowId ? { flowId: e.flowId } : {}),
      flowName: e.flowName,
      prompt: e.prompt || e.title,
      ownerPath: e.ownerPath,
      branch: e.branchName,
      startedAt: e.startedAt ?? e.at,
      at: e.at,
      live: false,
      failed: e.outcome === 'failed',
      retained: false,
      headline: e.headline,
      summary: e.summary,
      cwd: e.cwd,
      workerName: e.workerName,
      repoBranches: e.repoBranches,
    });
  }

  for (const place of input.places) {
    for (const c of place.conversations) {
      if (participantConvs.has(c.id)) continue;
      if (!c.turnCount) continue;
      const at = c.lastActiveAt ?? c.lastPromptAt ?? c.createdAt;
      // A chat in the main checkout has no branch of its own, but the branch
      // the checkout was on when it opened is the one it worked on — so it
      // joins that branch's record, and that branch's PR.
      const branch = c.branchName ?? (!c.worktreePath && isWorkBranch(c.baseBranch) ? c.baseBranch : undefined);
      const d = draftFor(place.path, branch, `chat:${c.id}`, c.createdAt);
      d.updatedAt = Math.max(d.updatedAt, at);
      d.titles.push({ text: c.name, weight: 1 });
      d.chats.set(c.id, {
        id: c.id,
        name: c.name,
        at,
        archived: !!c.hidden,
        ...(c.sessionId ? { sessionId: c.sessionId } : {}),
        ...(c.worktreePath ? { worktreePath: c.worktreePath } : {}),
      });
    }
  }

  const out: WorkRecord[] = [];
  for (const d of drafts.values()) {
    const place = findPlace(input.places, d.placePath);
    const pr = d.branch ? findPr(place, d.placePath, d.branch, input.prsByRepo) : undefined;
    const git = d.branch ? findBranchStatus(place, d.placePath, d.branch, input.branchStatus) : undefined;
    const ticketEarly = extractTicket(d.branch, ...d.prompts, ...d.titles.map((t) => t.text), pr?.title);
    // Branches named for the ticket, in any of the place's repos: work done
    // in a chat, by hand, or by a run long since evicted.
    const fromTicket = ticketEarly && /^[A-Z]/.test(ticketEarly) ? (input.ticketBranches?.[ticketEarly] ?? []) : [];
    for (const rb of fromTicket) {
      const k = `${norm(rb.repo)}::${rb.branch}`;
      if (!d.repoBranches.has(k)) d.repoBranches.set(k, rb);
    }
    const ticketKeys = new Set(fromTicket.map((rb) => `${norm(rb.repo)}::${rb.branch}`));
    const repoGit: RepoGit[] = [];
    for (const [k, rb] of d.repoBranches) {
      const status = input.branchStatus?.[`${rb.repo}::${rb.branch}`];
      if (!status) continue;
      // A workspace run cuts its branch in every member repo; only the ones
      // it committed to are part of the work. A branch named for the ticket
      // is part of it whenever it has anything on it.
      const touched =
        status.ahead > 0 ||
        status.unpushed > 0 ||
        (status.uncommitted ?? 0) > 0 ||
        (status.inTrunk && mergedIn(status, ticketKeys.has(k) ? 0 : d.startedAt));
      if (touched) repoGit.push({ ...rb, status });
    }
    repoGit.sort((a, b) => (b.status.lastCommitAt ?? 0) - (a.status.lastCommitAt ?? 0));
    const reposLanded = repoGit.length > 0 && repoGit.every((g) => g.status.inTrunk && g.status.ahead === 0);
    // Commits of its own in the trunk — not a branch cut and never committed
    // to, whose tip is an older trunk commit and so "in" the trunk too.
    const landed = !!git?.inTrunk && mergedIn(git, d.startedAt);
    const runs = [...d.runs.values()].sort((a, b) => a.at - b.at);
    const chats = [...d.chats.values()].sort((a, b) => a.at - b.at);
    const best = [...d.titles].sort((a, b) => b.weight - a.weight)[0]?.text;
    const title = pr?.title || best || d.branch || 'Untitled work';
    const status: WorkStatus = pr
      ? pr.state === 'MERGED'
        ? 'merged'
        : pr.state === 'OPEN'
          ? 'pr-open'
          : 'pr-closed'
      : landed || (!git && reposLanded)
        ? 'landed'
        : runs.some((r) => r.live)
        ? 'running'
        : runs.length
          ? runs[runs.length - 1].failed
            ? 'failed'
            : 'done'
          : 'chat';
    const kind: WorkKind = d.jobs.length ? 'batch' : runs.length ? 'run' : 'chat';
    const ticket = ticketEarly;
    const body = [
      title,
      d.headline,
      d.summary,
      ...d.prompts,
      ...chats.map((c) => c.name),
      ...runs.map((r) => r.flowName),
      ...d.jobs.map((j) => `${j.title} ${j.workerName ?? ''}`),
      d.branch,
      pr ? `PR #${pr.number} ${pr.title}` : undefined,
      ticket,
      place?.name ?? basename(d.placePath),
    ]
      .filter(Boolean)
      .join('\n');
    out.push({
      key: d.key,
      kind,
      title,
      placePath: place?.path ?? d.placePath,
      placeName: place?.name ?? basename(d.placePath),
      ...(d.branch ? { branch: d.branch } : {}),
      startedAt: d.startedAt,
      updatedAt: d.updatedAt,
      status,
      ...(pr ? { pr } : {}),
      ...(git ? { git } : {}),
      repoBranches: [...d.repoBranches.values()],
      repoGit,
      ...(ticket ? { ticket } : {}),
      ...(d.headline ? { headline: d.headline } : {}),
      ...(d.summary ? { summary: d.summary } : {}),
      runs: runs.map(({ failed: _f, ...r }) => r),
      chats,
      jobs: d.jobs,
      body,
    });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export interface WorkMatch {
  record: WorkRecord;
  /// Text around the first hit, split so the view can mark it.
  snippet?: { pre: string; hit: string; post: string };
  /// The hit came from something you typed inside a chat or run.
  fromTranscript?: boolean;
}

function snippetAround(text: string, words: string[], radius = 70): WorkMatch['snippet'] | undefined {
  const lower = text.toLowerCase();
  for (const w of words) {
    const at = lower.indexOf(w);
    if (at < 0) continue;
    const start = Math.max(0, at - radius);
    const end = Math.min(text.length, at + w.length + radius);
    const flat = (s: string) => s.replace(/\s+/g, ' ');
    return {
      pre: (start > 0 ? '…' : '') + flat(text.slice(start, at)),
      hit: text.slice(at, at + w.length),
      post: flat(text.slice(at + w.length, end)) + (end < text.length ? '…' : ''),
    };
  }
  return undefined;
}

export function queryWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/// Map prompt-search hits onto the records they belong to: a chat by its
/// session id, a run by the cwd its agents worked in.
export function transcriptHitsByRecord(records: WorkRecord[], hits: PromptHit[]): Map<string, PromptHit> {
  const bySession = new Map<string, string>();
  const byCwd: Array<{ cwd: string; key: string }> = [];
  for (const r of records) {
    for (const c of r.chats) if (c.sessionId) bySession.set(c.sessionId, r.key);
    for (const run of r.runs) {
      if (run.cwd && !isSamePath(run.cwd, r.placePath)) byCwd.push({ cwd: run.cwd, key: r.key });
    }
  }
  const out = new Map<string, PromptHit>();
  for (const h of hits) {
    const key =
      bySession.get(h.sessionId) ??
      byCwd.find((x) => isSamePath(x.cwd, h.cwd))?.key ??
      // A coordinator dir is named for the run: `…/coordinators/<runId>`.
      records.find((r) => r.runs.some((run) => h.cwd.endsWith(run.id)))?.key;
    if (key && !out.has(key)) out.set(key, h);
  }
  return out;
}

/// Every word must appear in the record (any field, any order) — or the
/// record must own a transcript that matched.
export function searchWorkRecords(
  records: WorkRecord[],
  query: string,
  transcriptHits: Map<string, PromptHit> = new Map(),
): WorkMatch[] {
  const words = queryWords(query);
  if (!words.length) return records.map((record) => ({ record }));
  const out: WorkMatch[] = [];
  for (const record of records) {
    const lower = record.body.toLowerCase();
    if (words.every((w) => lower.includes(w))) {
      out.push({ record, snippet: snippetAround(record.body, words) });
      continue;
    }
    const hit = transcriptHits.get(record.key);
    if (hit) out.push({ record, snippet: snippetAround(hit.snippet, words), fromTranscript: true });
  }
  return out;
}
