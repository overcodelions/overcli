// What the app is about to do on its own — schedules and shifts, in one place.
//
// Two mechanisms run unattended and neither knows about the other: a SCHEDULE
// fires a flow or a batch on a trigger, a WORKER wakes for a shift on a
// cadence. They have separate pages, separate stores and separate vocabulary,
// but the question the user actually arrives with — "what's coming, and how
// long have I got?" — is about neither in particular.
//
// So the arithmetic lives here once. The title bar's chips and the shift
// calendar's up-next strip both read from this module, which is what stops
// them disagreeing about which occurrence is sooner or how long is left.
//
// Nothing here computes a NEXT TIME. `nextAt` always comes from the engine
// that owns the subject (`nextFireAt` for schedules, `nextShiftAt` for
// workers) for the same reason the stores don't derive it either: re-deriving
// a fire time in the renderer produces a second answer that drifts from the
// one the scheduler will actually act on.

import { isOrchestrationAwaitingApproval } from '@shared/flows/orchestration';
import type { Orchestration } from '@shared/flows/orchestration';
import { describeTrigger, untilLabel } from '@shared/flows/schedule';
import type { Schedule } from '@shared/flows/schedule';
import type { Worker } from '@shared/flows/worker';

export type AutomationSource = 'worker' | 'schedule';

/// One unattended thing, reduced to what a status readout needs. Both species
/// flatten to this shape so ordering "next worker shift" against "next
/// schedule firing" is a plain sort rather than a special case.
export interface AutomationSubject {
  source: AutomationSource;
  id: string;
  name: string;
  enabled: boolean;
  /// When it next fires, straight from the engine. Null when nothing is
  /// pending — paused, or a trigger with nowhere left to land.
  nextAt: number | null;
  /// Work in flight for this subject right now.
  running: boolean;
  /// The rule in words: "Every weekday at 09:00".
  cadence: string;
}

export interface AutomationStatus {
  tone: 'waiting' | 'running' | 'armed';
  label: string;
  title: string;
}

/// The nouns a chip uses. Passed in rather than derived from `source` because
/// the two species read differently in the same sentence — a schedule IS
/// "Scheduled", a worker HAS a "Shift" — and the chip's whole job is to name
/// its subject in the label, since a title bar gives it no context to borrow.
export interface AutomationLabels {
  /// Leads the label when one thing is involved: "Shift · in 40m".
  one: string;
  /// Leads it when several are: "Shifts · 2 to approve".
  many: string;
  /// What the tooltip counts: "3 workers armed".
  unitOne: string;
  unitMany: string;
  /// What the tooltip calls a parked batch: "A scheduled batch is waiting".
  /// The tooltip has to name its own species even when the chip's label is
  /// talking about the other one — see `headlineStatus`.
  batchAdjective: string;
}

export function scheduleSubjects(
  schedules: Record<string, Schedule>,
  nextFireAt: Record<string, number | null>,
): AutomationSubject[] {
  return Object.values(schedules).map((s) => ({
    source: 'schedule' as const,
    id: s.id,
    name: s.name,
    enabled: s.enabled,
    nextAt: nextFireAt[s.id] ?? null,
    running: Boolean(s.activeRunId),
    cadence: describeTrigger(s.trigger),
  }));
}

/// `shiftProgress` is the workers store's live planning state. Only a `shift`
/// counts as running here: an errand is something you asked for just now and
/// are already watching, so surfacing it as unattended activity would report
/// your own click back to you.
export function workerSubjects(
  workers: Record<string, Worker>,
  nextShiftAt: Record<string, number | null>,
  shiftProgress: Record<string, { task: 'shift' | 'errand' }> = {},
): AutomationSubject[] {
  return Object.values(workers).map((w) => ({
    source: 'worker' as const,
    id: w.id,
    name: w.name,
    enabled: w.enabled,
    nextAt: nextShiftAt[w.id] ?? null,
    running: shiftProgress[w.id]?.task === 'shift',
    cadence: describeTrigger(w.cadence),
  }));
}

/// Batches this species produced that are parked on the user's approval.
///
/// Scoped by origin on purpose. A batch you assembled yourself in the
/// Orchestrator is also "awaiting approval", but it is not something the app
/// did while you weren't looking — counting it would make an automation
/// indicator light up for your own unfinished work.
export function awaitingApproval(
  orchestrations: Record<string, Orchestration>,
  source: AutomationSource,
): number {
  return Object.values(orchestrations).filter(
    (o) => o.origin?.kind === source && isOrchestrationAwaitingApproval(o),
  ).length;
}

/// The next few occurrences across every subject handed in, soonest first.
///
/// Overdue subjects (a `nextAt` already in the past — the app was asleep, or a
/// firing is queued behind something) stay in the list rather than being
/// filtered out: "due now" is the most urgent thing the strip can say, and
/// dropping it would make a stuck schedule look like no schedule.
export function upcomingAgenda(
  subjects: AutomationSubject[],
  limit = 3,
): AutomationSubject[] {
  return subjects
    .filter((s) => s.enabled && typeof s.nextAt === 'number')
    .sort((a, b) => (a.nextAt as number) - (b.nextAt as number))
    .slice(0, limit);
}

/// What the chip for one species has to say, in priority order. Nothing armed
/// → null, and the caller renders nothing: a permanently-lit item in the one
/// strip that's always on screen, for a feature you don't use, is just noise.
export function automationStatus(args: {
  subjects: AutomationSubject[];
  /// Batches of this species parked on approval — see `awaitingApproval`.
  waiting: number;
  labels: AutomationLabels;
  now?: number;
}): AutomationStatus | null {
  const { labels } = args;
  const now = args.now ?? Date.now();
  const armed = args.subjects.filter((s) => s.enabled);
  if (armed.length === 0) return null;

  // A parked proposal outranks a running run: one is blocked on the user, the
  // other is just working.
  if (args.waiting > 0) {
    return {
      tone: 'waiting',
      label:
        args.waiting === 1
          ? `${labels.one} · needs approval`
          : `${labels.many} · ${args.waiting} to approve`,
      title:
        args.waiting === 1
          ? `A ${labels.batchAdjective} batch is waiting for you to approve it`
          : `${args.waiting} ${labels.batchAdjective} batches are waiting for you to approve them`,
    };
  }

  const running = armed.filter((s) => s.running).length;
  if (running > 0) {
    return {
      tone: 'running',
      label:
        running === 1 ? `${labels.one} · running` : `${labels.many} · ${running} running`,
      title:
        running === 1
          ? `A ${labels.unitOne} is running right now`
          : `${running} ${labels.unitMany} are running right now`,
    };
  }

  // Armed but idle. The countdown is what proves the thing is alive rather
  // than forgotten, but it only means anything with the noun in front of it —
  // "in 3h" on its own is a time with no subject.
  const soonest = upcomingAgenda(armed, 1)[0];
  const counted = `${armed.length} ${armed.length === 1 ? labels.unitOne : labels.unitMany} armed`;
  return {
    tone: 'armed',
    label: soonest ? `${labels.one} · ${untilLabel(soonest.nextAt as number, now)}` : labels.one,
    title: soonest
      ? `${counted} · ${soonest.name} next at ${new Date(soonest.nextAt as number).toLocaleString()}`
      : counted,
  };
}

export const SCHEDULE_LABELS: AutomationLabels = {
  one: 'Scheduled',
  many: 'Scheduled',
  unitOne: 'schedule',
  unitMany: 'schedules',
  batchAdjective: 'scheduled',
};

export const SHIFT_LABELS: AutomationLabels = {
  one: 'Shift',
  many: 'Shifts',
  unitOne: 'worker',
  unitMany: 'workers',
  batchAdjective: 'shift',
};

/// One species' worth of input to the headline.
export interface AutomationSide {
  source: AutomationSource;
  subjects: AutomationSubject[];
  waiting: number;
  labels: AutomationLabels;
}

export interface AutomationHeadline extends AutomationStatus {
  /// Which side the chip ended up talking about — and therefore where
  /// clicking it has to land. A chip that says "Shift" and opens the schedules
  /// page is worse than no chip.
  source: AutomationSource;
}

const TONE_RANK: Record<AutomationStatus['tone'], number> = {
  waiting: 3,
  running: 2,
  armed: 1,
};

/// The single most urgent thing across every species, as one chip.
///
/// There used to be one chip per species, side by side. Two countdowns in the
/// strip that is always on screen make you read both and then work out which
/// one you cared about — and the difference between a schedule and a shift
/// only starts to matter once you go to act on it, which happens on the page
/// the chip opens, not in the chip. So: one readout, naming whichever side is
/// actually asking for attention.
///
/// What that costs is the simultaneous view — a shift parked on approval while
/// a schedule runs shows only the approval. That's the right way round (the
/// approval is the one blocked on you), and the loser is not dropped: it goes
/// into the tooltip, which is where "what else is going on" belongs. The
/// calendar's up-next strip is the surface with room to list everything.
export function headlineStatus(
  sides: AutomationSide[],
  now: number = Date.now(),
): AutomationHeadline | null {
  const ranked = sides
    .map((side) => ({
      side,
      status: automationStatus({
        subjects: side.subjects,
        waiting: side.waiting,
        labels: side.labels,
        now,
      }),
      running: side.subjects.filter((s) => s.enabled && s.running).length,
      soonestAt: upcomingAgenda(side.subjects, 1)[0]?.nextAt ?? null,
    }))
    .filter((r): r is typeof r & { status: AutomationStatus } => r.status !== null);

  if (ranked.length === 0) return null;

  ranked.sort((a, b) => {
    const byTone = TONE_RANK[b.status.tone] - TONE_RANK[a.status.tone];
    if (byTone !== 0) return byTone;
    // Same tone, so the tie-break is whichever is more of it: more batches
    // parked, more runs in flight, or — for two idle sides — the one that
    // fires first, which is the only reading of "next" a countdown can have.
    if (a.status.tone === 'waiting') return b.side.waiting - a.side.waiting;
    if (a.status.tone === 'running') return b.running - a.running;
    return (a.soonestAt ?? Infinity) - (b.soonestAt ?? Infinity);
  });

  const [winner, ...rest] = ranked;
  // Everything the chip couldn't say, in the one place that costs no space.
  const also = rest.map((r) => `Also: ${r.status.title}`);
  return {
    ...winner.status,
    source: winner.side.source,
    title: [winner.status.title, ...also].join('\n'),
  };
}
