// Which conversation a flow run is "at" right now, and which conversations
// it owns at all.
//
// A run has no single transcript: each participant keeps ONE conversation
// across every step it runs (see `FlowRun.conversationIds`), so anything
// that wants to look at a run's stream — the subagent drawer, the debug
// sheet — has to pick a participant first. Both of those used to answer
// that question inline; it lives here so they answer it the same way.

import type { FlowRun } from '@shared/flows/schema';
import type { UUID } from '@shared/types';

/// The participant the run is currently working through: the running step's,
/// the step a paused run would resume into, or — for a run that has stopped
/// — whoever ran last. Null when the run hasn't attempted a step yet.
export function focusedParticipantId(run: FlowRun): string | null {
  const st = run.state;
  const stepId =
    st.kind === 'running'
      ? st.currentStepId
      : st.kind === 'paused'
        ? st.nextStepId
        : run.attempts[run.attempts.length - 1]?.stepId;
  if (!stepId) return null;
  return run.flowSnapshot.steps.find((s) => s.id === stepId)?.participantId ?? null;
}

/// Conversation backing the run's focused participant, if it has one yet.
export function focusedFlowConversationId(run: FlowRun): UUID | null {
  const participantId = focusedParticipantId(run);
  return participantId ? run.conversationIds[participantId] ?? null : null;
}

export interface FlowConversationSource {
  participantId: string;
  /// Participant's friendly name, falling back to its id for a flow old
  /// enough that its participants were synthesized rather than declared.
  name: string;
  conversationId: UUID;
}

/// Every participant of a run that has actually opened a conversation, in
/// the flow's declared participant order so the list matches the run pane's
/// tabs. Participants that never ran have no conversation and are omitted
/// rather than offered as empty transcripts.
export function flowConversationSources(run: FlowRun): FlowConversationSource[] {
  const declared = run.flowSnapshot.participants ?? [];
  const sources: FlowConversationSource[] = [];
  const seen = new Set<string>();
  for (const p of declared) {
    const conversationId = run.conversationIds[p.id];
    if (!conversationId) continue;
    seen.add(p.id);
    sources.push({ participantId: p.id, name: p.name || p.id, conversationId });
  }
  // A conversation whose participant isn't in the snapshot shouldn't be
  // reachable, but dropping a transcript silently is worse than listing it
  // under its raw id.
  for (const [participantId, conversationId] of Object.entries(run.conversationIds)) {
    if (seen.has(participantId)) continue;
    sources.push({ participantId, name: participantId, conversationId });
  }
  return sources;
}
