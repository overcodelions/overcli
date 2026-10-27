// The overdb tool, told whose run it is serving.
//
// overdb's headless MCP server (Setup → Databases) logs every query an agent
// makes. The app-owned relay starts it with the run's attribution so the
// query log can identify the worker without exposing credentials to the CLI.
// The app-owned transport gives overdb two variables, the worker's name
// and the run's conversation, and overdb writes them on every line of its
// query log (`--query-log`), which the Databases tab reads back.
//
// Same seam as the tool gateway's per-run keys (toolGateway.ts), and on the
// same two launch paths in runner.ts.

import type { McpServerConfig } from '../mcpConfig';
import { OVERDB_TOOL } from '../../shared/overdbConnection';
import { bindRunTools } from './runToolRelay';

let workerOf: (conversationId: string) => string | undefined = () => undefined;

/// The org server installs the lookup once its runtime is up.
export function useOverdbWorkerLookup(fn: (conversationId: string) => string | undefined): void {
  workerOf = fn;
}

function bound(config: McpServerConfig, conversationId: string): McpServerConfig {
  const worker = workerOf(conversationId);
  const env = config.env && typeof config.env === 'object' && !Array.isArray(config.env) ? config.env : {};
  return { ...config, env: { ...env, OVERCLI_CONVERSATION: conversationId, ...(worker ? { OVERCLI_WORKER: worker } : {}) } };
}

/// For a run on the whole config: the overdb entry again, bound, to pass as
/// the run's own config (it wins over the config's entry of the same name).
export function boundOverdbTool(configured: () => Record<string, McpServerConfig>, conversationId: string): Record<string, McpServerConfig> {
  const tools = overdbToolsForRun(configured, conversationId);
  return Object.keys(tools).length ? bindRunTools(tools, conversationId) : {};
}

/// App-only source configuration. Collect this with gateway tools before
/// registering the complete relay session; inspecting it has no side effects.
export function overdbToolsForRun(configured: () => Record<string, McpServerConfig>, conversationId: string): Record<string, McpServerConfig> {
  const config = configured()[OVERDB_TOOL];
  return config && typeof config.command === 'string' ? { [OVERDB_TOOL]: bound(config, conversationId) } : {};
}

/// For a run on an allowlisted config: bind the overdb entry in place.
export function bindOverdbInConfig(configJson: string, conversationId: string): string {
  if (!configJson) return configJson;
  let parsed: { mcpServers?: Record<string, McpServerConfig> };
  try {
    parsed = JSON.parse(configJson);
  } catch {
    return configJson;
  }
  const config = parsed.mcpServers?.[OVERDB_TOOL];
  if (!config || typeof config.command !== 'string') return configJson;
  parsed.mcpServers![OVERDB_TOOL] = bindRunTools({ [OVERDB_TOOL]: bound(config, conversationId) }, conversationId)[OVERDB_TOOL];
  return JSON.stringify(parsed);
}
