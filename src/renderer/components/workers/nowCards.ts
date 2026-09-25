// What a Now card on the Today page says about work in flight, without
// opening it.
//
// The live line is read straight off the conversation the run is on: the
// newest tool call ("Bash · npm test", "Gmail · search_threads …") while it
// works, and the last thing it said when it has stopped to ask you something.
// Pure, so the card can call it inside a store selector and re-render only
// when the line itself changes.

import type { FlowRun, FlowWorkerExchange } from '@shared/flows/schema';
import type { StreamEvent } from '@shared/types';
import { parseMcpToolName } from '@shared/flows/mcpTools';
import { extractWorkerQuestion } from '@shared/flows/workerQuestion';
import { toolActivityLine } from '../toolActivity';

/// How far back to look. A step's newest tool call is almost always within
/// the last few events; this only bounds the walk on a very long transcript.
const SCAN_LIMIT = 400;

/// The conversation of the step the run is on — running it, or stopped in
/// front of it.
export function currentConversationId(run: FlowRun): string | undefined {
  const stepId =
    run.state.kind === 'running'
      ? run.state.currentStepId
      : run.state.kind === 'paused'
        ? run.state.nextStepId
        : undefined;
  if (!stepId) return undefined;
  const step = run.flowSnapshot?.steps.find((s) => s.id === stepId);
  return step ? run.conversationIds?.[step.participantId] : undefined;
}

/// The conversation of the step BEFORE the one the run stopped in front of —
/// where the work you are about to approve was done, and so where its own
/// account of that work is. Undefined for a run stopped before its first step.
export function priorConversationId(run: FlowRun): string | undefined {
  if (run.state.kind !== 'paused') return undefined;
  const steps = run.flowSnapshot?.steps ?? [];
  const at = steps.findIndex((s) => s.id === (run.state as { nextStepId: string }).nextStepId);
  const prior = at > 0 ? steps[at - 1] : undefined;
  return prior ? run.conversationIds?.[prior.participantId] : undefined;
}

/// The newest tool call as one short line. MCP tools read by server and tool
/// ("Gmail · search_threads") rather than as `mcp__claude_ai_Gmail__…`.
export function latestToolLine(events: StreamEvent[] | undefined): string {
  if (!events) return '';
  for (let i = events.length - 1, seen = 0; i >= 0 && seen < SCAN_LIMIT; i -= 1, seen += 1) {
    const e = events[i];
    const uses = e.kind.type === 'assistant' ? e.kind.info.toolUses : undefined;
    if (!uses || uses.length === 0) continue;
    const use = uses[uses.length - 1];
    const line = toolActivityLine(use);
    const mcp = parseMcpToolName(use.name);
    const name = mcp ? `${mcp.server.replace(/^claude_ai_/, '').replace(/_/g, ' ')} · ${mcp.tool}` : line.name;
    return line.detail ? `${name} · ${line.detail}` : name;
  }
  return '';
}

/// The last thing the step said, trimmed to a card's worth. What a paused
/// "asked you" card shows: the question itself — out of its protocol tag, and
/// when it is long, the sentence that actually asks, since the preamble is
/// context and the choice is what you came for.
export function latestSaid(events: StreamEvent[] | undefined, max = 200): string {
  if (!events) return '';
  for (let i = events.length - 1, seen = 0; i >= 0 && seen < SCAN_LIMIT; i -= 1, seen += 1) {
    const e = events[i];
    const text = e.kind.type === 'assistant' ? e.kind.info.text?.trim() : '';
    if (!text) continue;
    // Display only (React escapes it): tags a model wrapped around its words
    // are markup, not the question.
    const question = (extractWorkerQuestion(text) ?? text).replace(/<\/?[a-z_][\w-]*[^>]*>/gi, ' ');
    const flat = question.replace(/\s+/g, ' ').trim();
    if (flat.length <= max) return flat;
    const asks = flat.match(/[^.?!]*\?/g)?.map((q) => q.trim()).filter(Boolean);
    const last = asks?.[asks.length - 1];
    if (last && last.length <= max) return last;
    return `${flat.slice(0, max - 1)}…`;
  }
  return '';
}

/// What a paused card says instead of the reason's generic label: the step
/// that is waiting, and what you are being asked to do about it.
export function waitingLine(reason: string | undefined, step: string | undefined): string {
  const at = step ? `“${step}”` : 'the next step';
  switch (reason) {
    case 'externalAction':
      return `${at} acts outside the repo — approve it to run.`;
    case 'riskyStep':
      return `${at} has instructions that look risky — review before it runs.`;
    case 'failure':
      return `Failed at ${at}. Retry it, or skip past it.`;
    case 'interrupted':
      return `Interrupted at ${at} when the app closed — continue to pick it up.`;
    case 'needsInput':
      return `${at} asked you a question.`;
    default:
      return `Paused before ${at} — check the work so far, then continue.`;
  }
}

/// "3m", "1h 20m" — how long a live card has been going or waiting.
export function elapsedLabel(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}


/// When the run stopped: the end of the last step attempt before the pause.
export function pausedAt(run: FlowRun): number | undefined {
  if (run.state.kind !== 'paused') return undefined;
  const ends = run.attempts.map((a) => a.endedAt ?? a.startedAt);
  return ends.length > 0 ? Math.max(...ends) : undefined;
}

/// Whether you have talked to this run since it stopped — a turn with one of
/// its steps, or a correction held for the next. If so, that conversation is
/// where you are in the decision, not the output recorded before it.
export function talkedSincePause(run: FlowRun): boolean {
  const at = pausedAt(run);
  return at !== undefined && (run.lastUserTurnAt ?? 0) > at;
}

/// Of the steps that have run, the one whose conversation moved most
/// recently after the pause — where you were last talking. `lastEventAt`
/// gives each conversation's newest event time.
///
/// Steps played by the same participant share one conversation (a review
/// step and an eval step both run by Claude), so a conversation stands for
/// the step of it that ran LAST — that is the one you are talking to, and the
/// one whose output the pause hands on.
export function lastTalkedStep(run: FlowRun, lastEventAt: (conversationId: string) => number): string | undefined {
  const at = pausedAt(run);
  if (at === undefined) return undefined;
  const ranAt = new Map<string, number>();
  for (const a of run.attempts ?? []) ranAt.set(a.stepId, Math.max(ranAt.get(a.stepId) ?? 0, a.endedAt ?? a.startedAt));
  const latestOf = new Map<string, { id: string; ran: number }>();
  for (const step of run.flowSnapshot?.steps ?? []) {
    const conv = run.conversationIds?.[step.participantId];
    const ran = ranAt.get(step.id);
    if (!conv || ran === undefined) continue;
    const cur = latestOf.get(conv);
    if (!cur || ran >= cur.ran) latestOf.set(conv, { id: step.id, ran });
  }
  let best: { id: string; at: number } | undefined;
  for (const [conv, step] of latestOf) {
    const t = lastEventAt(conv);
    if (t > at && (!best || t > best.at)) best = { id: step.id, at: t };
  }
  return best?.id;
}

/// The latest exchange a paused step had with its worker — the flow asked the
/// worker first, and the worker answered, escalated to you, or failed. The
/// worker's side of it is the context the question alone does not carry.
export function latestExchange(run: FlowRun): FlowWorkerExchange | undefined {
  if (run.state.kind !== 'paused') return undefined;
  const stepId = run.state.nextStepId;
  const mine = (run.workerExchanges ?? []).filter((x) => x.stepId === stepId);
  return mine[mine.length - 1];
}

/// Questions the worker settled on its own during the run, oldest first.
export function workerDecisions(run: FlowRun): FlowWorkerExchange[] {
  return (run.workerExchanges ?? []).filter((x) => x.status === 'answered' && x.answer);
}
