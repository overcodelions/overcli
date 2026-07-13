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
  branchName?: string;
  /// Short status note (e.g. an error message when `failed`).
  note?: string;
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
/// `completedAt` and to show the batch as finished.
export function isOrchestrationComplete(o: Orchestration): boolean {
  return o.items.every(
    (it) =>
      it.status === 'done' || it.status === 'failed' || it.status === 'cancelled',
  );
}
