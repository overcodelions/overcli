// Everything in the app that is waiting on the user, as one list.
//
// "Needs you" used to live in four places that never compared notes: paused
// runs on the Flows tab badge, a worker's proposals and paused runs in the
// Workers sidebar, parked schedule batches inside the Shift chip's label, and
// a drafted hire on the Workers tab. Each was right about its own corner and
// none of them could tell you, from wherever you were, that there was
// anything to look at. The title bar's alert reads this list, and so does the
// Workers tab badge, so the count in the chip and the rows in its tray are
// the same thing by construction.
//
// Pure on purpose: the title bar owns the stores and hands them in, and every
// decision about what counts and how loud to be is tested here.

import type { Orchestration } from '@shared/flows/orchestration';
import {
  isOrchestrationAwaitingApproval,
  isOrchestrationComplete,
} from '@shared/flows/orchestration';
import { flowRunActivityAt, flowRunTitle, type FlowRun } from '@shared/flows/schema';
import type { WorkerFunding } from '@shared/flows/treasury';
import type { Worker } from '@shared/flows/worker';
import { STALL_AFTER_MS } from './components/flows/runTriage';
import { pauseReasonLabel, runStepPosition } from './components/workers/deskRunRail';

export type AttentionItem =
  | {
      kind: 'run';
      key: string;
      runId: string;
      workerId: string | null;
      title: string;
      reason: string;
      at: number;
      /// The flow cannot go on without you: a question, an approval, a failed
      /// step. A run that stopped where it was told to (`preStep`) or was cut
      /// off by a restart is waiting too, but only as urgently as anything
      /// else — it escalates on age like the rest.
      urgent: boolean;
    }
  | {
      kind: 'approval';
      key: string;
      orchestrationId: string;
      workerId: string | null;
      title: string;
      reason: string;
      at: number;
    }
  | {
      kind: 'hire';
      key: string;
      workerId: null;
      title: string;
      reason: string;
      at: number;
    }
  | {
      kind: 'unfunded';
      key: string;
      workerId: string;
      title: string;
      reason: string;
      /// No moment it started waiting is recorded, so it never escalates on
      /// age — only a paused run or a long wait does that.
      at: null;
    };

/// How loud the title-bar alert is.
///
///   - calm: something is waiting, but not for long. A tint, no motion — you
///     may well be about to look anyway.
///   - waiting: it has sat long enough to be worth a nudge. The border
///     breathes.
///   - blocking: a run can't continue without you (see `urgent`), or something
///     has waited over an hour. Amber, the queue's own colour for paused, and
///     a faster pulse.
///
/// Pulsing is earned rather than constant: an alert that always moves stops
/// being read within a day.
export type AttentionLevel = 'calm' | 'waiting' | 'blocking';

export const NUDGE_AFTER_MS = 10 * 60 * 1000;
export const BLOCKING_AFTER_MS = 60 * 60 * 1000;

export interface AttentionSources {
  runs: Record<string, FlowRun>;
  orchestrations: Record<string, Orchestration>;
  workers: Record<string, Pick<Worker, 'id' | 'name' | 'enabled'>>;
  /// Null until the treasury has been computed.
  funding: Pick<WorkerFunding, 'workerId' | 'blocked'>[] | null;
  pendingHire: { draft: { name: string }; at: number } | null;
}

/// Rank inside the tray: a stopped run first — it holds a worktree and the
/// rest of its flow hostage — then things to approve, then the rest.
const KIND_RANK: Record<AttentionItem['kind'], number> = {
  run: 0,
  approval: 1,
  hire: 2,
  unfunded: 3,
};

export function attentionInbox(src: AttentionSources, now: number = Date.now()): AttentionItem[] {
  const items: AttentionItem[] = [];

  for (const run of Object.values(src.runs)) {
    if (run.state.kind !== 'paused') continue;
    const at = flowRunActivityAt(run);
    // Same cut as the Flows badge: a run this quiet has been left behind, and
    // a count you can't clear stops being a signal.
    if (now - at > STALL_AFTER_MS) continue;
    const step = runStepPosition(run);
    const why = pauseReasonLabel(run);
    items.push({
      kind: 'run',
      key: `run:${run.id}`,
      runId: run.id,
      workerId: run.workerId ?? null,
      title: flowRunTitle(run),
      // The reason already says it paused; the step only says where.
      reason: [step ? `At ${step.step} ${step.position}/${step.total}` : null, why ?? 'Paused']
        .filter(Boolean)
        .join(' · '),
      at,
      urgent: run.state.reason !== 'preStep' && run.state.reason !== 'interrupted',
    });
  }

  for (const o of Object.values(src.orchestrations)) {
    if (!isOrchestrationAwaitingApproval(o)) continue;
    const proposed = o.items.filter((it) => it.status === 'proposed').length;
    const from =
      o.origin?.kind === 'worker'
        ? o.origin.workerName
        : o.origin?.kind === 'schedule'
          ? o.origin.scheduleName
          : 'Orchestrator';
    items.push({
      kind: 'approval',
      key: `approval:${o.id}`,
      orchestrationId: o.id,
      workerId: o.origin?.kind === 'worker' ? o.origin.workerId : null,
      title: o.title,
      reason: `${from} · ${proposed === 1 ? '1 to approve' : `${proposed} to approve`}`,
      at: o.createdAt,
    });
  }

  if (src.pendingHire) {
    items.push({
      kind: 'hire',
      key: 'hire',
      workerId: null,
      title: `Hire ${src.pendingHire.draft.name}`,
      reason: 'Drafted · nothing is hired until you say so',
      at: src.pendingHire.at,
    });
  }

  for (const f of src.funding ?? []) {
    // `pool` is the one block a person has to fix: the shared pot ran dry
    // above this worker. A cap or a paused worker is a setting, not a problem.
    if (f.blocked !== 'pool') continue;
    const worker = src.workers[f.workerId];
    if (!worker?.enabled) continue;
    items.push({
      kind: 'unfunded',
      key: `unfunded:${f.workerId}`,
      workerId: f.workerId,
      title: worker.name,
      reason: 'Out of funds · its next shift won’t run',
      at: null,
    });
  }

  // Oldest first inside a kind: the longest wait is the one the alert is
  // really about.
  return items.sort(
    (a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || (a.at ?? now) - (b.at ?? now),
  );
}

const GROUP_TITLES: Record<AttentionItem['kind'], string> = {
  run: 'Paused runs',
  approval: 'To approve',
  hire: 'Hires',
  unfunded: 'Out of funds',
};

/// The tray's sections. A flat list is fine at three rows and useless at
/// thirty, where the one question is "how many of each" — so every kind gets
/// a header with its own count, in the same order the inbox is sorted.
export function groupAttention(
  items: AttentionItem[],
): { kind: AttentionItem['kind']; title: string; items: AttentionItem[] }[] {
  const groups: { kind: AttentionItem['kind']; title: string; items: AttentionItem[] }[] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last?.kind === item.kind) last.items.push(item);
    else groups.push({ kind: item.kind, title: GROUP_TITLES[item.kind], items: [item] });
  }
  return groups;
}

export function attentionLevel(items: AttentionItem[], now: number = Date.now()): AttentionLevel | null {
  if (items.length === 0) return null;
  if (items.some((it) => it.kind === 'run' && it.urgent)) return 'blocking';
  const oldest = Math.min(...items.map((it) => it.at ?? now));
  const waited = now - oldest;
  if (waited >= BLOCKING_AFTER_MS) return 'blocking';
  if (waited >= NUDGE_AFTER_MS) return 'waiting';
  return 'calm';
}

/// The chip's words. "Run paused" leads when that's the reason it is amber,
/// so the colour and the label agree.
export function attentionLabel(items: AttentionItem[]): string {
  const runs = items.filter((it) => it.kind === 'run').length;
  const total = items.length;
  if (runs > 0 && runs === total) return runs === 1 ? 'Run paused' : `${runs} runs paused`;
  if (runs > 0) return `Run paused · ${total} need you`;
  return total === 1 ? '1 needs you' : `${total} need you`;
}

/// Work you were just in the middle of: still going, or finished a few
/// minutes ago. The tray shows it under the things that are waiting, as a way
/// back to what you were doing.
///
/// Derived from the runs themselves rather than from what leaves
/// `attentionInbox`. An earlier version watched rows depart the inbox, which
/// meant a flow only ever qualified if it had sat there paused while the app
/// was open — a run you finished or closed without it ever waiting on you was
/// invisible, and a reload forgot everything. Reading the store has neither
/// problem.
///
/// Emphatically not part of `attentionInbox`: none of this is waiting on you,
/// so it must never reach the chip's count or `attentionLevel`, or the badge
/// becomes something you can't clear.
export interface RecentItem {
  item: AttentionItem;
  /// Last activity, which for a finished run is when it finished.
  at: number;
  status: RecentStatus;
}

export interface RecentStatus {
  /// The work is still going. Worth watching, and it never ages out.
  continuing: boolean;
  label: string;
}

/// How long *finished* work lingers. Anything still going ignores this: a flow
/// can run for half an hour, and dropping it at ten minutes hides the very
/// thing you are waiting on.
export const RECENT_WINDOW_MS = 10 * 60 * 1000;
/// Live work takes these slots first, so a burst of finished runs can never
/// push something still going off the list.
export const RECENT_MAX = 5;

export function recentWork(
  src: Pick<AttentionSources, 'runs' | 'orchestrations'>,
  waiting: AttentionItem[],
  now: number = Date.now(),
): RecentItem[] {
  const waitingKeys = new Set(waiting.map((it) => it.key));
  const rows: RecentItem[] = [];

  for (const run of Object.values(src.runs)) {
    const key = `run:${run.id}`;
    if (waitingKeys.has(key)) continue;
    // A paused run that isn't in the inbox is one the inbox gave up on as
    // stale; it is not work in progress.
    if (run.state.kind === 'paused') continue;
    // Never started, so there is nothing to go back to.
    if (run.attempts.length === 0) continue;
    const status = runStatus(run);
    const at = flowRunActivityAt(run);
    if (!status.continuing && now - at >= RECENT_WINDOW_MS) continue;
    rows.push({
      item: {
        kind: 'run',
        key,
        runId: run.id,
        workerId: run.workerId ?? null,
        title: flowRunTitle(run),
        reason: status.label,
        at,
        urgent: false,
      },
      at,
      status,
    });
  }

  for (const o of Object.values(src.orchestrations)) {
    const key = `approval:${o.id}`;
    if (waitingKeys.has(key) || isOrchestrationAwaitingApproval(o)) continue;
    const complete = isOrchestrationComplete(o);
    const at = o.completedAt ?? o.createdAt;
    if (complete && now - at >= RECENT_WINDOW_MS) continue;
    if (!complete && o.items.every((it) => it.status === 'proposed')) continue;
    const left = o.items.filter(
      (it) => it.status !== 'done' && it.status !== 'failed' && it.status !== 'cancelled',
    ).length;
    rows.push({
      item: {
        kind: 'approval',
        key,
        orchestrationId: o.id,
        workerId: o.origin?.kind === 'worker' ? o.origin.workerId : null,
        title: o.title,
        reason: complete ? 'Finished' : `Running · ${left} left`,
        at,
      },
      at,
      status: complete
        ? { continuing: false, label: 'Finished' }
        : { continuing: true, label: `Running · ${left} left` },
    });
  }

  return rows
    .sort(
      (a, b) =>
        Number(b.status.continuing) - Number(a.status.continuing) || b.at - a.at,
    )
    .slice(0, RECENT_MAX);
}

function runStatus(run: FlowRun): RecentStatus {
  switch (run.state.kind) {
    case 'running': {
      const step = runStepPosition(run);
      return {
        continuing: true,
        label: step ? `Running · at ${step.step} ${step.position}/${step.total}` : 'Running',
      };
    }
    case 'watching':
      return { continuing: true, label: 'Watching for changes' };
    case 'done':
      return { continuing: false, label: run.state.success ? 'Finished' : 'Finished · failed' };
    case 'aborted':
      return { continuing: false, label: 'Stopped' };
    case 'archived':
      return { continuing: false, label: 'Closed' };
    default:
      return { continuing: false, label: 'Handled' };
  }
}
