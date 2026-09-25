// MCP tools as flow steps and workers see them.
//
// A flow step names the tools it may use, and those names become Claude's
// `--allowedTools`: pre-authorised, never routed through the approval broker.
// An MCP tool is named `mcp__<server>__<tool>`. Listing one is how a step that
// has to read a mailbox or a calendar says so — without it, an unattended
// worker's call is refused, because nobody is there to click Allow.
//
// Whether listing one also makes the step EXTERNAL (a pause for approval
// before it runs) depends on what the tool does. Reading your calendar is not
// acting on the world; sending mail is. We only have the tool's name to go
// on, so `isReadOnlyMcpTool` reads the name: it has to say read and must not
// say write. Anything it cannot place counts as a write — the cost of a wrong
// "write" is one approval click, the cost of a wrong "read" is an unattended
// send.

const READ_WORDS = new Set([
  'search', 'list', 'get', 'read', 'fetch', 'query', 'find', 'lookup', 'describe', 'view',
  'download', 'show', 'retrieve', 'count', 'check', 'info', 'whoami',
]);

const WRITE_WORDS = new Set([
  'send', 'create', 'update', 'delete', 'remove', 'post', 'reply', 'forward', 'trash', 'untrash',
  'add', 'apply', 'mark', 'unmark', 'label', 'unlabel', 'schedule', 'respond', 'upload', 'share',
  'copy', 'merge', 'publish', 'edit', 'set', 'write', 'move', 'archive', 'invite', 'transition',
  'unsubscribe', 'draft', 'discard', 'execute', 'run', 'submit', 'approve', 'close', 'assign',
  'comment', 'upsert', 'insert', 'patch', 'put', 'rename', 'undo', 'click', 'fill', 'navigate',
  'evaluate', 'hover', 'select', 'pin', 'unpin', 'save', 'import', 'export', 'login', 'logout',
]);

/// Account-level connectors (a Gmail, Calendar or Slack connector on the
/// user's Claude account) are named this way in Claude's server list. They
/// are not in any config file, so `--strict-mcp-config` drops them.
export const ACCOUNT_CONNECTOR_PREFIX = 'claude.ai ';

export function isAccountConnector(serverName: string): boolean {
  return serverName.startsWith(ACCOUNT_CONNECTOR_PREFIX);
}

/// `mcp__<server>__<tool>` → its parts. Server names may contain single
/// underscores (`claude_ai_Gmail`); the separator is the double one.
export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(name.trim());
  return m ? { server: m[1], tool: m[2] } : null;
}

/// The words in a tool name: `search_threads`, `getJiraIssue` and
/// `slack_read_channel` all split the obvious way.
function words(tool: string): string[] {
  return tool
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/// Whether an MCP tool, by its name alone, only reads. See the file comment
/// for why unknown means no.
export function isReadOnlyMcpTool(name: string): boolean {
  const parsed = parseMcpToolName(name);
  if (!parsed) return false;
  const w = words(parsed.tool);
  return w.some((x) => READ_WORDS.has(x)) && !w.some((x) => WRITE_WORDS.has(x));
}

/// The MCP tools the flow designer may grant, grouped by server, one line per
/// server so a long catalog stays readable. Read-only tools are marked, since
/// that is what decides whether granting one pauses the step.
export function renderMcpToolsSection(tools: string[]): string[] {
  const byServer = new Map<string, string[]>();
  for (const t of tools) {
    const parsed = parseMcpToolName(t);
    if (!parsed) continue;
    const list = byServer.get(parsed.server) ?? [];
    list.push(`${parsed.tool}${isReadOnlyMcpTool(t) ? '' : '*'}`);
    byServer.set(parsed.server, list);
  }
  if (byServer.size === 0) return [];
  return [
    'MCP TOOLS THE USER HAS (grant as `mcp__<server>__<tool>` in a step\'s tools). A tool',
    'marked * changes something (sends, creates, updates) and makes its step external; the',
    'rest only read. Grant exactly the tools a step calls — never a whole server:',
    ...[...byServer.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([server, names]) => `  ${server}: ${names.sort().join(', ')}`),
  ];
}
