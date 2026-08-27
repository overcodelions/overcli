// Permission policy for a run with nobody watching.
//
// In the app a tool permission request becomes a card and waits. Headless
// there is no one to click it, so a request that is merely left alone hangs
// the job until the CI timeout kills it — the worst of the three outcomes,
// because it burns a runner for an hour and tells you nothing.
//
// Two halves make that work, and only having both is enough:
//
//   1. This tap, which answers requests that reach the approval broker.
//   2. `unattendedAllowedTools` on the run (runtime.ts), which narrows each
//      step's `--allowedTools` to the intersection with the policy. Without
//      it a step declaring `tools: [Bash]` PRE-AUTHORISES Bash at the CLI, no
//      request is ever emitted, and this tap never sees the one call that
//      mattered. The flag would then govern only tools the flow did not ask
//      for — exactly backwards.
//
// So every request gets an answer, and the answer comes from `--permissions`:
//
//   deny          answer no to everything. The safe default, and enough for
//                 any flow whose steps only read and reason.
//   allow-list    answer yes to the tools named with --allow-tool, no to the
//                 rest.
//   auto-approve  answer yes. Only for a pipeline whose repo you control and
//                 whose flow you have read.
//
// This is an event TAP, not a change to the runtime: `runtime.ts` already
// auto-denies on worker-owned runs without `allowExternalActions` (the loop at
// runtime.ts:604), and it observes events before we do. That ordering is
// load-bearing and must not be inverted — a worker's own caps outrank the CLI
// flag, so `--permissions auto-approve` cannot widen a worker that was never
// granted external actions. It only answers what the worker boundary left
// undecided.
//
// `AskUserQuestion` / `userInputRequest` has no policy answer. A model asking
// which of three designs to take cannot be answered "yes". Those get an
// explicit refusal that names the question, so the step fails with a readable
// reason instead of hanging.

import type { MainToRendererEvent, UserInputAnswer } from '../shared/types';
import type { PermissionPolicy } from './args';

export interface PermissionDecision {
  kind: 'permission' | 'codex' | 'userInput';
  conversationId: string;
  /// `requestId` for permissions and user input; `callId` for codex.
  id: string;
  toolName: string;
  approved: boolean;
  /// Why, in one line, for the progress stream. The reason a job was useless
  /// is usually a denial nobody could see.
  reason: string;
}

export interface PermissionResponder {
  respondPermission(conversationId: string, requestId: string, approved: boolean): void;
  respondCodexApproval(
    conversationId: string,
    callId: string,
    kind: 'exec' | 'patch',
    approved: boolean,
  ): void;
  respondUserInput(
    conversationId: string,
    requestId: string,
    answers: Record<string, UserInputAnswer>,
  ): void;
}

/// Decide one tool request. Split out from the event walk so the policy table
/// is testable without synthesising a whole stream event.
export function decide(
  policy: PermissionPolicy,
  toolName: string,
  allowTools: ReadonlySet<string>,
): { approved: boolean; reason: string } {
  if (policy === 'auto-approve') {
    return { approved: true, reason: `auto-approved ${toolName} (--permissions auto-approve)` };
  }
  if (policy === 'allow-list') {
    if (allowTools.has(toolName)) {
      return { approved: true, reason: `allowed ${toolName} (--allow-tool)` };
    }
    return { approved: false, reason: `denied ${toolName} (not in --allow-tool)` };
  }
  return { approved: false, reason: `denied ${toolName} (--permissions deny)` };
}

/// The refusal handed back to a model that asked the user a question. Written
/// as instructions to the model rather than as an error string because that is
/// what it reads: it gets one more turn, and "decide it yourself and say which
/// you picked" salvages runs that would otherwise die on a clarifying question.
export function refuseUserInput(questions: Array<{ id: string; question: string }>): {
  answers: Record<string, UserInputAnswer>;
  summary: string;
} {
  const answers: Record<string, UserInputAnswer> = {};
  for (const q of questions) {
    answers[q.id] = {
      answers: [
        'This run has no interactive user (overcli headless). Do not ask again. ' +
          'Choose the most reasonable option yourself, state which you chose and why, and continue. ' +
          'If the question is genuinely unanswerable without a human, stop and say so plainly.',
      ],
    };
  }
  return {
    answers,
    summary: questions.map((q) => q.question).join(' | ') || 'a question with no text',
  };
}

/// Build the tap. Returns a function to call with every event, BEFORE it is
/// written to stdout/stderr, and after the flow runtime and worker engine have
/// seen it.
export function permissionTap(args: {
  policy: PermissionPolicy;
  allowTools: string[];
  responder: PermissionResponder;
  onDecision?: (d: PermissionDecision) => void;
  /// Deny every Codex exec/patch escalation outright, whatever the policy.
  ///
  /// The runtime's worker boundary (runtime.ts:605) auto-denies
  /// `permissionRequest` on a worker run with no external-action grant, and
  /// `respondPermission` is consume-once, so our later answer is a no-op —
  /// that is what makes a worker's caps outrank `--permissions`. But that loop
  /// matches `permissionRequest` ONLY. A codex-backed step running under
  /// `acceptEdits` maps to `approval: 'on-failure'`, so a sandboxed command
  /// that fails raises a `codexApproval` the boundary never sees, and
  /// `auto-approve` would wave it straight through — widening exactly the cap
  /// the boundary exists to hold.
  ///
  /// Set by the CLI when it is running a worker that was not granted external
  /// actions. Fixed here rather than in the runtime because the app has a
  /// human who can legitimately answer that prompt; a CI job does not.
  denyCodexApprovals?: boolean;
}): (event: MainToRendererEvent) => void {
  const allow = new Set(args.allowTools);
  const seen = new Set<string>();

  return (event: MainToRendererEvent) => {
    if (event.type !== 'stream') return;
    for (const ev of event.events) {
      const kind = ev.kind;
      if (kind.type === 'permissionRequest') {
        if (kind.info.decided) continue;
        // The runtime's worker-boundary tap may already have answered this one
        // in the same pass. Responding twice is harmless at the runner (the
        // pending callback is deleted on first use) but would double-log a
        // decision the CLI did not actually make.
        const key = `p:${event.conversationId}:${kind.info.requestId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const { approved, reason } = decide(args.policy, kind.info.toolName, allow);
        args.responder.respondPermission(event.conversationId, kind.info.requestId, approved);
        args.onDecision?.({
          kind: 'permission',
          conversationId: event.conversationId,
          id: kind.info.requestId,
          toolName: kind.info.toolName,
          approved,
          reason,
        });
      } else if (kind.type === 'codexApproval') {
        if (kind.info.decided) continue;
        const key = `c:${event.conversationId}:${kind.info.callId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // Codex asks about running a command or applying a patch, not about a
        // named tool. `exec` / `patch` are the names the allow-list can use.
        const toolName = kind.info.kind === 'exec' ? 'exec' : 'patch';
        const { approved, reason } = args.denyCodexApprovals
          ? {
              approved: false,
              reason: `denied codex ${toolName} (worker has no grant for external actions)`,
            }
          : decide(args.policy, toolName, allow);
        args.responder.respondCodexApproval(
          event.conversationId,
          kind.info.callId,
          kind.info.kind,
          approved,
        );
        args.onDecision?.({
          kind: 'codex',
          conversationId: event.conversationId,
          id: kind.info.callId,
          toolName,
          approved,
          reason,
        });
      } else if (kind.type === 'userInputRequest') {
        if (kind.info.submitted) continue;
        const key = `u:${event.conversationId}:${kind.info.requestId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const { answers, summary } = refuseUserInput(kind.info.questions);
        args.responder.respondUserInput(event.conversationId, kind.info.requestId, answers);
        args.onDecision?.({
          kind: 'userInput',
          conversationId: event.conversationId,
          id: kind.info.requestId,
          toolName: 'AskUserQuestion',
          approved: false,
          reason: `no interactive user to answer: ${summary}`,
        });
      }
    }
  };
}
