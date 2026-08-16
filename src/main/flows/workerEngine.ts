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
//   3. It does not run past its budget. Once the month's run spend crosses
//      `budgetUSDPerMonth`, shifts skip (journaled, once a day) until the
//      month rolls over.
//
// Verdict capture is a projection: every `orchestrationUpdate` for a batch
// with `origin.kind === 'worker'` is folded into the journal with
// deterministic entry ids, and the journal's idempotent append makes the
// fold safe to run on every event, restart, or replay.

import { randomUUID } from 'node:crypto';

import type { MainToRendererEvent, UUID } from '../../shared/types';
import type { Orchestration } from '../../shared/flows/orchestration';
import {
  evaluateSchedule,
  nextOccurrenceAfter,
  scheduleAnchor,
  type ScheduleTiming,
} from '../../shared/flows/schedule';
import {
  WORKER_DEMOTE_REJECTION_STREAK,
  computeWorkerScorecard,
  demotedTrust,
  rejectionStreak,
  validateWorker,
  workerAutoApproveCap,
  type Worker,
  type WorkerJournalEntry,
  type WorkerScorecard,
  type WorkerTrustLevel,
} from '../../shared/flows/worker';
import { deleteWorker, loadAllWorkers, saveWorker } from './workersStore';
import {
  appendWorkerJournalEntry,
  digestWorkerJournal,
  loadWorkerJournal,
  workerRejectedTitles,
} from './workerJournal';
import { workerSpendSince } from './runSummaryLog';

/// Same bound as the scheduler: re-derive the nearest due time at least once
/// a minute so sleep/clock-steps can't strand a timer.
const MAX_TIMER_MS = 60_000;

/// How many journaled rejections ride along in the shift prompt. The hard
/// filter in parkProposal uses the full list; the prompt excerpt only has to
/// be big enough to steer the model away from re-treading old ground.
const PROMPT_REJECTED_LIMIT = 30;

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
    maxItems?: number;
    excludeTitles?: string[];
    allowedFlowIds?: string[];
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
    rejectedTitles: (workerId: string) => string[];
    digest: (workerId: string) => string;
  };
  /// Run spend for a worker since `sinceMs`, from the run-summary log.
  spend?: (workerId: string, sinceMs: number) => number;
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

  private readonly now: () => number;
  private readonly timers: NonNullable<WorkerEngineDeps['timers']>;
  private readonly store: NonNullable<WorkerEngineDeps['store']>;
  private readonly journal: NonNullable<WorkerEngineDeps['journal']>;
  private readonly spend: NonNullable<WorkerEngineDeps['spend']>;

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
      rejectedTitles: workerRejectedTitles,
      digest: digestWorkerJournal,
    };
    this.spend = deps.spend ?? workerSpendSince;
  }

  /// Load persisted workers, reconcile batches that settled while the app was
  /// closed into the journal, and arm the timer. Called once at wiring time.
  start(): void {
    for (const w of this.store.loadAll()) this.workers.set(w.id, w);
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

  get(id: UUID): Worker | null {
    return this.workers.get(id) ?? null;
  }

  journalFor(id: UUID): WorkerJournalEntry[] {
    return this.journal.load(id);
  }

  nextShiftAt(id: UUID): number | null {
    const w = this.workers.get(id);
    if (!w || !w.enabled) return null;
    const timing = this.timing(w);
    return nextOccurrenceAfter(timing.trigger, scheduleAnchor(timing));
  }

  // ---- WRITES -----------------------------------------------------------

  /// Hire (no `id`) or update (with `id`). Every hire starts on probation —
  /// trust is not part of the application form. Edits keep the existing trust
  /// (promotion/demotion go through `setTrust`, an explicit act).
  save(
    input: Omit<Worker, 'id' | 'createdAt' | 'trust'> & { id?: UUID; trust?: WorkerTrustLevel },
  ): { ok: true; worker: Worker } | { ok: false; error: string } {
    const existing = input.id ? this.workers.get(input.id) : undefined;
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
    };
    // A non-autonomous worker may not run in the working copy; repair rather
    // than reject, since trust wasn't the caller's to choose here.
    if (candidate.trust !== 'autonomous' && candidate.caps.runIn === 'cwd') {
      candidate.caps = { ...candidate.caps, runIn: 'worktree' };
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
    this.arm();
    return { ok: true };
  }

  /// Work one shift right now, out of band — the "will this do what I think"
  /// button. Advances the shift number but not the cadence.
  async workShiftNow(id: UUID): Promise<{ ok: true } | { ok: false; error: string }> {
    const w = this.workers.get(id);
    if (!w) return { ok: false, error: 'Worker not found.' };
    if (this.firing.has(id)) return { ok: false, error: 'A shift is already starting.' };
    const res = await this.fire(w, { manual: true });
    this.arm();
    return res;
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

  private async fire(
    w: Worker,
    opts: { manual?: boolean },
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.firing.has(w.id)) return { ok: false, error: 'A shift is already starting.' };
    this.firing.add(w.id);
    try {
      return await this.fireInner(w, opts);
    } finally {
      this.firing.delete(w.id);
    }
  }

  private async fireInner(
    w: Worker,
    opts: { manual?: boolean },
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const now = this.now();

    // Budget gate. Enforced per calendar month against the run-summary log —
    // the same numbers the Usage page shows.
    const spent = this.spend(w.id, monthStart(now));
    if (spent >= w.budgetUSDPerMonth) {
      const message = `Monthly budget spent ($${spent.toFixed(2)} of $${w.budgetUSDPerMonth.toFixed(2)}) — idle until next month.`;
      if (opts.manual) return { ok: false, error: message };
      // Journaled at most once a day, so an every-15-minutes cadence doesn't
      // write 96 identical lines. The cadence still advances: an exhausted
      // worker waits for the month, it doesn't pile up missed occurrences.
      const wrote = this.journal.append({
        id: `shift-budget-${w.id}-${dayKey(now)}`,
        workerId: w.id,
        kind: 'shift',
        at: now,
        title: '',
        note: message,
      });
      if (wrote) this.deps.notify({ title: `${w.name} is out of budget`, body: message });
      w.lastShiftAt = now;
      this.persistAndEmit(w);
      return { ok: true };
    }

    // Stamp BEFORE awaiting the planning turn — it can run for minutes, long
    // enough for another tick to read a stale lastShiftAt and double-fire.
    const sequence = (w.shiftCount ?? 0) + 1;
    w.shiftCount = sequence;
    if (!opts.manual) w.lastShiftAt = now;
    this.persistAndEmit(w);

    const rejected = this.journal.rejectedTitles(w.id);
    const runIn = this.effectiveRunIn(w);
    const autoCap = workerAutoApproveCap(w);

    // The planning turn can run for minutes; tell the renderer the shift is
    // live so the row shows work happening instead of nothing. Cleared in
    // the finally so a thrown park can't leave a row spinning forever.
    this.deps.emit({ type: 'workerShiftProgress', workerId: w.id, active: true });
    let res: Awaited<ReturnType<WorkerParker['parkProposal']>>;
    try {
      res = await this.parkShift(w, sequence, runIn, autoCap, rejected);
    } finally {
      this.deps.emit({ type: 'workerShiftProgress', workerId: w.id, active: false });
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

    this.journal.append({
      id: `shift-${w.id}-${sequence}`,
      workerId: w.id,
      kind: 'shift',
      at: this.now(),
      title: `Shift ${sequence}`,
      note: describeShift(res.count, res.queued, res.excluded),
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
  ): ReturnType<WorkerParker['parkProposal']> {
    return this.deps.parker.parkProposal({
      origin: { kind: 'worker', workerId: w.id, workerName: w.name },
      projectPath: w.projectPath,
      prompt: this.buildShiftPrompt(w, sequence, rejected),
      flowId: w.flowIds[0],
      runIn,
      maxConcurrent: Math.min(w.caps.maxItemsPerShift, 4),
      title: `[Shift ${sequence}] ${w.name}`,
      autoApprove: autoCap > 0 ? { maxItems: autoCap } : undefined,
      model: w.heartbeatModel,
      maxItems: w.caps.maxItemsPerShift,
      excludeTitles: rejected,
      // The planner may route a candidate to any flow ON THE CONTRACT, but a
      // hallucinated flow id falls back to the primary — under autoApprove a
      // free choice would be an unattended launch into unvetted machinery.
      allowedFlowIds: w.flowIds,
    });
  }

  /// The planning turn's user request (the producer system prompt rides in
  /// front of it — see orchestrator.propose). Rebuilt from the journal every
  /// shift: this is the difference between a worker and a saved prompt.
  private buildShiftPrompt(w: Worker, sequence: number, rejected: string[]): string {
    const digest = this.journal.digest(w.id);
    const parts = [
      `You are "${w.name}", a standing worker on this project. This is your shift #${sequence}.`,
      '',
      'YOUR JOB DESCRIPTION',
      w.jobDescription,
      '',
      'YOUR JOURNAL (newest first — what you already proposed and how it was received):',
      digest || '(first shift — no journal yet)',
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
    const priorIds = new Set(this.journal.load(w.id).map((e) => e.id));
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
      if (item.status === 'cancelled' && !priorIds.has(key('approved'))) {
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
    if (changed) this.emitWorker(w);
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

/// Start of the calendar month containing `now`, local time — budget months
/// roll over when the user's wall calendar does.
function monthStart(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
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
