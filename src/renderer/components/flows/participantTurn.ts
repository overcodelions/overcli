// Send one message to a flow participant — the "hijack" turn that lets you
// talk to a step: ask it a question, push back, ask for a change.
//
// Shared by the run page's composer and the Workers Today reader, because the
// send is not just an IPC call and the two must not drift: it RESUMES the
// step's own session (so the model answers with the plan, the diff and its
// own output in context instead of as a stranger), honours a per-run model
// override, folds in any service logs the message mentions, and tells the
// run the user drove it. The runtime never advances on these turns; when a
// paused run is continued after one, the step is asked for a fresh output
// that reflects the conversation.

import { useFlowsStore } from '../../flowsStore';
import { attachMentionedServiceLogs } from '../../serviceLogContext';
import type { FlowRun } from '@shared/flows/schema';
import type { Attachment } from '@shared/types';

export function newConversationId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  // Cheap fallback so tests don't depend on the crypto API.
  return 'tmp-' + Math.random().toString(36).slice(2);
}

/// Send `prompt` to `participantId` on `run`. Resolves to the conversation id
/// it went to — minted when this participant has not spoken yet.
export async function sendParticipantTurn(args: {
  run: FlowRun;
  participantId: string;
  prompt: string;
  attachments?: Attachment[];
  /// Workspaces whose service logs a message may pull in by mention.
  serviceWorkspaceIds?: string[];
}): Promise<string> {
  const { run, participantId, prompt } = args;
  const participant = run.flowSnapshot.participants?.find((p) => p.id === participantId);
  if (!participant) throw new Error(`No participant ${participantId} on this run.`);
  const conversationId = run.conversationIds[participantId] ?? newConversationId();
  const model = run.modelOverrides?.[participantId] ?? participant.model;
  const outgoing = await attachMentionedServiceLogs(prompt, args.serviceWorkspaceIds ?? [], {
    views: (ids) => window.overcli.invoke('services:viewAll', ids),
    log: (workspaceId, serviceId) => window.overcli.invoke('services:log', { workspaceId, serviceId }),
  }).catch(() => prompt);
  void window.overcli.invoke('runner:send', {
    conversationId,
    prompt: outgoing,
    displayText: prompt,
    backend: participant.backend,
    cwd: run.projectPath,
    model,
    sessionId: run.sessionIdsByParticipant?.[participantId],
    // Hijack turns inherit the run's default permission — bypass for
    // participants that need write access. The runtime's preflight already
    // gated the run.
    permissionMode: 'bypassPermissions',
    chrome: run.chrome,
    attachments: args.attachments ?? [],
  });
  useFlowsStore.getState().noteUserTurn(run.id);
  return conversationId;
}
