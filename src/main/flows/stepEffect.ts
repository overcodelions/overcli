// Whether a flow step acts outside its run (pushes, sends, changes a
// service) or stays local, and which of its tools make it so. Pure, so the
// org layer can say what an approval covers without loading the runtime.

import type { FlowRun, FlowStep } from '../../shared/flows/schema';
import { isReadOnlyMcpTool } from '../../shared/flows/mcpTools';
import { isTrustedCommand } from './trustedCommands';

/// Resolve the side-effect class for a step. New flows state it explicitly;
/// old flows get a conservative compatibility inference so existing worker
/// contracts gain the external approval boundary without being hand-edited.
/// A clear external directive always wins over an erroneous `effect: local`:
/// safety metadata can add a boundary, never waive an obvious one.
export function resolveStepEffect(
  step: Pick<
    FlowStep,
    'id' | 'role' | 'systemPromptOverride' | 'tools' | 'output' | 'effect'
  >,
): 'local' | 'external' {
  const outside = stepOutsideTools(step);
  return outside === null || outside.length > 0 ? 'external' : 'local';
}

/// Why a step reaches outside, as tools: the ones it declares that can't be
/// shown to be local, lowercased (`bash`, a tracker's write). Empty: it's
/// local. Null: it's external for a reason no tool grant answers — it says
/// it ships, pushes, sends or edits a service, or names no tools at all.
export function stepOutsideTools(
  step: Pick<FlowStep, 'id' | 'role' | 'systemPromptOverride' | 'tools' | 'output' | 'effect'>,
): string[] | null {
  if (step.effect === 'external') return null;
  if (step.role === 'shipper') return null;

  // Tool names are judged one by one below, not scanned here: a step granted
  // a tracker's reads plus the built-in Write and Edit read as "edit …
  // tracker" to the verb patterns, and every team piece that read a tracker
  // asked for approval it didn't need.
  const text = [step.id, step.output, step.systemPromptOverride ?? '']
    .join(' ')
    .replace(/[_-]+/g, ' ');
  const actionableText = text.replace(
    /\b(?:do\s+not|don't|never|must\s+not)\s+(?:git\s+)?(?:push|deploy|publish|send|post|reply|respond|message|create|update|edit|delete|close|merge)\b[^.\n]*/gi,
    '',
  );
  const directExternal =
    /\bgit\s+push\b|\bpush\s+(?:the\s+)?(?:branch|code|changes|commit)|\bdeploy\b|\brelease\s+to\b|\bpublish\s+(?:the\s+)?(?:site|app|package|release|document)|\bmerge\s+(?:the\s+)?(?:branch|pull request|pr)\b/i;
  const prWrite =
    /\b(?:open|create|update|edit|close|merge)\b[^.\n]{0,80}\b(?:pull request|merge request|pr)\b|\b(?:pull request|merge request|pr)\b[^.\n]{0,80}\b(?:open|create|update|edit|close|merge)\b/i;
  const messageWrite =
    /\b(?:send|post|reply|respond|message|dm|deliver)\b[^.\n]{0,100}\b(?:slack|teams|email|e-mail|message|dm|channel|thread|recipient|inbox)\b|\b(?:slack|teams|email|e-mail|message|dm|channel|thread|recipient|inbox)\b[^.\n]{0,100}\b(?:send|post|reply|respond|message|deliver)\b/i;
  const serviceWrite =
    /\b(?:create|update|edit|change|delete|remove|close|transition|assign|comment|add|record|schedule|invite|upload)\b[^.\n]{0,110}\b(?:jira|productboard|zendesk|salesforce|linear|asana|trello|ticket|issue|insight|card|calendar|event|crm|record)\b|\b(?:jira|productboard|zendesk|salesforce|linear|asana|trello|ticket|issue|insight|card|calendar|event|crm)\b[^.\n]{0,110}\b(?:create|update|edit|change|delete|remove|close|transition|assign|comment|add|record|schedule|invite|upload)\b/i;
  if (directExternal.test(actionableText) || prWrite.test(actionableText) || messageWrite.test(actionableText) || serviceWrite.test(actionableText)) {
    return null;
  }
  // Fail closed: a step that reaches for a tool we don't recognise as read-only
  // is treated as external, so an unattended worker pauses rather than acting.
  // Covers both the Claude-style tool names and the Ollama built-in kit
  // (read_file/list_dir/write_file/edit_file/grep/bash — see ollamaTools.ts)
  // used by the shipped templates' `build`/`tests` steps.
  // `bash`, `websearch` and `webfetch` are NOT here on purpose: bash reaches
  // curl/git push/ssh/aws with the user's on-disk credentials, and webfetch is
  // a bare SSRF primitive. An unattended worker must stop and ask first.
  const LOCAL_TOOLS = new Set([
    'read', 'grep', 'glob', 'ls', 'edit', 'write', 'notebookedit', 'todowrite', 'task',
    'read_file', 'list_dir', 'write_file', 'edit_file',
  ]);
  // Scoped read-only git is local: `Bash(git diff:*)` cannot mutate anything,
  // and forcing a pause on it made two shipped templates stall at step 1.
  const READONLY_BASH = /^bash\(\s*git\s+(?:diff|log|show|status|ls-files|rev-parse)(?::\*)?\s*\)$/;
  // An MCP tool that only reads — searching a mailbox, listing a calendar —
  // is not acting on the world, so granting it keeps the step local. One
  // whose name says it sends, creates or updates, or says nothing we can
  // place, stays external (see isReadOnlyMcpTool).
  const isLocalTool = (t: string): boolean => {
    const name = t.toLowerCase().trim();
    if (name.startsWith('mcp__')) return isReadOnlyMcpTool(t.trim());
    return LOCAL_TOOLS.has(name.split('__')[0]) || READONLY_BASH.test(name) || isTrustedCommand(name);
  };
  const declared = step.tools ?? [];
  // Fail closed on an absent or empty declaration: a step that names nothing
  // is granted everything by the CLI, which is the opposite of "local".
  if (declared.length === 0) return null;
  return [...new Set(declared.filter((t) => !isLocalTool(t)).map((t) => t.toLowerCase().trim()))];
}

/// Whether approving an earlier step "for this run" covers this one: every
/// outside tool it needs was approved, and nothing else makes it external.
export function runGrantCovers(
  run: Pick<FlowRun, 'externalActionRunGrant'>,
  step: Pick<FlowStep, 'id' | 'role' | 'systemPromptOverride' | 'tools' | 'output' | 'effect'>,
): boolean {
  const grant = run.externalActionRunGrant;
  if (!grant?.length) return false;
  const outside = stepOutsideTools(step);
  return !!outside && outside.length > 0 && outside.every((t) => grant.includes(t));
}

/// The later steps approving `stepId` "for this run" would let through:
/// those that would otherwise ask, and need only the same outside tools.
export function stepsARunGrantCovers(steps: FlowStep[], stepId: string): string[] {
  const at = steps.findIndex((s) => s.id === stepId);
  const outside = at >= 0 ? stepOutsideTools(steps[at]) : null;
  if (!outside?.length) return [];
  const grant = { externalActionRunGrant: outside };
  return steps.slice(at + 1).filter((s) => resolveStepEffect(s) === 'external' && runGrantCovers(grant, s)).map((s) => s.id);
}
