// How much of one tool a worker may use. A tool (an MCP server) is given to
// a worker whole; its scope narrows that to the calls that read, or to calls
// picked by name. Absent: the whole tool, as before.
//
// Enforced twice, because one alone leaks:
//   - every call of the tool the server has ever seen that falls outside the
//     scope is passed to Claude as a disallowed tool, which it refuses even
//     when nothing asks for approval (an autonomous worker's runs);
//   - a call nobody has seen yet (a tool that grew a new one) isn't on that
//     list, so a scoped worker's calls that aren't pre-approved go through the
//     approval check, which refuses anything outside the scope (runtime.ts).

import { isReadOnlyMcpTool, parseMcpToolName } from './mcpTools';

/// `full` is only ever a worker's own choice over a narrower default: with no
/// default, a tool with no scope already is the whole tool.
export type ToolScope = { mode: 'full' } | { mode: 'read' } | { mode: 'only'; calls: string[] };

/// Scopes by the tool's server name, as the worker's `mcpServers` names it.
export type ToolScopes = Record<string, ToolScope>;

/// A server name as it appears inside `mcp__<server>__<tool>`.
export function mcpServerKey(server: string): string {
  return server.replace(/[^A-Za-z0-9_-]/g, '_');
}

function scopeFor(scopes: ToolScopes | undefined, toolName: string): { scope: ToolScope; server: string; tool: string } | null {
  if (!scopes) return null;
  const parsed = parseMcpToolName(toolName);
  if (!parsed) return null;
  for (const [server, scope] of Object.entries(scopes)) {
    if (mcpServerKey(server) === parsed.server) return { scope, server, tool: parsed.tool };
  }
  return null;
}

/// Whether a scoped worker may make this call. Calls of tools it has no scope
/// for, and anything that isn't an MCP call, aren't this file's to refuse.
export function inToolScope(scopes: ToolScopes | undefined, toolName: string): boolean {
  const hit = scopeFor(scopes, toolName);
  if (!hit || hit.scope.mode === 'full') return true;
  if (hit.scope.mode === 'read') return isReadOnlyMcpTool(toolName);
  return hit.scope.calls.includes(hit.tool);
}

/// Why a call was refused, for the refusal and the run's activity.
export function scopeRefusal(scopes: ToolScopes | undefined, toolName: string, workerName: string): string {
  const hit = scopeFor(scopes, toolName);
  if (!hit || hit.scope.mode === 'full') return '';
  const what = hit.scope.mode === 'read' ? 'read only' : `only ${hit.scope.calls.join(', ') || 'no calls'}`;
  return `Refused: ${workerName} may use ${hit.server} ${what}, and ${hit.tool} is outside that.`;
}

/// Every known call outside the scopes, for Claude's `--disallowedTools`.
export function scopeDenies(scopes: ToolScopes | undefined, knownTools: readonly string[]): string[] {
  if (!scopes || !Object.keys(scopes).length) return [];
  return knownTools.filter((t) => t.startsWith('mcp__') && !inToolScope(scopes, t)).sort();
}

/// A scope from untrusted input (the API), or undefined when it isn't one.
export function parseToolScope(raw: unknown): ToolScope | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as { mode?: unknown; calls?: unknown };
  if (r.mode === 'read') return { mode: 'read' };
  if (r.mode === 'full') return { mode: 'full' };
  if (r.mode === 'only' && Array.isArray(r.calls)) {
    const calls = [...new Set(r.calls.filter((c): c is string => typeof c === 'string' && /^[\w.-]{1,120}$/.test(c)))].slice(0, 200);
    return { mode: 'only', calls };
  }
  return undefined;
}

/// "read only", "3 calls", "full": how the worker's Tools card says it.
export function describeScope(scope: ToolScope | undefined): string {
  if (!scope || scope.mode === 'full') return 'whole tool';
  if (scope.mode === 'read') return 'read only';
  return scope.calls.length === 1 ? '1 call' : `${scope.calls.length} calls`;
}

/// A worker's scopes as they apply: the org's default for each tool, under
/// the worker's own choice. A tool left at the whole tool has no entry.
export function effectiveScopes(own: ToolScopes | undefined, defaults: ToolScopes | undefined): ToolScopes | undefined {
  const out: ToolScopes = {};
  for (const [name, scope] of Object.entries({ ...(defaults ?? {}), ...(own ?? {}) })) if (scope.mode !== 'full') out[name] = scope;
  return Object.keys(out).length ? out : undefined;
}

/// Whether `scope` allows nothing `limit` doesn't: a manager may narrow a
/// tool for their worker; going past the org's default is an admin's call.
/// Calls are judged by name, as everywhere: `server` is the tool's name.
export function withinScope(scope: ToolScope, limit: ToolScope | undefined, server: string): boolean {
  if (!limit || limit.mode === 'full') return true;
  if (scope.mode === 'full') return false;
  const key = mcpServerKey(server);
  if (limit.mode === 'read') return scope.mode === 'read' || scope.calls.every((c) => isReadOnlyMcpTool(`mcp__${key}__${c}`));
  if (scope.mode === 'read') return false;
  return scope.calls.every((c) => limit.calls.includes(c));
}
