// Worker engine — the main-process half of the Workers tab. A Worker is a
// standing persona with a job description; this engine is what makes it
// stand: one timer across every hired worker (the scheduler's pattern), and
// on each due shift a fresh PLANNING turn — job description + journal digest
// + "never re-propose what was rejected" — parked through the orchestrator
// under the worker's trust-level auto-launch cap.
//
// Three things it does NOT do, all on purpose:
//
//   1. It does not replay a frozen prompt. The shift prompt is rebuilt every
//      firing from the worker's journal, so the same worker asks a different
//      question every Monday.
//   2. It does not launch unattended beyond `workerAutoApproveCap` — zero on
//      probation. Trust is earned by explicit promotion and lost automatically
//      after WORKER_DEMOTE_REJECTION_STREAK consecutive rejections.
//   3. It does not run past its funding. Two ceilings, both checked before a
//      turn starts: the worker's own `budgetUSDPerMonth` cap, and its slice of
//      the shared monthly treasury, which is drawn in ROSTER ORDER — a worker
//      may spend only what is left after everyone above it is funded to its
//      cap (see src/shared/flows/treasury.ts). Either way shifts skip
//      (journaled, once a day) until the month rolls over.
//
// Verdict capture is a projection: every `orchestrationUpdate` for a batch
// with `origin.kind === 'worker'` is folded into the journal with
// deterministic entry ids, and the journal's idempotent append makes the
// fold safe to run on every event, restart, or replay.

import { randomUUID } from 'node:crypto';

import { isSafeIdSegment } from '../../shared/flows/safeId';
import type { Attachment, Backend, MainToRendererEvent, UUID } from '../../shared/types';
import type { Orchestration } from '../../shared/flows/orchestration';
import {
  evaluateSchedule,
  nextOccurrenceAfter,
  scheduleAnchor,
  type ScheduleTiming,
} from '../../shared/flows/schedule';
import {
  WORKER_DEMOTE_REJECTION_STREAK,
  WORKER_AUTO_RENDER_NEWEST,
  WORKER_FIRST_RUN_WINDOW_DAYS,
  WORKER_MAX_HANDOFFS_PER_TURN,
  canDelegate,
  computeWorkerScorecard,
  delegationTargets,
  demotedTrust,
  rejectionStreak,
  parseHandoffs,
  parseWorkerSubject,
  resolveHandoffTarget,
  rosterLine,
  stripHandoffs,
  stripWorkerSubject,
  validateWorker,
  workerAutoApproveCap,
  workerOrigin,
  WORKER_NOTE_MAX,
  type Worker,
  type WorkerErrandResult,
  type WorkerHandoff,
  type WorkerJournalEntry,
  type WorkerScorecard,
  type WorkerTrustLevel,
} from '../../shared/flows/worker';
import {
  DEFAULT_TREASURY_USD,
  allocateTreasury,
  describeFundingBlock,
  fundingFor,
  seedTreasury,
  validateTreasury,
  type Treasury,
  type TreasuryAllocation,
} from '../../shared/flows/treasury';
import {
  deleteWorker,
  loadAllWorkers,
  loadTreasury,
  saveTreasury,
  saveWorker,
} from './workersStore';
import {
  appendWorkerJournalEntry,
  clearWorkerJournal,
  deleteWorkerJournalEntries,
  digestWorkerJournal,
  hasWorkerJournalEntry,
  loadWorkerJournal,
  workerRejectedTitles,
} from './workerJournal';
import { loadRunSummaries, workerSpendByWorkerSince, workerSpendSince } from './runSummaryLog';
import {
  archiveWorkerFiles,
  clearWorkerFiles,
  deleteDeliverable,
  fileWorkerDeliverable,
  workerFilesDir,
} from './workerFiles';
import { publishDeliverableToProject } from './workerPublish';
import {
  WORKER_COMPACTION_KEEP_DAYS,
  compactionCutoff,
  isCompactionDue,
} from '../../shared/flows/workerCompaction';
import type { FlowWorkerQuestionRequest, FlowWorkerQuestionResult } from './runtime';
import { buildWorkerReport, type WorkerReport, type WorkerRunFact } from '../../shared/flows/workerReport';

/// Same bound as the scheduler: re-derive the nearest due time at least once
/// a minute so sleep/clock-steps can't strand a timer.
const MAX_TIMER_MS = 60_000;

/// How many journaled rejections ride along in the shift prompt. The hard
/// filter in parkProposal uses the full list; the prompt excerpt only has to
/// be big enough to steer the model away from re-treading old ground.
const PROMPT_REJECTED_LIMIT = 30;

/// How many referrals may sit unanswered on one colleague's desk at once,
/// from any number of senders. Without a cap a busy roster can pile an
/// unbounded queue of handoffs onto whichever worker keeps getting named.
const MAX_PENDING_REFERRALS = 3;

/// How many past errand exchanges ride along as conversation context, and how
/// much of each reply. Enough that a follow-up three turns later still lands;
/// bounded so the thread can't crowd out the job description and journal that
/// make the worker a persona rather than a chat window.
const ERRAND_THREAD_TURNS = 6;
const ERRAND_THREAD_REPLY_CHARS = 2000;
/// A filename, or one of the two keywords. Long enough for any name the
/// filer produces, short enough that the field can't be used as storage.
const WORKER_AUTO_RENDER_MAX = 200;

/// The slice of the orchestrator a worker shift drives. `parkProposal` runs
/// the producer turn and records the batch; `get`/`list` let the engine fold
/// batch state into the journal.
export interface WorkerParker {
  parkProposal(args: {
    origin?: Orchestration['origin'];
    projectPath: string;
    prompt: string;
    flowId: string;
    runIn: 'cwd' | 'worktree';
    baseBranch?: string;
    maxConcurrent: number;
    title?: string;
    autoApprove?: { maxItems: number };
    model?: string;
    /// Backend `model` was chosen for, when the worker recorded one.
    backend?: Backend;
    maxItems?: number;
    excludeTitles?: string[];
    allowedFlowIds?: string[];
    priorPrompt?: string;
    priorReply?: string;
    priorTurns?: Array<{ prompt: string; reply: string }>;
    attachments?: Attachment[];
  }): Promise<
    | { ok: true; orchestrationId: UUID; count: number; queued: number; excluded: number }
    | { ok: false; error: string }
  >;
  get(id: UUID): Orchestration | null;
  list(): Orchestration[];
}

export interface WorkerEngineDeps {
  parker: WorkerParker;
  isGitRepo: (projectPath: string) => boolean;
  emit: (event: MainToRendererEvent) => void;
  notify: (args: { title: string; body: string }) => void;
  now?: () => number;
  timers?: {
    set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clear: (handle: ReturnType<typeof setTimeout>) => void;
  };
  store?: {
    loadAll: () => Worker[];
    save: (w: Worker) => void;
    remove: (id: string) => void;
  };
  journal?: {
    append: (entry: WorkerJournalEntry) => boolean;
    load: (workerId: string) => WorkerJournalEntry[];
    has: (entryId: string) => boolean;
    rejectedTitles: (workerId: string) => string[];
    digest: (workerId: string) => string;
    clear: (workerId: string) => number;
    /// Drop the entries one turn wrote, leaving the rest of the memory.
    remove: (workerId: string, match: { orchestrationId?: string; ids?: string[] }) => number;
  };
  /// Run spend for a worker since `sinceMs`, from the run-summary log.
  spend?: (workerId: string, sinceMs: number) => number;
  /// The same rollup for the whole roster in one pass. The treasury has to
  /// price every worker to answer for any one of them, so it never uses
  /// `spend` — that would re-read the log once per head.
  spendAll?: (sinceMs: number) => Map<string, number>;
  /// Every terminal run's cost/token/time record. Injected so the report is
  /// testable without the on-disk summary log.
  runFacts?: () => WorkerRunFact[];
  treasuryStore?: {
    load: () => Treasury | null;
    save: (t: Treasury) => void;
  };
  /// Draft a read-only flow for one errand, file it in the generated bucket,
  /// and launch it — the third triage path, for asks that need real
  /// investigation and fit none of the worker's flows.
  ///
  /// One dep rather than three because it spans the drafter, flow storage and
  /// the orchestrator, none of which the engine should reach into itself; and
  /// it is optional so the engine still runs (declining path 3 honestly) in a
  /// build where flow drafting isn't wired.
  generatedFlow?: (args: {
    worker: Worker;
    errand: string;
    /// The `<flow_request>` body: what the flow must do, in the worker's words.
    request: string;
    runIn: 'cwd' | 'worktree';
  }) => Promise<
    { ok: true; orchestrationId: UUID; flowId: string } | { ok: false; error: string }
  >;
  /// A finished run's final artifact, so the engine can file it under the
  /// worker. The engine has no handle on the runtime, and it needs one here
  /// because run artifacts are pruned with the run — copying the deliverable
  /// out at completion is the only thing that outlives that.
  ///
  /// Entries carry either the recorded output (`body`) or a path to a file
  /// the run wrote itself (`sourcePath`), which is copied instead of read.
  deliverablesFor?: (runId: UUID) => Array<{ name: string; body?: string; sourcePath?: string }>;
  /// Save a version of an everyday project after this worker has filed
  /// something into it. Optional and fire-and-forget: the delivery has
  /// already happened, and a checkpoint that fails must not take the journal
  /// fold down with it.
  checkpoint?: (args: { projectPath: string; message: string }) => void;
  /// Permanently remove this worker's shift/errand ledgers and their child
  /// flow runs. Main wires this across the orchestrator + runtime; keeping it
  /// as one dependency lets the worker reset stay the single owner of what
  /// "start fresh" means without coupling this engine to either store.
  clearActivity?: (workerId: UUID) => { shifts: number; errands: number; runs: number };
  /// The same removal for ONE batch: forget the ledger and delete the flow
  /// runs it launched. Split from `clearActivity` rather than generalised
  /// because the whole-worker reset counts shifts and errands for its
  /// confirmation line and this one already knows which it removed.
  deleteActivity?: (workerId: UUID, orchestrationId: UUID) => { runs: number };
  /// One read-only model turn used when a participant asks its standing
  /// Worker for a decision. Main owns backend selection and RunnerManager;
  /// the engine owns persona, journal context, and answer/escalation policy.
  supervisorTurn?: (args: {
    worker: Worker;
    prompt: string;
    cwd: string;
  }) => Promise<{ ok: true; text: string } | { ok: false; error: string }>;
}

export class WorkerEngine {
  private workers = new Map<UUID, Worker>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private ticking = false;
  /// Workers with a shift's planning turn in flight. One shift at a time per
  /// worker — a producer turn can take minutes, and a second one against the
  /// same journal would propose the same things twice.
  private firing = new Set<UUID>();
  /// Referrals currently in flight per receiver id, so one colleague can't be
  /// buried under an unbounded queue of handoffs. See `MAX_PENDING_REFERRALS`.
  private pendingReferrals = new Map<string, number>();
  /// One promise chain per worker, so errands sent while the worker is mid-turn
  /// WAIT rather than bounce. A worker can only hold one planning turn at a
  /// time — they share a journal, a budget gate and cadence bookkeeping — but
  /// that is a reason to make you wait, not a reason to refuse something you
  /// typed. Shifts keep the old behaviour and skip when busy: a missed shift
  /// comes round again on the next tick, and a queue of them would mean a
  /// worker that fell behind catching up all night.
  private queue = new Map<UUID, Promise<unknown>>();

  private readonly now: () => number;
  private readonly timers: NonNullable<WorkerEngineDeps['timers']>;
  private readonly store: NonNullable<WorkerEngineDeps['store']>;
  private readonly journal: NonNullable<WorkerEngineDeps['journal']>;
  private readonly spend: NonNullable<WorkerEngineDeps['spend']>;
  private readonly spendAll: NonNullable<WorkerEngineDeps['spendAll']>;
  private readonly treasuryStore: NonNullable<WorkerEngineDeps['treasuryStore']>;
  /// Replaced in `start()` by the persisted pool, or by a seed seeded from the
  /// existing caps. The literal here only covers the window before that.
  private pool: Treasury = { monthlyUSD: DEFAULT_TREASURY_USD };
  /// The day the pool-exhausted notification last went out. One notice for the
  /// whole roster, not one per starved worker — the pool running dry is a
  /// single fact about your month, and six copies of it is how a user learns
  /// to ignore notifications. Not persisted: a restart re-notifying once is
  /// better than a stale key suppressing the only warning.
  private poolNoticeDay: string | null = null;

  constructor(private deps: WorkerEngineDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.timers = deps.timers ?? { set: setTimeout, clear: clearTimeout };
    this.store = deps.store ?? {
      loadAll: loadAllWorkers,
      save: saveWorker,
      remove: deleteWorker,
    };
    this.journal = deps.journal ?? {
      append: appendWorkerJournalEntry,
      load: loadWorkerJournal,
      has: hasWorkerJournalEntry,
      rejectedTitles: workerRejectedTitles,
      digest: digestWorkerJournal,
      clear: clearWorkerJournal,
      remove: deleteWorkerJournalEntries,
    };
    this.spend = deps.spend ?? workerSpendSince;
    this.spendAll = deps.spendAll ?? workerSpendByWorkerSince;
    this.treasuryStore = deps.treasuryStore ?? { load: loadTreasury, save: saveTreasury };
  }

  /// Load persisted workers, reconcile batches that settled while the app was
  /// closed into the journal, and arm the timer. Called once at wiring time.
  start(): void {
    for (const w of this.store.loadAll()) this.workers.set(w.id, w);
    // An install that predates the treasury gets a pool equal to what it was
    // already committed to — the sum of its caps. Written back immediately so
    // the seed is a decision on disk rather than one recomputed (differently)
    // after the next hire.
    const stored = this.treasuryStore.load();
    this.pool = stored ?? seedTreasury([...this.workers.values()]);
    if (!stored) this.treasuryStore.save(this.pool);
    // Batches settle on load (running → failed, queued → cancelled) without
    // emitting, so fold every worker batch's current state in now — appends
    // are idempotent, so this re-fold costs nothing when nothing changed.
    for (const o of this.deps.parker.list()) {
      if (o.origin?.kind === 'worker') this.syncOrchestration(o);
    }
    this.arm();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) this.timers.clear(this.timer);
    this.timer = null;
  }

  // ---- READS ------------------------------------------------------------

  list(): Array<{ worker: Worker; nextShiftAt: number | null; scorecard: WorkerScorecard }> {
    return [...this.workers.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((w) => this.snapshot(w));
  }

  /// Ids only. `list()` builds a scorecard per worker — two whole-file log
  /// reads each — which is far too much for a caller that just needs ids.
  workerIds(): UUID[] {
    return [...this.workers.keys()];
  }

  get(id: UUID): Worker | null {
    return this.workers.get(id) ?? null;
  }

  journalFor(id: UUID): WorkerJournalEntry[] {
    return this.journal.load(id);
  }

  /// Answer a question raised by one of this Worker's child flow steps.
  /// Serialized through the same per-worker queue as shifts and errands so
  /// the persona never takes two contradictory planning turns at once.
  answerFlowQuestion(request: FlowWorkerQuestionRequest): Promise<FlowWorkerQuestionResult> {
    return this.enqueue(request.workerId, async () => {
      const worker = this.workers.get(request.workerId);
      if (!worker) return { kind: 'error', error: 'The owning Worker no longer exists.' };
      if (!this.deps.supervisorTurn) {
        return { kind: 'error', error: 'Worker supervision is not available in this build.' };
      }

      const prompt = this.buildFlowQuestionPrompt(worker, request);
      const result = await this.deps.supervisorTurn({
        worker,
        prompt,
        cwd: request.projectPath || worker.projectPath,
      });
      if (!result.ok) return { kind: 'error', error: result.error };

      const escalation = taggedBody(result.text, 'escalate');
      if (escalation) return { kind: 'escalate', reason: escalation };
      const answer = taggedBody(result.text, 'worker_answer') ?? result.text.trim();
      if (!answer) return { kind: 'error', error: 'The Worker returned an empty answer.' };
      return { kind: 'answer', answer };
    });
  }

  nextShiftAt(id: UUID): number | null {
    const w = this.workers.get(id);
    if (!w || !w.enabled) return null;
    const timing = this.timing(w);
    return nextOccurrenceAfter(timing.trigger, scheduleAnchor(timing));
  }

  /// The pool and the funding waterfall it produces, priced against this
  /// month's spend. Derived on every call for the same reason the scorecard
  /// is: a cached allocation and the run-summary log would eventually
  /// disagree, and the one that gates spending has to be the true one.
  treasury(): { treasury: Treasury; allocation: TreasuryAllocation } {
    return { treasury: { ...this.pool }, allocation: this.allocate(this.now()) };
  }

  /// The roster's report card for the window starting at `sinceMs` (0 = all time).
  report(sinceMs: number): WorkerReport {
    return buildWorkerReport({
      workers: [...this.workers.values()],
      journal: (id) => this.journal.load(id),
      orchestrations: this.deps.parker.list(),
      runs: (this.deps.runFacts ?? loadRunSummaries)(),
      sinceMs: Math.max(0, sinceMs),
      generatedAt: this.now(),
    });
  }

  private allocate(now: number): TreasuryAllocation {
    const spend = this.spendAll(monthStart(now));
    return allocateTreasury(
      [...this.workers.values()],
      (id) => spend.get(id) ?? 0,
      this.pool.monthlyUSD,
      [...spend.values()].reduce((t, s) => t + Math.max(0, s), 0),
    );
  }

  // ---- WRITES -----------------------------------------------------------

  /// Hire (no `id`) or update (with `id`). Every hire starts on probation —
  /// trust is not part of the application form. Edits keep the existing trust
  /// (promotion/demotion go through `setTrust`, an explicit act).
  /// Write the roster's order. Takes the full list of ids so the result is
  /// what the user sees rather than a delta — every id present gets an
  /// explicit position, and anything omitted keeps whatever it had.
  reorder(ids: string[]): { ok: true } {
    ids.forEach((id, index) => {
      const w = this.workers.get(id);
      if (!w || w.order === index) return;
      w.order = index;
      saveWorker(w);
      this.emitWorker(w);
    });
    // Order IS the funding queue, so a reorder re-prices everyone — including
    // the workers that did not move, which is the whole point of moving one.
    this.emitTreasury();
    return { ok: true };
  }

  /// Set the monthly pool. The only number in this feature the user types
  /// that is not about one worker.
  setTreasury(monthlyUSD: number): { ok: true } | { ok: false; error: string } {
    const invalid = validateTreasury(monthlyUSD);
    if (invalid) return { ok: false, error: invalid };
    if (this.pool.monthlyUSD === monthlyUSD) return { ok: true };
    this.pool = { monthlyUSD };
    this.treasuryStore.save(this.pool);
    // Raising the pool can un-starve a worker that has been skipping shifts,
    // and its next cadence slot should not have to arrive before it notices.
    this.poolNoticeDay = null;
    this.emitTreasury();
    return { ok: true };
  }

  save(
    input: Omit<Worker, 'id' | 'createdAt' | 'trust'> & { id?: UUID; trust?: WorkerTrustLevel },
  ): { ok: true; worker: Worker } | { ok: false; error: string } {
    const existing = input.id ? this.workers.get(input.id) : undefined;
    if (input.id !== undefined && !isSafeIdSegment(input.id)) {
      return { ok: false, error: `Unsafe worker id: ${input.id}` };
    }
    const now = this.now();
    const trust: WorkerTrustLevel = existing?.trust ?? 'probation';

    const candidate: Worker = {
      ...(existing ?? { createdAt: now }),
      ...input,
      id: existing?.id ?? input.id ?? randomUUID(),
      createdAt: existing?.createdAt ?? now,
      trust,
      // Bookkeeping survives an edit — renaming a worker must not restart
      // its shift numbering or forget when it last worked.
      shiftCount: existing?.shiftCount,
      lastShiftAt: existing?.lastShiftAt,
      // Survives even a cadence edit, which DOES clear `lastShiftAt` below:
      // re-anchoring when the worker next runs is a scheduling decision, and
      // it must not tell the worker it has never looked at the project.
      lastPlannedAt: existing?.lastPlannedAt,
      lastCompactedAt: existing?.lastCompactedAt,
    };
    // A non-autonomous worker may not run in the working copy; repair rather
    // than reject, since trust wasn't the caller's to choose here.
    if (candidate.trust !== 'autonomous' && candidate.caps.runIn === 'cwd') {
      candidate.caps = { ...candidate.caps, runIn: 'worktree' };
    }
    // Drop handoff targets that are gone or have moved to another project.
    // They are already unreachable — `delegationTargets` re-checks both — so
    // this is only about not carrying a list that says something the roster
    // no longer supports. An emptied list falls back to "every colleague",
    // which is what an absent one means, and the editor shows that in words:
    // the alternative reading, "delegates to nobody", would switch the
    // feature off silently the day the one chosen colleague was deleted.
    if (candidate.delegatesTo) {
      const reachable = candidate.delegatesTo.filter((id) => {
        const t = this.workers.get(id);
        return !!t && t.id !== candidate.id && t.projectPath === candidate.projectPath;
      });
      candidate.delegatesTo = reachable.length > 0 ? reachable : undefined;
    }
    const invalid = validateWorker(candidate);
    if (invalid) return { ok: false, error: invalid };

    // Re-anchor when the cadence changed or the worker was re-enabled, so an
    // edit against a stale anchor can't fire the moment it saves.
    const cadenceChanged =
      !existing || JSON.stringify(existing.cadence) !== JSON.stringify(candidate.cadence);
    const reEnabled = !!existing && !existing.enabled && candidate.enabled;
    if (cadenceChanged || reEnabled) {
      candidate.anchorAt = now;
      candidate.lastShiftAt = undefined;
    }

    this.workers.set(candidate.id, candidate);
    this.persistAndEmit(candidate);
    this.arm();
    return { ok: true, worker: candidate };
  }

  setEnabled(id: UUID, enabled: boolean): { ok: true } | { ok: false; error: string } {
    const w = this.workers.get(id);
    if (!w) return { ok: false, error: 'Worker not found.' };
    if (w.enabled === enabled) return { ok: true };
    w.enabled = enabled;
    // Re-enabling restarts the clock — a worker paused for a week is not owed
    // a shift the moment it's unpaused.
    if (enabled) {
      w.anchorAt = this.now();
      w.lastShiftAt = undefined;
    }
    this.persistAndEmit(w);
    this.arm();
    return { ok: true };
  }

  /// Pick which of the worker's own outputs opens when you select it.
  ///
  /// Its own act rather than a field on `save`, for the same reason pausing
  /// is: this is a preference about looking at the worker, and routing it
  /// through the contract editor would make "show me the dashboard" a
  /// re-validation of the job description, the cadence and the budget.
  setAutoRender(id: UUID, autoRender: string): { ok: true } | { ok: false; error: string } {
    const w = this.workers.get(id);
    if (!w) return { ok: false, error: 'Worker not found.' };
    const next = (autoRender ?? '').trim();
    if (!next) return { ok: false, error: 'Pick what to render.' };
    if (next.length > WORKER_AUTO_RENDER_MAX) return { ok: false, error: 'That name is too long.' };
    if ((w.autoRender ?? WORKER_AUTO_RENDER_NEWEST) === next) return { ok: true };
    w.autoRender = next;
    this.persistAndEmit(w);
    return { ok: true };
  }

  /// Write a note against one of this worker's turns.
  ///
  /// Deliberately a journal entry rather than a UI annotation: the journal
  /// digest is what a worker reads before planning, so a note left on a shift
  /// is the one way to tell a standing persona something without editing the
  /// job description — which is the wrong instrument, because it is about
  /// this piece of work rather than about the job.
  ///
  /// Not idempotent by content: two identical notes on the same turn are two
  /// things the user chose to say, so the id carries the timestamp rather
  /// than hashing the text.
  note(
    id: UUID,
    orchestrationId: string,
    note: string,
  ): { ok: true } | { ok: false; error: string } {
    const w = this.workers.get(id);
    if (!w) return { ok: false, error: 'Worker not found.' };
    const owner = this.deps.parker.get(orchestrationId);
    if (!owner) return { ok: false, error: 'That turn is already gone.' };
    if (owner.origin?.kind !== 'worker' || owner.origin.workerId !== id) {
      return { ok: false, error: 'That turn belongs to a different worker.' };
    }
    const text = (note ?? '').trim();
    if (!text) return { ok: false, error: 'Write the note first.' };
    if (text.length > WORKER_NOTE_MAX) {
      return { ok: false, error: `A note is at most ${WORKER_NOTE_MAX} characters.` };
    }
    const at = this.now();
    const wrote = this.journal.append({
      id: `note-${w.id}-${at}`,
      workerId: w.id,
      kind: 'note',
      at,
      title: '',
      note: text,
      orchestrationId,
    });
    // No persistAndEmit: nothing on the worker record changed. The desk
    // re-reads the journal, which is where the note actually lives.
    if (!wrote) return { ok: false, error: "Couldn't save that note." };
    return { ok: true };
  }

  /// The explicit promote/demote act. Demoting below autonomous flips a cwd
  /// worker back to worktrees — the working copy is an autonomous privilege.
  setTrust(id: UUID, trust: WorkerTrustLevel): { ok: true } | { ok: false; error: string } {
    const w = this.workers.get(id);
    if (!w) return { ok: false, error: 'Worker not found.' };
    if (w.trust === trust) return { ok: true };
    w.trust = trust;
    if (trust !== 'autonomous' && w.caps.runIn === 'cwd') {
      w.caps = { ...w.caps, runIn: 'worktree' };
    }
    this.persistAndEmit(w);
    return { ok: true };
  }

  remove(id: UUID): { ok: true } | { ok: false; error: string } {
    const w = this.workers.get(id);
    if (!w) return { ok: false, error: 'Worker not found.' };
    // Firing a worker removes the persona, not its output: parked batches and
    // launched runs stay, exactly like deleting a schedule. The journal stays
    // on disk too — rehiring under the same id would remember.
    this.workers.delete(id);
    this.store.remove(id);
    this.deps.emit({ type: 'workerDeleted', id });
    // Firing someone releases whatever it was still holding to everyone below.
    this.emitTreasury();
    this.arm();
    return { ok: true };
  }

  /// Return this worker to the state it was in immediately after hiring: no
  /// journal, files, shifts, errands, or child runs, and shift numbering back
  /// at #1. "Start fresh" used to clear only the journal unless a second
  /// checkbox was noticed, while leaving every activity row behind; that was a
  /// memory reset wearing a clean-slate label.
  ///
  /// Trust and budget are untouched: both are the user's standing decisions
  /// about this worker, not things the worker learned. Historical spend also
  /// remains in the usage ledger so resetting cannot mint a fresh allowance.
  resetMemory(id: UUID):
    | { ok: true; entries: number; files: number; shifts: number; errands: number; runs: number }
    | { ok: false; error: string } {
    const w = this.workers.get(id);
    if (!w) return { ok: false, error: 'Worker not found.' };
    if (this.firing.has(id)) {
      // A planning turn in flight is about to journal against the shift number
      // we are resetting, so it would write the old life into the new one.
      return { ok: false, error: 'This worker is mid-shift. Wait for it to finish, then reset.' };
    }
    // The journal rewrite is the retry-safe step: it either lands or throws
    // having changed nothing. File deletion is irreversible, so it goes
    // second — a failed reset must not have already destroyed the output it
    // reports as untouched.
    let entries = 0;
    try {
      entries = this.journal.clear(id);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    const cleared = clearWorkerFiles(id);
    if (!cleared.ok) return { ok: false, error: cleared.error };
    const files = cleared.removed;

    const activity = this.deps.clearActivity?.(id) ?? { shifts: 0, errands: 0, runs: 0 };

    w.shiftCount = undefined;
    w.lastShiftAt = undefined;
    w.lastPlannedAt = undefined;
    // Re-anchor, or a worker whose cadence came due while it still had a
    // memory would fire the instant the reset lands.
    w.anchorAt = this.now();
    this.persistAndEmit(w);
    this.arm();
    return { ok: true, entries, files, ...activity };
  }

  /// Rub out ONE turn — a shift or an errand — and everything it left behind:
  /// its ledger, the flow runs it launched, the output those runs filed, and
  /// its journal entries. The whole-worker version of this is `resetMemory`;
  /// this is the same act scoped to a single line of history, for the case
  /// where one shift went wrong and the other fifty were fine.
  ///
  /// When the turn is the worker's MOST RECENT shift, shift numbering is
  /// handed back too, so the next shift is #N again rather than #N+1 with a
  /// hole where N used to be. `lastPlannedAt` rewinds with it: that anchor is
  /// what the prompt states as "your previous shift ran at", and leaving it on
  /// a shift that no longer exists would make the redo skip the window the
  /// deleted shift was supposed to cover.
  ///
  /// CADENCE is deliberately untouched. Deleting history is not a statement
  /// about the clock, and rewinding `lastShiftAt` would make the worker fire
  /// again by itself the moment the delete landed — a surprise unattended run
  /// as the result of a cleanup. Re-running is `redoShift`, which is a click.
  forgetActivity(
    id: UUID,
    orchestrationId: UUID,
  ):
    | { ok: true; task: 'shift' | 'errand'; label: string; entries: number; files: number; runs: number; shiftGivenBack: number | null }
    | { ok: false; error: string } {
    const w = this.workers.get(id);
    if (!w) return { ok: false, error: 'Worker not found.' };
    if (this.firing.has(id)) {
      // A planning turn in flight is about to journal against the shift number
      // this may be handing back — it would write the old turn into the new one.
      return { ok: false, error: 'This worker is mid-shift. Wait for it to finish, then try again.' };
    }
    const o = this.deps.parker.get(orchestrationId);
    if (!o) return { ok: false, error: 'That turn is already gone.' };
    if (o.origin?.kind !== 'worker' || o.origin.workerId !== id) {
      return { ok: false, error: 'That turn belongs to a different worker.' };
    }
    const task = o.origin.task === 'errand' ? 'errand' : 'shift';
    const number = shiftNumberOf(o.title);
    const label = task === 'shift' && number !== null ? `Shift ${number}` : 'that errand';

    // Journal first, for the same reason `resetMemory` does it first: the
    // rewrite either lands or throws having changed nothing, while deleting
    // files and runs is irreversible. A failed delete must not have already
    // destroyed the output it is about to report as untouched.
    let entries = 0;
    try {
      entries = this.journal.remove(id, {
        orchestrationId,
        // A shift whose planning turn FAILED journals a note with no batch id
        // on it (there was no batch to stamp). It shares the number, so the
        // redo's own note would be swallowed by idempotent append.
        ids: number === null ? [] : [`shift-${id}-${number}`],
      });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    // The filed copies, addressed exactly as the filing addressed them. Only
    // finished items filed anything.
    let files = 0;
    for (const item of o.items) {
      if (item.status !== 'done' || !item.finishedAt) continue;
      files += deleteDeliverable({
        workerId: id,
        task,
        label: o.title,
        title: item.candidate.title,
        at: item.finishedAt,
      }).removed;
    }

    const { runs } = this.deps.deleteActivity?.(id, orchestrationId) ?? { runs: 0 };

    // Hand the number back only if this WAS the last shift. Rewinding a hole
    // in the middle would renumber nothing and collide with everything after.
    let shiftGivenBack: number | null = null;
    if (task === 'shift' && number !== null && (w.shiftCount ?? 0) === number) {
      shiftGivenBack = number;
      w.shiftCount = number > 1 ? number - 1 : undefined;
      // `load` is newest-first and the deleted entries are already gone, so
      // the first shift note left is the one this shift followed.
      const previous = this.journal.load(id).find((e) => e.kind === 'shift' && !!e.orchestrationId);
      w.lastPlannedAt = previous?.at;
    }
    this.persistAndEmit(w);
    return { ok: true, task, label, entries, files, runs, shiftGivenBack };
  }

  /// Work the shift again from the state it started in: forget what it did,
  /// give the number back, then fire a fresh planning turn that lands as the
  /// same shift number over the same window.
  ///
  /// Only the LATEST shift. Re-running an older one could not give its number
  /// back (see `forgetActivity`), so it would delete Shift 3 and produce
  /// Shift 12 — which is not a re-run, it is a delete and a new shift wearing
  /// a confusing label. Refusing says so instead of quietly doing that.
  async redoShift(
    id: UUID,
    orchestrationId: UUID,
  ): Promise<{ ok: true; shift: number } | { ok: false; error: string }> {
    const w = this.workers.get(id);
    if (!w) return { ok: false, error: 'Worker not found.' };
    const o = this.deps.parker.get(orchestrationId);
    if (!o) return { ok: false, error: 'That shift is already gone.' };
    if (o.origin?.kind !== 'worker' || o.origin.workerId !== id) {
      return { ok: false, error: 'That shift belongs to a different worker.' };
    }
    if (o.origin.task === 'errand') {
      return { ok: false, error: 'That was an errand — send it again rather than re-running it.' };
    }
    const number = shiftNumberOf(o.title);
    if (number === null || (w.shiftCount ?? 0) !== number) {
      return {
        ok: false,
        error: 'Only the most recent shift can be re-run — an older one cannot have its number back.',
      };
    }
    if (this.firing.has(id)) {
      return { ok: false, error: 'This worker is mid-shift. Wait for it to finish, then try again.' };
    }
    const allocation = this.allocate(this.now());
    const funding = fundingFor(allocation, id);
    if (funding && !funding.funded) {
      return { ok: false, error: describeFundingBlock(funding, allocation) };
    }
    const forgotten = this.forgetActivity(id, orchestrationId);
    if (!forgotten.ok) return forgotten;
    // Manual, so the re-run does not stamp cadence: the clock has already had
    // this shift, and the point here is to do the work again, not to move on.
    const res = await this.fire(this.workers.get(id) ?? w, { manual: true });
    if (!res.ok) return res;
    return { ok: true, shift: number };
  }

  /// Archive the filed work this worker has stopped needing, once a week,
  /// before the shift that would otherwise read all of it. Deliberately no
  /// model turn: the point is to make the next shift cheaper, and paying a
  /// summariser to do it would spend more than it saves.
  ///
  /// Only the FILES are compacted. The journal is left alone on purpose — its
  /// digest is already bounded (`WORKER_JOURNAL_DIGEST_LIMIT`), so folding it
  /// would not shrink a single prompt, while `syncOrchestration` derives
  /// meaning from an entry's ABSENCE and would misread the gaps.
  ///
  /// Only reached from `tick()`, which only runs while at least one worker is
  /// enabled — a fully paused roster never compacts. That is the right
  /// trade-off (nothing is running, so nothing needs to be made cheaper), but
  /// it means the weekly cadence is conditional, not a hard guarantee.
  private compactIfDue(w: Worker): void {
    const now = this.now();
    if (!isCompactionDue(w.lastCompactedAt, now)) return;
    const { moved } = archiveWorkerFiles(w.id, compactionCutoff(now));
    // Stamped even when nothing moved, so a quiet worker is not re-checked
    // every minute for the rest of the week.
    w.lastCompactedAt = now;
    this.persistAndEmit(w);
    if (moved === 0) return;
    this.journal.append({
      id: `compacted-${w.id}-${dayKey(now)}`,
      workerId: w.id,
      kind: 'compacted',
      at: now,
      title: '',
      note: `Weekly compaction: archived ${moved} older ${moved === 1 ? 'file' : 'files'}.`,
    });
  }

  /// Work one shift right now, out of band — the "will this do what I think"
  /// button. Advances the shift number but not the cadence.
  async workShiftNow(id: UUID): Promise<{ ok: true } | { ok: false; error: string }> {
    const w = this.workers.get(id);
    if (!w) return { ok: false, error: 'Worker not found.' };
    if (this.firing.has(id)) return { ok: false, error: 'A shift is already starting.' };
    const res = await this.fire(w, { manual: true });
    this.arm();
    return res.ok ? { ok: true } : res;
  }

  /// Hand this worker a one-off instruction. An errand is planned through the
  /// standing job description rather than re-running the usual shift, and it
  /// deliberately leaves cadence and shift numbering alone.
  async runErrand(
    id: UUID,
    instruction: string,
    attachments?: Attachment[],
  ): Promise<{ ok: true; result: WorkerErrandResult } | { ok: false; error: string }> {
    const w = this.workers.get(id);
    if (!w) return { ok: false, error: 'Worker not found.' };
    const errand = instruction.trim();
    if (!errand) return { ok: false, error: 'Type what you want this worker to do.' };
    // Behind whatever this worker is already doing, and behind any errand sent
    // before it — a desk you can leave a note on, in the order the notes were
    // left. `this.workers.get` is re-read inside, because the wait can be
    // minutes and the worker may have been edited meanwhile.
    const res = await this.fire(w, { manual: true, errand, attachments });
    this.arm();
    if (!res.ok) return res;
    if (!res.errand) return { ok: false, error: 'The errand produced no result.' };
    return { ok: true, result: res.errand };
  }

  // ---- EVENTS -----------------------------------------------------------

  /// Tapped into the main emit chain. Folds worker-batch changes into the
  /// journal; ignores everything else (including its own workerUpdate
  /// emissions, so there is no recursion).
  observeEvent(event: MainToRendererEvent): void {
    if (event.type !== 'orchestrationUpdate') return;
    if (event.orchestration.origin?.kind !== 'worker') return;
    this.syncOrchestration(event.orchestration);
  }

  // ---- FIRING -----------------------------------------------------------

  private timing(w: Worker): ScheduleTiming {
    return {
      enabled: w.enabled,
      trigger: w.cadence,
      // A due shift while the previous one is still planning is skipped, not
      // queued — the next occurrence re-plans against a fresher journal
      // anyway, so a deferred replay would only duplicate it.
      onOverlap: 'skip',
      catchUp: 'skip',
      createdAt: w.createdAt,
      anchorAt: w.anchorAt,
      lastFiredAt: w.lastShiftAt,
      pendingSince: undefined,
    };
  }

  private arm(): void {
    if (this.disposed) return;
    if (this.timer) this.timers.clear(this.timer);
    this.timer = null;

    const now = this.now();
    let soonest = Number.POSITIVE_INFINITY;
    for (const w of this.workers.values()) {
      const decision = evaluateSchedule(this.timing(w), now, { busy: this.firing.has(w.id) });
      if (decision.action === 'fire') {
        soonest = now;
        break;
      }
      if (decision.action === 'wait') soonest = Math.min(soonest, decision.at);
      else soonest = Math.min(soonest, decision.nextAt);
    }
    if (!Number.isFinite(soonest)) return; // nobody hired/enabled — no timer
    const delay = Math.max(0, Math.min(soonest - now, MAX_TIMER_MS));
    this.timer = this.timers.set(() => void this.tick(), delay);
  }

  private async tick(): Promise<void> {
    if (this.disposed || this.ticking) return;
    this.ticking = true;
    try {
      // Iterate ids and RE-FETCH each worker: an earlier iteration's planning
      // turn can hold this loop for minutes, long enough for the user to edit
      // (or fire) a later worker. Evaluating a pre-edit snapshot would fire
      // on a cadence the user just changed — and then persist the stale
      // object over their edit. Same reasoning for taking `now` fresh per
      // iteration instead of once for a loop that can span minutes.
      for (const id of [...this.workers.keys()]) {
        const w = this.workers.get(id);
        if (!w) continue;
        if (this.firing.has(id)) continue;
        this.compactIfDue(w);
        const now = this.now();
        const decision = evaluateSchedule(this.timing(w), now, { busy: false });
        if (decision.action === 'wait') continue;
        if (decision.action === 'skip') {
          // Missed while the app was closed. Journal it honestly (idempotent
          // per missed occurrence) and move the anchor past it, or the next
          // tick would skip the same slot again.
          this.journal.append({
            id: `shift-missed-${w.id}-${decision.dueAt}`,
            workerId: w.id,
            kind: 'shift',
            at: now,
            title: '',
            note: `Missed a shift — ${decision.reason}`,
          });
          w.anchorAt = now;
          w.lastShiftAt = undefined;
          this.persistAndEmit(w);
          continue;
        }
        await this.fire(w, {});
      }
    } finally {
      this.ticking = false;
      this.arm();
    }
  }

  /// Run `task` after everything already queued for this worker. The chain
  /// continues through failures — one errand that threw must not strand every
  /// errand behind it.
  private enqueue<T>(id: UUID, task: () => Promise<T>): Promise<T> {
    const prior = this.queue.get(id) ?? Promise.resolve();
    const next = prior.then(task, task);
    // Stored separately from what the caller awaits: the caller wants the
    // rejection, the chain must not carry it forward as an unhandled one.
    this.queue.set(
      id,
      next.catch(() => undefined),
    );
    return next;
  }

  /// Every turn a worker takes goes through here, one at a time. The queue is
  /// what makes an errand sent mid-shift WAIT instead of bouncing off the
  /// `firing` guard — that guard stays as the scheduler's "is this worker
  /// busy" signal (a scheduled shift still SKIPS rather than piling up), but
  /// nothing a person typed is refused for being second in line.
  private async fire(
    w: Worker,
    opts: {
      manual?: boolean;
      errand?: string;
      attachments?: Attachment[];
      from?: { workerId: UUID; workerName: string };
    },
  ): Promise<{ ok: true; errand?: WorkerErrandResult } | { ok: false; error: string }> {
    return this.enqueue(w.id, async () => {
      // The wait can be minutes; the worker may have been edited meanwhile.
      const fresh = this.workers.get(w.id) ?? w;
      if (this.firing.has(fresh.id)) return { ok: false, error: 'A shift is already starting.' };
      this.firing.add(fresh.id);
      try {
        return await this.fireInner(fresh, opts);
      } finally {
        this.firing.delete(fresh.id);
      }
    });
  }

  private async fireInner(
    w: Worker,
    opts: {
      manual?: boolean;
      errand?: string;
      attachments?: Attachment[];
      from?: { workerId: UUID; workerName: string };
    },
  ): Promise<{ ok: true; errand?: WorkerErrandResult } | { ok: false; error: string }> {
    const now = this.now();

    // Funding gate. Both ceilings at once, priced per calendar month against
    // the run-summary log — the same numbers the Usage page shows. A worker
    // stops at its own cap, and it also stops when the shared pool has been
    // claimed by everyone above it on the roster.
    const allocation = this.allocate(now);
    const funding = fundingFor(allocation, w.id);
    if (funding && !funding.funded) {
      const message = describeFundingBlock(funding, allocation);
      if (opts.manual) return { ok: false, error: message };
      // Journaled at most once a day, so an every-15-minutes cadence doesn't
      // write 96 identical lines. Keyed by WHICH ceiling stopped it, so a
      // worker squeezed out by the pool in the morning and stopped by its own
      // cap that afternoon leaves both facts on its desk rather than one.
      // The cadence still advances: a defunded worker waits for the month, it
      // doesn't pile up missed occurrences.
      const wrote = this.journal.append({
        id: `shift-${funding.blocked}-${w.id}-${dayKey(now)}`,
        workerId: w.id,
        kind: 'shift',
        at: now,
        title: '',
        note: message,
      });
      // One notification per day for the pool no matter how many workers it
      // starves; per worker for a cap, which is one worker's own business.
      if (funding.blocked === 'pool') {
        if (this.poolNoticeDay !== dayKey(now)) {
          this.poolNoticeDay = dayKey(now);
          const starved = allocation.byWorker.filter((f) => f.blocked === 'pool');
          this.deps.notify({
            title: 'The monthly worker pool is spent',
            body:
              starved.length === 1
                ? `${w.name} has no funds left this month. Raise the pool or reprioritize the roster.`
                : `${starved.length} workers have no funds left this month, starting with ${w.name}. Raise the pool or reprioritize the roster.`,
          });
        }
      } else if (wrote) {
        this.deps.notify({ title: `${w.name} is out of budget`, body: message });
      }
      w.lastShiftAt = now;
      this.persistAndEmit(w);
      return { ok: true };
    }

    // Errands share the firing guard and budget gate, but they are not shifts:
    // never stamp cadence bookkeeping before their planning turn.
    if (opts.errand)
      return await this.fireErrand(w, opts.errand, opts.attachments, opts.from);

    // Stamp BEFORE awaiting the planning turn — it can run for minutes, long
    // enough for another tick to read a stale lastShiftAt and double-fire.
    const sequence = (w.shiftCount ?? 0) + 1;
    w.shiftCount = sequence;
    if (!opts.manual) w.lastShiftAt = now;
    // Read before overwriting — the prompt states the PREVIOUS turn's time,
    // which is the window a worker pulling data has to catch up on. A manual
    // shift still counts as looking at the project, so it stamps too.
    const previousPlannedAt = w.lastPlannedAt;
    w.lastPlannedAt = now;
    this.persistAndEmit(w);

    const rejected = this.journal.rejectedTitles(w.id);
    const runIn = this.effectiveRunIn(w);
    const autoCap = workerAutoApproveCap(w);

    // The planning turn can run for minutes; tell the renderer the shift is
    // live so the row shows work happening instead of nothing. Cleared in
    // the finally so a thrown park can't leave a row spinning forever.
    this.deps.emit({ type: 'workerShiftProgress', workerId: w.id, active: true, task: 'shift' });
    let res: Awaited<ReturnType<WorkerParker['parkProposal']>>;
    try {
      res = await this.parkShift(w, sequence, runIn, autoCap, rejected, previousPlannedAt);
    } finally {
      this.deps.emit({ type: 'workerShiftProgress', workerId: w.id, active: false, task: 'shift' });
    }

    // The planning turn ran for a while — the user may have edited the
    // worker meanwhile, replacing the map object. Journal entries key on the
    // id and are fine; everything user-facing from here uses the CURRENT
    // record so a finishing shift can't emit or echo a stale one.
    const fresh = this.workers.get(w.id) ?? w;

    if (!res.ok) {
      this.journal.append({
        id: `shift-${w.id}-${sequence}`,
        workerId: w.id,
        kind: 'shift',
        at: this.now(),
        title: `Shift ${sequence}`,
        note: `Failed: ${res.error}`,
      });
      this.emitWorker(fresh);
      this.deps.notify({ title: `${fresh.name}'s shift failed`, body: res.error });
      return { ok: false, error: res.error };
    }

    // Before the shift note, so what it says about referrals is part of the
    // one line the desk shows for this shift rather than a second row.
    const handoffs = this.dispatchHandoffs(
      fresh,
      this.deps.parker.get(res.orchestrationId)?.producer?.reply ?? '',
      res.count,
      this.now(),
      res.orchestrationId,
    );
    this.journal.append({
      id: `shift-${w.id}-${sequence}`,
      workerId: w.id,
      kind: 'shift',
      at: this.now(),
      title: `Shift ${sequence}`,
      note: [describeShift(res.count, res.queued, res.excluded), handoffs]
        .filter(Boolean)
        .join(' '),
      orchestrationId: res.orchestrationId,
    });
    this.emitWorker(fresh);
    this.deps.notify({
      title: `${fresh.name} worked a shift`,
      body: describeShiftNotification(res.count, res.queued, res.excluded),
    });
    return { ok: true };
  }

  private parkShift(
    w: Worker,
    sequence: number,
    runIn: 'cwd' | 'worktree',
    autoCap: number,
    rejected: string[],
    previousPlannedAt?: number,
  ): ReturnType<WorkerParker['parkProposal']> {
    return this.deps.parker.parkProposal({
      origin: workerOrigin(w, 'shift'),
      projectPath: w.projectPath,
      prompt: this.buildShiftPrompt(w, sequence, rejected, previousPlannedAt),
      flowId: w.flowIds[0],
      runIn,
      maxConcurrent: Math.min(w.caps.maxItemsPerShift, 4),
      title: `[Shift ${sequence}] ${w.name}`,
      autoApprove: autoCap > 0 ? { maxItems: autoCap } : undefined,
      model: w.heartbeatModel,
      backend: w.heartbeatBackend,
      maxItems: w.caps.maxItemsPerShift,
      excludeTitles: rejected,
      // The planner may route a candidate to any flow ON THE CONTRACT, but a
      // hallucinated flow id falls back to the primary — under autoApprove a
      // free choice would be an unattended launch into unvetted machinery.
      allowedFlowIds: w.flowIds,
    });
  }

  private async fireErrand(
    w: Worker,
    errand: string,
    attachments?: Attachment[],
    from?: { workerId: UUID; workerName: string },
  ): Promise<{ ok: true; errand: WorkerErrandResult } | { ok: false; error: string }> {
    const at = this.now();
    const rejected = this.journal.rejectedTitles(w.id);
    const runIn = this.effectiveRunIn(w);
    const autoCap = workerAutoApproveCap(w);
    // Calculate before awaiting the planner: tests and fast callers can share
    // a frozen clock, and journal append is intentionally idempotent.
    const entryId = this.errandEntryId(w.id, at);
    const priorTurns = this.priorErrandTurns(w.id);

    this.deps.emit({ type: 'workerShiftProgress', workerId: w.id, active: true, task: 'errand' });
    let res: Awaited<ReturnType<WorkerParker['parkProposal']>>;
    try {
      res = await this.deps.parker.parkProposal({
        origin: workerOrigin(w, 'errand', errand, from),
        projectPath: w.projectPath,
        prompt: this.buildErrandPrompt(w, errand, rejected, from),
        ...(priorTurns.length > 0 ? { priorTurns } : {}),
        attachments,
        flowId: w.flowIds[0],
        runIn,
        maxConcurrent: Math.min(w.caps.maxItemsPerShift, 4),
        title: `[Errand] ${errandLabel(errand)}`,
        autoApprove: autoCap > 0 ? { maxItems: autoCap } : undefined,
        model: w.heartbeatModel,
        backend: w.heartbeatBackend,
        maxItems: w.caps.maxItemsPerShift,
        excludeTitles: rejected,
        allowedFlowIds: w.flowIds,
      });
    } finally {
      this.deps.emit({ type: 'workerShiftProgress', workerId: w.id, active: false, task: 'errand' });
    }

    const fresh = this.workers.get(w.id) ?? w;
    if (!res.ok) {
      this.journal.append({
        id: entryId,
        workerId: w.id,
        kind: 'errand',
        at,
        title: errandLabel(errand),
        note: `Failed: ${res.error}`,
      });
      this.emitWorker(fresh);
      this.deps.notify({ title: `${fresh.name}'s errand failed`, body: res.error });
      return { ok: false, error: res.error };
    }

    const batch = this.deps.parker.get(res.orchestrationId);
    const rawReply = batch?.producer?.reply ?? '';
    const reply = errandReply(rawReply);
    // What the worker decided to call this. Falls back to the raw ask, which
    // is what every errand was called before — a worker that skips the tag
    // must not end up with an unnamed row.
    const subject = parseWorkerSubject(rawReply) ?? errandLabel(errand);
    // A delegated errand never gets a roster block, so it should never emit a
    // handoff; guarding on `from` as well means a turn that invented one
    // anyway cannot bounce the parcel onward.
    const handoffs = from ? '' : this.dispatchHandoffs(fresh, rawReply, res.count, at, res.orchestrationId);
    // Path 3: the worker judged the errand too big for a prose answer and
    // found nothing on its contract that fits, so it asked for machinery. Only
    // honored when it proposed nothing — a turn that did both is confused, and
    // the candidates it did produce are the safer half to act on.
    const request = res.count === 0 ? parseFlowRequest(rawReply) : null;
    if (request && this.deps.generatedFlow) {
      const built = await this.deps.generatedFlow({ worker: w, errand, request, runIn });
      if (built.ok) {
        this.journal.append({
          id: entryId,
          workerId: w.id,
          kind: 'errand',
          at,
          title: subject,
          note: `Drafted a flow to answer this — ${built.flowId}. ${reply} ${handoffs}`.trim(),
          orchestrationId: built.orchestrationId,
        });
        this.emitWorker(fresh);
        this.deps.notify({
          title: `${fresh.name} is investigating`,
          body: `Built a flow to answer "${subject}".`,
        });
        return {
          ok: true,
          errand: {
            orchestrationId: built.orchestrationId,
            count: 1,
            queued: 1,
            launchedNothing: false,
            reply,
          },
        };
      }
      // Drafting or launching failed. Fall through and report the errand as
      // the empty batch it actually is, with the failure in the note — a
      // silent downgrade to "nothing launched" would hide a broken drafter.
      this.journal.append({
        id: entryId,
        workerId: w.id,
        kind: 'errand',
        at,
        title: subject,
        note: `Wanted a flow to answer this, but building it failed: ${built.error}`,
        orchestrationId: res.orchestrationId,
      });
      this.emitWorker(fresh);
      this.deps.notify({ title: `${fresh.name} could not build a flow`, body: built.error });
      return { ok: false, error: built.error };
    }
    const launchedNothing = res.count === 0;
    this.journal.append({
      id: entryId,
      workerId: w.id,
      kind: 'errand',
      at,
      title: subject,
      note: [
        launchedNothing
          ? `Nothing launched — ${reply || 'the worker proposed nothing.'}`
          : describeShift(res.count, res.queued, res.excluded),
        handoffs,
      ]
        .filter(Boolean)
        .join(' '),
      orchestrationId: res.orchestrationId,
    });
    this.emitWorker(fresh);
    this.deps.notify({
      title: `${fresh.name} finished an errand`,
      body: launchedNothing
        ? reply || 'Nothing proposed.'
        : describeShiftNotification(res.count, res.queued, res.excluded),
    });
    return {
      ok: true,
      errand: {
        orchestrationId: res.orchestrationId,
        count: res.count,
        queued: res.queued,
        launchedNothing,
        reply,
      },
    };
  }

  /// The planning turn's user request (the producer system prompt rides in
  /// front of it — see orchestrator.propose). Rebuilt from the journal every
  /// shift: this is the difference between a worker and a saved prompt.
  private buildShiftPrompt(
    w: Worker,
    sequence: number,
    rejected: string[],
    previousPlannedAt?: number,
  ): string {
    const digest = this.journal.digest(w.id);
    const parts = [
      `You are "${w.name}", a standing worker on this project. This is your shift #${sequence}.`,
      '',
      ...this.clockBlock(previousPlannedAt),
      '',
      'YOUR JOB DESCRIPTION',
      w.jobDescription,
      '',
      'YOUR JOURNAL (newest first — what you already proposed and how it was received):',
      digest || '(first shift — no journal yet)',
      ...this.filesBlock(w),
      ...this.contextBlock(),
      ...this.delegationBlock(w),
    ];
    if (rejected.length > 0) {
      parts.push(
        '',
        'REJECTED BEFORE — do NOT propose these again, or anything that is essentially the same ask:',
        ...rejected.slice(0, PROMPT_REJECTED_LIMIT).map((t) => `  - ${t}`),
      );
    }
    parts.push(
      '',
      'Plan THIS shift: investigate the project as it stands right now and decide what the most',
      `valuable version of your job is today. Propose at most ${w.caps.maxItemsPerShift} candidates, best first.`,
      'Skip anything your journal shows was already done or is still in flight. If nothing worth',
      'doing has appeared since your last shift, say so and emit an empty candidates list —',
      'an honest empty shift beats makework.',
    );
    return parts.join('\n');
  }

  private buildFlowQuestionPrompt(worker: Worker, request: FlowWorkerQuestionRequest): string {
    const artifacts = request.artifacts.length > 0
      ? request.artifacts
          .map(
            (artifact) =>
              `<artifact name="${artifact.name}" from="${artifact.producedByStepId}">\n` +
              `${artifact.body}\n</artifact>`,
          )
          .join('\n\n')
      : '(no earlier artifacts)';
    return [
      `You are "${worker.name}", the standing Worker who owns this flow run.`,
      '',
      'YOUR JOB DESCRIPTION',
      worker.jobDescription,
      '',
      'YOUR JOURNAL (newest first)',
      this.journal.digest(worker.id) || '(no journal yet)',
      '',
      'THE RUN',
      `Flow: ${request.flowName}`,
      request.runTitle ? `Run: ${request.runTitle}` : '',
      `Original request: ${request.userPrompt}`,
      `Current step: ${request.step.id} (${request.step.role})`,
      request.step.systemPromptOverride
        ? `Step instructions: ${request.step.systemPromptOverride}`
        : '',
      '',
      'EARLIER ARTIFACTS',
      artifacts,
      '',
      'THE FLOW IS ASKING YOU',
      request.question,
      '',
      'Answer as the responsible owner. Make reasonable product, technical, and editorial',
      'decisions yourself. Local file/code edits and tests are already authorized and are not a',
      'reason to escalate. Do not perform any action in this turn; give the participant the',
      'decision it needs. If the answer requires private human knowledge, credentials, or approval',
      'for an external action, emit <escalate>one concise reason and what input is needed</escalate>.',
      'Otherwise emit <worker_answer>your direct, actionable answer</worker_answer>.',
      'Return exactly one of those tags and no commentary outside it.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  /// The user's one-off ask, bounded by the worker's standing job rather than
  /// treated as a free-standing prompt.

  /// When this shift is, and when the last one was. Without it a worker cannot
  /// express "since last time" at all: the journal digest is day-granular, so a
  /// worker on a 15-minute cadence sees the same date on every entry and cannot
  /// tell its own shifts apart. Stated as full ISO timestamps because that is
  /// what a query filter wants.
  private clockBlock(previousPlannedAt?: number): string[] {
    const nowISO = new Date(this.now()).toISOString();
    return [
      'THE CLOCK',
      `This shift started at ${nowISO}.`,
      previousPlannedAt !== undefined
        ? `Your previous shift planned at ${new Date(previousPlannedAt).toISOString()} — that is the` +
          ' window to catch up on for anything you track over time.'
        : 'You have never worked a shift before, so nothing has been covered yet.',
    ];
  }

  /// The worker's own directory, stated in every planning turn. A worker with
  /// nowhere to put anything can only ever answer in prose that scrolls away;
  /// with a directory it can leave a baseline for its next shift to diff
  /// against, keep a tally across weeks, and file the report it was asked for.
  private filesBlock(w: Worker): string[] {
    const dir = workerFilesDir(w.id);
    return [
      '',
      'YOUR FILES',
      `You have a directory of your own at: ${dir}`,
      'It persists between shifts and errands, and nobody else writes to it. Read',
      'what you left there before deciding what to do, and write anything a future',
      'shift will need — a baseline to compare against, a running tally, notes on',
      'what you already checked. Use ordinary absolute paths; it is outside the',
      'project, so nothing you put there touches the repository. Create it if it',
      'does not exist yet.',
      `Work you FILED more than ${WORKER_COMPACTION_KEEP_DAYS} days ago is moved into an`,
      '`archive/` subfolder once a week. Notes and baselines you wrote yourself are never',
      'moved. Do not read `archive/` unless you specifically need something old.',
      '',
      'WHERE FLOW OUTPUTS GO',
      'Every flow you launch runs in a disposable worktree/run root. Candidate',
      'instructions must use relative output paths inside that run — never tell a',
      `flow to create, edit, overwrite, move, or delete anything under the persistent`,
      `project/workspace path ${w.projectPath}. It may read that source when needed.`,
      'Do NOT paste that absolute path into a candidate prompt, not even as a place',
      'to avoid. Write "save it to a relative path inside this run" and stop there —',
      'the runtime already tells every step the source is read-only.',
      'Overcli files completed loose reports into your private directory automatically;',
      'publishing into the persistent workspace is not part of a worker shift or errand.',
      '',
      'PICKING UP WHERE YOU LEFT OFF',
      'If your job means gathering the same kind of thing shift after shift, do not',
      'gather it all again every time. Keep a cursor in `cursor.json` in that',
      'directory: read it first and cover only what is new since the mark it holds;',
      `if it is missing, this is your first pass — cover the last ${WORKER_FIRST_RUN_WINDOW_DAYS} days.`,
      'Write the new mark LAST, only once the gathering actually succeeded, and keep',
      'the mark it replaces beside it — a half-finished shift that moves the cursor',
      'forward silently loses the window it skipped, which is worse than doing the',
      'work twice. Your journal above is how you check: if it shows your last pass',
      'failed, treat the mark as suspect and resume from the one it replaced.',
    ];
  }

  /// Context discipline, stated in every turn a worker takes.
  ///
  /// Workers reliably rediscover this on their own — a shift hits a sweep
  /// whose payload dwarfs the answer, delegates it, and files a note so the
  /// next one starts ahead. That rediscovery is the fragile part: it depends
  /// on the shift both learning the lesson and remembering to write it down,
  /// and a note that lands in a filed report rather than a self-written one
  /// is in `archive/` two weeks later, behind an instruction not to read it.
  /// Six lines here cost nothing per turn and start every worker where the
  /// best one ended up.
  ///
  /// Deliberately not compaction. Compaction summarises what already entered
  /// the window, so it pays for the bulk first and then discards the detail;
  /// keeping the bulk out entirely is strictly cheaper, and only the shift
  /// standing in front of the call knows which one it is about to make.
  private contextBlock(): string[] {
    return [
      '',
      'KEEPING YOUR CONTEXT FOR THE WORK',
      'Some of what you need to look at is far bigger than the answer you want out',
      'of it — paginated sweeps, long listings, records whose descriptions dwarf the',
      'field you actually care about. Read those through a subagent and ask it for',
      'only the summary you need. Reading them yourself spends the window you still',
      'need for deciding, and you cannot get it back. Judge this BEFORE you make the',
      'call: once the payload is in front of you, the cost is already paid.',
    ];
  }

  /// The roster block, and the permission to use it.
  ///
  /// Present only for a worker that may actually delegate, because it is not
  /// free: eleven colleagues is eleven lines of prompt in every planning turn,
  /// and a worker with no business commissioning anyone should not be spending
  /// that or thinking about it. Absent, the existing "say who should do it
  /// instead" instruction still stands — a worker without the roster names an
  /// owner for you to route by hand, which is what every worker did before.
  private delegationBlock(w: Worker): string[] {
    if (!canDelegate(w)) return [];
    const targets = delegationTargets(w, this.roster());
    if (targets.length === 0) return [];
    const handedOff = this.handedOffTitles(w.id);
    const parts = [
      '',
      'YOUR COLLEAGUES',
      'Other standing workers on this project. They have their own job descriptions,',
      'their own flows and their own budgets; you cannot see their work and they',
      'cannot see yours.',
      ...targets.slice(0, PROMPT_REJECTED_LIMIT).map((t) => `  - ${rosterLine(t)}`),
      '',
      'HANDING WORK OVER',
      'When your work turns up something real that is plainly one of THEIR jobs and not',
      'yours, hand it over instead of dropping it or doing it badly. End your reply with:',
      '',
      '     <handoff to="Exact Colleague Name">',
      '     The errand, written to them: what you found, what you want done, and every',
      '     reference they need to act on it. They cannot see your reply, your files or',
      '     your journal — only this text — so a handoff that says "the ticket above" is',
      '     a handoff they cannot action.',
      '     </handoff>',
      '',
      `At most ${WORKER_MAX_HANDOFFS_PER_TURN} per turn, and they count against your item budget for this turn.`,
      'Use the name exactly as written above; a name that matches nobody is dropped and',
      'reported to your manager as a failed handoff.',
      '',
      'This is for work that is genuinely theirs, not for work you would rather not do.',
      'Your own job is still yours. A handoff is not a proposal and nobody approves it —',
      'it starts on their desk, spends their budget, and lands in their queue behind',
      'whatever they are already doing, so hand over things that are worth their shift.',
    ];
    if (handedOff.length > 0) {
      parts.push(
        '',
        'ALREADY HANDED OVER — you have sent these on before. Do not send them again,',
        'to anyone, unless something has genuinely changed:',
        ...handedOff.slice(0, PROMPT_REJECTED_LIMIT).map((t) => `  - ${t}`),
      );
    }
    return parts;
  }

  private roster(): Worker[] {
    return [...this.workers.values()];
  }

  /// Act on the `<handoff>` blocks a planning turn emitted, and describe what
  /// happened for the sender's journal.
  ///
  /// Fire-and-forget by design. The referral is queued on the RECEIVER's own
  /// turn queue, behind whatever it is already doing — which can be a shift
  /// that runs for minutes — and awaiting that here would hold the sender's
  /// queue slot the whole time, so a handoff would lock its author out of
  /// being sent an errand by the user. A referral is a referral: the sender
  /// records that it made one, and the outcome belongs to the receiver's desk.
  private dispatchHandoffs(
    sender: Worker,
    rawReply: string,
    proposed: number,
    at: number,
    orchestrationId: string | undefined,
  ): string {
    if (!canDelegate(sender)) return '';
    const requested = parseHandoffs(rawReply);
    if (requested.length === 0) return '';

    const targets = delegationTargets(sender, this.roster());
    // Referrals are items: a shift that already proposed its full cap has
    // spent the attention this worker is allowed to ask for in one turn, and
    // must not top it up by commissioning more work elsewhere.
    const room = Math.max(0, sender.caps.maxItemsPerShift - proposed);
    const allowed = Math.min(room, WORKER_MAX_HANDOFFS_PER_TURN);

    const sent: string[] = [];
    const failed: string[] = [];
    requested.slice(0, allowed).forEach((h, i) => {
      const outcome = this.dispatchOne(
        sender,
        h,
        targets,
        `handoff-${sender.id}-${at}-${i}`,
        at,
        orchestrationId,
      );
      (outcome.ok ? sent : failed).push(outcome.summary);
    });

    const dropped = requested.length - Math.min(requested.length, allowed);
    const notes: string[] = [];
    if (sent.length > 0) notes.push(`Handed on to ${sent.join(', ')}.`);
    if (failed.length > 0) notes.push(`Could not hand on: ${failed.join('; ')}.`);
    // Never silent: a turn whose referral was dropped for want of item budget
    // read, to its author, exactly like one that was sent.
    if (dropped > 0) {
      notes.push(
        `${dropped} more handoff${dropped === 1 ? '' : 's'} dropped — no item budget left this turn.`,
      );
    }
    return notes.join(' ');
  }

  /// One referral: resolve the name, journal it on the sender, start it on the
  /// receiver. Returns a fragment for the sender's shift/errand note.
  private dispatchOne(
    sender: Worker,
    h: WorkerHandoff,
    targets: Worker[],
    entryId: string,
    at: number,
    orchestrationId: string | undefined,
  ): { ok: boolean; summary: string } {
    const title = errandLabel(h.instruction);
    const target = resolveHandoffTarget(h.to, targets);

    // A failed referral is journaled as `delegated` too, so it lands on the
    // ALREADY HANDED OVER list. Deliberate: the alternative is a worker that
    // re-reads the same unresolved finding every morning and re-sends it to
    // the same name that matched nobody, forever. One visible failure the user
    // can act on beats a silent daily retry.
    if (!target) {
      this.journal.append({
        workerId: sender.id,
        id: entryId,
        kind: 'delegated',
        at,
        title,
        note: `Tried to hand this to "${h.to}", who is not a colleague on this project.`,
        orchestrationId,
      });
      return { ok: false, summary: `"${h.to}" matched no colleague` };
    }

    // Checked BEFORE the "Handed to" note lands: journaling the handoff and
    // then refusing to send it would tell the sender's own history a referral
    // happened that never did, and — because that title now reads as already
    // handed off (see `handedOffTitles`) — bury the errand for good.
    const pending = this.pendingReferrals.get(target.id) ?? 0;
    if (pending >= MAX_PENDING_REFERRALS) {
      return { ok: false, summary: `"${h.to}" already has ${pending} referrals waiting` };
    }
    this.pendingReferrals.set(target.id, pending + 1);

    this.journal.append({
      workerId: sender.id,
      id: entryId,
      kind: 'delegated',
      at,
      title,
      note: `Handed to ${target.name}: ${h.instruction}`,
      orchestrationId,
    });

    // `manual` so the receiver's funding gate reports back as an error rather
    // than swallowing the errand and stamping cadence — a referral that died
    // on someone else's spent budget has to be visible from the sender's desk.
    void this.fire(target, {
      manual: true,
      errand: h.instruction,
      from: { workerId: sender.id, workerName: sender.name },
    })
      // A referral that threw is a referral that did not happen, so it is
      // reported exactly like one that was refused. Swallowing the throw
      // would leave the sender's journal claiming it handed the work over
      // and nothing on either desk to say it never arrived.
      .then((res) => (res.ok ? null : res.error))
      .catch((err) => String(err))
      .then((error) => {
        this.pendingReferrals.set(target.id, Math.max(0, (this.pendingReferrals.get(target.id) ?? 1) - 1));
        if (!error) return;
        this.journal.append({
          workerId: sender.id,
          id: `${entryId}:failed`,
          kind: 'delegated',
          at: this.now(),
          title,
          note: `${target.name} could not take it: ${error}`,
          orchestrationId,
        });
        this.emitWorker(this.workers.get(sender.id) ?? sender);
        this.deps.notify({
          title: `${target.name} could not take ${sender.name}'s handoff`,
          body: error,
        });
      });

    return { ok: true, summary: target.name };
  }

  /// What this worker has already referred on. The delegation counterpart to
  /// `rejectedTitles`, and needed for the same reason: a shift plans fresh
  /// every morning from a job description that has not changed, so without a
  /// record of what it already handed over, a worker re-reads the same
  /// unresolved ticket tomorrow and refers it again, and the day after that.
  /// The receiver has no way to notice — each arrival looks like a first ask.
  private handedOffTitles(workerId: string): string[] {
    const titles = this.journal
      .load(workerId)
      .filter((e) => e.kind === 'delegated')
      .map((e) => e.title.trim())
      .filter(Boolean);
    return Array.from(new Set(titles));
  }

  /// `from` names the colleague that sent this errand, when one did.
  ///
  /// A delegated errand gets NO roster block, and that omission is the whole
  /// of the depth limit: referrals go one hop, and a worker that cannot see
  /// its colleagues cannot pass the parcel on to them. Enforced by absence
  /// rather than by a cycle detector because absence cannot be argued with —
  /// there is no instruction here for a confused turn to misread, and no
  /// depth counter to get the arithmetic wrong on.
  private buildErrandPrompt(
    w: Worker,
    errand: string,
    rejected: string[],
    from?: { workerName: string },
  ): string {
    const parts = [
      from
        ? `You are "${w.name}", a standing worker on this project. A COLLEAGUE — "${from.workerName}" — hit something in their own work that they judged to be your job, not theirs, and passed it to you as a ONE-OFF ERRAND.`
        : `You are "${w.name}", a standing worker on this project. Your manager has handed you a ONE-OFF ERRAND — not your usual shift.`,
      '',
      'YOUR JOB DESCRIPTION',
      w.jobDescription,
      '',
      'YOUR JOURNAL (newest first — what you already proposed and how it was received):',
      this.journal.digest(w.id) || '(no journal yet)',
      ...this.filesBlock(w),
      ...this.contextBlock(),
      ...(from ? [] : this.delegationBlock(w)),
    ];
    if (rejected.length > 0) {
      parts.push(
        '',
        'REJECTED BEFORE — do NOT propose these again, or anything that is essentially the same ask:',
        ...rejected.slice(0, PROMPT_REJECTED_LIMIT).map((t) => `  - ${t}`),
      );
    }
    parts.push(
      '',
      'THE ERRAND',
      errand,
      '',
      'TRIAGE THIS ERRAND. Your job is to get your manager the answer or the outcome',
      'they asked for, by the CHEAPEST means that actually works. Pick exactly one:',
      '',
      '1. ANSWER IT NOW. If you can settle the errand from what you can already see —',
      '   a question about this project, a lookup you can do with the tools you have —',
      '   just answer it in prose. Emit an empty candidates list. An answered question',
      '   is a finished errand, not a failure. Do not manufacture work to look busy.',
      '',
      '2. USE YOUR EXISTING FLOWS. If the errand is work of a kind you already have a',
      `   flow for, propose at most ${w.caps.maxItemsPerShift} candidates, best first,`,
      '   each a self-contained ask. This is the normal path for work in your remit.',
      '',
      '3. ASK FOR A NEW FLOW. If answering properly needs real investigation — several',
      '   steps, reading a lot of the codebase, correlating things you cannot hold in',
      '   one turn — and none of your flows fits, do NOT guess and do NOT force it into',
      '   the wrong flow. Emit an empty candidates list and end your reply with a block:',
      '',
      '     <flow_request>',
      '     One paragraph describing the flow needed to answer this errand: what each',
      '     step should do, in order, and what the final step must output. Write it as',
      '     an instruction to a flow designer, not as prose for a human.',
      '     </flow_request>',
      '',
      '   A flow requested this way is built to ANSWER, so it must not CHANGE anything.',
      '   It may do whatever it takes to find out: read files, search, query tools, and',
      '   RUN things whose only effect is telling you something — the test suite, a',
      '   build, a linter, a type-check, a read-only query. Running a command is not',
      '   the line; changing the project is. Never request a flow that edits files,',
      '   commits, pushes, or writes to an external system. If the errand truly needs',
      '   changes made, that is path 2 or it is out of scope.',
      '',
      'NAME THE ERRAND. Whatever path you take, START your reply with one line:',
      '',
      '     <subject>What this errand is, as a title</subject>',
      '',
      'Six words or so, in your own words, naming the WORK — "Report the parser',
      'test coverage", not "can you give me a report of the test coverage". It is what',
      'this errand will be called in your journal and on your desk from now on, so it',
      'has to distinguish this ask from the three like it you did last week. No',
      'trailing punctuation, no restating your manager\u2019s phrasing back at them.',
      '',
      'Whichever path you take, it must still be YOUR job. If the errand clearly falls',
      'outside your job description, take none of them: emit an empty candidates list,',
      'no flow request, and say in your own words what you understood the ask to be,',
      'why it is not yours, and who or what should do it instead.',
    );
    if (from) {
      parts.push(
        '',
        `"${from.workerName}" routed this to you by reading one line of your job description,`,
        'so they may simply have picked wrong. Refusing a misrouted errand is the correct',
        'outcome and costs almost nothing — say plainly that it is not yours and who should',
        'have it. Do NOT stretch your remit to cover it because a colleague asked; they have',
        'no authority over what your job is.',
      );
    }
    return parts.join('\n');
  }

  // ---- JOURNAL PROJECTION ----------------------------------------------

  /// Fold one worker batch's state into the journal. Deterministic entry ids
  /// + idempotent append = safe to call on every update and at startup.
  private syncOrchestration(o: Orchestration): void {
    if (o.origin?.kind !== 'worker') return;
    const w = this.workers.get(o.origin.workerId);
    if (!w) return;
    const now = this.now();
    // What the journal already holds, so a cancellation can be told apart
    // from a rejection: an item that was ever ACCEPTED (approved entry
    // exists) and later lands `cancelled` — a batch abort, or a queued item
    // settled by an app restart — is not a verdict on the idea. Folding it
    // as `rejected` would ban the title forever and feed the demotion
    // streak with rejections nobody made.
    let newestRejectedId: string | null = null;
    let changed = false;

    for (const item of o.items) {
      const c = item.candidate;
      const key = (suffix: string) => `${o.id}:${c.id}:${suffix}`;
      const base = { workerId: w.id, orchestrationId: o.id, title: c.title };

      changed =
        this.journal.append({ ...base, id: key('proposed'), kind: 'proposed', at: o.createdAt }) ||
        changed;

      const launched =
        item.status === 'running' ||
        item.status === 'paused' ||
        item.status === 'done' ||
        item.status === 'failed';
      // Reaching `queued` or beyond means the item was accepted — by a human
      // approving the batch, or standing acceptance via the trust cap.
      if (item.status === 'queued' || launched) {
        changed =
          this.journal.append({ ...base, id: key('approved'), kind: 'approved', at: now }) ||
          changed;
      }
      if (launched && item.runId) {
        changed =
          this.journal.append({
            ...base,
            id: key('launched'),
            kind: 'launched',
            at: item.startedAt ?? now,
            runId: item.runId,
          }) || changed;
      }
      if (item.status === 'done') {
        changed =
          this.journal.append({
            ...base,
            id: key('completed'),
            kind: 'completed',
            at: item.finishedAt ?? now,
            runId: item.runId,
          }) || changed;
        // Copy the answer somewhere it will outlive the run. Idempotent by
        // filename, which matters because this fold re-runs on every update
        // and at startup.
        if (item.runId && this.deps.deliverablesFor) {
          const artifacts = this.deps.deliverablesFor(item.runId);
          if (artifacts.length > 0) {
            fileWorkerDeliverable({
              workerId: w.id,
              task: o.origin.task === 'errand' ? 'errand' : 'shift',
              label: o.title,
              title: c.title,
              at: item.finishedAt ?? now,
              artifacts,
            });
            // And, for a worker hired to file into an everyday project, a
            // second copy where its owner actually looks: the folder. The
            // cabinet stays the archive; this is the delivery address.
            // `publishDeliverableToProject` refuses anything that is not a
            // marked everyday folder and keeps its own ledger, so this is
            // safe on the same re-fold the cabinet copy survives.
            if (w.caps.fileIntoProject) {
              const published = publishDeliverableToProject({
                workerId: w.id,
                projectPath: w.projectPath,
                runId: item.runId,
                artifacts,
              });
              // Documents arriving is one of the boundaries everyday projects
              // checkpoint on, and a worker's drop is no different from a
              // drag from Finder — without this it would be the one change to
              // the folder that "Undo or restore" could not put back.
              if (published.written.length > 0) {
                this.deps.checkpoint?.({
                  projectPath: w.projectPath,
                  message: `${w.name} added ${published.written.join(', ')}`,
                });
              }
            }
          }
        }
      }
      if (item.status === 'failed') {
        changed =
          this.journal.append({
            ...base,
            id: key('failed'),
            kind: 'failed',
            at: item.finishedAt ?? now,
            runId: item.runId,
            note: item.note,
          }) || changed;
      }
      // A cancellation is a REJECTION only when a person turned the work
      // down. Two things say otherwise: the item was already accepted (it
      // earned an `approved` entry on its way to `queued`), or a restart
      // settled it — which is the app's doing and must never cost a worker
      // its trust level.
      if (
        item.status === 'cancelled' &&
        !item.settledByRestart &&
        !this.journal.has(key('approved'))
      ) {
        const wrote = this.journal.append({
          ...base,
          id: key('rejected'),
          kind: 'rejected',
          at: item.finishedAt ?? now,
        });
        if (wrote) newestRejectedId = key('rejected');
        changed = wrote || changed;
      }
    }

    if (newestRejectedId) this.maybeDemote(w, newestRejectedId);
    if (changed) {
      this.emitWorker(w);
      // Gated on `changed` rather than fired per update: a finished run is
      // when cost lands in the log, and re-reading that log on every
      // streaming batch update would be a disk read per event.
      this.emitTreasury();
    }
  }

  /// Auto-demotion: three consecutive rejections cost one trust level. Keyed
  /// on the newest rejected entry's id so the same streak can only demote
  /// once — the journal's idempotent append is the exactly-once guard.
  private maybeDemote(w: Worker, newestRejectedId: string): void {
    if (w.trust === 'probation') return;
    const entries = this.journal.load(w.id);
    if (rejectionStreak(entries) < WORKER_DEMOTE_REJECTION_STREAK) return;
    const wrote = this.journal.append({
      id: `demote-${newestRejectedId}`,
      workerId: w.id,
      // 'demoted' terminates the rejection streak — see rejectionStreak.
      // Without that, the streak that caused this demotion would still be
      // live, and every following rejection would demote again.
      kind: 'demoted',
      at: this.now(),
      title: '',
      note: `Demoted ${w.trust} → ${demotedTrust(w.trust)} after ${WORKER_DEMOTE_REJECTION_STREAK} consecutive rejections.`,
    });
    if (!wrote) return;
    const from = w.trust;
    w.trust = demotedTrust(w.trust);
    if (w.trust !== 'autonomous' && w.caps.runIn === 'cwd') {
      w.caps = { ...w.caps, runIn: 'worktree' };
    }
    this.persistAndEmit(w);
    this.deps.notify({
      title: `${w.name} was demoted`,
      body: `${from} → ${w.trust} after ${WORKER_DEMOTE_REJECTION_STREAK} rejections in a row.`,
    });
  }

  // ---- INTERNALS --------------------------------------------------------

  /// Worktree preference degrades to cwd when the project isn't a repo —
  /// same reasoning as the scheduler's effectiveRunIn. A cwd *preference*
  /// (autonomous workers only) is honored as-is.
  private effectiveRunIn(w: Worker): 'cwd' | 'worktree' {
    if (w.caps.runIn !== 'worktree') return 'cwd';
    return this.deps.isGitRepo(w.projectPath) ? 'worktree' : 'cwd';
  }

  /// The clock alone is not enough: two errands can run under a frozen clock
  /// in a test or after a timestamp collision. The ordinal keeps append ids
  /// deterministic while preserving both entries.
  /// The errand thread for this worker, oldest first, bounded.
  ///
  /// An errand is not a one-off: you send one, read the answer, and say "no,
  /// the other spec" or "now do staging". The producer is a one-shot with no
  /// session, so the conversation only exists if it is replayed — and replaying
  /// just the last exchange loses the thing two turns back that the follow-up
  /// actually refers to.
  ///
  /// Read off the batches rather than a separate transcript: an errand batch
  /// already stores the instruction that made it and the reply it produced,
  /// which is exactly one turn.
  private priorErrandTurns(workerId: string): Array<{ prompt: string; reply: string }> {
    return this.deps.parker
      .list()
      .filter(
        (o) =>
          o.origin?.kind === 'worker' &&
          o.origin.workerId === workerId &&
          o.origin.task === 'errand' &&
          !!o.producer?.reply,
      )
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-ERRAND_THREAD_TURNS)
      .map((o) => ({
        prompt:
          (o.origin?.kind === 'worker' ? o.origin.errand : undefined) ?? o.producer!.prompt,
        // Bound each replayed reply: a thread of six full investigations would
        // crowd out the job description and journal that make it a worker.
        reply: o.producer!.reply.slice(0, ERRAND_THREAD_REPLY_CHARS),
      }));
  }

  private errandEntryId(workerId: string, at: number): string {
    const n = this.journal.load(workerId).filter((e) => e.kind === 'errand').length;
    return `errand-${workerId}-${at}-${n}`;
  }

  private snapshot(w: Worker): {
    worker: Worker;
    nextShiftAt: number | null;
    scorecard: WorkerScorecard;
  } {
    return {
      worker: structuredClone(w),
      nextShiftAt: this.nextShiftAt(w.id),
      scorecard: this.scorecard(w),
    };
  }

  private scorecard(w: Worker): WorkerScorecard {
    return computeWorkerScorecard(
      this.journal.load(w.id),
      this.spend(w.id, monthStart(this.now())),
    );
  }

  private persistAndEmit(w: Worker): void {
    this.store.save(w);
    this.emitWorker(w);
    // Anything worth persisting about a worker — a cap edit, a pause, a shift
    // that just spent money — changes what everyone below it can draw.
    this.emitTreasury();
  }

  private emitTreasury(): void {
    const snap = this.treasury();
    this.deps.emit({
      type: 'treasuryUpdate',
      treasury: snap.treasury,
      allocation: snap.allocation,
    });
  }

  private emitWorker(w: Worker): void {
    const snap = this.snapshot(w);
    this.deps.emit({
      type: 'workerUpdate',
      worker: snap.worker,
      nextShiftAt: snap.nextShiftAt,
      scorecard: snap.scorecard,
    });
  }
}

function taggedBody(text: string, tag: string): string | null {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = text.match(new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}\\s*>`, 'i'))?.[1];
  return body?.trim() || null;
}

/// Start of the calendar month containing `now`, local time — budget months
/// roll over when the user's wall calendar does.
function monthStart(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

/// The shift number out of a batch's ledger title (`[Shift 3] Warden`), or
/// null for an errand or anything filed before the scheme existed. This is
/// the only place the number survives on the batch itself — the worker record
/// holds the running count, not which count each batch was.
function shiftNumberOf(title: string): number | null {
  const found = /^\[Shift\s+(\d+)\]/i.exec(title);
  if (!found) return null;
  const n = Number(found[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function dayKey(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function describeShift(count: number, queued: number, excluded: number): string {
  const dropped = excluded > 0 ? ` ${excluded} dropped as previously rejected.` : '';
  if (count === 0) return `Nothing worth proposing this shift.${dropped}`;
  if (queued === 0) return `${count} proposed — waiting for approval.${dropped}`;
  const held = count - queued;
  if (held === 0) return `${count} proposed — ${queued} launched.${dropped}`;
  return `${count} proposed — ${queued} launched, ${held} waiting for approval.${dropped}`;
}

function describeShiftNotification(count: number, queued: number, excluded: number): string {
  if (count === 0) {
    return excluded > 0
      ? `Nothing new — ${excluded} idea${excluded === 1 ? '' : 's'} already rejected before.`
      : 'Nothing worth proposing this shift.';
  }
  const held = count - queued;
  if (queued === 0) return `${count} proposal${count === 1 ? '' : 's'} waiting for your review.`;
  if (held === 0) return `${queued} run${queued === 1 ? '' : 's'} launched under its trust cap.`;
  return `${queued} launched, ${held} waiting for your review.`;
}

function errandLabel(errand: string): string {
  const first = errand.trim().split('\n')[0]?.trim() ?? '';
  return first.length > 80 ? `${first.slice(0, 79)}…` : first || 'Errand';
}

/// The `<flow_request>` block a triage turn emits when the errand needs real
/// investigation and none of the worker's existing flows fit. Absent on the
/// other two paths (answered in prose, or routed to existing flows).
export function parseFlowRequest(reply: string): string | null {
  const match = /<flow_request>([\s\S]*?)<\/flow_request>/i.exec(reply);
  const body = match?.[1]?.trim();
  return body ? body : null;
}

function errandReply(reply: string): string {
  const prose = stripHandoffs(
    stripWorkerSubject(reply)
      .replace(/<candidates>[\s\S]*$/i, '')
      .replace(/<flow_request>[\s\S]*?<\/flow_request>/gi, ''),
  ).trim();
  return prose.length > 600 ? `${prose.slice(0, 599)}…` : prose;
}
