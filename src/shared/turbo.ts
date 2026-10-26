// UI-facing facts about turbo, shared by the conversation header and the flow
// step card so the two can't drift on what it claims to do.

import type { Backend, PermissionMode } from './types';

export const BATCHING_DIRECTIVE =
  'Prefer fewer, larger tool calls. Batch independent calls into a single message, ' +
  'and combine several shell steps into one command rather than issuing them one at ' +
  'a time. Never skip a check you would otherwise run just to reduce the call count.';

/// The batching ask for any mode where calls are still checked. Chained
/// shell lines defeat the check: one unrecognised command makes the whole
/// line ask, and a line with several commands that act can't be remembered
/// with one "Always allow" rule. Parallel simple calls save the same model
/// rounds, and each read-only one goes through without a card.
export const PARALLEL_CALLS_DIRECTIVE =
  'Prefer fewer model rounds: send independent tool calls together in a single message ' +
  'as parallel calls. Keep each shell command simple (one command, or a read-only ' +
  'pipeline) rather than chaining steps, loops or heredocs into one line, so each can ' +
  'be approved on its own. Never skip a check you would otherwise run just to reduce ' +
  'the call count.';

/// Only Bypass checks nothing, so only there is one combined command free.
export function batchingDirectiveFor(mode: PermissionMode | undefined): string {
  return mode === 'bypassPermissions' ? BATCHING_DIRECTIVE : PARALLEL_CALLS_DIRECTIVE;
}

/// Backends with at least one transport-level turbo lever. Response modes can
/// still provide speed-first prompting for other hosted backends, but this
/// helper describes the lower-level flow-step Turbo switch.
export function turboSupported(backend: Backend): boolean {
  return backend === 'claude' || backend === 'codex';
}

/// What turbo actually does on this backend, for UI copy. Codex has no
/// verified way to disable its MCP servers (`-c mcp_servers={}` does not
/// clear them), so promising "no MCP" there would be a lie in the UI.
export function turboSummary(backend: Backend): string {
  return backend === 'claude' ? 'low effort, no MCP' : 'low effort';
}
