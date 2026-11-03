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

import { pinnedClaudeTool, type McpServerConfig } from '../mcpConfig';
import { OVERDB_TOOL } from '../../shared/overdbConnection';
import { bindRunTools } from './runToolRelay';
import { activeWorkerUser } from './workerUser';

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

/// The overdb command the server may start for a run: only when the run's
/// own config names the tool (an allowlist that leaves it out gets nothing).
/// While workers run as a user of their own they can write the config, and
/// a repo brings its own `.mcp.json` that may reuse the tool's name: only
/// the entry the server pinned when it saved the tool counts then
/// (mcpConfig.ts pinnedClaudeTool), never what now sits under the name. A
/// tool the server never saved is left to the worker's CLI, which starts it
/// as the worker.
function overdbLaunch(configured: () => Record<string, McpServerConfig>): McpServerConfig | undefined {
  const config = configured()[OVERDB_TOOL];
  if (!config) return undefined;
  if (activeWorkerUser()) return pinnedClaudeTool(OVERDB_TOOL);
  return typeof config.command === 'string' ? config : undefined;
}

/// App-only source configuration. Collect this with gateway tools before
/// registering the complete relay session; inspecting it has no side effects.
export function overdbToolsForRun(configured: () => Record<string, McpServerConfig>, conversationId: string): Record<string, McpServerConfig> {
  const config = overdbLaunch(configured);
  return config ? { [OVERDB_TOOL]: bound(config, conversationId) } : {};
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
  const config = overdbLaunch(() => parsed.mcpServers ?? {});
  if (!config) return configJson;
  parsed.mcpServers![OVERDB_TOOL] = bindRunTools({ [OVERDB_TOOL]: bound(config, conversationId) }, conversationId)[OVERDB_TOOL];
  return JSON.stringify(parsed);
}
