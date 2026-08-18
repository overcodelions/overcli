// UI-facing facts about turbo, shared by the conversation header and the flow
// step card so the two can't drift on what it claims to do.

import type { Backend } from './types';

/// Backends with at least one turbo lever. Claude has all three (effort, MCP,
/// consolidation); codex has two. Copilot's CLI exposes no effort or MCP flags
/// at all, and ollama/gemini run through different transports entirely — a
/// toggle there would be decoration.
export function turboSupported(backend: Backend): boolean {
  return backend === 'claude' || backend === 'codex';
}

/// What turbo actually does on this backend, for UI copy. Codex has no
/// verified way to disable its MCP servers (`-c mcp_servers={}` does not
/// clear them), so promising "no MCP" there would be a lie in the UI.
export function turboSummary(backend: Backend): string {
  return backend === 'claude' ? 'low effort, no MCP' : 'low effort';
}
