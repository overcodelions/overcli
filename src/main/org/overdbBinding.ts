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
import { TEST_SYSTEMS_TOOL } from '../../shared/testSystems';
import { bindRunTools } from './runToolRelay';
import { activeWorkerUser } from './workerUser';

let workerOf: (conversationId: string) => string | undefined = () => undefined;

/// The org server installs the lookup once its runtime is up.
export function useOverdbWorkerLookup(fn: (conversationId: string) => string | undefined): void {
  workerOf = fn;
}

let runFilesOf: (conversationId: string) => string | undefined = () => undefined;
let formerNamesOf: (conversationId: string) => string[] = () => [];

/// The names a run's worker went by before, for test-systems' who-may-open.
export function useFormerNamesLookup(fn: (conversationId: string) => string[]): void {
  formerNamesOf = fn;
}

/// Where a run's evidence goes (runEvidence.ts), for the test-systems tool's screenshots.
export function useRunFilesLookup(fn: (conversationId: string) => string | undefined): void {
  runFilesOf = fn;
}

function bound(config: McpServerConfig, conversationId: string, name: string = OVERDB_TOOL): McpServerConfig {
  const worker = workerOf(conversationId);
  const files = name === TEST_SYSTEMS_TOOL ? runFilesOf(conversationId) : undefined;
  const former = name === TEST_SYSTEMS_TOOL ? formerNamesOf(conversationId).filter((n) => !n.includes('\n')) : [];
  const env = config.env && typeof config.env === 'object' && !Array.isArray(config.env) ? config.env : {};
  return { ...config, env: { ...env, OVERCLI_CONVERSATION: conversationId, ...(worker ? { OVERCLI_WORKER: worker } : {}), ...(files ? { OVERCLI_RUN_FILES: files } : {}), ...(former.length ? { OVERCLI_WORKER_FORMER: former.join('\n') } : {}) } };
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
///
/// The test-systems tool (testSystems.ts) is the same kind: a command the
/// server wrote, holding credentials in its sealed env, told whose run it is
/// (its apps say which workers may open them).
const SERVER_TOOLS = [OVERDB_TOOL, TEST_SYSTEMS_TOOL];

function overdbLaunch(configured: () => Record<string, McpServerConfig>, name: string = OVERDB_TOOL): McpServerConfig | undefined {
  const config = configured()[name];
  if (!config) return undefined;
  if (activeWorkerUser()) return pinnedClaudeTool(name);
  return typeof config.command === 'string' ? config : undefined;
}

/// App-only source configuration. Collect this with gateway tools before
/// registering the complete relay session; inspecting it has no side effects.
export function overdbToolsForRun(configured: () => Record<string, McpServerConfig>, conversationId: string): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const name of SERVER_TOOLS) {
    const config = overdbLaunch(configured, name);
    if (config) out[name] = bound(config, conversationId, name);
  }
  return out;
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
  const tools = overdbToolsForRun(() => parsed.mcpServers ?? {}, conversationId);
  if (!Object.keys(tools).length) return configJson;
  Object.assign(parsed.mcpServers!, bindRunTools(tools, conversationId));
  return JSON.stringify(parsed);
}
