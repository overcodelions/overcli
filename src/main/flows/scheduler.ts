// Scheduler engine — the main-process half of the Flows tab's Schedules
// surface. Owns one timer for every schedule the user has armed.
//
// Two things it does NOT do, both on purpose:
//
//   1. It does not poll on a fixed tick. It computes the nearest due time
//      across every enabled schedule and sleeps until then (bounded — see
//      MAX_TIMER_MS). Twenty schedules cost one timer, not twenty.
//   2. It does not dispatch an orchestrator batch unless the schedule asked
//      for it. A scheduled `orchestrate` target runs the producer turn and
//      PARKS what it finds; approving it is a human action. A target with
//      `autoApprove` set releases the first N items itself and parks the rest.
//      See shared/flows/schedule.ts for the reasoning and the bound.
//
// All the awkward arithmetic — missed while asleep, came due mid-run, restart
// mid-interval — lives in `evaluateSchedule` in shared/, which is pure and
// tested there. This file is the side effects: launch, persist, notify, rearm.

import { randomUUID } from 'node:crypto';

import type { MainToRendererEvent, UUID } from '../../shared/types';
import type { FlowRun } from '../../shared/flows/schema';
import {
  MAX_CHAIN_DEPTH,
  SCHEDULE_HISTORY_LIMIT,
  composeChainedPrompt,
  describeTrigger,
  evaluateSchedule,
  latestArtifact,
  nextOccurrenceAfter,
  scheduleAnchor,
  scheduledRunTitle,
  validateSchedule,
  type Schedule,
  type ScheduleRunRecord,
} from '../../shared/flows/schedule';
import type { FlowLauncher } from './orchestrator';
import { deleteSchedule, loadAllSchedules, saveSchedule } from './schedulesStore';

/// Longest we'll ever sleep in one go, even when the next occurrence is days
/// out. `setTimeout` is not a reliable long-range alarm — the laptop sleeps,
/// the clock steps, the timer fires late or early — so we re-derive the
/// nearest due time at least this often. It's still one timer and one wakeup
/// a minute, not a scan loop with work in it.
const MAX_TIMER_MS = 60_000;

/// Produce candidates and record them as a batch — parked for approval, or
/// (with `autoApprove`) released up to its cap. Implemented by the
/// orchestrator; injected so this engine stays testable without a CLI.
export interface ProposalParker {
  parkProposal(args: {
    scheduleId: UUID;
    scheduleName: string;
    projectPath: string;
    prompt: string;
    flowId: string;
    runIn: 'cwd' | 'worktree';
    baseBranch?: string;
    maxConcurrent: number;
    /// Title for the parked batch, already carrying its `[SR-n]` sequence.
    title: string;
    /// Set to launch without waiting for approval, up to `maxItems`.
    autoApprove?: { maxItems: number };
  }): Promise<
    | { ok: true; orchestrationId: UUID; count: number; queued: number }
    | { ok: false; error: string }
  >;
}

export interface SchedulerDeps {
  launcher: FlowLauncher;
  parker: ProposalParker;
  /// Whether a `worktree` target can actually fork here: a git work tree, or a
  /// workspace root (whose members each get one). Used to degrade to `cwd`
  /// rather than fail — see `effectiveRunIn`.
  isGitRepo: (projectPath: string) => boolean;
  emit: (event: MainToRendererEvent) => void;
  /// Desktop notification. A scheduled run finishing with nobody watching is
  /// invisible otherwise — this is the only channel out.
  notify: (args: { title: string; body: string }) => void;
  now?: () => number;
  timers?: {
    set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clear: (handle: ReturnType<typeof setTimeout>) => void;
  };
  store?: {
    loadAll: () => Schedule[];
    save: (s: Schedule) => void;
    remove: (id: string) => void;
  };
}

export class SchedulerEngine {
  private schedules = new Map<UUID, Schedule>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /// runId → scheduleId, so a terminal run update routes home in O(1) without
  /// scanning every schedule.
  private runToSchedule = new Map<UUID, UUID>();
  private disposed = false;
  /// Guards `tick` against re-entry. Firing is async (startRun awaits a
  /// worktree checkout), and a rearm inside that window could otherwise run a
  /// second tick against the same not-yet-updated schedule and launch twice.
  private ticking = false;
  /// Schedules with a launch in flight. `activeRunId` can't do this job: it
  /// isn't set until startRun resolves, and a worktree checkout leaves seconds
  /// in which the schedule looks idle to anything that asks. A double-click on
  /// Run now, or a tick landing mid-launch, would each start a second run.
  private firing = new Set<UUID>();

  private readonly now: () => number;
  private readonly timers: NonNullable<SchedulerDeps['timers']>;
  private readonly store: NonNullable<SchedulerDeps['store']>;

  constructor(private deps: SchedulerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.timers = deps.timers ?? { set: setTimeout, clear: clearTimeout };
    this.store = deps.store ?? {
      loadAll: loadAllSchedules,
      save: saveSchedule,
      remove: deleteSchedule,
    };
  }

  /// Load persisted schedules and arm the timer. Called once at wiring time.
  start(): void {
    for (const s of this.store.loadAll()) this.schedules.set(s.id, s);
    this.arm();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) this.timers.clear(this.timer);
    this.timer = null;
  }

  // ---- READS ------------------------------------------------------------

  list(): Schedule[] {
    return [...this.schedules.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: UUID): Schedule | null {
    return this.schedules.get(id) ?? null;
  }

  /// When each schedule will next fire, for the list UI. Computed rather than
  /// stored so it can't go stale against an edited trigger.
  nextFireAt(id: UUID): number | null {
    const s = this.schedules.get(id);
    if (!s || !s.enabled) return null;
    // An event-driven schedule has no next fire time at all. Falling through
    // would hand `Infinity` to the list UI and to every `scheduleUpdate`
    // event, where it renders as a nonsense countdown; `null` is the shape
    // the callers already handle for "not scheduled".
    if (s.trigger.kind === 'onFlowComplete') return null;
    return nextOccurrenceAfter(s.trigger, scheduleAnchor(s));
  }

  // ---- WRITES -----------------------------------------------------------

  /// Create or replace a schedule. `id` absent means create.
  save(input: Omit<Schedule, 'id' | 'createdAt' | 'history'> & { id?: UUID }):
    | { ok: true; schedule: Schedule }
    | { ok: false; error: string } {
    const invalid = validateSchedule(input as Partial<Schedule>);
    if (invalid) return { ok: false, error: invalid };

    // A base branch only means something for a worktree run. Dropping it on
    // the way in keeps a name picked before the target was flipped to
    // "project tree" from coming back to life if it's ever flipped again.
    if (input.target.runIn !== 'worktree' && input.target.baseBranch) {
      input = { ...input, target: { ...input.target, baseBranch: undefined } };
    }

    const existing = input.id ? this.schedules.get(input.id) : undefined;
    const now = this.now();
    // Re-anchor when the cadence changed or the schedule was just switched
    // back on. Without this, editing "every 4 hours" while the old anchor sits
    // 6 hours in the past makes the saved schedule fire the instant it's
    // saved — which reads as a bug even though the arithmetic is right.
    const triggerChanged =
      !existing || JSON.stringify(existing.trigger) !== JSON.stringify(input.trigger);
    const reEnabled = !!existing && !existing.enabled && input.enabled;

    const schedule: Schedule = {
      ...(existing ?? { createdAt: now, history: [] as ScheduleRunRecord[] }),
      ...input,
      id: existing?.id ?? input.id ?? randomUUID(),
      createdAt: existing?.createdAt ?? now,
      history: existing?.history ?? [],
      // Pinned after the spread, like `history`: the sequence must survive an
      // edit, or renaming a schedule would restart its numbering and put a
      // second SR-1 in the run list.
      runCount: existing?.runCount,
      anchorAt: triggerChanged || reEnabled ? now : existing?.anchorAt,
      // A cadence change invalidates a firing that was deferred under the old
      // one; a stale `pendingSince` would fire immediately after the edit.
      pendingSince: triggerChanged ? undefined : existing?.pendingSince,
    };
    this.schedules.set(schedule.id, schedule);
    this.persistAndEmit(schedule);
    this.arm();
    return { ok: true, schedule };
  }

  setEnabled(id: UUID, enabled: boolean): { ok: true } | { ok: false; error: string } {
    const s = this.schedules.get(id);
    if (!s) return { ok: false, error: 'Schedule not found.' };
    if (s.enabled === enabled) return { ok: true };
    s.enabled = enabled;
    // Turning a schedule back on restarts its clock — an interval that was off
    // for a week should not owe the user a firing the moment it's re-armed.
    if (enabled) {
      s.anchorAt = this.now();
      s.pendingSince = undefined;
    }
    this.persistAndEmit(s);
    this.arm();
    return { ok: true };
  }

  remove(id: UUID): { ok: true } | { ok: false; error: string } {
    const s = this.schedules.get(id);
    if (!s) return { ok: false, error: 'Schedule not found.' };
    // Deleting the schedule deliberately does NOT abort a run it started. The
    // run is real work in a real worktree; the user is removing the trigger,
    // not disowning the output.
    if (s.activeRunId) this.runToSchedule.delete(s.activeRunId);
    this.schedules.delete(id);
    this.store.remove(id);
    this.deps.emit({ type: 'scheduleDeleted', id });
    this.arm();
    return { ok: true };
  }

  /// Fire a schedule right now, out of band. Used by the list's "Run now" —
  /// the way to answer "will this actually do what I think" without waiting
  /// until 9am tomorrow.
  async runNow(id: UUID): Promise<{ ok: true } | { ok: false; error: string }> {
    const s = this.schedules.get(id);
    if (!s) return { ok: false, error: 'Schedule not found.' };
    if (this.firing.has(id)) return { ok: false, error: 'Already starting.' };
    if (this.isBusy(s)) return { ok: false, error: 'A run from this schedule is still going.' };
    await this.fire(s, { manual: true });
    this.arm();
    return { ok: true };
  }

  // ---- FIRING -----------------------------------------------------------

  /// Re-derive the nearest due time and sleep until then.
  private arm(): void {
    if (this.disposed) return;
    if (this.timer) this.timers.clear(this.timer);
    this.timer = null;

    const now = this.now();
    let soonest = Number.POSITIVE_INFINITY;
    for (const s of this.schedules.values()) {
      const decision = evaluateSchedule(s, now, { busy: this.isBusy(s) });
      if (decision.action === 'fire') {
        soonest = now;
        break;
      }
      if (decision.action === 'wait') soonest = Math.min(soonest, decision.at);
      else soonest = Math.min(soonest, decision.nextAt);
    }
    if (!Number.isFinite(soonest)) return; // nothing enabled — no timer at all
    const delay = Math.max(0, Math.min(soonest - now, MAX_TIMER_MS));
    this.timer = this.timers.set(() => void this.tick(), delay);
  }

  private async tick(): Promise<void> {
    if (this.disposed || this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      // Snapshot: firing mutates the map (and `remove` can run from IPC while
      // we await a launch), so iterate a copy.
      for (const s of [...this.schedules.values()]) {
        if (!this.schedules.has(s.id)) continue;
        // Mid-launch (a Run now, or a previous fire still awaiting its
        // worktree). Skip outright rather than evaluating — evaluating would
        // see it as busy and write a spurious "previous run was still going"
        // into the history for a run that hasn't even started.
        if (this.firing.has(s.id)) continue;
        const busy = this.isBusy(s);
        const decision = evaluateSchedule(s, now, { busy });
        if (decision.action === 'wait') continue;
        if (decision.action === 'skip') {
          this.record(s, { at: now, outcome: 'skipped', note: decision.reason });
          // Move the anchor past the occurrence we declined, or the very next
          // tick would evaluate the same missed slot and skip it again — a
          // history full of identical skip entries.
          s.anchorAt = now;
          s.lastFiredAt = undefined;
          this.persistAndEmit(s);
          continue;
        }
        if (busy && s.onOverlap === 'queue') {
          // Remember at most one. `pendingSince` is a flag, not a counter.
          if (s.pendingSince === undefined) {
            s.pendingSince = decision.dueAt;
            s.anchorAt = now;
            s.lastFiredAt = undefined;
            this.record(s, {
              at: now,
              outcome: 'skipped',
              note: 'Deferred — previous run still going.',
            });
            this.persistAndEmit(s);
          }
          continue;
        }
        await this.fire(s, { late: decision.late });
      }
    } finally {
      this.ticking = false;
      this.arm();
    }
  }

  private async fire(s: Schedule, opts: FireOpts): Promise<void> {
    if (this.firing.has(s.id)) return;
    this.firing.add(s.id);
    try {
      await this.fireInner(s, opts);
    } finally {
      this.firing.delete(s.id);
    }
  }

  private async fireInner(s: Schedule, opts: FireOpts): Promise<void> {
    const now = this.now();
    // Replace: the in-flight run is stale by definition — the user asked for
    // the freshest answer this cadence can give, not the one already running.
    if (s.activeRunId && s.onOverlap === 'replace' && !opts.manual) {
      try {
        this.deps.launcher.abortRun({ runId: s.activeRunId });
      } catch {
        // The run may already be terminal; the update handler cleans up.
      }
      this.runToSchedule.delete(s.activeRunId);
      s.activeRunId = undefined;
    }

    // A manual run is a test drive, not an occurrence. Advancing the cadence
    // for one would mean checking an hourly schedule at 8:59 silently costs
    // you the 9am run you were checking on — so `lastFiredAt` and the
    // deferred-firing flag are left exactly as they were, and only the
    // in-flight guard below stops a concurrent tick from doubling up.
    //
    // For a real occurrence, stamp BEFORE awaiting the launch: `lastFiredAt`
    // is what collapses N missed occurrences into one firing, and startRun can
    // take seconds (worktree checkout) — long enough for another tick to read
    // the old value.
    if (!opts.manual) {
      s.lastFiredAt = now;
      s.pendingSince = undefined;
    }
    // Manual runs DO take a sequence number even though they don't advance the
    // cadence. They produce a real run that lands in the same list as the
    // scheduled ones, so it needs a distinct name just as much.
    const sequence = (s.runCount ?? 0) + 1;
    s.runCount = sequence;
    this.persistAndEmit(s);

    const lateNote = opts.manual
      ? 'Run now.'
      : opts.chain
        ? `Chained from ${opts.chain.upstream.flowId} (hop ${opts.chain.depth}).`
        : opts.late
          ? 'Catch-up run.'
          : undefined;
    const runIn = this.effectiveRunIn(s);

    if (s.target.kind === 'orchestrate') {
      const res = await this.deps.parker.parkProposal({
        scheduleId: s.id,
        scheduleName: s.name,
        projectPath: s.projectPath,
        prompt: s.target.prompt,
        flowId: s.target.flowId,
        runIn,
        baseBranch: runIn === 'worktree' ? s.target.baseBranch : undefined,
        maxConcurrent: s.target.maxConcurrent,
        // Same problem as runs: every morning's batch would otherwise be
        // called "Morning triage" and the ledger couldn't tell them apart.
        title: `[SR-${sequence}] ${s.name}`,
        autoApprove: s.target.autoApprove,
      });
      if (!res.ok) {
        this.record(s, { at: this.now(), outcome: 'failed', note: res.error });
        this.persistAndEmit(s);
        this.deps.notify({ title: `${s.name} failed`, body: res.error });
        return;
      }
      this.record(s, {
        at: this.now(),
        outcome: 'done',
        orchestrationId: res.orchestrationId,
        note: joinNotes(lateNote, describeProposal(res.count, res.queued)),
      });
      this.persistAndEmit(s);
      this.deps.notify({
        title: s.name,
        body: describeProposalNotification(res.count, res.queued),
      });
      return;
    }

    const res = await this.deps.launcher.startRun({
      flowId: s.target.flowId,
      projectPath: s.projectPath,
      // The chained case is the whole reason this feature is worth having:
      // the schedule's prompt is fixed at edit time, so without the upstream
      // output folded in, the downstream flow starts blind.
      userPrompt: opts.chain ? chainedPrompt(s, opts.chain.upstream) : s.target.prompt,
      runIn,
      baseBranch: runIn === 'worktree' ? s.target.baseBranch : undefined,
      scheduleId: s.id,
      scheduleName: s.name,
      chainDepth: opts.chain?.depth,
      chainParentRunId: opts.chain?.upstream.id,
      // Titled from the BASE prompt, not the composed one — otherwise every
      // chained run would be titled with the first line of its predecessor's
      // output instead of what it was asked to do.
      title: scheduledRunTitle(sequence, s.target.prompt),
    });
    if (!res.ok) {
      this.record(s, { at: this.now(), outcome: 'failed', note: res.error });
      this.persistAndEmit(s);
      this.deps.notify({ title: `${s.name} failed to start`, body: res.error });
      return;
    }
    s.activeRunId = res.runId;
    this.runToSchedule.set(res.runId, s.id);
    this.record(s, { at: this.now(), outcome: 'launched', runId: res.runId, note: lateNote });
    this.persistAndEmit(s);

    // A run that finished synchronously (an immediate preflight abort inside
    // the runtime) would already have emitted its terminal update before we
    // recorded `activeRunId` above, and the update handler would have found no
    // owner. Re-check now that the mapping exists — same race the orchestrator
    // guards after its own launches.
    const cur = this.deps.launcher.getRun(res.runId);
    if (cur && isTerminal(cur)) this.onRunUpdate(cur);
  }

  // ---- RUN LIFECYCLE ----------------------------------------------------

  /// Called for every flow run update. Two independent jobs, and the order
  /// matters: settle the run with the schedule that OWNS it first (clearing
  /// the overlap guard), then fan the completion out to any schedule WATCHING
  /// its flow. Doing it the other way round would let a chained firing see a
  /// stale `activeRunId` and decline itself as busy.
  onRunUpdate(run: FlowRun): void {
    this.settleOwnedRun(run);
    void this.fireChainedSchedules(run);
  }

  /// Fan a terminal run out to every enabled `onFlowComplete` schedule
  /// watching its flow.
  ///
  /// Deliberately NOT gated on `runToSchedule` — reacting to runs this engine
  /// did NOT start is the entire point. A manual run, a run from another
  /// schedule, and a Worker's run all count, because what the user wired up
  /// was "when this flow finishes", not "when I remember to run it". The run
  /// firehose already arrives here (`src/main/index.ts` calls this for every
  /// update), so nothing upstream had to change.
  private async fireChainedSchedules(run: FlowRun): Promise<void> {
    if (!isTerminal(run)) return;
    const succeeded = run.state.kind === 'done' && run.state.success === true;
    // Snapshot: firing mutates the map, and `remove` can land from IPC while
    // we await a launch.
    for (const s of [...this.schedules.values()]) {
      if (!this.schedules.has(s.id)) continue;
      if (!s.enabled) continue;
      if (s.trigger.kind !== 'onFlowComplete') continue;
      if (s.trigger.watchFlowId !== run.flowId) continue;
      if (s.trigger.onOutcome === 'success' && !succeeded) continue;
      // Runtime backstop for the self-chain `validateSchedule` refuses at edit
      // time: a schedule whose own output re-triggers it is a loop that only
      // the depth cap would stop, five wasted runs at a time.
      if (run.scheduleId === s.id) continue;

      // Orchestrate targets are deliberately NOT chainable yet. Their child
      // runs are minted by the orchestrator, which does not carry
      // `chainDepth` — so a chain routed through one would reset its own hop
      // counter and escape MAX_CHAIN_DEPTH entirely. Declining out loud beats
      // a cap with a hole in it.
      if (s.target.kind !== 'flow') {
        this.record(s, {
          at: this.now(),
          outcome: 'skipped',
          note: 'Chaining is only supported for single-flow targets.',
        });
        this.persistAndEmit(s);
        continue;
      }

      const depth = (run.chainDepth ?? 0) + 1;
      if (depth > MAX_CHAIN_DEPTH) {
        this.record(s, {
          at: this.now(),
          outcome: 'skipped',
          note: `Chain stopped at ${MAX_CHAIN_DEPTH} hops — the limit that keeps a mis-wired pair of schedules from firing forever.`,
        });
        this.persistAndEmit(s);
        continue;
      }

      if (this.firing.has(s.id)) continue;
      // Overlap policy still applies, but only the part that means something
      // here. `queue`'s deferral is anchored to a missed OCCURRENCE, and an
      // event-driven schedule has none — so `queue` and `replace` both fire
      // (fireInner does the aborting for `replace`) and only `skip` declines.
      if (this.isBusy(s) && s.onOverlap === 'skip') {
        this.record(s, {
          at: this.now(),
          outcome: 'skipped',
          note: 'Previous run was still going.',
        });
        this.persistAndEmit(s);
        continue;
      }

      await this.fire(s, { chain: { depth, upstream: run } });
    }
  }

  /// Settle a terminal run with the schedule that launched it: clear the
  /// overlap guard, record the outcome, notify. Runs this engine did not start
  /// fall through immediately.
  private settleOwnedRun(run: FlowRun): void {
    const scheduleId = this.runToSchedule.get(run.id);
    if (!scheduleId) return;
    if (!isTerminal(run)) return;
    const s = this.schedules.get(scheduleId);
    this.runToSchedule.delete(run.id);
    if (!s) return;
    if (s.activeRunId === run.id) s.activeRunId = undefined;

    const ok = run.state.kind === 'done' && run.state.success;
    this.record(s, {
      at: this.now(),
      outcome: ok ? 'done' : 'failed',
      runId: run.id,
      note: ok ? undefined : describeFailure(run),
    });
    this.persistAndEmit(s);
    this.deps.notify({
      title: ok ? `${s.name} finished` : `${s.name} did not finish`,
      body: `${run.flowSnapshot.name} · ${describeTrigger(s.trigger)}`,
    });

    // A deferred firing has been waiting for exactly this moment.
    if (s.pendingSince !== undefined) void this.tick();
    else this.arm();
  }

  // ---- INTERNALS --------------------------------------------------------

  /// Where the firing actually works. A `worktree` target against a directory
  /// that isn't a git repo degrades to `cwd` instead of failing preflight.
  ///
  /// Not every scheduled flow is a code change. Plenty are "pull the overnight
  /// numbers", "sync the tracker", "check the deploy" — they run against a
  /// scratch directory or a data folder, touch external systems, and have no
  /// repo to fork. Refusing those because the target defaults to `worktree`
  /// would be the tool being pedantic about an assumption the user never made.
  /// Where a repo DOES exist, the isolation still applies.
  private effectiveRunIn(s: Schedule): 'cwd' | 'worktree' {
    if (s.target.runIn !== 'worktree') return 'cwd';
    return this.deps.isGitRepo(s.projectPath) ? 'worktree' : 'cwd';
  }

  /// True while a run this schedule started is still going. Reads through to
  /// the runtime rather than trusting `activeRunId`, so a run that ended
  /// without us seeing the update (or one lost to a restart) can't wedge the
  /// schedule as permanently busy.
  private isBusy(s: Schedule): boolean {
    if (!s.activeRunId) return false;
    const run = this.deps.launcher.getRun(s.activeRunId);
    if (!run || isTerminal(run)) {
      this.runToSchedule.delete(s.activeRunId);
      s.activeRunId = undefined;
      return false;
    }
    return true;
  }

  private record(s: Schedule, entry: ScheduleRunRecord): void {
    // A run's `launched` entry is superseded by its terminal one — keeping
    // both would double every firing in the history.
    const priorIndex =
      entry.runId !== undefined
        ? s.history.findIndex((h) => h.runId === entry.runId && h.outcome === 'launched')
        : -1;
    if (priorIndex >= 0) s.history.splice(priorIndex, 1);
    s.history.unshift(entry);
    if (s.history.length > SCHEDULE_HISTORY_LIMIT) {
      s.history.length = SCHEDULE_HISTORY_LIMIT;
    }
  }

  private persistAndEmit(s: Schedule): void {
    this.store.save(s);
    this.deps.emit({ type: 'scheduleUpdate', schedule: s, nextFireAt: this.nextFireAt(s.id) });
  }
}

/// Why one firing happened. `chain` is set only for an `onFlowComplete`
/// firing and carries both halves the downstream run needs: how deep the chain
/// already is, and the run whose output it inherits.
interface FireOpts {
  late?: boolean;
  manual?: boolean;
  chain?: { depth: number; upstream: FlowRun };
}

/// The prompt a chained run actually receives.
///
/// Falls back to the schedule's fixed prompt in the two cases where handoff
/// would be noise rather than context: the trigger opted out, or the upstream
/// run produced nothing (a run that failed before its first step finished has
/// no artifacts at all, and an empty block teaches the downstream model
/// nothing except that something went wrong).
function chainedPrompt(s: Schedule, upstream: FlowRun): string {
  const base = s.target.prompt;
  if (s.trigger.kind !== 'onFlowComplete') return base;
  if (s.trigger.passOutput === false) return base;
  const artifact = latestArtifact(upstream.artifacts);
  if (!artifact) return base;
  return composeChainedPrompt(base, {
    flowName: upstream.flowSnapshot?.name || upstream.flowId,
    artifactName: artifact.name,
    body: artifact.body,
  });
}

function isTerminal(run: FlowRun): boolean {
  const k = run.state.kind;
  return k === 'done' || k === 'aborted' || k === 'archived';
}

function describeFailure(run: FlowRun): string {
  if (run.state.kind === 'aborted') return 'Run aborted.';
  if (run.state.kind === 'done' && !run.state.success) return 'Run finished unsuccessfully.';
  return 'Run ended without completing.';
}

/// History line for an `orchestrate` firing. The split between launched and
/// held is the part worth reading later — "8 proposed" alone doesn't say
/// whether anything is burning tokens right now.
function describeProposal(count: number, queued: number): string {
  if (count === 0) return 'Nothing to propose.';
  if (queued === 0) return `${count} proposed — waiting for approval.`;
  const held = count - queued;
  if (held === 0) return `${count} proposed — ${queued} launched.`;
  return `${count} proposed — ${queued} launched, ${held} waiting for approval.`;
}

function describeProposalNotification(count: number, queued: number): string {
  if (count === 0) return 'Nothing new to propose.';
  const held = count - queued;
  if (queued === 0) {
    return `${count} ${plural(count, 'candidate')} waiting for your approval in Orchestrator.`;
  }
  if (held === 0) return `${queued} ${plural(queued, 'run')} launched in Orchestrator.`;
  return `${queued} launched, ${held} waiting for your approval in Orchestrator.`;
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

function joinNotes(...parts: Array<string | undefined>): string | undefined {
  const kept = parts.filter((p): p is string => !!p);
  return kept.length > 0 ? kept.join(' ') : undefined;
}
