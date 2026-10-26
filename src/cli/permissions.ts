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

import { isReadOnlyMcpTool } from '../shared/flows/mcpTools';
import type { MainToRendererEvent, UserInputAnswer } from '../shared/types';
import type { PermissionPolicy } from './args';
import path from 'node:path';
import { isReadOnlyBashCommand, splitCommands, words } from '../main/permissionPolicy';

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
  /// The shell command, for a Bash request.
  detail?: string;
}

export interface PermissionResponder {
  respondPermission(conversationId: string, requestId: string, approved: boolean, addDir?: string, scope?: 'once' | 'always', rule?: string, denyMessage?: string): void;
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
  toolInput = '',
): { approved: boolean; reason: string } {
  if (policy === 'auto-approve') {
    return { approved: true, reason: `auto-approved ${toolName} (--permissions auto-approve)` };
  }
  if (policy === 'allow-list') {
    if (allowTools.has(toolName)) {
      return { approved: true, reason: `allowed ${toolName} (--allow-tool)` };
    }
    // The org's `everything` level (workerAccess.ts).
    if (allowTools.has('*')) return { approved: true, reason: `allowed ${toolName} (every tool)` };
    // `Bash(npm test:*)`: a command the org listed, run as it is.
    if (toolName === 'Bash' && grantedCommand(toolInput, allowTools)) {
      return { approved: true, reason: 'allowed Bash (a listed command)' };
    }
    return { approved: false, reason: `denied ${toolName} (not in --allow-tool)` };
  }
  return { approved: false, reason: `denied ${toolName} (--permissions deny)` };
}

function commandOf(toolInput: string): string {
  try {
    const parsed = JSON.parse(toolInput) as { command?: unknown };
    if (typeof parsed?.command === 'string') return parsed.command;
  } catch {
    // Already the command line.
  }
  return toolInput;
}

/// Whether every command in a shell line starts with one the allow-list
/// grants as `Bash(<command>:*)`. A substitution, a redirect into a file, or
/// any command not listed: no.
export function grantedCommand(toolInput: string, allowTools: ReadonlySet<string>): boolean {
  const prefixes = [...allowTools].map((t) => /^Bash\((.+):\*\)$/.exec(t)?.[1]).filter((x): x is string => !!x);
  if (!prefixes.length) return false;
  let command = toolInput;
  try {
    const parsed = JSON.parse(toolInput) as { command?: unknown };
    if (typeof parsed?.command === 'string') command = parsed.command;
  } catch {
    // Already the command line.
  }
  const { commands, writes, opaque } = splitCommands(command);
  if (opaque || writes || !commands.length) return false;
  return commands.every((c) => {
    const said = words(c).join(' ');
    return prefixes.some((p) => said === p || said.startsWith(`${p} `));
  });
}

/// A shell command that only reads, and only inside one of `roots`: a worker
/// running `ls` and `cat` on its own files. Models reach for the shell to look
/// around however the prompt steers them, and refusing a read of the worker's
/// own baseline left it convinced it had none. Anything that writes, runs a
/// substitution, climbs with `..`, or names a path outside the roots is not
/// this.
export function readsOnlyUnder(toolName: string, toolInput: string, roots: readonly string[], also: (p: string) => boolean = () => false): boolean {
  if (toolName !== 'Bash') return false;
  let command = toolInput;
  try {
    const parsed = JSON.parse(toolInput) as { command?: unknown };
    if (typeof parsed?.command === 'string') command = parsed.command;
  } catch {
    // Already the command line.
  }
  if (!command.trim() || !isReadOnlyBashCommand(command)) return false;
  const inside = (p: string) => also(p) || roots.some((r) => p === r || p.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
  for (const c of splitCommands(command).commands) {
    let namedHere = false;
    for (const w of words(c).slice(1)) {
      if (w === '/dev/null' || /^\d?>&\d$/.test(w)) continue;
      if (w.includes('..') || w.startsWith('~') || w.includes('$')) return false;
      if (w.startsWith('-')) continue;
      // A count (`head -n 50`, `head -c 4000`) names nothing to read.
      if (/^\d+$/.test(w)) continue;
      if (!w.startsWith('/') || !inside(path.resolve(w))) return false;
      namedHere = true;
    }
    // A bare `ls` reads wherever the turn happens to be; only a path we can check counts.
    if (!namedHere) return false;
  }
  return true;
}

/// Where Claude Code keeps a tool result too big to hand the model inline
/// (`~/.claude/projects/<project>/<session>/tool-results/<call>.txt`): the
/// model is told the path and reads it, very often with `head`, `grep` or
/// `wc`. The Read tool may open it already; refusing the shell for the same
/// file left a worker holding a Zendesk search it believed it wasn't allowed
/// to look at.
export function isToolResultFile(p: string, home: string | undefined = process.env.HOME): boolean {
  if (!home) return false;
  const projects = path.join(home, '.claude', 'projects') + path.sep;
  return p.startsWith(projects) && p.slice(projects.length).split(path.sep).includes('tool-results');
}

/// What a refused tool call is told, in place of "denied by user": it was a
/// rule, not a person, and what to use instead. Without it a worker reported
/// "your permission settings denied" and stopped rather than use Read.
export function policyRefusal(toolName: string): string {
  return toolName === 'Bash'
    ? 'Refused by this server\'s rules, not by a person: shell commands are not allowed here, except plain reads (cat, head, grep, wc, ls) of your own files and of saved tool results. Use the Read and Grep tools instead; they are allowed and are not a way around anything. Carry on with them.'
    : `Refused by this server's rules, not by a person: ${toolName} is not among the tools allowed here. Carry on with the tools you have, and say what you could not do.`;
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
  /// Directories a read-only shell command may look inside even when the
  /// policy would refuse Bash: workers' own files.
  readOnlyRoots?: (conversationId: string) => string[];
  /// Let a tool call that only reads through, under the allow-list: a worker
  /// asked a question reads its tracker while it works out the answer, and
  /// nobody is there to approve a lookup. Its turn loads only its own tools,
  /// and calls outside its scope never reach here (Claude refuses them).
  allowToolReads?: boolean;
}): (event: MainToRendererEvent) => void {
  // Read as each request comes: the list changes in place while the server
  // runs (repo grants, the org's access level).
  const allowNow = () => new Set(args.allowTools);
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
        const allow = allowNow();
        const own = args.policy !== 'auto-approve' && !allow.has(kind.info.toolName) && readsOnlyUnder(kind.info.toolName, kind.info.toolInput, args.readOnlyRoots?.(event.conversationId) ?? [], (p) => isToolResultFile(p));
        const toolRead = args.policy === 'allow-list' && !!args.allowToolReads && !allow.has(kind.info.toolName) && kind.info.toolName.startsWith('mcp__') && isReadOnlyMcpTool(kind.info.toolName);
        const { approved, reason } = own
          ? { approved: true, reason: `allowed ${kind.info.toolName}: a read-only look at a worker's own files` }
          : toolRead
            ? { approved: true, reason: `allowed ${kind.info.toolName}: a tool call that only reads` }
            : decide(args.policy, kind.info.toolName, allow, kind.info.toolInput);
        if (approved) args.responder.respondPermission(event.conversationId, kind.info.requestId, true);
        else args.responder.respondPermission(event.conversationId, kind.info.requestId, false, undefined, undefined, undefined, policyRefusal(kind.info.toolName));
        args.onDecision?.({
          kind: 'permission',
          conversationId: event.conversationId,
          id: kind.info.requestId,
          toolName: kind.info.toolName,
          approved,
          reason,
          ...(kind.info.toolName === 'Bash' ? { detail: commandOf(kind.info.toolInput) } : {}),
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
          : decide(args.policy, toolName, allowNow());
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
