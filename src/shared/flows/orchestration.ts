// Orchestrator data model. An "orchestration" is a batch: the user asks an
// AI (with their MCPs) to produce a list of small, self-contained asks
// ("candidates"), maps each to a flow, and launches them — by default each
// child flow runs in its own git worktree, with a concurrency cap so they
// trickle rather than flood. A batch can instead run in the project's own
// working tree (`runIn: 'cwd'`), which trades that parallelism for working
// on the tree the user is actually looking at. The orchestration record is
// the ledger: it remembers where the batch came from (the producer
// conversation) and tracks each item from queued → running → done, linking
// out to the child FlowRun.
//
// Lives in `shared` so the main-process engine and the renderer store share
// one source of truth for the shapes that cross IPC.

import type { UUID } from '../types';
import type { WorkerMessageIntent } from './worker';

/// Where a run does its work: `cwd` = the project's own working tree,
/// `worktree` = a fresh git worktree forked from a base branch.
export type RunIn = 'cwd' | 'worktree';

/// One ask surfaced by the producer turn, before the user maps it to a
/// flow. The producer is instructed to end its reply with a
/// `<candidates>[…]</candidates>` block of these (minus the client-side
/// selection/override fields, which the UI layers on).
export interface Candidate {
  /// Stable id the producer assigns (e.g. the source ticket id, or a slug).
  /// Used as the React key and to dedup across refinement turns.
  id: string;
  /// Short human title — the headline of the ask.
  title: string;
  /// The actual prompt handed to the launched flow's first step. Self-
  /// contained: a flow run only sees this, not the producer conversation.
  prompt: string;
  /// Optional one-line context (source, votes, why it's small). Display only.
  note?: string;
  /// Optional rough size hint the producer may emit ('small' | 'medium').
  /// Display only — never gates anything.
  size?: 'small' | 'medium' | 'large';
  /// Optional flow id the producer SUGGESTS for this ask (it knows a docs
  /// tweak from a bugfix). The UI pre-selects it; the user overrides freely.
  suggestedFlowId?: string;
}

export type OrchestrationItemStatus =
  /// Produced by a scheduled producer turn and PARKED — not queued, not
  /// launched, waiting for a human to approve the batch. Distinct from
  /// `queued` precisely so it survives a restart: `queued` means "we already
  /// committed to launching this", which is why the loader settles those on
  /// boot, whereas a proposal has committed to nothing and costs nothing to
  /// keep. See `approveBatch` in main/flows/orchestrator.
  | 'proposed'
  /// Waiting for a concurrency slot — not yet launched.
  | 'queued'
  /// A child flow run is in flight (see `runId`).
  | 'running'
  /// The child flow hit a `pause_before` step and is waiting for the user to
  /// continue it (in the Flows tab). It does NOT hold a concurrency slot —
  /// the batch pumps the next queued item so a human checkpoint doesn't stall
  /// the whole batch. Transitions to `running` when resumed, then terminal.
  | 'paused'
  /// Child run finished successfully (its terminal state was `done`).
  | 'done'
  /// Child run ended in `aborted` (failure, user abort, or app restart).
  | 'failed'
  /// User removed it from the batch before it launched.
  | 'cancelled';

/// One launched (or about-to-be-launched) ask inside a batch. Carries its
/// own flow + base branch so a single batch can mix a docs flow, a bugfix
/// flow, etc. — the per-item mapping the Orchestrator tab is built around.
export interface OrchestrationItem {
  candidate: Candidate;
  /// Flow this item runs. Resolved from the per-item override or the batch
  /// default at launch time and frozen here.
  flowId: string;
  /// Base branch the item's worktree forks from (per-item override or batch
  /// default).
  baseBranch?: string;
  status: OrchestrationItemStatus;
  /// The child FlowRun once launched. Null while queued/cancelled.
  runId?: UUID;
  /// Mirror of the child run's worktree branch, copied on completion so the
  /// ledger can show/link it without holding the whole run.
  ///
  /// Display only — do NOT navigate by it. A flow that lands its work by
  /// branching off the scratch branch and then deleting it (what a worker
  /// shift does: commit, `git branch prometheus/<date>-<slug>`, remove the
  /// worktree) leaves this pointing at a ref that no longer resolves. Use
  /// `headSha` for that.
  branchName?: string;
  /// Tip commit of the item's work at the moment its run went terminal.
  ///
  /// The durable half of `branchName`. A commit id survives everything a
  /// branch name doesn't — the branch being renamed, deleted, or merged
  /// away — so `git branch --contains <headSha>` can still find wherever
  /// the work ended up long after the run itself was evicted. This is the
  /// ONLY link back to a finished item's code once `pruneOldRuns` has taken
  /// the run, which is why it is captured here on the item rather than left
  /// to be read off the run.
  ///
  /// Absent when the capture failed (a non-git cwd, or a branch AND worktree
  /// both already gone by the time the run reported terminal) and on every
  /// item that finished before this field existed.
  headSha?: string;
  /// Short status note (e.g. an error message when `failed`).
  note?: string;
  /// Set when a restart settled this item rather than a person or a run: a
  /// `queued` item is cancelled on boot because relaunching it would spend
  /// tokens with nobody present (see `settleItemOnLoad`).
  ///
  /// It exists because `cancelled` otherwise means "a human turned this
  /// down", and the worker journal reads it that way — as a rejection, which
  /// feeds the demotion streak. The engine's existing guard is the `approved`
  /// entry the item earned on its way to `queued`, and that holds for every
  /// item the fold saw; this makes the exemption a property of the item
  /// itself, so it survives a crash between queueing and the fold, and a
  /// journal that predates `approved` being written at all.
  settledByRestart?: boolean;
  startedAt?: number;
  finishedAt?: number;
}

export interface Orchestration {
  id: UUID;
  /// Human title for the batch — defaults to the producer prompt's gist.
  title: string;
  /// Project the batch's flows launch against (their worktrees fork from it).
  projectPath: string;
  /// Where each item's child run works. `worktree` (the default, and the
  /// value assumed by batches persisted before this field existed) forks a
  /// fresh worktree per item so they can run in parallel without colliding.
  /// `cwd` runs them straight in `projectPath`'s working tree — one repo, one
  /// checkout, so the batch is forced to `maxConcurrent: 1` and items run
  /// strictly one after another (see `startBatch`). Use it for work that has
  /// to see the tree as it actually is — uncommitted changes, untracked
  /// files, a local build — where a clean worktree would be the wrong input.
  runIn?: RunIn;
  /// Default base branch for items that don't override it. Ignored entirely
  /// when `runIn === 'cwd'` (nothing forks — the run uses whatever branch the
  /// working tree already has checked out).
  baseBranch?: string;
  /// Max items running at once. The `pump` never exceeds this. Always 1 for a
  /// `cwd` batch.
  maxConcurrent: number;
  items: OrchestrationItem[];
  /// Provenance: the producer turn that generated the candidates. We keep
  /// the user's ask + the assistant's prose reply so "why did I launch these"
  /// is answerable when the user comes back to the batch later.
  producer?: {
    prompt: string;
    reply: string;
  };
  /// Set when something other than the user produced this batch. A schedule
  /// batch normally arrives with every item `proposed` and does nothing until
  /// approved; `autoApprove` instead queues its first N items and parks the
  /// rest — see shared/flows/schedule.ts for the bound that N enforces. A
  /// worker batch is one shift's output: the worker's trust level decides the
  /// auto-launch prefix (see shared/flows/worker.ts, workerAutoApproveCap).
  origin?:
    | {
        kind: 'schedule';
        scheduleId: UUID;
        scheduleName: string;
      }
    | {
        kind: 'worker';
        workerId: UUID;
        workerName: string;
        /// Snapshot of the worker's explicit external-effects capability.
        /// Absent on older batches means false.
        allowExternalActions?: boolean;
        /// Which of a worker's two entry points produced this batch: its
        /// standing cadence (`shift`) or a one-off instruction the user typed
        /// (`errand`). Recorded rather than parsed back out of the batch title,
        /// which is display text. Absent on batches written before errands
        /// existed — read those as `shift`, which is what they were.
        task?: 'shift' | 'errand';
        /// How an errand was sent, back when the desk had an Ask/Create-work
        /// toggle. Never written any more — see `WorkerMessageIntent`. Absent
        /// reads as `'work'`, which is what every errand is now.
        intent?: WorkerMessageIntent;
        /// The raw instruction the user typed, for `task: 'errand'`. Kept
        /// because `producer.prompt` is the assembled planning prompt — job
        /// description, journal, rejections and all — which is the wrong thing
        /// to show back to the person who typed one sentence. This is what a
        /// worker's thread renders as your message, and what the activity row
        /// is titled with.
        errand?: string;
        /// Set when a COLLEAGUE sent this errand rather than the user — a
        /// worker that found something outside its own remit and handed it
        /// on. Absent means the user typed it, which is what every errand
        /// before delegation was.
        ///
        /// The receiver plans a delegated errand exactly like a typed one;
        /// this is provenance, not authority. It is what lets the desk say
        /// "from Chief of Staff" instead of implying you asked, and what
        /// stops the receiver delegating onward — referrals are one hop, so
        /// a batch carrying `from` never gets a roster block of its own.
        from?: { workerId: UUID; workerName: string };
      };
  createdAt: number;
  /// Set once every item has reached a terminal status (done/failed/cancelled).
  completedAt?: number;
}

/// A producer seed prompt the user has run before, offered as a one-click
/// starter in the Ask pane. Only FRESH asks are recorded — refinements
/// ("only the docs ones") are meaningless without their prior turn, so they
/// never become standalone entries. Global, not per-project: a good ask is
/// worth reusing across repos.
export interface RecentPrompt {
  /// The prompt text, trimmed.
  text: string;
  /// When it was last used (ms epoch) — drives newest-first ordering.
  lastUsedAt: number;
}

/// Pull the `<candidates>…</candidates>` JSON block out of a producer reply
/// and coerce it into Candidate[]. Tolerant by design — the model is told to
/// emit clean JSON, but we salvage common near-misses (a bare array with no
/// wrapper, trailing prose, missing ids) rather than throwing the whole turn
/// away. Returns [] when nothing parseable is found.
export function parseCandidates(reply: string): Candidate[] {
  const raw = extractCandidatesBlock(reply);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { candidates?: unknown }).candidates)
      ? (parsed as { candidates: unknown[] }).candidates
      : null;
  if (!arr) return [];
  const out: Candidate[] = [];
  const seen = new Set<string>();
  arr.forEach((entry, i) => {
    if (!entry || typeof entry !== 'object') return;
    const e = entry as Record<string, unknown>;
    const title = typeof e.title === 'string' ? e.title.trim() : '';
    const prompt =
      typeof e.prompt === 'string'
        ? e.prompt.trim()
        : typeof e.body === 'string'
          ? (e.body as string).trim()
          : '';
    if (!title && !prompt) return;
    let id = typeof e.id === 'string' && e.id.trim() ? e.id.trim() : `cand-${i + 1}`;
    while (seen.has(id)) id = `${id}-${i + 1}`;
    seen.add(id);
    const size =
      e.size === 'small' || e.size === 'medium' || e.size === 'large' ? e.size : undefined;
    out.push({
      id,
      title: title || prompt.slice(0, 60),
      prompt: prompt || title,
      note: typeof e.note === 'string' ? e.note.trim() || undefined : undefined,
      size,
      suggestedFlowId:
        typeof e.suggestedFlowId === 'string'
          ? e.suggestedFlowId.trim() || undefined
          : typeof e.flowId === 'string'
            ? (e.flowId as string).trim() || undefined
            : undefined,
    });
  });
  return out;
}

/// Find the candidates payload in a reply. Prefers the explicit
/// `<candidates>…</candidates>` wrapper; falls back to the first top-level
/// JSON array in the text so a model that forgets the wrapper still works.
function extractCandidatesBlock(reply: string): string | null {
  const tagged = reply.match(/<candidates>\s*([\s\S]*?)\s*<\/candidates>/i);
  if (tagged) return tagged[1].trim();
  // Fallback: a fenced ```json block.
  const fenced = reply.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/i);
  if (fenced) return fenced[1].trim();
  // Last resort: the first balanced top-level array in the text.
  const start = reply.indexOf('[');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < reply.length; i++) {
    const ch = reply[i];
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return reply.slice(start, i + 1);
    }
  }
  return null;
}

/// True once every item is in a terminal status — used to stamp
/// `completedAt` and to show the batch as finished. A `proposed` item is not
/// terminal (it hasn't started), so a parked batch never reads as complete.
export function isOrchestrationComplete(o: Orchestration): boolean {
  return o.items.every(
    (it) =>
      it.status === 'done' || it.status === 'failed' || it.status === 'cancelled',
  );
}

/// True while a batch is waiting on a human. Parked batches are the whole
/// point of a scheduled orchestration, so the UI needs a cheap predicate to
/// surface them ahead of finished ledgers.
export function isOrchestrationAwaitingApproval(o: Orchestration): boolean {
  return o.items.some((it) => it.status === 'proposed');
}

/// True when a batch has anything the run ledger can show. An item-less batch
/// launched nothing, so its ledger entry is a bare header with a "0/0 done"
/// count and no rows under it — and a roster of workers answering errands in
/// prose mints those faster than anyone clears them. The Orchestrator drops
/// them from the list; `ledgerBatches` is that filter plus the page's order.
export function hasLedgerRuns(o: Orchestration): boolean {
  return o.items.length > 0;
}

/// Every batch worth a row in the Orchestrator ledger, newest first.
///
/// Creation order is the ONLY ordering here. Floating parked batches to the
/// top reads well with five of them and badly with fifty: the list stops
/// being a timeline, and "what did my workers just do" — the question the
/// page is actually open for — can't be answered by looking at the top of it.
/// A batch waiting on approval is reached through the "needs you" filter in
/// the runs bar, which is exact where sort order was only suggestive.
export function ledgerBatches(orchestrations: Record<string, Orchestration>): Orchestration[] {
  return Object.values(orchestrations)
    .filter(hasLedgerRuns)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/// An item-less batch that no surface anywhere will ever show again — pure
/// residue, and the engine deletes it on sight rather than leave a record the
/// user has no way to clear.
///
/// A worker's is the exception, and the reason this isn't just
/// `items.length === 0`: an errand or shift that proposed nothing IS a turn on
/// that worker's desk, its prose answer sitting in `producer.reply`. Hidden
/// from the ledger, yes; deleted, never — that would silently eat half of
/// every worker conversation.
export function isResidueOrchestration(o: Orchestration): boolean {
  return o.items.length === 0 && o.origin?.kind !== 'worker';
}
