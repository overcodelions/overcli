// Scheduled runs data model. A Schedule is a *trigger* bolted onto work the
// user has already defined — it is not a new kind of run. Firing one either
// launches an ordinary FlowRun or asks the orchestrator producer for
// candidates and PARKS the resulting batch for approval.
//
// That asymmetry is the whole design. Launching a flow on a timer is a
// bounded, reviewable commitment: one worktree, one run, the user reads the
// diff afterwards. Dispatching a whole orchestrator batch unattended is not —
// the producer decides how many child runs exist, so a bad morning could fork
// a dozen worktrees and burn tokens with nobody watching. So by default a
// scheduled orchestration stops at the proposal: the batch lands in `proposed`
// and waits (see OrchestrationItemStatus in ./orchestration).
//
// `autoApprove` opts out of the waiting, but not out of the bound: it carries
// a per-firing item cap, so the unattended commitment stays finite no matter
// what the producer decides overnight. Overflow parks exactly as it would
// have. See ScheduleOrchestrateTarget below.
//
// Lives in `shared` so the main-process engine and the renderer agree on the
// shapes that cross IPC, and so the firing arithmetic below is unit-testable
// without Electron.

import type { UUID } from '../types';
import type { RunIn } from './orchestration';

/// How often a schedule fires.
///
/// Deliberately NOT cron. Cron's expressiveness is mostly wasted here (nobody
/// schedules a coding agent for "the 3rd Tuesday at 4:07") and it costs a
/// parser plus a syntax the user has to be taught. These two shapes cover
/// what people actually ask for, and both render back to plain English.
export type ScheduleTrigger =
  /// Fire every `everyMinutes` minutes, measured from the last fire (or from
  /// when the schedule was armed, if it has never fired) — but only inside the
  /// active window, if one is set. "Every hour, weekdays, 8am–5pm" is the
  /// shape this exists for: a repeating check that shouldn't run overnight or
  /// at the weekend.
  | {
      kind: 'interval';
      everyMinutes: number;
      /// Weekdays it may fire on, `0` = Sunday … `6` = Saturday. Empty or
      /// absent means every day.
      days?: number[];
      /// Hours of the day it may fire between, local `"HH:MM"`, both ends
      /// inclusive — an 8:00–17:00 hourly schedule fires at 17:00. Absent
      /// means all day. A `start` after `end` wraps midnight (22:00–02:00),
      /// and the day set then applies to the evening half: "Fri 22:00–02:00"
      /// includes Saturday 01:00.
      window?: { start: string; end: string };
    }
  /// Fire at a wall-clock time of day, on the given weekdays.
  | {
      kind: 'daily';
      /// 24h local time, `"HH:MM"`.
      time: string;
      /// Weekdays this may fire on, `0` = Sunday … `6` = Saturday. Empty or
      /// absent means every day.
      days?: number[];
    }
  /// Fire when a run of ANOTHER flow finishes. The one trigger here with no
  /// clock in it: it has no next occurrence, contributes nothing to the
  /// engine's nearest-due-time arithmetic, and is driven entirely by
  /// `SchedulerEngine.onRunUpdate` seeing a terminal run.
  ///
  /// This is what turns two schedules into a pipeline — "when the nightly
  /// scrape finishes, triage what it found".
  | {
      kind: 'onFlowComplete';
      /// Flow whose runs we watch. Matched against `FlowRun.flowId`, so ANY
      /// run of that flow fires this — manual, time-scheduled, or itself
      /// chained from a third flow.
      watchFlowId: string;
      /// `success` fires only on `{kind:'done', success:true}`. `any` fires on
      /// every terminal state, including failure and abort — the shape a
      /// cleanup or notify step wants, since it has to run either way.
      onOutcome: 'success' | 'any';
      /// Append what the upstream run produced to this schedule's fixed
      /// prompt. Absent means TRUE: this trigger kind is new, so there is no
      /// legacy behaviour to protect, and a pipeline that silently drops its
      /// payload is the surprising default. See `composeChainedPrompt`.
      passOutput?: boolean;
    };

/// The clock-based triggers — every variant that has a next occurrence, a day
/// set, and a place on a calendar.
///
/// Worth a name because several surfaces genuinely cannot accept anything
/// else: a Worker's cadence (a worker with no clock never wakes — see
/// `validateWorker`) and the shift-calendar projection both assume a time
/// axis. Narrowing to this is more honest than widening those to a trigger
/// they would silently mishandle.
export type TimedTrigger = Exclude<ScheduleTrigger, { kind: 'onFlowComplete' }>;

/// Launch one flow run with a fixed prompt. The plain case.
export interface ScheduleFlowTarget {
  kind: 'flow';
  flowId: string;
  /// The `user_prompt` handed to the run. Fixed at edit time — a schedule
  /// fires with nobody there to type anything.
  prompt: string;
  runIn: RunIn;
  /// Only meaningful when `runIn === 'worktree'`.
  baseBranch?: string;
}

/// Run the orchestrator's producer turn and park what it finds. Dispatches on
/// its own only when `autoApprove` is set, and even then only up to its cap —
/// see the file header.
export interface ScheduleOrchestrateTarget {
  kind: 'orchestrate';
  /// The producer seed prompt ("pull new ProductBoard feedback and triage…").
  prompt: string;
  /// Flow every proposed candidate is mapped to in the parked batch. The user
  /// can remap per item before approving; this is just the default, because
  /// there is nobody around to choose one at fire time.
  flowId: string;
  runIn: RunIn;
  baseBranch?: string;
  /// Concurrency the batch will use once released — by approval, or by
  /// `autoApprove` below.
  maxConcurrent: number;
  /// Launch the batch as soon as the producer returns, instead of parking it.
  /// Absent — the default — parks, and nothing runs until a human approves.
  ///
  /// `maxItems` is required rather than optional, and that is the point. The
  /// hazard here was never "a scheduled batch launched", it was "the producer
  /// decided at 3am that there were thirty things to do". A cap turns that
  /// from an unbounded fork into launch the first N, park the rest: overflow
  /// items stay `proposed` and wait for a human exactly as the whole batch
  /// would have. `maxConcurrent` does not do this job — it limits how many run
  /// at once, not how much work is committed to.
  autoApprove?: { maxItems: number };
}

/// Ceiling on `autoApprove.maxItems`. An unattended firing is allowed to be
/// large, but not unbounded — past this the user should be looking at the list
/// rather than raising the number.
export const SCHEDULE_AUTO_APPROVE_MAX = 20;

export type ScheduleTarget = ScheduleFlowTarget | ScheduleOrchestrateTarget;

/// What to do when a schedule comes due while its previous run is still going.
export type ScheduleOverlapPolicy =
  /// Do nothing this time around; try again at the next occurrence. Default,
  /// and the right answer for anything that might run long.
  | 'skip'
  /// Remember that it came due and fire as soon as the in-flight run ends.
  /// At most one is remembered — five missed occurrences do not become five
  /// queued runs.
  | 'queue'
  /// Abort the in-flight run and start a fresh one.
  | 'replace';

/// What to do about occurrences that passed while the app was closed.
export type ScheduleCatchUpPolicy =
  /// Pretend they never happened; wait for the next fresh occurrence.
  | 'skip'
  /// Fire ONE catch-up run, however many occurrences were missed. Three
  /// missed mornings produce one run, not three.
  | 'once';

/// One entry in a schedule's history. Deliberately thin — it points at the
/// run/batch rather than copying it, so the history stays small no matter how
/// long the schedule lives.
export interface ScheduleRunRecord {
  at: number;
  /// `skipped` means we consciously declined to fire (overlap or catch-up
  /// policy), and is recorded rather than swallowed so a schedule that looks
  /// idle can explain itself.
  outcome: 'launched' | 'done' | 'failed' | 'skipped';
  runId?: UUID;
  /// Set for an `orchestrate` target — the batch that was parked.
  orchestrationId?: UUID;
  /// Short human explanation. Always present for `skipped` and `failed`.
  note?: string;
}

export interface Schedule {
  id: UUID;
  name: string;
  enabled: boolean;
  /// Project (or workspace root) the target runs against.
  projectPath: string;
  target: ScheduleTarget;
  trigger: ScheduleTrigger;
  onOverlap: ScheduleOverlapPolicy;
  catchUp: ScheduleCatchUpPolicy;
  createdAt: number;
  /// Reset whenever the trigger is edited or the schedule is re-enabled, so
  /// "every 4 hours" restarts its clock from the change instead of firing
  /// immediately off a stale `createdAt`.
  anchorAt?: number;
  /// Last time it actually fired (not counting skips).
  lastFiredAt?: number;
  /// Set when `onOverlap: 'queue'` deferred a firing. Cleared when it fires.
  pendingSince?: number;
  /// The run currently in flight from this schedule, if any.
  activeRunId?: UUID;
  /// How many times this schedule has fired, ever. Only ever increments —
  /// it's the sequence number stamped into each run's title, so reusing one
  /// would put two identically-named runs in the list, which is the exact
  /// problem it exists to solve. Independent of `history`, which is capped and
  /// forgets its tail.
  runCount?: number;
  /// Newest first, capped at SCHEDULE_HISTORY_LIMIT.
  history: ScheduleRunRecord[];
}

/// How many past firings a schedule remembers.
export const SCHEDULE_HISTORY_LIMIT = 20;

/// A firing this far past its due time is still "on time". Without a grace
/// window a schedule that comes due a few milliseconds before the timer wakes
/// would be classed as late and handed to the catch-up policy — which for
/// `catchUp: 'skip'` would silently skip every single occurrence.
export const SCHEDULE_GRACE_MS = 60_000;

/// The slice of a Schedule the firing arithmetic actually reads. Widened to a
/// structural type so the Worker engine (whose cadence is a ScheduleTrigger
/// but whose record is not a Schedule) reuses `evaluateSchedule` instead of
/// growing a second copy of the missed-while-asleep / due-mid-run logic.
export interface ScheduleTiming {
  enabled: boolean;
  trigger: ScheduleTrigger;
  onOverlap: 'skip' | 'queue' | 'replace';
  catchUp: 'skip' | 'once';
  createdAt: number;
  anchorAt?: number;
  lastFiredAt?: number;
  pendingSince?: number;
}

/// The point a schedule measures its next occurrence from.
export function scheduleAnchor(s: ScheduleTiming): number {
  return s.lastFiredAt ?? s.anchorAt ?? s.createdAt;
}

/// Next occurrence strictly after `afterMs`, in local wall-clock time.
///
/// Local, not UTC, and that is the point: "every weekday at 9am" means 9am
/// where the user is, on both sides of a daylight-saving switch. Building the
/// candidate with the local `Date` constructor gets that for free. (The one
/// oddity: on a spring-forward day a time inside the skipped hour doesn't
/// exist, and JS normalizes it forward — 02:30 fires at 03:30. That's the
/// least surprising of the available wrong answers.)
/// An `onFlowComplete` trigger has no occurrence at all and returns
/// `Infinity`. That is not a sentinel for "very far away" — it is what keeps
/// the schedule out of `SchedulerEngine.arm`'s nearest-due-time reduction,
/// which bails on a non-finite minimum and arms no timer.
export function nextOccurrenceAfter(trigger: ScheduleTrigger, afterMs: number): number {
  if (trigger.kind === 'interval') return nextIntervalOccurrence(trigger, afterMs);
  if (trigger.kind === 'onFlowComplete') return Number.POSITIVE_INFINITY;
  const parsed = parseTimeOfDay(trigger.time);
  const { hours, minutes } = parsed ?? { hours: 9, minutes: 0 };
  const days = allowedDays(trigger.days);
  const from = new Date(afterMs);
  // 8 days, not 7: the candidate built for day-offset 0 is usually already in
  // the past, so a once-a-week schedule needs one extra day of runway to find
  // the same weekday again.
  for (let offset = 0; offset <= 8; offset++) {
    const cand = new Date(
      from.getFullYear(),
      from.getMonth(),
      from.getDate() + offset,
      hours,
      minutes,
      0,
      0,
    );
    const at = cand.getTime();
    if (at <= afterMs) continue;
    if (!days.has(cand.getDay())) continue;
    return at;
  }
  // Unreachable for any non-empty day set, but never return something in the
  // past — a caller would treat it as due and fire in a loop.
  return afterMs + 24 * 60 * 60_000;
}

/// Next interval tick that lands inside the active window.
///
/// Step first, then check: if the stepped candidate falls outside the window
/// (evening, weekend), jump to the next time the window opens rather than
/// stepping through the closed hours one interval at a time. That also
/// re-phases each day to the window's start — an 8am–5pm hourly schedule armed
/// at 8:37 fires on the half hour today and from 8:00 sharp tomorrow, which is
/// what "every hour, 8 to 5" means to a person.
function nextIntervalOccurrence(
  trigger: Extract<ScheduleTrigger, { kind: 'interval' }>,
  afterMs: number,
): number {
  const stepMs = Math.max(1, Math.floor(trigger.everyMinutes)) * 60_000;
  const candidate = afterMs + stepMs;
  const days = allowedDays(trigger.days);
  const window = parseWindow(trigger.window);
  // Unrestricted: the common case, and no date arithmetic needed for it.
  if (!window && days.size === 7) return candidate;
  if (isWithinActiveWindow(candidate, days, window)) return candidate;
  return nextWindowOpening(candidate, days, window);
}

interface ParsedWindow {
  startMinutes: number;
  endMinutes: number;
}

function parseWindow(window: { start: string; end: string } | undefined): ParsedWindow | null {
  if (!window) return null;
  const start = parseTimeOfDay(window.start);
  const end = parseTimeOfDay(window.end);
  // An unparseable window is treated as no window rather than as a window that
  // never opens — a typo shouldn't silently stop a schedule forever.
  if (!start || !end) return null;
  return {
    startMinutes: start.hours * 60 + start.minutes,
    endMinutes: end.hours * 60 + end.minutes,
  };
}

/// Is `at` a moment the schedule is allowed to fire?
export function isWithinActiveWindow(
  at: number,
  days: Set<number>,
  window: ParsedWindow | null,
): boolean {
  const d = new Date(at);
  const minutes = d.getHours() * 60 + d.getMinutes();
  if (!window) return days.has(d.getDay());
  if (window.startMinutes <= window.endMinutes) {
    return (
      days.has(d.getDay()) &&
      minutes >= window.startMinutes &&
      minutes <= window.endMinutes
    );
  }
  // Wraps midnight. The window belongs to the day it OPENED on, so the small
  // hours are governed by yesterday's entry in the day set — "Fri 22:00–02:00"
  // has to include Saturday 01:00, and must not include Saturday 23:00.
  if (minutes >= window.startMinutes) return days.has(d.getDay());
  if (minutes <= window.endMinutes) return days.has((d.getDay() + 6) % 7);
  return false;
}

/// Earliest moment at or after `from` that the window opens on an allowed day.
function nextWindowOpening(
  from: number,
  days: Set<number>,
  window: ParsedWindow | null,
): number {
  const startMinutes = window?.startMinutes ?? 0;
  const base = new Date(from);
  for (let offset = 0; offset <= 8; offset++) {
    const cand = new Date(
      base.getFullYear(),
      base.getMonth(),
      base.getDate() + offset,
      Math.floor(startMinutes / 60),
      startMinutes % 60,
      0,
      0,
    );
    // `<` not `<=`: `from` is already past the caller's `afterMs`, so an
    // opening landing exactly on it is a legitimate next occurrence.
    if (cand.getTime() < from) continue;
    if (!days.has(cand.getDay())) continue;
    return cand.getTime();
  }
  return from + 24 * 60 * 60_000;
}

/// What the engine should do with a schedule right now. Pure, so the awkward
/// cases (missed while asleep, due during a long run) are testable without a
/// clock or a subprocess.
export type ScheduleDecision =
  /// Nothing to do until `at`.
  | { action: 'wait'; at: number }
  /// Fire now. `late` marks a catch-up firing, for the history note.
  | { action: 'fire'; dueAt: number; late: boolean }
  /// It came due but we're declining. `nextAt` is when we'll look again.
  | { action: 'skip'; dueAt: number; nextAt: number; reason: string };

export function evaluateSchedule(
  s: ScheduleTiming,
  now: number,
  opts: { busy?: boolean; awakeSince?: number } = {},
): ScheduleDecision {
  if (!s.enabled) return { action: 'wait', at: Number.POSITIVE_INFINITY };

  // Event-driven, so never "due". It fires from `onRunUpdate` when a watched
  // run goes terminal; reporting a due time here would put it into the timer
  // arithmetic and wake the engine for a schedule no clock can satisfy. This
  // also means the overlap and catch-up policies below never apply to it —
  // there is no occurrence to miss and none to defer.
  if (s.trigger.kind === 'onFlowComplete') {
    return { action: 'wait', at: Number.POSITIVE_INFINITY };
  }

  // A firing deferred by `onOverlap: 'queue'` owes the user a run the moment
  // the tree is free, regardless of where the next occurrence falls.
  if (s.pendingSince !== undefined && !opts.busy) {
    return { action: 'fire', dueAt: s.pendingSince, late: true };
  }

  const dueAt = nextOccurrenceAfter(s.trigger, scheduleAnchor(s));
  if (dueAt > now) return { action: 'wait', at: dueAt };

  const late = now - dueAt > SCHEDULE_GRACE_MS;

  if (opts.busy) {
    const nextAt = nextOccurrenceAfter(s.trigger, now);
    if (s.onOverlap === 'skip') {
      return {
        action: 'skip',
        dueAt,
        nextAt,
        reason: 'Previous run was still going.',
      };
    }
    // 'queue' and 'replace' both want to run; the engine handles the
    // difference (defer vs abort-and-relaunch), so both report `fire`.
    return { action: 'fire', dueAt, late };
  }

  // `late` alone does not mean the occurrence was missed — only that nobody
  // looked at it in time. An engine that walks its roster serially spends
  // minutes inside one entry's turn, and everything behind it comes due while
  // it is running. Those occurrences were not missed while overcli was
  // closed; overcli was right here, busy. `awakeSince` is the moment the
  // caller knows it was awake and looking (its tick start), so anything due
  // at or after it fires late instead of being written off. Without this the
  // last entries on a long roster starve: skipped, re-anchored to now, and
  // skipped again on the next pass, forever.
  //
  // Compared against `awakeSince` MINUS the grace window, not `awakeSince`
  // itself. The tick that services an occurrence is armed to wake at its due
  // time, so it enters the callback a few milliseconds AFTER it — making
  // `dueAt < awakeSince` true for the very slot the guard exists to protect,
  // and writing off every worker that shares a due time with a slower one
  // ahead of it. The same grace that decides `late` decides this.
  const missedWhileClosed =
    late &&
    (opts.awakeSince === undefined || dueAt < opts.awakeSince - SCHEDULE_GRACE_MS);

  if (missedWhileClosed && s.catchUp === 'skip') {
    return {
      action: 'skip',
      dueAt,
      nextAt: nextOccurrenceAfter(s.trigger, now),
      reason: 'Missed while overcli was closed.',
    };
  }
  return { action: 'fire', dueAt, late };
}

/// Plain-English rendering of a trigger, for the schedules list and the
/// notification body. Shared so the two never drift.
export function describeTrigger(trigger: ScheduleTrigger): string {
  if (trigger.kind === 'interval') {
    const mins = Math.max(1, Math.floor(trigger.everyMinutes));
    const every =
      mins % 60 === 0
        ? mins / 60 === 1
          ? 'Every hour'
          : `Every ${mins / 60} hours`
        : mins === 1
          ? 'Every minute'
          : `Every ${mins} minutes`;
    // "Every hour, weekdays 8am–5pm". Both qualifiers are optional and the
    // sentence has to read cleanly with either, both, or neither.
    const dayPart = describeDays(trigger.days);
    const windowPart = trigger.window
      ? `${formatTimeOfDay(trigger.window.start)}–${formatTimeOfDay(trigger.window.end)}`
      : '';
    const qualifier = [dayPart, windowPart].filter(Boolean).join(' ');
    return qualifier ? `${every}, ${qualifier}` : every;
  }
  if (trigger.kind === 'onFlowComplete') {
    // `watchFlowId` is a flow id, not a name — the same rawness `describeTarget`
    // already has. The pane substitutes the real name where it has the list.
    const what = trigger.watchFlowId || 'another flow';
    return trigger.onOutcome === 'success'
      ? `When ${what} succeeds`
      : `When ${what} finishes`;
  }
  const time = formatTimeOfDay(trigger.time);
  const dayPart = describeDays(trigger.days);
  return dayPart ? `${capitalize(dayPart)} at ${time}` : `Every day at ${time}`;
}

/// `'weekdays'` / `'Mon, Wed, Fri'` / `''` for "every day". Lower case so it
/// reads inside a sentence; callers capitalize when it leads one.
function describeDays(days: number[] | undefined): string {
  const list = days ?? [];
  if (list.length === 0 || list.length === 7) return '';
  if (isWeekdaySet(list)) return 'weekdays';
  if (isWeekendSet(list)) return 'weekends';
  return [...list].sort((a, b) => a - b).map((d) => DAY_NAMES[d] ?? '?').join(', ');
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const WEEKDAY_SET = [1, 2, 3, 4, 5];

function isWeekdaySet(days: number[]): boolean {
  const set = new Set(days);
  return set.size === 5 && WEEKDAY_SET.every((d) => set.has(d));
}

function isWeekendSet(days: number[]): boolean {
  const set = new Set(days);
  return set.size === 2 && set.has(0) && set.has(6);
}

function allowedDays(days: number[] | undefined): Set<number> {
  const valid = (days ?? []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  return valid.length > 0 ? new Set(valid) : new Set([0, 1, 2, 3, 4, 5, 6]);
}

/// `"09:30"` → `{hours: 9, minutes: 30}`. Null for anything unparseable, so
/// callers can fall back rather than schedule at NaN.
export function parseTimeOfDay(time: string): { hours: number; minutes: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((time ?? '').trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return { hours, minutes };
}

function formatTimeOfDay(time: string): string {
  const parsed = parseTimeOfDay(time);
  if (!parsed) return time;
  const { hours, minutes } = parsed;
  const suffix = hours < 12 ? 'am' : 'pm';
  const h12 = hours % 12 === 0 ? 12 : hours % 12;
  return minutes === 0 ? `${h12}${suffix}` : `${h12}:${String(minutes).padStart(2, '0')}${suffix}`;
}

/// "in 3h" for a pending firing. The useful question about a schedule that
/// hasn't fired yet is how far away it is, not what o'clock it lands at — and
/// a countdown is what proves an idle schedule is actually alive rather than
/// forgotten. Shared so the title bar, the library strip and the schedules
/// list all phrase it identically.
export function untilLabel(at: number, now: number = Date.now()): string {
  const diff = at - now;
  if (diff <= 0) return 'due now';
  if (diff < 60_000) return 'in under a minute';
  if (diff < 3_600_000) return `in ${Math.round(diff / 60_000)}m`;
  if (diff < 86_400_000) return `in ${Math.round(diff / 3_600_000)}h`;
  return `in ${Math.round(diff / 86_400_000)}d`;
}

/// Title for a run (or parked batch) a schedule produced.
///
/// A scheduled prompt is fixed by definition, and `flowRunTitle` falls back to
/// the prompt's first line — so without this every morning's run is titled
/// identically and the library becomes a wall of the same sentence. The
/// `[SR-n]` prefix makes each occurrence nameable: "SR-12 went wrong", not
/// "the changelog one from, I think, Tuesday?".
///
/// `n` counts firings of THIS schedule, not runs globally. Two schedules will
/// both have an SR-1, which is the deliberate trade: an ordinal is only worth
/// reading if it means something, and "the 12th morning triage" is a fact
/// about the schedule. Runs already carry `scheduleName` for the badge that
/// tells the two apart.
export function scheduledRunTitle(sequence: number, prompt: string): string {
  const tag = `[SR-${sequence}]`;
  const firstLine = (prompt ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return firstLine ? `${tag} ${firstLine}` : tag;
}

/// How many `onFlowComplete` hops a chain may take before the engine refuses
/// to extend it. A→B→C→D→E is five runs; a sixth is declined and the reason is
/// written into the schedule's history rather than swallowed.
///
/// Worth recording why a DEPTH cap: GitHub Actions suppresses workflow
/// recursion by IDENTITY (an event authored by GITHUB_TOKEN does not start
/// another run), and agent frameworks cap TURNS inside a single run
/// (LangGraph's `recursion_limit`, the OpenAI Agents SDK's `max_turns`).
/// Neither bounds a chain of separate runs. A counter carried on the run
/// degrades after N hops instead of forbidding the first one, which is the
/// failure mode users actually complain about in the identity-based design.
export const MAX_CHAIN_DEPTH = 5;

/// Ceiling on how much upstream output is pasted into a chained run's prompt.
/// A `diff` artifact can be megabytes; the downstream model pays for every
/// byte, and a truncated head beats a blown context window.
export const CHAIN_OUTPUT_MAX_CHARS = 8_000;

/// The upstream artifact a chained run should be handed: the most recently
/// produced non-empty one.
///
/// Keyed on `producedAt` rather than "whatever the last step declared as its
/// output". Two steps may legitimately share an output name (see
/// `FlowStepAttempt.artifact` in schema.ts), and a run can stop early on a
/// failing step — in both cases the newest artifact is the one that says where
/// the run actually got to, and finding it needs no walk over the flow shape.
///
/// Structurally typed rather than importing `FlowArtifact`, to keep this
/// module free of any dependency on the run schema.
export function latestArtifact(
  artifacts: Record<string, { name: string; body: string; producedAt: number }> | undefined,
): { name: string; body: string } | null {
  let best: { name: string; body: string; producedAt: number } | null = null;
  for (const a of Object.values(artifacts ?? {})) {
    if (!a || typeof a.body !== 'string' || a.body.length === 0) continue;
    if (!best || a.producedAt > best.producedAt) best = a;
  }
  return best ? { name: best.name, body: best.body } : null;
}

/// Build the prompt for a chained run: the schedule's own fixed prompt, plus
/// what the upstream run actually produced.
///
/// This is the difference between a trigger and a pipeline. A schedule's
/// prompt is fixed at edit time because nobody is there to type one — so
/// without this, the triage flow launched by "when the scrape finishes" would
/// start with no idea what was scraped, and the user would have built a
/// causal edge that carries no data.
export function composeChainedPrompt(
  basePrompt: string,
  upstream: { flowName: string; artifactName: string; body: string },
): string {
  const body = upstream.body ?? '';
  const clipped =
    body.length > CHAIN_OUTPUT_MAX_CHARS
      ? `${body.slice(0, CHAIN_OUTPUT_MAX_CHARS)}\n\n[…truncated at ${CHAIN_OUTPUT_MAX_CHARS} characters]`
      : body;
  return [
    basePrompt,
    '',
    '---',
    '',
    `UPSTREAM CONTEXT — the flow "${upstream.flowName}" just finished and produced ` +
      `"${upstream.artifactName}". That output follows. Treat it as the input to your ` +
      'work rather than re-deriving it.',
    '',
    clipped,
  ].join('\n');
}

/// Short label for what a firing does, used in the list row and history.
export function describeTarget(target: ScheduleTarget): string {
  return target.kind === 'flow'
    ? `Runs ${target.flowId}`
    : `Proposes a batch of ${target.flowId} runs`;
}

/// Validation shared by the IPC handler and the editor, so the UI can disable
/// Save for exactly the reasons main would reject it.
export function validateSchedule(s: Partial<Schedule>): string | null {
  if (!s.name?.trim()) return 'Give the schedule a name.';
  if (!s.projectPath?.trim()) return 'Pick a project to run against.';
  const target = s.target;
  if (!target) return 'Pick what this schedule runs.';
  if (!target.flowId?.trim()) return 'Pick a flow.';
  if (!target.prompt?.trim()) {
    return target.kind === 'flow'
      ? 'A scheduled run needs a prompt — there is nobody there to type one.'
      : 'The producer needs a seed prompt.';
  }
  if (target.kind === 'orchestrate' && target.autoApprove) {
    const cap = Math.floor(target.autoApprove.maxItems);
    if (!Number.isFinite(cap) || cap < 1) {
      return 'Auto-launch needs a cap of at least one item.';
    }
    if (cap > SCHEDULE_AUTO_APPROVE_MAX) {
      return `Auto-launch is capped at ${SCHEDULE_AUTO_APPROVE_MAX} items per firing.`;
    }
  }
  const trigger = s.trigger;
  if (!trigger) return 'Pick when it runs.';
  // Must come BEFORE the time-based branches. Without it an `onFlowComplete`
  // trigger falls through to the `parseTimeOfDay(trigger.time)` check at the
  // bottom, where `time` is undefined, `(time ?? '')` swallows it, and the
  // schedule is rejected with "Time must look like 09:30." — a nonsense error
  // that typechecks perfectly.
  if (trigger.kind === 'onFlowComplete') {
    if (!trigger.watchFlowId?.trim()) return 'Pick the flow to watch.';
    // Self-chaining is an infinite loop with extra steps: the run this
    // schedule launches is itself a run of `watchFlowId`, which fires it
    // again. MAX_CHAIN_DEPTH would contain it, but five wasted runs per hop
    // is a bug to refuse at edit time, not to survive at runtime.
    if (trigger.watchFlowId === target.flowId) {
      return 'A flow cannot be chained to itself.';
    }
    return null;
  }
  if (trigger.kind === 'interval') {
    if (!Number.isFinite(trigger.everyMinutes) || trigger.everyMinutes < 1) {
      return 'Interval must be at least one minute.';
    }
    if (trigger.days && trigger.days.length === 0) {
      return 'Pick at least one day, or leave every day selected.';
    }
    if (trigger.window) {
      if (!parseTimeOfDay(trigger.window.start) || !parseTimeOfDay(trigger.window.end)) {
        return 'Active hours must look like 08:00 and 17:00.';
      }
      if (trigger.window.start === trigger.window.end) {
        return 'Active hours need a start and end that differ.';
      }
      // The step has to fit inside the window, or the schedule opens, fires
      // once at the start, steps past the close, and waits for tomorrow — a
      // "every 4 hours, 9–10am" schedule that silently means "daily at 9".
      const parsed = parseWindow(trigger.window);
      if (parsed && parsed.startMinutes < parsed.endMinutes) {
        const span = parsed.endMinutes - parsed.startMinutes;
        if (trigger.everyMinutes > span) {
          return `That interval is longer than the ${span}-minute window, so it would only fire once a day.`;
        }
      }
    }
  } else if (trigger.days && trigger.days.length === 0) {
    return 'Pick at least one day, or leave every day selected.';
  } else if (!parseTimeOfDay(trigger.time)) {
    return 'Time must look like 09:30.';
  }
  return null;
}
