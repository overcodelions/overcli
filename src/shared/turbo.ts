// UI-facing facts about turbo, shared by the conversation header and the flow
// step card so the two can't drift on what it claims to do.

import type { Backend } from './types';

export const BATCHING_DIRECTIVE =
  'Prefer fewer, larger tool calls. Batch independent calls into a single message, ' +
  'and combine several shell steps into one command rather than issuing them one at ' +
  'a time. Never skip a check you would otherwise run just to reduce the call count.';

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
