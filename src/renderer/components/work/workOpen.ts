// What clicking a Work row opens.
//
// Decided by what the record IS, never by how old it is — a rule by age made
// the same row open one thing today and another tomorrow. Anything live, or
// made of a single thing, opens that thing in one click, the way a Recent row
// used to; only work with several parts (or a run that was evicted) goes to
// the record page, which is where the trail and the transcripts are. ⌥-click
// does whichever the row doesn't.

import type { FlowRun } from '@shared/flows/schema';
import type { WorkRecord } from '@shared/workRecords';
import { runNeedsYou } from '../../attentionInbox';

/// `paused`: stopped, but not asking for you — you paused it, or it has been
/// left long enough that the tray stopped counting it.
export type LiveState = 'needs-you' | 'running' | 'paused';

export type OpenTarget =
  | { type: 'chat'; id: string }
  | { type: 'run'; id: string }
  | { type: 'record' };

export interface Liveness {
  state: LiveState | null;
  /// The part that is live — what a click on a live row opens.
  target?: OpenTarget;
}

const TERMINAL = new Set(['done', 'archived', 'aborted']);

/// Is any part of the record working, or waiting on you? A paused run needs
/// you; a run mid-step or a chat whose agent is streaming is running.
export function liveness(
  r: WorkRecord,
  runs: Record<string, FlowRun>,
  runningChatIds: ReadonlySet<string>,
  now: number = Date.now(),
  touchedAt?: (run: FlowRun) => number,
): Liveness {
  let running: OpenTarget | undefined;
  let paused: OpenTarget | undefined;
  for (const part of r.runs) {
    const run = runs[part.id];
    if (!run) continue;
    if (run.state.kind === 'paused') {
      // The title bar's rule, so the two counts agree.
      if (runNeedsYou(run, now, touchedAt)) return { state: 'needs-you', target: { type: 'run', id: run.id } };
      paused ??= { type: 'run', id: run.id };
    } else if (!TERMINAL.has(run.state.kind)) running ??= { type: 'run', id: run.id };
    // A step answering you after the run settled: the run stays done, but
    // its conversation is streaming.
    else if (Object.values(run.conversationIds ?? {}).some((id) => runningChatIds.has(id))) {
      running ??= { type: 'run', id: run.id };
    }
  }
  for (const chat of r.chats) {
    if (runningChatIds.has(chat.id)) running ??= { type: 'chat', id: chat.id };
  }
  if (running) return { state: 'running', target: running };
  if (paused) return { state: 'paused', target: paused };
  return { state: null };
}

/// Nothing but one chat, or one run the app still keeps — no batch, no PR.
function singlePart(r: WorkRecord, runs: Record<string, FlowRun>): OpenTarget | null {
  if (r.jobs.length || r.pr) return null;
  if (r.chats.length === 1 && r.runs.length === 0) return { type: 'chat', id: r.chats[0].id };
  if (r.runs.length === 1 && r.chats.length === 0 && runs[r.runs[0].id]) return { type: 'run', id: r.runs[0].id };
  return null;
}

export function primaryTarget(r: WorkRecord, live: Liveness, runs: Record<string, FlowRun>): OpenTarget {
  if (live.target) return live.target;
  return singlePart(r, runs) ?? { type: 'record' };
}

/// ⌥-click: the record page when the click goes straight in, and the most
/// recent thing that can be opened when the click goes to the record page.
export function alternateTarget(r: WorkRecord, primary: OpenTarget, runs: Record<string, FlowRun>): OpenTarget {
  if (primary.type !== 'record') return { type: 'record' };
  const parts: Array<{ at: number; target: OpenTarget }> = [
    ...r.chats.map((c) => ({ at: c.at, target: { type: 'chat', id: c.id } as OpenTarget })),
    ...r.runs.filter((x) => runs[x.id]).map((x) => ({ at: x.at, target: { type: 'run', id: x.id } as OpenTarget })),
  ];
  return parts.sort((a, b) => b.at - a.at)[0]?.target ?? { type: 'record' };
}
